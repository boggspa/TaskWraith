/*
 * ensembleProviderDefaults — per-provider model + reasoning + fast-tier
 * options for the ensemble participant chip flyouts. Mirrors the
 * defaults baked into App.tsx (CODEX_DEFAULT_MODELS,
 * CLAUDE_DEFAULT_MODELS, GEMINI_DEFAULT_MODELS, KIMI_DEFAULT_MODELS)
 * but stays in a small standalone module so the consumer doesn't
 * need to import from App.tsx (which would invert the dependency
 * direction).
 *
 * Originally landed in Slice D (1.0.3) for the EnsembleSetupSheet
 * modal's per-row pickers; carried forward in Slice F (1.0.3) when
 * that modal retired and the per-participant pickers moved into
 * EnsembleParticipantsAboveRow chip flyouts.
 *
 * Note: the renderer's authoritative model list lives in App.tsx's
 * `agentModelsByProvider` state (which can be hydrated from server-side
 * configuration). The setup sheet uses these defaults only — if a user
 * has a custom model that isn't in this list, the chip will still
 * render its label (CombinedModelPicker falls back to the modelId). The
 * orchestrator dispatch passes the raw `participant.model` string to
 * the provider adapter unchanged, so custom IDs still work.
 */

import type {
  CombinedModelPickerModelOption,
  CombinedModelPickerReasoningOption
} from './combinedModelPickerTypes'
import type { EnsembleParticipant, PermissionPresetId, ProviderId } from '../../../main/store/types'
import { codexReasoningDisplayLabel, claudeReasoningDisplayLabel } from './composerChipFormat'
import {
  CLAUDE_DEFAULT_MODELS,
  CODEX_DEFAULT_MODELS,
  type CodexModelOption
} from './providerModelDefaults'
import {
  CURSOR_GROK_45_BASE_MODEL_ID,
  GROK_45_DEFAULT_REASONING_EFFORT,
  GROK_45_MODEL_ID,
  isGrok45ReasoningModelId
} from '../../../shared/grok45Models'

export interface EnsembleModelDefaults {
  modelOptions: CombinedModelPickerModelOption[]
  reasoningOptions: CombinedModelPickerReasoningOption[]
  /**
   * Default reasoning value when no participant.reasoningEffort is set.
   * For Kimi this is the value that maps to thinkingEnabled=true.
   */
  defaultReasoning: string
  /**
   * Model IDs that support the paid Fast tier (lightning bolt + toggle).
   * Empty set means the toggle row stays hidden.
   */
  fastModeCapableModelIds: Set<string>
  /** Default model id when participant.model is unset. */
  defaultModelId: string
}

const CODEX_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'low', label: codexReasoningDisplayLabel('low') },
  { value: 'medium', label: codexReasoningDisplayLabel('medium') },
  { value: 'high', label: codexReasoningDisplayLabel('high') },
  { value: 'xhigh', label: codexReasoningDisplayLabel('xhigh') }
]
// Official GPT-5.6 tiers (2026-07-09): `max` on all three trio models; the top
// `ultra` tier (internal token 'ultracode', displayed "Ultra") on Sol + Terra
// only — Luna stops at max.
const CODEX_TRIO_FULL_REASONING: CombinedModelPickerReasoningOption[] = [
  ...CODEX_REASONING,
  { value: 'max', label: codexReasoningDisplayLabel('max') },
  { value: 'ultracode', label: codexReasoningDisplayLabel('ultracode') }
]
const CODEX_TRIO_MAX_REASONING: CombinedModelPickerReasoningOption[] = [
  ...CODEX_REASONING,
  { value: 'max', label: codexReasoningDisplayLabel('max') }
]

