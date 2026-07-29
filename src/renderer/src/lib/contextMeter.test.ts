import { describe, expect, it } from 'vitest'
import {
  contextPercent,
  currentContextTokens,
  buildParticipantContextRows,
  liveOutputTokensForParticipant,
  applyLiveContextTokenUsage,
  contextTokensFromUsage,
  currentContextUsage,
  buildContextActivitySummary
} from './contextMeter'
import type { ChatMessage, ChatRun, EnsembleParticipant } from '../../../main/store/types'
import { withContextUsageSnapshot } from '../../../shared/contextUsage'

const run = (overrides: Partial<ChatRun> = {}): ChatRun =>
  ({
    runId: 'r',
    provider: 'claude',
    startedAt: '2026-05-30T12:00:00.000Z',
    status: 'success',
    ...overrides
  }) as ChatRun

const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  total_tokens: input + output
})

describe('contextPercent', () => {
  it('clamps to 0..100 and returns 0 for an unknown window', () => {
    expect(contextPercent(50_000, 200_000)).toBe(25)
    expect(contextPercent(500_000, 200_000)).toBe(100)
    expect(contextPercent(-5, 200_000)).toBe(0)
    expect(contextPercent(50_000, 0)).toBe(0)
  })
})

describe('currentContextTokens — honest proxy, NOT a cumulative sum', () => {
  it('uses the LATEST run input+output, not the sum across runs', () => {
    const runs = [
      run({ runId: 'a', startedAt: '2026-05-30T12:00:00.000Z', stats: usage(40_000, 2_000) }),
      run({ runId: 'b', startedAt: '2026-05-30T12:05:00.000Z', stats: usage(95_000, 3_000) })
    ]
    // Cumulative would be 140k; honest = latest run only (95k + 3k).
    expect(currentContextTokens(runs)).toBe(98_000)
  })

  it('ignores runs without usage stats when picking the latest', () => {
    const runs = [
      run({ runId: 'a', startedAt: '2026-05-30T12:00:00.000Z', stats: usage(80_000, 1_000) }),
      run({ runId: 'b', startedAt: '2026-05-30T12:09:00.000Z', stats: undefined })
    ]
    expect(currentContextTokens(runs)).toBe(81_000)
  })

  it('adds the in-flight output estimate only while running', () => {
    const runs = [run({ stats: usage(50_000, 1_000) })]
    expect(currentContextTokens(runs, { liveOutputTokens: 500, isRunning: true })).toBe(51_500)
    expect(currentContextTokens(runs, { liveOutputTokens: 500, isRunning: false })).toBe(51_000)
  })

  it('returns 0 for an empty / statless thread', () => {
    expect(currentContextTokens([])).toBe(0)
    expect(currentContextTokens([run({ stats: undefined })])).toBe(0)
  })

  it('uses a valid total-only provider snapshot instead of discarding the run', () => {
    expect(currentContextTokens([run({ stats: { total_tokens: 91_000 } })])).toBe(91_000)
  })

  it('uses the atomic last invocation instead of a multi-request turn aggregate', () => {
    const atomic = withContextUsageSnapshot(
      {
        input_tokens: 90_000,
        output_tokens: 1_000,
        total_tokens: 91_000
      },
      { source: 'provider-last-invocation', precision: 'exact' }
    )
    expect(
      currentContextUsage([
        run({
          stats: {
            input_tokens: 500_000,
            output_tokens: 20_000,
            total_tokens: 520_000,
            _taskwraith_context_usage: atomic._taskwraith_context_usage
          }
        })
      ])
    ).toMatchObject({
      contextTokens: 91_000,
      source: 'provider-last-invocation',
      precision: 'exact'
    })
  })

  it('replaces a pre-compaction run snapshot with the provider post-token count', () => {
    const messages = [
      {
        id: 'compacted',
        role: 'system',
        content: 'Context compacted',
        timestamp: '2026-05-30T12:05:00.000Z',
        metadata: {
          kind: 'contextCompaction',
          contextCompaction: {
            kind: 'completed',
            telemetry: { provider: 'claude', postTokens: 22_000 }
          }
        }
      }
    ] as ChatMessage[]

    expect(currentContextUsage([run({ stats: usage(90_000, 1_000) })], { messages })).toMatchObject(
      {
        contextTokens: 22_000,
        unclassifiedTokens: 22_000,
        source: 'provider-compaction',
        precision: 'exact'
      }
    )
  })

  it('marks live output added to an exact compaction baseline as derived', () => {
    const messages = [
      {
        id: 'compacted',
        role: 'system',
        content: 'Context compacted',
        timestamp: '2026-05-30T12:05:00.000Z',
        metadata: {
          kind: 'contextCompaction',
          contextCompaction: {
            kind: 'completed',
            telemetry: { provider: 'claude', postTokens: 22_000 }
          }
        }
      }
    ] as ChatMessage[]

    expect(
      currentContextUsage([run({ stats: usage(90_000, 1_000) })], {
        messages,
        isRunning: true,
        liveOutputTokens: 500
      })
    ).toMatchObject({
      contextTokens: 22_500,
      unclassifiedTokens: 22_000,
      outputTokens: 500,
      visibleOutputTokens: 500,
      source: 'provider-compaction',
      precision: 'derived'
    })
  })

  it('keeps an atomic invocation received after an in-run compaction', () => {
    const observedAt = Date.parse('2026-05-30T12:06:00.000Z')
    const atomic = withContextUsageSnapshot(
      { input_tokens: 25_000, output_tokens: 500 },
      {
        source: 'provider-last-invocation',
        precision: 'exact',
        observedAt
      }
    )
    const messages = [
      {
        id: 'compacted',
        role: 'system',
        content: 'Context compacted',
        timestamp: '2026-05-30T12:05:00.000Z',
        metadata: {
          kind: 'contextCompaction',
          contextCompaction: {
            kind: 'completed',
            telemetry: { provider: 'claude', postTokens: 22_000 }
          }
        }
      }
    ] as ChatMessage[]

    expect(
      currentContextUsage(
        [
          run({
            startedAt: '2026-05-30T12:00:00.000Z',
            stats: atomic
          })
        ],
        { messages }
      )
    ).toMatchObject({
      observedAt,
      contextTokens: 25_500,
      source: 'provider-last-invocation'
    })
  })

  it('marks the prior count stale when compaction completes without post tokens', () => {
    const messages = [
      {
        id: 'compacted',
        role: 'system',
        content: 'Context compacted',
        timestamp: '2026-05-30T12:05:00.000Z',
        metadata: {
          kind: 'contextCompaction',
          contextCompaction: { kind: 'completed', telemetry: { provider: 'antigravity' } }
        }
      }
    ] as ChatMessage[]

    expect(currentContextUsage([run({ stats: usage(90_000, 1_000) })], { messages })).toMatchObject(
      {
        contextTokens: 91_000,
        source: 'post-compaction-unknown',
        precision: 'estimated'
      }
    )
  })
})

