import { describe, expect, it } from 'vitest'
import {
  CHAT_RUN_STALE_EXIT_CODE,
  CHAT_RUN_STALE_SETTLEMENT_STATUS,
  isActiveChatRunStatus,
  reconcileStaleChatRuns,
  settleStaleChatRun
} from './ChatRunReconciler'
import type { ChatRecord, ChatRun } from './store/types'

const NOW = '2026-07-20T12:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const OLD = '2026-07-20T11:00:00.000Z'
const RECENT = '2026-07-20T11:59:50.000Z'

function run(partial: Partial<ChatRun> & Pick<ChatRun, 'runId'>): ChatRun {
  return {
    startedAt: OLD,
    status: 'running',
    ...partial
  }
}

function chat(
  id: string,
  runs: ChatRun[],
  extra: Partial<ChatRecord> = {}
): ChatRecord {
  return {
    appChatId: id,
    title: id,
    provider: 'codex',
    createdAt: NOW_MS,
    updatedAt: NOW_MS,
    messages: [],
    runs,
    ...extra
  } as ChatRecord
}

describe('isActiveChatRunStatus', () => {
  it('flags the active projection statuses', () => {
    for (const status of [
      'running',
      'queued',
      'starting',
      'cancelling',
      'steer_promoting',
      'active',
      'paused'
    ]) {
      expect(isActiveChatRunStatus(status)).toBe(true)
    }
  })

  it('leaves terminal and sleeping statuses alone', () => {
    for (const status of [
      'success',
      'success_with_warnings',
      'failed',
      'cancelled',
      'completed',
      'sleeping',
      'idle',
      undefined,
      null,
      1
    ]) {
      expect(isActiveChatRunStatus(status)).toBe(false)
    }
  })
})

describe('settleStaleChatRun', () => {
  it('marks failed with endedAt and default exit code', () => {
    const settled = settleStaleChatRun(run({ runId: 'r1' }), NOW)
    expect(settled.status).toBe(CHAT_RUN_STALE_SETTLEMENT_STATUS)
    expect(settled.endedAt).toBe(NOW)
    expect(settled.exitCode).toBe(CHAT_RUN_STALE_EXIT_CODE)
  })

  it('preserves an existing exitCode and endedAt', () => {
    const settled = settleStaleChatRun(
      run({ runId: 'r1', exitCode: 42, endedAt: OLD }),
      NOW
    )
    expect(settled.exitCode).toBe(42)
    expect(settled.endedAt).toBe(OLD)
  })
})

describe('reconcileStaleChatRuns', () => {
  it('settles active runs with no live owner and leaves live ones alone', () => {
    const live = new Set(['live-1'])
    const result = reconcileStaleChatRuns(
      [
        chat('c1', [
          run({ runId: 'stale-1', status: 'running' }),
          run({ runId: 'live-1', status: 'running' }),
          run({ runId: 'done-1', status: 'success' })
        ]),
        chat('c2', [run({ runId: 'stale-2', status: 'starting' })])
      ],
      (runId) => live.has(runId),
      NOW
    )

    expect(result.settlements).toEqual([
      { chatId: 'c1', runId: 'stale-1', previousStatus: 'running' },
      { chatId: 'c2', runId: 'stale-2', previousStatus: 'starting' }
    ])
    expect(result.chats).toHaveLength(2)

    const c1 = result.chats.find((c) => c.appChatId === 'c1')!
    expect(c1.runs.map((r) => r.status)).toEqual(['failed', 'running', 'success'])
    expect(c1.runs[0]?.endedAt).toBe(NOW)
    expect(c1.updatedAt).toBe(NOW_MS)

    const c2 = result.chats.find((c) => c.appChatId === 'c2')!
    expect(c2.runs[0]?.status).toBe('failed')
  })

  it('is idempotent when every active run is already settled or live', () => {
    const result = reconcileStaleChatRuns(
      [
        chat('c1', [
          run({ runId: 'done', status: 'failed', endedAt: OLD }),
          run({ runId: 'live', status: 'running' })
        ])
      ],
      (runId) => runId === 'live',
      NOW
    )
    expect(result.settlements).toEqual([])
    expect(result.chats).toEqual([])
  })

  it('does not settle sleeping ensemble participant runs', () => {
    const result = reconcileStaleChatRuns(
      [chat('ensemble', [run({ runId: 'sleep-1', status: 'sleeping' })])],
      () => false,
      NOW
    )
    expect(result.settlements).toEqual([])
    expect(result.chats).toEqual([])
  })

  it('honours minAgeMs so periodic sweeps skip brand-new seeds', () => {
    const result = reconcileStaleChatRuns(
      [
        chat('c1', [
          run({ runId: 'fresh', status: 'running', startedAt: RECENT }),
          run({ runId: 'old', status: 'running', startedAt: OLD })
        ])
      ],
      () => false,
      NOW,
      { minAgeMs: 30_000, nowMs: NOW_MS }
    )
    expect(result.settlements).toEqual([
      { chatId: 'c1', runId: 'old', previousStatus: 'running' }
    ])
    expect(result.chats[0]?.runs.map((r) => r.status)).toEqual(['running', 'failed'])
  })

  it('covers solo parents as well as sub-threads (not only workerControl chats)', () => {
    const result = reconcileStaleChatRuns(
      [
        chat('parent', [run({ runId: 'p-run', status: 'running' })]),
        chat('child', [run({ runId: 'c-run', status: 'paused' })], {
          parentChatId: 'parent'
        })
      ],
      () => false,
      NOW
    )
    expect(result.settlements.map((s) => s.chatId).sort()).toEqual(['child', 'parent'])
  })

  it('skips chats with empty or missing runs', () => {
    const result = reconcileStaleChatRuns(
      [chat('empty', []), { appChatId: 'no-runs' } as ChatRecord],
      () => false,
      NOW
    )
    expect(result).toEqual({ chats: [], settlements: [] })
  })
})