const CLAUDE_REASONING_UNAVAILABLE = 'Not available for this Claude model'
const CLAUDE_FULL_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'low', label: claudeReasoningDisplayLabel('low') },
  { value: 'medium', label: claudeReasoningDisplayLabel('medium') },
  { value: 'high', label: claudeReasoningDisplayLabel('high') },
  { value: 'xhigh', label: claudeReasoningDisplayLabel('xhigh') },
  { value: 'max', label: claudeReasoningDisplayLabel('max') },
  { value: 'ultracode', label: claudeReasoningDisplayLabel('ultracode') }
]
const claudeReasoningOptions = (
  enabled: ReadonlySet<string>
): CombinedModelPickerReasoningOption[] =>
  CLAUDE_FULL_REASONING.map((option) =>
    enabled.has(option.value)
      ? option
      : { ...option, disabled: true, disabledReason: CLAUDE_REASONING_UNAVAILABLE }
  )
const CLAUDE_SONNET_REASONING = claudeReasoningOptions(new Set(['low', 'medium', 'high', 'max']))
const CLAUDE_OPUS_REASONING = claudeReasoningOptions(
  new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
)
const CLAUDE_HAIKU_REASONING = claudeReasoningOptions(new Set())

const KIMI_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'on', label: 'Thinking on' },
  { value: 'off', label: 'Thinking off' }
]

// Grok 4.5 exposes low/medium/high only; GrokCliArgs.normalizeGrokEffortFlag
// is the dispatch-side guard.
const GROK_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

const CODEX_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  // GPT-5.6 trio — GA 2026-07-09, official hyphenated display names. Dispatch
  // errors cleanly if the user's account hasn't been ramped into the staged
  // rollout yet (the id is simply absent from that account's live model/list).
  { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' }
  // gpt-5.2 and gpt-5.3-codex are HARD-retired (the API rejects requests) and
  // removed from the ensemble Codex picker. Historical/cost lookups elsewhere
  // (modelDisplayName, contextWindows, ProviderRateService) keep their entries.
]

const CLAUDE_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'claude-opus-4-8-1m', label: 'Claude Opus 4.8 1M' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 Legacy' },
  { id: 'claude-opus-4-7-1m', label: 'Claude Opus 4.7 1M' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
]

const GEMINI_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite' }
]

const KIMI_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }
]

// Grok — mirrors App.tsx GROK_DEFAULT_MODELS. Keep Grok Composer separate from
// Cursor's `composer-2.5-fast` because it dispatches through Grok Build CLI auth.
const GROK_MODELS: CombinedModelPickerModelOption[] = [
  { id: GROK_45_MODEL_ID, label: 'Grok 4.5 Fast' },
  { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' }
]

// Cursor — Composer 2.5 plus Cursor Grok 4.5. Grok 4.5 is one friendly row in
// the UI; dispatch maps reasoning/Fast to Cursor's concrete grok-4.5-* ids.
const CURSOR_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { id: 'composer-2.5', label: 'Composer 2.5' },
  { id: CURSOR_GROK_45_BASE_MODEL_ID, label: 'Cursor Grok 4.5' }
]

const OLLAMA_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)' },
  { id: 'qwen3.6:35b', label: 'Qwen 3.6 (35B-A3B)' },
  { id: 'gemma4:12b', label: 'Gemma 4 (12B Param)' },
  { id: 'ornith:9b', label: 'Ornith 1.0 (9B Param)' },
  { id: 'ornith:35b', label: 'Ornith 1.0 (35B Param)' },
  { id: 'laguna-xs-2.1:q8_0', label: 'Laguna XS 2.1 (33B-A3B Q8)' },
  { id: 'gpt-oss:20b', label: 'GPT OSS (20B Param)' },
  { id: 'lfm2.5:8b', label: 'LFM 2.5 (8B-A1B)' },
  { id: 'minicpm-v4.5:8b', label: 'MiniCPM-V 4.5 (8B Param)' },
  { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)' },
  { id: 'granite4.1:30b', label: 'Granite 4.1 (30B Param)' },
  { id: 'nemotron3:33b', label: 'Nemotron 3 Nano Omni (33B Param)' }
]

