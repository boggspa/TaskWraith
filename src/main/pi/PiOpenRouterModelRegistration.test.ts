import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PI_OPENROUTER_CUSTOM_MODELS,
  writePiOpenRouterModelRegistration
} from './PiOpenRouterModelRegistration'
import { PI_OPENROUTER_ALLOWED_MODEL_IDS } from './PiModelPolicy'
import { findPiStaticModel } from './PiModels'
import { resolvePiUpstreamBrand } from '../../shared/piBrandTable'

const temporaryHomes: string[] = []

function isolatedHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-pi-openrouter-model-'))
  temporaryHomes.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('writePiOpenRouterModelRegistration', () => {
  it('keeps registration exactly in step with the OpenRouter policy exception', () => {
    expect(PI_OPENROUTER_CUSTOM_MODELS.map((model) => model.modelId)).toEqual(
      PI_OPENROUTER_ALLOWED_MODEL_IDS
    )
  })

  it('registers the four 2026-08-30 free routes with verified metadata', () => {
    const additions = Object.fromEntries(
      PI_OPENROUTER_CUSTOM_MODELS.slice(-4).map((model) => [model.modelId, model])
    )
    expect(additions).toEqual({
      'cohere/north-mini-code:free': {
        modelId: 'cohere/north-mini-code:free',
        label: 'North Mini Code',
        reasoning: true,
        reasoningControl: 'toggle',
        input: ['text'],
        contextWindow: 256_000,
        maxTokens: 64_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      },
      'minimax/minimax-m3:free': {
        modelId: 'minimax/minimax-m3:free',
        label: 'MiniMax M3',
        reasoning: true,
        reasoningControl: 'toggle',
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 943_718,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      },
      'thinkingmachines/inkling:free': {
        modelId: 'thinkingmachines/inkling:free',
        label: 'Inkling',
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: null,
          max: 'max'
        },
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 262_144,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      },
      'thinkingmachines/inkling-small:free': {
        modelId: 'thinkingmachines/inkling-small:free',
        label: 'Inkling Small',
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: null,
          max: 'max'
        },
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 262_144,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    })
  })

  it('preserves GLM 5.2 Extra High while keeping unsupported extended stops hidden', () => {
    expect(
      PI_OPENROUTER_CUSTOM_MODELS.find((model) => model.modelId === 'z-ai/glm-5.2')
        ?.thinkingLevelMap
    ).toEqual({ xhigh: 'xhigh' })
    for (const modelId of [
      'thinkingmachines/inkling:free',
      'thinkingmachines/inkling-small:free'
    ]) {
      expect(
        PI_OPENROUTER_CUSTOM_MODELS.find((model) => model.modelId === modelId)?.thinkingLevelMap
          ?.xhigh,
        modelId
      ).toBeNull()
    }
    for (const modelId of ['cohere/north-mini-code:free', 'minimax/minimax-m3:free']) {
      expect(
        PI_OPENROUTER_CUSTOM_MODELS.find((model) => model.modelId === modelId)?.thinkingLevelMap,
        modelId
      ).toBeUndefined()
    }
  })

  it('keeps the OpenRouter model registrations in lockstep with picker metadata', () => {
    for (const model of PI_OPENROUTER_CUSTOM_MODELS) {
      expect(findPiStaticModel(`openrouter/${model.modelId}`)).toMatchObject({
        modelId: model.modelId,
        label: model.label,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        thinking: model.reasoning,
        images: model.input.includes('image')
      })
    }
  })

  it('maps OpenRouter resold models to their original provider brands', () => {
    // Test that Zai, Poolside, and NVIDIA models get their original branding
    expect(resolvePiUpstreamBrand('openrouter/z-ai/glm-5.2')?.label).toBe('Z.ai')
    expect(resolvePiUpstreamBrand('openrouter/z-ai/glm-5.2')?.hueClass).toBe('zai')
    expect(resolvePiUpstreamBrand('openrouter/poolside/laguna-s-2.1')?.label).toBe('Poolside')
    expect(resolvePiUpstreamBrand('openrouter/poolside/laguna-s-2.1')?.hueClass).toBe('poolside')
    expect(resolvePiUpstreamBrand('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')?.label).toBe('NVIDIA')
    expect(resolvePiUpstreamBrand('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free')?.hueClass).toBe('nvidia')
  })

  it.each(PI_OPENROUTER_CUSTOM_MODELS)('registers only $modelId in Pi’s isolated home', (model) => {
    const home = isolatedHome()

    expect(
      writePiOpenRouterModelRegistration({ isolatedHomeDir: home, modelId: model.modelId })
    ).toBe(true)

    expect(JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))).toEqual({
      providers: {
        openrouter: {
          models: [
            {
              id: model.modelId,
              name: model.label,
              api: 'openai-completions',
              reasoning: model.reasoning,
              ...(model.thinkingLevelMap
                ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
                : {}),
              input: [...model.input],
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              cost: model.cost,
              compat: {
                supportsDeveloperRole: false,
                ...(model.reasoningControl === 'toggle'
                  ? { supportsReasoningEffort: false }
                  : {}),
                thinkingFormat: model.reasoningControl === 'toggle' ? 'together' : 'openrouter'
              }
            }
          ]
        }
      }
    })
    if (process.platform !== 'win32') {
      expect(statSync(join(home, 'models.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('serializes toggle-only OpenRouter routes without a fake effort parameter', () => {
    for (const modelId of [
      'poolside/laguna-s-2.1',
      'cohere/north-mini-code:free',
      'minimax/minimax-m3:free'
    ]) {
      const home = isolatedHome()
      writePiOpenRouterModelRegistration({ isolatedHomeDir: home, modelId })
      const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
      expect(config.providers.openrouter.models[0].compat, modelId).toEqual({
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        thinkingFormat: 'together'
      })
    }
  })

  it('leaves Pi’s home untouched for every model outside the curated exception', () => {
    const home = isolatedHome()

    expect(
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'anthropic/claude-opus-5'
      })
    ).toBe(false)
    expect(() => statSync(join(home, 'models.json'))).toThrow()
  })

  it('does not recreate retired Ox Alpha in a new Pi home', () => {
    const home = isolatedHome()

    expect(
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'stealth/ox-alpha'
      })
    ).toBe(false)
    expect(() => statSync(join(home, 'models.json'))).toThrow()
  })

  it('refuses to overwrite another per-run Pi configuration', () => {
    const home = isolatedHome()
    writeFileSync(join(home, 'models.json'), '{}', { mode: 0o600 })

    expect(() =>
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'z-ai/glm-5.2'
      })
    ).toThrow()
    expect(readFileSync(join(home, 'models.json'), 'utf8')).toBe('{}')
  })
})