describe('contextTokensFromUsage', () => {
  it('keeps an explicit total when provider usage omits a field or includes thinking tokens', () => {
    expect(contextTokensFromUsage({ totalTokens: 91_000 })).toBe(91_000)
    expect(
      contextTokensFromUsage({ inputTokens: 80_000, outputTokens: 2_000, totalTokens: 84_000 })
    ).toBe(84_000)
  })
})

describe('buildParticipantContextRows — per-participant honest context', () => {
  const participants: EnsembleParticipant[] = [
    {
      id: 'p1',
      provider: 'claude',
      enabled: true,
      role: 'Architect',
      order: 0
    } as EnsembleParticipant,
    { id: 'p2', provider: 'codex', enabled: true, role: 'Builder', order: 1 } as EnsembleParticipant
  ]

  it('scopes each row to that participant latest run (not the other participant)', () => {
    const runs = [
      run({
        runId: 'p1a',
        ensembleParticipantId: 'p1',
        startedAt: '2026-05-30T12:00:00.000Z',
        stats: usage(10_000, 500)
      }),
      run({
        runId: 'p1b',
        ensembleParticipantId: 'p1',
        startedAt: '2026-05-30T12:06:00.000Z',
        stats: usage(120_000, 4_000)
      }),
      run({
        runId: 'p2a',
        ensembleParticipantId: 'p2',
        startedAt: '2026-05-30T12:03:00.000Z',
        stats: usage(30_000, 1_000)
      })
    ]
    const rows = buildParticipantContextRows(runs, participants)
    expect(rows.map((r) => [r.id, r.usedTokens])).toEqual([
      ['p1', 124_000],
      ['p2', 31_000]
    ])
    expect(rows[0].role).toBe('Architect')
    expect(rows[0].provider).toBe('claude')
    expect(rows[0].windowTokens).toBeGreaterThan(0)
    expect(rows[0].percent).toBeGreaterThan(0)
  })

  it('reads 0% for a participant that has not run yet', () => {
    const rows = buildParticipantContextRows([], participants)
    expect(rows.every((r) => r.usedTokens === 0 && r.percent === 0)).toBe(true)
  })

  it('uses a total-only snapshot for an individual participant', () => {
    const rows = buildParticipantContextRows(
      [run({ ensembleParticipantId: 'p1', stats: { totalTokens: 101_000 } })],
      participants
    )
    expect(rows.find((row) => row.id === 'p1')?.usedTokens).toBe(101_000)
    expect(rows.find((row) => row.id === 'p2')?.usedTokens).toBe(0)
  })

  it('uses the latest run-reported context limit for a plan-entitled Kimi seat', () => {
    const kimi = {
      id: 'kimi-k3',
      provider: 'kimi',
      model: 'kimi-k3',
      enabled: true,
      role: 'Builder',
      order: 0
    } as EnsembleParticipant
    const rows = buildParticipantContextRows(
      [
        run({
          provider: 'kimi',
          ensembleParticipantId: kimi.id,
          stats: { ...usage(250_000, 12_000), totalTokenLimit: 1_048_576 }
        })
      ],
      [kimi]
    )

    expect(rows[0].usedTokens).toBe(262_000)
    expect(rows[0].windowTokens).toBe(1_048_576)
    expect(rows[0].percent).toBeCloseTo(24.99, 1)
  })

  it('adds the live output estimate ONLY to the actively-running participant', () => {
    const runs = [
      run({ runId: 'p1a', ensembleParticipantId: 'p1', stats: usage(80_000, 2_000) }),
      run({ runId: 'p2a', ensembleParticipantId: 'p2', stats: usage(30_000, 1_000) })
    ]
    const rows = buildParticipantContextRows(runs, participants, {
      participantId: 'p1',
      outputTokens: 600
    })
    expect(rows.find((r) => r.id === 'p1')?.usedTokens).toBe(82_600) // 80k+2k + 600 live
    expect(rows.find((r) => r.id === 'p2')?.usedTokens).toBe(31_000) // untouched
  })

  it('applies completed compaction only to its matching participant row', () => {
    const runs = [
      run({ runId: 'p1a', ensembleParticipantId: 'p1', stats: usage(80_000, 2_000) }),
      run({ runId: 'p2a', ensembleParticipantId: 'p2', stats: usage(30_000, 1_000) })
    ]
    const messages = [
      {
        id: 'p1-compacted',
        role: 'system',
        content: 'Context compacted',
        timestamp: '2026-05-30T12:05:00.000Z',
        metadata: {
          kind: 'contextCompaction',
          ensembleParticipantId: 'p1',
          contextCompaction: {
            kind: 'completed',
            telemetry: { provider: 'claude', postTokens: 18_000 }
          }
        }
      }
    ] as ChatMessage[]

    const rows = buildParticipantContextRows(runs, participants, { messages })
    expect(rows.find((row) => row.id === 'p1')?.usedTokens).toBe(18_000)
    expect(rows.find((row) => row.id === 'p2')?.usedTokens).toBe(31_000)
  })

  it('indexes compaction evidence once for every participant row', () => {
    let metadataReads = 0
    const metadata = {
      kind: 'contextCompaction',
      ensembleParticipantId: 'p1',
      contextCompaction: {
        kind: 'completed',
        telemetry: { provider: 'claude', postTokens: 18_000 }
      }
    }
    const messages = [
      {
        id: 'p1-compacted',
        role: 'system',
        content: 'Context compacted',
        timestamp: '2026-05-30T12:05:00.000Z',
        get metadata() {
          metadataReads += 1
          return metadata
        }
      }
    ] as ChatMessage[]

    const rows = buildParticipantContextRows(
      [
        run({ runId: 'p1a', ensembleParticipantId: 'p1', stats: usage(80_000, 2_000) }),
        run({ runId: 'p2a', ensembleParticipantId: 'p2', stats: usage(30_000, 1_000) })
      ],
      participants,
      { messages }
    )

    expect(metadataReads).toBe(messages.length)
    expect(rows.find((row) => row.id === 'p1')?.usedTokens).toBe(18_000)
    expect(rows.find((row) => row.id === 'p2')?.usedTokens).toBe(31_000)
  })

  it('does not fall back to a pre-compaction run when exact post usage is zero', () => {
    const rows = buildParticipantContextRows(
      [run({ runId: 'p1a', ensembleParticipantId: 'p1', stats: usage(80_000, 2_000) })],
      participants,
      {
        messages: [
          {
            id: 'p1-compacted-empty',
            role: 'system',
            content: 'Context compacted',
            timestamp: '2026-05-30T12:05:00.000Z',
            metadata: {
              ensembleParticipantId: 'p1',
              contextCompaction: {
                kind: 'completed',
                telemetry: { provider: 'claude', postTokens: 0 }
              }
            }
          }
        ] as ChatMessage[]
      }
    )

    expect(rows.find((row) => row.id === 'p1')?.usedTokens).toBe(0)
  })

  it('no live add when participantId is unset', () => {
    const runs = [run({ runId: 'p1a', ensembleParticipantId: 'p1', stats: usage(80_000, 2_000) })]
    const rows = buildParticipantContextRows(runs, participants, { outputTokens: 600 })
    expect(rows.find((r) => r.id === 'p1')?.usedTokens).toBe(82_000)
  })

  it('uses live Ollama context windows supplied by the app for participant rows', () => {
    const rows = buildParticipantContextRows(
      [],
      [
        {
          id: 'ollama-custom',
          provider: 'ollama',
          model: 'custom-local:latest',
          enabled: true,
          role: 'Local',
          order: 0
        } as EnsembleParticipant,
        {
          id: 'claude',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          enabled: true,
          role: 'Reviewer',
          order: 1
        } as EnsembleParticipant
      ],
      {
        resolveWindowTokens: (participant) =>
          participant.provider === 'ollama' ? 65_536 : undefined
      }
    )

    expect(rows.find((r) => r.id === 'ollama-custom')?.windowTokens).toBe(65_536)
    expect(rows.find((r) => r.id === 'claude')?.windowTokens).toBe(200_000)
  })
})

