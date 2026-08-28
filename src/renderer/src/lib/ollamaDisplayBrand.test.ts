import { describe, expect, it } from 'vitest'
import {
  OLLAMA_DISPLAY_BRANDS,
  providerAccentVar,
  resolveOllamaDisplayBrand,
  resolveProviderBrandLabel,
  resolveProviderHueClass
} from './ollamaDisplayBrand'

describe('resolveOllamaDisplayBrand', () => {
  it('maps curated Ollama models to their upstream provider brands', () => {
    expect(resolveOllamaDisplayBrand('qwen3.6:35b', 'Qwen 3.6 (35B-A3B)')).toMatchObject({
      providerLabel: 'Alibaba',
      providerClass: 'alibaba'
    })
    expect(resolveOllamaDisplayBrand('qwen3.8:27b-mlx')).toMatchObject({
      providerLabel: 'Alibaba',
      providerClass: 'alibaba',
      modelLabel: 'Qwen 3.8 (27B-MLX)'
    })
    expect(resolveOllamaDisplayBrand('qwen3.8-flash-next:125b-mlx')).toMatchObject({
      providerLabel: 'Alibaba',
      providerClass: 'alibaba',
      modelLabel: 'Qwen 3.8 Flash Next (125B-MLX)'
    })
    expect(resolveOllamaDisplayBrand('ornith:35b', 'Ornith 1.0 (35B Param)')).toMatchObject({
      providerLabel: 'Deep Reinforce',
      providerClass: 'deep-reinforce'
    })
    expect(resolveOllamaDisplayBrand('ornith-1.5:35b')).toMatchObject({
      providerLabel: 'Deep Reinforce',
      providerClass: 'deep-reinforce',
      modelLabel: 'Ornith 1.5 (35B Param)'
    })
    expect(resolveOllamaDisplayBrand('gemma4:12b', 'Gemma 4 (12B Param)')).toMatchObject({
      providerLabel: 'Google',
      providerClass: 'google'
    })
    expect(resolveOllamaDisplayBrand('gemma4:31b-mlx', 'Gemma 4 (31B-MLX)')).toMatchObject({
      providerLabel: 'Google',
      providerClass: 'google'
    })
    expect(resolveOllamaDisplayBrand('granite4.1:30b', 'Granite 4.1 (30B Param)')).toMatchObject({
      providerLabel: 'IBM',
      providerClass: 'ibm'
    })
    expect(resolveOllamaDisplayBrand('granite4.2:8b')).toMatchObject({
      providerLabel: 'IBM',
      providerClass: 'ibm',
      modelLabel: 'Granite 4.2 (8B Param)'
    })
    expect(resolveOllamaDisplayBrand('lfm2.5:8b', 'LFM 2.5 (8B-A1B)')).toMatchObject({
      providerLabel: 'Liquid',
      providerClass: 'liquid'
    })
    expect(
      resolveOllamaDisplayBrand('nemotron3:33b', 'Nemotron 3 Nano Omni (33B Param)')
    ).toMatchObject({
      providerLabel: 'NVIDIA',
      providerClass: 'nvidia'
    })
    expect(resolveOllamaDisplayBrand('nemotron-3.5-lightning:30b-mlx')).toMatchObject({
      providerLabel: 'NVIDIA',
      providerClass: 'nvidia',
      modelLabel: 'Nemotron 3.5 Lightning (30B-MLX)'
    })
    expect(resolveOllamaDisplayBrand('gpt-oss:20b', 'GPT OSS (20B Param)')).toMatchObject({
      providerLabel: 'OpenAI',
      providerClass: 'openai'
    })
    expect(resolveOllamaDisplayBrand('minicpm-v4.5:8b', 'MiniCPM-V 4.5 (8B Param)')).toMatchObject({
      providerLabel: 'OpenBMB',
      providerClass: 'openbmb'
    })
    expect(resolveOllamaDisplayBrand('laguna-xs-2.1:q8_0')).toMatchObject({
      providerLabel: 'Poolside',
      providerClass: 'poolside'
    })
    expect(
      resolveOllamaDisplayBrand('devstral-small-2:24b', 'Devstral Small 2 (24B Param)')
    ).toMatchObject({
      providerLabel: 'Mistral',
      providerClass: 'mistral'
    })
    expect(resolveOllamaDisplayBrand('mistral-medium-3.5:128b')).toMatchObject({
      providerLabel: 'Mistral',
      providerClass: 'mistral',
      modelLabel: 'Mistral Medium 3.5 (128B Param)'
    })
    expect(resolveOllamaDisplayBrand('ministral-3:14b', 'Ministral 3 (14B Param)')).toMatchObject({
      providerLabel: 'Mistral',
      providerClass: 'mistral'
    })
    expect(resolveOllamaDisplayBrand('llama3.1:8b')).toMatchObject({
      providerLabel: 'Meta',
      providerClass: 'meta'
    })
    expect(resolveOllamaDisplayBrand('llama3.2:3b')?.providerClass).toBe('meta')
    expect(resolveOllamaDisplayBrand('muse-glimmer:30b-mlx')).toMatchObject({
      providerLabel: 'Meta',
      providerClass: 'meta',
      modelLabel: 'Muse Glimmer (30B-MLX)'
    })
    expect(resolveOllamaDisplayBrand('deepseek-r1:8b')?.providerClass).toBe('deepseek')
    expect(resolveOllamaDisplayBrand('rnj-1')?.providerLabel).toBe('Essential AI')
    expect(resolveOllamaDisplayBrand('glm-4.7-flash:q4_K_M')?.providerClass).toBe('zai')
    expect(resolveOllamaDisplayBrand('north-mini-code-1.0:q4_K_M')?.providerClass).toBe('cohere')
    expect(resolveOllamaDisplayBrand('glm-5.3-flash:cloud')).toMatchObject({
      providerLabel: 'Z.ai',
      providerClass: 'zai',
      modelLabel: 'GLM 5.3 Flash'
    })
    expect(resolveOllamaDisplayBrand('glm-5.2:cloud')).toMatchObject({
      providerLabel: 'Z.ai',
      providerClass: 'zai',
      modelLabel: 'GLM 5.2'
    })
    expect(resolveOllamaDisplayBrand('minimax-m3:cloud')).toMatchObject({
      providerLabel: 'MiniMax',
      providerClass: 'minimax',
      modelLabel: 'MiniMax M3'
    })
    expect(resolveOllamaDisplayBrand('kimi-k2.7-code:cloud')).toMatchObject({
      providerLabel: 'Kimi',
      providerClass: 'kimi',
      modelLabel: 'Kimi K2.7 Code'
    })
    expect(resolveOllamaDisplayBrand('deepseek-v4-pro:cloud')).toMatchObject({
      providerLabel: 'DeepSeek',
      providerClass: 'deepseek',
      modelLabel: 'DeepSeek V4 Pro'
    })
    expect(resolveOllamaDisplayBrand('deepseek-v4-flash:cloud')).toMatchObject({
      providerLabel: 'DeepSeek',
      providerClass: 'deepseek',
      modelLabel: 'DeepSeek V4 Flash'
    })
    expect(resolveOllamaDisplayBrand('gemma4:cloud')).toMatchObject({
      providerLabel: 'Google',
      providerClass: 'google',
      modelLabel: 'Gemma 4'
    })
  })

  it('matches the local Mistral tags from the bare id, with no label to help', () => {
    // `ministral` needs its own needle — 'mistral' is NOT a substring of it, so
    // a single 'mistral' needle would leave Ministral unbranded.
    expect(resolveOllamaDisplayBrand('ministral-3:14b')?.providerClass).toBe('mistral')
    expect(resolveOllamaDisplayBrand('devstral-small-2:24b')?.providerClass).toBe('mistral')
  })

  it('reuses the existing upstream hues for the lightweight catalog', () => {
    const expected = new Map([
      ['ministral-3:3b', 'mistral'],
      ['granite4:3b', 'ibm'],
      ['qwen3.5:2b', 'alibaba'],
      ['deepseek-r1:1.5b', 'deepseek'],
      ['nemotron-3-nano:4b', 'nvidia'],
      ['lfm2.5-thinking:1.2b', 'liquid'],
      ['gemma3:4b', 'google']
    ])
    for (const [modelId, providerClass] of expected) {
      expect(resolveOllamaDisplayBrand(modelId)?.providerClass).toBe(providerClass)
    }
  })

  it('keeps the provider picker order explicit', () => {
    expect(OLLAMA_DISPLAY_BRANDS.map((brand) => brand.id)).toEqual([
      'alibaba',
      'cohere',
      'deepseek',
      'deep-reinforce',
      'essential',
      'google',
      'ibm',
      'kimi',
      'liquid',
      'meta',
      'minimax',
      'mistral',
      'nvidia',
      'openai',
      'openbmb',
      'poolside',
      'zai'
    ])
  })
})

