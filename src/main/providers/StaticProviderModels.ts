import type { ProviderId } from '../store/types'
import {
  concreteModelForPreviewPlaceholder,
  isPreviewCatalogModelId,
  isPreviewModelPlaceholder,
  previewModelsForProvider,
  type PreviewModelCatalogEntry
} from '../../shared/previewModelCatalog'
import {
  CURSOR_GROK_45_BASE_MODEL_ID,
  GROK_45_DEFAULT_REASONING_EFFORT,
  GROK_45_MODEL_ID,
  GROK_45_REASONING_EFFORTS,
  isCursorGrok45ModelId
} from '../../shared/grok45Models'
import { activeCodexModelRows, isCodexModelRetired } from '../../shared/codexModelLifecycle'

export {
  activeCodexModelRows,
  codexModelRetiresAt,
  CODEX_MODEL_RETIREMENTS,
  CODEX_RETIRED_MODEL_IDS,
  hasReachedCodexRetirementDate,
  isCodexModelRetired
} from '../../shared/codexModelLifecycle'

export interface StaticProviderModelOptions {
  includePreviewModels?: boolean
}

export interface CodexModelContextConfig {
  model_context_window: number
  model_auto_compact_token_limit: number
}

export const CODEX_LONG_CONTEXT_WINDOW = 1_050_000
export const CODEX_LONG_CONTEXT_AUTO_COMPACT_LIMIT = 850_000

const CODEX_MODEL_CONTEXT_CONFIGS: Readonly<Record<string, CodexModelContextConfig>> = {
  'gpt-5.5': {
    model_context_window: CODEX_LONG_CONTEXT_WINDOW,
    model_auto_compact_token_limit: CODEX_LONG_CONTEXT_AUTO_COMPACT_LIMIT
  },
  'gpt-5.4': {
    model_context_window: CODEX_LONG_CONTEXT_WINDOW,
    model_auto_compact_token_limit: CODEX_LONG_CONTEXT_AUTO_COMPACT_LIMIT
  },
  // GPT-5.6 trio (GA 2026-07-09) — CONFIRMED against official metadata: the raw
  // API window is 1,050,000 (128K max output, cutoff 2026-02-16, per
  // developers.openai.com/api/docs/models/gpt-5.6-*), while the Codex CLI's own
  // catalog ships a smaller 372,000 default working window (same truncation it
  // applies to gpt-5.5's 272,000). TaskWraith keeps its deliberate long-context
  // override — raise the working window to the raw API window — exactly as it
  // does for gpt-5.5/5.4.
  'gpt-5.6-sol': {
    model_context_window: CODEX_LONG_CONTEXT_WINDOW,
    model_auto_compact_token_limit: CODEX_LONG_CONTEXT_AUTO_COMPACT_LIMIT
  },
  'gpt-5.6-terra': {
    model_context_window: CODEX_LONG_CONTEXT_WINDOW,
    model_auto_compact_token_limit: CODEX_LONG_CONTEXT_AUTO_COMPACT_LIMIT
  },
  'gpt-5.6-luna': {
    model_context_window: CODEX_LONG_CONTEXT_WINDOW,
    model_auto_compact_token_limit: CODEX_LONG_CONTEXT_AUTO_COMPACT_LIMIT
  }
}

export interface CodexReasoningEffortOption {
  reasoningEffort: string
  description?: string
  disabled?: boolean
  disabledReason?: string
}

export function codexModelSupportsLightReasoning(modelId?: string | null): boolean {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
  return /^gpt-5(?:[.-]|$)/.test(id) && !id.startsWith('preview:')
}

// Official GPT-5.6 catalog (2026-07-09): ALL THREE trio models expose the
// `max` tier ("Maximum reasoning depth for the hardest problems").
export function codexModelSupportsMaxReasoning(modelId?: string | null): boolean {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
  return (
    id === 'gpt-5.6-sol' ||
    id === 'gpt-5.6-terra' ||
    id === 'gpt-5.6-luna' ||
    id === 'preview:openai:gpt-5.6:sol' ||
    id === 'preview:openai:gpt-5.6:terra' ||
    id === 'preview:openai:gpt-5.6:luna'
  )
}

// Official GPT-5.6 catalog (2026-07-09): the top tier's catalog effort id is
// `ultra` ("Maximum reasoning with automatic task delegation"), on Sol AND
// Terra — NOT Luna. TaskWraith's internal token for this tier stays `ultracode`
// (shared with Claude's ladder and persisted composer state), and
// codexReasoningEffortsForModel maps an inbound `ultra` from the live
// `model/list` back onto the internal token for the PICKER.
// WIRE CAVEAT (2026-07-12): the Codex API's reasoning.effort enum tops out at
// `xhigh` and 400s on `max`/`ultra`/`ultracode` ("Codex failed · exit 1"), so
// codexWireReasoningEffort clamps all three to `xhigh` at dispatch — see its
// doc. This model-support flag now only shapes which tiers the PICKER offers
// (keep `max`/`ultra` selectable per product), NOT the wire value.
export function codexModelSupportsUltracodeReasoning(modelId?: string | null): boolean {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
  return (
    id === 'gpt-5.6-sol' ||
    id === 'gpt-5.6-terra' ||
    id === 'preview:openai:gpt-5.6:sol' ||
    id === 'preview:openai:gpt-5.6:terra'
  )
}

