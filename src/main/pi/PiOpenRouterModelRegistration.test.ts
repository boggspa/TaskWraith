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

  it('keeps the Ox Alpha registration in lockstep with picker metadata', () => {
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
              input: [...model.input],
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              cost: model.cost,
              compat: {
                supportsDeveloperRole: false,
                thinkingFormat: 'openrouter'
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

  it('leaves Pi’s home untouched for every model outside the one-model exception', () => {
    const home = isolatedHome()

    expect(
      writePiOpenRouterModelRegistration({
        isolatedHomeDir: home,
        modelId: 'anthropic/claude-opus-5'
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
        modelId: 'stealth/ox-alpha'
      })
    ).toThrow()
    expect(readFileSync(join(home, 'models.json'), 'utf8')).toBe('{}')
  })
})
