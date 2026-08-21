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
 * The one user-approved OpenRouter model for Pi. Pi 0.82.1's bundled
 * OpenRouter catalog does not include Ox Alpha, and Pi starts offline in
 * TaskWraith, so register its current API metadata in the selected run's
 * owner-only home instead of refreshing or exposing the aggregator catalog.
 *
 * Source: OpenRouter Models API, verified 2026-08-21 — model
 * `stealth/ox-alpha`, 1,048,576-token context, 131,072-token output cap,
 * free input/output, text + image input, and OpenRouter reasoning support.
 */
export const PI_OPENROUTER_CUSTOM_MODELS: readonly PiOpenRouterCustomModelRegistration[] = [
  {
    modelId: 'stealth/ox-alpha',
    label: 'Ox Alpha',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
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
