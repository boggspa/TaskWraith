/**
 * Phase 2 observability — is v2 patching actually HOLDING under load?
 *
 * The chat-updated path is already well mitigated: v2 emits compact field-mask
 * patches against an acknowledged baseline instead of the whole ChatRecord, and
 * the measured win is large (a real 26k-message / 62 MB chat: v1 degraded
 * 6.6 s -> 22.8 s across seven identical saves while v2 held flat at ~3.4 s).
 *
 * But patching only applies WHILE the acknowledged baseline is held. A failed
 * apply nacks, which drops the baseline and forces a full snapshot on the next
 * delivery. Under fan-out — many rapid deliveries, busy renderer, ACK timeouts —
 * that degradation is plausible precisely when it hurts most, and nothing
 * counted it. A frame-cadence triage run could therefore see main-thread cost
 * from full-record sends and have no way to attribute it.
 *
 * These counters are cumulative and deliberately cheap (three integers). They
 * exist so a measurement window can answer one question: of the deliveries in
 * this window, how many were patches, how many degraded to snapshots, and how
 * many times was a baseline dropped?
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import {
  attachChatUpdateProducerEnvelope,
  type ChatUpdateDelivery
} from '../shared/chatUpdateTransport'
import { deriveChatRecordMutationWithProjection } from './store/ChatRecordMutation'
import { ChatUpdateProjectionTracker } from './store/ChatUpdateProjectionTracker'
import {
  ChatUpdateDeliveryCoordinator,
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

function target(id = 11): ChatUpdateDeliveryTarget & { deliveries: ChatUpdateDelivery[] } {
  const deliveries: ChatUpdateDelivery[] = []
  return {
    id,
    deliveries,
    isDestroyed: () => false,
    send: (_channel, payload) => deliveries.push(payload as ChatUpdateDelivery)
  }
}

describe('ChatUpdateDeliveryCoordinator protocol counters', () => {
  it('counts a first delivery as a snapshot and a baseline-backed follow-up as a patch', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first, second] = projectSequence(chat(1, ['one']), chat(2, ['two']))
    coordinator.enqueue(sink, first)
    coordinator.enqueue(sink, second)
    expect(sink.deliveries[0].kind).toBe('snapshot')
    expect(coordinator.protocolCounters()).toMatchObject({ snapshots: 1, patches: 0 })

    // Acknowledging holds the baseline, so the queued update can go as a patch.
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: true })
    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ snapshots: 1, patches: 1 })
  })

  it('counts the baseline drop when a renderer nacks, and the snapshot it forces', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first, second, third] = projectSequence(
      chat(1, ['one']),
      chat(2, ['two']),
      chat(3, ['three'])
    )
    coordinator.enqueue(sink, first)
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: true })
    coordinator.enqueue(sink, second)
    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ baselineDrops: 0 })

    // The renderer could not apply the patch. That drops the baseline — the
    // degradation this counter exists to make visible.
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[1].deliveryId, applied: false })
    coordinator.enqueue(sink, third)

    const latest = sink.deliveries[sink.deliveries.length - 1]
    expect(latest.kind).toBe('snapshot')
    const counters = coordinator.protocolCounters()
    expect(counters.baselineDrops).toBeGreaterThanOrEqual(1)
    // A measurement window can now see the ratio rather than assuming it.
    expect(counters.snapshots).toBeGreaterThanOrEqual(2)
  })

  it('keeps a broken producer visible even though the delivery now patches', () => {
    // 2026-08-19: a producer that yields no delta used to degrade every
    // delivery to a full-record snapshot, and snapshots-vs-patches was the
    // only signal. Recovering by baseline diff removes the OOM but would also
    // make a broken producer read as HEALTHY on those two counters — the
    // regression would go quiet rather than get fixed. These count the cause.
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first] = projectSequence(chat(1, ['one']))
    coordinator.enqueue(sink, first)
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: true })
    expect(coordinator.protocolCounters()).toMatchObject({ producerDeltaMissing: 0 })

    // Exactly the shipped failure: a save path broadcasts with no producer
    // envelope at all, so there is no delta to chain from.
    coordinator.enqueue(sink, chat(2, ['one', 'two']))

    const latest = sink.deliveries[sink.deliveries.length - 1]
    expect(latest.kind).toBe('patch')
    const counters = coordinator.protocolCounters()
    expect(counters.producerDeltaMissing).toBe(1)
    expect(counters.spliceRecoveries).toBe(1)
  })

  it('keeps counting across targets so a fan-out window sees every delivery', () => {
    const a = target(21)
    const b = target(22)
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    coordinator.enqueue(a, chat(1, ['one']))
    coordinator.enqueue(b, chat(1, ['one']))

    // Per-target stats are a point-in-time retention view; these are cumulative
    // totals for the whole coordinator, which is what a triage window needs.
    expect(coordinator.protocolCounters().snapshots).toBe(2)
  })

  it('counts broadcasts discarded by the enqueue staleness guard', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    // Seed a fresh known revision, then rebroadcast an OLDER one — the exact
    // late-arrival shape the staleness guard exists to reject. The frame is
    // dropped silently; without this counter the transcript just freezes
    // while snapshots/patches stay flat.
    const [fresh] = projectSequence(chat(5, ['five']))
    coordinator.enqueue(sink, fresh)
    expect(coordinator.protocolCounters().staleEnqueueDrops).toBe(0)

    const [stale] = projectSequence(chat(2, ['two']))
    coordinator.enqueue(sink, stale)

    expect(coordinator.protocolCounters()).toMatchObject({ staleEnqueueDrops: 1 })
  })

  it('tallies rejected ACKs by failing validation check', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const [first] = projectSequence(chat(1, ['one']))
    coordinator.enqueue(sink, first)
    // A nack with no main-side mismatch is a renderer apply failure.
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: false })
    expect(coordinator.protocolCounters()).toMatchObject({
      ackRejections: 1,
      ackRejectReasons: { rendererApplyFailure: 1 }
    })

    // A revision mismatch is attributed to its own axis.
    const [, second] = projectSequence(chat(1, ['one']), chat(2, ['two']))
    coordinator.enqueue(sink, second)
    coordinator.acknowledge(sink.id, {
      deliveryId: sink.deliveries[1].deliveryId,
      applied: true,
      revision: sink.deliveries[1].revision + 999
    })
    expect(coordinator.protocolCounters()).toMatchObject({
      ackRejections: 2,
      ackRejectReasons: { rendererApplyFailure: 1, revisionMismatch: 1 }
    })
  })

  it('returns a copy of the reason map so callers cannot mutate internal tallies', () => {
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const snapshot = coordinator.protocolCounters()
    snapshot.ackRejectReasons.rendererApplyFailure = 99
    expect(coordinator.protocolCounters().ackRejectReasons).toEqual({})
  })

  it('keeps serialized-byte diagnostics absent unless explicitly enabled', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    coordinator.enqueue(sink, chat(1, ['one']))

    expect(coordinator.protocolCounters().serializedBytes).toBeUndefined()
  })

  it('records categorized serialized-byte totals only when explicitly enabled', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2,
      measureSerializedBytes: true
    })

    coordinator.enqueue(sink, chat(1, ['one']))

    const totals = coordinator.protocolCounters().serializedBytes
    expect(totals).toMatchObject({
      envelope: expect.any(Number),
      peak: expect.any(Number),
      ensemble: expect.any(Number),
      runs: expect.any(Number),
      nonMessageRecord: expect.any(Number),
      messages: expect.any(Number)
    })
    expect(totals?.envelope).toBeGreaterThan(0)
    expect(totals?.peak).toBe(totals?.envelope)
    expect(totals?.nonMessageRecord).toBeGreaterThan(0)
    expect(totals?.messages).toBeGreaterThan(0)
  })
})

/**
 * KNOWN DEFECT, pinned deliberately: an oversized chat can never patch.
 *
 * `boundChatUpdateSnapshot` delivers a marked shell for a chat over
 * `DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES` rows — a tail page plus `summaryOnly`,
 * `transcriptPaged`, `messageCount`, `runCount` and `runWallMs`. Every one of
 * those is a NON-message field, so every one of them is inside
 * `computeChatSubRevisions`, which hashes the record without its messages.
 *
 * The coordinator hashes the DELIVERED shell — correct, that is what the
 * renderer ACKs — but retains the CANONICAL record as `baselineChat`. On the
 * next send `retainedBaselineMatchesAcknowledged` recomputes the canonical
 * record's hash and compares it against the shell's. They cannot be equal, so
 * the baseline is dropped and a full snapshot is sent, forever. Every delivery
 * to a large thread is a whole-record send, which is precisely the cost v2
 * patching exists to avoid, and it is silent: the counters report healthy
 * snapshots rather than a stuck lane.
 *
 * These tests assert the behaviour AS IT IS so the defect is named, located and
 * discoverable instead of folklore. Fixing it is not a one-line change —
 * retaining the shell as the patch base also requires the producer's delta and
 * main's ACK hash to be computed over the shell projection rather than the
 * canonical record, or the very next patch nacks on a record-hash mismatch and
 * the renderer is left believing it holds a complete transcript when it holds
 * one page. When that lands, these expectations flip to `patch` / `0`.
 */
