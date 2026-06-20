import { describe, expect, it } from 'vitest'

import {
  applyManualProviderRateOverrides,
  BAKED_IN_RATES,
  findDollarRateNearTokenPhrase,
  getCurrentProviderRates,
  parsePersistedProviderRateProbe,
  shouldRefreshProviderRateProbe,
  RATE_TABLE_VERSION
} from './ProviderRateService'

/**
 * 1.0.5-EW38 — Tests for the pure helpers + the baseline shape.
 *
 * The probe orchestrator (`probeAllProviderRates`,
 * `probeOneProvider`) hits the real network so it's deliberately
 * NOT exercised here; its behaviour is verified manually in dev.
 * The helpers it depends on (`findDollarRateNearTokenPhrase`) are
 * fully testable and bear the regex weight.
 */

describe('findDollarRateNearTokenPhrase', () => {
  it('matches a clean "$15.00 / 1M tokens" pattern', () => {
    const out = findDollarRateNearTokenPhrase('Opus rate: $15.00 / 1M tokens (output)', 15)
    expect(out).not.toBeNull()
    expect(out).toContain('$15')
  })

  it('matches "$3.00 per 1M tokens"', () => {
    const out = findDollarRateNearTokenPhrase('Sonnet input is $3.00 per 1M tokens', 3)
    expect(out).not.toBeNull()
  })

  it('matches "$0.25/M tokens"', () => {
    const out = findDollarRateNearTokenPhrase('Mini tier: $0.25/M tokens input', 0.25)
    expect(out).not.toBeNull()
    expect(out).toContain('$0.25')
  })

  it('matches the integer form without decimals', () => {
    const out = findDollarRateNearTokenPhrase('Pricing: $5 / 1M tokens output', 5)
    expect(out).not.toBeNull()
  })

  it('matches even when the price has no decimal in the page text', () => {
    const out = findDollarRateNearTokenPhrase('Cost is $10 per 1M tokens', 10)
    expect(out).not.toBeNull()
  })

  it('returns null when the dollar value is present but not near a token phrase', () => {
    // Same page, but the $15 is in an unrelated sentence about
    // monthly subscription cost.
    const out = findDollarRateNearTokenPhrase(
      'Subscription costs $15 monthly. Pricing for tokens is in the API docs.',
      15
    )
    expect(out).toBeNull()
  })

  it('returns null when the dollar amount differs', () => {
    const out = findDollarRateNearTokenPhrase('Opus is $15.00 per 1M tokens', 3)
    expect(out).toBeNull()
  })

  it('matches commas in the million-token phrasing', () => {
    const out = findDollarRateNearTokenPhrase('$2.50 / 1,000,000 tokens', 2.5)
    expect(out).not.toBeNull()
  })

  it('matches "million tokens" spelled out', () => {
    const out = findDollarRateNearTokenPhrase('$0.50 per million tokens', 0.5)
    expect(out).not.toBeNull()
  })

  it('returns null for empty input', () => {
    expect(findDollarRateNearTokenPhrase('', 5)).toBeNull()
    expect(findDollarRateNearTokenPhrase('some text', 0)).toBeNull()
    expect(findDollarRateNearTokenPhrase('some text', -1)).toBeNull()
    expect(findDollarRateNearTokenPhrase('some text', Number.NaN)).toBeNull()
  })

  it('is case-insensitive for the token phrase', () => {
    const out = findDollarRateNearTokenPhrase('$1.25 / 1M TOKENS (input)', 1.25)
    expect(out).not.toBeNull()
  })
})

