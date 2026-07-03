import { describe, expect, it } from 'vitest'
import type { ChatRecord, ChatRun } from '../../../main/store/types'
import {
  buildEnsembleRoundCostRow,
  buildEnsembleRoundSummaryRows,
  buildRunCompleteSummaryRows,
  buildEscalationChips,
  buildRoundOutcomeRows
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
  roundId: string | null = 'r1'
): ChatRecord {
  return {
    chatKind: 'ensemble',
    runs: [],
    ensemble: {
      ...(roundId ? { activeRound: { roundId, participants: [] } } : {}),
      escalationSignals: signals
    }
  } as unknown as ChatRecord
}

describe('buildEscalationChips', () => {
  it('returns [] when there is no active round or no signals', () => {
    expect(buildEscalationChips(null)).toEqual([])
    expect(buildEscalationChips(chatWithSignals([], null))).toEqual([])
    expect(buildEscalationChips(chatWithSignals([sig({ kind: 'stuck' })], null))).toEqual([])
    expect(buildEscalationChips(chatWithParticipants([]))).toEqual([])
  })

  it('maps kind + recommendedAction to label/action/tone for the current round', () => {
    const chips = buildEscalationChips(
      chatWithSignals([
        sig({ id: 's1', kind: 'disagreement-unresolved', recommendedAction: 'call-synthesizer' })
      ])
    )
    expect(chips).toEqual([
      {
        id: 's1',
        label: 'Unreconciled answers',
        action: 'Add a synthesizer to reconcile the answers.',
        tone: 'info'
      }
    ])
  })

  it('marks failure-shaped signals as attention tone', () => {
    const chips = buildEscalationChips(
      chatWithSignals([
        sig({ id: 's1', kind: 'tool-error-cluster', recommendedAction: 'pause-for-user' })
      ])
    )
    expect(chips[0].tone).toBe('attention')
    expect(chips[0].label).toBe('Tool errors clustered')
  })

  it('only surfaces signals for the active round and de-dups by kind', () => {
    const chips = buildEscalationChips(
      chatWithSignals([
        sig({ id: 'old', kind: 'stuck', roundId: 'r0' }), // previous round — excluded
        sig({ id: 'a', kind: 'stuck' }),
        sig({ id: 'b', kind: 'stuck' }) // dup kind — collapsed
      ])
    )
    expect(chips).toHaveLength(1)
    expect(chips[0].id).toBe('a')
  })

  it('never frames panel size as waste — copy leans into the panel', () => {
    const chips = buildEscalationChips(
      chatWithSignals([
        sig({ id: '1', kind: 'disagreement-unresolved', recommendedAction: 'call-synthesizer' }),
        sig({ id: '2', kind: 'looping', recommendedAction: 'extend-rounds' })
      ])
    )
    const allCopy = chips.map((c) => `${c.label} ${c.action}`).join(' ')
    expect(allCopy.toLowerCase()).not.toMatch(/too many|waste|fewer seats|reduce/)
  })
})
