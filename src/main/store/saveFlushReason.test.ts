/**
 * T4c — which FlushReason each save emits, observed through real behaviour.
 *
 * Normal saves now fsync V2 mutations without scheduling a whole-record timer;
 * barrier reasons still materialize compatibility checkpoints immediately.
 * These tests assert those observable consequences and recorded reason mixes.
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
import { AppStore } from '../store'
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

function incrementalNormalSaves(): number {
  return AppStore.getIncrementalChatPersistenceStats().boundaryMix.normal
}

/** Statuses `isActiveChatRunStatus` treats as live that the raw `'running'` test did not. */
const LIVE_BEYOND_RUNNING: readonly string[] = [
  'starting',
  'queued',
  'cancelling',
  'steer_promoting',
  'active',
  'paused'
]

const MATRIX_STATUSES = [
  'running',
  'sleeping',
  'success',
  'success_with_warnings',
  'failed',
  'cancelled',
  'queued',
  'starting',
  'cancelling',
  'steer_promoting',
  'active',
  'paused',
  'completed',
  'mystery'
] as const

const APPROVAL_SHAPES = ['none', 'awaiting', 'queued'] as const

interface FlushReasonRow {
  status: string
  approval: string
  save2: string
  disk2: string
  save3: string
  disk3: string
}

/**
 * Captured from `deriveSaveFlushReason` at HEAD e55a8c75d, before the shared
 * liveness predicate, by the exact walk `flushReasonMatrix` performs. Do not
 * regenerate from the current code: it is the oracle the equivalence half of
 * the test above compares against.
 */
const PRE_CHANGE_FLUSH_REASON_MATRIX: readonly FlushReasonRow[] = [
  {
    status: 'running',
    approval: 'none',
    save2: 'normal+1',
    disk2: 'deferred',
    save3: 'normal+1',
    disk3: 'deferred'
  },
  {
    status: 'running',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'normal+1',
    disk3: 'deferred'
  },
  {
    status: 'running',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'normal+1',
    disk3: 'deferred'
  },
  {
    status: 'sleeping',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'sleeping',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'sleeping',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'success',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'success',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'success',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'success_with_warnings',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'success_with_warnings',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'success_with_warnings',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'failed',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'failed',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'failed',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'cancelled',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'cancelled',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'cancelled',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'queued',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'queued',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'queued',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'starting',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'starting',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'starting',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'cancelling',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'cancelling',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'cancelling',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'steer_promoting',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'steer_promoting',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'steer_promoting',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'active',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'active',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'active',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'paused',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'paused',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'paused',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'completed',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'completed',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'completed',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'mystery',
    approval: 'none',
    save2: 'terminal+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'mystery',
    approval: 'awaiting',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  },
  {
    status: 'mystery',
    approval: 'queued',
    save2: 'approval+1',
    disk2: 'written-through',
    save3: 'terminal+1',
    disk3: 'written-through'
  }
]

function approvalShape(kind: (typeof APPROVAL_SHAPES)[number]): ChatRecord['ensemble'] | undefined {
  if (kind === 'none') return undefined
  return {
    activeRound: {
      lanes: {
        'lane-1': {
          laneId: 'lane-1',
          participantId: 'p1',
          provider: 'gemini',
          status: kind === 'awaiting' ? 'awaiting-approval' : 'running',
          intent: 'write',
          startedAt: '2026-05-08T00:00:00.000Z',
          ...(kind === 'queued' ? { approvalsQueued: 2 } : {})
        }
      }
    }
  } as unknown as ChatRecord['ensemble']
}

function boundaryMix(): Record<string, number> {
  return { ...AppStore.getIncrementalChatPersistenceStats().boundaryMix }
}

function boundaryDelta(before: Record<string, number>, after: Record<string, number>): string {
  const keys = ['normal', 'approval', 'terminal']
  const moved = keys.filter((key) => (after[key] ?? 0) !== (before[key] ?? 0))
  return moved.map((key) => `${key}+${(after[key] ?? 0) - (before[key] ?? 0)}`).join(',') || 'none'
}

/**
 * The exact walk the golden matrix was captured with (one approval shape per
 * call so each test stays inside the local 5 s timeout: every save fsyncs).
 * Do not edit the walk.
 */
