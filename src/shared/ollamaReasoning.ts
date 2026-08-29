import {
  normalizeOllamaModelKey,
  ollamaCloudBaseModelId,
  ollamaModelIdAliases
} from './ollamaModelAvailability'

/**
 * The exact vocabulary Ollama's `think` field accepts as a string. Its own
 * validator names the set: `must be "high", "medium", "low", "max", true, or
 * false`. Distinct from `store/types.ts`'s `OllamaReasoningLevel`, which is the
 * TaskWraith run-profile preset rather than the wire value.
 */
export type OllamaThinkingLevel = 'low' | 'medium' | 'high' | 'max'
export type OllamaReasoningEffort = 'off' | 'on' | OllamaThinkingLevel

export interface OllamaReasoningSupport {
  readonly kind: 'unsupported' | 'toggle' | 'levels' | 'unknown'
  /**
   * The complete ladder to offer, lowest stop first. `off` appears only when
   * the model can actually stop reasoning, so a picker never shows a control
   * the model will ignore.
   */
  readonly efforts: readonly OllamaReasoningEffort[]
  readonly defaultEffort: OllamaReasoningEffort | null
  /** False for models that always reason (GPT-OSS, GLM 5.3, MiniMax M2.x). */
  readonly canDisable: boolean
}

export interface OllamaReasoningCapabilityInput {
  modelId?: string | null
  /**
   * Authoritative `/api/show` capabilities when present. An empty array is
   * meaningful evidence that the model does not advertise thinking; omit the
   * field when the daemon supplied no capability metadata.
   */
  capabilities?: readonly string[] | null
}

const TOGGLE_EFFORTS = ['off', 'on'] as const

const UNSUPPORTED: OllamaReasoningSupport = Object.freeze({
  kind: 'unsupported',
  efforts: [],
  defaultEffort: null,
  canDisable: false
})
const UNKNOWN: OllamaReasoningSupport = Object.freeze({
  kind: 'unknown',
  efforts: [],
  defaultEffort: null,
  canDisable: false
})
const TOGGLE: OllamaReasoningSupport = Object.freeze({
  kind: 'toggle',
  efforts: TOGGLE_EFFORTS,
  defaultEffort: 'on',
  canDisable: true
})
/** Thinks on every turn. The daemon accepts `think: false` and ignores it, so
 *  offering Off would be a control that silently does nothing. */
const ALWAYS_ON: OllamaReasoningSupport = Object.freeze({
  kind: 'toggle',
  efforts: ['on'] as const,
  defaultEffort: 'on',
  canDisable: false
})

function levels(
  efforts: readonly OllamaThinkingLevel[],
  defaultEffort: OllamaThinkingLevel,
  canDisable: boolean
): OllamaReasoningSupport {
  return Object.freeze({
    kind: 'levels',
    efforts: canDisable ? (['off', ...efforts] as const) : efforts,
    defaultEffort,
    canDisable
  })
}

// Curated fallbacks keep the picker useful before live daemon metadata arrives.
// Runtime launch still prefers exact `/api/show` capabilities, so a retagged or
// upgraded model can override this table without waiting for a TaskWraith build.
const KNOWN_TOGGLE_MODEL_IDS = [
  // The base and `-thinking` siblings of the instruct variant below both
  // think; only `qwen3:4b-instruct` does not.
  'qwen3:4b',
  'qwen3:4b-thinking',
  'qwen3.5:2b',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'qwen3.6:35b',
  'qwen3.8:27b-mlx',
  'qwen3.8-flash-next:125b-mlx',
  'gemma4:12b',
  'gemma4:31b-mlx',
  'ornith:9b',
  'ornith:35b',
  'laguna-xs-2.1:q8_0',
  'lfm2.5-thinking:1.2b',
  'lfm2.5:8b',
  'nemotron-3-nano:4b',
  'nemotron3:33b',
  'nemotron-3.5-lightning:30b-mlx',
  'muse-glimmer:30b-mlx',
  'deepseek-r1:1.5b',
  'deepseek-r1:8b',
  'glm-4.7-flash:q4_k_m',
  'north-mini-code-1.0:q4_k_m'
] as const

