import { describe, expect, it } from 'vitest'
import { buildProviderApiRateGroups } from './providerApiRatesTable'

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
        runAt: '2026-06-22T10:00:00.000Z',
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
