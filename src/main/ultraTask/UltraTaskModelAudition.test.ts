import { describe, expect, it } from 'vitest'
import {
  auditionUltraTaskModels,
  type UltraTaskAuditionCandidateInput
} from './UltraTaskModelAudition'
import { resolveUltraTaskQuotaBinding } from './UltraTaskQuotaBindings'

function candidate(
  provider: UltraTaskAuditionCandidateInput['provider'],
  modelId: string,
  overrides: Partial<UltraTaskAuditionCandidateInput> = {}
): UltraTaskAuditionCandidateInput {
  return {
    provider,
    modelId,
    label: modelId,
    configured: true,
    ultraTaskSupported: true,
    runtimeAvailability: 'available',
    routeAvailability: 'available',
    quotaBinding: resolveUltraTaskQuotaBinding(provider, modelId),
    ...overrides
  }
}

describe('auditionUltraTaskModels', () => {
  it('keeps an exhausted bespoke pool from nullifying eligible siblings', () => {
    const result = auditionUltraTaskModels({
      candidates: [candidate('codex', 'gpt-5.5'), candidate('codex', 'gpt-5.3-codex-spark')],
      quotaPools: [
        { id: 'codex:standard', provider: 'codex', state: 'exhausted', usedPercent: 100 },
        { id: 'codex:spark', provider: 'codex', state: 'available', usedPercent: 20 }
      ]
    })

    expect(result.candidates.find((row) => row.modelId === 'gpt-5.5')?.state).toBe('quota_limited')
    expect(result.candidates.find((row) => row.modelId === 'gpt-5.3-codex-spark')).toMatchObject({
      state: 'eligible',
      quotaHeadroomPercent: 80
    })
    expect(result.providers).toEqual([
      {
        provider: 'codex',
        state: 'eligible',
        candidateCount: 2,
        eligibleCount: 1,
        recommendedModelId: 'gpt-5.3-codex-spark'
      }
    ])
  })

  it('treats stale exhaustion as unknown instead of fabricating an outage', () => {
    const result = auditionUltraTaskModels({
      candidates: [candidate('claude', 'claude-fable-5')],
      quotaPools: [
        {
          id: 'claude:fable',
          provider: 'claude',
          state: 'exhausted',
          usedPercent: 100,
          stale: true
        }
      ]
    })

    expect(result.candidates[0]).toMatchObject({ state: 'unknown', quotaEvidence: 'unknown' })
    expect(result.recommended).toBeUndefined()
  })

  it('treats local Ollama as unmetered while only Cloud consumes hosted quota', () => {
    const result = auditionUltraTaskModels({
      candidates: [candidate('ollama', 'qwen3.5:9b'), candidate('ollama', 'glm-5.2:cloud')],
      quotaPools: [{ id: 'ollama:cloud', provider: 'ollama', state: 'limited', usedPercent: 95 }]
    })

    expect(result.candidates.find((row) => row.modelId === 'qwen3.5:9b')).toMatchObject({
      state: 'eligible',
      quotaEvidence: 'not_applicable',
      priorityScore: 100
    })
    expect(result.candidates.find((row) => row.modelId === 'glm-5.2:cloud')?.state).toBe(
      'quota_limited'
    )
  })

  it('prefers a cheaper actual-API model when both fit a known budget', () => {
    const result = auditionUltraTaskModels({
      candidates: [
        candidate('antigravity', 'gemini-api:gemini-cheap', {
          quotaBinding: { kind: 'metered', poolIds: ['budget:cheap'], satisfaction: 'all' },
          rate: {
            billingBasis: 'actual_api',
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1
          }
        }),
        candidate('antigravity', 'gemini-api:gemini-costly', {
          quotaBinding: { kind: 'metered', poolIds: ['budget:costly'], satisfaction: 'all' },
          rate: {
            billingBasis: 'actual_api',
            inputUsdPerMillion: 4,
            outputUsdPerMillion: 6
          }
        })
      ],
      quotaPools: [
        {
          id: 'budget:cheap',
          provider: 'antigravity',
          state: 'available',
          usedPercent: 50,
          remainingUsd: 20
        },
        {
          id: 'budget:costly',
          provider: 'antigravity',
          state: 'available',
          usedPercent: 50,
          remainingUsd: 20
        }
      ],
      expectedInputTokens: 1_000_000,
      expectedOutputTokens: 1_000_000
    })

    expect(result.candidates.map((row) => row.modelId)).toEqual([
      'gemini-api:gemini-cheap',
      'gemini-api:gemini-costly'
    ])
    expect(result.candidates.map((row) => row.estimatedCostUsd)).toEqual([2, 10])
    expect(result.recommended?.modelId).toBe('gemini-api:gemini-cheap')
  })

  it('does not use projected API-equivalent prices as an automatic spending decision', () => {
    const result = auditionUltraTaskModels({
      candidates: [
        candidate('grok', 'z-cheap', {
          quotaBinding: { kind: 'metered', poolIds: ['grok:subscription'], satisfaction: 'all' },
          rate: {
            billingBasis: 'projected_api_equivalent',
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1
          }
        }),
        candidate('grok', 'a-expensive', {
          quotaBinding: { kind: 'metered', poolIds: ['grok:subscription'], satisfaction: 'all' },
          rate: {
            billingBasis: 'projected_api_equivalent',
            inputUsdPerMillion: 10,
            outputUsdPerMillion: 10
          }
        })
      ],
      quotaPools: [
        { id: 'grok:subscription', provider: 'grok', state: 'available', usedPercent: 50 }
      ],
      expectedInputTokens: 1_000_000,
      expectedOutputTokens: 1_000_000
    })

    expect(result.candidates.map((row) => row.modelId)).toEqual(['a-expensive', 'z-cheap'])
    expect(result.candidates.map((row) => row.estimatedCostUsd)).toEqual([20, 2])
  })

  it('supports any-pool bindings without borrowing unrelated provider quota', () => {
    const result = auditionUltraTaskModels({
      candidates: [
        candidate('claude', 'claude-sonnet-5', {
          quotaBinding: {
            kind: 'metered',
            poolIds: ['claude:team-a', 'claude:team-b'],
            satisfaction: 'any'
          }
        })
      ],
      quotaPools: [
        { id: 'claude:team-a', provider: 'claude', state: 'exhausted', usedPercent: 100 },
        { id: 'claude:team-b', provider: 'claude', state: 'available', usedPercent: 40 }
      ]
    })

    expect(result.candidates[0]).toMatchObject({
      state: 'eligible',
      quotaHeadroomPercent: 60
    })
  })

  it('reports actionable non-eligible states and never recommends them', () => {
    const result = auditionUltraTaskModels({
      candidates: [
        candidate('codex', 'gpt-unsupported', { ultraTaskSupported: false }),
        candidate('claude', 'claude-unconfigured', { configured: false }),
        candidate('grok', 'grok-offline', { routeAvailability: 'unavailable' }),
        candidate('mistral', 'mistral-unknown', { runtimeAvailability: 'unknown' }),
        candidate('codex', 'cli-default')
      ]
    })

    expect(result.candidates.map((row) => [row.modelId, row.state])).toEqual([
      ['mistral-unknown', 'unknown'],
      ['claude-unconfigured', 'unconfigured'],
      ['grok-offline', 'transport_unavailable'],
      ['gpt-unsupported', 'unsupported']
    ])
    expect(result.candidates.some((row) => row.modelId === 'cli-default')).toBe(false)
    expect(result.recommended).toBeUndefined()
  })

  it('rejects duplicate exact candidates rather than choosing arbitrarily', () => {
    const duplicate = candidate('codex', 'gpt-5.5')
    const result = auditionUltraTaskModels({ candidates: [duplicate, { ...duplicate }] })

    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.every((row) => row.state === 'unsupported')).toBe(true)
    expect(result.recommended).toBeUndefined()
  })
})