const CODEX_FAST_CAPABLE = new Set<string>([
  'gpt-5.5',
  'gpt-5.4',
  // GPT-5.6 trio (GA, 5.5 parity) — all expose the Fast speed tier
  // (additionalSpeedTiers:['fast'] in the preview catalog); the solo composer
  // derives Fast dynamically from that field, so mirror it here for ensemble seats.
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna'
])
// Claude Fast mode is limited to supported Opus models. Fable 5 deliberately
// keeps its full reasoning ladder but does not expose the paid Fast toggle.
const CLAUDE_FAST_CAPABLE = new Set<string>([
  'claude-opus-4-8-1m',
  'claude-opus-4-7-1m'
])
const CURSOR_FAST_CAPABLE = new Set<string>([
  'composer-2.5',
  'composer-2.5-fast',
  CURSOR_GROK_45_BASE_MODEL_ID
])
// Both Grok models run permanently in Fast mode. This set only drives the
// picker's Fast ⚡ glyph — Grok passes no onToggleFastMode, so no toggle row
// renders and no fast-clearing runs on model switch.
const GROK_FAST_CAPABLE = new Set<string>([GROK_45_MODEL_ID, 'grok-composer-2.5-fast'])

function isClaudeFullReasoningModel(modelId?: string | null): boolean {
  const normalized = String(modelId || '').toLowerCase()
  return (
    normalized.includes('opus') || normalized.includes('fable') || normalized.includes('mythos')
  )
}

// Sonnet 5 exposes the full Opus-equivalent reasoning ladder (unlike the
// legacy Sonnet 4.x line, which is capped at low/medium/high/max). Matches the
// Sonnet 5 family — `claude-sonnet-5` and future variants like
// `claude-sonnet-5-1m` — while the trailing non-digit guard avoids colliding
// with a numeric lookalike such as `claude-sonnet-50`.
const CLAUDE_SONNET_5_FAMILY = /sonnet-5(?![0-9])/
function isClaudeSonnet5Model(modelId?: string | null): boolean {
  return CLAUDE_SONNET_5_FAMILY.test(String(modelId || '').toLowerCase())
}

function isClaudeHaikuModel(modelId?: string | null): boolean {
  return String(modelId || '')
    .toLowerCase()
    .includes('haiku')
}

export function getEnsembleReasoningOptions(
  provider: ProviderId,
  modelId?: string | null
): CombinedModelPickerReasoningOption[] {
  switch (provider) {
    case 'codex': {
      // Mirrors main's codexModelSupportsMaxReasoning / -UltracodeReasoning
      // (official 2026-07-09 tiers): Sol + Terra get max + ultra('ultracode');
      // Luna gets max only; everything else stops at xhigh. Stale
      // pre-un-gate placeholder ids count as their concrete slugs.
      const codexModel = String(modelId || '').toLowerCase()
      if (
        codexModel === 'gpt-5.6-sol' ||
        codexModel === 'gpt-5.6-terra' ||
        codexModel === 'preview:openai:gpt-5.6:sol' ||
        codexModel === 'preview:openai:gpt-5.6:terra'
      ) {
        return CODEX_TRIO_FULL_REASONING
      }
      if (codexModel === 'gpt-5.6-luna' || codexModel === 'preview:openai:gpt-5.6:luna') {
        return CODEX_TRIO_MAX_REASONING
      }
      return CODEX_REASONING
    }
    case 'claude':
      if (isClaudeHaikuModel(modelId)) return CLAUDE_HAIKU_REASONING
      return isClaudeFullReasoningModel(modelId) || isClaudeSonnet5Model(modelId)
        ? CLAUDE_OPUS_REASONING
        : CLAUDE_SONNET_REASONING
    case 'kimi':
      return KIMI_REASONING
    case 'grok':
      return isGrok45ReasoningModelId(modelId) ? GROK_REASONING : []
    case 'cursor':
      return modelId === CURSOR_GROK_45_BASE_MODEL_ID ? GROK_REASONING : []
    default:
      return []
  }
}