describe('applyLiveContextTokenUsage', () => {
  it('replaces the active solo run with its live provider context snapshot', () => {
    const meter = {
      solo: {
        id: 'solo',
        provider: 'codex' as const,
        usedTokens: 20_000,
        windowTokens: 200_000,
        percent: 10
      }
    }
    const updated = applyLiveContextTokenUsage(meter, {
      inputTokens: 86_000,
      outputTokens: 4_000,
      totalTokens: 90_000
    })
    expect(updated?.solo.usedTokens).toBe(90_000)
    expect(updated?.solo.percent).toBe(45)
  })

  it('updates only the active ensemble participant row', () => {
    const meter = {
      solo: {
        id: 'solo',
        provider: 'claude' as const,
        usedTokens: 0,
        windowTokens: 200_000,
        percent: 0
      },
      participants: [
        {
          id: 'p1',
          provider: 'claude' as const,
          usedTokens: 20_000,
          windowTokens: 200_000,
          percent: 10
        },
        {
          id: 'p2',
          provider: 'codex' as const,
          usedTokens: 30_000,
          windowTokens: 1_050_000,
          percent: 2.86
        }
      ]
    }
    const updated = applyLiveContextTokenUsage(meter, { totalTokens: 90_000 }, 'p2')
    expect(updated?.participants?.map((row) => row.usedTokens)).toEqual([20_000, 90_000])
  })

  it('lets an exact zero snapshot replace stale live context', () => {
    const meter = {
      solo: {
        id: 'solo',
        provider: 'claude' as const,
        usedTokens: 90_000,
        windowTokens: 200_000,
        percent: 45
      }
    }
    const updated = applyLiveContextTokenUsage(meter, {
      contextUsage: {
        observedAt: 1,
        contextTokens: 0,
        totalTokens: 0,
        inputTokens: 0,
        freshInputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 0,
        visibleOutputTokens: 0,
        reasoningTokens: 0,
        toolUsePromptTokens: 0,
        unclassifiedTokens: 0,
        source: 'provider-compaction',
        precision: 'exact'
      }
    })

    expect(updated?.solo).toMatchObject({
      usedTokens: 0,
      percent: 0,
      usage: {
        contextTokens: 0,
        source: 'provider-compaction',
        precision: 'exact'
      }
    })
  })

  it('does not let a stale active-run snapshot undo a completed compaction', () => {
    const meter = {
      solo: {
        id: 'solo',
        provider: 'claude' as const,
        usedTokens: 0,
        windowTokens: 200_000,
        percent: 0,
        usage: {
          observedAt: 200,
          contextTokens: 0,
          totalTokens: 0,
          inputTokens: 0,
          freshInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          visibleOutputTokens: 0,
          reasoningTokens: 0,
          toolUsePromptTokens: 0,
          unclassifiedTokens: 0,
          source: 'provider-compaction' as const,
          precision: 'exact' as const
        }
      }
    }
    const staleLive = {
      contextUsage: {
        observedAt: 100,
        contextTokens: 90_000,
        totalTokens: 90_000,
        inputTokens: 86_000,
        freshInputTokens: 6_000,
        cacheReadInputTokens: 80_000,
        cacheCreationInputTokens: 0,
        outputTokens: 4_000,
        visibleOutputTokens: 4_000,
        reasoningTokens: 0,
        toolUsePromptTokens: 0,
        unclassifiedTokens: 0,
        source: 'provider-last-invocation' as const,
        precision: 'exact' as const
      }
    }

    expect(applyLiveContextTokenUsage(meter, staleLive)?.solo).toMatchObject({
      usedTokens: 0,
      percent: 0,
      usage: {
        observedAt: 200,
        contextTokens: 0,
        source: 'provider-compaction'
      }
    })
  })

  it('allows a provider invocation received after compaction to resume live context', () => {
    const compacted = {
      solo: {
        id: 'solo',
        provider: 'claude' as const,
        usedTokens: 0,
        windowTokens: 200_000,
        percent: 0,
        usage: {
          observedAt: 100,
          contextTokens: 0,
          totalTokens: 0,
          inputTokens: 0,
          freshInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
          visibleOutputTokens: 0,
          reasoningTokens: 0,
          toolUsePromptTokens: 0,
          unclassifiedTokens: 0,
          source: 'provider-compaction' as const,
          precision: 'exact' as const
        }
      }
    }
    const laterLive = {
      contextUsage: {
        observedAt: 200,
        contextTokens: 25_000,
        totalTokens: 25_000,
        inputTokens: 24_000,
        freshInputTokens: 24_000,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        outputTokens: 1_000,
        visibleOutputTokens: 1_000,
        reasoningTokens: 0,
        toolUsePromptTokens: 0,
        unclassifiedTokens: 0,
        source: 'provider-last-invocation' as const,
        precision: 'exact' as const
      }
    }

    expect(applyLiveContextTokenUsage(compacted, laterLive)?.solo).toMatchObject({
      usedTokens: 25_000,
      usage: {
        observedAt: 200,
        source: 'provider-last-invocation'
      }
    })
  })
})

