import {
  normalizeOllamaModelKey,
  ollamaCloudBaseModelId,
  ollamaModelIdAliases
} from './ollamaModelAvailability'

export type OllamaReasoningEffort = 'off' | 'on' | 'low' | 'medium' | 'high'

export type OllamaReasoningSupport =
  | { kind: 'unsupported'; efforts: readonly []; defaultEffort: null }
  | { kind: 'toggle'; efforts: readonly ['off', 'on']; defaultEffort: 'on' }
  | {
      kind: 'levels'
      efforts: readonly ['low', 'medium', 'high']
      defaultEffort: 'high'
    }
  | { kind: 'unknown'; efforts: readonly []; defaultEffort: null }

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
const LEVEL_EFFORTS = ['low', 'medium', 'high'] as const

// Curated fallbacks keep the picker useful before live daemon metadata arrives.
// Runtime launch still prefers exact `/api/show` capabilities, so a retagged or
// upgraded model can override this table without waiting for a TaskWraith build.
const KNOWN_TOGGLE_MODEL_IDS = [
  'qwen3:4b-instruct',
  'qwen3.5:2b',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'qwen3.6:35b',
  'qwen3.8:27b-mlx',
  'gemma4:12b',
  'gemma4:31b-mlx',
  'ornith:9b',
  'ornith:35b',
  'ornith-1.5:35b',
  'laguna-xs-2.1:q8_0',
  'lfm2.5-thinking:1.2b',
  'lfm2.5:8b',
  'minicpm-v4.5:8b',
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

export function isOllamaGptOssModel(modelId?: string | null): boolean {
  const key = normalizedBaseModelId(modelId)
  return ollamaModelIdAliases(key).some(
    (alias) => alias === 'gpt-oss' || alias === 'gpt-oss:20b' || alias === 'gpt-oss:latest'
  )
}

function staticOllamaReasoningSupport(modelId?: string | null): OllamaReasoningSupport {
  const key = normalizedBaseModelId(modelId)
  if (!key) return { kind: 'unknown', efforts: [], defaultEffort: null }
  if (isOllamaGptOssModel(key)) {
    return { kind: 'levels', efforts: LEVEL_EFFORTS, defaultEffort: 'high' }
  }
  if (KNOWN_TOGGLE_MODEL_IDS.some((candidate) => matchesCuratedModel(key, candidate))) {
    return { kind: 'toggle', efforts: TOGGLE_EFFORTS, defaultEffort: 'on' }
  }
  if (KNOWN_NON_THINKING_MODEL_IDS.some((candidate) => matchesCuratedModel(key, candidate))) {
    return { kind: 'unsupported', efforts: [], defaultEffort: null }
  }
  return { kind: 'unknown', efforts: [], defaultEffort: null }
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
    if (!thinking) return { kind: 'unsupported', efforts: [], defaultEffort: null }
    return isOllamaGptOssModel(input.modelId)
      ? { kind: 'levels', efforts: LEVEL_EFFORTS, defaultEffort: 'high' }
      : { kind: 'toggle', efforts: TOGGLE_EFFORTS, defaultEffort: 'on' }
  }
  return staticOllamaReasoningSupport(input.modelId)
}

export function normalizeOllamaReasoningEffort(
  value: unknown,
  support: OllamaReasoningSupport
): OllamaReasoningEffort | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  if (support.kind === 'toggle') {
    if (normalized === 'off' || normalized === 'false') return 'off'
    if (
      normalized === 'on' ||
      normalized === 'true' ||
      normalized === 'low' ||
      normalized === 'medium' ||
      normalized === 'high'
    ) {
      return 'on'
    }
    return support.defaultEffort
  }
  if (support.kind === 'levels') {
    return support.efforts.includes(normalized as 'low' | 'medium' | 'high')
      ? (normalized as 'low' | 'medium' | 'high')
      : support.defaultEffort
  }
  return null
}
