import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatRun } from '../../../main/store/types'
import {
  buildEnsembleRoundCostRow,
  buildEnsembleRoundSummaryRows,
  buildEnsembleRoundTokenDetails,
  buildRunCompleteSummaryRows,
  buildRunCompleteTokenDetails,
  buildRunCompleteBlockers,
  buildRoundOutcomeRows,
  resolveRunCompleteStatus,
  runCompleteProducedWork
} from './runCompleteSummary'
import type { ComplexityEscalationSignal } from '../../../main/store/types'
import type { RendererProviderRates } from './providerRateEstimate'

// activeRound.participants is all buildRoundOutcomeRows reads; a partial cast
// keeps the fixture focused on status outcomes.
function chatWithParticipants(
  statuses: Array<{ role: string; provider: string; status: string }>
): ChatRecord {
  return {
    chatKind: 'ensemble',
    runs: [],
    ensemble: {
      activeRound: {
        roundId: 'r1',
        participants: statuses.map((s, i) => ({
          participantId: `p${i}`,
          provider: s.provider,
          role: s.role,
          order: i,
          status: s.status
        }))
      }
    }
  } as unknown as ChatRecord
}

describe('buildRoundOutcomeRows', () => {
  it('groups participants into contributed / skipped / failed', () => {
    const rows = buildRoundOutcomeRows(
      chatWithParticipants([
        { role: 'Worker', provider: 'codex', status: 'answered' },
        { role: 'Reviewer', provider: 'claude', status: 'yielded' },
        { role: 'Scout', provider: 'gemini', status: 'skipped' },
        { role: 'Runner', provider: 'grok', status: 'failed' },
        { role: 'Probe', provider: 'cursor', status: 'unreachable' },
        { role: 'Napper', provider: 'kimi', status: 'sleeping' }
      ])
    )
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]))
    expect(byLabel.Contributed).toBe('Worker, Reviewer')
    expect(byLabel.Skipped).toBe('Scout, Napper')
    expect(byLabel.Failed).toBe('Runner, Probe')
  })

  it('omits empty buckets and falls back to provider when role is blank', () => {
    const rows = buildRoundOutcomeRows(
      chatWithParticipants([{ role: '  ', provider: 'codex', status: 'answered' }])
    )
    expect(rows).toEqual([{ label: 'Contributed', value: 'codex' }])
  })

  it('returns nothing when there is no active round', () => {
    expect(buildRoundOutcomeRows(null)).toEqual([])
    expect(buildRoundOutcomeRows({} as unknown as ChatRecord)).toEqual([])
  })
})

describe('buildEnsembleRoundSummaryRows', () => {
  it('appends the outcome rollup right after Status', () => {
    const chat = chatWithParticipants([
      { role: 'Worker', provider: 'codex', status: 'answered' },
      { role: 'Scout', provider: 'gemini', status: 'skipped' }
    ])
    const labels = buildEnsembleRoundSummaryRows(chat, false).map((r) => r.label)
    expect(labels).toContain('Status')
    expect(labels).toContain('Contributed')
    expect(labels).toContain('Skipped')
    expect(labels.indexOf('Contributed')).toBe(labels.indexOf('Status') + 1)
  })

  it('labels the round wall-clock row "Latency" (not "Duration")', () => {
    const chat = {
      chatKind: 'ensemble',
      runs: [],
      ensemble: {
        activeRound: {
          roundId: 'r1',
          participants: [],
          startedAt: '2026-06-04T10:00:00.000Z',
          endedAt: '2026-06-04T10:00:30.000Z'
        }
      }
    } as unknown as ChatRecord
    const labels = buildEnsembleRoundSummaryRows(chat, false).map((r) => r.label)
    expect(labels).toContain('Latency')
    expect(labels).not.toContain('Duration')
    const latency = buildEnsembleRoundSummaryRows(chat, false).find((r) => r.label === 'Latency')
    expect(latency?.value).toBe('30s')
  })

  it('threads cost options through to a Cost row', () => {
    const chat = {
      chatKind: 'ensemble',
      runs: [run({ provider: 'claude', stats: { cost_usd: 0.5 } })],
      ensemble: { activeRound: { roundId: 'r1', participants: [] } }
    } as unknown as ChatRecord
    const cost = buildEnsembleRoundSummaryRows(chat, false, { currency: 'USD' }).find(
      (r) => r.label === 'Cost'
    )
    expect(cost?.value).toBe('$0.50')
  })

  it('appends a RAM row when an Ollama lane reports peak RSS', () => {
    const chat = {
      chatKind: 'ensemble',
      runs: [
        run({ provider: 'claude', stats: { cost_usd: 0.31, inputTokens: 100, outputTokens: 20 } }),
        run({
          provider: 'ollama',
          stats: {
            inputTokens: 50,
            outputTokens: 10,
            ollamaMemoryPeakRssGb: 41,
            ollamaMemorySampleCount: 9
          }
        })
      ],
      ensemble: { activeRound: { roundId: 'r1', participants: [] } }
    } as unknown as ChatRecord
    const rows = buildEnsembleRoundSummaryRows(chat, false, { currency: 'GBP' })
    expect(rows.find((r) => r.label === 'Cost')?.value).toContain('£')
    expect(rows.find((r) => r.label === 'RAM')?.value).toBe(
      '41 GB llama-server peak, 9 samples'
    )
  })
})

