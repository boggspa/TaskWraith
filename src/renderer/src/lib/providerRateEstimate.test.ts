import { describe, expect, it } from 'vitest'
import {
  estimateRunCostUsd,
  estimateUsageRecordCostUsd,
  normalizeProviderRates,
  resolveModelRate,
  usageRecordInputTokens,
  type RendererProviderRates
} from './providerRateEstimate'

const RATES: RendererProviderRates = {
  codex: [
    { modelId: 'gpt-5.5', inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.0 },
    { modelId: 'gpt-5.4-mini', inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.0 }
  ],
  cursor: [
    { modelId: 'composer-2.5-fast', inputUsdPerMillion: 3.0, outputUsdPerMillion: 15.0 },
    { modelId: 'composer-2.5', inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5 }
  ]
}

describe('normalizeProviderRates', () => {
  it('unwraps the ProviderRatesSnapshot baseline envelope', () => {
    const snapshot = {
      rateTableVersion: '2026-05-29',
      baseline: {
        codex: {
          provider: 'codex',
          pricingUrl: 'https://example',
          models: [
            {
              modelId: 'gpt-5.5',
              inputUsdPerMillion: 1.25,
              outputUsdPerMillion: 10.0,
              cachedInputUsdPerMillion: 0.125,
              sourceUrl: 'x',
              lastVerified: '2026-05-29'
            }
          ]
        },
        cursor: {
          provider: 'cursor',
          pricingUrl: 'https://cursor.com/docs/models/cursor-composer-2-5',
          models: [
            {
              modelId: 'composer-2.5-fast',
              inputUsdPerMillion: 3,
              outputUsdPerMillion: 15,
              sourceUrl: 'https://cursor.com/docs/models/cursor-composer-2-5',
              lastVerified: '2026-05-29'
            },
            {
              modelId: 'composer-2.5',
              inputUsdPerMillion: 0.5,
              outputUsdPerMillion: 2.5,
              sourceUrl: 'https://cursor.com/changelog/composer-2-5',
              lastVerified: '2026-05-29'
            }
          ]
        }
      }
    }
    const out = normalizeProviderRates(snapshot)
    expect(out.codex).toEqual([
      {
        modelId: 'gpt-5.5',
        inputUsdPerMillion: 1.25,
        outputUsdPerMillion: 10.0,
        cachedInputUsdPerMillion: 0.125
      }
    ])
    // Empty model lists are dropped entirely.
    expect(out.cursor).toEqual([
      { modelId: 'composer-2.5-fast', inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
      { modelId: 'composer-2.5', inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5 }
    ])
  })

  it('accepts an already-unwrapped table map', () => {
    const out = normalizeProviderRates({
      grok: { models: [{ modelId: 'grok-build', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }] }
    })
    expect(out.grok).toEqual([
      { modelId: 'grok-build', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }
    ])
  })

  it('returns {} for malformed / missing input and skips invalid entries', () => {
    expect(normalizeProviderRates(null)).toEqual({})
    expect(normalizeProviderRates('nope')).toEqual({})
    expect(normalizeProviderRates(undefined)).toEqual({})
    // entry missing a numeric rate is skipped, leaving the provider absent
    expect(
      normalizeProviderRates({
        codex: { models: [{ modelId: 'x', inputUsdPerMillion: 'bad', outputUsdPerMillion: 1 }] }
      })
    ).toEqual({})
  })
})

describe('resolveModelRate', () => {
  it('matches exactly, then by prefix, then falls back to the first model', () => {
    expect(resolveModelRate(RATES, 'codex', 'gpt-5.5')?.modelId).toBe('gpt-5.5')
    // dated suffix resolves to the base entry via prefix match
    expect(resolveModelRate(RATES, 'codex', 'gpt-5.5-2026-06-01')?.modelId).toBe('gpt-5.5')
    // unknown model on a known provider falls back to first listed
    expect(resolveModelRate(RATES, 'codex', 'totally-unknown')?.modelId).toBe('gpt-5.5')
  })

  it('returns null for unknown provider or empty rate list', () => {
    expect(resolveModelRate(RATES, undefined, 'gpt-5.5')).toBeNull()
    expect(resolveModelRate(RATES, 'gemini', 'gemini-3.1-pro')).toBeNull()
  })

  it('resolves Cursor models against the Composer 2.5 Fast proxy rate', () => {
    expect(resolveModelRate(RATES, 'cursor', 'composer-2.5-fast')?.modelId).toBe(
      'composer-2.5-fast'
    )
    expect(resolveModelRate(RATES, 'cursor', 'composer-2.5')?.modelId).toBe('composer-2.5')
  })
})

describe('estimateRunCostUsd', () => {
  it('projects input+output tokens at the per-million rate', () => {
    // 1,000,000 in * $1.25/M + 500,000 out * $10/M = 1.25 + 5.00 = 6.25
    const usd = estimateRunCostUsd(RATES, 'codex', 'gpt-5.5', 1_000_000, 500_000)
    expect(usd).toBeCloseTo(6.25, 6)
  })

  it('uses the resolved (prefix/fallback) model rate', () => {
    // unknown model → falls back to gpt-5.5 rate
    const usd = estimateRunCostUsd(RATES, 'codex', 'mystery', 100_000, 0)
    expect(usd).toBeCloseTo(0.125, 6)
  })

  it('projects exact Cursor Composer 2.5 rows via the standard rate', () => {
    // 10k in * $0.50/M + 5k out * $2.50/M = 0.005 + 0.0125 = 0.0175
    expect(
      estimateRunCostUsd(RATES, 'cursor', 'composer-2.5', 10_000, 5_000)
    ).toBeCloseTo(0.0175, 6)
  })

  it('returns 0 when provider/model cannot be resolved', () => {
    expect(estimateRunCostUsd(RATES, undefined, 'x', 100_000, 100_000)).toBe(0)
  })

  it('returns 0 when there are no tokens', () => {
    expect(estimateRunCostUsd(RATES, 'codex', 'gpt-5.5', 0, 0)).toBe(0)
  })

  it('treats non-finite token counts as zero', () => {
    expect(estimateRunCostUsd(RATES, 'codex', 'gpt-5.5', NaN, NaN)).toBe(0)
    // one valid count still estimates
    expect(estimateRunCostUsd(RATES, 'codex', 'gpt-5.5', 1_000_000, NaN)).toBeCloseTo(1.25, 6)
  })

  it('prices cache reads at the cached input rate when the input count already includes cache', () => {
    const rates: RendererProviderRates = {
      claude: [
        {
          modelId: 'claude-opus-4-7',
          inputUsdPerMillion: 5,
          outputUsdPerMillion: 25,
          cachedInputUsdPerMillion: 0.5
        }
      ]
    }
    const usd = estimateRunCostUsd(
      rates,
      'claude',
      'claude-opus-4-7',
      5_000_000,
      0,
      {
        cacheReadInputTokens: 4_000_000,
        inputIncludesCache: true
      }
    )
    // 1M normal input * $5/M + 4M cache read * $0.5/M = $7.
    expect(usd).toBeCloseTo(7, 6)
  })
})

const CLAUDE_RATES: RendererProviderRates = {
  claude: [
    {
      modelId: 'claude-opus-4-7',
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      cachedInputUsdPerMillion: 0.5
    }
  ]
}

describe('usageRecordInputTokens', () => {
  it('sums cache reads and creation when a breakdown is present', () => {
    expect(
      usageRecordInputTokens({
        provider: 'claude',
        model: 'claude-opus-4-7',
        inputTokens: 11,
        outputTokens: 5,
        cacheReadInputTokens: 3
      })
    ).toBe(14)
  })

  it('returns base inputTokens for legacy combined rows', () => {
    expect(
      usageRecordInputTokens({
        provider: 'claude',
        model: 'claude-opus-4-7',
        inputTokens: 14,
        outputTokens: 5
      })
    ).toBe(14)
  })
})

describe('estimateUsageRecordCostUsd', () => {
  it('prices cache reads at the cached input rate', () => {
    const usd = estimateUsageRecordCostUsd(CLAUDE_RATES, {
      provider: 'claude',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadInputTokens: 4_000_000
    })
    // 1M * $5/M + 4M * $0.5/M = 7
    expect(usd).toBeCloseTo(7, 6)
  })

  it('keeps legacy combined input rows on the standard input rate', () => {
    const usd = estimateUsageRecordCostUsd(CLAUDE_RATES, {
      provider: 'claude',
      model: 'claude-opus-4-7',
      inputTokens: 5_000_000,
      outputTokens: 0
    })
    expect(usd).toBeCloseTo(25, 6)
  })
})
