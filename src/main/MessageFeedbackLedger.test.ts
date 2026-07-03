import { describe, expect, it } from 'vitest'
import {
  buildMessageFeedbackCastingSignals,
  capMessageFeedbackReceipts,
  filterMessageFeedbackReceipts,
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
  it('keeps the newest latest states while enforcing the hard cap', () => {
    const records = [
      receipt('old-a', 'chat-a', 'message-a', 'up'),
      receipt('old-b', 'chat-b', 'message-b', 'down'),
      receipt('new-a', 'chat-a', 'message-a', 'down'),
      receipt('old-c', 'chat-c', 'message-c', 'up')
    ]

    const capped = capMessageFeedbackReceipts(records, 2)

    expect(capped.map((record) => record.id)).toEqual(['new-a', 'old-c'])
  })

  it('does not exceed the configured cap when every record is a unique rating', () => {
    const records = Array.from({ length: 10 }, (_, index) =>
      receipt(
        `receipt-${index}`,
        `chat-${index}`,
        `message-${index}`,
        index % 2 === 0 ? 'up' : 'down'
      )
    )

    const capped = capMessageFeedbackReceipts(records, 3)

    expect(capped).toHaveLength(3)
    expect(capped.map((record) => record.id)).toEqual(['receipt-7', 'receipt-8', 'receipt-9'])
  })

  it('does not emit a duplicate set after capped history preserves latest state', () => {
    const existing = capMessageFeedbackReceipts(
      [
        receipt('old-a', 'chat-a', 'message-a', 'up'),
        receipt('old-b', 'chat-b', 'message-b', 'down')
      ],
      2
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

  it('refreshes a receipt when unchanged feedback gains run-backed attribution later', () => {
    const previous = chat('chat-a', 'message-a', 'up')
    const next = {
      ...previous,
      runs: [
        {
          runId: 'run-a',
          provider: 'codex',
          requestedModel: 'gpt-5.5',
          actualModel: 'gpt-5.5-xhigh',
          status: 'success',
          startedAt: '2026-07-02T00:00:00.000Z'
        }
      ],
      messages: [{ ...previous.messages[0], runId: 'run-a' }]
    } as ChatRecord
    const existing: MessageFeedbackReceipt[] = [
      {
        ...receipt('old-unresolved', 'chat-a', 'message-a', 'up'),
        attributionSource: 'unresolved',
        attributionComplete: false
      }
    ]

    const update = updateMessageFeedbackLedgerForChatSave(previous, next, existing, {
      now: () => 100,
      idFactory: () => 'refresh'
    })

    expect(update.appended).toHaveLength(1)
    expect(update.appended[0]).toMatchObject({
      id: 'refresh',
      action: 'update',
      runId: 'run-a',
      provider: 'codex',
      model: 'gpt-5.5-xhigh',
      attributionSource: 'run',
      attributionComplete: true
    })
  })

  it('does not collide receipt state when chat ids contain delimiters', () => {
    const existing = [receipt('one', 'chat:a', 'message', 'up')]

    const update = updateMessageFeedbackLedgerForChatSave(
      chat('chat', 'a:message', 'down'),
      chat('chat', 'a:message', 'down'),
      existing,
      { now: () => 100, idFactory: () => 'new' }
    )

    expect(update.records.map((record) => record.id)).toEqual(['one', 'new'])
  })

  it('filters receipts by workspace as well as provider/run', () => {
    const records: MessageFeedbackReceipt[] = [
      {
        ...receipt('a', 'chat-a', 'message-a', 'up'),
        workspaceId: 'ws-1',
        provider: 'codex',
        runId: 'run-a'
      },
      {
        ...receipt('b', 'chat-b', 'message-b', 'down'),
        workspaceId: 'ws-2',
        provider: 'claude',
        runId: 'run-b'
      }
    ]

    expect(
      filterMessageFeedbackReceipts(records, { workspaceId: 'ws-1' }).map((record) => record.id)
    ).toEqual(['a'])
    expect(
      filterMessageFeedbackReceipts(records, { provider: 'claude', runId: 'run-b' }).map(
        (record) => record.id
      )
    ).toEqual(['b'])
  })

  it('derives casting signals from only the latest feedback receipt state', () => {
    const records: MessageFeedbackReceipt[] = [
      {
        ...receipt('old-a', 'chat-a', 'message-a', 'up'),
        provider: 'claude',
        model: 'sonnet-old',
        role: 'Reviewer',
        attributionComplete: true
      },
      {
        ...receipt('new-a', 'chat-a', 'message-a', 'down'),
        action: 'flip',
        provider: 'claude',
        model: 'sonnet-new',
        role: 'Reviewer',
        ensembleStageRole: 'reviewer',
        attributionComplete: true,
        reason: 'wrong-model-for-role',
        recordedAt: 30
      },
      {
        ...receipt('b', 'chat-b', 'message-b', 'up'),
        provider: 'codex',
        model: 'gpt-5.5',
        role: 'Worker',
        ensembleStageRole: 'worker',
        recordedAt: 20
      }
    ]

    expect(buildMessageFeedbackCastingSignals(records)).toEqual([
      {
        provider: 'claude',
        model: 'sonnet-new',
        role: 'Reviewer',
        ensembleStageRole: 'reviewer',
        samples: 1,
        up: 0,
        down: 1,
        net: -1,
        attributionComplete: 1,
        reasonCounts: { 'wrong-model-for-role': 1 },
        latestAt: 30
      },
      {
        provider: 'codex',
        model: 'gpt-5.5',
        role: 'Worker',
        ensembleStageRole: 'worker',
        samples: 1,
        up: 1,
        down: 0,
        net: 1,
        attributionComplete: 0,
        reasonCounts: {},
        latestAt: 20
      }
    ])
  })
})
