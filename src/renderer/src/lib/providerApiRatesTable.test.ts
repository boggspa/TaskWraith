import { describe, expect, it } from 'vitest'
import { buildProviderApiRateGroups } from './providerApiRatesTable'
import { BAKED_IN_RATES, RATE_TABLE_VERSION } from '../../../main/services/ProviderRateService'
import type { ProviderId } from '../../../main/store/types'
import { isRetiredProvider } from '../../../shared/retiredProviders'
import { getEnsembleModelDefaults } from './ensembleProviderDefaults'
import { MODEL_USAGE_PROVIDER_ORDER } from './modelUsageTable'
import { normalizeProviderRates, resolveModelRate } from './providerRateEstimate'

describe('buildProviderApiRateGroups', () => {
  it('preserves provider/model rate provenance from the raw snapshot', () => {
    const groups = buildProviderApiRateGroups({
      rateTableVersion: '2026-06-23',
      baseline: {
        codex: {
          provider: 'codex',
          pricingUrl: 'https://openai.com/api/pricing',
          models: [
            {
              modelId: 'gpt-5.5',
              inputUsdPerMillion: 5,
              cachedInputUsdPerMillion: 0.5,
              outputUsdPerMillion: 30,
              sourceUrl: 'https://openai.com/api/pricing',
              lastVerified: '2026-06-23',
              notes: 'Codex CLI projection.'
            }
          ]
        }
      },
      probe: {
        runAt: '2026-06-23T10:00:00.000Z',
        results: {
          codex: {
            provider: 'codex',
            pricingUrl: 'https://openai.com/api/pricing',
            models: [
              {
                modelId: 'gpt-5.5',
                status: 'verified',
                baseline: {
                  inputUsdPerMillion: 5,
                  outputUsdPerMillion: 30,
                  confidence: 'baked-in'
                }
              }
            ]
          }
        }
      }
    })

    expect(groups).toHaveLength(1)
    expect(groups[0].rateTableVersion).toBe('2026-06-23')
    expect(groups[0].rows[0]).toMatchObject({
      provider: 'codex',
      modelId: 'gpt-5.5',
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
      sourceUrl: 'https://openai.com/api/pricing',
      lastVerified: '2026-06-23',
      notes: 'Codex CLI projection.',
      confidence: 'baked-in',
      status: 'verified'
    })
  })

  it('marks manual overrides and stale probe baselines distinctly', () => {
    const groups = buildProviderApiRateGroups({
      rateTableVersion: '2026-06-23',
      baseline: {
        kimi: {
          provider: 'kimi',
          pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code',
          models: [
            {
              modelId: 'kimi-k2.7-code',
              inputUsdPerMillion: 0.95,
              cachedInputUsdPerMillion: 0.19,
              outputUsdPerMillion: 4,
              sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k27-code',
              lastVerified: '2026-06-23',
              confidence: 'manual-override'
            },
            {
              modelId: 'kimi-k2.6',
              inputUsdPerMillion: 0.95,
              outputUsdPerMillion: 4,
              sourceUrl: 'https://platform.kimi.ai/docs/pricing/chat-k26',
              lastVerified: '2026-06-23'
            }
          ]
        }
      },
      probe: {
        runAt: '2026-06-23T10:00:00.000Z',
        results: {
          kimi: {
            provider: 'kimi',
            pricingUrl: 'https://platform.kimi.ai/docs/pricing/chat',
            models: [
              {
                modelId: 'kimi-k2.6',
                status: 'verified',
                baseline: {
                  inputUsdPerMillion: 0.6,
                  outputUsdPerMillion: 2.5,
                  confidence: 'baked-in'
                }
              }
            ]
          }
        }
      }
    })

    const [group] = groups
    expect(group.rows[0].status).toBe('manual-override')
    expect(group.rows[1].status).toBe('stale-probe')
  })

  it('ignores probe results that predate the current rate table', () => {
    const groups = buildProviderApiRateGroups({
      rateTableVersion: '2026-06-23',
      baseline: {
        codex: {
          provider: 'codex',
          pricingUrl: 'https://openai.com/api/pricing',
          models: [
            {
              modelId: 'gpt-5.5',
              inputUsdPerMillion: 5,
              cachedInputUsdPerMillion: 0.5,
              outputUsdPerMillion: 30,
              sourceUrl: 'https://openai.com/api/pricing',
              lastVerified: '2026-06-23'
            }
          ]
        }
      },
      probe: {
        runAt: '2026-06-22T10:00:00.000Z',
        results: {
          codex: {
            provider: 'codex',
            pricingUrl: 'https://openai.com/api/pricing',
            models: [
              {
                modelId: 'gpt-5.5',
                status: 'fetch-failed',
                baseline: {
                  inputUsdPerMillion: 5,
                  outputUsdPerMillion: 30,
                  confidence: 'baked-in'
                },
                errorMessage: 'Pricing page did not respond.'
              }
            ]
          }
        }
      }
    })

    expect(groups[0].rows[0].status).toBe('baseline')
    expect(groups[0].rows[0].statusMessage).toContain('predates this rate table')
  })

  it('omits local Ollama rows from the API rates list', () => {
    const groups = buildProviderApiRateGroups({
      rateTableVersion: '2026-06-23',
      baseline: {
        ollama: {
          provider: 'ollama',
          pricingUrl: 'local://ollama',
          models: [
            {
              modelId: 'qwen3:4b-instruct',
              inputUsdPerMillion: 0,
              outputUsdPerMillion: 0,
              sourceUrl: 'local://ollama',
              lastVerified: '2026-06-23'
            }
          ]
        }
      }
    })

    expect(groups).toEqual([])
  })

  it('keeps Gemini in the historical API rates roster', () => {
    const groups = buildProviderApiRateGroups({
      rateTableVersion: '2026-06-23',
      baseline: {
        gemini: {
          provider: 'gemini',
          pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
          models: [
            {
              modelId: 'gemini-3.1-pro',
              inputUsdPerMillion: 1.25,
              outputUsdPerMillion: 10,
              sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
              lastVerified: '2026-06-23'
            }
          ]
        }
      }
    })

    expect(groups[0].provider).toBe('gemini')
  })
})

