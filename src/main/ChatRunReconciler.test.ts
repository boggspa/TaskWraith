import { describe, expect, it } from 'vitest'
import {
  BRIDGE_TRANSCRIPT_ACTIVITY_GRACE_MS,
  bridgeTranscriptActivityIsLive,
  bridgeTranscriptIsOwnedByFinalizer,
  CHAT_RUN_STALE_EXIT_CODE,
  CHAT_RUN_STALE_REASON,
  CHAT_RUN_STALE_SETTLEMENT_STATUS,
  isActiveChatRunStatus,
  queueJobStatusForTerminalRunStatus,
  reconcileOrphanedRunQueueJobs,
  reconcileStaleChatRuns,
  sealChatRunTerminalFields,
  settleStaleChatRun,
  terminalChatRunSealFromExactSession
} from './ChatRunReconciler'
import { staleRunSettlementNoticeId } from './RunFailureNotice'
import type { ChatMessage, ChatRecord, ChatRun } from './store/types'

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
    expect(result).toEqual({ chats: [], settlements: [], terminalRecoveries: [] })
  })

  it('recovers a lagging active projection from an exact terminal session', () => {
    const existingMessage: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'The completed answer',
      timestamp: RECENT,
      runId: 'r1'
    }
    const result = reconcileStaleChatRuns(
      [
        chat(
          'c1',
          [
            run({
              runId: 'r1',
              provider: 'codex',
              status: 'running',
              endedAt: RECENT,
              stats: { totalTokens: 42 }
            })
          ],
          { messages: [existingMessage] }
        )
      ],
      () => false,
      NOW,
      {
        getRunSession: () => ({
          runId: 'r1',
          appChatId: 'c1',
          provider: 'codex',
          status: 'completed',
          updatedAt: NOW_MS
        })
      }
    )

    expect(result.settlements).toEqual([])
    expect(result.terminalRecoveries).toEqual([
      {
        chatId: 'c1',
        runId: 'r1',
        previousStatus: 'running',
        recoveredStatus: 'success'
      }
    ])
    expect(result.chats[0].runs[0]).toMatchObject({
      status: 'success',
      endedAt: RECENT,
      stats: { totalTokens: 42 }
    })
    expect(result.chats[0].runs[0].exitCode).toBeUndefined()
    expect(result.chats[0].messages).toEqual([existingMessage])
  })

  it('recovers a legacy missing-status run from an exact cancelled session', () => {
    const result = reconcileStaleChatRuns(
      [chat('c1', [run({ runId: 'r1', provider: 'codex', status: undefined })])],
      () => false,
      NOW,
      {
        getRunSession: () => ({
          runId: 'r1',
          appChatId: 'c1',
          provider: 'codex',
          status: 'cancelled',
          updatedAt: NOW_MS
        })
      }
    )

    expect(result.settlements).toEqual([])
    expect(result.terminalRecoveries).toEqual([
      {
        chatId: 'c1',
        runId: 'r1',
        previousStatus: 'undefined',
        recoveredStatus: 'cancelled'
      }
    ])
    expect(result.chats[0].runs[0]).toMatchObject({
      status: 'cancelled',
      cancelled: true,
      endedAt: NOW
    })
    expect(result.chats[0].messages).toEqual([])
  })

  it('leaves an ended legacy missing-status run untouched', () => {
    const result = reconcileStaleChatRuns(
      [chat('c1', [run({ runId: 'r1', provider: 'codex', status: undefined, endedAt: OLD })])],
      () => false,
      NOW,
      {
        getRunSession: () => ({
          runId: 'r1',
          appChatId: 'c1',
          provider: 'codex',
          status: 'cancelled',
          updatedAt: NOW_MS
        })
      }
    )

    expect(result).toEqual({ chats: [], settlements: [], terminalRecoveries: [] })
  })

  describe('settlement transcript notice', () => {
    it('appends an explanatory error row for every settled run', () => {
      const result = reconcileStaleChatRuns(
        [
          chat('c1', [
            run({ runId: 'stale-1', status: 'running', provider: 'ollama' }),
            run({ runId: 'stale-2', status: 'queued', provider: 'ollama' })
          ])
        ],
        () => false,
        NOW
      )
      const messages = result.chats[0].messages
      expect(messages.map((m) => m.id)).toEqual([
        staleRunSettlementNoticeId('c1', 'stale-1'),
        staleRunSettlementNoticeId('c1', 'stale-2')
      ])
      expect(messages.every((m) => m.role === 'error')).toBe(true)
      expect(messages[0].runId).toBe('stale-1')
      // The card kind both platforms already render (desktop
      // ProviderRunFailureCard / iOS ProviderRunFailureCard).
      expect(messages[0].metadata?.kind).toBe('providerRunFailure')
      expect(messages[0].content).toContain('stale-1')
      expect(messages[0].content).toContain('still marked running')
      expect(messages[0].content).toContain(CHAT_RUN_STALE_REASON)
      expect(messages[1].content).toContain('still marked queued')
    })

    it('inserts after the settled run own last row, not at the tail', () => {
      const messages: ChatMessage[] = [
        { id: 'u1', role: 'user', content: 'old prompt', timestamp: OLD, runId: 'stale-1' },
        { id: 'a1', role: 'assistant', content: 'partial', timestamp: OLD, runId: 'stale-1' },
        { id: 'u2', role: 'user', content: 'newer prompt', timestamp: NOW, runId: 'done-1' }
      ]
      const result = reconcileStaleChatRuns(
        [
          chat(
            'c1',
            [run({ runId: 'stale-1' }), run({ runId: 'done-1', status: 'success' })],
            { messages }
          )
        ],
        () => false,
        NOW
      )
      // iOS anchors a run's completion card to that run's LAST row — a
      // tail-appended notice would drag the old card below the newer turn.
      expect(result.chats[0].messages.map((m) => m.id)).toEqual([
        'u1',
        'a1',
        staleRunSettlementNoticeId('c1', 'stale-1'),
        'u2'
      ])
    })

    it('keeps existing transcript rows and appends after them', () => {
      const existing: ChatMessage = {
        id: 'u1',
        role: 'user',
        content: 'do the thing',
        timestamp: OLD
      }
      const result = reconcileStaleChatRuns(
        [chat('c1', [run({ runId: 'stale-1' })], { messages: [existing] })],
        () => false,
        NOW
      )
      expect(result.chats[0].messages).toHaveLength(2)
      expect(result.chats[0].messages[0]).toEqual(existing)
    })

    it('does not duplicate a notice that is already in the transcript', () => {
      const result = reconcileStaleChatRuns(
        [
          chat('c1', [run({ runId: 'stale-1' })], {
            messages: [
              {
                id: staleRunSettlementNoticeId('c1', 'stale-1'),
                role: 'error',
                content: 'already explained',
                timestamp: OLD
              }
            ]
          })
        ],
        () => false,
        NOW
      )
      expect(result.chats[0].messages).toHaveLength(1)
      expect(result.chats[0].messages[0].content).toBe('already explained')
    })

    it('writes no notice when nothing was settled', () => {
      const result = reconcileStaleChatRuns(
        [chat('c1', [run({ runId: 'live', status: 'running' })])],
        () => true,
        NOW
      )
      expect(result.chats).toEqual([])
    })
  })
})