describe('liveOutputTokensForParticipant — scoped to the active participant only', () => {
  const id = (chars: number) => chars // identity so we assert the char count directly

  it('counts ONLY the active participant unsealed-run output, not earlier sealed peers', () => {
    const runs = [
      // p1 already answered + sealed this round (endedAt set, success)
      run({
        runId: 'p1run',
        ensembleParticipantId: 'p1',
        status: 'success',
        endedAt: '2026-05-30T12:05:00.000Z'
      }),
      // p2 is streaming now (no endedAt, running)
      run({ runId: 'p2run', ensembleParticipantId: 'p2', status: 'running' })
    ]
    const messages = [
      { role: 'assistant', runId: 'p1run', content: 'AAAA' }, // p1 sealed — MUST be ignored
      { role: 'assistant', runId: 'p2run', content: 'BB' }, // p2 live — counted
      { role: 'user', runId: 'p2run', content: 'ignored-non-assistant' }
    ]
    // The bug was: a chat-wide sum gave p2 'AAAA'+'BB'=6; scoped gives only 'BB'=2.
    expect(liveOutputTokensForParticipant(runs, messages, 'p2', id)).toBe(2)
    // p1 has no UNSEALED run → 0 (it's done).
    expect(liveOutputTokensForParticipant(runs, messages, 'p1', id)).toBe(0)
  })

  it('returns 0 when participantId is undefined or has no unsealed run', () => {
    const runs = [run({ runId: 'p2run', ensembleParticipantId: 'p2', status: 'running' })]
    expect(liveOutputTokensForParticipant(runs, [], undefined, id)).toBe(0)
    expect(liveOutputTokensForParticipant([], [], 'p2', id)).toBe(0)
  })
})

