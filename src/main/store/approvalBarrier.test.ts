/**
 * Item 5 — narrow the 'approval' save barrier.
 *
 * The barrier exists so an open approval RENDERS PROMPTLY. It was implemented
 * as a synchronous whole-record write-through (`saveCoalescer` treats any
 * reason !== 'normal' as a durability barrier), and it re-fired on EVERY save
 * for as long as the approval stayed open. During a fan-out round that is a
 * full fsync of the chat record per save, for the entire time a human is
 * looking at the dialog — exactly the amplification this epic is removing.
 *
 * Narrowing, not removing: the compatibility checkpoint still fires on the
 * save that OPENS or CHANGES an approval. Subsequent saves while the same
 * approval stays open are fsynced as V2 mutations without another full write.
 *
 * Why deferring those is safe — all three verified in source, not assumed:
 *  1. Approval DECISIONS never went through this path. `writeApprovalLedger`
 *     (index.ts) writes `approval-ledger.json` via `writeJson` synchronously,
 *     outside the coalescer entirely.
 *  2. Rendering does not come from the chat file. An open approval is pushed
 *     to the renderer as `agent-approval-request` (index.ts), and to remote
 *     devices via the APNs attention fanout — neither reads the record.
 *  3. In-process readers are never stale: `saveChat` stamps `chatRecordCache`
 *     with the `mtimeMs: -1` dirty marker before scheduling, and
 *     `readChatRecordCached` returns a dirty entry without stat-ing the file.
 *
 * The last property is asserted here directly, because it is the one that
 * would silently rot if someone later removed the dirty marker.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord, ChatRun } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-approval-barrier-test-${process.pid}`)

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

/** An ensemble round with one lane parked on an approval. */
function awaitingApproval(laneId: string, approvalsQueued = 0): ChatRecord['ensemble'] {
  return {
    activeRound: {
      lanes: {
        [laneId]: {
          laneId,
          participantId: 'p1',
          provider: 'gemini',
          status: 'awaiting-approval',
          intent: 'write',
          startedAt: '2026-05-08T00:00:00.000Z',
          ...(approvalsQueued ? { approvalsQueued } : {})
        }
      }
    }
  } as unknown as ChatRecord['ensemble']
}

/** Title currently on disk — the test of whether a save was written through. */
function persistedTitle(chatId: string): string | null {
  if (!fs.existsSync(chatFilePath(chatId))) return null
  return JSON.parse(fs.readFileSync(chatFilePath(chatId), 'utf-8')).title
}

function approvalFlushes(): number {
  return AppStore.getPersistenceCoalescingStats().coalescer.reasonMix.approval
}

