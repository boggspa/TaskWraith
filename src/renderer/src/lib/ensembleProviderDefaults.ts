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
import {
  codexReasoningDisplayLabel,
  claudeReasoningDisplayLabel,
  mistralReasoningDisplayLabel
} from './composerChipFormat'
import {
  isMistralThinkingCapableModel,
  isPiMistralThinkingCapableModel
} from '../../../shared/mistralModels'
import {
  CLAUDE_DEFAULT_MODELS,
  CODEX_DEFAULT_MODELS,
  KIMI_DEFAULT_MODELS,
  type CodexModelOption
} from './providerModelDefaults'
import { resolveOllamaReasoningSupport } from '../../../shared/ollamaReasoning'
import {
  CURSOR_GROK_45_BASE_MODEL_ID,
  CURSOR_GROK_46_BASE_MODEL_ID,
  GROK_45_DEFAULT_REASONING_EFFORT,
  GROK_45_MODEL_ID,
  GROK_45_REASONING_EFFORTS,
  GROK_46_DEFAULT_REASONING_EFFORT,
  GROK_46_MODEL_ID,
  GROK_46_REASONING_EFFORTS,
  cursorGrokBaseModelId,
  isCursorGrokModelId,
  isGrokReasoningModelId
} from '../../../shared/grok45Models'
import {
  KIMI_K27_MODEL_ID,
  KIMI_K3_256K_MODEL_ID,
  KIMI_K3_MODEL_ID,
  KIMI_K3_REASONING_EFFORTS,
  isKimiK3Model as isSharedKimiK3Model
} from '../../../shared/kimiModels'
import { activePiModelRows } from '../../../shared/piModelLifecycle'

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

/** Curated roster rows mirror main's runnable catalogs. Every concrete row is
 * an explicit UltraTask candidate unless it opts out; `custom` remains unknown
 * until live discovery proves that exact id. */
function withCuratedUltraTaskSupport<T extends CombinedModelPickerModelOption>(
  models: readonly T[]
): Array<T & { ultraTaskSupported?: boolean }> {
  return models.map((model) =>
    model.id === 'custom' ? { ...model } : { ultraTaskSupported: true, ...model }
  )
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

const KIMI_ALWAYS_ON_REASONING: CombinedModelPickerReasoningOption[] = [
  {
    value: 'on',
    label: 'On',
    disabledReason: 'Thinking is always on for K2.7 Coding.'
  }
]
const KIMI_K3_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' }
]

const grokReasoningOptions = (
  efforts: readonly { reasoningEffort: string }[]
): CombinedModelPickerReasoningOption[] =>
  efforts.map(({ reasoningEffort }) => ({
    value: reasoningEffort,
    label:
      reasoningEffort === 'xhigh'
        ? 'Extra High'
        : reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1)
  }))

// Grok 4.5 stops at High; Grok 4.6 adds the verified Extra High (`xhigh`)
// tier. GrokCliArgs remains the dispatch-side guard for the wire token.
const GROK_45_REASONING = grokReasoningOptions(GROK_45_REASONING_EFFORTS)
const GROK_46_REASONING = grokReasoningOptions(GROK_46_REASONING_EFFORTS)

// Mistral Devstral Small and Mistral Medium 3.5 now support configurable Thinking levels
// (off, low, medium, high, max). These match the Vibe CLI's ThinkingLevel enum.
const MISTRAL_THINKING_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: mistralReasoningDisplayLabel('low') },
  { value: 'medium', label: mistralReasoningDisplayLabel('medium') },
  { value: 'high', label: mistralReasoningDisplayLabel('high') },
  { value: 'max', label: mistralReasoningDisplayLabel('max') }
]

// General Pi API-key models (DeepSeek, ZAI, Qwen, MiniMax, Groq, Cerebras,
// OpenRouter upstreams): full thinking-level ladder surfaced via
// piReasoningEffort and dispatched as Pi thinkingLevel. Mirrors the display
// labels in composerChipFormat's provider === 'pi' branch.
const PI_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' }
]

const OLLAMA_TOGGLE_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' }
]
const OLLAMA_LEVEL_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

/** Muse Code seat models. Wire id mirrors the on-disk Muse model-catalog
 *  (`muse-spark-1.2`). Opaque CLI seat — keep the catalogue small until the
 *  live probe widens it. */
const MUSE_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  { id: 'muse-spark-1.2', label: 'Muse Spark 1.2' }
]
const MUSE_MODELS = withCuratedUltraTaskSupport(MUSE_MODEL_ROWS)

// Muse Spark effort ladder (HANDOFF #4 / Meta `/effort`): minimal→ultra,
// including xhigh. Never `none` — meta rejects it (maps to minimal at argv).
const MUSE_REASONING: CombinedModelPickerReasoningOption[] = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'ultra', label: 'Ultra' }
]

const CODEX_MODEL_ROWS: CombinedModelPickerModelOption[] = [
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
const CODEX_MODELS = withCuratedUltraTaskSupport(CODEX_MODEL_ROWS)

const CLAUDE_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  // Labels omit the "Claude " prefix (provider header/chip already carries
  // it); Legacy cluster below the current models — mirrors the main catalog.
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 Legacy' },
  { id: 'claude-opus-4-8-1m', label: 'Opus 4.8 1M Legacy' },
  { id: 'claude-opus-4-7-1m', label: 'Opus 4.7 1M Legacy' },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    ultraTaskSupported: false
  }
]
const CLAUDE_MODELS = withCuratedUltraTaskSupport(CLAUDE_MODEL_ROWS)

