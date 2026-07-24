import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../../main/store/types'
import {
  API_SPEND_WINDOW_MS,
  buildApiSpendByProvider,
  buildProviderCalendarMonthSpend,
  type ApiSpendCurrencyOptions
} from './apiSpendAggregation'
import { getFxRatesPerUsd, setFxRatesPerUsd } from './formatCost'
import type { RendererProviderRates } from './providerRateEstimate'

// Fixed reference clock so every window boundary is exact.
const NOW = new Date('2026-06-13T12:00:00.000Z').getTime()

// $1/M in, $10/M out — round numbers make the cost assertions obvious.
const RATES: RendererProviderRates = {
  codex: [{ modelId: 'gpt-5.5', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }],
  claude: [{ modelId: 'opus', inputUsdPerMillion: 5, outputUsdPerMillion: 25 }],
  // Cursor ships no public rate — records still aggregate tokens but
  // project zero cost (matches `estimateRunCostUsd` returning 0).
  cursor: [{ modelId: 'composer-2.5-fast', inputUsdPerMillion: 3, outputUsdPerMillion: 15 }]
}

function makeRecord(overrides: Partial<UsageRecord> & { timestamp: number }): UsageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    workspaceId: 'ws-1',
    chatId: 'chat-1',
    runId: 'run-1',
    model: 'gpt-5.5',
    provider: 'codex',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  } as UsageRecord
}

/** Always force USD so the conversion tests don't depend on the
 * module-level FX map a prior test may have hot-swapped. */
const USD: ApiSpendCurrencyOptions = { currency: 'USD' }

describe('buildApiSpendByProvider — empty / zero', () => {
  it('returns an empty array for no records', () => {
    expect(buildApiSpendByProvider([], RATES, USD, NOW)).toEqual([])
  })

  it('omits ollama from the token/cost roster (handled via RAM aggregation)', () => {
    const records = [makeRecord({ provider: 'ollama', timestamp: NOW - 1000, inputTokens: 1000 })]
    expect(buildApiSpendByProvider(records, RATES, USD, NOW)).toEqual([])
  })

  it('includes grok token runs in the priced roster', () => {
    const rates: RendererProviderRates = {
      ...RATES,
      grok: [{ modelId: 'grok-build', inputUsdPerMillion: 2, outputUsdPerMillion: 10 }]
    }
    const records = [
      makeRecord({
        provider: 'grok',
        model: 'grok-build',
        timestamp: NOW - 1000,
        inputTokens: 1_000_000,
        outputTokens: 0
      })
    ]
    const [grok] = buildApiSpendByProvider(records, rates, USD, NOW)
    expect(grok.provider).toBe('grok')
    expect(grok.day.totalTokens).toBe(1_000_000)
    expect(grok.day.costUsd).toBeCloseTo(2, 5)
  })

  it('skips reset_hint records entirely', () => {
    const records = [
      makeRecord({ timestamp: NOW - 1000, inputTokens: 5000, usageKind: 'reset_hint' })
    ]
    expect(buildApiSpendByProvider(records, RATES, USD, NOW)).toEqual([])
  })

  it('projects Cursor spend via the Composer 2.5 Fast proxy rate', () => {
    const records = [
      makeRecord({
        provider: 'cursor',
        model: 'composer-2.5-fast',
        timestamp: NOW - 1000,
        inputTokens: 10_000,
        outputTokens: 5_000
      })
    ]
    const [cursor] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(cursor.provider).toBe('cursor')
    expect(cursor.day.totalTokens).toBe(15_000)
    expect(cursor.day.costUsd).toBeCloseTo(0.105, 6)
    expect(cursor.day.costDisplay).toBe('$0.11')
  })
})

