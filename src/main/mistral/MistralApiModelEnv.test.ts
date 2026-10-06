import { describe, expect, it } from 'vitest'
import { PI_STATIC_MODELS } from '../../host-shared/pi/PiModels'
import { modelRequiresApiKey } from '../../shared/apiKeyModelIndicator'
import {
  MISTRAL_API_MODEL_IMAGE_INPUT,
  mistralApiModelVibeConfig,
  VIBE_ACTIVE_MODEL_ENV,
  VIBE_MODELS_ENV
} from './MistralApiModelEnv'
import { MISTRAL_SEAT_MODELS } from './MistralCliArgs'

const KEY_MARKED_SEAT_MODELS = MISTRAL_SEAT_MODELS.filter((model) =>
  modelRequiresApiKey('mistral', model)
)

function vibeModels(model: string, thinking: Parameters<typeof mistralApiModelVibeConfig>[1]) {
  const config = mistralApiModelVibeConfig(model, thinking)
  if (!config) throw new Error(`no Vibe config for ${model}`)
  return { config, entries: JSON.parse(config.env[VIBE_MODELS_ENV]) as Record<string, unknown>[] }
}

describe('mistralApiModelVibeConfig', () => {
  it('pins Mistral Large 4 as the active Vibe model at the run thinking level', () => {
    const { config, entries } = vibeModels('mistral-large-4', 'max')
    expect(config.env[VIBE_ACTIVE_MODEL_ENV]).toBe('mistral-large-4')
    expect(config.thinkingLevel).toBe('max')
    expect(entries).toEqual([
      {
        name: 'mistral-large-4',
        provider: 'mistral',
        alias: 'mistral-large-4',
        display_name: 'Mistral Large 4',
        input_price: 0.68,
        output_price: 2.09,
        thinking: 'max',
        supports_images: true
      }
    ])
  })

  it('opens a thinking-capable model at high when the run names no level', () => {
    expect(vibeModels('mistral-large-4', null).config.thinkingLevel).toBe('high')
    expect(vibeModels('mistral-small-2603', undefined).entries[0]?.thinking).toBe('high')
  })

  it('opens a model without a thinking ladder at off, whatever the run carried over', () => {
    const { config, entries } = vibeModels('mistral-large-2512', 'medium')
    expect(config.thinkingLevel).toBe('off')
    expect(entries[0]?.thinking).toBe('off')
  })

  it.each([
    'mistral-medium-3.5',
    'mistral-vibe-cli-latest',
    'glm-5-2',
    'glm-5-3',
    'mistral/mistral-large-2512',
    'devstral-2512',
    'not-a-mistral-model',
    '',
    null
  ])('leaves %s to Vibe', (model) => {
    expect(mistralApiModelVibeConfig(model, 'high')).toBeNull()
  })

  it.each(KEY_MARKED_SEAT_MODELS)('builds a complete entry for key-marked %s', (model) => {
    const { config, entries } = vibeModels(model, 'high')
    expect(config.env[VIBE_ACTIVE_MODEL_ENV]).toBe(model)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: model, provider: 'mistral', alias: model })
    expect(typeof entries[0]?.display_name).toBe('string')
    expect(entries[0]?.display_name).not.toBe(model)
    expect(MISTRAL_API_MODEL_IMAGE_INPUT).toHaveProperty(model)
  })

  it('keeps the image table to exactly the key-marked seat models', () => {
    expect(Object.keys(MISTRAL_API_MODEL_IMAGE_INPUT).sort()).toEqual(
      [...KEY_MARKED_SEAT_MODELS].sort()
    )
  })

  it('agrees with the Pi lane on image input wherever both carry the model', () => {
    for (const entry of PI_STATIC_MODELS) {
      if (entry.upstream !== 'mistral') continue
      if (!(entry.modelId in MISTRAL_API_MODEL_IMAGE_INPUT)) continue
      expect(MISTRAL_API_MODEL_IMAGE_INPUT[entry.modelId], entry.modelId).toBe(entry.images)
    }
  })
})
