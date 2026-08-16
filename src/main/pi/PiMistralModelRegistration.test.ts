import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PI_MISTRAL_CUSTOM_MODELS,
  writePiMistralModelRegistration
} from './PiMistralModelRegistration'
import { findPiStaticModel } from './PiModels'

const temporaryHomes: string[] = []

function isolatedHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-pi-mistral-model-'))
  temporaryHomes.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryHomes.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('writePiMistralModelRegistration', () => {
  it('keeps each custom registration in lockstep with its picker metadata', () => {
    for (const model of PI_MISTRAL_CUSTOM_MODELS) {
      expect(findPiStaticModel(`mistral/${model.modelId}`)).toMatchObject({
        modelId: model.modelId,
        label: model.label,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        thinking: model.reasoning,
        images: model.input.includes('image')
      })
    }
  })

  it.each(PI_MISTRAL_CUSTOM_MODELS)(
    'registers only the selected $modelId deployment in Pi’s isolated home',
    (model) => {
      const home = isolatedHome()

      expect(
        writePiMistralModelRegistration({ isolatedHomeDir: home, modelId: model.modelId })
      ).toBe(true)

      expect(JSON.parse(readFileSync(join(home, 'models.json'), 'utf8'))).toEqual({
        providers: {
          mistral: {
            models: [
              {
                id: model.modelId,
                name: model.label,
                api: 'mistral-conversations',
                reasoning: model.reasoning,
                input: [...model.input],
                contextWindow: model.contextWindow,
                maxTokens: model.maxTokens,
                cost: model.cost
              }
            ]
          }
        }
      })
      if (process.platform !== 'win32') {
        expect(statSync(join(home, 'models.json')).mode & 0o777).toBe(0o600)
      }
    }
  )

  it('leaves Pi’s home untouched for a model already bundled by Pi', () => {
    const home = isolatedHome()

    expect(
      writePiMistralModelRegistration({
        isolatedHomeDir: home,
        modelId: 'mistral-medium-3.5'
      })
    ).toBe(false)
    expect(() => statSync(join(home, 'models.json'))).toThrow()
  })

  it('refuses to overwrite another per-run Pi configuration', () => {
    const home = isolatedHome()
    writeFileSync(join(home, 'models.json'), '{}', { mode: 0o600 })

    expect(() =>
      writePiMistralModelRegistration({
        isolatedHomeDir: home,
        modelId: 'zai-glm-5-2'
      })
    ).toThrow()
    expect(readFileSync(join(home, 'models.json'), 'utf8')).toBe('{}')
  })
})
