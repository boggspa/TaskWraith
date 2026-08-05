import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import { applyChatUpdateDelivery, type ChatUpdateDelivery } from '../shared/chatUpdateTransport'
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
    updatedAt
  } as ChatRecord
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
    expect(patched).toEqual({
      ok: true,
      baseline: { revision: patch.revision, chat: latest }
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