/**
 * Map TaskWraith's internal reasoning-effort token to the Codex API wire value.
 *
 * The Codex `reasoning.effort` enum tops out at `xhigh`; the API hard-rejects
 * anything higher with a 400 that the app-server relays and the run surfaces as
 * "Codex failed · exit 1":
 *
 *   Invalid value: 'max'. Supported values are: 'none', 'minimal', 'low',
 *   'medium', 'high', and 'xhigh'.   (param reasoning.effort, status 400)
 *
 * TaskWraith's internal ladder carries higher tiers — `max`, and the shared
 * `ultracode`/`ultra` top tier — so every above-`xhigh` tier is clamped to
 * `xhigh` (the deepest reasoning the wire actually accepts). This stops a
 * Max/Ultra seat — or a stale persisted `max` effort that leaked onto a model
 * that never listed it (e.g. gpt-5.5, captured in the durable run-event log
 * 2026-07-12) — from 400ing the turn. Internal tokens are untouched, so the
 * picker and persisted composer state keep their tiers; only the outbound wire
 * value is normalized. Mirrors ClaudeCliArgs' internal→wire mapping.
 *
 * An explicit effort is normalized onto that finite wire enum. Missing,
 * whitespace-only, and unknown values resolve to the same effective default
 * the renderer shows for an older/unseeded Codex seat: `medium` whenever the
 * selected model supports it, otherwise that model's canonical default or its
 * first accepted effort. This explicit fallback is important: omitting
 * `turn/start.effort` lets app-server inherit `model_reasoning_effort` from the
 * user's global Codex config, which may be invalid for the selected model (the
 * production failure was a global `max` inherited by gpt-5.5).
 */
export const CODEX_WIRE_REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
] as const

export type CodexWireReasoningEffort = (typeof CODEX_WIRE_REASONING_EFFORTS)[number]

const CODEX_WIRE_REASONING_EFFORT_SET: ReadonlySet<string> = new Set(
  CODEX_WIRE_REASONING_EFFORTS
)

function explicitCodexWireReasoningEffort(
  effort?: string | null
): CodexWireReasoningEffort | null {
  const normalized = String(effort || '')
    .trim()
    .toLowerCase()
  if (!normalized) return null
  if (normalized === 'off') return 'none'
  if (normalized === 'light') return 'low'
  if (normalized === 'extra') return 'xhigh'
  // Above-`xhigh` internal tiers are not in the API's reasoning.effort enum.
  if (normalized === 'ultracode' || normalized === 'ultra' || normalized === 'max') {
    return 'xhigh'
  }
  return CODEX_WIRE_REASONING_EFFORT_SET.has(normalized)
    ? (normalized as CodexWireReasoningEffort)
    : null
}

function fallbackCodexWireReasoningEffort(modelId?: string | null): CodexWireReasoningEffort {
  const normalizedModel = normalizeCodexModel(modelId)
  const model = CODEX_STATIC_MODELS.find((candidate) => candidate.id === normalizedModel)
  const supported = [
    ...new Set(
      (model?.supportedReasoningEfforts || [])
        .filter((option) => !('disabled' in option) || !option.disabled)
        .map((option) => explicitCodexWireReasoningEffort(option.reasoningEffort))
        .filter((effort): effort is CodexWireReasoningEffort => effort !== null)
    )
  ]

  // Matches resolveEnsembleParticipantSettings: an older participant with no
  // stored effort displays the provider default (medium) when the model allows
  // it. Explicit model-selection paths still persist the model's own default.
  if (supported.includes('medium')) return 'medium'

  const modelDefault = explicitCodexWireReasoningEffort(model?.defaultReasoningEffort)
  if (modelDefault && (supported.length === 0 || supported.includes(modelDefault))) {
    return modelDefault
  }
  return supported[0] || 'medium'
}

export function codexWireReasoningEffort(
  effort?: string | null,
  modelId?: string | null
): CodexWireReasoningEffort {
  return explicitCodexWireReasoningEffort(effort) || fallbackCodexWireReasoningEffort(modelId)
}