describe('BAKED_IN_RATES', () => {
  it('has an entry for every provider', () => {
    expect(BAKED_IN_RATES.codex).toBeDefined()
    expect(BAKED_IN_RATES.claude).toBeDefined()
    expect(BAKED_IN_RATES.gemini).toBeDefined()
    expect(BAKED_IN_RATES.kimi).toBeDefined()
    expect(BAKED_IN_RATES.cursor).toBeDefined()
    expect(BAKED_IN_RATES.ollama).toBeDefined()
  })

  it('every priced entry carries a pricingUrl + at least one model', () => {
    for (const table of Object.values(BAKED_IN_RATES)) {
      // Retained guard: a gated provider with no published rates may ship an
      // empty models list + empty pricingUrl (the empty-models signal also keeps
      // probeAllProviderRates from fetching). No provider does so today — Grok
      // now carries projected xAI API rates — but the invariant stays defensive.
      if (table.models.length === 0) {
        expect(table.pricingUrl).toBe('')
        continue
      }
      expect(table.pricingUrl).toMatch(/^(https?:\/\/|local:\/\/)/)
      expect(table.models.length).toBeGreaterThan(0)
    }
  })

  it('keeps Grok Composer priced as a Grok-provider projection, distinct from Cursor', () => {
    const grokComposer = BAKED_IN_RATES.grok.models.find(
      (model) => model.modelId === 'grok-composer-2.5-fast'
    )
    const cursorComposer = BAKED_IN_RATES.cursor.models.find(
      (model) => model.modelId === 'composer-2.5-fast'
    )

    expect(grokComposer).toMatchObject({
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15
    })
    expect(cursorComposer).toBeDefined()
  })

  it('every model entry has positive input/output rates + a sourceUrl', () => {
    for (const table of Object.values(BAKED_IN_RATES)) {
      for (const model of table.models) {
        expect(model.modelId).toBeTruthy()
        if (table.provider === 'ollama') {
          expect(model.inputUsdPerMillion).toBe(0)
          expect(model.outputUsdPerMillion).toBe(0)
        } else {
          expect(model.inputUsdPerMillion).toBeGreaterThan(0)
          expect(model.outputUsdPerMillion).toBeGreaterThan(0)
        }
        expect(model.sourceUrl).toMatch(/^(https?:\/\/|local:\/\/)/)
        expect(model.lastVerified).toBe(RATE_TABLE_VERSION)
      }
    }
  })

  it('output rates are >= input rates (typical industry pattern)', () => {
    // This is a soft invariant — most providers charge more for
    // output tokens. The test would only fail if a baked-in rate
    // got entered upside-down.
    for (const table of Object.values(BAKED_IN_RATES)) {
      for (const model of table.models) {
        expect(model.outputUsdPerMillion).toBeGreaterThanOrEqual(model.inputUsdPerMillion)
      }
    }
  })

  it('cached-input rates (when present) are < input rates', () => {
    for (const table of Object.values(BAKED_IN_RATES)) {
      for (const model of table.models) {
        if (model.cachedInputUsdPerMillion !== undefined) {
          expect(model.cachedInputUsdPerMillion).toBeLessThan(model.inputUsdPerMillion)
        }
      }
    }
  })

  it('has zero-cost local entries for curated Ollama tags', () => {
    expect(BAKED_IN_RATES.ollama.models.map((model) => model.modelId)).toEqual(
      expect.arrayContaining([
        'qwen3.6:35b',
        'minicpm-v4.5:8b',
        'granite4.1:3b',
        'granite4.1:30b',
        'nemotron3:33b'
      ])
    )
  })
})

describe('getCurrentProviderRates', () => {
  it('returns the baseline immediately (no probe required)', () => {
    const snapshot = getCurrentProviderRates()
    expect(snapshot.rateTableVersion).toBe(RATE_TABLE_VERSION)
    expect(snapshot.baseline).toBe(BAKED_IN_RATES)
  })

  it('does not require the probe to have run', () => {
    // If no probe has been triggered yet, `probe` is undefined.
    // Callers must treat baseline as authoritative regardless.
    const snapshot = getCurrentProviderRates()
    expect(snapshot.baseline.claude.models.length).toBeGreaterThan(0)
  })
})

describe('applyManualProviderRateOverrides', () => {
  it('applies valid manual overrides with an explicit confidence label', () => {
    const out = applyManualProviderRateOverrides(
      BAKED_IN_RATES,
      {
        overrides: [
          {
            provider: 'gemini',
            modelId: 'gemini-3.1-flash',
            inputUsdPerMillion: 0.31,
            outputUsdPerMillion: 2.55,
            cachedInputUsdPerMillion: 0.08,
            sourceUrl: 'https://example.com/pricing',
            lastVerified: '2026-05-31',
            notes: 'checked by release owner'
          }
        ]
      },
      '2026-05-31T12:00:00.000Z'
    )

    expect(out.summary.applied).toEqual([{ provider: 'gemini', modelId: 'gemini-3.1-flash' }])
    expect(out.summary.rejected).toEqual([])
    const model = out.baseline.gemini.models.find((entry) => entry.modelId === 'gemini-3.1-flash')
    expect(model?.inputUsdPerMillion).toBe(0.31)
    expect(model?.outputUsdPerMillion).toBe(2.55)
    expect(model?.cachedInputUsdPerMillion).toBe(0.08)
    expect(model?.sourceUrl).toBe('https://example.com/pricing')
    expect(model?.confidence).toBe('manual-override')
    expect(model?.notes).toContain('Manual override:')

    const bakedModel = BAKED_IN_RATES.gemini.models.find(
      (entry) => entry.modelId === 'gemini-3.1-flash'
    )
    expect(bakedModel?.inputUsdPerMillion).toBe(0.3)
    expect(bakedModel?.confidence).toBeUndefined()
  })

  it('rejects invalid manual rates without changing the baseline', () => {
    const out = applyManualProviderRateOverrides(
      BAKED_IN_RATES,
      [
        {
          provider: 'gemini',
          modelId: 'gemini-3.1-flash',
          inputUsdPerMillion: 100_000,
          outputUsdPerMillion: 2.55
        },
        {
          provider: 'claude',
          modelId: 'claude-sonnet-4-6',
          inputUsdPerMillion: 3,
          outputUsdPerMillion: 2
        },
        {
          provider: 'kimi',
          modelId: 'kimi-k2.6',
          inputUsdPerMillion: 0.6,
          outputUsdPerMillion: 2.5,
          cachedInputUsdPerMillion: 9
        }
      ],
      '2026-05-31T12:00:00.000Z'
    )

    expect(out.summary.applied).toEqual([])
    expect(out.summary.rejected.map((entry) => entry.reason)).toEqual([
      'invalid-rate',
      'output-below-input',
      'invalid-cached-input-rate'
    ])
    expect(out.baseline.gemini.models.find((entry) => entry.modelId === 'gemini-3.1-flash'))
      .toMatchObject({ inputUsdPerMillion: 0.3, outputUsdPerMillion: 2.5 })
  })
})

