import { describe, expect, it } from 'vitest'
import {
  estimateRunCostUsd,
  estimateUsageRecordCostUsd,
  isKnownLocalOllamaModel,
  normalizeProviderRates,
  resolveModelRate,
  usageRecordInputTokens,
  usageRecordTotalTokens,
  type RendererProviderRates
} from './providerRateEstimate'

const RATES: RendererProviderRates = {
  codex: [
    { modelId: 'gpt-5.5', inputUsdPerMillion: 1.25, outputUsdPerMillion: 10.0 },
    { modelId: 'gpt-5.4-mini', inputUsdPerMillion: 0.25, outputUsdPerMillion: 2.0 }
  ],
  cursor: [
    { modelId: 'composer-2.5-fast', inputUsdPerMillion: 3.0, outputUsdPerMillion: 15.0 },
    { modelId: 'composer-2.5', inputUsdPerMillion: 0.5, outputUsdPerMillion: 2.5 },
    {
      modelId: 'grok-4.6',
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 6,
      cachedInputUsdPerMillion: 0.5
    },
    {
      modelId: 'grok-4.6-fast',
      inputUsdPerMillion: 4,
      outputUsdPerMillion: 12,
      cachedInputUsdPerMillion: 1
    }
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
              longContextThresholdTokens: 200_000,
              longContextInputUsdPerMillion: 2.5,
              longContextOutputUsdPerMillion: 20,
              longContextCachedInputUsdPerMillion: 0.25,
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
        cachedInputUsdPerMillion: 0.125,
        longContextThresholdTokens: 200_000,
        longContextInputUsdPerMillion: 2.5,
        longContextOutputUsdPerMillion: 20,
        longContextCachedInputUsdPerMillion: 0.25
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

  it('drops an incomplete long-context tier without dropping the base rate', () => {
    const out = normalizeProviderRates({
      grok: {
        models: [
          {
            modelId: 'grok-4.6',
            inputUsdPerMillion: 2,
            outputUsdPerMillion: 6,
            cachedInputUsdPerMillion: 0.5,
            longContextThresholdTokens: 200_000,
            longContextInputUsdPerMillion: 4
          }
        ]
      }
    })
    expect(out.grok).toEqual([
      {
        modelId: 'grok-4.6',
        inputUsdPerMillion: 2,
        outputUsdPerMillion: 6,
        cachedInputUsdPerMillion: 0.5
      }
    ])
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

  it('resolves default sentinels before falling back to the first rate entry', () => {
    const rates: RendererProviderRates = {
      claude: [
        { modelId: 'claude-fable-5', inputUsdPerMillion: 10, outputUsdPerMillion: 50 },
        { modelId: 'claude-sonnet-5', inputUsdPerMillion: 3, outputUsdPerMillion: 15 }
      ],
      gemini: [
        { modelId: 'gemini-3.1-pro', inputUsdPerMillion: 2, outputUsdPerMillion: 12 },
        { modelId: 'gemini-3.1-flash-lite', inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 }
      ]
    }

    expect(resolveModelRate(rates, 'claude', 'cli-default')?.modelId).toBe('claude-sonnet-5')
    expect(resolveModelRate(rates, 'claude', undefined)?.modelId).toBe('claude-sonnet-5')
    expect(resolveModelRate(rates, 'gemini', 'flash-lite')?.modelId).toBe(
      'gemini-3.1-flash-lite'
    )
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

  it('keeps Cursor Grok 4.6 standard and Fast wire ids on distinct rate rows', () => {
    expect(resolveModelRate(RATES, 'cursor', 'cursor-grok-4.6-low')?.modelId).toBe('grok-4.6')
    expect(resolveModelRate(RATES, 'cursor', 'cursor-grok-4.6-xhigh')?.modelId).toBe('grok-4.6')
    expect(resolveModelRate(RATES, 'cursor', 'cursor-grok-4.6-low-fast')?.modelId).toBe(
      'grok-4.6-fast'
    )
    expect(resolveModelRate(RATES, 'cursor', 'cursor-grok-4.6-xhigh-fast')?.modelId).toBe(
      'grok-4.6-fast'
    )
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

  it('switches all Grok 4.6 tokens to long-context rates at 200k prompt tokens', () => {
    const rates: RendererProviderRates = {
      grok: [
        {
          modelId: 'grok-4.6',
          inputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.5,
          outputUsdPerMillion: 6,
          longContextThresholdTokens: 200_000,
          longContextInputUsdPerMillion: 4,
          longContextCachedInputUsdPerMillion: 1,
          longContextOutputUsdPerMillion: 12
        }
      ]
    }

    // 99,999 fresh + 50k cached + 50k cache creation = 199,999 prompt tokens.
    expect(
      estimateRunCostUsd(rates, 'grok', 'grok-4.6', 99_999, 1_000_000, {
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 50_000
      })
    ).toBeCloseTo(6.324998, 6)

    // At 200k the long tier applies to fresh input, cached input, cache creation, and output.
    expect(
      estimateRunCostUsd(rates, 'grok', 'grok-4.6', 100_000, 1_000_000, {
        cacheReadInputTokens: 50_000,
        cacheCreationInputTokens: 50_000
      })
    ).toBeCloseTo(12.65, 6)

    // Output tokens do not contribute to the prompt threshold.
    expect(estimateRunCostUsd(rates, 'grok', 'grok-4.6', 0, 1_000_000)).toBeCloseTo(6, 6)
  })

  it('projects Cursor Grok 4.6 Fast against its permanently higher rate row', () => {
    expect(
      estimateRunCostUsd(RATES, 'cursor', 'cursor-grok-4.6-high', 1_000_000, 1_000_000)
    ).toBeCloseTo(8, 6)
    expect(
      estimateRunCostUsd(RATES, 'cursor', 'cursor-grok-4.6-high-fast', 1_000_000, 1_000_000)
    ).toBeCloseTo(16, 6)
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

describe('usageRecordTotalTokens', () => {
  it('prefers a persisted total when one is available', () => {
    expect(
      usageRecordTotalTokens({
        provider: 'claude',
        model: 'claude-opus-4-7',
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 20,
        cacheReadInputTokens: 3
      })
    ).toBe(20)
  })

  it('reconstructs a cache-inclusive total for partially-populated rows', () => {
    expect(
      usageRecordTotalTokens({
        provider: 'claude',
        model: 'claude-opus-4-7',
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 0,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2
      })
    ).toBe(21)
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

  it('uses a distinct cost-rate model without changing the persisted display model', () => {
    const rates: RendererProviderRates = {
      kimi: [
        { modelId: 'kimi-k2.7-code', inputUsdPerMillion: 0.95, outputUsdPerMillion: 4 },
        {
          modelId: 'kimi-k2.7-code-highspeed',
          inputUsdPerMillion: 1.9,
          outputUsdPerMillion: 8
        }
      ]
    }
    const usd = estimateUsageRecordCostUsd(rates, {
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      costRateModel: 'kimi-k2.7-code-highspeed',
      inputTokens: 1_000_000,
      outputTokens: 500_000
    })

    expect(usd).toBeCloseTo(5.9, 6)
  })
})

describe('isKnownLocalOllamaModel', () => {
  const rates: RendererProviderRates = {
    ollama: [
      { modelId: 'qwen3:4b-instruct', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      { modelId: 'gemma4:12b', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      { modelId: 'nemotron3:33b', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    ],
    gemini: [
      { modelId: 'gemini-3.1-pro-preview', inputUsdPerMillion: 2, outputUsdPerMillion: 12 }
    ]
  }

  it('recognises Gemma and Nemotron local tags without falling back to table[0]', () => {
    expect(isKnownLocalOllamaModel(rates, 'gemma4:12b')).toBe(true)
    expect(isKnownLocalOllamaModel(rates, 'gemma4:12b-it-q4_K_M')).toBe(true)
    expect(isKnownLocalOllamaModel(rates, 'nemotron3:33b')).toBe(true)
  })

  it('does not treat cloud Gemini models as local Ollama', () => {
    expect(isKnownLocalOllamaModel(rates, 'gemini-3.1-pro-preview')).toBe(false)
    expect(isKnownLocalOllamaModel(rates, 'gpt-5.5')).toBe(false)
    expect(isKnownLocalOllamaModel(rates, undefined)).toBe(false)
  })

  it('does not treat shorter cloud ids as local via reverse prefix', () => {
    const withDevstral: RendererProviderRates = {
      ...rates,
      ollama: [
        ...(rates.ollama || []),
        { modelId: 'devstral-small-2:24b', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
      ]
    }
    expect(isKnownLocalOllamaModel(withDevstral, 'devstral-small')).toBe(false)
  })
})

// Ollama's rate table is entirely local models at $0 with a
// `pricingUrl: 'local://ollama'` note. ollama.com CLOUD models are a paid
// service and have no rows at all, so every one of them used to resolve to a
// free local row - either through `table[0]` or through the reverse prefix
// match - and TaskWraith reported real spend as $0.
describe('ollama cloud models never inherit a local free rate', () => {
  const rates: RendererProviderRates = {
    ollama: [
      { modelId: 'qwen3:4b-instruct', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      { modelId: 'devstral-small-2:24b', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }
    ]
  }

  it('returns no rate for an unpriced cloud model instead of table[0]', () => {
    expect(resolveModelRate(rates, 'ollama', 'glm-5.3:cloud')).toBeNull()
    expect(resolveModelRate(rates, 'ollama', 'qwen3-coder:480b-cloud')).toBeNull()
  })

  // The hazard isKnownLocalOllamaModel already documents, still live here: a
  // shorter cloud id reverse-prefix-matching a longer local row.
  it('does not reverse-prefix a cloud id onto a longer local row', () => {
    expect(resolveModelRate(rates, 'ollama', 'devstral-small-cloud')).toBeNull()
  })

  it('leaves the cost blank rather than reporting a misleading zero', () => {
    expect(estimateRunCostUsd(rates, 'ollama', 'glm-5.3:cloud', 1_000_000, 500_000)).toBe(0)
    // Callers treat <= 0 as "render nothing". The local control still resolves.
    expect(resolveModelRate(rates, 'ollama', 'qwen3:4b-instruct')?.modelId).toBe(
      'qwen3:4b-instruct'
    )
  })

  // Once real cloud rows are added they must price normally, including a tag
  // that extends a cloud row.
  it('prices a cloud model once its own row exists', () => {
    const priced: RendererProviderRates = {
      ollama: [
        ...(rates.ollama || []),
        { modelId: 'glm-5.3:cloud', inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.2 }
      ]
    }
    expect(resolveModelRate(priced, 'ollama', 'glm-5.3:cloud')?.inputUsdPerMillion).toBe(0.6)
    expect(estimateRunCostUsd(priced, 'ollama', 'glm-5.3:cloud', 1_000_000, 0)).toBeCloseTo(0.6, 6)
  })

  it('leaves local model resolution untouched', () => {
    expect(resolveModelRate(rates, 'ollama', 'devstral-small-2:24b')?.modelId).toBe(
      'devstral-small-2:24b'
    )
    expect(resolveModelRate(rates, 'ollama', 'gemma4:12b')?.modelId).toBe('qwen3:4b-instruct')
  })
})

describe('resolveModelRate gemma mis-tag trap', () => {
  it('falls through to Gemini table[0] for gemma tags (documents the live £ bug)', () => {
    const rates: RendererProviderRates = {
      gemini: [
        { modelId: 'gemini-3.1-pro-preview', inputUsdPerMillion: 2, outputUsdPerMillion: 12 },
        { modelId: 'gemini-3.1-flash-lite', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 }
      ]
    }
    expect(resolveModelRate(rates, 'gemini', 'gemma4:12b')?.modelId).toBe('gemini-3.1-pro-preview')
    expect(estimateRunCostUsd(rates, 'gemini', 'gemma4:12b', 0, 40_000)).toBeGreaterThan(0)
  })
})