export function codexReasoningEffortsForModel<T extends CodexReasoningEffortOption>(
  modelId: string,
  efforts: readonly T[] | null | undefined
): Array<T | CodexReasoningEffortOption> {
  const normalized: Array<T | CodexReasoningEffortOption> = []
  const seen = new Set<string>()
  // Inbound wire-token → internal-token aliases: the live `model/list` says
  // 'light' where TaskWraith says 'low', and (GPT-5.6) 'ultra' where
  // TaskWraith's shared internal tier token is 'ultracode' (outbound wire
  // normalization lives in codexWireReasoningEffort).
  const INBOUND_EFFORT_ALIASES: Readonly<Record<string, string>> = {
    light: 'low',
    ultra: 'ultracode'
  }
  for (const effort of efforts || []) {
    if (!effort?.reasoningEffort) continue
    const alias = INBOUND_EFFORT_ALIASES[effort.reasoningEffort.toLowerCase()]
    const key = alias ?? effort.reasoningEffort
    const normalizedKey = key.toLowerCase()
    if (seen.has(normalizedKey)) continue
    seen.add(normalizedKey)
    normalized.push(alias ? { ...effort, reasoningEffort: alias } : effort)
  }
  if (codexModelSupportsLightReasoning(modelId) && !seen.has('low')) {
    normalized.unshift({ reasoningEffort: 'low' })
    seen.add('low')
  }
  if (codexModelSupportsMaxReasoning(modelId) && !seen.has('max')) {
    normalized.push({ reasoningEffort: 'max' })
    seen.add('max')
  }
  if (codexModelSupportsUltracodeReasoning(modelId) && !seen.has('ultracode')) {
    normalized.push({ reasoningEffort: 'ultracode' })
  }
  return normalized
}

// GPT-5.6 trio: GA'd upstream on 2026-07-09, but OpenAI is ramping accounts
// gradually AND the CLI catalog gates the rows behind
// minimal_client_version=0.144.0 — so a given user's live `model/list` may
// omit them for a while. `get-agent-models` appends these static rows to the
// live list when missing (the id-dedupe prefers the CLI's row the day it
// appears). This replaces the retired preview-catalog append for the trio.
export const CODEX_STAGED_ROLLOUT_MODEL_IDS: ReadonlySet<string> = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna'
])

// Codex CLI 0.144.0 stopped returning these rows from `model/list`, but direct
// read-only requests to both ids still completed on 2026-07-18 and OpenAI's
// current model cards still list them as active. Keep them discoverable in
// TaskWraith until the shared lifecycle schedule reaches a verified sunset.
export const CODEX_EXPLICITLY_RUNNABLE_MODEL_IDS: ReadonlySet<string> = new Set([
  'gpt-5.4',
  'gpt-5.4-mini',
  // 2026-07-25: a later CLI catalog update dropped the GPT-5.3 Codex Spark
  // research-preview row from `model/list` the same way, which silently
  // removed it from every picker (the merge only re-appends listed ids).
  // Spark has NO published sunset (see CODEX_MODEL_RETIREMENTS) and its
  // static row is already hedged ("Research preview where available"), so
  // keep it offered; the CLI's own row wins the id-dedupe if it returns.
  'gpt-5.3-codex-spark'
])

// Fallback default when a persisted/unknown id can't be resolved. Deliberately
// NOT the newest family: gpt-5.6 is still ramping account-by-account (see
// CODEX_STAGED_ROLLOUT_MODEL_IDS), so an unramped account falling back to Sol
// would fail its runs. Upstream's own default is gpt-5.6-sol; revisit once the
// rollout completes.
export const CODEX_DEFAULT_MODEL_ID = 'gpt-5.5'

/**
 * Merge the live Codex `model/list` rows with TaskWraith-appended rows:
 * staged-rollout GA models, explicitly runnable discovery-hidden models, and
 * preview-catalog rows (behind the preview flag). The CLI's own row wins the
 * id-dedupe the day it appears.
 *
 * Returns `null` when the live list is EMPTY — an empty/malformed model/list
 * response (transient hiccup, CLI warm-up race, zero-entitled account) must
 * fall back to the FULL static catalog at the call site, not to an
 * append-rows-only list that would drop gpt-5.5 and carry no default.
 */
export function mergeCodexLiveModelRows<
  TLive extends { id: string },
  TStatic extends { id: string }
>(
  liveRows: readonly TLive[],
  staticFallback: readonly TStatic[],
  options: { includePreviewAppends: boolean }
): Array<TLive | TStatic> | null {
  if (liveRows.length === 0) return null
  const appendRows = staticFallback.filter(
    (model) =>
      !isCodexModelRetired(model.id) &&
      (CODEX_STAGED_ROLLOUT_MODEL_IDS.has(model.id) ||
        CODEX_EXPLICITLY_RUNNABLE_MODEL_IDS.has(model.id) ||
        (options.includePreviewAppends && isPreviewCatalogModelId(model.id)))
  )
  return [
    ...liveRows,
    ...appendRows.filter((appended) => !liveRows.some((model) => model.id === appended.id))
  ]
}