const KNOWN_NON_THINKING_MODEL_IDS = [
  // Qwen's own card: this variant "supports only non-thinking mode and does
  // not generate <think></think> blocks". Its sibling `qwen3:4b` does think.
  'qwen3:4b-instruct',
  // Upstream MiniCPM-V 4.5 has hybrid thinking, but the packaged GGUF template
  // hardcodes `enable_thinking = false`, so it is not reachable here.
  'minicpm-v4.5:8b',
  // Ornith 1.5 kept 1.0's `enable_thinking` template verbatim but ships
  // without the `ornith` parser/renderer that 1.0 declares, so the daemon
  // reports no thinking capability. Packaging, not a capability change —
  // recheck if a repackage lands.
  'ornith-1.5',
  'ornith-1.5:9b',
  'ornith-1.5:35b',
  // All three Granite 4.2 sizes share one byte-identical chat template, so
  // they cannot differ. IBM's template does support thinking; Ollama's
  // packaging does not surface it, and the library page shows no badges.
  'granite4.2',
  'granite4.2:3b',
  'granite4.2:8b',
  'granite4.2:30b',
  'gemma3:4b',
  'granite4:3b',
  'granite4.1:3b',
  'granite4.1:30b',
  'devstral-small-2:24b',
  'ministral-3:3b',
  'ministral-3:14b',
  'llama3.1:8b',
  'rnj-1',
  'llama3.2:3b'
] as const

function normalizedBaseModelId(modelId?: string | null): string {
  return normalizeOllamaModelKey(ollamaCloudBaseModelId(modelId))
}

function matchesCuratedModel(modelId: string, curatedId: string): boolean {
  if (modelId === curatedId || modelId.startsWith(`${curatedId}-`)) return true
  return ollamaModelIdAliases(modelId).includes(curatedId)
}

/**
 * Every GPT-OSS size and packaging, anchored so a model that merely ends in
 * "gpt-oss" does not match. The previous three-literal allowlist covered only
 * the 20B tag, so `gpt-oss:120b` — including the Cloud tag — fell through to
 * the boolean surface and lost the one ladder Ollama actually documents.
 */
const GPT_OSS_FAMILY = /^(?:openai\/)?gpt-oss(?:[:-]|$)/

export function isOllamaGptOssModel(modelId?: string | null): boolean {
  const key = normalizedBaseModelId(modelId)
  return key ? GPT_OSS_FAMILY.test(key) : false
}

/**
 * Families whose reasoning surface is NOT the plain Off/On boolean.
 *
 * Keyed by family prefix against the Cloud-stripped id. Order matters only in
 * that the first match wins, so longer prefixes are listed first. A family
 * absent from here is a boolean model, which is the honest default: Ollama
 * ignores a level whose prompt template does not consume `.ThinkLevel`, and
 * offering a stop the model discards is worse than not offering it.
 */
