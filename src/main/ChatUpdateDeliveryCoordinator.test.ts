import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import {
  appliedChatUpdateBaseline,
  applyChatUpdateDelivery,
  attachChatUpdateProducerEnvelope,
  chatUpdateProducerEnvelopeFor,
  computeChatSubRevisions,
  type ChatUpdateDelivery
} from '../shared/chatUpdateTransport'
import { deriveChatRecordMutationWithProjection } from './store/ChatRecordMutation'
import { ChatUpdateProjectionTracker } from './store/ChatUpdateProjectionTracker'
import {
  ChatUpdateDeliveryCoordinator,
  resolveEmitProtocolVersionForTest,
  type ChatUpdateDeliveryTarget
} from './ChatUpdateDeliveryCoordinator'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-07-18T00:00:00.000Z' }
}

function chat(updatedAt: number, contents: string[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Ensemble',
    provider: 'codex',
    chatKind: 'ensemble',
    archived: false,
    messages: contents.map((content, index) => message(`message-${index}`, content)),
    runs: [],
    createdAt: 1,
    updatedAt,
    persistenceRevision: updatedAt
  } as ChatRecord
}

function projectSequence(...records: ChatRecord[]): ChatRecord[] {
  if (records.length === 0) return records
  const tracker = new ChatUpdateProjectionTracker()
  attachChatUpdateProducerEnvelope(records[0], {
    state: tracker.seed(records[0]),
    delta: null
  })
  for (let index = 1; index < records.length; index += 1) {
    const before = records[index - 1]
    const after = records[index]
    attachChatUpdateProducerEnvelope(
      after,
      tracker.observe(before, after, deriveChatRecordMutationWithProjection(before, after))
    )
  }
  return records
}

function target(id = 7): ChatUpdateDeliveryTarget & { deliveries: ChatUpdateDelivery[] } {
  const deliveries: ChatUpdateDelivery[] = []
  return {
    id,
    deliveries,
    isDestroyed: () => false,
    send: (_channel, payload) => deliveries.push(payload as ChatUpdateDelivery)
  }
}

