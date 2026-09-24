import { describe, expect, it } from 'vitest'
import { ULTRATASK_REQUIRED_STAGES } from './UltraTaskCapabilityResolver'
import { buildUltraTaskOptions } from './UltraTaskOptionsService'

const graphRoute = {
  id: 'graph',
  kind: 'execution_graph' as const,
  availability: 'available' as const,
  priority: 0,
  stages: ULTRATASK_REQUIRED_STAGES
}

describe('buildUltraTaskOptions', () => {
  it('composes live capability, exact quota pools, and a concrete recommendation', () => {
    const result = buildUltraTaskOptions({
      providers: [
        {
          provider: 'codex',
          configured: true,
          source: 'live',
          models: [{ id: 'gpt-5.5' }, { id: 'gpt-5.3-codex-spark' }],
          fallbackModels: [
            {
              id: 'gpt-5.5',
              ultraTaskSupported: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }]
            },
            {
              id: 'gpt-5.3-codex-spark',
              ultraTaskSupported: true,
              supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }]
            }
          ],
          runtimeEvidence: {
            'gpt-5.5': { state: 'available' },
            'gpt-5.3-codex-spark': { state: 'available' }
          },
          routes: [graphRoute]
        }
      ],
      quotaPools: [
        { id: 'codex:standard', provider: 'codex', state: 'exhausted', usedPercent: 100 },
        { id: 'codex:spark', provider: 'codex', state: 'available', usedPercent: 15 }
      ]
    })

    expect(result).toMatchObject({
      schemaVersion: 1,
      truncated: false,
      recommended: { provider: 'codex', modelId: 'gpt-5.3-codex-spark' }
    })
    expect(result.candidates.map((candidate) => candidate.modelId)).toEqual([
      'gpt-5.3-codex-spark',
      'gpt-5.5'
    ])
  })

  it('does not treat an available partial route as executable orchestration', () => {
    const result = buildUltraTaskOptions({
      providers: [
        {
          provider: 'ollama',
          configured: true,
          source: 'static',
          models: [{ id: 'qwen3.5:9b', ultraTaskSupported: true }],
          runtimeEvidence: { 'qwen3.5:9b': { state: 'available' } },
          routes: [{ ...graphRoute, stages: ['scout', 'join'] }]
        }
      ]
    })

    expect(result.candidates[0]?.state).toBe('transport_unavailable')
    expect(result.recommended).toBeUndefined()
  })

  it('uses rates only on an exact provider/model join', () => {
    const result = buildUltraTaskOptions({
      providers: [
        {
          provider: 'antigravity',
          configured: true,
          source: 'live',
          models: [
            {
              id: 'gemini-api:gemini-3.6-flash',
              ultraTaskSupported: true
            }
          ],
          runtimeEvidence: {
            'gemini-api:gemini-3.6-flash': { state: 'available' }
          },
          routes: [graphRoute]
        }
      ],
      quotaPools: [
        {
          id: 'antigravity:gemini-api-budget',
          provider: 'antigravity',
          state: 'available',
          remainingUsd: 10
        }
      ],
      rates: [
        {
          provider: 'gemini',
          modelId: 'gemini-api:gemini-3.6-flash',
          billingBasis: 'actual_api',
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2
        }
      ],
      expectedInputTokens: 1_000_000,
      expectedOutputTokens: 1_000_000
    })

    expect(result.candidates[0]?.billingBasis).toBe('unknown')
    expect(result.candidates[0]?.estimatedCostUsd).toBeUndefined()
  })

  it('reports configured providers with no concrete models instead of inventing a default', () => {
    const result = buildUltraTaskOptions({
      providers: [
        {
          provider: 'mistral',
          configured: true,
          source: 'live',
          models: [{ id: 'cli-default', ultraTaskSupported: true }],
          routes: [graphRoute]
        }
      ]
    })

    expect(result.candidates).toEqual([])
    expect(result.providers).toEqual([
      {
        provider: 'mistral',
        state: 'unknown',
        candidateCount: 0,
        eligibleCount: 0
      }
    ])
    expect(result.recommended).toBeUndefined()
  })
})