const GEMINI_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'pro', label: 'Pro' },
  { id: 'flash', label: 'Flash' },
  { id: 'flash-lite', label: 'Flash Lite' }
]
const GEMINI_MODELS = withCuratedUltraTaskSupport(GEMINI_MODEL_ROWS)

const KIMI_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  {
    id: KIMI_K27_MODEL_ID,
    label: 'K2.7 Coding',
    supportedReasoningEfforts: [{ reasoningEffort: 'on' }],
    defaultReasoningEffort: 'on',
    additionalSpeedTiers: ['fast']
  },
  {
    id: KIMI_K3_MODEL_ID,
    label: 'K3 (up to 1M)',
    supportedReasoningEfforts: KIMI_K3_REASONING_EFFORTS.map((reasoningEffort) => ({
      reasoningEffort
    })),
    defaultReasoningEffort: 'max'
  },
  {
    id: KIMI_K3_256K_MODEL_ID,
    label: 'K3 256K',
    supportedReasoningEfforts: KIMI_K3_REASONING_EFFORTS.map((reasoningEffort) => ({
      reasoningEffort
    })),
    defaultReasoningEffort: 'max'
  }
]
const KIMI_MODELS = withCuratedUltraTaskSupport(KIMI_MODEL_ROWS)
// Fast (Standard/Highspeed) stays exclusive to K2.7 Coding — neither K3 route has it.
const KIMI_FAST_CAPABLE = new Set<string>([KIMI_K27_MODEL_ID])