describe('buildApiSpendByProvider — window bucketing at exact boundaries', () => {
  it('counts a record exactly at the 24h boundary in all three windows (inclusive)', () => {
    const records = [
      makeRecord({ timestamp: NOW - API_SPEND_WINDOW_MS.day, inputTokens: 1_000_000 })
    ]
    const [codex] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(codex.day.runs).toBe(1)
    expect(codex.week.runs).toBe(1)
    expect(codex.month.runs).toBe(1)
  })

  it('drops a record one ms older than the 24h boundary from the day window only', () => {
    const records = [
      makeRecord({ timestamp: NOW - API_SPEND_WINDOW_MS.day - 1, inputTokens: 1_000_000 })
    ]
    const [codex] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(codex.day.runs).toBe(0)
    expect(codex.day.totalTokens).toBe(0)
    expect(codex.week.runs).toBe(1)
    expect(codex.month.runs).toBe(1)
  })

  it('counts a record exactly at the 7d boundary in week + month but not day', () => {
    const records = [
      makeRecord({ timestamp: NOW - API_SPEND_WINDOW_MS.week, inputTokens: 2_000_000 })
    ]
    const [codex] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(codex.day.runs).toBe(0)
    expect(codex.week.runs).toBe(1)
    expect(codex.month.runs).toBe(1)
  })

  it('counts a record exactly at the 30d boundary in month only', () => {
    const records = [
      makeRecord({ timestamp: NOW - API_SPEND_WINDOW_MS.month, inputTokens: 3_000_000 })
    ]
    const [codex] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(codex.day.runs).toBe(0)
    expect(codex.week.runs).toBe(0)
    expect(codex.month.runs).toBe(1)
    expect(codex.month.tokensIn).toBe(3_000_000)
  })

  it('drops a record one ms older than the 30d boundary from every window', () => {
    const records = [
      makeRecord({ timestamp: NOW - API_SPEND_WINDOW_MS.month - 1, inputTokens: 9_000_000 })
    ]
    // Provider has no in-window activity → omitted entirely.
    expect(buildApiSpendByProvider(records, RATES, USD, NOW)).toEqual([])
  })

  it('drops future-dated (clock-skew) records', () => {
    const records = [makeRecord({ timestamp: NOW + 60_000, inputTokens: 1_000_000 })]
    expect(buildApiSpendByProvider(records, RATES, USD, NOW)).toEqual([])
  })
})

describe('buildApiSpendByProvider — cost math', () => {
  it('prices input + output tokens via the rate table and sums per window', () => {
    // 2,000,000 in * $1/M = $2 ; 500,000 out * $10/M = $5 ; total $7.
    const records = [
      makeRecord({ timestamp: NOW - 1000, inputTokens: 2_000_000, outputTokens: 500_000 })
    ]
    const [codex] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(codex.day.costUsd).toBeCloseTo(7, 6)
    expect(codex.day.tokensIn).toBe(2_000_000)
    expect(codex.day.tokensOut).toBe(500_000)
    expect(codex.day.totalTokens).toBe(2_500_000)
    expect(codex.day.costDisplay).toBe('$7.00')
  })

  it('sums multiple records into the right windows independently', () => {
    const records = [
      // inside 24h: $1 (1M in)
      makeRecord({ timestamp: NOW - ONE_HOUR(2), inputTokens: 1_000_000 }),
      // 3 days ago: $2 (2M in) — week + month, not day
      makeRecord({ timestamp: NOW - ONE_DAY(3), inputTokens: 2_000_000 }),
      // 10 days ago: $4 (4M in) — month only
      makeRecord({ timestamp: NOW - ONE_DAY(10), inputTokens: 4_000_000 })
    ]
    const [codex] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(codex.day.costUsd).toBeCloseTo(1, 6)
    expect(codex.week.costUsd).toBeCloseTo(3, 6) // $1 + $2
    expect(codex.month.costUsd).toBeCloseTo(7, 6) // $1 + $2 + $4
    expect(codex.day.runs).toBe(1)
    expect(codex.week.runs).toBe(2)
    expect(codex.month.runs).toBe(3)
  })

  it('prefers an explicit cost over the rate estimate when a record carries one', () => {
    const record = makeRecord({ timestamp: NOW - 1000, inputTokens: 1_000_000 })
    // Inject an explicit cost the way a provider might in the future.
    ;(record as unknown as Record<string, unknown>).explicitCostUsd = 42
    const [codex] = buildApiSpendByProvider([record], RATES, USD, NOW)
    // 42 (explicit) wins over the $1 the rate table would project.
    expect(codex.day.costUsd).toBe(42)
  })

  it('treats negative / NaN token counts as zero', () => {
    const records = [
      makeRecord({ timestamp: NOW - 1000, inputTokens: -5 as number, outputTokens: NaN as number })
    ]
    const [codex] = buildApiSpendByProvider(records, RATES, USD, NOW)
    expect(codex.day.tokensIn).toBe(0)
    expect(codex.day.tokensOut).toBe(0)
    expect(codex.day.costUsd).toBe(0)
  })
})