const FAMILY_LADDERS: readonly (readonly [string, OllamaReasoningSupport])[] = [
  // Ollama documents low/medium/high for GPT-OSS and rewrites "max" to "high"
  // in server/routes.go before the model sees it, so a Max stop would be a lie
  // at the client layer. The trace itself cannot be turned off.
  ['gpt-oss', levels(['low', 'medium', 'high'], 'high', false)],

  // Its template branches on `.ThinkLevel` and emits
  // `[MODEL_SETTINGS]{"reasoning_effort":"high"}` — but only `high` maps
  // through; every other level falls back to "none". So the honest surface is
  // high-or-off, expressed through the level API rather than the boolean.
  ['mistral-medium-3.5', levels(['high'], 'high', true)],

  // Z.ai: GLM 5.3 takes low/high/max ONLY — there is no medium — and defaults
  // to max. Disabling is not merely ignored, it FAILS the request, so Off must
  // not be offered. Listed before `glm-5.2`/`glm-5.1` prefixes for clarity;
  // the matcher takes the first hit.
  ['glm-5.3-flash', levels(['low', 'high', 'max'], 'max', false)],
  ['glm-5.3', levels(['low', 'high', 'max'], 'max', false)],
  // GLM 5.2 documents seven efforts that collapse to three outcomes: none and
  // minimal skip thinking, low/medium map to high, xhigh maps to max. Through
  // Ollama's four-value vocabulary that leaves exactly High and Max, which is
  // also how Ollama's own model page describes it.
  ['glm-5.2', levels(['high', 'max'], 'max', true)],
  // `reasoning_effort` is documented as "GLM-5.2 and above", so 5.1 is boolean.
  ['glm-5.1', TOGGLE],

  // DeepSeek V4: low/high/max with medium and xhigh documented aliases for
  // high, default high, and a real no-thinking mode.
  ['deepseek-v4-pro', levels(['low', 'high', 'max'], 'high', true)],
  ['deepseek-v4-flash', levels(['low', 'high', 'max'], 'high', true)],

  // Moonshot publishes an effort ladder for K3, but Ollama's own page is
  // silent on it and a Cloud tag exposes no template to check, so the level
  // set is unverified ON THIS PATH. Thinking is not disableable either way —
  // stay on the surface we can prove rather than risk a stop that silently
  // becomes max.
  ['kimi-k3', ALWAYS_ON],
  ['kimi-k2.7-code', ALWAYS_ON],
  ['kimi-k2.6', TOGGLE],
  // Retired upstream on 2026-07-31, but saved chats still name it and an
  // `unknown` renders as an affirmative "not configurable" denial.
  ['kimi-k2.5', TOGGLE],

  // MiniMax M2.x: `thinking.type: "disabled"` is accepted and ignored.
  ['minimax-m2.7', ALWAYS_ON],
  ['minimax-m3', TOGGLE],

  // Measured on a live daemon at temperature 0: low/medium/high/max produced
  // byte-identical output and only `false` differed. Gemma gates thinking with
  // a control token, not an effort level.
  ['gemma4', TOGGLE],
  ['qwen3.5', TOGGLE],
  ['nemotron-3-nano', TOGGLE],
  ['nemotron-3-super', TOGGLE],
  ['nemotron-3-ultra', TOGGLE],
  ['nemotron3', TOGGLE],

  // Vision + tools, no thinking badge.
  ['mistral-large-3', UNSUPPORTED]
]

function familyLadder(key: string): OllamaReasoningSupport | null {
  if (isOllamaGptOssModel(key)) {
    return FAMILY_LADDERS.find(([family]) => family === 'gpt-oss')?.[1] ?? null
  }
  const match = FAMILY_LADDERS.find(
    ([family]) => key === family || key.startsWith(`${family}:`) || key.startsWith(`${family}-`)
  )
  return match ? match[1] : null
}

function staticOllamaReasoningSupport(modelId?: string | null): OllamaReasoningSupport {
  const key = normalizedBaseModelId(modelId)
  if (!key) return UNKNOWN
  const ladder = familyLadder(key)
  if (ladder) return ladder
  // Non-thinking is checked FIRST because its entries are the more specific
  // statement. `qwen3:4b` thinks and `qwen3:4b-instruct` does not, and the
  // curated matcher treats a `-` suffix as a family member — so the base tag
  // would otherwise hand its sibling a control it cannot honour.
  if (KNOWN_NON_THINKING_MODEL_IDS.some((candidate) => matchesCuratedModel(key, candidate))) {
    return UNSUPPORTED
  }
  if (KNOWN_TOGGLE_MODEL_IDS.some((candidate) => matchesCuratedModel(key, candidate))) {
    return TOGGLE
  }
  return UNKNOWN
}