describe('buildEnsembleRoundTokenDetails', () => {
  it('maps round participants to role token cells and a round total', () => {
    const chat = {
      chatKind: 'ensemble',
      runs: [
        run({
          provider: 'codex',
          ensembleParticipantId: 'worker',
          stats: { input_tokens: 1000, output_tokens: 200 }
        }),
        run({
          provider: 'ollama',
          ensembleParticipantId: 'scout',
          requestedModel: 'laguna-xs-2.1:q8_0',
          stats: { input_tokens: 300, output_tokens: 50 }
        })
      ],
      ensemble: {
        bossmanParticipantId: 'scout',
        secondInCommandParticipantId: 'worker',
        participants: [
          { id: 'worker', provider: 'codex', role: 'Worker', order: 1 },
          {
            id: 'scout',
            provider: 'ollama',
            role: 'Scout',
            order: 0,
            model: 'laguna-xs-2.1:q8_0'
          }
        ],
        activeRound: {
          roundId: 'r1',
          participants: [
            {
              participantId: 'worker',
              provider: 'codex',
              role: 'Worker',
              order: 1,
              status: 'answered'
            },
            {
              participantId: 'scout',
              provider: 'ollama',
              role: 'Scout',
              order: 0,
              status: 'answered'
            },
            {
              participantId: 'reviewer',
              provider: 'claude',
              role: 'Reviewer',
              order: 2,
              status: 'skipped'
            }
          ]
        }
      }
    } as unknown as ChatRecord

    const details = buildEnsembleRoundTokenDetails(chat)
    expect(details?.participants.map((participant) => participant.label)).toEqual([
      'Scout',
      'Worker',
      'Reviewer'
    ])
    expect(
      details?.participants.map((participant) => ({
        label: participant.label,
        isBossman: participant.isBossman,
        isCaptain: participant.isCaptain
      }))
    ).toEqual([
      { label: 'Scout', isBossman: true, isCaptain: false },
      { label: 'Worker', isBossman: false, isCaptain: true },
      { label: 'Reviewer', isBossman: false, isCaptain: false }
    ])
    expect(details?.participants[0].providerClass).toBe('poolside')
    expect(details?.participants[0].totalTokens).toBe(350)
    expect(details?.participants[2].tokensLabel).toBe('-')
    expect(details?.totalTokens).toBe(1550)
  })

  it('returns null when the round has no token data', () => {
    const chat = chatWithParticipants([{ role: 'Scout', provider: 'gemini', status: 'answered' }])
    expect(buildEnsembleRoundTokenDetails(chat)).toBeNull()
  })
})

