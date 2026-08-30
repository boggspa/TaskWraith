/**
 * OpenRouter custom-model registration shared by Electron main and the
 * standalone pure-Node Host. Pi starts offline in a fresh per-run home, so the
 * selected curated model must be written to `models.json` before spawn.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PiThinkingLevel } from './PiCliArgs'

export interface PiOpenRouterCustomModelRegistration {
  readonly modelId: string
  readonly label: string
  readonly reasoning: boolean
  /** Routes with a real on/off toggle but no named effort selector. */
  readonly reasoningControl?: 'toggle'
  readonly thinkingLevelMap?: Readonly<Partial<Record<PiThinkingLevel, string | null>>>
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
 * The user-approved OpenRouter models for Pi. Pi's bundled OpenRouter catalog
 * does not include these models, and TaskWraith intentionally does not refresh
 * the aggregator catalog at launch.
 *
 * Sources: OpenRouter Models API, verified 2026-08-30. TaskWraith's Pi RPC
 * transport carries text and image content, so video/audio modalities exposed
 * by some upstream models are deliberately not advertised here.
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
    // Pi's generated OpenRouter catalogue opts this model into Extra High.
    thinkingLevelMap: { xhigh: 'xhigh' },
    input: ['text'],
    contextWindow: 256_000,
    maxTokens: 131_072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    modelId: 'poolside/laguna-s-2.1',
    label: 'Laguna S 2.1',
    reasoning: true,
    reasoningControl: 'toggle',
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
  },
  {
    modelId: 'cohere/north-mini-code:free',
    label: 'North Mini Code (OpenRouter Free)',
    reasoning: true,
    reasoningControl: 'toggle',
    input: ['text'],
    contextWindow: 256_000,
    maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    modelId: 'minimax/minimax-m3:free',
    label: 'MiniMax M3 (OpenRouter Free)',
    reasoning: true,
    reasoningControl: 'toggle',
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 943_718,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    modelId: 'thinkingmachines/inkling:free',
    label: 'Inkling (OpenRouter Free)',
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
  {
    modelId: 'thinkingmachines/inkling-small:free',
    label: 'Inkling Small (OpenRouter Free)',
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
]

export function findPiOpenRouterCustomModel(
  modelId: string
): PiOpenRouterCustomModelRegistration | undefined {
  return PI_OPENROUTER_CUSTOM_MODELS.find((model) => model.modelId === modelId)
}

/** Register the exact selected model in Pi's owner-only per-run home. */
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
            ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
            input: [...model.input],
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            cost: model.cost,
            compat: {
              supportsDeveloperRole: false,
              ...(model.reasoningControl === 'toggle' ? { supportsReasoningEffort: false } : {}),
              thinkingFormat: model.reasoningControl === 'toggle' ? 'together' : 'openrouter'
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