describe('ChatUpdateDeliveryCoordinator', () => {
  it('keeps one delivery in flight and replaces any number of pending snapshots with the latest', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 1
    })
    coordinator.enqueue(sink, chat(1, ['one']))
    coordinator.enqueue(sink, chat(2, ['two']))
    coordinator.enqueue(sink, chat(3, ['three']))

    expect(sink.deliveries).toHaveLength(1)
    expect(sink.deliveries[0].kind).toBe('snapshot')
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ inFlight: 1, pending: 1 })

    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: true
    })
    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('patch')
    if (sink.deliveries[1].kind !== 'patch') throw new Error('Expected patch')
    expect(sink.deliveries[1].protocolVersion).toBe(1)
    if (sink.deliveries[1].protocolVersion !== 1) throw new Error('Expected v1 patch')
    expect(sink.deliveries[1].record.updatedAt).toBe(3)
  })

  it('produces a patch that reconstructs the exact latest pending chat', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 1
    })
    const first = chat(1, ['one', 'stable'])
    const latest = chat(3, ['three', 'stable', 'tail'])
    coordinator.enqueue(sink, first)
    const firstDelivery = sink.deliveries[0]
    const firstApplied = applyChatUpdateDelivery(firstDelivery)
    expect(firstApplied.ok).toBe(true)
    if (!firstApplied.ok) throw new Error(firstApplied.reason)
    coordinator.enqueue(sink, latest)
    coordinator.acknowledge(sink.id, { deliveryId: firstDelivery.deliveryId, applied: true })

    const patch = sink.deliveries[1]
    const patched = applyChatUpdateDelivery(patch, firstApplied.baseline)
    expect(patched).toMatchObject({
      ok: true,
      baseline: { revision: patch.revision, chat: latest }
    })
  })

  it('advances an idle baseline for a renderer-authored compact mutation without an echo', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [seed, rendererMutation, laterMainUpdate] = projectSequence(
      chat(1, ['h']),
      chat(2, ['hello']),
      chat(3, ['hello', 'later'])
    )
    coordinator.enqueue(sink, seed)
    const seedDelivery = sink.deliveries[0]
    const seedApplied = applyChatUpdateDelivery(seedDelivery)
    expect(seedApplied.ok).toBe(true)
    if (!seedApplied.ok) throw new Error(seedApplied.reason)
    coordinator.acknowledge(sink.id, {
      deliveryId: seedDelivery.deliveryId,
      applied: true
    })

    expect(coordinator.adoptRendererMutation(sink.id, rendererMutation, 1)).toBe(true)
    expect(sink.deliveries).toHaveLength(1)

    const rendererProducer = chatUpdateProducerEnvelopeFor(rendererMutation)
    const rendererBaseline = appliedChatUpdateBaseline(
      seedApplied.baseline.revision,
      rendererMutation,
      rendererProducer?.state.transcriptHash
    )
    coordinator.enqueue(sink, laterMainUpdate)
    const delivery = sink.deliveries[1]
    expect(delivery.kind).toBe('patch')
    const applied = applyChatUpdateDelivery(delivery, rendererBaseline)
    expect(applied).toMatchObject({
      ok: true,
      baseline: { chat: laterMainUpdate }
    })
  })

  it('forces a full resync after the renderer rejects a delivery', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    coordinator.enqueue(sink, chat(1, ['one']))
    coordinator.enqueue(sink, chat(2, ['two']))
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: false
    })
    expect(sink.deliveries[1].kind).toBe('snapshot')
  })

  it('retries a rejected delivery once without creating a rejection loop', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    coordinator.enqueue(sink, chat(1, ['one']))
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: false
    })
    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('snapshot')

    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[1].deliveryId,
      applied: false
    })
    expect(sink.deliveries).toHaveLength(2)
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ inFlight: 0, pending: 0 })
  })

  it('ignores acknowledgements sent by a different renderer', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    coordinator.enqueue(sink, chat(1, ['one']))
    expect(
      coordinator.acknowledge(99, {
        deliveryId: sink.deliveries[0].deliveryId,
        applied: true
      })
    ).toBe(false)
    expect(coordinator.statsForTarget(sink.id).inFlight).toBe(1)
  })

  it('releases an unacknowledged delivery and resyncs the latest pending chat', () => {
    vi.useFakeTimers()
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      ackTimeoutMs: 250
    })
    coordinator.enqueue(sink, chat(1, ['one']))
    coordinator.enqueue(sink, chat(2, ['latest']))

    vi.advanceTimersByTime(250)

    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('snapshot')
    if (sink.deliveries[1].kind !== 'snapshot') throw new Error('Expected snapshot')
    expect(sink.deliveries[1].chat.updatedAt).toBe(2)
    vi.useRealTimers()
  })

  it('throttles acknowledged delivery bursts while retaining the latest pending chat', () => {
    vi.useFakeTimers()
    let now = 1_000
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 100,
      now: () => now,
      emitProtocolVersion: 1
    })
    coordinator.enqueue(sink, chat(1, ['one']))
    coordinator.enqueue(sink, chat(2, ['two']))
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: true
    })
    expect(sink.deliveries).toHaveLength(1)

    now += 100
    vi.advanceTimersByTime(100)
    expect(sink.deliveries).toHaveLength(2)
    if (sink.deliveries[1].kind !== 'patch') throw new Error('Expected patch')
    expect(sink.deliveries[1].protocolVersion).toBe(1)
    if (sink.deliveries[1].protocolVersion !== 1) throw new Error('Expected v1 patch')
    expect(sink.deliveries[1].record.updatedAt).toBe(2)
    vi.useRealTimers()
  })

  it('emits v2 field-mask patches when emitProtocolVersion is flagged', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const first = chat(1, ['one', 'stable'])
    const latest = {
      ...chat(3, ['one', 'stable', 'tail']),
      title: 'Updated'
    }
    projectSequence(first, latest)
    coordinator.enqueue(sink, first)
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: true
    })
    coordinator.enqueue(sink, latest)

    const patch = sink.deliveries[1]
    expect(patch.kind).toBe('patch')
    expect(patch.protocolVersion).toBe(2)
    if (patch.kind !== 'patch' || patch.protocolVersion !== 2) {
      throw new Error('Expected v2 patch')
    }
    expect('record' in patch).toBe(false)
    expect(patch.recordDelta.title).toBe('Updated')
    expect(patch.recordMask).toEqual(expect.arrayContaining(['title', 'updatedAt']))

    const firstApplied = applyChatUpdateDelivery(sink.deliveries[0])
    expect(firstApplied.ok).toBe(true)
    if (!firstApplied.ok) throw new Error(firstApplied.reason)
    const patched = applyChatUpdateDelivery(patch, firstApplied.baseline)
    expect(patched).toMatchObject({
      ok: true,
      baseline: { revision: patch.revision, chat: latest }
    })
  })

  it('reports retained baseline bytes and never stacks three full ChatRecord refs', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 1
    })
    const first = chat(1, ['one-message-body'])
    coordinator.enqueue(sink, first)
    const beforeAck = coordinator.statsForTarget(sink.id)
    expect(beforeAck.retainedBaselineBytes).toBeGreaterThan(0)
    expect(beforeAck.retainedMessages).toBe(1)
    expect(beforeAck.inFlight).toBe(1)

    const delivery = sink.deliveries[0]
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: delivery.deliveryId,
        applied: true
      })
    ).toBe(true)

    const idle = coordinator.statsForTarget(sink.id)
    expect(idle.inFlight).toBe(0)
    expect(idle.retainedBaselineBytes).toBeGreaterThan(0)

    // After ACK: baselineChat held for next patch. Enqueue next → inFlight +
    // pending would be the danger zone; with only one pending and baseline
    // cleared on send, patches still work and stats stay finite.
    coordinator.enqueue(sink, chat(2, ['two']))
    expect(sink.deliveries[1].kind).toBe('patch')
    const mid = coordinator.statsForTarget(sink.id)
    expect(mid.inFlight).toBe(1)
    expect(mid.retainedBaselineBytes).toBeGreaterThan(0)
  })

  it('rejects an ACK whose revision disagrees with the in-flight delivery', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    coordinator.enqueue(sink, chat(1, ['one']))
    const deliveryId = sink.deliveries[0].deliveryId

    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId,
        applied: true,
        revision: 999
      })
    ).toBe(true)
    // Treated as a reject → one snapshot retry, then stop.
    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('snapshot')
  })

  it('nacks when the ACK content hash does not match the sent chat', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    coordinator.enqueue(sink, chat(1, ['one']))
    const deliveryId = sink.deliveries[0].deliveryId

    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId,
        applied: true,
        recordHash: 'deadbeef'
      })
    ).toBe(true)
    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('snapshot')
  })

  it('accepts an ACK whose content hash matches the sent chat', () => {
    const sink = target()
    const first = chat(1, ['one'])
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    coordinator.enqueue(sink, first)
    const deliveryId = sink.deliveries[0].deliveryId

    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId,
        applied: true,
        recordHash: computeChatSubRevisions(first).recordHash
      })
    ).toBe(true)
    expect(sink.deliveries).toHaveLength(1)
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ inFlight: 0, pending: 0 })
  })

  it('reports how long the in-flight delivery has been waiting for an ACK', () => {
    let now = 5_000
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      now: () => now
    })
    coordinator.enqueue(sink, chat(1, ['one']))
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ inFlight: 1, inFlightAgeMs: 0 })
    now = 5_400
    expect(coordinator.statsForTarget(sink.id).inFlightAgeMs).toBe(400)
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: true
    })
    expect(coordinator.statsForTarget(sink.id).inFlightAgeMs).toBe(0)
  })

  it('forces a snapshot when a new renderer document ACKs a patch from the prior epoch', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, chat(1, ['seed']))
    const seed = sink.deliveries[0]
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: seed.deliveryId,
        deliveryEpoch: seed.deliveryEpoch,
        applied: true,
        rendererEpoch: 'renderer-a'
      })
    ).toBe(true)

    coordinator.enqueue(sink, chat(2, ['seed', 'next']))
    const patch = sink.deliveries[1]
    expect(patch.kind).toBe('patch')
    // A reload can receive a patch with a stale renderer baseline. Treat the
    // first ACK from its new epoch as a NACK and repair with one snapshot.
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: patch.deliveryId,
        deliveryEpoch: patch.deliveryEpoch,
        applied: true,
        rendererEpoch: 'renderer-b'
      })
    ).toBe(true)
    expect(sink.deliveries).toHaveLength(3)
    const recovery = sink.deliveries[2]
    expect(recovery.kind).toBe('snapshot')
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: recovery.deliveryId,
        deliveryEpoch: recovery.deliveryEpoch,
        applied: true,
        rendererEpoch: 'renderer-b'
      })
    ).toBe(true)
    // An old async ACK cannot reopen or mutate the new baseline.
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: seed.deliveryId,
        deliveryEpoch: seed.deliveryEpoch,
        applied: true,
        rendererEpoch: 'renderer-a'
      })
    ).toBe(false)
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ inFlight: 0, pending: 0 })
  })

  it('increments the delivery epoch when a target reloads and rejects its old ACKs', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
    coordinator.enqueue(sink, chat(1, ['before reload']))
    const beforeReload = sink.deliveries[0]
    coordinator.clearTarget(sink.id)

    coordinator.enqueue(sink, chat(2, ['after reload']))
    const afterReload = sink.deliveries[1]
    expect(afterReload.deliveryEpoch).toBeGreaterThan(beforeReload.deliveryEpoch ?? 0)
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: beforeReload.deliveryId,
        deliveryEpoch: beforeReload.deliveryEpoch,
        applied: true,
        chatId: beforeReload.chatId,
        rendererEpoch: 'old-document'
      })
    ).toBe(false)
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: afterReload.deliveryId,
        deliveryEpoch: afterReload.deliveryEpoch,
        applied: true,
        chatId: afterReload.chatId,
        rendererEpoch: 'new-document'
      })
    ).toBe(true)
  })

  it('records a render receipt without making rendering another transport gate', () => {
    let now = 5_000
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      now: () => now
    })
    coordinator.enqueue(sink, chat(1, ['one']))
    const delivery = sink.deliveries[0]
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: delivery.deliveryId,
        deliveryEpoch: delivery.deliveryEpoch,
        applied: true,
        chatId: delivery.chatId,
        rendererEpoch: 'renderer-a'
      })
    ).toBe(true)
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: delivery.deliveryId,
        deliveryEpoch: delivery.deliveryEpoch,
        applied: true,
        chatId: delivery.chatId,
        rendererEpoch: 'renderer-a'
      })
    ).toBe(true)
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ renderPending: 1 })
    now += 75
    expect(coordinator.statsForTarget(sink.id).renderReceiptAgeMs).toBe(75)
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: delivery.deliveryId,
        deliveryEpoch: delivery.deliveryEpoch,
        applied: true,
        phase: 'rendered',
        chatId: delivery.chatId,
        rendererEpoch: 'renderer-a',
        recordHash: 'wrong-record'
      })
    ).toBe(false)
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: delivery.deliveryId,
        deliveryEpoch: delivery.deliveryEpoch,
        applied: true,
        phase: 'rendered',
        chatId: delivery.chatId,
        rendererEpoch: 'renderer-a'
      })
    ).toBe(true)
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ renderPending: 0 })
    // Render receipts are idempotent and do not enqueue or block anything.
    expect(
      coordinator.acknowledge(sink.id, {
        deliveryId: delivery.deliveryId,
        deliveryEpoch: delivery.deliveryEpoch,
        applied: true,
        phase: 'rendered',
        chatId: delivery.chatId,
        rendererEpoch: 'renderer-a'
      })
    ).toBe(true)
  })

  it('bypasses stream cadence for a terminal chat update without widening the queue', () => {
    let now = 10_000
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 1_000,
      now: () => now
    })
    coordinator.enqueue(sink, chat(1, ['streaming']))
    const first = sink.deliveries[0]
    coordinator.acknowledge(sink.id, { deliveryId: first.deliveryId, applied: true })

    // This normal update arms the 1 s cadence timer.
    coordinator.enqueue(sink, chat(2, ['streaming', 'ordinary progress']))
    expect(sink.deliveries).toHaveLength(1)
    coordinator.enqueue(sink, {
      ...chat(3, ['streaming', 'ordinary progress', 'terminal']),
      runs: [{ runId: 'r1', startedAt: '2026-08-21T15:00:00.000Z', status: 'completed' }]
    })
    expect(sink.deliveries).toHaveLength(2)
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ inFlight: 1, pending: 0 })
    now += 1
  })

  it('retries one timed-out delivery as a snapshot even when no newer update is queued', () => {
    vi.useFakeTimers()
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      ackTimeoutMs: 250
    })
    coordinator.enqueue(sink, chat(1, ['one']))
    vi.advanceTimersByTime(250)
    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('snapshot')
    vi.advanceTimersByTime(250)
    expect(sink.deliveries).toHaveLength(2)
    vi.useRealTimers()
  })
})