describe('buildRunCompleteSummaryRows', () => {
  it('distinguishes Plan workflow from read-only posture even though both use provider plan mode', () => {
    expect(
      buildRunCompleteSummaryRows(
        run({ provider: 'codex', approvalMode: 'plan', workflowMode: 'plan' })
      )
    ).toContainEqual({ label: 'Mode', value: 'Plan' })
    expect(
      buildRunCompleteSummaryRows(
        run({ provider: 'codex', approvalMode: 'plan', workflowMode: 'normal' })
      )
    ).toContainEqual({ label: 'Mode', value: 'Read-Only/Recon' })
  })

  it('renders Ollama model and RAM as local hardware telemetry', () => {
    const rows = buildRunCompleteSummaryRows(
      run({
        provider: 'ollama',
        actualModel: 'qwen3.5:9b',
        approvalMode: 'plan',
        status: 'completed',
        stats: {
          inputTokens: 100,
          outputTokens: 25,
          ollamaMemoryPeakRssGb: 2.42,
          ollamaMemorySampleCount: 3
        }
      })
    )
    expect(rows).toContainEqual({ label: 'Model', value: 'Qwen 3.5 (9B Param)' })
    expect(rows).toContainEqual({ label: 'Tokens', value: '100 in / 25 out' })
    expect(rows).toContainEqual({ label: 'RAM', value: '2.4 GB llama-server peak, 3 samples' })
  })
})

describe('buildRunCompleteTokenDetails', () => {
  it('builds a single provider token cell for solo runs', () => {
    const details = buildRunCompleteTokenDetails(
      run({
        provider: 'claude',
        stats: { input_tokens: 1200, output_tokens: 300 }
      })
    )
    expect(details?.participants).toHaveLength(1)
    expect(details?.participants[0]).toMatchObject({
      provider: 'claude',
      providerClass: 'claude',
      label: 'Claude',
      isBossman: false,
      isCaptain: false,
      totalTokens: 1500
    })
    expect(details?.totalTokens).toBe(1500)
  })
})

// A run belonging to round r1, with overridable provider/model/stats. Only the
// fields the cost row reads matter; cast keeps the fixture focused.
function run(partial: Partial<ChatRun>): ChatRun {
  return {
    runId: Math.random().toString(36).slice(2),
    ensembleRoundId: 'r1',
    ...partial
  } as ChatRun
}

const ESTIMATE_RATES: RendererProviderRates = {
  codex: [
    {
      modelId: 'gpt-5.5',
      inputUsdPerMillion: 1.25,
      outputUsdPerMillion: 10.0,
      cachedInputUsdPerMillion: 0.125
    }
  ],
  kimi: [
    { modelId: 'kimi-k2.7-code', inputUsdPerMillion: 0.95, outputUsdPerMillion: 4 },
    {
      modelId: 'kimi-k2.7-code-highspeed',
      inputUsdPerMillion: 1.9,
      outputUsdPerMillion: 8
    }
  ],
  cursor: []
}

