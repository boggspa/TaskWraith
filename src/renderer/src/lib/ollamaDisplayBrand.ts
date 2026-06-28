import { humaniseModelId } from './modelDisplayName'

type OllamaDisplayBrand = {
  providerLabel: string
  providerClass: string
  modelLabel: string
}

const includesAny = (value: string, needles: string[]): boolean =>
  needles.some((needle) => value.includes(needle))

export function resolveOllamaDisplayBrand(
  modelId: string | undefined | null,
  modelLabel?: string | null
): OllamaDisplayBrand | null {
  const id = String(modelId || '').trim()
  const label = String(modelLabel || humaniseModelId('ollama', id) || '').trim()
  const key = `${id} ${label}`.trim().toLowerCase()
  if (!key) return null

  if (includesAny(key, ['qwen3', 'qwen 3', 'qwen'])) {
    return {
      providerLabel: 'Qwen',
      providerClass: 'qwen',
      modelLabel: label || 'Qwen 3 (4B Param)'
    }
  }

  if (includesAny(key, ['gemma4', 'gemma 4', 'gemma'])) {
    return {
      providerLabel: 'Google',
      providerClass: 'google',
      modelLabel: label || 'Gemma 4 (12B Param)'
    }
  }

  if (includesAny(key, ['gpt-oss', 'gpt oss', 'openai/gpt-oss'])) {
    return {
      providerLabel: 'OpenAI',
      providerClass: 'openai',
      modelLabel: label || 'GPT OSS (20B Param)'
    }
  }

  if (includesAny(key, ['ornith'])) {
    return {
      providerLabel: 'Ornith',
      providerClass: 'ornith',
      modelLabel: label || 'Ornith 1.0 (9B Param)'
    }
  }

  return null
}

export type { OllamaDisplayBrand }