describe('buildApiSpendByProvider — currency conversion + overestimate', () => {
  it('converts USD to the display currency at the FX rate', () => {
    // Pin GBP to a known rate so the assertion is deterministic.
    const before = getFxRatesPerUsd()
    setFxRatesPerUsd({ GBP: 0.8 })
    try {
      const records = [makeRecord({ timestamp: NOW - 1000, inputTokens: 10_000_000 })] // $10
      const [codex] = buildApiSpendByProvider(records, RATES, { currency: 'GBP' }, NOW)
      expect(codex.day.costUsd).toBeCloseTo(10, 6) // raw stays USD
      expect(codex.day.costDisplay).toBe('£8.00') // 10 * 0.8
    } finally {
      setFxRatesPerUsd(before)
    }
  })

  it('applies the overestimate multiplier before FX conversion', () => {
    const before = getFxRatesPerUsd()
    setFxRatesPerUsd({ EUR: 1 }) // unity FX so we isolate the bias
    try {
      const records = [makeRecord({ timestamp: NOW - 1000, inputTokens: 10_000_000 })] // $10
      const [codex] = buildApiSpendByProvider(
        records,
        RATES,
        { currency: 'EUR', overestimatePercent: 20 },
        NOW
      )
      // raw costUsd is unbiased; only the display string carries the +20%.
      expect(codex.day.costUsd).toBeCloseTo(10, 6)
      expect(codex.day.costDisplay).toBe('€12.00') // 10 * 1.20 * 1.0
    } finally {
      setFxRatesPerUsd(before)
    }
  })

  it('clamps an out-of-range overestimate to the 25% cap', () => {
    const before = getFxRatesPerUsd()
    setFxRatesPerUsd({ USD: 1 })
    try {
      const records = [makeRecord({ timestamp: NOW - 1000, inputTokens: 10_000_000 })] // $10
      const [codex] = buildApiSpendByProvider(
        records,
        RATES,
        { currency: 'USD', overestimatePercent: 999 },
        NOW
      )
      // 999% clamps to 25% → $12.50.
      expect(codex.day.costDisplay).toBe('$12.50')
    } finally {
      setFxRatesPerUsd(before)
    }
  })
})

describe('buildApiSpendByProvider — multiple providers', () => {
  it('returns one entry per active provider in canonical order', () => {
    const records = [
      // Claude: 1M out * $25/M = $25
      makeRecord({
        provider: 'claude',
        model: 'opus',
        timestamp: NOW - ONE_HOUR(1),
        outputTokens: 1_000_000
      }),
      // Codex: 1M in * $1/M = $1
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - ONE_HOUR(1),
        inputTokens: 1_000_000
      })
    ]
    const result = buildApiSpendByProvider(records, RATES, USD, NOW)
    // Canonical order is gemini, codex, claude, kimi, cursor → codex before claude.
    expect(result.map((r) => r.provider)).toEqual(['codex', 'claude'])
    const codex = result.find((r) => r.provider === 'codex')!
    const claude = result.find((r) => r.provider === 'claude')!
    expect(codex.day.costUsd).toBeCloseTo(1, 6)
    expect(claude.day.costUsd).toBeCloseTo(25, 6)
    expect(claude.day.tokensOut).toBe(1_000_000)
  })

  it('keeps each provider window independent', () => {
    const records = [
      makeRecord({
        provider: 'codex',
        model: 'gpt-5.5',
        timestamp: NOW - ONE_DAY(2),
        inputTokens: 1_000_000
      }),
      makeRecord({
        provider: 'claude',
        model: 'opus',
        timestamp: NOW - ONE_HOUR(1),
        outputTokens: 200_000
      })
    ]
    const result = buildApiSpendByProvider(records, RATES, USD, NOW)
    const codex = result.find((r) => r.provider === 'codex')!
    const claude = result.find((r) => r.provider === 'claude')!
    // Codex run is 2 days old → week/month only.
    expect(codex.day.runs).toBe(0)
    expect(codex.week.runs).toBe(1)
    // Claude run is fresh → all three.
    expect(claude.day.runs).toBe(1)
    expect(claude.day.costUsd).toBeCloseTo(5, 6) // 200k out * $25/M
  })
})