describe('buildEnsembleRoundCostRow', () => {
  it('sums explicit cost_usd across runs into a plain currency string', () => {
    const row = buildEnsembleRoundCostRow(
      [run({ provider: 'claude', stats: { cost_usd: 0.5 } }), run({ stats: { cost_usd: 0.25 } })],
      { currency: 'USD' }
    )
    expect(row).toEqual({ label: 'Cost', value: '$0.75' })
  })

  it('returns null when there is no real cost AND no estimate', () => {
    // Codex run with no cost_usd and no rate table → nothing to show.
    expect(buildEnsembleRoundCostRow([run({ provider: 'codex', stats: {} })], {})).toBeNull()
    expect(buildEnsembleRoundCostRow([], {})).toBeNull()
  })

  it('projects a clearly-badged API-equivalent estimate for subscription seats', () => {
    // Codex emits no cost_usd → estimate from tokens:
    // 1,000,000 in * $1.25/M + 100,000 out * $10/M = 1.25 + 1.00 = $2.25
    const row = buildEnsembleRoundCostRow(
      [
        run({
          provider: 'codex',
          actualModel: 'gpt-5.5',
          stats: { input_tokens: 1_000_000, output_tokens: 100_000 }
        })
      ],
      { currency: 'USD', providerRates: ESTIMATE_RATES }
    )
    expect(row?.label).toBe('Cost')
    // Badged with leading ~ AND the est. API-equiv qualifier — never a bare $.
    expect(row?.value).toBe('~$2.25 est. API-equiv')
  })

  it('uses Kimi Fast mode\'s internal Highspeed rate without changing the display model', () => {
    const row = buildEnsembleRoundCostRow(
      [
        run({
          provider: 'kimi',
          actualModel: 'kimi-k2.7-code',
          stats: {
            input_tokens: 1_000_000,
            output_tokens: 500_000,
            _taskwraith_cost_rate_model: 'kimi-k2.7-code-highspeed'
          }
        })
      ],
      { currency: 'USD', providerRates: ESTIMATE_RATES }
    )

    expect(row?.value).toBe('~$5.90 est. API-equiv')
  })

  it('shows real + estimate together when seats are mixed, keeping the estimate badged', () => {
    const row = buildEnsembleRoundCostRow(
      [
        run({ provider: 'claude', stats: { cost_usd: 0.5 } }),
        run({
          provider: 'codex',
          actualModel: 'gpt-5.5',
          stats: { input_tokens: 1_000_000, output_tokens: 0 }
        })
      ],
      { currency: 'USD', providerRates: ESTIMATE_RATES }
    )
    // Real $0.50 + projected $1.25 (1M in * $1.25/M), estimate still badged.
    expect(row?.value).toBe('$0.50 + ~$1.25 est. API-equiv')
  })

  it('uses cached input rates for cache-read tokens in projected subscription costs', () => {
    const row = buildEnsembleRoundCostRow(
      [
        run({
          provider: 'codex',
          actualModel: 'gpt-5.5',
          stats: {
            input_tokens: 1_000_000,
            cache_read_input_tokens: 4_000_000,
            output_tokens: 0
          }
        })
      ],
      { currency: 'USD', providerRates: ESTIMATE_RATES }
    )
    // 1M normal input * $1.25/M + 4M cache read * $0.125/M = $1.75.
    expect(row?.value).toBe('~$1.75 est. API-equiv')
  })

  it('does not add historical Codex cache-subset aliases twice', () => {
    const row = buildEnsembleRoundCostRow(
      [
        run({
          provider: 'codex',
          actualModel: 'gpt-5.5',
          stats: {
            input_tokens: 1_000_000,
            cachedInputTokens: 800_000,
            cached_input_tokens: 800_000,
            output_tokens: 0
          }
        })
      ],
      { currency: 'USD', providerRates: ESTIMATE_RATES }
    )

    expect(row?.value).toBe('~$0.35 est. API-equiv')
  })

  it('never estimates a seat that already reported cost_usd', () => {
    // Even with a rate table present + tokens, an explicit cost wins and no
    // "est." badge appears.
    const row = buildEnsembleRoundCostRow(
      [
        run({
          provider: 'codex',
          actualModel: 'gpt-5.5',
          stats: { cost_usd: 3, input_tokens: 1_000_000, output_tokens: 1_000_000 }
        })
      ],
      { currency: 'USD', providerRates: ESTIMATE_RATES }
    )
    expect(row?.value).toBe('$3.00')
    expect(row?.value).not.toContain('est.')
  })

  it('does not estimate Cursor (empty rate list) and shows nothing for a pure subscription round with no rates', () => {
    const row = buildEnsembleRoundCostRow(
      [run({ provider: 'cursor', stats: { input_tokens: 500_000, output_tokens: 500_000 } })],
      { currency: 'USD', providerRates: ESTIMATE_RATES }
    )
    expect(row).toBeNull()
  })

  it('honours the display currency for the real-cost path', () => {
    const row = buildEnsembleRoundCostRow([run({ provider: 'claude', stats: { cost_usd: 1 } })], {
      currency: 'GBP'
    })
    // £ symbol present (GBP); exact figure depends on the FX table.
    expect(row?.value).toMatch(/£/)
  })
})

function sig(partial: Partial<ComplexityEscalationSignal>): ComplexityEscalationSignal {
  return {
    id: partial.id || Math.random().toString(36).slice(2),
    chatId: 'c1',
    roundId: 'r1',
    kind: 'stuck',
    evidence: 'because',
    recommendedAction: 'pause-for-user',
    createdAt: '2026-06-04T10:00:00.000Z',
    ...partial
  }
}