// Grok — mirrors App.tsx GROK_DEFAULT_MODELS. Its Composer id stays distinct
// from the Cursor catalog below.
const GROK_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  {
    id: GROK_46_MODEL_ID,
    label: 'Grok 4.6 Fast',
    supportedReasoningEfforts: [...GROK_46_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_46_DEFAULT_REASONING_EFFORT
  },
  {
    id: GROK_45_MODEL_ID,
    label: 'Grok 4.5 Fast',
    supportedReasoningEfforts: [...GROK_45_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT
  },
  { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' }
]
const GROK_MODELS = withCuratedUltraTaskSupport(GROK_MODEL_ROWS)

/** Mistral Vibe seat models. BARE ids only — a `mistral/<model>` id belongs to
 *  Pi's BYOK upstream, a different provider that shares the brand word.
 *  devstral-small leads because it is the seat default. Mirrors
 *  MISTRAL_SEAT_MODELS and the contextWindows registrations. */
const MISTRAL_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  { id: 'devstral-small', label: 'Devstral Small' },
  { id: 'mistral-medium-3.5', label: 'Mistral Medium 3.5' },
  { id: 'mistral-large-2512', label: 'Mistral Large 3' },
  { id: 'zai-glm-5-2', label: 'GLM-5.2 (via Mistral)' },
  { id: 'codestral-2508', label: 'Codestral (Aug 2025)' },
  { id: 'mistral-small-2603', label: 'Mistral Small 4' },
  { id: 'devstral-2512', label: 'Devstral 2' },
  { id: 'labs-leanstral-1-5', label: 'Leanstral 1.5 (Labs)' },
  { id: 'mistral-medium-latest', label: 'Mistral Medium (Latest)' },
  { id: 'mistral-medium-2508', label: 'Mistral Medium 3.1' },
  { id: 'mistral-medium-2505', label: 'Mistral Medium 3' },
  { id: 'ministral-14b-2512', label: 'Ministral 3 (14B)' },
  { id: 'ministral-8b-2512', label: 'Ministral 3 (8B)' },
  { id: 'ministral-3b-2512', label: 'Ministral 3 (3B)' }
]
const MISTRAL_MODELS = withCuratedUltraTaskSupport(MISTRAL_MODEL_ROWS)

// Cursor model catalog — backs live Path-B Cursor seats and decodes stored
// historical ensemble seats.
const CURSOR_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  { id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { id: 'composer-2.5', label: 'Composer 2.5' },
  {
    id: CURSOR_GROK_46_BASE_MODEL_ID,
    label: 'Cursor Grok 4.6',
    supportedReasoningEfforts: [...GROK_46_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_46_DEFAULT_REASONING_EFFORT,
    additionalSpeedTiers: ['fast']
  },
  {
    id: CURSOR_GROK_45_BASE_MODEL_ID,
    label: 'Cursor Grok 4.5',
    supportedReasoningEfforts: [...GROK_45_REASONING_EFFORTS],
    defaultReasoningEffort: GROK_45_DEFAULT_REASONING_EFFORT,
    additionalSpeedTiers: ['fast']
  }
]
const CURSOR_MODELS = withCuratedUltraTaskSupport(CURSOR_MODEL_ROWS)

/** AntiGravity gemini-api lane seats. The `gemini-api:` prefix is
 * load-bearing (dispatch + discovery both key on it); the live discovery
 * snapshot may extend this list, but these four wire models are the
 * deterministic floor.
 *
 * MUST stay in lockstep with ANTIGRAVITY_GEMINI_API_STATIC_MODEL_IDS in
 * src/main/antigravity/AntigravityGeminiApiStaticModels.ts, which owns the
 * floor and is the list that gets re-probed. This is a hand-mirror because the
 * renderer must not import from src/main; providerFallthroughGuards.test.ts
 * fails if the two drift. They did drift once: the 2.5 family was probed dead
 * on 2026-07-26 and only the main-side list was corrected, leaving every new
 * antigravity seat seeded with a model that 404s at dispatch.
 *
 * Context windows resolve through the provider-level antigravity fallback
 * (1M), not per-model rows — shared/contextWindows.ts has no 3.x entries. */
const ANTIGRAVITY_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  { id: 'gemini-api:gemini-3.6-flash', label: '3.6 Flash' },
  { id: 'gemini-api:gemini-3.5-flash', label: '3.5 Flash' },
  { id: 'gemini-api:gemini-3.1-pro-preview', label: '3.1 Pro Preview' },
  { id: 'gemini-api:gemini-3.1-flash-lite', label: '3.1 Flash-Lite' }
]
const ANTIGRAVITY_MODELS = withCuratedUltraTaskSupport(ANTIGRAVITY_MODEL_ROWS)

/** Pi seat models. Wire ids are `<upstream>/<model>` (pi's own syntax) and
 * MUST stay in lockstep with src/main/pi/PiModels.ts — that module owns the
 * curated catalog and the anti-circumvention wall; this is the renderer-side
 * mirror the seat editor offers. A model whose upstream has no stored key is
 * still listed here but fails visibly at dispatch with a "no key" message. */
const PI_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'zai/glm-5.2', label: 'GLM-5.2' },
  { id: 'zai/glm-5.1', label: 'GLM-5.1' },
  { id: 'zai/glm-4.7', label: 'GLM-4.7' },
  { id: 'qwen-token-plan/qwen3.7-max', label: 'Qwen3.7 Max' },
  { id: 'qwen-token-plan/qwen3.7-plus', label: 'Qwen3.7 Plus' },
  { id: 'qwen-token-plan/qwen3.8-max', label: 'Qwen3.8 Max' },
  { id: 'minimax/MiniMax-M3', label: 'MiniMax M3' },
  { id: 'minimax/MiniMax-M2.7', label: 'MiniMax M2.7' },
  { id: 'xiaomi-token-plan-cn/mimo-v2-pro', label: 'MiMo V2 Pro (CN)' },
  { id: 'xiaomi-token-plan-cn/mimo-v2.5', label: 'MiMo V2.5 (CN)' },
  { id: 'xiaomi-token-plan-cn/mimo-v2.5-pro', label: 'MiMo V2.5 Pro (CN)' },
  { id: 'xiaomi-token-plan-sgp/mimo-v2-pro', label: 'MiMo V2 Pro (SGP)' },
  { id: 'xiaomi-token-plan-sgp/mimo-v2.5', label: 'MiMo V2.5 (SGP)' },
  { id: 'xiaomi-token-plan-sgp/mimo-v2.5-pro', label: 'MiMo V2.5 Pro (SGP)' },
  { id: 'xiaomi-token-plan-ams/mimo-v2-pro', label: 'MiMo V2 Pro (AMS)' },
  { id: 'xiaomi-token-plan-ams/mimo-v2.5', label: 'MiMo V2.5 (AMS)' },
  { id: 'xiaomi-token-plan-ams/mimo-v2.5-pro', label: 'MiMo V2.5 Pro (AMS)' },
  { id: 'mistral/zai-glm-5-2', label: 'GLM-5.2 (via Mistral)' },
  { id: 'mistral/mistral-medium-3.5', label: 'Mistral Medium 3.5' },
  { id: 'mistral/mistral-medium-latest', label: 'Mistral Medium (Latest)' },
  { id: 'mistral/mistral-small-2603', label: 'Mistral Small 4' },
  { id: 'mistral/mistral-large-2512', label: 'Mistral Large 3' },
  { id: 'mistral/devstral-2512', label: 'Devstral 2' },
  { id: 'mistral/codestral-2508', label: 'Codestral (Aug 2025)' },
  { id: 'mistral/labs-leanstral-1-5', label: 'Leanstral 1.5 (Labs)' },
  { id: 'mistral/mistral-medium-2508', label: 'Mistral Medium 3.1' },
  { id: 'mistral/mistral-medium-2505', label: 'Mistral Medium 3' },
  { id: 'mistral/ministral-14b-2512', label: 'Ministral 3 (14B)' },
  { id: 'mistral/ministral-8b-2512', label: 'Ministral 3 (8B)' },
  { id: 'mistral/ministral-3b-2512', label: 'Ministral 3 (3B)' },
  { id: 'groq/openai/gpt-oss-120b', label: 'GPT-OSS 120B (Groq)' },
  { id: 'groq/qwen/qwen3-32b', label: 'Qwen3 32B (Groq)' },
  { id: 'cerebras/zai-glm-4.7', label: 'GLM-4.7 (Cerebras)' },
  { id: 'cerebras/gpt-oss-120b', label: 'GPT-OSS 120B (Cerebras)' },
  { id: 'openrouter/stealth/ox-alpha', label: 'Ox Alpha' },
  { id: 'openrouter/zai/glm-5.2', label: 'GLM 5.2' },
  { id: 'openrouter/poolside/laguna-s-2.1', label: 'Laguna S 2.1' },
  { id: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra' }
]
const PI_MODELS = withCuratedUltraTaskSupport(PI_MODEL_ROWS)