/**
 * Resolve the honest reasoning surface for an Ollama model.
 *
 * Ordinary thinking models expose Ollama's boolean control as Off/On. GPT-OSS
 * is the documented exception: its trace cannot be disabled, but its
 * Low/Medium/High effort is adjustable. `/api/show` capability evidence wins
 * over the curated fallback so custom, retagged, and Cloud models stay honest.
 */
export function resolveOllamaReasoningSupport(
  input: OllamaReasoningCapabilityInput
): OllamaReasoningSupport {
  if (Array.isArray(input.capabilities)) {
    const thinking = input.capabilities.some(
      (capability) => String(capability).trim().toLowerCase() === 'thinking'
    )
    if (!thinking) return UNSUPPORTED
    // The daemon proves THAT a model thinks; it has no field for the shape of
    // the control (there is no `thinking_levels` capability), so the curated
    // ladder still decides between boolean and levels.
    return familyLadder(normalizedBaseModelId(input.modelId)) ?? TOGGLE
  }
  return staticOllamaReasoningSupport(input.modelId)
}

/** Lowest to highest. The clamp below walks this order, so keep it sorted. */
const LEVEL_ORDER: readonly OllamaThinkingLevel[] = ['low', 'medium', 'high', 'max']

export function isOllamaThinkingLevel(value: unknown): value is OllamaThinkingLevel {
  return LEVEL_ORDER.includes(value as OllamaThinkingLevel)
}

/** Ladder tokens that mean "as little reasoning as possible". */
const OFF_TOKENS = new Set(['off', 'false', 'none', 'minimal'])
/** Ladder tokens above the highest named level TaskWraith shows per provider. */
const TOP_TOKENS = new Set(['xhigh', 'max', 'maximum', 'ultra', 'ultracode', 'ultratask'])

/**
 * Fold a TaskWraith ladder token onto the exact stop this model offers.
 *
 * Two rules earn their place. `minimal`/`none` sit at the FLOOR of the shared
 * ladder, so folding them onto `on` (as the boolean-era code did) turned
 * thinking on for a user asking for as little as possible. And a level the
 * model does not expose — `medium` on GLM's low/high/max ladder — clamps DOWN
 * to the nearest offered stop instead of being forwarded, because the vendor
 * silently promotes an unrecognised effort to its own maximum.
 */
export function normalizeOllamaReasoningEffort(
  value: unknown,
  support: OllamaReasoningSupport
): OllamaReasoningEffort | null {
  if (support.kind === 'unsupported' || support.kind === 'unknown') return null
  const normalized = String(value || '')
    .trim()
    .toLowerCase()

  const ladder = support.efforts.filter(isOllamaThinkingLevel)

  if (OFF_TOKENS.has(normalized)) {
    if (support.canDisable) return 'off'
    // Cannot stop reasoning, so honour the INTENT: the least this model will
    // do. Falling back to `defaultEffort` here would answer a request for as
    // little as possible with GLM 5.3's `max` — worse than the boolean era
    // this replaced.
    return ladder.length > 0 ? ladder[0] : support.defaultEffort
  }
  if (support.kind === 'toggle') return 'on'
  if (ladder.length === 0) return support.defaultEffort
  if (TOP_TOKENS.has(normalized)) return ladder[ladder.length - 1]
  if (normalized === 'on' || normalized === 'true' || !normalized) return support.defaultEffort
  if (!isOllamaThinkingLevel(normalized)) return support.defaultEffort
  if (ladder.includes(normalized)) return normalized

  // A level the model does not expose rounds UP to the next offered stop.
  // That is what the vendors themselves document — DeepSeek and GLM both map
  // `medium` onto `high` — and rounding DOWN would run Local Scout's `medium`
  // at DeepSeek's LOWEST effort. Above the ladder, take its top.
  const requestedRank = LEVEL_ORDER.indexOf(normalized)
  const atOrAbove = ladder.filter((level) => LEVEL_ORDER.indexOf(level) >= requestedRank)
  return atOrAbove.length > 0 ? atOrAbove[0] : ladder[ladder.length - 1]
}
