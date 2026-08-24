import { describe, expect, it } from 'vitest'
import {
  ULTRATASK_REQUIRED_STAGES,
  isConcreteUltraTaskModelId,
  listUltraTaskModelOptions,
  resolveUltraTaskCapability,
  type UltraTaskModelCapabilityCandidate,
  type UltraTaskRouteCandidate
} from './UltraTaskCapabilityResolver'

function model(
  overrides: Partial<UltraTaskModelCapabilityCandidate> = {}
): UltraTaskModelCapabilityCandidate {
  return {
    provider: 'codex',
    modelId: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    ultraTaskSupported: true,
    runtimeAvailability: 'available',
    reasoning: { mode: 'configurable', ceiling: 'ultracode' },
    source: 'live',
    ...overrides
  }
}

function route(overrides: Partial<UltraTaskRouteCandidate> = {}): UltraTaskRouteCandidate {
  return {
    id: 'ultratask-graph-v1',
    kind: 'execution_graph',
    availability: 'available',
    priority: 0,
    stages: ULTRATASK_REQUIRED_STAGES,
    ...overrides
  }
}

describe('resolveUltraTaskCapability', () => {
  it('binds one exact concrete model to one complete staged route', () => {
    expect(
      resolveUltraTaskCapability({
        provider: 'codex',
        modelId: 'gpt-5.6-terra',
        models: [model()],
        routes: [route()]
      })
    ).toEqual({
      ok: true,
      capability: {
        schemaVersion: 1,
        provider: 'codex',
        modelId: 'gpt-5.6-terra',
        modelLabel: 'GPT-5.6-Terra',
        modelSource: 'live',
        reasoning: { mode: 'configurable', ceiling: 'ultracode' },
        route: {
          id: 'ultratask-graph-v1',
          kind: 'execution_graph',
          stages: [...ULTRATASK_REQUIRED_STAGES]
        }
      }
    })
  })

  it.each([undefined, null, '', ' ', 'cli-default', 'default', 'custom'])(
    'refuses the model sentinel %j and returns concrete choices',
    (modelId) => {
      const result = resolveUltraTaskCapability({
        provider: 'codex',
        modelId,
        models: [
          model(),
          model({ modelId: 'cli-default', label: 'CLI Default' }),
          model({ provider: 'claude', modelId: 'claude-sonnet-5', label: 'Sonnet 5' })
        ],
        routes: [route()]
      })
      expect(result).toMatchObject({
        ok: false,
        code: 'model_required',
        models: [{ modelId: 'gpt-5.6-terra' }]
      })
    }
  )

  it('uses exact catalog identity and never accepts a prefix lookalike', () => {
    const result = resolveUltraTaskCapability({
      provider: 'codex',
      modelId: 'gpt-5.6-terra-forged',
      models: [model()],
      routes: [route()]
    })
    expect(result).toMatchObject({ ok: false, code: 'model_unknown' })
  })

  it('fails closed on duplicate exact catalog identities', () => {
    const result = resolveUltraTaskCapability({
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      models: [model(), model({ label: 'Duplicate Terra' })],
      routes: [route()]
    })
    expect(result).toMatchObject({ ok: false, code: 'model_ambiguous' })
  })

  it.each([
    [model({ ultraTaskSupported: false }), 'model_unsupported'],
    [
      model({
        runtimeAvailability: 'unavailable',
        runtimeUnavailableReason: 'Model access is disabled.'
      }),
      'model_unavailable'
    ],
    [model({ runtimeAvailability: 'unknown' }), 'model_runtime_unknown'],
    [model({ reasoning: { mode: 'configurable' } }), 'invalid_reasoning_capability'],
    [model({ reasoning: { mode: 'fixed' } }), 'invalid_reasoning_capability']
  ] as const)('rejects invalid model capability: %s', (candidate, code) => {
    const result = resolveUltraTaskCapability({
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      models: [candidate],
      routes: [route()]
    })
    expect(result).toMatchObject({ ok: false, code })
  })

  it('accepts an explicitly supported live model with no reasoning axis', () => {
    const result = resolveUltraTaskCapability({
      provider: 'cursor',
      modelId: 'composer-2.5',
      models: [
        model({
          provider: 'cursor',
          modelId: 'composer-2.5',
          label: 'Composer 2.5',
          reasoning: { mode: 'none' }
        })
      ],
      routes: [route({ kind: 'taskwraith_delegation' })]
    })
    expect(result).toMatchObject({
      ok: true,
      capability: {
        provider: 'cursor',
        modelId: 'composer-2.5',
        reasoning: { mode: 'none' }
      }
    })
  })

  it('preserves an explicitly fixed reasoning ceiling', () => {
    const result = resolveUltraTaskCapability({
      provider: 'kimi',
      modelId: 'kimi-k2.7-code',
      models: [
        model({
          provider: 'kimi',
          modelId: 'kimi-k2.7-code',
          label: 'K2.7 Coding',
          reasoning: { mode: 'fixed', ceiling: 'on', supported: ['on'] }
        })
      ],
      routes: [route({ kind: 'taskwraith_delegation' })]
    })
    expect(result).toMatchObject({
      ok: true,
      capability: {
        provider: 'kimi',
        modelId: 'kimi-k2.7-code',
        reasoning: { mode: 'fixed', ceiling: 'on', supported: ['on'] }
      }
    })
  })

  it('rejects a parallel-only route and names every missing staged capability', () => {
    const result = resolveUltraTaskCapability({
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      models: [model()],
      routes: [
        route({
          id: 'legacy-wave',
          kind: 'taskwraith_delegation',
          stages: ['scout', 'join', 'worker']
        })
      ]
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'route_incomplete',
      route: {
        id: 'legacy-wave',
        missingStages: ['worker_artifact', 'reviewer_after_worker', 'synthesis']
      }
    })
  })

  it.each([
    ['unknown', 'route_runtime_unknown'],
    ['unavailable', 'route_unavailable']
  ] as const)('fails closed when the route is %s', (availability, code) => {
    const result = resolveUltraTaskCapability({
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      models: [model()],
      routes: [route({ availability, unavailableReason: 'Route is not ready.' })]
    })
    expect(result).toMatchObject({ ok: false, code })
  })

  it('selects the highest-priority complete route without changing the model', () => {
    const result = resolveUltraTaskCapability({
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      models: [model()],
      routes: [
        route({ id: 'native', kind: 'provider_native', priority: 20 }),
        route({ id: 'graph', kind: 'execution_graph', priority: 0 }),
        route({ id: 'wave', kind: 'taskwraith_delegation', priority: 10 })
      ]
    })
    expect(result).toMatchObject({
      ok: true,
      capability: { modelId: 'gpt-5.6-terra', route: { id: 'graph' } }
    })
  })
})

describe('UltraTask model option affordance', () => {
  it('lists only concrete models for the requested provider', () => {
    expect(
      listUltraTaskModelOptions('codex', [
        model({ modelId: 'cli-default', label: 'CLI Default' }),
        model({ modelId: 'gpt-5.6-sol', label: 'Sol' }),
        model({ provider: 'claude', modelId: 'claude-opus-5', label: 'Opus' })
      ]).map((entry) => entry.modelId)
    ).toEqual(['gpt-5.6-sol'])
  })

  it('recognizes only non-sentinel model ids as concrete', () => {
    expect(isConcreteUltraTaskModelId('gpt-5.6-sol')).toBe(true)
    expect(isConcreteUltraTaskModelId(' cli-default ')).toBe(false)
    expect(isConcreteUltraTaskModelId('custom')).toBe(false)
  })
})
