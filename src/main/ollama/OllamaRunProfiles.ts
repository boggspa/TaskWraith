import type {
  OllamaReasoningLevel,
  OllamaRunProfile,
  OllamaRunProfileId
} from '../store/types'
import { resolveContextWindow } from '../../shared/contextWindows'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

/**
 * Ceiling for a profile's context cap, raised from 262,144 on 2026-07-30 so a
 * model whose real window EXCEEDS 256K can actually use it — `devstral-small-2:24b`
 * measures 393,216 locally and was being clipped by a third.
 *
 * Safe to set generously because `resolveOllamaNumCtx` is DEMAND-DRIVEN:
 * `min(limit, roundUp(tokens the messages actually need))` with an 8,192 floor. A
 * ceiling is not an allocation — it only bounds how far `num_ctx` may grow once a
 * conversation genuinely gets long. Headroom left above 393,216 for future pulls.
 */
const OLLAMA_RUN_PROFILE_CONTEXT_CAP_MAX = 524_288

/**
 * Ceiling for the working profiles (`approved_patcher`, `verify_with_shell`).
 * Raised from 131,072 on 2026-07-30: most of the installed fleet measures 262,144,
 * so the old value halved a model's real window on the profiles used for actual
 * work. `local_scout` deliberately keeps a much lower cap — it trades context for
 * speed on purpose.
 */
const OLLAMA_WORKING_PROFILE_CONTEXT_CAP = 262_144

/** `local_scout` stays deliberately small; it is the fast/cheap recon profile. */
const OLLAMA_SCOUT_PROFILE_CONTEXT_CAP = 65_536

export const OLLAMA_RUN_PROFILE_PRESETS: Record<
  Exclude<OllamaRunProfileId, 'custom'>,
  Required<Pick<OllamaRunProfile, 'id' | 'label' | 'reasoningLevel' | 'contextCapTokens' | 'protocolMode' | 'compactToolSchemas' | 'oneToolAtATime' | 'numPredictTool' | 'numPredictFinal' | 'keepAlive'>>
> = {
  local_scout: {
    id: 'local_scout',
    label: 'Local Scout',
    reasoningLevel: 'medium',
    contextCapTokens: 32_768,
    protocolMode: 'native_first',
    compactToolSchemas: true,
    oneToolAtATime: true,
    numPredictTool: 1024,
    numPredictFinal: 3072,
    keepAlive: '10m'
  },
  approved_patcher: {
    id: 'approved_patcher',
    label: 'Approved Patcher',
    reasoningLevel: 'high',
    contextCapTokens: 65_536,
    protocolMode: 'native_first',
    compactToolSchemas: true,
    oneToolAtATime: true,
    numPredictTool: 1536,
    numPredictFinal: 4096,
    keepAlive: '10m'
  },
  verify_with_shell: {
    id: 'verify_with_shell',
    label: 'Verify With Shell',
    reasoningLevel: 'high',
    contextCapTokens: 65_536,
    protocolMode: 'native_first',
    compactToolSchemas: true,
    oneToolAtATime: true,
    numPredictTool: 1536,
    numPredictFinal: 4096,
    keepAlive: '10m'
  },
  provider_parity: {
    id: 'provider_parity',
    label: 'Provider Parity',
    reasoningLevel: 'high',
    contextCapTokens: 65_536,
    protocolMode: 'native_first',
    compactToolSchemas: false,
    oneToolAtATime: true,
    numPredictTool: 1536,
    numPredictFinal: 4096,
    keepAlive: '10m'
  }
}

export const OLLAMA_RUN_PROFILE_ORDER: Exclude<OllamaRunProfileId, 'custom'>[] = [
  'local_scout',
  'approved_patcher',
  'verify_with_shell',
  'provider_parity'
]

export function isOllamaRunProfileId(value: unknown): value is OllamaRunProfileId {
  return (
    value === 'local_scout' ||
    value === 'approved_patcher' ||
    value === 'verify_with_shell' ||
    value === 'provider_parity' ||
    value === 'custom'
  )
}

