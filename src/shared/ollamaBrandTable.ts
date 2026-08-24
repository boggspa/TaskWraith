/**
 * Shared Ollama display-brand table — the single source of truth for the
 * "brand spoof" presentation used across renderer, main, and (mirrored in)
 * iOS. Local and Cloud Ollama models stay `provider: 'ollama'` at runtime;
 * this table maps a model id to its upstream brand NAME + hue CLASS so a Qwen /
 * GLM / MiniMax / Kimi model keeps its maker accent without losing the Ollama
 * Cloud source classifier.
 *
 * Renderer adds humanised-label fallback on top (see
 * src/renderer/src/lib/ollamaDisplayBrand.ts); main uses the raw matcher for
 * the remote transcript speaker projection. Keep in lockstep with the iOS
 * twin (ios/.../OllamaDisplayBrand.swift).
 */

import { resolvePiUpstreamBrand } from './piBrandTable'

export type OllamaDisplayBrandDefinition = {
  id: string
  providerLabel: string
  providerClass: string
  needles: string[]
  fallbackModelLabel: string
}

export const OLLAMA_DISPLAY_BRANDS: readonly OllamaDisplayBrandDefinition[] = [
  {
    id: 'alibaba',
    providerLabel: 'Alibaba',
    providerClass: 'alibaba',
    needles: ['qwen3', 'qwen 3', 'qwen'],
    fallbackModelLabel: 'Qwen 3 (4B Param)'
  },
  {
    id: 'cohere',
    providerLabel: 'Cohere',
    providerClass: 'cohere',
    needles: ['north-mini-code-1.0', 'north mini code 1.0', 'north mini code'],
    fallbackModelLabel: 'North Mini Code 1.0 (30B-A3B Q4)'
  },
  {
    id: 'deepseek',
    providerLabel: 'DeepSeek',
    providerClass: 'deepseek',
    needles: ['deepseek-r1', 'deepseek r1', 'deepseek'],
    fallbackModelLabel: 'DeepSeek R1 (8B Param)'
  },
  {
    id: 'deep-reinforce',
    providerLabel: 'Deep Reinforce',
    providerClass: 'deep-reinforce',
    needles: ['ornith'],
    fallbackModelLabel: 'Ornith 1.0 (9B Param)'
  },
  {
    id: 'essential',
    providerLabel: 'Essential AI',
    providerClass: 'essential',
    needles: ['rnj-1', 'rnj 1'],
    fallbackModelLabel: 'Rnj-1 (8B Param)'
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
    id: 'kimi',
    providerLabel: 'Kimi',
    providerClass: 'kimi',
    needles: ['kimi-'],
    fallbackModelLabel: 'Kimi K3'
  },
  {
    id: 'liquid',
    providerLabel: 'Liquid',
    providerClass: 'liquid',
    needles: ['lfm2.5', 'lfm 2.5', 'lfm'],
    fallbackModelLabel: 'LFM 2.5 (8B-A1B)'
  },
  {
    id: 'meta',
    providerLabel: 'Meta',
    providerClass: 'meta',
    needles: ['muse-glimmer', 'muse glimmer', 'llama3.1', 'llama 3.1', 'llama3.2', 'llama 3.2'],
    fallbackModelLabel: 'Llama 3.1 (8B Param)'
  },
  {
    id: 'minimax',
    providerLabel: 'MiniMax',
    providerClass: 'minimax',
    needles: ['minimax-', 'minimax '],
    fallbackModelLabel: 'MiniMax M3'
  },
  {
    // The `mistral` hue class + label already exist for the first-class Mistral
    // Vibe seat, so a local Devstral / Ministral tag reuses them rather than
    // introducing a tenth brand colour. `ministral` needs its own needle:
    // 'mistral' is NOT a substring of 'ministral'.
    id: 'mistral',
    providerLabel: 'Mistral',
    providerClass: 'mistral',
    needles: ['devstral', 'ministral', 'magistral', 'mistral'],
    fallbackModelLabel: 'Devstral Small 2 (24B Param)'
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
  },
  {
    id: 'poolside',
    providerLabel: 'Poolside',
    providerClass: 'poolside',
    needles: ['laguna-xs-2.1', 'laguna xs 2.1', 'laguna'],
    fallbackModelLabel: 'Laguna XS 2.1 (33B-A3B Q8)'
  },
  {
    id: 'zai',
    providerLabel: 'Z.ai',
    providerClass: 'zai',
    needles: ['glm-', 'glm '],
    fallbackModelLabel: 'GLM-4.7-Flash (30B-A3B Q4)'
  }
]

export type OllamaBrandMatch = {
  providerLabel: string
  providerClass: string
  fallbackModelLabel: string
}

const includesAny = (value: string, needles: string[]): boolean =>
  needles.some((needle) => value.includes(needle))

/**
 * Pure brand matcher — substring-matches the lowercased `"${id} ${label}"`
 * key against each brand's needles. No humanised-label dependency, so it's
 * safe to call from main / shared contexts.
 */
export function matchOllamaBrand(
  modelId: string | undefined | null,
  modelLabel?: string | null
): OllamaBrandMatch | null {
  const id = String(modelId || '').trim()
  const label = String(modelLabel || '').trim()
  const match = (value: string): OllamaDisplayBrandDefinition | undefined =>
    value ? OLLAMA_DISPLAY_BRANDS.find((brand) => includesAny(value, brand.needles)) : undefined
  // Provider events may arrive with a stale human label while their wire model
  // id is current. The id is the authoritative identity; considering the
  // concatenated label first let an earlier table entry (e.g. Qwen) hijack a
  // later DeepSeek run mid-stream.
  const definition = match(id.toLowerCase()) || match(label.toLowerCase())
  if (!definition) return null
  return {
    providerLabel: definition.providerLabel,
    providerClass: definition.providerClass,
    fallbackModelLabel: definition.fallbackModelLabel
  }
}

/** Frozen presentation for a participant-health chip at stamp time. Health
 * cards are per-round audit records — never re-resolve from the live roster.
 * Both model-backed runtime seats resolve through their upstream brand. */
export function resolveHealthEntryPresentation(
  provider: string,
  modelId: string | undefined | null,
  fallbackProviderLabel: string
): { displayProviderLabel: string; displayHueClass: string } {
  const id = String(provider || '').trim()
  if (id === 'ollama') {
    const brand = matchOllamaBrand(modelId)
    if (brand) {
      return {
        displayProviderLabel: brand.providerLabel,
        displayHueClass: brand.providerClass
      }
    }
  }
  if (id === 'pi') {
    const brand = resolvePiUpstreamBrand(modelId)
    if (brand) {
      return {
        displayProviderLabel: brand.label,
        displayHueClass: brand.hueClass
      }
    }
  }
  return { displayProviderLabel: fallbackProviderLabel, displayHueClass: id }
}