describe('resolveProviderHueClass', () => {
  it('returns the spoofed brand class for Ollama display brands', () => {
    expect(resolveProviderHueClass('ollama', 'qwen3.5:9b')).toBe('alibaba')
    expect(resolveProviderHueClass('ollama', 'gemma4:12b')).toBe('google')
    expect(resolveProviderHueClass('ollama', 'gemma4:31b-mlx')).toBe('google')
    expect(resolveProviderHueClass('ollama', 'gpt-oss:20b')).toBe('openai')
    expect(resolveProviderHueClass('ollama', 'laguna-xs-2.1:q8_0')).toBe('poolside')
    // Reuses the first-class Mistral seat's hue — one brand, one colour.
    expect(resolveProviderHueClass('ollama', 'devstral-small-2:24b')).toBe('mistral')
    expect(resolveProviderHueClass('ollama', 'ministral-3:14b')).toBe('mistral')
    expect(resolveProviderHueClass('ollama', 'llama3.2:3b')).toBe('meta')
    expect(resolveProviderHueClass('ollama', 'muse-glimmer:30b-mlx')).toBe('meta')
    expect(resolveProviderHueClass('ollama', 'nemotron-3.5-lightning:30b-mlx')).toBe('nvidia')
    expect(resolveProviderHueClass('ollama', 'deepseek-r1:8b')).toBe('deepseek')
    expect(resolveProviderHueClass('ollama', 'glm-4.7-flash:q4_K_M')).toBe('zai')
    expect(resolveProviderHueClass('ollama', 'glm-5.3-flash:cloud')).toBe('zai')
    expect(resolveProviderHueClass('ollama', 'glm-5.2:cloud')).toBe('zai')
    expect(resolveProviderHueClass('ollama', 'minimax-m3:cloud')).toBe('minimax')
    expect(resolveProviderHueClass('ollama', 'kimi-k3:cloud')).toBe('kimi')
  })

  it('returns the runtime provider for non-brand models', () => {
    expect(resolveProviderHueClass('ollama', 'some-unknown-local-model')).toBe('ollama')
    expect(resolveProviderHueClass('claude', 'claude-opus-4-8')).toBe('claude')
    expect(resolveProviderHueClass('codex')).toBe('codex')
  })
})

