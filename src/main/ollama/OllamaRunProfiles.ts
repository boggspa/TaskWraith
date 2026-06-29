import type {
  AppSettings,
  OllamaReasoningLevel,
  OllamaRunProfile,
  OllamaRunProfileId,
  OllamaToolControlTier
} from '../store/types'
import { resolveContextWindow } from '../../shared/contextWindows'
import { resolveOllamaModelFamily } from './OllamaModelPreflight'
import { normalizeOllamaToolControlTier } from './OllamaToolTiers'

const OLLAMA_RUN_PROFILE_CONTEXT_CAP_MAX = 262_144

export const OLLAMA_RUN_PROFILE_PRESETS: Record<
  Exclude<OllamaRunProfileId, 'custom'>,
  Required<Pick<OllamaRunProfile, 'id' | 'label' | 'tier' | 'reasoningLevel' | 'contextCapTokens' | 'protocolMode' | 'compactToolSchemas' | 'oneToolAtATime' | 'numPredictTool' | 'numPredictFinal' | 'keepAlive'>>
> = {
  local_scout: {
    id: 'local_scout',
    label: 'Local Scout',
    tier: 'read_only',
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
    tier: 'approved_edits',
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
    tier: 'approved_shell',
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
    tier: 'provider_parity',
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

function profileIdForTier(tier: OllamaToolControlTier): Exclude<OllamaRunProfileId, 'custom'> {
  if (tier === 'approved_edits') return 'approved_patcher'
  if (tier === 'approved_shell') return 'verify_with_shell'
  if (tier === 'provider_parity') return 'provider_parity'
  return 'local_scout'
}

function sanitizeReasoningLevel(value: unknown, fallback: OllamaReasoningLevel): OllamaReasoningLevel {
  return value === 'low' || value === 'medium' || value === 'high' ? value : fallback
}

function sanitizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(numeric)))
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
  settings: Pick<
    AppSettings,
    'ollamaDefaultRunProfile' | 'ollamaRunProfiles' | 'ollamaToolControlTier'
  >,
  effectiveTier: OllamaToolControlTier,
  modelId?: string | null,
  chatProfile?: string | null
): OllamaRunProfile {
  // A per-chat run-profile (composer picker) wins over the global default; an
  // absent/invalid value falls back to the global setting, then to the
  // tier-derived profile.
  const selectedId = isOllamaRunProfileId(chatProfile)
    ? chatProfile
    : isOllamaRunProfileId(settings.ollamaDefaultRunProfile)
      ? settings.ollamaDefaultRunProfile
      : profileIdForTier(effectiveTier)
  const baseId =
    selectedId === 'custom' ? profileIdForTier(effectiveTier) : selectedId
  const base = OLLAMA_RUN_PROFILE_PRESETS[baseId]
  const custom =
    (modelId && settings.ollamaRunProfiles?.[modelId]) ||
    settings.ollamaRunProfiles?.default ||
    {}
  const tier = normalizeOllamaToolControlTier(custom.tier || base.tier)
  const fallbackContextCapTokens = defaultContextCapTokens(
    baseId,
    modelId,
    base.contextCapTokens
  )
  return {
    ...base,
    ...custom,
    id: selectedId,
    label: custom.label || base.label,
    tier,
    reasoningLevel: sanitizeReasoningLevel(custom.reasoningLevel, base.reasoningLevel),
    contextCapTokens: sanitizePositiveInt(
      custom.contextCapTokens,
      fallbackContextCapTokens,
      4096,
      OLLAMA_RUN_PROFILE_CONTEXT_CAP_MAX
    ),
    protocolMode:
      custom.protocolMode === 'json_fallback' || custom.protocolMode === 'json_only'
        ? custom.protocolMode
        : base.protocolMode,
    compactToolSchemas:
      typeof custom.compactToolSchemas === 'boolean'
        ? custom.compactToolSchemas
        : base.compactToolSchemas,
    oneToolAtATime:
      typeof custom.oneToolAtATime === 'boolean' ? custom.oneToolAtATime : base.oneToolAtATime,
    numPredictTool: sanitizePositiveInt(custom.numPredictTool, base.numPredictTool, 256, 8192),
    numPredictFinal: sanitizePositiveInt(custom.numPredictFinal, base.numPredictFinal, 512, 16_384),
    keepAlive: typeof custom.keepAlive === 'string' && custom.keepAlive.trim()
      ? custom.keepAlive.trim()
      : base.keepAlive
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
    family === 'ornith_9b' ||
    family === 'ornith_35b' ||
    family === 'nemotron3_33b'
    ? profile.reasoningLevel || 'medium'
    : undefined
}