/**
 * Catalogue-vs-rate-table coverage guard.
 *
 * The Settings → Model Usage tables are only as complete as the tables behind
 * them. A model the picker OFFERS but the rate table omits is invisible in
 * Provider/Model API Rates, and — worse — `resolveModelRate` silently prices it
 * off `models[0]`, so its projected cost is another model's. That is exactly
 * how `gemini-api:gemini-2.0-flash` shipped priced at 2.5 Flash rates.
 *
 * Retired providers are excluded: Gemini's catalogue holds selection aliases
 * (`pro`, `flash`) rather than wire ids, and nothing new can be dispatched to
 * it anyway.
 */
describe('offered-model rate coverage', () => {
  const PRICED_PROVIDERS: ProviderId[] = MODEL_USAGE_PROVIDER_ORDER.filter(
    (provider) => !isRetiredProvider(provider)
  ).concat('ollama')

  const rates = normalizeProviderRates({
    rateTableVersion: RATE_TABLE_VERSION,
    baseline: BAKED_IN_RATES
  })

  for (const provider of PRICED_PROVIDERS) {
    it(`prices every model the ${provider} picker offers with that model's own rate row`, () => {
      const offered = getEnsembleModelDefaults(provider)
        .modelOptions.map((option) => option.id)
        .filter((id) => id !== 'auto')
      expect(offered.length).toBeGreaterThan(0)

      const unpriced = offered.filter((modelId) => {
        const resolved = resolveModelRate(rates, provider, modelId)
        return resolved?.modelId.toLowerCase() !== modelId.toLowerCase()
      })
      expect(unpriced).toEqual([])
    })
  }
})