describe('providerAccentVar', () => {
  it('turns a resolved branding hue into the scoped provider accent token', () => {
    expect(providerAccentVar('deepseek')).toBe('var(--provider-deepseek-color, var(--accent))')
    expect(providerAccentVar('Deep-Reinforce')).toBe(
      'var(--provider-deep-reinforce-color, var(--accent))'
    )
  })

  it('refuses unsafe or absent hue classes so callers inherit their parent accent', () => {
    expect(providerAccentVar(undefined)).toBeNull()
    expect(providerAccentVar('deepseek); color: red')).toBeNull()
  })
})

describe('resolveProviderHueClass — Pi BYOK upstreams', () => {
  it('paints a Pi row with the upstream that actually serves it', () => {
    expect(resolveProviderHueClass('pi', 'deepseek/deepseek-v4-flash')).toBe('deepseek')
    expect(resolveProviderHueClass('pi', 'mistral/devstral-2512')).toBe('mistral')
    expect(resolveProviderHueClass('pi', 'cerebras/gpt-oss-120b')).toBe('cerebras')
    expect(resolveProviderHueClass('pi', 'zai/glm-5.2')).toBe('zai')
    expect(resolveProviderHueClass('pi', 'minimax/MiniMax-M3')).toBe('minimax')
  })

  it('handles the Groq two-slash wire id', () => {
    expect(resolveProviderHueClass('pi', 'groq/openai/gpt-oss-120b')).toBe('groq')
  })

  it('reuses the existing qwen hue for qwen-token-plan', () => {
    expect(resolveProviderHueClass('pi', 'qwen-token-plan/qwen3.7-max')).toBe('qwen')
    // Same class the Ollama lane resolves Qwen to — one brand, one colour.
    expect(resolveProviderHueClass('ollama', 'qwen3.5:9b')).toBe('alibaba')
  })

  it('falls back to the pi seat colour for unknown or malformed ids', () => {
    expect(resolveProviderHueClass('pi', 'anthropic/claude-opus')).toBe('pi')
    expect(resolveProviderHueClass('pi', 'noslash')).toBe('pi')
    expect(resolveProviderHueClass('pi')).toBe('pi')
  })

  it('does not apply Pi splitting to other providers', () => {
    expect(resolveProviderHueClass('claude', 'deepseek/deepseek-v4-flash')).toBe('claude')
  })
})