describe('ChatUpdateDeliveryCoordinator bounded-snapshot baselines', () => {
  function oversizedChat(updatedAt: number, tailContent: string): ChatRecord {
    const contents = Array.from({ length: 1_501 }, (_, index) => `row-${index}`)
    contents[contents.length - 1] = tailContent
    return chat(updatedAt, contents)
  }

  it('delivers an oversized chat as a bounded shell, not the canonical record', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    coordinator.enqueue(sink, oversizedChat(1, 'first'))
    const delivery = sink.deliveries[0]
    expect(delivery.kind).toBe('snapshot')
    if (delivery.kind !== 'snapshot') throw new Error('expected a snapshot')
    expect((delivery.chat as { transcriptPaged?: boolean }).transcriptPaged).toBe(true)
    expect(delivery.chat.messages.length).toBeLessThan(1_501)
  })

  it('drops the baseline on every later delivery, so a large thread never patches', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })

    const records = projectSequence(
      oversizedChat(1, 'one'),
      oversizedChat(2, 'two'),
      oversizedChat(3, 'three'),
      oversizedChat(4, 'four')
    )
    for (const record of records) {
      coordinator.enqueue(sink, record)
      const latest = sink.deliveries[sink.deliveries.length - 1]
      coordinator.acknowledge(sink.id, { deliveryId: latest.deliveryId, applied: true })
    }

    const counters = coordinator.protocolCounters()
    // Four whole-record snapshots where three compact patches belonged.
    expect(counters.snapshots).toBe(4)
    expect(counters.patches).toBe(0)
    expect(counters.baselineDrops).toBe(3)
    expect(sink.deliveries.every((delivery) => delivery.kind === 'snapshot')).toBe(true)
    // Guard the guard: `every` over an empty list is vacuous.
    expect(sink.deliveries).toHaveLength(4)
  })

  it('patches normally for a chat small enough to deliver whole', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 0,
      emitProtocolVersion: 2
    })
    const [first, second] = projectSequence(chat(1, ['one']), chat(2, ['two']))
    coordinator.enqueue(sink, first)
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: true })
    coordinator.enqueue(sink, second)
    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ baselineDrops: 0 })
  })
})