function flushReasonMatrix(shape: (typeof APPROVAL_SHAPES)[number]): FlushReasonRow[] {
  const rows: FlushReasonRow[] = []
  let index = 0
  for (const status of MATRIX_STATUSES) {
    for (const approval of APPROVAL_SHAPES) {
      index += 1
      if (approval !== shape) continue
      const chatId = `chat-${index}-${status}-${approval}`
      const chat = baseChat(chatId, [
        { runId: 'run-1', startedAt: '2026-05-08T00:00:00.000Z', status }
      ])
      AppStore.saveChat(chat)
      // Save 2: an edit; for approval shapes this save OPENS the approval.
      chat.ensemble = approvalShape(approval)
      chat.title = `${chatId} edit 1`
      const before2 = boundaryMix()
      AppStore.saveChat(chat)
      const save2 = boundaryDelta(before2, boundaryMix())
      const disk2 = persistedTitle(chatId) === chat.title ? 'written-through' : 'deferred'
      // Save 3: the approval (if any) is unchanged, so the run predicate governs.
      chat.title = `${chatId} edit 2`
      const before3 = boundaryMix()
      AppStore.saveChat(chat)
      const save3 = boundaryDelta(before3, boundaryMix())
      const disk3 = persistedTitle(chatId) === chat.title ? 'written-through' : 'deferred'
      rows.push({ status, approval, save2, disk2, save3, disk3 })
    }
  }
  return rows
}

describe('T4c save flush reason', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    AppStore.resetTransientDeletionGuardsForTests()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it("persists a streaming save as an incremental 'normal' mutation", () => {
    const chat = baseChat('chat-streaming', [runningRun('run-live')])
    AppStore.saveChat(chat)
    const before = incrementalNormalSaves()

    chat.title = 'deferred update'
    AppStore.saveChat(chat)

    // The compatibility checkpoint stays cold; V2 already fsynced the delta.
    expect(persistedTitle('chat-streaming')).toBe('chat-streaming')
    expect(AppStore.getChat('chat-streaming')?.title).toBe('deferred update')
    expect(incrementalNormalSaves()).toBe(before + 1)
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

  it.each(LIVE_BEYOND_RUNNING)(
    "treats a run parked at '%s' as live: the save is a normal streaming mutation",
    (status) => {
      const chatId = `chat-live-${status}`
      const chat = baseChat(chatId, [
        { runId: 'run-live', startedAt: '2026-05-08T00:00:00.000Z', status }
      ])
      AppStore.saveChat(chat)
      const before = incrementalNormalSaves()

      chat.title = 'still streaming'
      AppStore.saveChat(chat)

      // Before the shared predicate every one of these read as idle and wrote
      // the whole record through as 'terminal' — on a streaming Ensemble
      // thread with a seat at 'starting', that is a full checkpoint per save.
      expect(persistedTitle(chatId)).toBe(chatId)
      expect(AppStore.getChat(chatId)?.title).toBe('still streaming')
      expect(incrementalNormalSaves()).toBe(before + 1)
    }
  )

  it("a sleeping run is not live: the save still writes through as 'terminal'", () => {
    const chat = baseChat('chat-sleeping', [
      { runId: 'run-sleeping', startedAt: '2026-05-08T00:00:00.000Z', status: 'sleeping' }
    ])
    AppStore.saveChat(chat)
    const before = reasonMix().terminal

    chat.title = 'asleep update'
    AppStore.saveChat(chat)

    expect(persistedTitle('chat-sleeping')).toBe('asleep update')
    expect(reasonMix().terminal).toBe(before + 1)
  })

  it.each(APPROVAL_SHAPES)(
    "matches the pre-change flush-reason matrix for the '%s' approval shape everywhere except the six statuses the shared predicate makes live",
    (approval) => {
      const rows = flushReasonMatrix(approval)
      const goldenRows = PRE_CHANGE_FLUSH_REASON_MATRIX.filter(
        (entry) => entry.approval === approval
      )
      expect(rows).toHaveLength(goldenRows.length)
      expect(rows).toHaveLength(MATRIX_STATUSES.length)
      const changed = rows.filter((row) => LIVE_BEYOND_RUNNING.includes(row.status))
      expect(changed).toHaveLength(LIVE_BEYOND_RUNNING.length)

      for (const row of rows) {
        const golden = goldenRows.find((entry) => entry.status === row.status)
        expect(golden).toBeDefined()
        if (!LIVE_BEYOND_RUNNING.includes(row.status)) {
          expect(row).toEqual(golden)
          continue
        }
        // A live run governs whenever no approval TRANSITION outranks it: the
        // save that opens an approval still writes through, the next one is a
        // normal streaming mutation. Every one of these was 'terminal' before.
        expect(golden!.save3).toBe('terminal+1')
        expect(row).toEqual({
          ...golden,
          ...(approval === 'none' ? { save2: 'normal+1', disk2: 'deferred' } : {}),
          save3: 'normal+1',
          disk3: 'deferred'
        })
      }
    }
  )
})
