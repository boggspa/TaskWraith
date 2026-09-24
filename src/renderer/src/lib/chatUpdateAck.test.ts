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

  it('does not echo the delivery producer hash', () => {
    const appliedChat = chat(['hello'])
    expect(
      buildChatUpdateAck({
        delivery: { deliveryId: 'd2', revision: 7, recordHash: 'deadbeef' },
        applied: true,
        appliedChat
      })
    ).toEqual({
      deliveryId: 'd2',
      applied: true,
      revision: 7,
      recordHash: computeChatSubRevisions(appliedChat).recordHash
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

  it('prefers an explicit appliedRecordHash over the applied chat', () => {
    expect(
      buildChatUpdateAck({
        delivery: { deliveryId: 'd4', revision: 8, recordHash: 'deadbeef' },
        applied: true,
        appliedChat: chat(['hello']),
        appliedRecordHash: 'applied-hash'
      })
    ).toEqual({
      deliveryId: 'd4',
      applied: true,
      revision: 8,
      recordHash: 'applied-hash'
    })
  })

  it('echoes delivery and renderer epochs with the applied transcript digest', () => {
    expect(
      buildChatUpdateAck({
        delivery: {
          deliveryId: 'd5',
          revision: 9,
          chatId: 'chat-1',
          deliveryEpoch: 12
        },
        applied: true,
        phase: 'accepted',
        rendererEpoch: 'renderer-1',
        appliedRecordHash: 'record-1',
        appliedTranscriptHash: 'transcript-1'
      })
    ).toEqual({
      deliveryId: 'd5',
      applied: true,
      phase: 'accepted',
      chatId: 'chat-1',
      deliveryEpoch: 12,
      rendererEpoch: 'renderer-1',
      revision: 9,
      recordHash: 'record-1',
      transcriptHash: 'transcript-1'
    })
  })
})