/**
 * Canonical seed config for a new ensemble participant. Mirrors the
 * fallback values that used to be scattered across:
 *   - `src/main/EnsembleDefaults.ts` (initial `model` + `permissionPresetId`)
 *   - `App.tsx` composer pickers (`reasoningEffort || 'medium'`, etc.)
 *   - `EnsembleOrchestrator.ts` dispatch (`participant.model || 'cli-default'`)
 *
 * Used both for seeding (when adding a participant) and for resolving
 * the effective per-participant settings the composer pickers display.
 *
 * Field shape matches the `EnsembleParticipant` interface in
 * `src/main/store/types.ts` (around line 206). `reasoningEffort`,
 * `fastModeEnabled`, `thinkingEnabled`, and `serviceTier` are optional
 * on the participant record itself — this helper resolves them to
 * concrete defaults so call-sites don't need to repeat the fallback
 * logic.
 *
 * New participants persist concrete provider defaults rather than a generic
 * `cli-default` sentinel, so the picker never needs to expose a fake Default
 * row and dispatch does not depend on provider-native defaults drifting.
 *
 * Every live provider seeds with `permissionPresetId: 'default'` (the
 * "Default Approval" preset). A freshly added participant is fully
 * deterministic — model, reasoning, thinking, approval — regardless of which
 * participant happened to be selected when the user hit "+". Roster presets
 * and the Agent Pool are the only paths that carry participant config over.
 * (The seeded default panel in `src/main/EnsembleDefaults.ts` keeps its
 * curated writer/reader preset split — that panel is effectively a built-in
 * preset, and read-only recon fan-out relies on it.)
 */
export interface DefaultEnsembleParticipantConfig {
  model: string
  permissionPresetId: PermissionPresetId
  reasoningEffort?: string
  fastModeEnabled?: boolean
  thinkingEnabled?: boolean
  serviceTier?: string
}

export function getDefaultEnsembleParticipantConfig(
  provider: ProviderId
): DefaultEnsembleParticipantConfig {
  switch (provider) {
    case 'codex':
      return {
        model: 'gpt-5.5',
        permissionPresetId: 'default',
        reasoningEffort: 'medium',
        fastModeEnabled: false,
        serviceTier: ''
      }
    case 'claude':
      return {
        model: 'claude-sonnet-5',
        permissionPresetId: 'default',
        reasoningEffort: 'medium',
        fastModeEnabled: false
      }
    case 'gemini':
      // Retired provider — kept only so legacy participants resolve; not
      // part of the deterministic new-participant matrix.
      return {
        model: 'flash-lite',
        permissionPresetId: 'read_only'
      }
    case 'kimi':
      return {
        model: 'kimi-k2.7-code',
        permissionPresetId: 'default',
        thinkingEnabled: true
      }
    case 'grok':
      // Default Approval like every other seed; the Grok seat itself is
      // still toolless at dispatch, so the preset only matters if the user
      // later swaps the row to a tool-capable provider config.
      return {
        model: GROK_45_MODEL_ID,
        permissionPresetId: 'default',
        reasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT
      }
    case 'cursor':
      return {
        model: 'composer-2.5-fast',
        permissionPresetId: 'default',
        fastModeEnabled: true
      }
    case 'ollama':
      return {
        model: 'qwen3.5:9b',
        permissionPresetId: 'default'
      }
    default:
      return {
        model: 'gpt-5.5',
        permissionPresetId: 'default'
      }
  }
}

/**
 * Deterministic default role name for a freshly added participant. Matches
 * the provider display name except Ollama, which reads "Local" (mirrors the
 * seeded default panel in `src/main/EnsembleDefaults.ts`). The chip strip
 * suffixes " 2", " 3", … when the name is already taken, so two Claude seats
 * become "Claude" / "Claude 2" — never a clone of the selected chip's role.
 */
export function getDefaultEnsembleRoleName(provider: ProviderId): string {
  switch (provider) {
    case 'codex':
      return 'Codex'
    case 'claude':
      return 'Claude'
    case 'kimi':
      return 'Kimi'
    case 'grok':
      return 'Grok'
    case 'cursor':
      return 'Cursor'
    case 'ollama':
      return 'Local'
    default:
      return 'Gemini'
  }
}

