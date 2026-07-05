import type {
  OllamaReasoningLevel,
  OllamaRunProfile,
  OllamaRunProfileId
} from '../store/types'
import { resolveContextWindow } from '../../shared/contextWindows'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'

const OLLAMA_RUN_PROFILE_CONTEXT_CAP_MAX = 262_144

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

function knownModelContextWindow(modelId?: string | null): number | null {
  const trimmed = String(modelId || '').trim()
  if (!trimmed || resolveOllamaModelFamily(trimmed) === 'unknown') return null
  return resolveContextWindow('ollama', trimmed)
}

function defaultContextCapTokens(
  baseId: Exclude<OllamaRunProfileId, 'custom'>,
  modelId: string | null | undefined,
  fallback: number
): number {
  const modelWindow = knownModelContextWindow(modelId)
  if (!modelWindow) return fallback
  if (baseId === 'local_scout') return Math.min(modelWindow, 65_536)
  if (baseId === 'provider_parity') {
    return Math.min(modelWindow, OLLAMA_RUN_PROFILE_CONTEXT_CAP_MAX)
  }
  return Math.min(modelWindow, 131_072)
}

export function resolveOllamaRunProfile(
  modelId?: string | null,
  chatProfile?: string | null
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
    contextCapTokens: defaultContextCapTokens(selectedId, modelId, base.contextCapTokens)
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
