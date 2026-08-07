/**
 * T3a-1 integration regression: coalesced saves vs history deletion.
 *
 * The unit tests in `saveCoalescer.test.ts` prove the coalescer's own
 * `discard` contract. They cannot prove the STORE calls it. This file covers
 * that wiring, because the failure it guards is a history-deletion violation
 * (NON-NEGOTIABLE #4), not a cosmetic bug: a save deferred behind a timer for
 * a chat that is then deleted will recreate the chat file when the timer
 * fires, and `getChats()` enumerates the chats directory, so the deleted chat
 * reappears in the list and in every projection built from it.
 *
 * SCOPE NOTE: this lives under `saveCoalescer*` because that is this lane's
 * approved write scope. Its natural long-term home is
 * `src/main/AppStoreDeleteChat.test.ts` alongside the other deletion
 * regressions — a reviewer or a lane holding that file may move it verbatim.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './index'
import type { ChatRecord, ChatRun } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-coalescer-deletion-test-${process.pid}`)

// Pin this suite's coalescing window BEFORE the store module is imported and
// reads it. Without this the test would silently go vacuous the moment the
// production default is retuned upward: the pending timer would never fire
// inside the settle window, and "the file did not reappear" would prove
// nothing at all.
vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '50'
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatFilePath = (chatId: string): string => join(userDataPath, 'chats', `${chatId}.json`)

/** A run the coalescer will treat as live. Only a running run defers a save. */
function runningRun(runId: string): ChatRun {
  return { runId, startedAt: '2026-05-08T00:00:00.000Z', status: 'running' }
}

function saveChat(appChatId: string, runs: ChatRun[]): ChatRecord {
  const chat: ChatRecord = {
    appChatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'gemini',
    title: appChatId,
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs
  }
  AppStore.saveChat(chat)
  return chat
}

/**
 * Leave a deferred write pending for `chatId`. The first save always writes
 * synchronously (the file does not exist yet), so a second save is required
 * before anything is actually pending.
 */
function leavePendingSave(chatId: string): void {
  const chat = saveChat(chatId, [runningRun(`${chatId}-run`)])
  expect(fs.existsSync(chatFilePath(chatId))).toBe(true)
  chat.title = 'streaming update'
  AppStore.saveChat(chat)
}

/** Longer than the coalescing window, so any pending timer has fired. */
const settleTimers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

describe('save coalescing vs history deletion', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    AppStore.resetTransientDeletionGuardsForTests()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it('does not resurrect a deleted chat when a coalesced save is still pending', async () => {
    leavePendingSave('chat-pending')

    AppStore.deleteChat('chat-pending')
    expect(fs.existsSync(chatFilePath('chat-pending'))).toBe(false)

    await settleTimers()

    // Without discard-on-delete the pending timer recreates this file.
    expect(fs.existsSync(chatFilePath('chat-pending'))).toBe(false)
    expect(AppStore.getChats().some((entry) => entry.appChatId === 'chat-pending')).toBe(false)
  })

  it('leaves an untouched sibling chat pending write intact', async () => {
    // Discarding must be surgical: deleting one chat must not silently drop
    // another chat's deferred write, which would lose that chat's newest data.
    leavePendingSave('chat-victim')
    leavePendingSave('chat-survivor')

    AppStore.deleteChat('chat-victim')

    await settleTimers()

    expect(fs.existsSync(chatFilePath('chat-victim'))).toBe(false)
    expect(fs.existsSync(chatFilePath('chat-survivor'))).toBe(true)

    const survivor = AppStore.getChats().find((entry) => entry.appChatId === 'chat-survivor')
    expect(survivor).toBeDefined()
    // The survivor's pending write must have landed, not been discarded.
    expect(survivor?.title).toBe('streaming update')
  })

  it('clears every pending write when all chat history is deleted', async () => {
    leavePendingSave('chat-one')
    leavePendingSave('chat-two')

    AppStore.clearChats()

    await settleTimers()

    expect(fs.existsSync(chatFilePath('chat-one'))).toBe(false)
    expect(fs.existsSync(chatFilePath('chat-two'))).toBe(false)
    expect(AppStore.getChats()).toHaveLength(0)
  })
})