/**
 * Patch to apply when a participant's PROVIDER changes in an editor. Resets
 * every provider-specific field to the new provider's defaults so a stale
 * cross-provider value can't survive (e.g. a Claude model id on a Codex
 * participant). Critically it also clears `permissionOverrides` and
 * `runtimeProfileId`: the composer's live-chat provider-change handler omits
 * `permissionOverrides`, which — because participant patches shallow-merge —
 * silently leaks the previous provider's tool grants onto the new provider.
 * Each field is present in the returned patch (with an explicit `undefined`
 * where it should clear) so a `{ ...participant, ...patch }` shallow merge
 * actually removes the old value rather than retaining it.
 */
export function buildProviderChangeParticipantPatch(
  provider: ProviderId
): Partial<EnsembleParticipant> {
  const defaults = getDefaultEnsembleParticipantConfig(provider)
  return {
    provider,
    model: defaults.model,
    runtimeProfileId: undefined,
    geminiAuthProfileId: null,
    permissionPresetId: defaults.permissionPresetId,
    permissionOverrides: undefined,
    reasoningEffort: defaults.reasoningEffort,
    fastModeEnabled: defaults.fastModeEnabled,
    thinkingEnabled: defaults.thinkingEnabled,
    serviceTier: defaults.serviceTier,
    linkedProviderSessionId: null
  }
}

/**
 * The model-level metadata needed to seed a freshly selected model. The live
 * Codex/Claude catalogs use this same shape; callers selecting a static model
 * may omit it and the renderer fallbacks are consulted instead.
 */
export type ProviderModelSelectionMetadata = Pick<
  CodexModelOption,
  'supportedReasoningEfforts' | 'defaultReasoningEffort' | 'additionalSpeedTiers'
>

/**
 * Provider-scoped participant fields normalized for one explicit model.
 * Irrelevant settings are intentionally present as `undefined`: this object is
 * also a shallow-merge patch, so those keys must clear values left by the
 * previously selected provider/model rather than silently preserving them.
 */
export type ProviderModelSelectionFields = Pick<
  Partial<EnsembleParticipant>,
  'model' | 'reasoningEffort' | 'fastModeEnabled' | 'thinkingEnabled' | 'serviceTier'
>

function normalizeReasoningEffortToken(value?: string | null): string {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (normalized === 'light') return 'low'
  if (normalized === 'extra') return 'xhigh'
  if (normalized === 'ultra') return 'ultracode'
  return normalized
}

function fallbackModelSelectionMetadata(
  provider: ProviderId,
  model: string
): ProviderModelSelectionMetadata | undefined {
  if (provider === 'codex') {
    return CODEX_DEFAULT_MODELS.find((option) => option.id === model)
  }
  if (provider === 'claude') {
    return CLAUDE_DEFAULT_MODELS.find((option) => option.id === model)
  }
  return undefined
}

function enabledReasoningEffortsForModel(
  provider: ProviderId,
  model: string,
  metadata?: ProviderModelSelectionMetadata | null
): string[] {
  const source = metadata?.supportedReasoningEfforts
  const values = source
    ? source
        .filter((option) => !option.disabled)
        .map((option) => normalizeReasoningEffortToken(option.reasoningEffort))
    : getEnsembleReasoningOptions(provider, model)
        .filter((option) => !option.disabled)
        .map((option) => normalizeReasoningEffortToken(option.value))
  return [...new Set(values.filter(Boolean))]
}

