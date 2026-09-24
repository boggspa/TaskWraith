import {
  isOllamaCloudModelId,
  normalizeOllamaModelKey,
  ollamaCloudBaseModelId
} from './ollamaModelAvailability'

/**
 * Named Ollama Cloud seats that must not be stopped by the local-model
 * tool-loop retry ceiling. Those models can emit several reasoning-only or
 * repair turns while still working; the ceiling's "deferring to the panel"
 * finalize is a false stop for them.
 *
 * Local models stay protected. Cloud rows that are not in this list stay
 * protected. Tagged Cloud variants (`:0731`, `:preview`, `:latest`) inherit
 * the matching family id.
 */
export const OLLAMA_CLOUD_MODELS_WITHOUT_TOOL_LOOP_RETRY_CEILING = [
  'glm-5.3-flash',
  'glm-5.3',
  'deepseek-v4-flash',
  'gemma4:31b',
  'mistral-large-3:675b',
  'gpt-oss:120b',
  'nemotron-3-ultra',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'minimax-m2.7',
  'glm-5.1',
  'gemma4',
  'deepseek-v4-pro',
  'kimi-k3',
  'minimax-m3'
] as const

function matchesExemptCloudBase(base: string, familyId: string): boolean {
  return base === familyId || base.startsWith(`${familyId}:`)
}

export function isOllamaCloudModelExemptFromToolLoopRetryCeiling(modelId?: string | null): boolean {
  if (!isOllamaCloudModelId(modelId)) return false
  const base = normalizeOllamaModelKey(ollamaCloudBaseModelId(modelId))
  return OLLAMA_CLOUD_MODELS_WITHOUT_TOOL_LOOP_RETRY_CEILING.some((familyId) =>
    matchesExemptCloudBase(base, familyId)
  )
}

/** False means the desktop/host retry ceiling must not finalize the run. */
export function ollamaToolLoopRetryCeilingEnabled(modelId?: string | null): boolean {
  return !isOllamaCloudModelExemptFromToolLoopRetryCeiling(modelId)
}