describe('terminalChatRunSealFromExactSession', () => {
  const targetChat = chat('c1', [])
  const targetRun = run({ runId: 'r1', provider: 'codex' })

  it.each([
    ['completed', 'success'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled']
  ] as const)('maps exact terminal session status %s to %s', (status, expected) => {
    expect(
      terminalChatRunSealFromExactSession(targetChat, targetRun, {
        runId: 'r1',
        appChatId: 'c1',
        provider: 'codex',
        status,
        updatedAt: NOW_MS
      })
    ).toEqual({ status: expected, endedAt: NOW })
  })

  it('rejects active, mismatched, and malformed session evidence', () => {
    const exact = {
      runId: 'r1',
      appChatId: 'c1',
      provider: 'codex',
      status: 'completed',
      updatedAt: NOW_MS
    }
    expect(
      terminalChatRunSealFromExactSession(targetChat, targetRun, {
        ...exact,
        status: 'running'
      })
    ).toBeUndefined()
    expect(
      terminalChatRunSealFromExactSession(targetChat, targetRun, {
        ...exact,
        runId: 'other-run'
      })
    ).toBeUndefined()
    expect(
      terminalChatRunSealFromExactSession(targetChat, targetRun, {
        ...exact,
        appChatId: 'other-chat'
      })
    ).toBeUndefined()
    expect(
      terminalChatRunSealFromExactSession(targetChat, targetRun, {
        ...exact,
        provider: 'claude'
      })
    ).toBeUndefined()
    expect(
      terminalChatRunSealFromExactSession(targetChat, targetRun, {
        ...exact,
        updatedAt: Number.NaN
      })
    ).toBeUndefined()
  })
})

describe('bridgeTranscriptIsOwnedByFinalizer', () => {
  it('treats any non-running transcript status as finalizer-owned', () => {
    expect(bridgeTranscriptIsOwnedByFinalizer('success')).toBe(true)
    expect(bridgeTranscriptIsOwnedByFinalizer('failed')).toBe(true)
    expect(bridgeTranscriptIsOwnedByFinalizer('cancelled')).toBe(true)
  })

  it('leaves a still-running transcript to the activity probe', () => {
    expect(bridgeTranscriptIsOwnedByFinalizer('running')).toBe(false)
    expect(bridgeTranscriptIsOwnedByFinalizer(undefined)).toBe(false)
  })

  // The live failure this rule exists for: a one-sentence local-model reply
  // finishes streaming, the run stays open another minute, and by the time the
  // finalizer claims it the activity window has long since decayed. Ownership
  // has to outrank age or the sweep settles a successful run and purges the
  // transcript its pending terminal flush needs.
  it('outranks a decayed activity window once a finalizer has claimed the run', () => {
    const lastActivity = NOW_MS - BRIDGE_TRANSCRIPT_ACTIVITY_GRACE_MS - 5_000
    expect(bridgeTranscriptActivityIsLive(lastActivity, NOW_MS)).toBe(false)
    expect(bridgeTranscriptIsOwnedByFinalizer('success')).toBe(true)
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

describe('reconcileOrphanedRunQueueJobs', () => {
  const terminal = new Map<string, string>([
    ['run-success', 'success'],
    ['run-failed', 'failed'],
    ['run-cancelled', 'cancelled'],
    ['run-live', 'running']
  ])

  it('settles a live-status job whose run sealed, mirroring the seal', () => {
    const settlements = reconcileOrphanedRunQueueJobs(
      [
        { runId: 'run-success', status: 'active', chatId: 'chat-1' },
        { runId: 'run-failed', status: 'starting', chatId: 'chat-1' },
        { runId: 'run-cancelled', status: 'cancelling', chatId: 'chat-2' }
      ],
      terminal
    )
    expect(settlements).toEqual([
      {
        runId: 'run-success',
        chatId: 'chat-1',
        previousStatus: 'active',
        nextStatus: 'completed',
        runStatus: 'success'
      },
      {
        runId: 'run-failed',
        chatId: 'chat-1',
        previousStatus: 'starting',
        nextStatus: 'failed',
        runStatus: 'failed'
      },
      {
        runId: 'run-cancelled',
        chatId: 'chat-2',
        previousStatus: 'cancelling',
        nextStatus: 'cancelled',
        runStatus: 'cancelled'
      }
    ])
  })

  it('never touches queued or paused jobs — they are future prompts', () => {
    expect(
      reconcileOrphanedRunQueueJobs(
        [
          { runId: 'run-success', status: 'queued', chatId: 'chat-1' },
          { runId: 'run-success', status: 'paused', chatId: 'chat-1' }
        ],
        terminal
      )
    ).toEqual([])
  })

  it('leaves jobs whose run is live or unknown alone', () => {
    expect(
      reconcileOrphanedRunQueueJobs(
        [
          { runId: 'run-live', status: 'active', chatId: 'chat-1' },
          { runId: 'run-unknown', status: 'active', chatId: 'chat-1' }
        ],
        terminal
      )
    ).toEqual([])
  })

  it('leaves already-terminal jobs alone', () => {
    expect(
      reconcileOrphanedRunQueueJobs(
        [{ runId: 'run-success', status: 'completed', chatId: 'chat-1' }],
        terminal
      )
    ).toEqual([])
  })

  it('carries settlements for chatless jobs without inventing a chat id', () => {
    const settlements = reconcileOrphanedRunQueueJobs(
      [{ runId: 'run-success', status: 'active' }],
      terminal
    )
    expect(settlements).toHaveLength(1)
    expect('chatId' in settlements[0]).toBe(false)
  })
})

describe('queueJobStatusForTerminalRunStatus', () => {
  it('mirrors the seal and fails closed on anything unrecognised', () => {
    expect(queueJobStatusForTerminalRunStatus('success')).toBe('completed')
    expect(queueJobStatusForTerminalRunStatus('completed')).toBe('completed')
    expect(queueJobStatusForTerminalRunStatus('cancelled')).toBe('cancelled')
    expect(queueJobStatusForTerminalRunStatus('failed')).toBe('failed')
    expect(queueJobStatusForTerminalRunStatus('exploded')).toBe('failed')
    expect(queueJobStatusForTerminalRunStatus(undefined)).toBe('failed')
  })
})