function defaultReasoningEffortForModel(
  provider: ProviderId,
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null
): string | undefined {
  const fallbackMetadata = fallbackModelSelectionMetadata(provider, model)
  const metadata = modelMetadata ? { ...fallbackMetadata, ...modelMetadata } : fallbackMetadata
  const enabled = enabledReasoningEffortsForModel(provider, model, metadata)
  if (enabled.length === 0) return undefined

  const modelDefault = normalizeReasoningEffortToken(metadata?.defaultReasoningEffort)
  if (modelDefault && enabled.includes(modelDefault)) return modelDefault

  const providerDefault = normalizeReasoningEffortToken(
    getDefaultEnsembleParticipantConfig(provider).reasoningEffort
  )
  if (providerDefault && enabled.includes(providerDefault)) return providerDefault
  if (enabled.includes('medium')) return 'medium'
  return enabled[0]
}

/**
 * Canonical fresh/provider-switch state for an explicit provider + model pair.
 * This encodes the same model-sensitive rules as the composer:
 *
 * - Codex/Claude start with Fast off and the model's enabled default reasoning.
 * - Kimi starts with thinking on and has no reasoning effort field.
 * - Grok's Fast posture is encoded by its provider/model route, not a toggle;
 *   only Grok 4.5 carries a reasoning effort.
 * - Cursor Composer 2.5 expresses Fast through the model id, while Cursor Grok
 *   starts with its reasoning default and the optional Fast toggle off.
 */
export function normalizeProviderModelSelection(
  provider: ProviderId,
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null
): ProviderModelSelectionFields {
  const cleared: ProviderModelSelectionFields = {
    model,
    reasoningEffort: undefined,
    fastModeEnabled: undefined,
    thinkingEnabled: undefined,
    serviceTier: undefined
  }

  switch (provider) {
    case 'codex':
      return {
        ...cleared,
        reasoningEffort: defaultReasoningEffortForModel(provider, model, modelMetadata),
        fastModeEnabled: false,
        serviceTier: ''
      }
    case 'claude':
      return {
        ...cleared,
        reasoningEffort: defaultReasoningEffortForModel(provider, model, modelMetadata),
        fastModeEnabled: false
      }
    case 'kimi':
      return { ...cleared, thinkingEnabled: true }
    case 'grok':
      return {
        ...cleared,
        reasoningEffort: isGrok45ReasoningModelId(model)
          ? GROK_45_DEFAULT_REASONING_EFFORT
          : undefined
      }
    case 'cursor':
      if (model === CURSOR_GROK_45_BASE_MODEL_ID) {
        return {
          ...cleared,
          reasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT,
          fastModeEnabled: false
        }
      }
      return { ...cleared, fastModeEnabled: model === 'composer-2.5-fast' }
    default:
      return cleared
  }
}

/**
 * One atomic participant patch for selecting a model from any provider group.
 * Provider/session/grant hygiene comes from `buildProviderChangeParticipantPatch`;
 * the explicit model fields then override that provider's generic seed values.
 */
export function buildProviderModelChangeParticipantPatch(
  provider: ProviderId,
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null
): Partial<EnsembleParticipant> {
  return {
    ...buildProviderChangeParticipantPatch(provider),
    ...normalizeProviderModelSelection(provider, model, modelMetadata)
  }
}

/**
 * Resolve a participant's effective settings by layering its stored
 * fields on top of `getDefaultEnsembleParticipantConfig`. The returned
 * object always has concrete (non-undefined) values for the
 * provider-relevant fields so consumers can read directly without
 * repeating fallback chains.
 *
 * - `reasoningEffort`: empty string for providers without a reasoning
 *   axis (Gemini); otherwise the participant's value or the canonical
 *   provider default.
 * - `serviceTier`: empty string when not the paid Fast tier. Codex
 *   participants infer `'fast'` from `fastModeEnabled` if `serviceTier`
 *   itself is unset, matching the existing renderer fallback in
 *   `App.tsx` and the orchestrator dispatch.
 */
export interface ResolvedEnsembleParticipantSettings {
  provider: ProviderId
  model: string
  permissionPresetId: PermissionPresetId
  reasoningEffort: string
  fastModeEnabled: boolean
  thinkingEnabled: boolean
  serviceTier: string
}

