/**
 * T4c — which FlushReason each save emits, observed through real behaviour.
 *
 * The derivation is only meaningful if the barrier reasons actually stop a
 * save from sitting in a timer. These tests assert the OBSERVABLE consequence
 * (is the record on disk immediately, or only after the coalescing window?)
 * plus the recorded reason mix, rather than reaching into a private helper.
 *
 * Every status string used here was verified against the live type
 * definitions: `RunStatus` is success|success_with_warnings|failed|cancelled|
 * running|sleeping (no approval member), and the approval signal is
 * `ConcurrentLaneStatus.'awaiting-approval'` on
 * `chat.ensemble.activeRound.lanes`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './index'
import type { ChatRecord, ChatRun } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-flush-reason-test-${process.pid}`)

vi.hoisted(() => {
  process.env.TASKWRAITH_SAVE_COALESCE_MS = '50'
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatFilePath = (chatId: string): string => join(userDataPath, 'chats', `${chatId}.json`)

function runningRun(runId: string): ChatRun {
  return { runId, startedAt: '2026-05-08T00:00:00.000Z', status: 'running' }
}

function baseChat(appChatId: string, runs: ChatRun[] = []): ChatRecord {
  return {
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
}

/** Title currently on disk — the test of whether a save was deferred. */
function persistedTitle(chatId: string): string | null {
  if (!fs.existsSync(chatFilePath(chatId))) return null
  return JSON.parse(fs.readFileSync(chatFilePath(chatId), 'utf-8')).title
}

function reasonMix(): Record<string, number> {
  return AppStore.getPersistenceCoalescingStats().coalescer.reasonMix
}

describe('T4c save flush reason', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    AppStore.resetTransientDeletionGuardsForTests()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it("defers a streaming save as 'normal'", () => {
    const chat = baseChat('chat-streaming', [runningRun('run-live')])
    AppStore.saveChat(chat)
    const before = reasonMix().normal

    chat.title = 'deferred update'
    AppStore.saveChat(chat)

    // Still the old title on disk: the save is sitting in the timer.
    expect(persistedTitle('chat-streaming')).toBe('chat-streaming')
    expect(reasonMix().normal).toBe(before + 1)
  })

  it("writes an idle save through immediately as 'terminal'", () => {
    const chat = baseChat('chat-idle', [
      { runId: 'run-done', startedAt: '2026-05-08T00:00:00.000Z', status: 'success' }
    ])
    AppStore.saveChat(chat)
    const before = reasonMix().terminal

    chat.title = 'idle update'
    AppStore.saveChat(chat)

    // No running run ⇒ barrier ⇒ already durable with no waiting.
    expect(persistedTitle('chat-idle')).toBe('idle update')
    expect(reasonMix().terminal).toBe(before + 1)
  })

  it("writes through as 'approval' when a lane is awaiting approval, even mid-run", () => {
    const chat = baseChat('chat-approval', [runningRun('run-live')])
    AppStore.saveChat(chat)
    const before = reasonMix().approval

    // A running run would normally defer. An open approval gate outranks it.
    chat.ensemble = {
      activeRound: {
        lanes: {
          'lane-1': {
            laneId: 'lane-1',
            participantId: 'p1',
            provider: 'gemini',
            status: 'awaiting-approval',
            intent: 'write',
            startedAt: '2026-05-08T00:00:00.000Z'
          }
        }
      }
    } as unknown as ChatRecord['ensemble']
    chat.title = 'approval pending update'
    AppStore.saveChat(chat)

    expect(persistedTitle('chat-approval')).toBe('approval pending update')
    expect(reasonMix().approval).toBe(before + 1)
  })

  it('treats a queued approval count as an approval barrier', () => {
    const chat = baseChat('chat-approval-count', [runningRun('run-live')])
    AppStore.saveChat(chat)
    const before = reasonMix().approval

    chat.ensemble = {
      activeRound: {
        lanes: {
          'lane-1': {
            laneId: 'lane-1',
            participantId: 'p1',
            provider: 'gemini',
            status: 'running',
            intent: 'write',
            startedAt: '2026-05-08T00:00:00.000Z',
            approvalsQueued: 2
          }
        }
      }
    } as unknown as ChatRecord['ensemble']
    chat.title = 'queued approval update'
    AppStore.saveChat(chat)

    expect(persistedTitle('chat-approval-count')).toBe('queued approval update')
    expect(reasonMix().approval).toBe(before + 1)
  })

  it('does not raise an approval barrier for a settled lane', () => {
    const chat = baseChat('chat-lane-settled', [runningRun('run-live')])
    AppStore.saveChat(chat)
    const before = reasonMix().approval

    chat.ensemble = {
      activeRound: {
        lanes: {
          'lane-1': {
            laneId: 'lane-1',
            participantId: 'p1',
            provider: 'gemini',
            status: 'completed',
            intent: 'read',
            startedAt: '2026-05-08T00:00:00.000Z',
            approvalsQueued: 0
          }
        }
      }
    } as unknown as ChatRecord['ensemble']
    chat.title = 'settled lane update'
    AppStore.saveChat(chat)

    // No open approval ⇒ the running run governs ⇒ deferred as before.
    expect(persistedTitle('chat-lane-settled')).toBe('chat-lane-settled')
    expect(reasonMix().approval).toBe(before)
  })
})