function chatWithSignals(
  signals: ComplexityEscalationSignal[],
  roundId: string | null = 'r1',
  roundOverrides: Record<string, unknown> = {}
): ChatRecord {
  return {
    chatKind: 'ensemble',
    runs: [],
    ensemble: {
      ...(roundId ? { activeRound: { roundId, participants: [], ...roundOverrides } } : {}),
      escalationSignals: signals
    }
  } as unknown as ChatRecord
}

describe('buildRunCompleteBlockers', () => {
  it('returns [] when there is no active round or no signals', () => {
    expect(buildRunCompleteBlockers(null)).toEqual([])
    expect(buildRunCompleteBlockers(chatWithSignals([], null))).toEqual([])
    expect(buildRunCompleteBlockers(chatWithSignals([sig({ kind: 'stuck' })], null))).toEqual([])
    expect(buildRunCompleteBlockers(chatWithParticipants([]))).toEqual([])
  })

  it('carries the signal evidence line as the blocker detail', () => {
    expect(
      buildRunCompleteBlockers(
        chatWithSignals([sig({ kind: 'stuck', evidence: 'No participant answered.' })])
      )
    ).toEqual([{ kind: 'stuck', detail: 'No participant answered.' }])
  })

  it('only surfaces signals for the active round and de-dups by kind', () => {
    const blockers = buildRunCompleteBlockers(
      chatWithSignals([
        sig({ id: 'old', kind: 'stuck', roundId: 'r0', evidence: 'stale' }), // previous round
        sig({ id: 'a', kind: 'stuck', evidence: 'first' }),
        sig({ id: 'b', kind: 'stuck', evidence: 'dup' }) // dup kind — collapsed
      ])
    )
    expect(blockers).toEqual([{ kind: 'stuck', detail: 'first' }])
  })

  it('filters disagreement-unresolved from the title while keeping tool errors', () => {
    expect(
      buildRunCompleteBlockers(chatWithSignals([sig({ kind: 'disagreement-unresolved' })])).map(
        (b) => b.kind
      )
    ).toEqual([])
    expect(
      buildRunCompleteBlockers(chatWithSignals([sig({ kind: 'tool-error-cluster' })])).map(
        (b) => b.kind
      )
    ).toEqual(['tool-error-cluster'])
  })

  it('orders blockers worst-first so the title shows the most severe', () => {
    const blockers = buildRunCompleteBlockers(
      chatWithSignals([
        sig({ id: '1', kind: 'disagreement-unresolved' }),
        sig({ id: '2', kind: 'looping' }),
        sig({ id: '3', kind: 'stuck' }),
        sig({ id: '4', kind: 'tool-error-cluster' })
      ])
    )
    expect(blockers.map((b) => b.kind)).toEqual([
      'stuck',
      'tool-error-cluster',
      'looping'
    ])
  })

  it('prefers the live continuation counters over stored evidence for looping', () => {
    const blockers = buildRunCompleteBlockers(
      chatWithSignals([sig({ kind: 'looping', evidence: 'stored line' })], 'r1', {
        continuationHops: 7,
        maxContinuationHops: 7
      })
    )
    expect(blockers[0].detail).toBe('Handoff/Turns reached their limit (7/7).')
  })
})

describe('runCompleteProducedWork', () => {
  it('counts file changes, assistant output, or any participant that answered', () => {
    expect(runCompleteProducedWork({ chat: null, fileChangeCount: 1 })).toBe(true)
    expect(
      runCompleteProducedWork({ chat: null, fileChangeCount: 0, hadAssistantOutput: true })
    ).toBe(true)
    expect(
      runCompleteProducedWork({
        chat: chatWithParticipants([{ role: 'Worker', provider: 'codex', status: 'yielded' }]),
        fileChangeCount: 0
      })
    ).toBe(true)
  })

  it('is false for a round that produced nothing', () => {
    expect(
      runCompleteProducedWork({
        chat: chatWithParticipants([
          { role: 'Worker', provider: 'codex', status: 'failed' },
          { role: 'Reviewer', provider: 'claude', status: 'skipped' }
        ]),
        fileChangeCount: 0,
        hadAssistantOutput: false
      })
    ).toBe(false)
    expect(runCompleteProducedWork({ chat: null, fileChangeCount: 0 })).toBe(false)
  })
})