// Fallback model list — used ONLY when the live Codex CLI `model/list` query
// fails or returns nothing (see `get-agent-models`). On the normal path the
// renderer's `codexModels` comes from the CLI-derived `normalized` list, not
// from here. Retirement metadata is sourced from CODEX_MODEL_RETIREMENTS so
// the fallback and live paths can never drift.
// GPT-5.6 trio rows carry the OFFICIAL metadata (verified 2026-07-09 against
// the upstream Codex catalog codex-rs/models-manager/models.json +
// developers.openai.com): official display names are hyphenated
// ("GPT-5.6-Sol"), Sol's official default effort is LOW, `max` exists on all
// three, and the top `ultra` tier (TaskWraith-internal token: 'ultracode')
// exists on Sol + Terra only — codexReasoningEffortsForModel appends those two
// tiers per the codexModelSupports* predicates.
export const CODEX_STATIC_MODELS = [
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    description: 'Latest frontier agentic coding model.',
    supportedReasoningEfforts: codexReasoningEffortsForModel('gpt-5.6-sol', [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]),
    defaultReasoningEffort: 'low',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    description: 'Balanced agentic coding model for everyday work.',
    supportedReasoningEfforts: codexReasoningEffortsForModel('gpt-5.6-terra', [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]),
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    description: 'Fast and affordable agentic coding model.',
    supportedReasoningEfforts: codexReasoningEffortsForModel('gpt-5.6-luna', [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]),
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: CODEX_DEFAULT_MODEL_ID,
    label: 'GPT-5.5',
    description: 'Default Codex model',
    isDefault: true,
    supportedReasoningEfforts: codexReasoningEffortsForModel('gpt-5.5', [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]),
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    supportedReasoningEfforts: codexReasoningEffortsForModel('gpt-5.4', [
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]),
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    supportedReasoningEfforts: codexReasoningEffortsForModel('gpt-5.4-mini', [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' }
    ]),
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',
    description: 'Research preview where available',
    supportedReasoningEfforts: codexReasoningEffortsForModel('gpt-5.3-codex-spark', [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' }
    ]),
    defaultReasoningEffort: 'low'
  }
  // gpt-5.2 and gpt-5.3-codex are HARD-retired (see CODEX_RETIRED_MODEL_IDS)
  // and intentionally omitted here.
]
const CLAUDE_REASONING_UNAVAILABLE = 'Not available for this Claude model'
const CLAUDE_FULL_REASONING_EFFORTS = [
  { reasoningEffort: 'low' },
  { reasoningEffort: 'medium' },
  { reasoningEffort: 'high' },
  { reasoningEffort: 'xhigh' },
  { reasoningEffort: 'max' },
  { reasoningEffort: 'ultracode' }
]
const claudeReasoningEfforts = (enabled: ReadonlySet<string>) =>
  CLAUDE_FULL_REASONING_EFFORTS.map((option) =>
    enabled.has(option.reasoningEffort)
      ? option
      : { ...option, disabled: true, disabledReason: CLAUDE_REASONING_UNAVAILABLE }
  )
const CLAUDE_OPUS_REASONING_EFFORTS = claudeReasoningEfforts(
  new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
)
const CLAUDE_SONNET_REASONING_EFFORTS = claudeReasoningEfforts(
  new Set(['low', 'medium', 'high', 'max'])
)
const CLAUDE_HAIKU_REASONING_EFFORTS = claudeReasoningEfforts(new Set())
export const CLAUDE_THINKING_BUDGET: Record<string, number> = {
  low: 2048,
  medium: 8000,
  high: 16000,
  xhigh: 32000,
  max: 64000,
  ultracode: 64000
}
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5'
const CLAUDE_FAST_MODE_MODEL_IDS: ReadonlySet<string> = new Set([
  'opus',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6'
])

/**
 * Canonical run-boundary guard for Claude's paid Fast mode. Picker metadata is
 * still model-specific, but persisted, remote, or forged payloads must pass
 * this allow-list before TaskWraith forwards the setting to Claude.
 */
export function claudeModelSupportsFastMode(modelId?: string | null): boolean {
  return CLAUDE_FAST_MODE_MODEL_IDS.has(
    normalizeCliProviderModel('claude', modelId).trim().toLowerCase()
  )
}

// NOTE: keep in sync with the renderer's CLAUDE_DEFAULT_MODELS (App.tsx).
// This list is served to the renderer via `getAgentModels('claude')` and
// becomes `agentModelsByProvider.claude`, which OVERRIDES the renderer's own
// fallback list — so a stale entry here is what the composer/welcome picker
// actually shows. `additionalSpeedTiers` must be carried through so the
// renderer knows which models offer the paid Fast tier.
// Labels intentionally OMIT the "Claude " prefix: the picker groups these
// under a CLAUDE section header and the composer chip prepends the provider
// name, so a prefixed label rendered as "Claude Claude Opus 5". Current
// models lead; the Legacy cluster (… Legacy) sits below them.
const CLAUDE_STATIC_MODELS = [
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    description: '1M context window — adaptive thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    description: '1M context window — adaptive thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: CLAUDE_DEFAULT_MODEL,
    label: 'Sonnet 5',
    description: '1M context window — extended thinking',
    isDefault: true,
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6 Legacy',
    description: '200K context window — legacy Sonnet',
    supportedReasoningEfforts: CLAUDE_SONNET_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium'
  },
  {
    id: 'claude-opus-4-8-1m',
    label: 'Opus 4.8 1M Legacy',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-opus-4-7-1m',
    label: 'Opus 4.7 1M Legacy',
    description: '1M context window — extended thinking',
    supportedReasoningEfforts: CLAUDE_OPUS_REASONING_EFFORTS,
    defaultReasoningEffort: 'medium',
    additionalSpeedTiers: ['fast']
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    description: 'Fast & efficient',
    supportedReasoningEfforts: CLAUDE_HAIKU_REASONING_EFFORTS
  },
  { id: 'custom', label: 'Custom model ID' }
]
export const KIMI_K3_REASONING_EFFORTS = ['low', 'high', 'max'] as const

