import { describe, expect, it } from 'vitest'
import {
  capMessageFeedbackReceipts,
  updateMessageFeedbackLedgerForChatSave
} from './MessageFeedbackLedger'
import type { ChatRecord, MessageFeedbackReceipt } from './store/types'

function receipt(id: string, chatId: string, messageId: string, vote: 'up' | 'down'): MessageFeedbackReceipt {
  return {
    schemaVersion: 1,
    id,
    source: 'message_metadata',
    action: 'set',
    chatId,
    messageId,
    vote,
    at: 1,
    recordedAt: 1
  }
}

function chat(chatId: string, messageId: string, vote?: 'up' | 'down'): ChatRecord {
  return {
    appChatId: chatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: chatId,
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [
      {
        id: messageId,
        role: 'assistant',
        content: 'Done',
        timestamp: '2026-07-02T00:00:00.000Z',
        ...(vote ? { metadata: { feedback: { vote, at: 10 } } } : {})
      }
    ],
    runs: []
  }
}

describe('MessageFeedbackLedger', () => {
  it('keeps latest per-message state even when trimming old history', () => {
    const records = [
      receipt('old-a', 'chat-a', 'message-a', 'up'),
      receipt('old-b', 'chat-b', 'message-b', 'down'),
      receipt('new-a', 'chat-a', 'message-a', 'down')
    ]

    const capped = capMessageFeedbackReceipts(records, 0)

    expect(capped.map((record) => record.id)).toEqual(['old-b', 'new-a'])
  })

  it('does not emit a duplicate set after capped history preserves latest state', () => {
    const existing = capMessageFeedbackReceipts(
      [
        receipt('old-a', 'chat-a', 'message-a', 'up'),
        receipt('old-b', 'chat-b', 'message-b', 'down')
      ],
      1
    )

    const update = updateMessageFeedbackLedgerForChatSave(
      chat('chat-a', 'message-a', 'up'),
      chat('chat-a', 'message-a', 'up'),
      existing,
      { now: () => 100, idFactory: () => 'new' }
    )

    expect(update.changed).toBe(false)
    expect(update.appended).toEqual([])
  })
})