const OLLAMA_MODEL_ROWS: CombinedModelPickerModelOption[] = [
  { id: 'qwen3:4b-instruct', label: 'Qwen 3 (4B Param)' },
  { id: 'qwen3.5:2b', label: 'Qwen 3.5 (2B Param)' },
  { id: 'qwen3.5:4b', label: 'Qwen 3.5 (4B Param)' },
  { id: 'qwen3.5:9b', label: 'Qwen 3.5 (9B Param)' },
  { id: 'qwen3.6:35b', label: 'Qwen 3.6 (35B-A3B)' },
  { id: 'qwen3.8:27b-mlx', label: 'Qwen 3.8 (27B-MLX)' },
  { id: 'gemma3:4b', label: 'Gemma 3 (4B Param)' },
  { id: 'gemma4:12b', label: 'Gemma 4 (12B Param)' },
  { id: 'gemma4:31b-mlx', label: 'Gemma 4 (31B-MLX)' },
  { id: 'ornith:9b', label: 'Ornith 1.0 (9B Param)' },
  { id: 'ornith:35b', label: 'Ornith 1.0 (35B Param)' },
  { id: 'ornith-1.5:9b', label: 'Ornith 1.5 (9B Param)' },
  { id: 'ornith-1.5:35b', label: 'Ornith 1.5 (35B Param)' },
  { id: 'laguna-xs-2.1:q8_0', label: 'Laguna XS 2.1 (33B-A3B Q8)' },
  { id: 'gpt-oss:20b', label: 'GPT OSS (20B Param)' },
  { id: 'lfm2.5-thinking:1.2b', label: 'LFM 2.5 Thinking (1.2B Param)' },
  { id: 'lfm2.5:8b', label: 'LFM 2.5 (8B-A1B)' },
  { id: 'minicpm-v4.5:8b', label: 'MiniCPM-V 4.5 (8B Param)' },
  { id: 'granite4:3b', label: 'Granite 4.0 (3B Param)' },
  { id: 'granite4.1:3b', label: 'Granite 4.1 (3B Param)' },
  { id: 'granite4.1:30b', label: 'Granite 4.1 (30B Param)' },
  { id: 'nemotron-3-nano:4b', label: 'Nemotron 3 Nano (4B Param)' },
  { id: 'nemotron3:33b', label: 'Nemotron 3 Nano Omni (33B Param)' },
  { id: 'nemotron-3.5-lightning:30b-mlx', label: 'Nemotron 3.5 Lightning (30B-MLX)' },
  { id: 'devstral-small-2:24b', label: 'Devstral Small 2 (24B Param)' },
  { id: 'ministral-3:3b', label: 'Ministral 3 (3B Param)' },
  { id: 'ministral-3:14b', label: 'Ministral 3 (14B Param)' },
  { id: 'muse-glimmer:30b-mlx', label: 'Muse Glimmer (30B-MLX)' },
  { id: 'llama3.1:8b', label: 'Llama 3.1 (8B Param)' },
  { id: 'deepseek-r1:1.5b', label: 'DeepSeek R1 (1.5B Param)' },
  { id: 'deepseek-r1:8b', label: 'DeepSeek R1 (8B Param)' },
  { id: 'rnj-1', label: 'Rnj-1 (8B Param)' },
  { id: 'glm-4.7-flash:q4_K_M', label: 'GLM-4.7-Flash (30B-A3B Q4)' },
  { id: 'north-mini-code-1.0:q4_K_M', label: 'North Mini Code 1.0 (30B-A3B Q4)' },
  { id: 'llama3.2:3b', label: 'Llama 3.2 (3B Param)' }
]
const OLLAMA_MODELS = withCuratedUltraTaskSupport(OLLAMA_MODEL_ROWS)

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
  'claude-opus-5',
  'claude-opus-4-8-1m',
  'claude-opus-4-7-1m'
])
const CURSOR_FAST_CAPABLE = new Set<string>([
  'composer-2.5',
  'composer-2.5-fast',
  CURSOR_GROK_46_BASE_MODEL_ID,
  CURSOR_GROK_45_BASE_MODEL_ID
])
// All Grok CLI models run permanently in Fast mode. This set only drives the
// picker's Fast ⚡ glyph — Grok passes no onToggleFastMode, so no toggle row
// renders and no fast-clearing runs on model switch.
const GROK_FAST_CAPABLE = new Set<string>([
  GROK_46_MODEL_ID,
  GROK_45_MODEL_ID,
  'grok-composer-2.5-fast'
])

function isDirectGrok46ModelId(modelId?: string | null): boolean {
  const id = String(modelId || '')
    .trim()
    .toLowerCase()
  return id === GROK_46_MODEL_ID
}

