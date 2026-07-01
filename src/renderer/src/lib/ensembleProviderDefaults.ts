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
} from '../components/CombinedModelPicker'
import type { EnsembleParticipant, PermissionPresetId, ProviderId } from '../../../main/store/types'
import { OPENAI_PREVIEW_MODEL_ACCESS_REASON } from '../../../shared/previewModelCatalog'
import { codexReasoningDisplayLabel, claudeReasoningDisplayLabel } from './composerChipFormat'

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
const CODEX_SOL_REASONING: CombinedModelPickerReasoningOption[] = [
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
const claudeReasoningOptions = (enabled: ReadonlySet<string>): CombinedModelPickerReasoningOption[] =>
  CLAUDE_FULL_REASONING.map((option) =>
    enabled.has(option.value)
      ? option
      : { ...option, disabled: true, disabledReason: CLAUDE_REASONING_UNAVAILABLE }
  )
const CLAUDE_SONNET_REASONING = claudeReasoningOptions(
  new Set(['low', 'medium', 'high', 'max'])
)
const CLAUDE_OPUS_REASONING = claudeReasoningOptions(
  new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
)
const CLAUDE_HAIKU_REASONING = claudeReasoningOptions(new Set())

const KIMI_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'on', label: 'Thinking on' },
  { value: 'off', label: 'Thinking off' }
]

// Grok mirrors Claude Code's effort grammar (low|medium|high|xhigh|max);
// GrokCliArgs.normalizeGrokEffortFlag is the dispatch-side guard.
const GROK_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' }
]

const CODEX_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  {
    id: 'preview:openai:gpt-5.6:sol',
    label: 'GPT-5.6 Sol',
    disabled: true,
    disabledReason: OPENAI_PREVIEW_MODEL_ACCESS_REASON
  },
  {
    id: 'preview:openai:gpt-5.6:terra',
    label: 'GPT-5.6 Terra',
    disabled: true,
    disabledReason: OPENAI_PREVIEW_MODEL_ACCESS_REASON
  },
  {
    id: 'preview:openai:gpt-5.6:luna',
    label: 'GPT-5.6 Luna',
    disabled: true,
    disabledReason: OPENAI_PREVIEW_MODEL_ACCESS_REASON
  }
  // gpt-5.2 and gpt-5.3-codex are HARD-retired (the API rejects requests) and
  // removed from the ensemble Codex picker. Historical/cost lookups elsewhere
  // (modelDisplayName, contextWindows, ProviderRateService) keep their entries.
]

const CLAUDE_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'claude-opus-4-8-1m', label: 'Claude Opus 4.8 1M' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-mythos-5', label: 'Claude Mythos 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-4-7-1m', label: 'Claude Opus 4.7 1M' },
  // Sonnet 4.6 is retired from the picker; its tombstone metadata (display
  // name, context window, billing rate) is retained elsewhere for past runs.
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
  { id: 'grok-build', label: 'Grok Build 0.1' },
  { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' }
]

// Cursor — the only ids TaskWraith exposes (mirrors CursorCliProbe). "Fast" is a
// distinct model id (composer-2.5-fast), not a service tier, so both are listed
// as model options rather than a fast-tier toggle (no reasoning axis).
const CURSOR_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'composer-2.5', label: 'Composer 2.5' },
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' }
]

const OLLAMA_MODELS: CombinedModelPickerModelOption[] = [
  { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)' },
  { id: 'qwen3.6:35b', label: 'Qwen 3.6 (35B-A3B)' },
  { id: 'gemma4:12b', label: 'Gemma 4 (12B Param)' },
  { id: 'ornith:9b', label: 'Ornith 1.0 (9B Param)' },
  { id: 'ornith:35b', label: 'Ornith 1.0 (35B Param)' },
  { id: 'gpt-oss:20b', label: 'GPT OSS (20B Param)' },
  { id: 'lfm2.5:8b', label: 'LFM 2.5 (8B-1A)' },
  { id: 'minicpm-v4.5:8b', label: 'MiniCPM-V 4.5 (8B Param)' },
  { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)' },
  { id: 'granite4.1:30b', label: 'Granite 4.1 (30B Param)' },
  { id: 'nemotron3:33b', label: 'Nemotron 3 Nano Omni (33B Param)' }
]

const CODEX_FAST_CAPABLE = new Set<string>(['gpt-5.5', 'gpt-5.4'])
// Fast mode is Opus/Fable-only, and the default picker exposes the 1M Opus rows.
const CLAUDE_FAST_CAPABLE = new Set<string>([
  'claude-opus-4-8-1m',
  'claude-opus-4-7-1m',
  'claude-fable-5',
  'claude-fable-5-1m'
])

function isClaudeFullReasoningModel(modelId?: string | null): boolean {
  const normalized = String(modelId || '').toLowerCase()
  return normalized.includes('opus') || normalized.includes('fable') || normalized.includes('mythos')
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
    case 'codex':
      return String(modelId || '').toLowerCase() === 'preview:openai:gpt-5.6:sol'
        ? CODEX_SOL_REASONING
        : CODEX_REASONING
    case 'claude':
      if (isClaudeHaikuModel(modelId)) return CLAUDE_HAIKU_REASONING
      return isClaudeFullReasoningModel(modelId) || isClaudeSonnet5Model(modelId)
        ? CLAUDE_OPUS_REASONING
        : CLAUDE_SONNET_REASONING
    case 'kimi':
      return KIMI_REASONING
    case 'grok':
      return GROK_REASONING
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
        permissionPresetId: 'workspace_write',
        reasoningEffort: 'medium',
        fastModeEnabled: false,
        serviceTier: ''
      }
    case 'claude':
      return {
        model: 'claude-sonnet-5',
        permissionPresetId: 'read_only',
        reasoningEffort: 'medium',
        fastModeEnabled: false
      }
    case 'gemini':
      return {
        model: 'flash-lite',
        permissionPresetId: 'read_only'
      }
    case 'kimi':
      return {
        model: 'kimi-k2.7-code',
        permissionPresetId: 'read_only',
        thinkingEnabled: false
      }
    case 'grok':
      // Grok stays read-only as an ensemble member until G5 (tool mediation
      // via TaskWraith MCP + approval ledger) lands write-capable runs.
      return {
        model: 'grok-build',
        permissionPresetId: 'read_only',
        reasoningEffort: 'medium'
      }
    case 'cursor':
      // Cursor (Composer 2.5) has no reasoning axis; default to read-only in
      // ensembles like most members (codex is the lone writer). The user can
      // grant write per-participant — cursor's write mode is deny-list
      // contained + diff-reviewed. MUST mirror EnsembleDefaults.ts.
      return {
        model: 'composer-2.5-fast',
        permissionPresetId: 'read_only'
      }
    case 'ollama':
      return {
        model: 'qwen3:4b-instruct',
        permissionPresetId: 'read_only'
      }
    default:
      return {
        model: 'gpt-5.5',
        permissionPresetId: 'default'
      }
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
        defaultReasoning: 'off',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'kimi-k2.7-code'
      }
    case 'grok':
      return {
        modelOptions: GROK_MODELS,
        reasoningOptions: GROK_REASONING,
        defaultReasoning: 'medium',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'grok-build'
      }
    case 'cursor':
      return {
        modelOptions: CURSOR_MODELS,
        reasoningOptions: [],
        defaultReasoning: '',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'composer-2.5-fast'
      }
    case 'ollama':
      return {
        modelOptions: OLLAMA_MODELS,
        reasoningOptions: [],
        defaultReasoning: '',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'qwen3:4b-instruct'
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