// Small readable helpers for relative timestamps.
function ONE_HOUR(n: number): number {
  return n * 60 * 60 * 1000
}
function ONE_DAY(n: number): number {
  return n * 24 * 60 * 60 * 1000
}

describe('antigravity in the spend roster', () => {
  it('prices key-lane records via gemini-api rate rows', () => {
    const rates: RendererProviderRates = {
      antigravity: [
        {
          modelId: 'gemini-api:gemini-2.5-flash',
          inputUsdPerMillion: 0.3,
          outputUsdPerMillion: 2.5
        }
      ]
    }
    const records = [
      makeRecord({
        provider: 'antigravity',
        model: 'gemini-api:gemini-2.5-flash',
        timestamp: NOW - ONE_HOUR(1),
        inputTokens: 1_000_000,
        outputTokens: 1_000_000
      })
    ]
    const result = buildApiSpendByProvider(records, rates, USD, NOW)
    const antigravity = result.find((r) => r.provider === 'antigravity')!
    expect(antigravity.day.runs).toBe(1)
    expect(antigravity.day.costUsd).toBeCloseTo(2.8, 6) // $0.30 in + $2.50 out
  })
})

describe('buildProviderCalendarMonthSpend — budget meter', () => {
  const rates: RendererProviderRates = {
    antigravity: [
      { modelId: 'gemini-api:gemini-2.5-flash', inputUsdPerMillion: 1, outputUsdPerMillion: 10 }
    ]
  }
  const inMonth = (overrides: Partial<UsageRecord> = {}): UsageRecord =>
    makeRecord({
      provider: 'antigravity',
      model: 'gemini-api:gemini-2.5-flash',
      timestamp: NOW - ONE_HOUR(1),
      inputTokens: 1_000_000, // $1 at the test rate
      ...overrides
    })

  it('counts calendar month-to-date, not the rolling 30-day window', () => {
    // NOW is 13 June — a record from 30 May is inside the rolling 30d window
    // but OUTSIDE the calendar month, so the meter must exclude it.
    const lastMonth = inMonth({ timestamp: new Date('2026-05-30T12:00:00.000Z').getTime() })
    const meter = buildProviderCalendarMonthSpend(
      [inMonth(), lastMonth],
      rates,
      'antigravity',
      20,
      USD,
      NOW
    )
    expect(meter.runs).toBe(1)
    expect(meter.spentUsd).toBeCloseTo(1, 6)
    expect(meter.capUsd).toBe(20)
    expect(meter.fraction).toBeCloseTo(1 / 20, 6)
    expect(meter.resetLabel).toContain('1')
    expect(meter.resetLabel.toLowerCase()).toContain('jul')
  })

  it('clamps the fraction at 1 when spend exceeds the cap and treats bad caps as uncapped', () => {
    const over = buildProviderCalendarMonthSpend(
      [inMonth(), inMonth(), inMonth()],
      rates,
      'antigravity',
      2,
      USD,
      NOW
    )
    expect(over.fraction).toBe(1)

    for (const cap of [null, undefined, 0, -5, Number.NaN]) {
      const meter = buildProviderCalendarMonthSpend(
        [inMonth()],
        rates,
        'antigravity',
        cap,
        USD,
        NOW
      )
      expect(meter.capUsd).toBeNull()
      expect(meter.fraction).toBe(0)
      expect(meter.capDisplay).toBe('')
    }
  })

  it('ignores other providers, reset hints, and future-dated records', () => {
    const meter = buildProviderCalendarMonthSpend(
      [
        inMonth({ provider: 'codex', model: 'gpt-5.5' }),
        inMonth({ usageKind: 'reset_hint' }),
        inMonth({ timestamp: NOW + ONE_HOUR(1) })
      ],
      rates,
      'antigravity',
      20,
      USD,
      NOW
    )
    expect(meter.runs).toBe(0)
    expect(meter.spentUsd).toBe(0)
  })
})
