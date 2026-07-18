import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import { applyChatUpdateDelivery, type ChatUpdateDelivery } from '../shared/chatUpdateTransport'
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
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
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
    expect(sink.deliveries[1].record.updatedAt).toBe(3)
  })

  it('produces a patch that reconstructs the exact latest pending chat', () => {
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({ minDeliveryIntervalMs: 0 })
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

  it('throttles acknowledged delivery bursts while retaining the latest pending chat', () => {
    vi.useFakeTimers()
    let now = 1_000
    const sink = target()
    const coordinator = new ChatUpdateDeliveryCoordinator({
      minDeliveryIntervalMs: 100,
      now: () => now
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
    expect(sink.deliveries[1].record.updatedAt).toBe(2)
    vi.useRealTimers()
  })
})
