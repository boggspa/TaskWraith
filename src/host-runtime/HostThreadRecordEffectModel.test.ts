import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { projectThreadCatalogueRunSummary } from '../host-shared/thread-catalogue/ThreadCatalogueRunSummary'
import {
  hostCatalogueThreadSummary,
  projectHostCatalogueThread
} from './HostCatalogueThreadProjection'
import {
  assembleProfileThreadRound,
  projectProfileThreadRoundBase,
  projectProfileThreadRow
} from './HostProfileDomainProjection'
import type { HostProfileThread } from './HostProfileDomainStore'
import {
  compareHostThreadRecordRuns,
  HOST_THREAD_RECORD_RUN_CANDIDATE_LIMIT,
  hostThreadRecordRoundRow,
  hostThreadRecordRunRank,
  hostThreadRecordThreadRow,
  modelHostThreadRecordEffects,
  type HostThreadRecordModelled
} from './HostThreadRecordEffectModel'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

function thread(overrides: Record<string, unknown> = {}): HostProfileThread {
  return {
    appChatId: 'chat-a',
    scope: 'global',
    title: 'Chat A',
    provider: 'codex',
    archived: false,
    createdAt: 1,
    updatedAt: T0 + 60_000,
    persistenceRevision: 3,
    messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: iso(0) }],
    runs: [],
    ...overrides
  } as unknown as HostProfileThread
}

function run(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId,
    provider: 'codex',
    status: 'success',
    startedAt: iso(0),
    endedAt: iso(1_000),
    ...overrides
  }
}

function modelled(committed: HostProfileThread): HostThreadRecordModelled {
  const model = modelHostThreadRecordEffects(committed)
  if (model.kind !== 'modelled') throw new Error('expected a modelled record')
  return model
}

