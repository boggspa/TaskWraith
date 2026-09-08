import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS,
  normalizePiCerebrasMaxCompletionTokens
} from '../../shared/piCerebrasCompletionCap'
import { findPiStaticModel } from './PiModels'

/**
 * Pi 0.84.2 lacks Qwen 3.8 27B and gives Gemma a larger output ceiling than
 * Cerebras's console reports. Register only the selected new route, combining
 * any user completion cap in the same exclusive models.json write.
 *
 * Sources (2026-09-08): Cerebras Cloud console model limits and
 * https://inference-docs.cerebras.ai/capabilities/reasoning
 * https://inference-docs.cerebras.ai/models/qwen-3.8-27b
 */
export function writePiCerebrasModelRegistration(input: {
  isolatedHomeDir: string
  modelId: string
  maxCompletionTokens?: number
}): boolean {
  const modelId = input.modelId.trim()
  if (!modelId || modelId.includes('\0')) {
    throw new TypeError('Pi Cerebras model id is invalid.')
  }
  const cap = normalizePiCerebrasMaxCompletionTokens(input.maxCompletionTokens)
  if (input.maxCompletionTokens !== undefined && cap === undefined) {
    throw new RangeError(
      `Pi Cerebras completion cap must be a whole number from 1 to ${PI_CEREBRAS_MODEL_MAX_COMPLETION_TOKENS}.`
    )
  }
  const model =
    modelId === 'gemma-4-31b' || modelId === 'qwen-3.8-27b'
      ? findPiStaticModel(`cerebras/${modelId}`)
      : undefined
  if (!model && cap === undefined) return false

  const cerebras = model
    ? {
        models: [
          {
            id: model.modelId,
            name: model.label,
            api: 'openai-completions',
            reasoning: model.thinking,
            input: model.images ? ['text', 'image'] : ['text'],
            contextWindow: model.contextWindow,
            maxTokens: Math.min(cap ?? model.maxOutputTokens, model.maxOutputTokens),
            cost: { input: 0.99, output: 1.49, cacheRead: 0, cacheWrite: 0 },
            compat: { supportsStore: false, supportsDeveloperRole: false },
            thinkingLevelMap: {
              off: 'none',
              minimal: null,
              low: modelId === 'qwen-3.8-27b' ? 'low' : null,
              medium: modelId === 'qwen-3.8-27b' ? 'medium' : null,
              high: 'high',
              xhigh: null,
              max: null
            }
          }
        ]
      }
    : { modelOverrides: { [modelId]: { maxTokens: cap } } }

  writeFileSync(
    join(input.isolatedHomeDir, 'models.json'),
    JSON.stringify({ providers: { cerebras } }),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  )
  return true
}
