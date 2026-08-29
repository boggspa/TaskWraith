import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PiOpenRouterCustomModelRegistration {
  readonly modelId: string
  readonly label: string
  readonly reasoning: boolean
  readonly input: readonly ('text' | 'image')[]
  readonly contextWindow: number
  readonly maxTokens: number
  readonly cost: Readonly<{
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }>
}

/**
 * The user-approved OpenRouter models for Pi. Pi 0.82.1's bundled
 * OpenRouter catalog does not include these models, and Pi starts offline in
 * TaskWraith, so register their current API metadata in the selected run's
 * owner-only home instead of refreshing or exposing the aggregator catalog.
 *
 * Sources: OpenRouter Models API, verified 2026-08-21:
 * - `zai/glm-5.2`: 256,000-token context, free input/output, text-only input.
 * - `poolside/laguna-s-2.1`: 256,000-token context, free input/output, text-only input.
 * - `nvidia/nemotron-3-ultra-550b-a55b:free`: 1,000,000-token context, 65,536-token output cap,
 *   free input/output, text-only input.
 *
 * OpenRouter withdrew `stealth/ox-alpha` on 2026-08-28. Its historical
 * metadata remains in PiModels, PiBrandTable, and context-window lookups so
 * saved chats and ensemble seats still render, but no new Pi home registers it.
 */
export const PI_OPENROUTER_CUSTOM_MODELS: readonly PiOpenRouterCustomModelRegistration[] = [
  {
    modelId: 'z-ai/glm-5.2',
    label: 'GLM 5.2',
    reasoning: true,
    input: ['text'],
    contextWindow: 256_000,
    maxTokens: 131_072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    modelId: 'poolside/laguna-s-2.1',
    label: 'Laguna S 2.1',
    reasoning: true,
    input: ['text'],
    contextWindow: 256_000,
    maxTokens: 131_072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    label: 'Nemotron 3 Ultra',
    reasoning: true,
    input: ['text'],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
]

export function findPiOpenRouterCustomModel(
  modelId: string
): PiOpenRouterCustomModelRegistration | undefined {
  return PI_OPENROUTER_CUSTOM_MODELS.find((model) => model.modelId === modelId)
}

/**
 * Register the exact curated OpenRouter model in Pi's per-run home. Returning
 * false means the requested id is outside TaskWraith's one-model exception.
 */
export function writePiOpenRouterModelRegistration(input: {
  isolatedHomeDir: string
  modelId: string
}): boolean {
  const model = findPiOpenRouterCustomModel(input.modelId)
  if (!model) return false

  const modelsPath = join(input.isolatedHomeDir, 'models.json')
  const config = {
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
  }
  // The isolated home is fresh and owner-only. Exclusive creation refuses to
  // replace another configuration source if launch preparation ever changes.
  writeFileSync(modelsPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return true
}