export function resolveEnsembleParticipantSettings(
  participant: Pick<
    EnsembleParticipant,
    | 'provider'
    | 'model'
    | 'permissionPresetId'
    | 'reasoningEffort'
    | 'fastModeEnabled'
    | 'thinkingEnabled'
    | 'serviceTier'
  >
): ResolvedEnsembleParticipantSettings {
  const defaults = getDefaultEnsembleParticipantConfig(participant.provider)
  const model = participant.model || defaults.model
  const permissionPresetId = participant.permissionPresetId || defaults.permissionPresetId
  const reasoningOptions =
    participant.provider === 'kimi' ? [] : getEnsembleReasoningOptions(participant.provider, model)
  const enabledReasoningOptions = reasoningOptions.filter((option) => !option.disabled)
  const reasoningValues = new Set(enabledReasoningOptions.map((option) => option.value))
  const reasoningEffort =
    enabledReasoningOptions.length === 0
      ? ''
      : participant.reasoningEffort && reasoningValues.has(participant.reasoningEffort)
        ? participant.reasoningEffort
        : defaults.reasoningEffort && reasoningValues.has(defaults.reasoningEffort)
          ? defaults.reasoningEffort
          : (enabledReasoningOptions[0]?.value ?? '')
  const fastModeEnabled = Boolean(participant.fastModeEnabled ?? defaults.fastModeEnabled)
  const thinkingEnabled = Boolean(participant.thinkingEnabled ?? defaults.thinkingEnabled)
  // Codex serviceTier: respect explicit value, else infer 'fast' from
  // fastModeEnabled (mirrors the existing renderer + dispatch fallback).
  const serviceTier =
    participant.serviceTier ?? (fastModeEnabled ? 'fast' : (defaults.serviceTier ?? ''))
  return {
    provider: participant.provider,
    model,
    permissionPresetId,
    reasoningEffort,
    fastModeEnabled,
    thinkingEnabled,
    serviceTier
  }
}

export function getEnsembleModelDefaults(provider: ProviderId): EnsembleModelDefaults {
  switch (provider) {
    case 'codex':
      return {
        modelOptions: CODEX_MODELS,
        reasoningOptions: CODEX_REASONING,
        defaultReasoning: 'medium',
        fastModeCapableModelIds: CODEX_FAST_CAPABLE,
        defaultModelId: 'gpt-5.5'
      }
    case 'claude':
      return {
        modelOptions: CLAUDE_MODELS,
        reasoningOptions: getEnsembleReasoningOptions('claude', 'claude-sonnet-5'),
        defaultReasoning: 'medium',
        fastModeCapableModelIds: CLAUDE_FAST_CAPABLE,
        defaultModelId: 'claude-sonnet-5'
      }
    case 'gemini':
      return {
        modelOptions: GEMINI_MODELS,
        reasoningOptions: [],
        defaultReasoning: '',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'flash-lite'
      }
    case 'kimi':
      return {
        modelOptions: KIMI_MODELS,
        reasoningOptions: KIMI_REASONING,
        defaultReasoning: 'on',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'kimi-k2.7-code'
      }
    case 'grok':
      return {
        modelOptions: GROK_MODELS,
        reasoningOptions: GROK_REASONING,
        defaultReasoning: GROK_45_DEFAULT_REASONING_EFFORT,
        fastModeCapableModelIds: GROK_FAST_CAPABLE,
        defaultModelId: GROK_45_MODEL_ID
      }
    case 'cursor':
      return {
        modelOptions: CURSOR_MODELS,
        reasoningOptions: [],
        defaultReasoning: GROK_45_DEFAULT_REASONING_EFFORT,
        fastModeCapableModelIds: CURSOR_FAST_CAPABLE,
        defaultModelId: 'composer-2.5-fast'
      }
    case 'ollama':
      return {
        modelOptions: OLLAMA_MODELS,
        reasoningOptions: [],
        defaultReasoning: '',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'qwen3.5:9b'
      }
    default:
      return {
        modelOptions: [],
        reasoningOptions: [],
        defaultReasoning: '',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'gpt-5.5'
      }
  }
}
