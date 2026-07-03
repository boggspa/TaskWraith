import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import type { ChatRecord, ChatRun } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-message-feedback-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function makeChat(
  id: string,
  feedback?: { vote: 'up' | 'down'; at: number; reason?: string; note?: string },
  runOverrides: Partial<ChatRun> = {}
): ChatRecord {
  return {
    appChatId: id,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: id,
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done.',
        timestamp: '2026-07-02T12:00:00.000Z',
        runId: 'run-1',
        ...(feedback ? { metadata: { feedback } } : {})
      }
    ],
    runs: [
      {
        runId: 'run-1',
        provider: 'codex',
        startedAt: '2026-07-02T11:59:00.000Z',
        endedAt: '2026-07-02T12:00:00.000Z',
        requestedModel: 'gpt-5.5',
        actualModel: 'gpt-5.5-xhigh',
        status: 'success',
        ...runOverrides
      }
    ]
  }
}

describe('AppStore message feedback receipts', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('backfills message-local feedback into a durable attributed receipt once', () => {
    const chat = makeChat('feedback-chat-backfill', { vote: 'up', at: 1000 })

    AppStore.saveChat(chat)
    AppStore.saveChat(chat)

    const receipts = AppStore.getMessageFeedbackReceipts({ chatId: chat.appChatId })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      schemaVersion: 1,
      source: 'message_metadata',
      action: 'set',
      chatId: chat.appChatId,
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      messageId: 'assistant-1',
      runId: 'run-1',
      provider: 'codex',
      model: 'gpt-5.5-xhigh',
      vote: 'up',
      at: 1000
    })
  })

  it('records flip transitions without duplicating repeated saves', () => {
    const chatId = 'feedback-chat-transitions'
    AppStore.saveChat(makeChat(chatId, { vote: 'up', at: 1000 }))
    AppStore.saveChat(
      makeChat(chatId, {
        vote: 'down',
        at: 2000,
        reason: 'wrong-model-for-role',
        note: 'Missed the review brief.'
      })
    )
    AppStore.saveChat(
      makeChat(chatId, {
        vote: 'down',
        at: 2000,
        reason: 'wrong-model-for-role',
        note: 'Missed the review brief.'
      })
    )

    const receipts = AppStore.getMessageFeedbackReceipts({ chatId })
    expect(receipts.map((receipt) => receipt.action)).toEqual(['set', 'flip'])
    expect(receipts[1]).toMatchObject({
      action: 'flip',
      vote: 'down',
      previousVote: 'up',
      reason: 'wrong-model-for-role',
      note: 'Missed the review brief.',
      noteSensitive: true
    })
  })

  it('treats removing a rating as erasure from the feedback ledger', () => {
    const chatId = 'feedback-chat-clear-erases'
    AppStore.saveChat(makeChat(chatId, { vote: 'down', at: 1000 }))
    expect(AppStore.getMessageFeedbackReceipts({ chatId })).toHaveLength(1)

    AppStore.saveChat(makeChat(chatId))

    expect(AppStore.getMessageFeedbackReceipts({ chatId })).toHaveLength(0)
  })

  it('purges feedback receipts when a rated message is removed from a chat', () => {
    const chat = makeChat('feedback-chat-message-delete', { vote: 'up', at: 1000 })
    AppStore.saveChat(chat)
    expect(AppStore.getMessageFeedbackReceipts({ chatId: chat.appChatId })).toHaveLength(1)

    AppStore.saveChat({ ...chat, messages: [], runs: [] })

    expect(AppStore.getMessageFeedbackReceipts({ chatId: chat.appChatId })).toHaveLength(0)
  })

  it('preserves ensemble lane and stage role attribution from the producing run', () => {
    const chat = makeChat(
      'feedback-chat-ensemble-stage',
      { vote: 'down', at: 3000, reason: 'wrong-model-for-role' },
      {
        ensembleParticipantId: 'participant-reviewer',
        ensembleLaneId: 'round-1:participant-reviewer:0',
        ensembleRole: 'Reviewer',
        ensembleStageRole: 'reviewer'
      }
    )

    AppStore.saveChat(chat)

    const receipts = AppStore.getMessageFeedbackReceipts({ chatId: chat.appChatId })
    expect(receipts[0]).toMatchObject({
      ensembleParticipantId: 'participant-reviewer',
      ensembleLaneId: 'round-1:participant-reviewer:0',
      ensembleRole: 'Reviewer',
      ensembleStageRole: 'reviewer',
      attributionSource: 'run',
      attributionComplete: true,
      vote: 'down',
      reason: 'wrong-model-for-role'
    })
  })

  it('marks metadata-only guest attribution as incomplete', () => {
    const chat = makeChat('feedback-chat-guest-fallback', { vote: 'up', at: 1000 })
    const guestChat: ChatRecord = {
      ...chat,
      messages: [
        {
          ...chat.messages[0],
          runId: undefined,
          metadata: {
            feedback: { vote: 'up', at: 1000 },
            guestRunId: 'guest-run-1',
            guestProvider: 'claude',
            guestModel: 'claude-sonnet-5',
            guestRole: 'Reviewer'
          }
        }
      ],
      runs: []
    }

    AppStore.saveChat(guestChat)

    const receipts = AppStore.getMessageFeedbackReceipts({ chatId: guestChat.appChatId })
    expect(receipts[0]).toMatchObject({
      runId: 'guest-run-1',
      provider: 'claude',
      model: 'claude-sonnet-5',
      role: 'Reviewer',
      attributionSource: 'message_metadata',
      attributionComplete: false
    })
  })

  it('purges feedback receipts when deleting chats or clearing history', () => {
    const workspaceChat = makeChat('feedback-chat-delete', { vote: 'up', at: 1000 })
    const otherChat = makeChat('feedback-chat-clear-all', { vote: 'down', at: 2000 })
    AppStore.saveChat(workspaceChat)
    AppStore.saveChat(otherChat)
    expect(AppStore.getMessageFeedbackReceipts()).toHaveLength(2)

    AppStore.deleteChat(workspaceChat.appChatId)

    expect(AppStore.getMessageFeedbackReceipts({ chatId: workspaceChat.appChatId })).toHaveLength(0)
    expect(AppStore.getMessageFeedbackReceipts({ chatId: otherChat.appChatId })).toHaveLength(1)

    AppStore.clearChats()

    expect(AppStore.getMessageFeedbackReceipts()).toHaveLength(0)
  })
})