describe('default emit protocol', () => {
  /**
   * MEASURED 2026-08-05 on the real 26,389-message / 924-run ensemble chat
   * (62 MB record), identical freshly-seeded profile per arm, transcript open,
   * 7 identical saves each:
   *
   *   v1 total per save: 6.6, 9.3, 13.0, 15.2, 18.2, 22.8, 21.5 s  (degrading)
   *   v2 total per save: 1.7, 3.6, 3.4, 3.4, 3.4, 3.4, 3.4 s       (flat)
   *
   * The decisive property is not the 4.5x median — it is that v1 degrades
   * monotonically with every save while v2 stays flat, which is the
   * "it never recovers" symptom users report. v2 also opened the chat in
   * 2.35 s vs 6.75 s and held 196 MB vs 717 MB of renderer heap.
   *
   * Patches are fail-safe: the coordinator only patches while it holds the
   * acknowledged baseline, and a failed apply nacks, which drops the baseline
   * and forces a full snapshot on the next delivery. TASKWRAITH_CHAT_UPDATE_PROTOCOL=1
   * remains as the escape hatch.
   */
  it('defaults to v2 patches, with an explicit env escape hatch back to v1', () => {
    const previous = process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL
    try {
      delete process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL
      expect(resolveEmitProtocolVersionForTest()).toBe(2)
      process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL = '1'
      expect(resolveEmitProtocolVersionForTest()).toBe(1)
      process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL = '2'
      expect(resolveEmitProtocolVersionForTest()).toBe(2)
    } finally {
      if (previous === undefined) delete process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL
      else process.env.TASKWRAITH_CHAT_UPDATE_PROTOCOL = previous
    }
  })
})