function grokReasoningDefaultForModel(
  provider: ProviderId,
  modelId?: string | null
): string | undefined {
  if (provider === 'grok') {
    if (!isGrokReasoningModelId(modelId)) return undefined
    return isDirectGrok46ModelId(modelId)
      ? GROK_46_DEFAULT_REASONING_EFFORT
      : GROK_45_DEFAULT_REASONING_EFFORT
  }
  if (provider === 'cursor') {
    const baseModelId = cursorGrokBaseModelId(modelId)
    if (baseModelId === CURSOR_GROK_46_BASE_MODEL_ID) {
      return GROK_46_DEFAULT_REASONING_EFFORT
    }
    if (baseModelId === CURSOR_GROK_45_BASE_MODEL_ID) {
      return GROK_45_DEFAULT_REASONING_EFFORT
    }
  }
  return undefined
}

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
  modelId?: string | null,
  modelMetadata?: { capabilities?: readonly string[] | null } | null
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
      return isSharedKimiK3Model(modelId) ? KIMI_K3_REASONING : KIMI_ALWAYS_ON_REASONING
    case 'grok':
      if (!isGrokReasoningModelId(modelId)) return []
      return isDirectGrok46ModelId(modelId) ? GROK_46_REASONING : GROK_45_REASONING
    case 'cursor': {
      const baseModelId = cursorGrokBaseModelId(modelId)
      if (baseModelId === CURSOR_GROK_46_BASE_MODEL_ID) return GROK_46_REASONING
      if (baseModelId === CURSOR_GROK_45_BASE_MODEL_ID) return GROK_45_REASONING
      return []
    }
    case 'mistral': {
      return isMistralThinkingCapableModel(modelId) ? MISTRAL_THINKING_REASONING : []
    }
    case 'pi': {
      if (isPiMistralThinkingCapableModel(modelId)) return MISTRAL_THINKING_REASONING
      return PI_REASONING
    }
    case 'ollama': {
      const support = resolveOllamaReasoningSupport({
        modelId,
        ...(modelMetadata && Array.isArray(modelMetadata.capabilities)
          ? { capabilities: modelMetadata.capabilities }
          : {})
      })
      if (support.kind === 'toggle') return OLLAMA_TOGGLE_REASONING
      if (support.kind === 'levels') return OLLAMA_LEVEL_REASONING
      return []
    }
    case 'muse':
      return MUSE_REASONING
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
 * "Accept Edits" preset). A freshly added participant is fully
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
        reasoningEffort: 'on',
        fastModeEnabled: false,
        thinkingEnabled: true,
        serviceTier: 'standard'
      }
    case 'grok':
      // Accept Edits like every other seed; the Grok seat itself is
      // still toolless at dispatch, so the preset only matters if the user
      // later swaps the row to a tool-capable provider config.
      return {
        model: GROK_46_MODEL_ID,
        permissionPresetId: 'default',
        reasoningEffort: GROK_46_DEFAULT_REASONING_EFFORT
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
        permissionPresetId: 'default',
        reasoningEffort: 'on'
      }
    case 'antigravity':
      // Gemini-api lane model id — the `gemini-api:` prefix is load-bearing
      // (dispatch routes on it); the discovery snapshot may widen the option
      // list, but the seed stays deterministic.
      return {
        model: 'gemini-api:gemini-3.6-flash',
        permissionPresetId: 'default'
      }
    case 'pi':
      return {
        model: 'deepseek/deepseek-v4-flash',
        permissionPresetId: 'default'
      }
    case 'mistral':
      // Must stay in lockstep with getDefaultEnsembleModel in
      // src/main/EnsembleDefaults.ts — these two seeds diverging is how a
      // participant ends up configured differently depending on which surface
      // created it.
      return {
        model: 'devstral-small',
        permissionPresetId: 'default',
        reasoningEffort: 'medium'
      }
    case 'muse':
      // Must stay in lockstep with getDefaultEnsembleModel in
      // src/main/EnsembleDefaults.ts. Default high matches
      // MuseCliArgs MUSE_DEFAULT_REASONING_EFFORT.
      return {
        model: 'muse-spark-1.2',
        permissionPresetId: 'default',
        reasoningEffort: 'high'
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
    case 'antigravity':
      return 'AntiGravity'
    case 'pi':
      return 'Pi'
    case 'mistral':
      return 'Mistral'
    case 'muse':
      return 'Muse'
    default:
      return 'Gemini'
  }
}

/**
 * Fields a seat change may carry from the previous participant onto the next
 * provider/model selection. Used by live composer + roster/Agent Pool pickers;
 * omitted when seeding a brand-new participant or a solo-chat provider switch.
 */
export type ParticipantSeatCarryover = Pick<
  EnsembleParticipant,
  | 'permissionPresetId'
  | 'permissionOverrides'
  | 'reasoningEffort'
  | 'fastModeEnabled'
  | 'serviceTier'
  | 'thinkingEnabled'
  | 'provider'
>

/**
 * Patch to apply when a participant's PROVIDER changes in an editor. Resets
 * provider-bound runtime/session fields so a stale cross-provider value can't
 * survive (e.g. a Claude model id on a Codex participant, a linked session id,
 * or a runtime profile). Permission preset + tool-grant overrides are carried
 * from `previous` when provided — seat edits must not snap back to Accept
 * Edits; only fresh seats (`getDefaultEnsembleParticipantConfig`) seed that
 * default. Each clearable field is present in the returned patch (with an
 * explicit `undefined` where it should clear) so a
 * `{ ...participant, ...patch }` shallow merge actually removes the old value
 * rather than retaining it.
 */
