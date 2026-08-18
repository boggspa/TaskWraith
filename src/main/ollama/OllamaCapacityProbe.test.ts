import { describe, expect, it } from 'vitest'
import {
  EMPTY_OLLAMA_RESIDENCY_OBSERVATION,
  estimateOllamaCapacity,
  fetchOllamaLoadedModels,
  observeOllamaResidency,
  parseOllamaLoadedModels,
  readDeclaredOllamaModelCeiling
} from './OllamaCapacityProbe'

describe('readDeclaredOllamaModelCeiling', () => {
  it('reads a positive declared ceiling', () => {
    expect(readDeclaredOllamaModelCeiling({ OLLAMA_MAX_LOADED_MODELS: '2' })).toBe(2)
  })

  it('treats 0 as "ollama decides", not as a ceiling of zero', () => {
    expect(readDeclaredOllamaModelCeiling({ OLLAMA_MAX_LOADED_MODELS: '0' })).toBeUndefined()
  })

  it('has no opinion when the variable is absent, blank or junk', () => {
    expect(readDeclaredOllamaModelCeiling({})).toBeUndefined()
    expect(readDeclaredOllamaModelCeiling({ OLLAMA_MAX_LOADED_MODELS: '   ' })).toBeUndefined()
    expect(readDeclaredOllamaModelCeiling({ OLLAMA_MAX_LOADED_MODELS: 'lots' })).toBeUndefined()
    expect(readDeclaredOllamaModelCeiling({ OLLAMA_MAX_LOADED_MODELS: '-3' })).toBeUndefined()
  })
})

describe('parseOllamaLoadedModels', () => {
  it('reads the /api/ps shape', () => {
    const models = parseOllamaLoadedModels({
      models: [
        { model: 'qwen3:30b', size_vram: 21_000_000_000, expires_at: '2026-08-18T15:00:00Z' },
        { model: 'granite4:32b', size_vram: 18_000_000_000 }
      ]
    })
    expect(models).toEqual([
      { model: 'qwen3:30b', sizeVramBytes: 21_000_000_000, expiresAt: '2026-08-18T15:00:00Z' },
      { model: 'granite4:32b', sizeVramBytes: 18_000_000_000 }
    ])
  })

  it('returns an empty list for an idle server or a junk payload', () => {
    expect(parseOllamaLoadedModels({ models: [] })).toEqual([])
    expect(parseOllamaLoadedModels(null)).toEqual([])
    expect(parseOllamaLoadedModels({ models: 'nope' })).toEqual([])
    expect(parseOllamaLoadedModels({ models: [null, { model: '' }, { model: 'ok' }] })).toEqual([
      { model: 'ok' }
    ])
  })
})

describe('fetchOllamaLoadedModels', () => {
  it('reports residency from a reachable server', async () => {
    const result = await fetchOllamaLoadedModels({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ models: [{ model: 'qwen3:30b' }] }), {
          status: 200
        })) as unknown as typeof fetch
    })
    expect(result.reachable).toBe(true)
    expect(result.models).toEqual([{ model: 'qwen3:30b' }])
  })

  it('fails soft when ollama is unreachable rather than throwing', async () => {
    const result = await fetchOllamaLoadedModels({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch
    })
    expect(result.reachable).toBe(false)
    expect(result.models).toEqual([])
  })

  it('fails soft on a non-200', async () => {
    const result = await fetchOllamaLoadedModels({
      baseUrl: 'http://127.0.0.1:11434',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    })
    expect(result.reachable).toBe(false)
    expect(result.models).toEqual([])
  })
})

describe('observeOllamaResidency', () => {
  it('keeps the high-water mark and never lowers it', () => {
    let observation = EMPTY_OLLAMA_RESIDENCY_OBSERVATION
    observation = observeOllamaResidency(observation, 1)
    observation = observeOllamaResidency(observation, 4)
    observation = observeOllamaResidency(observation, 2)
    expect(observation.observedHighWater).toBe(4)
    expect(observation.samples).toBe(3)
  })
})

describe('estimateOllamaCapacity', () => {
  it('has NO opinion with no declaration and no evidence — the unconstrained host stays unconstrained', () => {
    const estimate = estimateOllamaCapacity({
      declaredCeiling: undefined,
      observation: EMPTY_OLLAMA_RESIDENCY_OBSERVATION,
      reachable: true
    })
    expect(estimate.ceiling).toBeUndefined()
    expect(estimate.source).toBe('unknown')
  })

  it('stays unbounded with no declaration however much residency it has seen', () => {
    const estimate = estimateOllamaCapacity({
      declaredCeiling: undefined,
      observation: { observedHighWater: 12, samples: 40 },
      reachable: true
    })
    expect(estimate.ceiling).toBeUndefined()
    expect(estimate.source).toBe('unknown')
    expect(estimate.floor).toBe(12)
  })

  it('adopts a declared ceiling', () => {
    const estimate = estimateOllamaCapacity({
      declaredCeiling: 2,
      observation: EMPTY_OLLAMA_RESIDENCY_OBSERVATION,
      reachable: true
    })
    expect(estimate.ceiling).toBe(2)
    expect(estimate.source).toBe('declared')
  })

  it('lets measured residency WIDEN a stale declaration, never narrow it', () => {
    const estimate = estimateOllamaCapacity({
      declaredCeiling: 2,
      observation: { observedHighWater: 5, samples: 9 },
      reachable: true
    })
    expect(estimate.ceiling).toBe(5)
    expect(estimate.floor).toBe(5)
    expect(estimate.source).toBe('observed')
  })

  it('never invents a ceiling from an unreachable probe', () => {
    const estimate = estimateOllamaCapacity({
      declaredCeiling: 2,
      observation: EMPTY_OLLAMA_RESIDENCY_OBSERVATION,
      reachable: false
    })
    expect(estimate.ceiling).toBeUndefined()
    expect(estimate.source).toBe('unknown')
  })
})