const KIMI_STATIC_MODELS = [
  {
    id: 'kimi-k2.7-code',
    label: 'K2.7 Coding',
    description: 'Standard and Highspeed tiers with always-on thinking',
    isDefault: true,
    supportedReasoningEfforts: [{ reasoningEffort: 'on' }],
    defaultReasoningEffort: 'on',
    additionalSpeedTiers: ['fast']
  },
  {
    // Managed `kimi-code/k3` alias (2026-07-16): 256K on Moderato and up to 1M
    // on Allegretto+, with model-advertised Low/High/Max effort choices. No
    // Highspeed tier — Fast stays a K2.7 Coding capability.
    id: 'kimi-k3',
    label: 'K3',
    description:
      "Moonshot's flagship K3 - 256K on Moderato, up to 1M on Allegretto+ - Low, High, or Max thinking",
    supportedReasoningEfforts: KIMI_K3_REASONING_EFFORTS.map((reasoningEffort) => ({
      reasoningEffort
    })),
    defaultReasoningEffort: 'max'
  }
]
/** AntiGravity gemini-api (BYO-key) lane floor — mirrors the renderer's
 * ANTIGRAVITY_MODELS defaults and the contextWindows registrations. Live
 * discovery may widen this; it must never shrink below these rows. */
const ANTIGRAVITY_GEMINI_API_STATIC_MODELS = [
  {
    id: 'gemini-api:gemini-2.5-pro',
    label: 'Gemini 2.5 Pro (API)',
    description: 'Gemini API key lane · 1M context'
  },
  {
    id: 'gemini-api:gemini-2.5-flash',
    label: 'Gemini 2.5 Flash (API)',
    description: 'Gemini API key lane · 1M context',
    isDefault: true
  },
  {
    id: 'gemini-api:gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite (API)',
    description: 'Gemini API key lane · 1M context'
  },
  {
    id: 'gemini-api:gemini-2.0-flash',
    label: 'Gemini 2.0 Flash (API)',
    description: 'Gemini API key lane · 1M context'
  }
]

