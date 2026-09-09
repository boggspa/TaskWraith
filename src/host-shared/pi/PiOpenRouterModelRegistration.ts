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
    label: 'North Mini Code',
    reasoning: true,
    reasoningControl: 'toggle',
    input: ['text'],
    contextWindow: 256_000,
    maxTokens: 64_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    modelId: 'minimax/minimax-m3:free',
    label: 'M3 (OpenRouter)',
    reasoning: true,
    reasoningControl: 'toggle',
    input: ['text', 'image'],
    contextWindow: 1_048_576,
    maxTokens: 943_718,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
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
  {
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
  },
  {
    // Inception Mercury 2.5 Preview — fastest reasoning dLLM, 260K context.
    // Released 2026-08-31. Tunable effort (null supported_efforts → full ladder).
    // Sources: OpenRouter model page + inceptionlabs.ai, verified 2026-08-31.
    modelId: 'inception/mercury-2.5-preview',
    label: 'Mercury 2.5 Preview',
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max'
    },
    input: ['text'],
    contextWindow: 260_000,
    maxTokens: 32_768,
    cost: { input: 0.2, output: 0.75, cacheRead: 0, cacheWrite: 0 }
  },
  {
    // Tencent Hy4 preview — 770B MoE (49B active). Released 2026-08-28.
    // OpenRouter effort strings: none (no-think), low, high.
    // Pi spells 'none' as 'off'; xhigh/max/minimal/medium have no mapping.
    // Sources: OpenRouter model page + aireiter.com pricing page, 2026-08-30.
    modelId: 'tencent/hy4-preview',
    label: 'Hy4 Preview',
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      low: 'low',
      high: 'high'
    },
    input: ['text'],
    contextWindow: 1_048_576,
    maxTokens: 64_000,
    cost: { input: 0.834, output: 2.501, cacheRead: 0.042, cacheWrite: 0 }
  },
  {
    // Inception Mercury 2.5 — GA dLLM, released 2026-09-08. Same tunable
    // surface as the preview row above: `reasoning_effort` is in
    // supported_parameters and supported_efforts is not enumerated, so the
    // gateway accepts the whole ladder.
    // Cost is the LIST price. OpenRouter is running an introductory 80% off
    // ($0.04/$0.15, cache read $0.004); the promotion expires, the list price
    // does not, so estimates stay honest rather than silently under-billing.
    // Sources: OpenRouter Models API + model page, verified 2026-09-09.
    modelId: 'inception/mercury-2.5',
    label: 'Mercury 2.5',
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max'
    },
    input: ['text'],
    contextWindow: 260_000,
    maxTokens: 65_536,
    cost: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0 }
  },
  {
    // Nex AGI Nex-N2.5-Mini — free agentic coder, released 2026-09-08.
    // `reasoning_effort` is advertised with no enumerated supported_efforts.
    // Sources: OpenRouter Models API + model page, verified 2026-09-09.
    modelId: 'nex-agi/nex-n2.5-mini:free',
    label: 'Nex-N2.5-Mini',
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max'
    },
    input: ['text'],
    contextWindow: 262_144,
    maxTokens: 235_929,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    // Nex AGI Nex-N2.5-Pro — the larger free route, released 2026-09-08. Takes
    // image input for its visual feedback loop; TaskWraith's Pi RPC transport
    // carries text and image, so both are advertised.
    // Sources: OpenRouter Models API + model page, verified 2026-09-09.
    modelId: 'nex-agi/nex-n2.5-pro:free',
    label: 'Nex-N2.5-Pro',
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      max: 'max'
    },
    input: ['text', 'image'],
    contextWindow: 262_144,
    maxTokens: 235_929,
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