describe('approval save barrier', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    AppStore.resetTransientDeletionGuardsForTests()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it('does not re-fsync the whole record on every save while one approval stays open', () => {
    const chat = baseChat('chat-open-approval', [runningRun('run-live')])
    AppStore.saveChat(chat)

    // The approval opens — this save must be written through.
    chat.ensemble = awaitingApproval('lane-1')
    chat.title = 'approval opened'
    AppStore.saveChat(chat)
    expect(persistedTitle('chat-open-approval')).toBe('approval opened')
    const afterOpen = approvalFlushes()

    // The human is still looking at the dialog. Streaming continues, and the
    // SAME approval is still open — these saves must defer like any other.
    chat.title = 'still streaming 1'
    AppStore.saveChat(chat)
    chat.title = 'still streaming 2'
    AppStore.saveChat(chat)

    expect(persistedTitle('chat-open-approval')).toBe('approval opened')
    expect(approvalFlushes()).toBe(afterOpen)
  })

  it('still writes through the save that opens an approval', () => {
    const chat = baseChat('chat-opens', [runningRun('run-live')])
    AppStore.saveChat(chat)
    const before = approvalFlushes()

    chat.ensemble = awaitingApproval('lane-1')
    chat.title = 'approval opened'
    AppStore.saveChat(chat)

    // The transition is what a reader must see promptly.
    expect(persistedTitle('chat-opens')).toBe('approval opened')
    expect(approvalFlushes()).toBe(before + 1)
  })

  it('writes through again when a second approval opens', () => {
    const chat = baseChat('chat-second', [runningRun('run-live')])
    AppStore.saveChat(chat)
    chat.ensemble = awaitingApproval('lane-1')
    chat.title = 'first approval'
    AppStore.saveChat(chat)
    const afterFirst = approvalFlushes()

    chat.title = 'deferred while open'
    AppStore.saveChat(chat)
    expect(approvalFlushes()).toBe(afterFirst)

    // A different lane parks on its own approval — a new thing to render.
    chat.ensemble = awaitingApproval('lane-2')
    chat.title = 'second approval'
    AppStore.saveChat(chat)

    expect(persistedTitle('chat-second')).toBe('second approval')
    expect(approvalFlushes()).toBe(afterFirst + 1)
  })

  it('writes through when the queued approval count changes', () => {
    const chat = baseChat('chat-queue', [runningRun('run-live')])
    AppStore.saveChat(chat)
    chat.ensemble = awaitingApproval('lane-1', 1)
    chat.title = 'one queued'
    AppStore.saveChat(chat)
    const afterFirst = approvalFlushes()

    chat.ensemble = awaitingApproval('lane-1', 2)
    chat.title = 'two queued'
    AppStore.saveChat(chat)

    expect(persistedTitle('chat-queue')).toBe('two queued')
    expect(approvalFlushes()).toBe(afterFirst + 1)
  })

  it('re-arms after an approval closes and a later one opens', () => {
    const chat = baseChat('chat-rearm', [runningRun('run-live')])
    AppStore.saveChat(chat)
    chat.ensemble = awaitingApproval('lane-1')
    chat.title = 'opened'
    AppStore.saveChat(chat)

    // Approval resolved: no open approvals left. A running run governs, so
    // this defers — and the barrier must forget the closed approval.
    chat.ensemble = { activeRound: { lanes: {} } } as unknown as ChatRecord['ensemble']
    chat.title = 'resolved'
    AppStore.saveChat(chat)
    const afterResolve = approvalFlushes()

    chat.ensemble = awaitingApproval('lane-1')
    chat.title = 'reopened'
    AppStore.saveChat(chat)

    // Same lane id as before: if the signature were never cleared this would
    // be treated as "unchanged" and the reopened approval would sit in a timer.
    expect(persistedTitle('chat-rearm')).toBe('reopened')
    expect(approvalFlushes()).toBe(afterResolve + 1)
  })

  it('serves the open approval to readers immediately even while the write defers', () => {
    const chat = baseChat('chat-render', [runningRun('run-live')])
    AppStore.saveChat(chat)
    chat.ensemble = awaitingApproval('lane-1')
    chat.title = 'approval opened'
    AppStore.saveChat(chat)

    chat.title = 'deferred but visible'
    AppStore.saveChat(chat)

    // The durable write is still pending...
    expect(persistedTitle('chat-render')).toBe('approval opened')
    // ...but every in-process reader (IPC, bridge broadcast, projections)
    // already sees it. This is what makes deferring the fsync safe.
    expect(AppStore.getChat('chat-render')?.title).toBe('deferred but visible')
  })

  /* The 'history-deletion' barrier is deliberately NOT re-asserted here.
   * `deletedChatIds` is module-private with no way to mark a chat as deleting
   * from a test, so any assertion written at this level passes whether or not
   * the barrier exists — worse than no test. It stays checked FIRST in
   * deriveSaveFlushReason and is covered end-to-end by
   * saveCoalescerDeletion.test.ts and AppStoreHistoryDeletionTransaction.test.ts. */

  it('keeps later approval streaming durable without another whole-record rewrite', async () => {
    const chat = baseChat('chat-lands', [runningRun('run-live')])
    AppStore.saveChat(chat)
    chat.ensemble = awaitingApproval('lane-1')
    chat.title = 'approval opened'
    AppStore.saveChat(chat)

    chat.title = 'eventually durable'
    AppStore.saveChat(chat)
    expect(persistedTitle('chat-lands')).toBe('approval opened')

    await new Promise((resolve) => setTimeout(resolve, 200))

    // The compatibility checkpoint remains at the approval transition; the
    // later streaming mutation is already fsynced in V2 and cold-replayable.
    expect(persistedTitle('chat-lands')).toBe('approval opened')
    AppStore.clearChatRecordCacheForTests()
    expect(AppStore.getChat('chat-lands')?.title).toBe('eventually durable')
  })
})