const OLLAMA_STATIC_MODELS = [
  {
    id: 'qwen3:4b-instruct',
    label: 'Qwen 3 (4B Param)',
    description: 'Local Ollama model · 262k context',
    isDefault: true
  },
  {
    id: 'qwen3.5:9b',
    label: 'Qwen 3.5 (9B Param)',
    description: 'Qwen 3.5 9B via Ollama · 262k context'
  },
  {
    id: 'qwen3.6:35b',
    label: 'Qwen 3.6 (35B-A3B)',
    description: 'Qwen 3.6 35B-A3B via Ollama · 262k context · vision/tools/thinking'
  },
  {
    id: 'gemma4:12b',
    label: 'Gemma 4 (12B Param)',
    description: 'Google Gemma 4 12B via Ollama · 262k context'
  },
  {
    id: 'ornith:9b',
    label: 'Ornith 1.0 (9B Param)',
    description: 'Ornith 1.0 9B via Ollama · 262k context · agentic coding'
  },
  {
    id: 'ornith:35b',
    label: 'Ornith 1.0 (35B Param)',
    description: 'Ornith 1.0 35B via Ollama · 262k context · agentic coding'
  },
  {
    id: 'laguna-xs-2.1:q8_0',
    label: 'Laguna XS 2.1 (33B-A3B Q8)',
    description: 'Poolside Laguna XS 2.1 33B-A3B Q8 via Ollama · 262k context · tools/thinking'
  },
  {
    id: 'gpt-oss:20b',
    label: 'GPT OSS (20B Param)',
    description: 'OpenAI gpt-oss 20B via Ollama · 131k context'
  },
  {
    id: 'minicpm-v4.5:8b',
    label: 'MiniCPM-V 4.5 (8B Param)',
    description: 'MiniCPM-V 4.5 8B via Ollama · 40k context · vision/tools/thinking'
  },
  {
    id: 'granite4.1:3b',
    label: 'Granite 4.1 (3B Param)',
    description: 'IBM Granite 4.1 3B via Ollama · 131k context · tools'
  },
  {
    id: 'granite4.1:30b',
    label: 'Granite 4.1 (30B Param)',
    description: 'IBM Granite 4.1 30B via Ollama · 131k context · tools'
  },
  {
    id: 'nemotron3:33b',
    label: 'Nemotron 3 Nano Omni (33B Param)',
    description: 'NVIDIA Nemotron 3 Nano Omni 33B via Ollama · 131k context · vision/tools/thinking'
  },
  { id: 'custom', label: 'Custom model ID' }
]
const GEMINI_STATIC_MODELS = [
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite', isDefault: true }
]
const GEMINI_DEFAULT_MODEL = 'flash-lite'
const GROK_DEFAULT_MODEL = GROK_45_MODEL_ID
const GROK_STATIC_MODELS = [
  {
    id: GROK_DEFAULT_MODEL,
    // Grok's CLI models are permanently Fast-mode, so the label reflects that.
    label: 'Grok 4.5 Fast',
    description: '500K context - low/medium/high reasoning',
    isDefault: true,
    supportedReasoningEfforts: [...GROK_45_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT
  },
  { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' }
]
const CURSOR_STATIC_MODELS = [
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast', isDefault: true },
  { id: 'composer-2.5', label: 'Composer 2.5' },
  {
    id: CURSOR_GROK_45_BASE_MODEL_ID,
    label: 'Grok 4.5',
    description: 'First-party Cursor model pool - 500K context',
    supportedReasoningEfforts: [...GROK_45_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT,
    additionalSpeedTiers: ['fast']
  }
]
const KIMI_DEFAULT_MODEL = 'kimi-k2.7-code'
const KIMI_STANDARD_API_MODEL = 'kimi-for-coding'
const KIMI_HIGHSPEED_API_MODEL = 'kimi-for-coding-highspeed'
// Kimi CLI's --model option resolves configured model aliases, not raw API
// model ids. OAuth-managed Kimi Code models use the stable `kimi-code/` key
// namespace in ~/.kimi/config.toml; passing only `kimi-for-coding` leaves the
// CLI without an LLM even though that is the correct third-party API model id.
export const KIMI_STANDARD_CLI_MODEL = `kimi-code/${KIMI_STANDARD_API_MODEL}`
export const KIMI_HIGHSPEED_CLI_MODEL = `kimi-code/${KIMI_HIGHSPEED_API_MODEL}`
const KIMI_K3_API_MODEL = 'k3'
export const KIMI_K3_CLI_MODEL = `kimi-code/${KIMI_K3_API_MODEL}`
const KIMI_CLI_MODEL_IDS = new Set([
  ...KIMI_STATIC_MODELS.map((model) => model.id),
  KIMI_STANDARD_CLI_MODEL,
  KIMI_HIGHSPEED_CLI_MODEL,
  KIMI_K3_CLI_MODEL
])
const KIMI_CLI_MODEL_ALIASES = new Map<string, string>([
  ['default', KIMI_DEFAULT_MODEL],
  ['cli-default', KIMI_DEFAULT_MODEL],
  ['custom', KIMI_DEFAULT_MODEL],
  ['best', KIMI_DEFAULT_MODEL],
  ['kimi-latest', KIMI_DEFAULT_MODEL],
  ['kimi-code', KIMI_DEFAULT_MODEL],
  [KIMI_STANDARD_API_MODEL, KIMI_STANDARD_CLI_MODEL],
  [KIMI_HIGHSPEED_API_MODEL, KIMI_HIGHSPEED_CLI_MODEL],
  // K3's raw API id and managed CLI alias both resolve to the canonical
  // TaskWraith id; 'kimi-k3' itself passes through via KIMI_CLI_MODEL_IDS.
  [KIMI_K3_API_MODEL, 'kimi-k3'],
  [KIMI_K3_CLI_MODEL, 'kimi-k3'],
  ['kimi-k2.7', KIMI_DEFAULT_MODEL],
  ['kimi-k2.7-code', KIMI_DEFAULT_MODEL],
  ['kimi-k2.7-code-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2.7-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2.6', KIMI_DEFAULT_MODEL],
  ['kimi-k2.6-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2', KIMI_DEFAULT_MODEL],
  ['kimi-k2-1t', KIMI_DEFAULT_MODEL],
  ['kimi-thinking-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2.5', KIMI_DEFAULT_MODEL],
  ['kimi-k2-thinking-turbo', KIMI_DEFAULT_MODEL],
  ['kimi-k2-thinking', KIMI_DEFAULT_MODEL],
  ['kimi-k2-turbo-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0905-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0711-preview', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0905', KIMI_DEFAULT_MODEL],
  ['kimi-k2-0711', KIMI_DEFAULT_MODEL],
  ['kimi-k2-turbo', KIMI_DEFAULT_MODEL]
])

export function isKimiK3Model(model?: string | null): boolean {
  const normalized = String(model || '')
    .trim()
    .toLowerCase()
  return (
    normalized === 'kimi-k3' ||
    normalized === KIMI_K3_API_MODEL ||
    normalized === KIMI_K3_CLI_MODEL
  )
}

/** K3 defaults to Max; K2.7 Coding has no configurable effort axis. */
export function normalizeKimiReasoningEffort(
  model?: string | null,
  effort?: string | null
): (typeof KIMI_K3_REASONING_EFFORTS)[number] | null {
  if (!isKimiK3Model(model)) return null
  const normalized = String(effort || '')
    .trim()
    .toLowerCase()
  return KIMI_K3_REASONING_EFFORTS.includes(
    normalized as (typeof KIMI_K3_REASONING_EFFORTS)[number]
  )
    ? (normalized as (typeof KIMI_K3_REASONING_EFFORTS)[number])
    : 'max'
}

/** Value exposed by Kimi Code's ACP `thinking` session config option. */
export function kimiAcpThinkingConfigValue(
  model?: string | null,
  effort?: string | null
): string {
  return normalizeKimiReasoningEffort(model, effort) || 'on'
}

export function getStaticProviderModels(
  provider: ProviderId,
  options: StaticProviderModelOptions = {}
) {
  const models =
    provider === 'codex'
      ? activeCodexModelRows(CODEX_STATIC_MODELS)
      : provider === 'claude'
        ? CLAUDE_STATIC_MODELS
        : provider === 'kimi'
          ? KIMI_STATIC_MODELS
          : provider === 'ollama'
            ? OLLAMA_STATIC_MODELS
            : provider === 'gemini'
              ? GEMINI_STATIC_MODELS
              : provider === 'grok'
                ? GROK_STATIC_MODELS
                : provider === 'cursor'
                  ? CURSOR_STATIC_MODELS
                  : provider === 'antigravity'
                    // Official agy-CLI rows stay discovery-owned (S4), but the
                    // BYO-key gemini-api sub-lane gets a deterministic static
                    // floor so ensemble catalogs and fallbacks are never
                    // model-less. The `gemini-api:` prefix is load-bearing —
                    // dispatch routes on it.
                    ? ANTIGRAVITY_GEMINI_API_STATIC_MODELS
                    : GEMINI_STATIC_MODELS
  if (!options.includePreviewModels) return models
  const previews = previewModelsForProvider(provider)
  if (previews.length === 0) return models
  // PREVIEW_MODEL_CATALOG is empty since the GPT-5.6 trio graduated to
  // first-class CODEX_STATIC_MODELS rows (2026-07-09), so this path is
  // currently inert — kept for the NEXT preview family: codex previews lead
  // the list; other providers append previews after their static rows.
  return provider === 'codex'
    ? [...previews.map(previewModelForPicker), ...models]
    : [...models, ...previews.map(previewModelForPicker)]
}

export function normalizeCliProviderModel(provider: ProviderId, model?: string | null): string {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  const lowered = trimmed.toLowerCase()
  if (provider === 'codex') {
    return normalizeCodexModel(trimmed)
  }
  if (provider === 'kimi') {
    if (!lowered) return KIMI_DEFAULT_MODEL
    const alias = KIMI_CLI_MODEL_ALIASES.get(lowered)
    if (alias) return alias
    if (KIMI_CLI_MODEL_IDS.has(lowered)) return lowered
    return KIMI_DEFAULT_MODEL
  }
  if (provider === 'ollama') {
    if (!trimmed || trimmed === 'cli-default' || trimmed === 'auto' || trimmed === 'default') {
      return OLLAMA_STATIC_MODELS[0].id
    }
    return trimmed
  }
  if (provider === 'grok') {
    if (!trimmed || lowered === 'cli-default' || lowered === 'default') return GROK_DEFAULT_MODEL
    if (lowered === 'grok-build' || lowered === 'grok-build-0.1') return GROK_DEFAULT_MODEL
    if (lowered.startsWith('grok')) return trimmed
    return GROK_DEFAULT_MODEL
  }
  if (provider === 'cursor') {
    if (!trimmed || lowered === 'cli-default' || lowered === 'default') return 'composer-2.5-fast'
    if (trimmed.startsWith('composer-')) return trimmed
    if (isCursorGrok45ModelId(trimmed)) return CURSOR_GROK_45_BASE_MODEL_ID
    return 'composer-2.5-fast'
  }
  if (provider === 'gemini') {
    if (!trimmed || lowered === 'cli-default' || lowered === 'default') return GEMINI_DEFAULT_MODEL
    return trimmed
  }
  if (provider === 'antigravity') {
    // S3 intentionally has no static AntiGravity model catalogue. Preserve a
    // provider-reported/model-payload value for the official CLI and use the
    // honest CLI-default sentinel until S4 owns authenticated discovery.
    if (!trimmed || lowered === 'cli-default' || lowered === 'default' || lowered === 'auto') {
      return 'cli-default'
    }
    return trimmed
  }
  if (provider === 'claude') {
    if (
      !trimmed ||
      lowered === 'cli-default' ||
      lowered === 'default' ||
      lowered === 'custom' ||
      lowered === 'best'
    ) {
      return CLAUDE_DEFAULT_MODEL
    }
    if (isPreviewModelPlaceholder(lowered)) return CLAUDE_DEFAULT_MODEL
    // Any stale preview-namespaced id (e.g. a persisted
    // `preview:anthropic:claude-sonnet-5` from before Sonnet 5 went GA) maps
    // to the concrete default — it is never a valid CLI/SDK model name.
    if (lowered.startsWith('preview:')) return CLAUDE_DEFAULT_MODEL
    if (lowered === 'fable') return 'claude-fable-5'
    if (lowered === 'mythos') return 'claude-mythos-5'
    if (['sonnet', 'opus', 'haiku'].includes(lowered)) return lowered
    if (trimmed.startsWith('claude-')) {
      // The `-1m` suffix is an TaskWraith-internal marker for the 1M-context
      // variant — it drives the context-window meter (contextWindows.ts) and
      // the rate table, but it is NOT a real Claude CLI/SDK model name. The
      // CLI only accepts the base id (e.g. `claude-opus-4-8`), so `--model
      // claude-opus-4-8-1m` fails with "model not found". Strip it here so the
      // base model is dispatched (the 1M window is entitlement-based on the
      // base model, not a distinct model id).
      return trimmed.endsWith('-1m') ? trimmed.slice(0, -'-1m'.length) : trimmed
    }
  }
  if (!trimmed || trimmed === 'cli-default' || trimmed === 'custom' || trimmed === 'best')
    return 'default'
  return trimmed || 'default'
}

export function appendKimiThinkingArgs(args: string[], kimiThinking?: boolean | null): void {
  args.push(kimiThinking === false ? '--no-thinking' : '--thinking')
}

function kimiCliModelArg(model: string, serviceTier?: string | null): string | null {
  const normalized = model.trim().toLowerCase()
  // Resolve K3 before the tier switch: it has no speed tiers, so a stale or
  // queued Fast flag must never silently reroute a K3 run onto the K2.7
  // HighSpeed alias.
  if (
    normalized === 'kimi-k3' ||
    normalized === KIMI_K3_API_MODEL ||
    normalized === KIMI_K3_CLI_MODEL
  ) {
    return KIMI_K3_CLI_MODEL
  }
  if (serviceTier === 'fast') return KIMI_HIGHSPEED_CLI_MODEL
  if (serviceTier === 'standard') return KIMI_STANDARD_CLI_MODEL
  if (!normalized || normalized === 'default' || normalized === KIMI_DEFAULT_MODEL) return null
  return model
}

/** Exact model value understood by Kimi Code's ACP config picker. Unlike the
 * CLI argv helper, this must be explicit for the default model because a
 * resumed session's persisted model takes precedence over process defaults. */
export function kimiAcpModelConfigValue(model: string, serviceTier?: string | null): string {
  return kimiCliModelArg(model, serviceTier) || KIMI_STANDARD_CLI_MODEL
}

export function appendKimiModelArgs(
  args: string[],
  model: string,
  serviceTier?: string | null
): void {
  const cliModel = kimiCliModelArg(model, serviceTier)
  if (cliModel) args.push('--model', cliModel)
}

export function claudePermissionModeForApproval(approvalMode?: string): string {
  if (approvalMode === 'plan') return 'plan'
  return 'acceptEdits'
}

export function normalizeCodexModel(model?: string | null): string {
  const trimmed = typeof model === 'string' ? model.trim() : ''
  // A stale preview:… placeholder id (persisted before the GPT-5.6 trio became
  // selectable) maps to its concrete slug, not to the default model.
  const placeholderConcrete = concreteModelForPreviewPlaceholder(trimmed)
  if (placeholderConcrete) return placeholderConcrete
  if (
    !trimmed ||
    ['cli-default', 'auto', 'pro', 'flash', 'flash-lite', 'custom'].includes(trimmed) ||
    isPreviewModelPlaceholder(trimmed)
  ) {
    // Explicit default, NOT [0]: the GPT-5.6 trio leads CODEX_STATIC_MODELS
    // but is still ramping account-by-account, so unresolved ids must keep
    // falling back to the universally-available default.
    return CODEX_DEFAULT_MODEL_ID
  }
  return trimmed
}

export function codexModelContextConfig(model?: string | null): CodexModelContextConfig | null {
  const config = CODEX_MODEL_CONTEXT_CONFIGS[normalizeCodexModel(model)]
  return config ? { ...config } : null
}

function previewModelForPicker(entry: PreviewModelCatalogEntry) {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    disabled: entry.disabled,
    disabledReason: entry.disabledReason,
    hidden: false,
    runnable: entry.runnable,
    accessState: entry.accessState,
    previewFamily: entry.previewFamily,
    previewRole: entry.previewRole,
    ...(entry.supportedReasoningEfforts
      ? { supportedReasoningEfforts: entry.supportedReasoningEfforts }
      : {}),
    ...(entry.defaultReasoningEffort
      ? { defaultReasoningEffort: entry.defaultReasoningEffort }
      : {}),
    ...(entry.additionalSpeedTiers ? { additionalSpeedTiers: entry.additionalSpeedTiers } : {})
  }
}
