import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import { computeChatSubRevisions } from '../../../shared/chatUpdateTransport'
import { buildChatUpdateAck } from './chatUpdateAck'

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-08-05T00:00:00.000Z' }
}

function chat(contents: string[]): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Ensemble',
    provider: 'codex',
    chatKind: 'ensemble',
    archived: false,
    messages: contents.map((content, index) => message(`m-${index}`, content)),
    runs: [],
    createdAt: 1,
    updatedAt: 2
  } as ChatRecord
}

describe('buildChatUpdateAck', () => {
  it('emits deliveryId + applied only on rejection', () => {
    expect(
      buildChatUpdateAck({
        delivery: { deliveryId: 'd1', revision: 3, recordHash: 'abc' },
        applied: false
      })
    ).toEqual({ deliveryId: 'd1', applied: false })
  })

  it('enriches successful ACKs with revision + recordHash from the delivery', () => {
    expect(
      buildChatUpdateAck({
        delivery: { deliveryId: 'd2', revision: 7, recordHash: 'deadbeef' },
        applied: true
      })
    ).toEqual({
      deliveryId: 'd2',
      applied: true,
      revision: 7,
      recordHash: 'deadbeef'
    })
  })

  it('computes recordHash from the applied chat when the delivery omits it', () => {
    const appliedChat = chat(['hello'])
    const ack = buildChatUpdateAck({
      delivery: { deliveryId: 'd3', revision: 4 },
      applied: true,
      appliedChat
    })
    expect(ack).toEqual({
      deliveryId: 'd3',
      applied: true,
      revision: 4,
      recordHash: computeChatSubRevisions(appliedChat).recordHash
    })
  })
})
