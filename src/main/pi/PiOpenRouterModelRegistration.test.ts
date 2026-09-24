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
import { PI_FULL_LADDER, resolvePiReasoningSupport } from '../../shared/piReasoning'

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
    // Selected by id, not by `slice(-4)`: a positional window silently
    // retargets itself onto whatever was appended last, so this fixture would
    // stop covering the routes it names as soon as newer models land after them.
    const addedOn20260830 = [
      'cohere/north-mini-code:free',
      'minimax/minimax-m3:free',
      'thinkingmachines/inkling:free',
      'thinkingmachines/inkling-small:free'
    ]
    const additions = Object.fromEntries(
      PI_OPENROUTER_CUSTOM_MODELS.filter((model) => addedOn20260830.includes(model.modelId)).map(
        (model) => [model.modelId, model]
      )
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
        label: 'M3 (OpenRouter)',
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

  it('registers the Sakana Fugu pair with verified metadata', () => {
    const tunableLadder = {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max'
    }
    const sakana = Object.fromEntries(
      PI_OPENROUTER_CUSTOM_MODELS.filter((model) => model.modelId.startsWith('sakana/')).map(
        (model) => [model.modelId, model]
      )
    )
    expect(sakana).toEqual({
      'sakana/fugu-max': {
        modelId: 'sakana/fugu-max',
        label: 'Fugu Max',
        reasoning: true,
        thinkingLevelMap: tunableLadder,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 0 }
      },
      'sakana/fugu-ultra-v2': {
        modelId: 'sakana/fugu-ultra-v2',
        label: 'Fugu Ultra v2',
        reasoning: true,
        thinkingLevelMap: tunableLadder,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        // BASE tier only. OpenRouter's `overrides` block raises this to
        // $10 / $45 / $1.00 once the PROMPT passes 272,000 tokens, which this
        // flat cost shape cannot express.
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
      }
    })
  })

  it('registers the three 2026-09-08 routes with verified metadata', () => {
    const tunableLadder = {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max'
    }
    const addedOn20260908 = [
      'inception/mercury-2.5',
      'nex-agi/nex-n2.5-mini:free',
      'nex-agi/nex-n2.5-pro:free'
    ]
    const additions = Object.fromEntries(
      PI_OPENROUTER_CUSTOM_MODELS.filter((model) => addedOn20260908.includes(model.modelId)).map(
        (model) => [model.modelId, model]
      )
    )
    expect(additions).toEqual({
      'inception/mercury-2.5': {
        modelId: 'inception/mercury-2.5',
        label: 'Mercury 2.5',
        reasoning: true,
        thinkingLevelMap: tunableLadder,
        input: ['text'],
        contextWindow: 260_000,
        maxTokens: 65_536,
        // The LIST rate, not the launch promotion — see the module comment.
        cost: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0 }
      },
      'nex-agi/nex-n2.5-mini:free': {
        modelId: 'nex-agi/nex-n2.5-mini:free',
        label: 'Nex-N2.5-Mini',
        reasoning: true,
        thinkingLevelMap: tunableLadder,
        input: ['text'],
        contextWindow: 262_144,
        maxTokens: 235_929,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      },
      'nex-agi/nex-n2.5-pro:free': {
        modelId: 'nex-agi/nex-n2.5-pro:free',
        label: 'Nex-N2.5-Pro',
        reasoning: true,
        thinkingLevelMap: tunableLadder,
        // Only the Pro route takes images; the Mini is text-only.
        input: ['text', 'image'],
        contextWindow: 262_144,
        maxTokens: 235_929,
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

  it('registers Union Alpha as a NON-reasoning route', () => {
    const entry = PI_OPENROUTER_CUSTOM_MODELS.find(
      (model) => model.modelId === 'stealth/union-alpha'
    )
    expect(entry).toEqual({
      modelId: 'stealth/union-alpha',
      label: 'Union Alpha',
      // The load-bearing field. This endpoint advertises max_tokens,
      // temperature, top_p, tools, tool_choice and response_format — and
      // neither `reasoning` nor `reasoning_effort`. Flipping this to true
      // writes a reasoning model into Pi's per-run models.json and puts a live
      // effort selector over a gateway that drops the field.
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 262_144,
      maxTokens: 131_072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
    expect(entry).not.toHaveProperty('thinkingLevelMap')
    expect(entry).not.toHaveProperty('reasoningControl')

    const home = isolatedHome()
    expect(
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'stealth/union-alpha'
      })
    ).toBe(true)
    const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    expect(config.providers.openrouter.models[0]).toMatchObject({
      id: 'stealth/union-alpha',
      name: 'Union Alpha',
      api: 'openai-completions',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 262_144,
      maxTokens: 131_072
    })
    expect(config.providers.openrouter.models[0]).not.toHaveProperty('thinkingLevelMap')
  })

  it('registers Pareto as a NON-reasoning paid route', () => {
    const entry = PI_OPENROUTER_CUSTOM_MODELS.find((model) => model.modelId === 'unbiased/pareto')
    expect(entry).toEqual({
      modelId: 'unbiased/pareto',
      label: 'Pareto',
      // Same load-bearing shape as Union Alpha: supported_parameters are
      // max_tokens, response_format, temperature, tool_choice, tools and
      // top_p — no `reasoning`/`reasoning_effort` for a ladder to drive.
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 262_144,
      maxTokens: 131_072,
      cost: { input: 2.5, output: 7.5, cacheRead: 0.25, cacheWrite: 0 }
    })
    expect(entry).not.toHaveProperty('thinkingLevelMap')
    expect(entry).not.toHaveProperty('reasoningControl')

    const home = isolatedHome()
    expect(
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'unbiased/pareto'
      })
    ).toBe(true)
    const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    expect(config.providers.openrouter.models[0]).toMatchObject({
      id: 'unbiased/pareto',
      name: 'Pareto',
      api: 'openai-completions',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 262_144,
      maxTokens: 131_072
    })
    expect(config.providers.openrouter.models[0]).not.toHaveProperty('thinkingLevelMap')
  })

  it('registers Jev 1.13 as a NON-reasoning structured decision route', () => {
    const entry = PI_OPENROUTER_CUSTOM_MODELS.find(
      (model) => model.modelId === 'typesafe/jev-1.13'
    )
    expect(entry).toEqual({
      modelId: 'typesafe/jev-1.13',
      label: 'Jev 1.13',
      // A structured decision model returns typed choices, not prose — no
      // reasoning axis exists to map. maxTokens and cost are placeholders
      // while the route is "coming soon": re-verify both at launch.
      reasoning: false,
      input: ['text'],
      contextWindow: 32_000,
      maxTokens: 8_192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
    expect(entry).not.toHaveProperty('thinkingLevelMap')
    expect(entry).not.toHaveProperty('reasoningControl')

    const home = isolatedHome()
    expect(
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'typesafe/jev-1.13'
      })
    ).toBe(true)
    const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    expect(config.providers.openrouter.models[0]).toMatchObject({
      id: 'typesafe/jev-1.13',
      name: 'Jev 1.13',
      api: 'openai-completions',
      reasoning: false,
      input: ['text'],
      contextWindow: 32_000,
      maxTokens: 8_192
    })
    expect(config.providers.openrouter.models[0]).not.toHaveProperty('thinkingLevelMap')
  })

  it('registers Space Bunny Alpha as a mandatory-reasoning route mapped Low to Max', () => {
    const entry = PI_OPENROUTER_CUSTOM_MODELS.find(
      (model) => model.modelId === 'stealth/space-bunny-alpha'
    )
    const lowToMax = {
      // OpenRouter marks reasoning `mandatory: true`, so there is no `none`
      // effort to send; a null here is what stops Pi sending one anyway.
      off: null,
      // Not in supported_efforts (low, medium, high, xhigh, max).
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    }
    expect(entry).toEqual({
      modelId: 'stealth/space-bunny-alpha',
      label: 'Space Bunny Alpha',
      reasoning: true,
      thinkingLevelMap: lowToMax,
      // The route also takes video; the Pi RPC transport carries text and
      // image only, so video is deliberately not advertised.
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 524_288,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    })
    expect(entry).not.toHaveProperty('reasoningControl')

    // Pi's own rule (pi-ai `getSupportedThinkingLevels`, 0.84.2): a null entry
    // removes a level, and xhigh/max exist only when mapped. The stops Pi
    // accepts must be exactly the stops TaskWraith offers — otherwise an
    // offered stop is clamped to a neighbour before it reaches OpenRouter.
    const piAccepts = PI_FULL_LADDER.filter((level) => {
      const mapped = entry?.thinkingLevelMap?.[level]
      if (mapped === null) return false
      if (level === 'xhigh' || level === 'max') return mapped !== undefined
      return true
    })
    expect(piAccepts).toEqual(
      resolvePiReasoningSupport('openrouter/stealth/space-bunny-alpha').efforts
    )

    const home = isolatedHome()
    expect(
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'stealth/space-bunny-alpha'
      })
    ).toBe(true)
    const config = JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))
    expect(config.providers.openrouter.models[0]).toMatchObject({
      id: 'stealth/space-bunny-alpha',
      name: 'Space Bunny Alpha',
      api: 'openai-completions',
      reasoning: true,
      thinkingLevelMap: lowToMax,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 524_288,
      // A named effort selector, not the on/off `together` toggle.
      compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter' }
    })
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