describe('resolveProviderBrandLabel', () => {
  it('returns the spoofed upstream brand label for Ollama brands', () => {
    expect(resolveProviderBrandLabel('ollama', 'qwen3.5:9b')).toBe('Alibaba')
    expect(resolveProviderBrandLabel('ollama', 'nemotron3:33b')).toBe('NVIDIA')
    expect(resolveProviderBrandLabel('ollama', 'nemotron-3.5-lightning:30b-mlx')).toBe('NVIDIA')
    expect(resolveProviderBrandLabel('ollama', 'laguna-xs-2.1:q8_0')).toBe('Poolside')
    expect(resolveProviderBrandLabel('ollama', 'devstral-small-2:24b')).toBe('Mistral')
    expect(resolveProviderBrandLabel('ollama', 'ministral-3:14b')).toBe('Mistral')
    expect(resolveProviderBrandLabel('ollama', 'rnj-1')).toBe('Essential AI')
    expect(resolveProviderBrandLabel('ollama', 'north-mini-code-1.0:q4_K_M')).toBe('Cohere')
  })

  it('returns the BYOK upstream brand for a Pi row', () => {
    // Without this the caller falls through to getProviderName('pi'), which
    // before this pass had no `pi` case and answered "Gemini" — the leftover
    // that put "Gemini deepseek/deepseek-v4-flash" on the composer trigger.
    expect(resolveProviderBrandLabel('pi', 'mistral/devstral-2512')).toBe('Mistral')
    expect(resolveProviderBrandLabel('pi', 'deepseek/deepseek-v4-flash')).toBe('DeepSeek')
    expect(resolveProviderBrandLabel('pi', 'groq/openai/gpt-oss-120b')).toBe('Groq')
    expect(resolveProviderBrandLabel('pi', 'qwen-token-plan/qwen3.7-max')).toBe('Qwen')
  })

  it('returns null for non-branded providers and unresolvable models', () => {
    expect(resolveProviderBrandLabel('claude', 'claude-opus-4-8')).toBeNull()
    expect(resolveProviderBrandLabel('ollama', 'mystery-model')).toBeNull()
    // An unknown Pi upstream keeps the plain "Pi" seat name.
    expect(resolveProviderBrandLabel('pi', 'anthropic/claude-opus')).toBeNull()
  })
})
