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
 * `stealth/union-alpha` carries its own dated sunset for the same reason, and
 * `stealth/space-bunny-alpha` is the current stealth preview.
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
  },
  {
    // Sakana Fugu Max — released 2026-09-11. `reasoning_effort` is in
    // supported_parameters with supported_efforts unenumerated, the same shape
    // as Mercury and the Nex-N2.5 pair, so the gateway takes the whole ladder.
    // Sources: OpenRouter Models API + model page, verified 2026-09-11.
    modelId: 'sakana/fugu-max',
    label: 'Fugu Max',
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
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 0 }
  },
  {
    // Sakana Fugu Ultra v2 — released 2026-09-11, same surface as Fugu Max.
    // Its pricing carries an OpenRouter `overrides` tier that doubles input
    // and raises output to $45 once the PROMPT passes 272,000 tokens; this
    // flat cost block cannot express a prompt-length break, so the base tier
    // is recorded and the long-prompt tier is documented in MODEL_CATALOGUE.md.
    // Sources: OpenRouter Models API + model page, verified 2026-09-11.
    modelId: 'sakana/fugu-ultra-v2',
    label: 'Fugu Ultra v2',
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
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }
  },
  {
    // Union Alpha — free stealth preview released 2026-09-16, offered for a
    // seven-day window (see PI_MODEL_RETIREMENTS).
    //
    // `reasoning: false` is the whole point of this row. Every other stealth
    // or preview route above advertises `reasoning_effort`; this endpoint's
    // supported_parameters are max_tokens, temperature, top_p, tools,
    // tool_choice and response_format ONLY. Registering it as a reasoning
    // model would put a live effort selector over a gateway that drops the
    // field, which is the failure `piReasoning` exists to prevent.
    //
    // Sources: OpenRouter Models API + /endpoints, verified 2026-09-16.
    modelId: 'stealth/union-alpha',
    label: 'Union Alpha',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 262_144,
    maxTokens: 131_072,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    // Pareto — Unbiased's multimodal composite, released 2026-09-17. Paid
    // route: $2.50/$7.50 per Mtok with $0.25 cache read, one hosting provider
    // (no routing fan-out), 30-day retention, prompts not trained on.
    //
    // `reasoning: false` for the same reason as Union Alpha above: the
    // endpoint's supported_parameters are max_tokens, response_format,
    // temperature, tool_choice, tools and top_p ONLY — no `reasoning` or
    // `reasoning_effort`, so a ladder here would drive a field the gateway
    // drops.
    //
    // Sources: OpenRouter Models API + /endpoints, verified 2026-09-18.
    modelId: 'unbiased/pareto',
    label: 'Pareto',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 262_144,
    maxTokens: 131_072,
    cost: { input: 2.5, output: 7.5, cacheRead: 0.25, cacheWrite: 0 }
  },
  {
    // Jev 1.13 — TypeSafe's first System One structured decision model,
    // released 2026-09-17. Text in, typed choices out: a decision point, not
    // a prose generator, so `reasoning: false` is the model's nature, not a
    // missing parameter map.
    //
    // The route is "coming soon" on OpenRouter — listed with no endpoints,
    // no pricing and no published output ceiling. maxTokens is an 8,192
    // PLACEHOLDER (already generous for a typed choice) and cost is 0/0 as a
    // neutral placeholder, NOT a free-route claim: both must be re-verified
    // against the Models API at launch, and the route 404s until then.
    //
    // Sources: OpenRouter model page + FAQ, read 2026-09-18.
    modelId: 'typesafe/jev-1.13',
    label: 'Jev 1.13',
    reasoning: false,
    input: ['text'],
    contextWindow: 32_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  },
  {
    // Space Bunny Alpha — free stealth preview released 2026-09-23. The
    // opposite shape from Union Alpha: OpenRouter's reasoning block is
    // `mandatory: true`, supported_efforts low/medium/high/xhigh/max, default
    // Max. The map is spelled out in full because two of its entries are
    // load-bearing: `off: null` stops Pi sending `effort: "none"` to a route
    // that cannot stop reasoning, and `xhigh`/`max` must be mapped or Pi's
    // `getSupportedThinkingLevels` drops them as opt-in stops. `minimal` is
    // not a supported effort, so it is null too.
    //
    // Video input is advertised upstream but not here — the Pi RPC transport
    // carries text and image only. The endpoint accepts only `auto`
    // tool_choice, which is all Pi ever sends (it never sets the field).
    //
    // Sources: OpenRouter Models API + /endpoints, verified 2026-09-23.
    modelId: 'stealth/space-bunny-alpha',
    label: 'Space Bunny Alpha',
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    },
    input: ['text', 'image'],
    contextWindow: 1_000_000,
    maxTokens: 524_288,
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