describe('resolveRunCompleteStatus', () => {
  const stalled = [{ kind: 'stuck' as const, detail: 'No participant answered.' }]

  it('titles a clean run "Task complete" with no accent', () => {
    expect(resolveRunCompleteStatus({ exitCode: 0, producedWork: true })).toMatchObject({
      kind: 'complete',
      label: 'Task complete',
      tone: 'neutral'
    })
  })

  it('replaces the title with the blocker and tints it yellow when work was produced', () => {
    expect(
      resolveRunCompleteStatus({ exitCode: 0, blockers: stalled, producedWork: true })
    ).toMatchObject({
      kind: 'stuck',
      label: 'Round stalled',
      tone: 'warning',
      detail: 'No participant answered.'
    })
  })

  it('tints the blocker red when nothing at all was produced', () => {
    expect(
      resolveRunCompleteStatus({ exitCode: 0, blockers: stalled, producedWork: false })
    ).toMatchObject({ kind: 'stuck', label: 'Round stalled', tone: 'danger' })
  })

  it('labels every blocker kind that remains in the title pool', () => {
    const labelFor = (kind: 'stuck' | 'looping' | 'tool-error-cluster'): string =>
      resolveRunCompleteStatus({
        exitCode: 0,
        blockers: [{ kind, detail: '' }],
        producedWork: true
      }).label
    expect(labelFor('stuck')).toBe('Round stalled')
    expect(labelFor('looping')).toBe('Handoff/turns exhausted')
    expect(labelFor('tool-error-cluster')).toBe('Tool errors clustered')
  })

  it('joins every blocker evidence line into the title tooltip, worst first', () => {
    expect(
      resolveRunCompleteStatus({
        exitCode: 0,
        blockers: [
          { kind: 'stuck', detail: 'No answer.' },
          { kind: 'tool-error-cluster', detail: '2 of 3 failed.' }
        ],
        producedWork: true
      }).detail
    ).toBe('No answer. 2 of 3 failed.')
  })

  // The user's own stop is not a failure of the round — titling a cancelled
  // ensemble round "Round stalled" in red would blame the harness for a
  // deliberate act.
  it('lets an intentional cancel outrank a blocker and stay neutral', () => {
    expect(
      resolveRunCompleteStatus({ exitCode: 130, blockers: stalled, producedWork: false })
    ).toMatchObject({ kind: 'cancelled', label: 'Run cancelled', tone: 'neutral' })
  })

  it('accents a non-zero exit by whether the run still produced work', () => {
    expect(resolveRunCompleteStatus({ exitCode: 1, producedWork: true })).toMatchObject({
      kind: 'exit-failure',
      label: 'Task ended (code 1)',
      srLabel: 'Task ended with code 1',
      tone: 'warning'
    })
    expect(resolveRunCompleteStatus({ exitCode: 1, producedWork: false }).tone).toBe('danger')
  })

  it('surfaces a non-ensemble intentional pause when a question is unanswered', () => {
    expect(
      resolveRunCompleteStatus({ exitCode: 0, producedWork: true, awaitingAnswer: true })
    ).toMatchObject({ kind: 'awaiting-answer', label: 'Awaiting your answer', tone: 'neutral' })
  })

  it('ranks a blocker above an unanswered question', () => {
    expect(
      resolveRunCompleteStatus({
        exitCode: 0,
        blockers: stalled,
        producedWork: true,
        awaitingAnswer: true
      }).kind
    ).toBe('stuck')
  })

  it('keeps the stripped global-chat wording', () => {
    expect(
      resolveRunCompleteStatus({ exitCode: 0, isGlobal: true, producedWork: true }).label
    ).toBe('Done')
    expect(
      resolveRunCompleteStatus({ exitCode: 130, isGlobal: true, producedWork: true }).label
    ).toBe('Stopped')
    expect(
      resolveRunCompleteStatus({ exitCode: 1, isGlobal: true, producedWork: true })
    ).toMatchObject({ label: "Couldn't finish", tone: 'warning' })
  })
})