/**
 * The model's context window, or `null` when it is not trustworthy enough to size
 * a cap from.
 *
 * `measuredContextTokens` is a window READ FROM THE RUNNING DAEMON
 * (`OllamaModelInfo.contextLength`). When present it is authoritative and the
 * family gate is bypassed entirely — the gate exists only because an unrecognised
 * tag has no trustworthy window, and a measurement removes that doubt. Without it
 * the previous behaviour stands: a known family reads the static table, and an
 * `unknown` family returns null so the caller keeps its conservative preset.
 *
 * That gate was the real cause of "why is my new local model throttled": a freshly
 * pulled tag resolves `unknown`, so it fell back to a 32K–65K preset regardless of
 * supporting 262K. A measurement now rescues it without anyone hand-adding an arm.
 */
function knownModelContextWindow(
  modelId?: string | null,
  measuredContextTokens?: number | null
): number | null {
  const trimmed = String(modelId || '').trim()
  if (!trimmed) return null
  const measured =
    typeof measuredContextTokens === 'number' &&
    Number.isFinite(measuredContextTokens) &&
    measuredContextTokens > 0
      ? Math.trunc(measuredContextTokens)
      : undefined
  if (measured) return resolveContextWindow('ollama', trimmed, undefined, measured)
  if (resolveOllamaModelFamily(trimmed) === 'unknown') return null
  return resolveContextWindow('ollama', trimmed)
}

function defaultContextCapTokens(
  baseId: Exclude<OllamaRunProfileId, 'custom'>,
  modelId: string | null | undefined,
  fallback: number,
  measuredContextTokens?: number | null
): number {
  const modelWindow = knownModelContextWindow(modelId, measuredContextTokens)
  if (!modelWindow) return fallback
  if (baseId === 'local_scout') {
    return Math.min(modelWindow, OLLAMA_SCOUT_PROFILE_CONTEXT_CAP)
  }
  if (baseId === 'provider_parity') {
    return Math.min(modelWindow, OLLAMA_RUN_PROFILE_CONTEXT_CAP_MAX)
  }
  return Math.min(modelWindow, OLLAMA_WORKING_PROFILE_CONTEXT_CAP)
}

export function resolveOllamaRunProfile(
  modelId?: string | null,
  chatProfile?: string | null,
  measuredContextTokens?: number | null
): OllamaRunProfile {
  // The global run-profile settings surface (ollamaDefaultRunProfile /
  // ollamaRunProfiles) was removed — it had no UI and only added a confusing,
  // own-goal-prone layer. The per-ensemble-participant selection (chatProfile,
  // set from the participant runtime popover) is now the ONLY user-configurable
  // runtime knob. Absent a selection, default to provider_parity: the
  // least-restrictive, fully model-adaptive preset — so a capable local model is
  // NEVER pinned to the restrictive local_scout. Knobs still auto-tune per model:
  // context scales to the model's window (defaultContextCapTokens), while
  // tool-schema compaction / one-tool-at-a-time / thinking are gated by model
  // family in OllamaProvider.
  const requested = isOllamaRunProfileId(chatProfile) ? chatProfile : 'provider_parity'
  // 'custom' no longer carries per-model overrides (that surface is gone) → fall
  // back to the default full-capability preset.
  const selectedId = requested === 'custom' ? 'provider_parity' : requested
  const base = OLLAMA_RUN_PROFILE_PRESETS[selectedId]
  return {
    ...base,
    id: selectedId,
    contextCapTokens: defaultContextCapTokens(
      selectedId,
      modelId,
      base.contextCapTokens,
      measuredContextTokens
    )
  }
}

export function resolveOllamaThinkingLevel(
  modelId: string,
  profile: Pick<OllamaRunProfile, 'reasoningLevel'>
): OllamaReasoningLevel | undefined {
  const family = resolveOllamaModelFamily(modelId)
  return family === 'gpt_oss_20b' ||
    family === 'qwen3_6_35b' ||
    family === 'minicpm_v45_8b' ||
    family === 'lfm2_5_8b' ||
    family === 'laguna_xs_2_1' ||
    family === 'ornith_9b' ||
    family === 'ornith_35b' ||
    family === 'nemotron3_33b'
    ? profile.reasoningLevel || 'medium'
    : undefined
}
