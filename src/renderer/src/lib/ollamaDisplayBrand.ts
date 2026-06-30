import { humaniseModelId } from './modelDisplayName'

type OllamaDisplayBrand = {
  providerLabel: string
  providerClass: string
  modelLabel: string
}

type OllamaDisplayBrandDefinition = {
  id: string
  providerLabel: string
  providerClass: string
  needles: string[]
  fallbackModelLabel: string
}

const OLLAMA_DISPLAY_BRANDS: readonly OllamaDisplayBrandDefinition[] = [
  {
    id: 'alibaba',
    providerLabel: 'Alibaba',
    providerClass: 'alibaba',
    needles: ['qwen3', 'qwen 3', 'qwen'],
    fallbackModelLabel: 'Qwen 3 (4B Param)'
  },
  {
    id: 'deep-reinforce',
    providerLabel: 'Deep Reinforce',
    providerClass: 'deep-reinforce',
    needles: ['ornith'],
    fallbackModelLabel: 'Ornith 1.0 (9B Param)'
  },
  {
    id: 'google',
    providerLabel: 'Google',
    providerClass: 'google',
    needles: ['gemma4', 'gemma 4', 'gemma'],
    fallbackModelLabel: 'Gemma 4 (12B Param)'
  },
  {
    id: 'ibm',
    providerLabel: 'IBM',
    providerClass: 'ibm',
    needles: ['granite4.1', 'granite 4.1', 'granite'],
    fallbackModelLabel: 'Granite 4.1 (3B Param)'
  },
  {
    id: 'liquid',
    providerLabel: 'Liquid',
    providerClass: 'liquid',
    needles: ['lfm2.5', 'lfm 2.5', 'lfm'],
    fallbackModelLabel: 'LFM 2.5 (8B-1A)'
  },
  {
    id: 'nvidia',
    providerLabel: 'NVIDIA',
    providerClass: 'nvidia',
    needles: ['nemotron3', 'nemotron 3', 'nemotron'],
    fallbackModelLabel: 'Nemotron 3 Nano Omni (33B Param)'
  },
  {
    id: 'openai',
    providerLabel: 'OpenAI',
    providerClass: 'openai',
    needles: ['gpt-oss', 'gpt oss', 'openai/gpt-oss'],
    fallbackModelLabel: 'GPT OSS (20B Param)'
  },
  {
    id: 'openbmb',
    providerLabel: 'OpenBMB',
    providerClass: 'openbmb',
    needles: ['minicpm-v4.5', 'minicpm v4.5', 'minicpm'],
    fallbackModelLabel: 'MiniCPM-V 4.5 (8B Param)'
  }
]

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

  const definition = OLLAMA_DISPLAY_BRANDS.find((brand) => includesAny(key, brand.needles))
  if (definition) {
    return {
      providerLabel: definition.providerLabel,
      providerClass: definition.providerClass,
      modelLabel: label || definition.fallbackModelLabel
    }
  }

  return null
}

/**
 * Resolve the CSS hue class for a provider + model. Returns the runtime
 * provider id for everything except Ollama-backed display brands, which
 * resolve to their spoofed upstream brand class (e.g. `alibaba`). Callers
 * compose this into `var(--provider-${class}-color)` for tinting — used by
 * the @-mention chips so a `@Planner` running Qwen paints Alibaba purple
 * instead of generic Ollama green, matching the transcript header.
 */
export function resolveProviderHueClass(
  provider: string | undefined | null,
  modelId?: string | null,
  modelLabel?: string | null
): string {
  const id = String(provider || '').trim()
  if (id === 'ollama') {
    const brand = resolveOllamaDisplayBrand(modelId, modelLabel)
    if (brand) return brand.providerClass
  }
  return id
}

/**
 * Spoofed upstream brand label for an Ollama-backed model (e.g. "Alibaba"),
 * or null for non-Ollama providers / unbranded Ollama models. Lets mention
 * chips fall back to the brand name instead of "Ollama" when a participant
 * has no explicit role.
 */
export function resolveProviderBrandLabel(
  provider: string | undefined | null,
  modelId?: string | null,
  modelLabel?: string | null
): string | null {
  if (String(provider || '').trim() === 'ollama') {
    const brand = resolveOllamaDisplayBrand(modelId, modelLabel)
    if (brand) return brand.providerLabel
  }
  return null
}

export { OLLAMA_DISPLAY_BRANDS }
export type { OllamaDisplayBrand, OllamaDisplayBrandDefinition }