describe('shouldRefreshProviderRateProbe', () => {
  it('refreshes missing, malformed, or stale probes only', () => {
    const now = Date.parse('2026-05-31T12:00:00.000Z')

    expect(
      shouldRefreshProviderRateProbe({ rateTableVersion: RATE_TABLE_VERSION, baseline: BAKED_IN_RATES }, now)
    ).toBe(true)
    expect(
      shouldRefreshProviderRateProbe(
        {
          rateTableVersion: RATE_TABLE_VERSION,
          baseline: BAKED_IN_RATES,
          probe: { runAt: 'not-a-date', results: {} as never }
        },
        now
      )
    ).toBe(true)
    expect(
      shouldRefreshProviderRateProbe(
        {
          rateTableVersion: RATE_TABLE_VERSION,
          baseline: BAKED_IN_RATES,
          probe: { runAt: '2026-05-30T12:00:00.000Z', results: {} as never }
        },
        now
      )
    ).toBe(false)
    expect(
      shouldRefreshProviderRateProbe(
        {
          rateTableVersion: RATE_TABLE_VERSION,
          baseline: BAKED_IN_RATES,
          probe: { runAt: '2026-05-20T12:00:00.000Z', results: {} as never }
        },
        now
      )
    ).toBe(true)
  })
})

describe('parsePersistedProviderRateProbe', () => {
  it('keeps explicit confidence labels and defaults old cache entries to baked-in', () => {
    const parsed = parsePersistedProviderRateProbe(
      JSON.stringify({
        runAt: '2026-05-31T12:00:00.000Z',
        results: {
          gemini: {
            provider: 'gemini',
            pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
            fetchedAt: '2026-05-31T12:01:00.000Z',
            models: [
              {
                modelId: 'gemini-3.1-flash',
                status: 'verified',
                baseline: {
                  inputUsdPerMillion: 0.31,
                  outputUsdPerMillion: 2.55,
                  confidence: 'manual-override'
                },
                matchedDollarStrings: ['$0.31 / 1M tokens']
              },
              {
                modelId: 'gemini-3.1-pro',
                status: 'not-verified',
                baseline: {
                  inputUsdPerMillion: 1.25,
                  outputUsdPerMillion: 10
                }
              }
            ]
          }
        }
      })
    )

    expect(parsed?.results.gemini.models[0]?.baseline.confidence).toBe('manual-override')
    expect(parsed?.results.gemini.models[1]?.baseline.confidence).toBe('baked-in')
  })

  it('rejects malformed persisted probe data instead of trusting bad scrape output', () => {
    expect(parsePersistedProviderRateProbe('{')).toBeNull()
    expect(
      parsePersistedProviderRateProbe(
        JSON.stringify({
          runAt: '2026-05-31T12:00:00.000Z',
          results: {
            gemini: {
              provider: 'gemini',
              pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
              models: [
                {
                  modelId: 'gemini-3.1-flash',
                  status: 'verified',
                  baseline: {
                    inputUsdPerMillion: 0,
                    outputUsdPerMillion: 2.55,
                    confidence: 'manual-override'
                  }
                }
              ]
            }
          }
        })
      )
    ).toBeNull()
    expect(
      parsePersistedProviderRateProbe(
        JSON.stringify({
          runAt: '2026-05-31T12:00:00.000Z',
          results: {
            gemini: {
              provider: 'gemini',
              pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
              models: [
                {
                  modelId: 'gemini-3.1-flash',
                  status: 'verified',
                  baseline: {
                    inputUsdPerMillion: 0.31,
                    outputUsdPerMillion: 2.55,
                    confidence: 'scraped'
                  }
                }
              ]
            }
          }
        })
      )
    ).toBeNull()
    expect(
      parsePersistedProviderRateProbe(
        JSON.stringify({
          runAt: '2026-05-31T12:00:00.000Z',
          results: {
            unknown: {
              provider: 'unknown',
              pricingUrl: '',
              models: []
            }
          }
        })
      )
    ).toBeNull()
  })
})