describe('buildContextActivitySummary', () => {
  it('tracks message, reasoning, and tool directions without adding them to provider totals', () => {
    const messages = [
      {
        id: 'user',
        role: 'user',
        content: 'Read and update the file.',
        timestamp: '2026-05-30T12:00:00.000Z'
      },
      {
        id: 'tools',
        role: 'tool',
        content: '',
        timestamp: '2026-05-30T12:00:01.000Z',
        metadata: { ensembleParticipantId: 'p1' },
        toolActivities: [
          {
            id: 'read',
            toolName: 'read_file',
            displayName: 'Read file',
            category: 'read',
            status: 'success',
            parameters: { file_path: '/tmp/a.ts' },
            outputPreview: 'const a = 1',
            metadata: { ensembleParticipantId: 'p1' }
          },
          {
            id: 'think',
            toolName: 'codex_reasoning',
            displayName: 'Reasoning',
            category: 'unknown',
            status: 'success',
            outputPreview: 'Need to inspect the call site.',
            metadata: { ensembleParticipantId: 'p1' }
          }
        ]
      }
    ] as ChatMessage[]

    expect(buildContextActivitySummary(messages, 'p1')).toMatchObject({
      messageCount: 1,
      userMessageCount: 1,
      toolCallCount: 1,
      toolResultCount: 1,
      readCalls: 1,
      filesRead: 1,
      reasoningSegmentCount: 1,
      tools: [{ name: 'read_file', count: 1 }]
    })
  })
})
