import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../main/store/types'
import {
  applyChatUpdateDelivery,
  buildChatUpdateDelivery,
  buildChatUpdateMessageSplice,
  normalizeChatUpdateAck
} from './chatUpdateTransport'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-07-18T00:00:00.000Z' }
}

function chat(revision: number, messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Large ensemble',
    provider: 'codex',
    chatKind: 'ensemble',
    archived: false,
    messages,
    runs: [],
    createdAt: 1,
    updatedAt: revision,
    persistenceRevision: revision
  } as ChatRecord
}

describe('chat update transport', () => {
  it('builds one exact middle splice while retaining an unchanged prefix and suffix', () => {
    const a = message('a', 'A')
    const b = message('b', 'B')
    const c = message('c', 'C')
    const d = message('d', 'D')
    expect(buildChatUpdateMessageSplice([a, b, d], [a, c, d])).toEqual({
      start: 1,
      deleteCount: 1,
      items: [c]
    })
  })

  it('round-trips a revisioned patch to the exact next chat', () => {
    const first = chat(1, [message('a', 'A'), message('b', 'B')])
    const next = {
      ...chat(2, [message('a', 'A'), message('b', 'B grew'), message('c', 'C')]),
      title: 'Updated ensemble'
    }
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'delivery-2',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first }
    })
    expect(delivery.kind).toBe('patch')
    const applied = applyChatUpdateDelivery(delivery, { revision: 1, chat: first })
    expect(applied).toEqual({ ok: true, baseline: { revision: 2, chat: next } })
  })

  it('rejects a patch against the wrong baseline so the sender can resync with a snapshot', () => {
    const first = chat(1, [message('a', 'A')])
    const next = chat(2, [message('a', 'B')])
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'delivery-2',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first }
    })
    expect(applyChatUpdateDelivery(delivery, { revision: 9, chat: first })).toEqual({
      ok: false,
      reason: 'Patch base revision is stale.'
    })
  })

  it('uses a full snapshot when most of the transcript changed', () => {
    const first = chat(
      1,
      Array.from({ length: 60 }, (_, index) => message(`old-${index}`, String(index)))
    )
    const next = chat(
      2,
      Array.from({ length: 60 }, (_, index) => message(`new-${index}`, String(index)))
    )
    expect(
      buildChatUpdateDelivery({
        deliveryId: 'delivery-2',
        revision: 2,
        chat: next,
        baseline: { revision: 1, chat: first }
      }).kind
    ).toBe('snapshot')
  })

  it('keeps an append-sized update small for a multi-megabyte transcript', () => {
    const largeMessages = Array.from({ length: 700 }, (_, index) =>
      message(`message-${index}`, `${index}:${'x'.repeat(2_500)}`)
    )
    const first = chat(1, largeMessages)
    const next = chat(2, [...largeMessages, message('message-700', 'latest result')])
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'delivery-large',
      revision: 2,
      chat: next,
      baseline: { revision: 1, chat: first }
    })

    expect(delivery.kind).toBe('patch')
    expect(JSON.stringify(delivery).length).toBeLessThan(JSON.stringify(next).length * 0.02)
    expect(applyChatUpdateDelivery(delivery, { revision: 1, chat: first })).toEqual({
      ok: true,
      baseline: { revision: 2, chat: next }
    })
  })

  it('strictly bounds renderer acknowledgements', () => {
    expect(normalizeChatUpdateAck({ deliveryId: 'delivery-1', applied: true })).toEqual({
      deliveryId: 'delivery-1',
      applied: true
    })
    expect(normalizeChatUpdateAck({ deliveryId: '', applied: true })).toBeNull()
    expect(normalizeChatUpdateAck({ deliveryId: 'delivery-1', applied: 'yes' })).toBeNull()
  })
})