function ensembleThread(round: Record<string, unknown>, runs: unknown[] = []): HostProfileThread {
  return thread({
    chatKind: 'ensemble',
    ensemble: {
      orchestrationMode: 'sequential',
      fanoutPolicy: 'all',
      participants: [
        { id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true },
        { id: 'p2', provider: 'claude', role: 'worker', order: 1, enabled: true }
      ],
      activeRound: round
    },
    runs
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0 + 3_600_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('modelHostThreadRecordEffects: refusal', () => {
  it.each([
    ['an unsafe chat id', { appChatId: '..' }],
    [
      'a latest run status the catalogue cannot hold',
      { runs: [run('r1', { status: 's'.repeat(70) })] }
    ],
    ['a latest run provider that is not text', { runs: [run('r1', { provider: 5 })] }],
    ['an empty parent chat id', { parentChatId: '' }],
    [
      'a workspace path over 4,096 characters',
      { scope: 'workspace', workspaceId: 'ws', workspacePath: `/${'p'.repeat(4_096)}` }
    ]
  ])('refuses %s, as the donor publication throws', (_label, overrides) => {
    const committed = thread(overrides)
    expect(() => projectHostCatalogueThread(committed)).toThrow(
      'Host thread metadata projection is invalid'
    )
    expect(modelHostThreadRecordEffects(committed)).toEqual({
      kind: 'refused',
      threadId: committed.appChatId,
      errorCode: 'thread_record_persist_failed'
    })
  })

  it('models the same record once the refusing field is gone', () => {
    expect(modelHostThreadRecordEffects(thread({ runs: [run('r1')] })).kind).toBe('modelled')
  })
})

describe('modelHostThreadRecordEffects: the mirror row', () => {
  it('carries the projection the mirror observes and reads the thread through it', () => {
    const committed = thread({
      providerMetadata: {
        selectedModelType: 'gpt-5',
        reasoningEffort: 'high',
        permissionPresetId: 'read_only'
      },
      workflowMode: 'plan',
      messages: [
        { id: 'm1', role: 'user', content: 'question', timestamp: iso(0) },
        { id: 'm2', role: 'tool', content: 'tool output', timestamp: iso(1) }
      ],
      runs: [run('r1', { usage: { inputTokens: 5, outputTokens: 7 } })]
    })
    const model = modelled(committed)
    expect(model.projection).toEqual(projectHostCatalogueThread(committed))
    const summary = hostCatalogueThreadSummary(model.projection)
    expect(model.thread).toEqual(projectProfileThreadRow(summary, undefined))
    // The mirror's preview is the last non-empty message of any role, the
    // composer keys omit `reasoningEffort`, and the last-run stub has no usage.
    expect(model.thread).toMatchObject({
      latestPreview: 'tool output',
      modelId: 'gpt-5',
      permissionPresetId: 'plan'
    })
    expect(model.thread).not.toHaveProperty('reasoningEffort')
    expect(model.thread).not.toHaveProperty('usage')
    expect(model.thread).not.toHaveProperty('activeRoundId')
  })
})

describe('modelHostThreadRecordEffects: run candidates', () => {
  it('stores each run as the catalogue summary of the record, JSON-clean', () => {
    const runs = [
      run('r1', {
        exitCode: -0,
        usage: { inputTokens: 1, outputTokens: 2 },
        runDiff: { createdFiles: [{ path: 'a' }] }
      }),
      run('r2', {
        provider: 'ollama',
        stats: { ollamaMemoryPeakRssGb: 1.5 },
        toolActivities: [{ id: 't' }]
      })
    ]
    const model = modelled(thread({ runs }))
    const byRun = new Map(model.runs.candidates.map((candidate) => [candidate.runId, candidate]))
    for (const source of runs) {
      const expected = JSON.parse(JSON.stringify(projectThreadCatalogueRunSummary(source)))
      expect(byRun.get(source.runId as string)?.summary).toEqual(expected)
    }
    expect(Object.is(byRun.get('r1')?.summary.exitCode, 0)).toBe(true)
    expect(byRun.get('r1')?.summary.diffFileCount).toBe(1)
    expect(byRun.get('r2')?.summary).toMatchObject({ stats: { ollamaMemoryPeakRssGb: 1.5 } })
    expect(byRun.get('r2')?.summary).not.toHaveProperty('toolActivities')
    expect(byRun.get('r1')?.ordinal).toBe(0)
    expect(byRun.get('r2')?.ordinal).toBe(1)
  })

  it('summarises runs after the external-import continuity strip, which moves the byte budget', () => {
    // Early fields spend the 8 KiB copy budget before `status`; dropping the
    // provider continuity fields leaves room for it (fills of 240-271 do).
    const wide = String.fromCharCode(0x4e00).repeat(512)
    const heavy = run('r1', {
      providerRunId: wide,
      providerThreadId: wide,
      requestedModel: wide,
      actualModel: wide,
      approvalMode: 'a'.repeat(256),
      workflowMode: wide,
      endedAt: undefined,
      status: 'failed'
    })
    const kept = modelled(thread({ runs: [heavy] })).runs.candidates[0]!
    const stripped = modelled(
      thread({ runs: [heavy], externalProviderThreadImport: { nativeResumeAllowed: false } })
    ).runs.candidates[0]!
    expect(kept.summary).toHaveProperty('providerThreadId')
    expect(stripped.summary).not.toHaveProperty('providerThreadId')
    expect(kept.summary).not.toHaveProperty('status')
    expect(stripped.summary).toHaveProperty('status', 'failed')
    // The rank follows the stored summary: without a status the run is active.
    expect(kept.rank).toEqual({ active: 1, recency: T0 })
    expect(stripped.rank).toEqual({ active: 0, recency: T0 })
    expect(kept.row.providerOutcome).toBe('unknown')
    expect(stripped.row.providerOutcome).toBe('failed')
  })

  it('builds each run row against the mirror summary, as the window path does', () => {
    const model = modelled(
      thread({
        provider: 'claude',
        runs: [
          run('r1', { provider: undefined, status: 'failed', warningSummaries: ['boom'] }),
          run('r2', {
            startedAt: undefined,
            endedAt: undefined,
            status: 'running',
            requestedModel: 'm'
          })
        ]
      })
    )
    const byRun = new Map(model.runs.candidates.map((candidate) => [candidate.runId, candidate]))
    expect(byRun.get('r1')?.row).toEqual({
      runId: 'r1',
      threadId: 'chat-a',
      providerId: 'claude',
      providerOutcome: 'failed',
      startedAt: T0,
      endedAt: T0 + 1_000,
      failureReason: 'boom'
    })
    expect(byRun.get('r1')?.recency).toBe(T0 + 1_000)
    // No time parses: the projection's recency falls back to the thread.
    expect(byRun.get('r2')?.recency).toBe(T0 + 60_000)
    expect(byRun.get('r2')?.rank).toEqual({ active: 1, recency: 0 })
  })

  it('orders candidates as the catalogue does and keeps at most the run window', () => {
    const runs = Array.from({ length: HOST_THREAD_RECORD_RUN_CANDIDATE_LIMIT + 5 }, (_, index) =>
      run(`r${index}`, { startedAt: iso(index), endedAt: iso(index + 10) })
    )
    runs.push(run('live-old', { status: 'running', startedAt: iso(-5_000), endedAt: undefined }))
    runs.push(run('tie-a', { endedAt: iso(50_000) }), run('tie-b', { endedAt: iso(50_000) }))
    const model = modelled(thread({ runs }))
    expect(model.runs.total).toBe(runs.length)
    expect(model.runs.candidates).toHaveLength(HOST_THREAD_RECORD_RUN_CANDIDATE_LIMIT)
    expect(model.runs.candidates.slice(0, 3).map((candidate) => candidate.runId)).toEqual([
      'live-old',
      'tie-a',
      'tie-b'
    ])
    const ranks = model.runs.candidates.slice(3).map((candidate) => candidate.rank.recency)
    expect(ranks).toEqual([...ranks].sort((left, right) => right - left))
    expect(model.runs.candidates.at(-1)?.runId).toBe('r8')
  })
})

describe('hostThreadRecordRunRank', () => {
  it.each([
    [
      { runId: 'r', status: 'Completed', endedAt: undefined },
      { active: 0, recency: 0 }
    ],
    [
      { runId: 'r', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' },
      { active: 1, recency: T0 }
    ],
    [
      { runId: 'r', status: 'running', endedAt: '2026-01-01T00:00:00.000Z' },
      { active: 0, recency: T0 }
    ],
    [
      { runId: 'r', endedAt: '1969-12-31T23:59:59.000Z' },
      { active: 0, recency: -1_000 }
    ],
    [
      { runId: 'r', startedAt: 'not a date' },
      { active: 1, recency: 0 }
    ],
    [
      { runId: 5, status: 'running' },
      { active: 0, recency: 0 }
    ],
    [{ status: 'running' }, { active: 0, recency: 0 }]
  ])('ranks %j as %j', (summary, rank) => {
    expect(hostThreadRecordRunRank(summary)).toEqual(rank)
  })
})

describe('compareHostThreadRecordRuns', () => {
  const at = (threadId: string, active: 0 | 1, recency: number, ordinal = 0) => ({
    threadId,
    rank: { active, recency },
    ordinal
  })

  it('puts active before terminal, then the most recent, then the ordinal', () => {
    expect(compareHostThreadRecordRuns(at('a', 1, 0), at('a', 0, 9))).toBeLessThan(0)
    expect(compareHostThreadRecordRuns(at('a', 0, 9), at('a', 1, 0))).toBeGreaterThan(0)
    expect(compareHostThreadRecordRuns(at('a', 0, 9), at('a', 0, 5))).toBeLessThan(0)
    expect(compareHostThreadRecordRuns(at('a', 0, -8.64e15), at('a', 0, 8.64e15))).toBeGreaterThan(
      0
    )
    expect(compareHostThreadRecordRuns(at('a', 0, 5, 1), at('a', 0, 5, 2))).toBeLessThan(0)
    expect(compareHostThreadRecordRuns(at('a', 0, 5, 2), at('a', 0, 5, 1))).toBeGreaterThan(0)
  })

  it('orders thread ids by their UTF-8 bytes, as SQLite BINARY does', () => {
    const bmpMax = String.fromCharCode(0xffff)
    const astral = String.fromCodePoint(0x1f600)
    // UTF-16 puts the astral character first; UTF-8 puts U+FFFF first.
    expect(bmpMax > astral).toBe(true)
    expect(compareHostThreadRecordRuns(at(bmpMax, 0, 5), at(astral, 0, 5))).toBeLessThan(0)
    expect(compareHostThreadRecordRuns(at('ab', 0, 5), at('a', 0, 5))).toBeGreaterThan(0)
    expect(compareHostThreadRecordRuns(at('B', 0, 5), at('a', 0, 5))).toBeLessThan(0)
  })
})

describe('modelHostThreadRecordEffects: the round', () => {
  const seats = [
    { participantId: 'p1', runId: 'seat-run', status: 'running' },
    { participantId: 'p2', status: 'idle' }
  ]

  it('carries the seats’ run ids and marks the member runs the window may add', () => {
    const committed = ensembleThread(
      {
        roundId: 'round-1',
        status: 'completed',
        participants: seats,
        startedAt: iso(0),
        endedAt: iso(5_000)
      },
      [
        run('r-member', { ensembleRoundId: 'round-1' }),
        run('r-other', { ensembleRoundId: 'round-2' }),
        run('r-none')
      ]
    )
    const model = modelled(committed)
    expect(model.round).toEqual({
      roundId: 'round-1',
      row: expect.objectContaining({ providerRunIds: ['seat-run'], status: 'completed' }),
      live: false,
      recency: T0 + 5_000
    })
    const members = model.runs.candidates.filter((candidate) => candidate.roundMember)
    expect(members.map((candidate) => candidate.runId)).toEqual(['r-member'])
    const summary = hostCatalogueThreadSummary(model.projection)
    const base = projectProfileThreadRoundBase(summary)!
    expect(hostThreadRecordRoundRow(model.round!, ['r-member'])).toEqual(
      assembleProfileThreadRound(summary, base, ['r-member'])!.row
    )
    expect(hostThreadRecordRoundRow(model.round!, [])).toEqual(model.round!.row)
  })

  it('reads liveness from the mirror presentation: a running latest run keeps an active round live', () => {
    const committed = ensembleThread(
      { roundId: 'round-1', status: 'active', participants: seats },
      [run('r1', { status: 'running', startedAt: iso(9_000), endedAt: undefined })]
    )
    const model = modelled(committed)
    expect(model.projection.summary.presentation?.status).toBe('running')
    expect(model.round?.live).toBe(true)
    expect(model.round?.row.status).toBe('running')
    const withRound = hostThreadRecordThreadRow(model, true)
    expect(withRound).toEqual(
      projectProfileThreadRow(hostCatalogueThreadSummary(model.projection), 'round-1')
    )
    expect(Object.keys(withRound).at(-1)).toBe('activeRoundId')
    expect(hostThreadRecordThreadRow(model, false)).toBe(model.thread)
  })

  it('never gives a terminal round an activeRoundId', () => {
    const model = modelled(
      ensembleThread({ roundId: 'round-1', status: 'completed', participants: seats })
    )
    expect(model.round?.live).toBe(false)
    expect(hostThreadRecordThreadRow(model, true)).toBe(model.thread)
  })

  it('drops a round whose row does not decode, and projects the seats without it', () => {
    const committed = ensembleThread(
      {
        roundId: 'round-1',
        status: 'running',
        orchestrationMode: 'm'.repeat(300),
        participants: seats,
        activeParticipantId: 'p1'
      },
      [run('r1', { ensembleRoundId: 'round-1' })]
    )
    const model = modelled(committed)
    expect(
      projectProfileThreadRoundBase(hostCatalogueThreadSummary(model.projection))
    ).not.toBeNull()
    expect(model.round).toBeNull()
    expect(model.runs.candidates.every((candidate) => !candidate.roundMember)).toBe(true)
    // Without a round, a seat is active only by its own flag and keeps no round status.
    expect(model.participants.rows.map((row) => [row.id, row.active, row.status])).toEqual([
      ['p1', false, undefined],
      ['p2', false, undefined]
    ])
  })

  it('has no round for a single chat', () => {
    const model = modelled(thread({ runs: [run('r1', { ensembleRoundId: 'round-1' })] }))
    expect(model.round).toBeNull()
    expect(model.participants).toEqual({ rows: [], omitted: 0, warningAt: 0 })
  })
})

describe('modelHostThreadRecordEffects: participants', () => {
  it('projects seats with the round’s status and active seat, counting omitted seats', () => {
    const committed = thread({
      chatKind: 'ensemble',
      updatedAt: T0 + 77,
      ensemble: {
        orchestrationMode: 'sequential',
        fanoutPolicy: 'all',
        participants: [
          { id: 'p1', provider: 'codex', role: 'worker', order: 0, enabled: true },
          { id: 'p1', provider: 'codex', role: 'worker', order: 1, enabled: true },
          { id: 'p2', provider: 'claude', role: 'worker', order: 'x', enabled: true }
        ],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          activeParticipantId: 'p1',
          participants: [{ participantId: 'p1', status: 'thinking' }]
        }
      },
      runs: [run('r1', { status: 'running', endedAt: undefined })]
    })
    const model = modelled(committed)
    expect(model.round?.live).toBe(true)
    expect(model.participants.rows).toEqual([
      expect.objectContaining({ id: 'p1', threadId: 'chat-a', active: true, status: 'thinking' })
    ])
    expect(model.participants.omitted).toBe(2)
    expect(model.participants.warningAt).toBe(T0 + 77)
  })
})

describe('modelHostThreadRecordEffects: goal timing', () => {
  it('times an open goal against the clock, up to the thread’s own stamp, as the donor does', () => {
    const committed = thread({
      updatedAt: T0 + 7_200_000,
      activeGoal: {
        id: 'goal-1',
        objective: 'ship it',
        status: 'active',
        mode: 'autonomous',
        runtimeLedger: { startedAt: iso(0), intervals: [{ status: 'active', startedAt: iso(0) }] }
      }
    })
    vi.setSystemTime(T0 + 3_600_000)
    expect(modelled(committed).thread.goal).toMatchObject({
      wallMs: 3_600_000,
      activeMs: 3_600_000
    })
    vi.setSystemTime(T0 + 5_400_000)
    expect(modelled(committed).thread.goal).toMatchObject({ wallMs: 5_400_000 })
    vi.setSystemTime(T0 + 9_000_000)
    expect(modelled(committed).thread.goal).toMatchObject({ wallMs: 7_200_000 })
  })
})