export function buildProviderChangeParticipantPatch(
  provider: ProviderId,
  previous?: Pick<EnsembleParticipant, 'permissionPresetId' | 'permissionOverrides'> | null
): Partial<EnsembleParticipant> {
  const defaults = getDefaultEnsembleParticipantConfig(provider)
  return {
    provider,
    model: defaults.model,
    runtimeProfileId: undefined,
    geminiAuthProfileId: null,
    permissionPresetId: previous?.permissionPresetId ?? defaults.permissionPresetId,
    permissionOverrides: previous ? previous.permissionOverrides : undefined,
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
  'supportedReasoningEfforts' | 'defaultReasoningEffort' | 'capabilities' | 'additionalSpeedTiers'
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
  // Keep Muse wire `ultra` (and Codex `ultracode`) distinct as tokens — they
  // share EFFORT_LADDER_RANK 6 for seat-change snaps. Rewriting ultra→
  // ultracode here made Muse persist a token its CLI does not accept.
  return normalized
}

/** K3 has a selectable Low/High/Max effort; K2.7 Coding's thinking is fixed On. */
export function isKimiK3Model(model?: string | null): boolean {
  return isSharedKimiK3Model(model)
}

/**
 * The picker uses K2.7's fixed thinking state as an `on` stop, but K3 must
 * retain its independent effort. Collapsing K3 to `on` makes the shared ladder
 * land on Low even when the persisted selection is High or Max.
 */
export function resolveKimiReasoningPickerSelection(
  model: string | null | undefined,
  reasoningEffort?: string | null
): string {
  if (normalizeReasoningEffortToken(reasoningEffort) === 'ultratask') return 'ultraTask'
  if (!isKimiK3Model(model)) return 'on'
  return normalizeReasoningEffortToken(reasoningEffort) || 'max'
}

/** Persist K3 effort and the synthetic UltraTask selection without treating
 * ordinary K2.7 choices as anything other than its fixed thinking flag. */
export function buildKimiReasoningPickerPatch(
  model: string | null | undefined,
  reasoningEffort: string
): Pick<Partial<EnsembleParticipant>, 'reasoningEffort' | 'thinkingEnabled'> {
  if (normalizeReasoningEffortToken(reasoningEffort) === 'ultratask') {
    return { reasoningEffort: 'ultraTask', thinkingEnabled: true }
  }
  if (isKimiK3Model(model)) return { reasoningEffort, thinkingEnabled: true }
  return { reasoningEffort: undefined, thinkingEnabled: true }
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
  if (provider === 'kimi') {
    return KIMI_DEFAULT_MODELS.find((option) => option.id === model)
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
    : getEnsembleReasoningOptions(provider, model, metadata)
        .filter((option) => !option.disabled)
        .map((option) => normalizeReasoningEffortToken(option.value))
  return [...new Set(values.filter(Boolean))]
}

function resolveEnabledEffortToken(
  token: string | undefined,
  enabled: readonly string[]
): string | undefined {
  if (!token) return undefined
  if (enabled.includes(token)) return token
  // Codex/Claude wire ceiling is `ultracode`; Muse Meta uses `ultra`. Live
  // model/list defaults may still say `ultra` while the enabled catalog lists
  // only `ultracode` (or the reverse after a Muse seat change).
  if (token === 'ultra' && enabled.includes('ultracode')) return 'ultracode'
  if (token === 'ultracode' && enabled.includes('ultra')) return 'ultra'
  return undefined
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

  const modelDefault = resolveEnabledEffortToken(
    normalizeReasoningEffortToken(metadata?.defaultReasoningEffort),
    enabled
  )
  if (modelDefault) return modelDefault

  if (provider === 'ollama') {
    const ollamaDefault = resolveOllamaReasoningSupport({
      modelId: model,
      ...(metadata && Array.isArray(metadata.capabilities)
        ? { capabilities: metadata.capabilities }
        : {})
    }).defaultEffort
    if (ollamaDefault && enabled.includes(ollamaDefault)) return ollamaDefault
  }

  const providerDefault = resolveEnabledEffortToken(
    normalizeReasoningEffortToken(getDefaultEnsembleParticipantConfig(provider).reasoningEffort),
    enabled
  )
  if (providerDefault) return providerDefault
  if (enabled.includes('medium')) return 'medium'
  return enabled[0]
}

/**
 * Ladder ranks matching CombinedModelPicker's LADDER_STOPS / iOS nearest-higher
 * tie-break. Used to persist effort across model/provider seat changes when the
 * exact token is no longer enabled.
 */
const EFFORT_LADDER_RANK: Readonly<Record<string, number>> = {
  off: 0,
  // Muse Meta floor stop (shared Off index); never emit `none` on argv.
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultracode: 6,
  // Muse Meta ceiling stop (shared Ultracode index).
  ultra: 6,
  // Kimi binary thinking rides Light when mapping onto the shared ladder.
  on: 1
}

function effortLadderRank(value?: string | null): number | null {
  const token = normalizeReasoningEffortToken(value)
  if (!token) return null
  return Object.prototype.hasOwnProperty.call(EFFORT_LADDER_RANK, token)
    ? EFFORT_LADDER_RANK[token]!
    : null
}

/**
 * Keep the previous effort when still enabled; otherwise snap to the nearest
 * enabled ladder stop (ties → higher), else the model/provider default.
 */
export function resolveReasoningEffortForSeatChange(options: {
  provider: ProviderId
  model: string
  previousEffort?: string | null
  modelMetadata?: ProviderModelSelectionMetadata | null
}): string | undefined {
  const { provider, model, previousEffort, modelMetadata } = options
  const fallbackMetadata = fallbackModelSelectionMetadata(provider, model)
  const metadata = modelMetadata ? { ...fallbackMetadata, ...modelMetadata } : fallbackMetadata
  const enabled = enabledReasoningEffortsForModel(provider, model, metadata)
  if (enabled.length === 0) return undefined

  const normalizedPrevious = normalizeReasoningEffortToken(previousEffort)
  const exactPrevious = resolveEnabledEffortToken(normalizedPrevious, enabled)
  if (exactPrevious) return exactPrevious

  const previousRank = effortLadderRank(normalizedPrevious)
  if (previousRank != null) {
    let best: string | undefined
    let bestDistance = Infinity
    let bestRank = -1
    for (const effort of enabled) {
      const rank = effortLadderRank(effort)
      if (rank == null) continue
      const distance = Math.abs(rank - previousRank)
      // Match CombinedModelPicker.nearestEnabledLadderIndex: ties → higher stop.
      if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
        bestDistance = distance
        bestRank = rank
        best = effort
      }
    }
    if (best) return best
  }

  // Fresh native/hosted Grok models seed their version-specific default even
  // though lower effort stops are enabled.
  if (!normalizedPrevious) {
    const grokDefault = normalizeReasoningEffortToken(grokReasoningDefaultForModel(provider, model))
    if (grokDefault && enabled.includes(grokDefault)) return grokDefault
  }

  return defaultReasoningEffortForModel(provider, model, modelMetadata)
}

function previousSeatHadFastEnabled(
  previous?: Pick<EnsembleParticipant, 'fastModeEnabled' | 'serviceTier'> | null
): boolean {
  if (!previous) return false
  if (previous.serviceTier === 'fast') return true
  if (previous.serviceTier == null && previous.fastModeEnabled === true) return true
  return previous.fastModeEnabled === true
}

function modelSupportsFastTier(
  provider: ProviderId,
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null
): boolean {
  if (modelMetadata?.additionalSpeedTiers?.includes('fast')) return true
  return getEnsembleModelDefaults(provider).fastModeCapableModelIds.has(model)
}

/**
 * Canonical fresh/provider-switch state for an explicit provider + model pair.
 *
 * When `previous` is omitted (new seat, solo-chat provider change), this seeds
 * Fast off and the model's default reasoning. When `previous` is a seat being
 * edited, reasoning snaps to the closest enabled ladder stop and Fast stays on
 * when the destination model still supports it.
 */
export function normalizeProviderModelSelection(
  provider: ProviderId,
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null,
  previous?: Pick<
    EnsembleParticipant,
    'reasoningEffort' | 'fastModeEnabled' | 'serviceTier' | 'thinkingEnabled'
  > | null
): ProviderModelSelectionFields {
  const cleared: ProviderModelSelectionFields = {
    model,
    reasoningEffort: undefined,
    fastModeEnabled: undefined,
    thinkingEnabled: undefined,
    serviceTier: undefined
  }
  const reasoningEffort = resolveReasoningEffortForSeatChange({
    provider,
    model,
    previousEffort: previous?.reasoningEffort,
    modelMetadata
  })
  const carryFast = previousSeatHadFastEnabled(previous)

  switch (provider) {
    case 'codex': {
      const nextFast = carryFast && modelSupportsFastTier(provider, model, modelMetadata)
      return {
        ...cleared,
        reasoningEffort,
        fastModeEnabled: nextFast,
        serviceTier: nextFast ? 'fast' : ''
      }
    }
    case 'claude':
      return {
        ...cleared,
        reasoningEffort,
        fastModeEnabled: carryFast && modelSupportsFastTier(provider, model, modelMetadata)
      }
    case 'kimi': {
      const nextFast = carryFast && modelSupportsFastTier(provider, model, modelMetadata)
      return {
        ...cleared,
        reasoningEffort,
        fastModeEnabled: nextFast,
        thinkingEnabled: previous?.thinkingEnabled ?? true,
        serviceTier: nextFast ? 'fast' : 'standard'
      }
    }
    case 'grok':
      return {
        ...cleared,
        reasoningEffort: isGrokReasoningModelId(model)
          ? (reasoningEffort ?? grokReasoningDefaultForModel(provider, model))
          : undefined
      }
    case 'cursor':
      if (isCursorGrokModelId(model)) {
        return {
          ...cleared,
          reasoningEffort: reasoningEffort ?? grokReasoningDefaultForModel(provider, model),
          fastModeEnabled: carryFast && modelSupportsFastTier(provider, model, modelMetadata)
        }
      }
      if (model === 'composer-2.5-fast') {
        return { ...cleared, fastModeEnabled: true }
      }
      if (model === 'composer-2.5') {
        return { ...cleared, fastModeEnabled: false }
      }
      return {
        ...cleared,
        fastModeEnabled: carryFast && modelSupportsFastTier(provider, model, modelMetadata)
      }
    default:
      return { ...cleared, reasoningEffort }
  }
}

/**
 * Deterministic model-only patch for a Codex participant or chat.
 *
 * `reasoningEffort` is deliberately present even when the live model row has
 * no explicit default. Composer state is shallow-merged, so omitting this key
 * would leave a previous effort unexamined. With `previous`, effort maps to the
 * closest enabled ladder stop; without it, the model/provider default is used
 * (so Sol `max` does not silently stick on GPT-5.5 when no carryover is
 * supplied). Fast fields stay out of this patch: same-provider model changes
 * preserve Fast via `buildSameProviderModelChangeParticipantPatch` / the
 * composer when the destination supports it.
 */
export function buildCodexModelChangeParticipantPatch(
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null,
  previous?: Pick<EnsembleParticipant, 'reasoningEffort'> | null
): Pick<Partial<EnsembleParticipant>, 'model' | 'reasoningEffort'> {
  const normalized = normalizeProviderModelSelection('codex', model, modelMetadata, previous)
  return {
    model,
    reasoningEffort: normalized.reasoningEffort
  }
}

/**
 * Same-provider model change for an existing ensemble seat: carry reasoning
 * (closest ladder) and Fast when still applicable; leave permission/runtime
 * fields absent so shallow merge preserves them.
 */
export function buildSameProviderModelChangeParticipantPatch(
  participant: Pick<
    EnsembleParticipant,
    'provider' | 'reasoningEffort' | 'fastModeEnabled' | 'serviceTier' | 'thinkingEnabled'
  >,
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null
): Partial<EnsembleParticipant> {
  return {
    provider: participant.provider,
    ...normalizeProviderModelSelection(participant.provider, model, modelMetadata, participant)
  }
}

/**
 * One atomic participant patch for selecting a model from any provider group.
 * Provider/session hygiene comes from `buildProviderChangeParticipantPatch`;
 * the explicit model fields then override that provider's generic seed values.
 * Pass `previous` for seat edits so permissions, grants, effort, and Fast
 * carry across; omit it for fresh seeds.
 */
export function buildProviderModelChangeParticipantPatch(
  provider: ProviderId,
  model: string,
  modelMetadata?: ProviderModelSelectionMetadata | null,
  previous?: ParticipantSeatCarryover | null
): Partial<EnsembleParticipant> {
  return {
    ...buildProviderChangeParticipantPatch(provider, previous),
    ...normalizeProviderModelSelection(provider, model, modelMetadata, previous)
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
    | 'ollamaRunProfile'
  >
): ResolvedEnsembleParticipantSettings {
  const defaults = getDefaultEnsembleParticipantConfig(participant.provider)
  const model = participant.model || defaults.model
  const permissionPresetId = participant.permissionPresetId || defaults.permissionPresetId
  const reasoningOptions = getEnsembleReasoningOptions(participant.provider, model)
  const enabledReasoningOptions = reasoningOptions.filter((option) => !option.disabled)
  const reasoningValues = new Set(enabledReasoningOptions.map((option) => option.value))
  const configuredModelDefaultReasoning = defaultReasoningEffortForModel(
    participant.provider,
    model
  )
  const modelDefaultReasoning =
    participant.provider === 'ollama' &&
    participant.ollamaRunProfile === 'local_scout' &&
    reasoningValues.has('medium')
      ? 'medium'
      : configuredModelDefaultReasoning
  const reasoningEffort =
    participant.reasoningEffort === 'ultraTask'
      ? 'ultraTask'
      : enabledReasoningOptions.length === 0
        ? ''
        : participant.reasoningEffort && reasoningValues.has(participant.reasoningEffort)
          ? participant.reasoningEffort
          : modelDefaultReasoning && reasoningValues.has(modelDefaultReasoning)
            ? modelDefaultReasoning
            : (enabledReasoningOptions[0]?.value ?? '')
  const fastModeEnabled =
    participant.provider === 'kimi' && isKimiK3Model(model)
      ? false
      : Boolean(participant.fastModeEnabled ?? defaults.fastModeEnabled)
  const thinkingEnabled =
    participant.provider === 'kimi'
      ? true
      : Boolean(participant.thinkingEnabled ?? defaults.thinkingEnabled)
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

export function getEnsembleModelDefaults(
  provider: ProviderId,
  now: Date = new Date()
): EnsembleModelDefaults {
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
        reasoningOptions: KIMI_ALWAYS_ON_REASONING,
        defaultReasoning: 'on',
        fastModeCapableModelIds: KIMI_FAST_CAPABLE,
        defaultModelId: 'kimi-k2.7-code'
      }
    case 'grok':
      return {
        modelOptions: GROK_MODELS,
        reasoningOptions: GROK_46_REASONING,
        defaultReasoning: GROK_46_DEFAULT_REASONING_EFFORT,
        fastModeCapableModelIds: GROK_FAST_CAPABLE,
        defaultModelId: GROK_46_MODEL_ID
      }
    case 'cursor':
      return {
        modelOptions: CURSOR_MODELS,
        reasoningOptions: [],
        defaultReasoning: GROK_46_DEFAULT_REASONING_EFFORT,
        fastModeCapableModelIds: CURSOR_FAST_CAPABLE,
        defaultModelId: 'composer-2.5-fast'
      }
    case 'ollama':
      return {
        modelOptions: OLLAMA_MODELS,
        reasoningOptions: getEnsembleReasoningOptions('ollama', 'qwen3.5:9b'),
        defaultReasoning: 'on',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'qwen3.5:9b'
      }
    case 'antigravity':
      return {
        modelOptions: ANTIGRAVITY_MODELS,
        reasoningOptions: [],
        defaultReasoning: '',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'gemini-api:gemini-3.6-flash'
      }
    case 'pi':
      return {
        modelOptions: activePiModelRows(PI_MODELS, now),
        reasoningOptions: PI_REASONING,
        defaultReasoning: 'medium',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'deepseek/deepseek-v4-flash'
      }
    case 'mistral':
      // Without this case the switch fell to `default:`, which returns an EMPTY
      // modelOptions list — so selecting Mistral for an ensemble participant
      // offered zero models and seeded Codex's `gpt-5.5` as the default id. The
      // two sibling switches in this file already had their mistral branches,
      // which is exactly why the gap was invisible.
      return {
        modelOptions: MISTRAL_MODELS,
        reasoningOptions: MISTRAL_THINKING_REASONING,
        defaultReasoning: 'medium',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'devstral-small'
      }
    case 'muse':
      return {
        modelOptions: MUSE_MODELS,
        reasoningOptions: MUSE_REASONING,
        defaultReasoning: 'high',
        fastModeCapableModelIds: new Set<string>(),
        defaultModelId: 'muse-spark-1.2'
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
