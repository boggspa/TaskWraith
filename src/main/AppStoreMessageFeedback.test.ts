import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import type { ChatRecord } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-message-feedback-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function makeChat(
  id: string,
  feedback?: { vote: 'up' | 'down'; at: number; reason?: string; note?: string }
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
        status: 'success'
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

  it('records flip and clear transitions without duplicating repeated saves', () => {
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
    AppStore.saveChat(makeChat(chatId))
    AppStore.saveChat(makeChat(chatId))

    const receipts = AppStore.getMessageFeedbackReceipts({ chatId })
    expect(receipts.map((receipt) => receipt.action)).toEqual(['set', 'flip', 'clear'])
    expect(receipts[1]).toMatchObject({
      action: 'flip',
      vote: 'down',
      previousVote: 'up',
      reason: 'wrong-model-for-role',
      note: 'Missed the review brief.',
      noteSensitive: true
    })
    expect(receipts[2]).toMatchObject({
      action: 'clear',
      previousVote: 'down'
    })
    expect(receipts[2].vote).toBeUndefined()
  })
})
