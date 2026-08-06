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
import type { ChatUpdateDelivery } from '../shared/chatUpdateTransport'
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
    updatedAt
  } as ChatRecord
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

    coordinator.enqueue(sink, chat(1, ['one']))
    coordinator.enqueue(sink, chat(2, ['two']))
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

    coordinator.enqueue(sink, chat(1, ['one']))
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[0].deliveryId, applied: true })
    coordinator.enqueue(sink, chat(2, ['two']))
    expect(sink.deliveries[1].kind).toBe('patch')
    expect(coordinator.protocolCounters()).toMatchObject({ baselineDrops: 0 })

    // The renderer could not apply the patch. That drops the baseline — the
    // degradation this counter exists to make visible.
    coordinator.acknowledge(sink.id, { deliveryId: sink.deliveries[1].deliveryId, applied: false })
    coordinator.enqueue(sink, chat(3, ['three']))

    const latest = sink.deliveries[sink.deliveries.length - 1]
    expect(latest.kind).toBe('snapshot')
    const counters = coordinator.protocolCounters()
    expect(counters.baselineDrops).toBeGreaterThanOrEqual(1)
    // A measurement window can now see the ratio rather than assuming it.
    expect(counters.snapshots).toBeGreaterThanOrEqual(2)
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
})
