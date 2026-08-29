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

/** Internal picker id for a model served by the direct Ollama Cloud API. */
export function ollamaCloudModelId(modelId?: string | null): string {
  const value = String(modelId || '').trim()
  if (!value || isOllamaCloudModelId(value)) return value
  return `${value}:cloud`
}

const OLLAMA_CLOUD_MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-flash:0731': 'DeepSeek V4 Flash (0731)',
  'deepseek-v4-flash:preview': 'DeepSeek V4 Flash (Preview)',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek-v4-pro:0813': 'DeepSeek V4 Pro (0813)',
  'deepseek-v4-pro:preview': 'DeepSeek V4 Pro (Preview)',
  gemma4: 'Gemma 4',
  'gemma4:31b': 'Gemma 4 (31B Param)',
  'glm-5.3-flash': 'GLM 5.3 Flash',
  'glm-5.3': 'GLM 5.3',
  'glm-5.2': 'GLM 5.2',
  'glm-5.1': 'GLM 5.1',
  'gpt-oss:20b': 'GPT OSS (20B Param)',
  'gpt-oss:120b': 'GPT OSS (120B Param)',
  'kimi-k2.5': 'Kimi K2.5',
  'kimi-k2.6': 'Kimi K2.6',
  'kimi-k2.7-code': 'Kimi K2.7 Code',
  'kimi-k3': 'Kimi K3',
  'minimax-m2.7': 'MiniMax M2.7',
  'minimax-m3': 'MiniMax M3',
  'mistral-large-3:675b': 'Mistral Large 3 (675B Param)',
  'nemotron-3-nano:30b': 'Nemotron 3 Nano (30B Param)',
  'nemotron-3-super': 'Nemotron 3 Super',
  'nemotron-3-ultra': 'Nemotron 3 Ultra',
  'qwen3.5:397b': 'Qwen 3.5 (397B Param)'
}

const OLLAMA_MODEL_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['mistral-medium-3.5', 'mistral-medium-3.5:latest', 'mistral-medium-3.5:128b'],
  ['granite4.2', 'granite4.2:latest', 'granite4.2:8b']
]

/**
 * Resolve Cloud account model ids to product-facing names without changing the
 * exact wire id used by the daemon. Unknown recommendations deliberately return
 * undefined so callers can preserve a new upstream id instead of guessing.
 */
export function ollamaCloudModelDisplayName(modelId?: string | null): string | undefined {
  const key = normalizeOllamaModelKey(ollamaCloudBaseModelId(modelId))
  return OLLAMA_CLOUD_MODEL_DISPLAY_NAMES[key]
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
  const curatedGroup = OLLAMA_MODEL_ALIAS_GROUPS.find((group) => group.includes(key))
  for (const alias of curatedGroup || []) aliases.add(alias)
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
