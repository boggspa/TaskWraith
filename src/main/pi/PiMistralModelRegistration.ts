import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PiMistralCustomModelRegistration {
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
 * Callable Mistral deployments that are absent from Pi 0.82.1's bundled
 * catalogue. IDs and limits come from Mistral's public model cards; the Admin
 * limits page sometimes shows a quota/deployment slug instead of the API ID
 * (`glm-5-2` vs `zai-glm-5-2`, for example).
 */
export const PI_MISTRAL_CUSTOM_MODELS: readonly PiMistralCustomModelRegistration[] = [
  {
    modelId: 'zai-glm-5-2',
    label: 'GLM-5.2 (via Mistral)',
    reasoning: true,
    input: ['text'],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.14, cacheWrite: 0 }
  },
  {
    modelId: 'labs-leanstral-1-5',
    label: 'Leanstral 1.5 (Labs)',
    reasoning: false,
    input: ['text'],
    contextWindow: 262_144,
    maxTokens: 131_072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    modelId: 'codestral-2508',
    label: 'Codestral (Aug 2025)',
    reasoning: false,
    input: ['text'],
    contextWindow: 131_072,
    maxTokens: 4_096,
    cost: { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0 }
  },
  {
    modelId: 'ministral-14b-2512',
    label: 'Ministral 3 (14B)',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.2, output: 0.2, cacheRead: 0.02, cacheWrite: 0 }
  },
  {
    modelId: 'ministral-8b-2512',
    label: 'Ministral 3 (8B)',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.15, output: 0.15, cacheRead: 0.015, cacheWrite: 0 }
  },
  {
    modelId: 'ministral-3b-2512',
    label: 'Ministral 3 (3B)',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0 }
  }
]

export function findPiMistralCustomModel(
  modelId: string
): PiMistralCustomModelRegistration | undefined {
  return PI_MISTRAL_CUSTOM_MODELS.find((model) => model.modelId === modelId)
}

/**
 * Register one selected model in the run's owner-only Pi home. Returning false
 * means Pi already bundles (or TaskWraith does not curate) the requested ID.
 */
export function writePiMistralModelRegistration(input: {
  isolatedHomeDir: string
  modelId: string
}): boolean {
  const model = findPiMistralCustomModel(input.modelId)
  if (!model) return false

  const modelsPath = join(input.isolatedHomeDir, 'models.json')
  const config = {
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
  }
  // Each run has a fresh 0700 home. Exclusive creation prevents a second
  // config source from silently replacing the selected model's registration.
  writeFileSync(modelsPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return true
}
