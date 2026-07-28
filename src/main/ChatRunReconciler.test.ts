import { describe, expect, it } from 'vitest'
import {
  BRIDGE_TRANSCRIPT_ACTIVITY_GRACE_MS,
  bridgeTranscriptActivityIsLive,
  CHAT_RUN_STALE_EXIT_CODE,
  CHAT_RUN_STALE_SETTLEMENT_STATUS,
  isActiveChatRunStatus,
  reconcileStaleChatRuns,
  sealChatRunTerminalFields,
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

describe('bridgeTranscriptActivityIsLive', () => {
  it('is live within the grace window and dead at its edge', () => {
    expect(bridgeTranscriptActivityIsLive(NOW_MS - 1_000, NOW_MS)).toBe(true)
    expect(
      bridgeTranscriptActivityIsLive(NOW_MS - BRIDGE_TRANSCRIPT_ACTIVITY_GRACE_MS + 1, NOW_MS)
    ).toBe(true)
    expect(
      bridgeTranscriptActivityIsLive(NOW_MS - BRIDGE_TRANSCRIPT_ACTIVITY_GRACE_MS, NOW_MS)
    ).toBe(false)
  })

  it('treats unstamped or malformed activity as NOT live', () => {
    expect(bridgeTranscriptActivityIsLive(undefined, NOW_MS)).toBe(false)
    expect(bridgeTranscriptActivityIsLive(Number.NaN, NOW_MS)).toBe(false)
    expect(bridgeTranscriptActivityIsLive(Number.POSITIVE_INFINITY, NOW_MS)).toBe(false)
  })

  it('honors a custom grace window', () => {
    expect(bridgeTranscriptActivityIsLive(NOW_MS - 5_000, NOW_MS, 10_000)).toBe(true)
    expect(bridgeTranscriptActivityIsLive(NOW_MS - 5_000, NOW_MS, 4_000)).toBe(false)
  })
})

describe('sealChatRunTerminalFields', () => {
  it('fills status, endedAt, stats and exitCode on an active run', () => {
    const sealed = sealChatRunTerminalFields(run({ runId: 'r1', status: 'running' }), {
      status: 'success',
      endedAt: NOW,
      stats: { tokens: 5 },
      exitCode: 0
    })
    expect(sealed).toMatchObject({
      status: 'success',
      endedAt: NOW,
      stats: { tokens: 5 },
      exitCode: 0
    })
  })

  it('fills a missing status even when other fields are absent from the seal', () => {
    const sealed = sealChatRunTerminalFields(run({ runId: 'r1', status: undefined }), {
      status: 'failed',
      endedAt: NOW
    })
    expect(sealed?.status).toBe('failed')
    expect(sealed?.endedAt).toBe(NOW)
    expect(sealed && 'stats' in sealed && sealed.stats !== undefined).toBe(false)
  })

  it('never overwrites terminal fields the live seal already wrote', () => {
    const sealed = sealChatRunTerminalFields(
      run({
        runId: 'r1',
        status: 'success',
        endedAt: RECENT,
        stats: { tokens: 9 },
        exitCode: 0
      }),
      { status: 'failed', endedAt: NOW, stats: { tokens: 1 }, exitCode: 1 }
    )
    expect(sealed).toBeNull()
  })

  it('repairs the endedAt-set-but-still-running ghost shape', () => {
    const sealed = sealChatRunTerminalFields(
      run({ runId: 'r1', status: 'running', endedAt: RECENT }),
      { status: 'failed', endedAt: NOW }
    )
    expect(sealed?.status).toBe('failed')
    expect(sealed?.endedAt).toBe(RECENT)
  })

  it('marks cancelled seals with the cancelled flag', () => {
    const sealed = sealChatRunTerminalFields(run({ runId: 'r1', status: 'running' }), {
      status: 'cancelled',
      endedAt: NOW
    })
    expect(sealed?.status).toBe('cancelled')
    expect(sealed?.cancelled).toBe(true)
  })

  it('does not stamp cancelled when only non-status fields fill', () => {
    const sealed = sealChatRunTerminalFields(
      run({ runId: 'r1', status: 'failed', endedAt: undefined }),
      { status: 'cancelled', endedAt: NOW }
    )
    expect(sealed?.status).toBe('failed')
    expect(sealed?.endedAt).toBe(NOW)
    expect(sealed?.cancelled).toBeUndefined()
  })
})