describe('out-of-order producer broadcasts (delegate-wave return burst)', () => {
  /**
   * Two wave children return near-simultaneously. Child A's propagation saves
   * the parent (rev 2) but its broadcast is deferred across an awaited fleet
   * worktree settle; child B saves (rev 3) and broadcasts first. The renderer
   * therefore sees rev 3, then a stale rev-2 rebroadcast. The stale delivery
   * must never make the transcript lose B's already-delivered return card, and
   * must not poison the patch baseline into a snapshot pair.
   */
  it('drops a stale rebroadcast that arrives after a fresher revision was delivered', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [seed, staleReturnA, freshReturnB] = projectSequence(
      chat(1, ['prompt']),
      chat(2, ['prompt', 'return A']),
      chat(3, ['prompt', 'return A', 'return B'])
    )

    coordinator.enqueue(sink, seed)
    let applied = applyChatUpdateDelivery(sink.deliveries[0])
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error(applied.reason)
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: true })

    coordinator.enqueue(sink, freshReturnB)
    coordinator.enqueue(sink, staleReturnA)
    expect(sink.deliveries).toHaveLength(2)
    const fresh = applyChatUpdateDelivery(sink.deliveries[1], applied.baseline)
    expect(fresh.ok).toBe(true)
    if (!fresh.ok) throw new Error(fresh.reason)
    applied = fresh
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[1].deliveryId, applied: true })

    for (const delivery of sink.deliveries.slice(2)) {
      const next = applyChatUpdateDelivery(delivery, applied.baseline)
      expect(next.ok).toBe(true)
      if (!next.ok) throw new Error(next.reason)
      applied = next
      coordinator.acknowledge(sink.id, { deliveryId: delivery.deliveryId, applied: true })
    }

    // The transcript the user reads must still hold child B's return card.
    expect(applied.baseline.chat.messages.map((entry) => entry.content)).toContain('return B')
  })

  it('heals an out-of-order pair sitting in the compose window instead of losing the fresher record', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [seed, staleReturnA, freshReturnB] = projectSequence(
      chat(1, ['prompt']),
      chat(2, ['prompt', 'return A']),
      chat(3, ['prompt', 'return A', 'return B'])
    )

    coordinator.enqueue(sink, seed)
    // Both broadcasts land while the seed delivery is still awaiting its ACK,
    // in reversed order: fresher B first, then the deferred stale A.
    coordinator.enqueue(sink, freshReturnB)
    coordinator.enqueue(sink, staleReturnA)

    const applied = applyChatUpdateDelivery(sink.deliveries[0])
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error(applied.reason)
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: true })

    expect(sink.deliveries).toHaveLength(2)
    const second = sink.deliveries[1]
    const next = applyChatUpdateDelivery(second, applied.baseline)
    expect(next.ok).toBe(true)
    if (!next.ok) throw new Error(next.reason)
    // Both return cards survive: the late stale delta is spliced in FRONT of
    // the fresher pending delta, so nothing regresses and nothing is lost.
    expect(next.baseline.chat.messages.map((entry) => entry.content)).toEqual([
      'prompt',
      'return A',
      'return B'
    ])
    // And the healed chain still rides the patch protocol — an out-of-order
    // burst must not degrade the multi-MB parent chat to snapshot deliveries.
    expect(second.kind).toBe('patch')
  })

  it('converges seven reversed fan-out returns into one bounded delivery chain', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const records = projectSequence(
      chat(1, ['prompt']),
      ...Array.from({ length: 7 }, (_, index) =>
        chat(index + 2, [
          'prompt',
          ...Array.from({ length: index + 1 }, (_, lane) => `lane return ${lane + 1}`)
        ])
      )
    )
    const seed = records[0]
    const returns = records.slice(1)

    coordinator.enqueue(sink, seed)
    // All seven lanes complete while the seed snapshot awaits its synchronous
    // transport receipt, but arrive in the worst causal order.
    for (const returned of [...returns].reverse()) coordinator.enqueue(sink, returned)
    expect(sink.deliveries).toHaveLength(1)

    const seedApplied = applyChatUpdateDelivery(sink.deliveries[0])
    if (!seedApplied.ok) throw new Error(seedApplied.reason)
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      deliveryEpoch: sink.deliveries[0].deliveryEpoch,
      applied: true,
      revision: seedApplied.baseline.revision,
      recordHash: seedApplied.baseline.recordHash,
      transcriptHash: seedApplied.baseline.transcriptHash,
      rendererEpoch: 'renderer-a'
    })

    expect(sink.deliveries).toHaveLength(2)
    const allReturns = applyChatUpdateDelivery(sink.deliveries[1], seedApplied.baseline)
    if (!allReturns.ok) throw new Error(allReturns.reason)
    expect(allReturns.baseline.chat.messages.map((entry) => entry.content)).toEqual([
      'prompt',
      'lane return 1',
      'lane return 2',
      'lane return 3',
      'lane return 4',
      'lane return 5',
      'lane return 6',
      'lane return 7'
    ])
    expect(sink.deliveries[1].kind).toBe('patch')

    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[1].deliveryId,
      deliveryEpoch: sink.deliveries[1].deliveryEpoch,
      applied: true,
      revision: allReturns.baseline.revision,
      recordHash: allReturns.baseline.recordHash,
      transcriptHash: allReturns.baseline.transcriptHash,
      rendererEpoch: 'renderer-a'
    })
    expect(coordinator.statsForTarget(sink.id)).toMatchObject({ inFlight: 0, pending: 0 })
  })

  it('delivers the next reply after a save mutated the retained baseline record', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [first, second] = projectSequence(chat(1, ['one']), chat(2, ['one', 'the answer is 42']))

    coordinator.enqueue(sink, first)
    const firstApplied = applyChatUpdateDelivery(sink.deliveries[0])
    if (!firstApplied.ok) throw new Error(firstApplied.reason)
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: true
    })

    // AppStore.saveChat writes the NEW revision into its CALLER's record
    // (store/index.ts:7376), and on a getChat()-then-save path that caller's
    // record is the very object the coordinator retained as its baseline. The
    // save is not broadcast, so no delivery ever carried that revision.
    const retainedBaseline = first as { persistenceRevision: number }
    retainedBaseline.persistenceRevision = 5

    coordinator.enqueue(sink, second)

    // What a human reads: the reply has to reach the renderer.
    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('patch')
    const applied = applyChatUpdateDelivery(sink.deliveries[1], firstApplied.baseline)
    if (!applied.ok) throw new Error(applied.reason)
    expect(applied.baseline.chat.messages.map((entry) => entry.content)).toContain(
      'the answer is 42'
    )
  })

  it('snapshots before diffing from a retained baseline whose metadata mutated in place', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const first = {
      ...chat(1, ['one']),
      providerMetadata: { selectedModelType: 'gpt-5.6-luna' }
    } as ChatRecord

    coordinator.enqueue(sink, first)
    // IPC gives the renderer a detached structured clone. Keeping the same
    // object here would mask main-side baseline mutations in this unit test.
    const firstApplied = applyChatUpdateDelivery(structuredClone(sink.deliveries[0]))
    if (!firstApplied.ok) throw new Error(firstApplied.reason)
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[0].deliveryId,
      applied: true,
      recordHash: firstApplied.baseline.recordHash
    })

    // A later save/cache path mutates the coordinator's retained object. The
    // revision stamp is expected and normalized; this metadata field is not.
    first.persistenceRevision = 9
    first.providerMetadata = {
      ...first.providerMetadata,
      codexGoalNativeAvailable: true
    }
    const second = {
      ...chat(2, ['one', 'two']),
      providerMetadata: first.providerMetadata
    } as ChatRecord
    coordinator.enqueue(sink, second)

    expect(sink.deliveries).toHaveLength(2)
    expect(sink.deliveries[1].kind).toBe('snapshot')
    const repaired = applyChatUpdateDelivery(structuredClone(sink.deliveries[1]))
    if (!repaired.ok) throw new Error(repaired.reason)
    expect(repaired.baseline.chat).toEqual(second)
    expect(coordinator.protocolCounters()).toMatchObject({
      baselineDrops: 1,
      ackRejections: 0
    })
  })
})
