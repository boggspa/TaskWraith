const SAFE_OLLAMA_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/

export function normalizeOllamaModelKey(modelId?: string | null): string {
  return String(modelId || '')
    .trim()
    .toLowerCase()
}

/**
 * Ollama's local daemon accepts both the current `:cloud` source suffix and
 * the legacy `-cloud` tag suffix. Keep this source classifier shared by main
 * and renderer so a cloud row can never be mistaken for a pullable local tag.
 */
export function isOllamaCloudModelId(modelId?: string | null): boolean {
  const key = normalizeOllamaModelKey(modelId)
  return key.endsWith(':cloud') || key.endsWith('-cloud')
}

/** Remove only Ollama's explicit cloud source marker, preserving the model tag. */
export function ollamaCloudBaseModelId(modelId?: string | null): string {
  const value = String(modelId || '').trim()
  if (!isOllamaCloudModelId(value)) return value
  if (value.toLowerCase().endsWith(':cloud')) return value.slice(0, -':cloud'.length)
  return value.slice(0, -'-cloud'.length)
}

export function ollamaModelIdAliases(modelId?: string | null): string[] {
  const key = normalizeOllamaModelKey(modelId)
  if (!key) return []
  const aliases = new Set<string>([key])
  const withoutLatest = key.replace(/:latest$/, '')
  if (withoutLatest && withoutLatest !== key) aliases.add(withoutLatest)
  if (!key.includes(':')) aliases.add(`${key}:latest`)
  if (key === 'gpt-oss' || key === 'gpt-oss:20b' || key === 'gpt-oss:latest') {
    aliases.add('gpt-oss')
    aliases.add('gpt-oss:20b')
    aliases.add('gpt-oss:latest')
    aliases.add('openai/gpt-oss-20b')
  }
  if (key === 'openai/gpt-oss-20b') {
    aliases.add('gpt-oss')
    aliases.add('gpt-oss:20b')
    aliases.add('gpt-oss:latest')
  }
  if (key === 'ornith' || key === 'ornith:latest' || key === 'ornith:9b') {
    aliases.add('ornith')
    aliases.add('ornith:latest')
    aliases.add('ornith:9b')
  }
  if (key === 'gemma3' || key === 'gemma3:latest' || key === 'gemma3:4b') {
    aliases.add('gemma3')
    aliases.add('gemma3:latest')
    aliases.add('gemma3:4b')
  }
  if (
    key === 'lfm2.5-thinking' ||
    key === 'lfm2.5-thinking:latest' ||
    key === 'lfm2.5-thinking:1.2b'
  ) {
    aliases.add('lfm2.5-thinking')
    aliases.add('lfm2.5-thinking:latest')
    aliases.add('lfm2.5-thinking:1.2b')
  }
  if (key === 'lfm2.5' || key === 'lfm2.5:latest' || key === 'lfm2.5:8b') {
    aliases.add('lfm2.5')
    aliases.add('lfm2.5:latest')
    aliases.add('lfm2.5:8b')
  }
  if (key === 'rnj-1' || key === 'rnj-1:latest' || key === 'rnj-1:8b') {
    aliases.add('rnj-1')
    aliases.add('rnj-1:latest')
    aliases.add('rnj-1:8b')
  }
  return [...aliases]
}

export function ollamaModelIdsMatch(requested?: string | null, installed?: string | null): boolean {
  const requestedAliases = new Set(ollamaModelIdAliases(requested))
  if (requestedAliases.size === 0) return false
  return ollamaModelIdAliases(installed).some((alias) => requestedAliases.has(alias))
}

export function isOllamaModelInstalled(
  requestedModelId: string,
  installedModelIds: readonly string[]
): boolean {
  return installedModelIds.some((installedModelId) =>
    ollamaModelIdsMatch(requestedModelId, installedModelId)
  )
}

export function buildOllamaPullCommand(modelId?: string | null): string | null {
  const trimmed = String(modelId || '').trim()
  if (!trimmed || trimmed === 'custom' || trimmed.startsWith('-')) return null
  if (isOllamaCloudModelId(trimmed)) return null
  if (!SAFE_OLLAMA_MODEL_ID.test(trimmed)) return null
  return `ollama pull ${trimmed}`
}
