import { describe, expect, it } from 'vitest'
import {
  OLLAMA_DISPLAY_BRANDS,
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
    expect(resolveOllamaDisplayBrand('ornith:35b', 'Ornith 1.0 (35B Param)')).toMatchObject({
      providerLabel: 'Deep Reinforce',
      providerClass: 'deep-reinforce'
    })
    expect(resolveOllamaDisplayBrand('gemma4:12b', 'Gemma 4 (12B Param)')).toMatchObject({
      providerLabel: 'Google',
      providerClass: 'google'
    })
    expect(resolveOllamaDisplayBrand('granite4.1:30b', 'Granite 4.1 (30B Param)')).toMatchObject({
      providerLabel: 'IBM',
      providerClass: 'ibm'
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
    expect(resolveOllamaDisplayBrand('gpt-oss:20b', 'GPT OSS (20B Param)')).toMatchObject({
      providerLabel: 'OpenAI',
      providerClass: 'openai'
    })
    expect(
      resolveOllamaDisplayBrand('minicpm-v4.5:8b', 'MiniCPM-V 4.5 (8B Param)')
    ).toMatchObject({
      providerLabel: 'OpenBMB',
      providerClass: 'openbmb'
    })
    expect(resolveOllamaDisplayBrand('laguna-xs-2.1:q8_0')).toMatchObject({
      providerLabel: 'Poolside',
      providerClass: 'poolside'
    })
  })

  it('keeps the provider picker order explicit', () => {
    expect(OLLAMA_DISPLAY_BRANDS.map((brand) => brand.id)).toEqual([
      'alibaba',
      'deep-reinforce',
      'google',
      'ibm',
      'liquid',
      'nvidia',
      'openai',
      'openbmb',
      'poolside'
    ])
  })
})

describe('resolveProviderHueClass', () => {
  it('returns the spoofed brand class for Ollama display brands', () => {
    expect(resolveProviderHueClass('ollama', 'qwen3.5:9b')).toBe('alibaba')
    expect(resolveProviderHueClass('ollama', 'gemma4:12b')).toBe('google')
    expect(resolveProviderHueClass('ollama', 'gpt-oss:20b')).toBe('openai')
    expect(resolveProviderHueClass('ollama', 'laguna-xs-2.1:q8_0')).toBe('poolside')
  })

  it('returns the runtime provider for non-brand models', () => {
    expect(resolveProviderHueClass('ollama', 'some-unknown-local-model')).toBe('ollama')
    expect(resolveProviderHueClass('claude', 'claude-opus-4-8')).toBe('claude')
    expect(resolveProviderHueClass('codex')).toBe('codex')
  })
})

describe('resolveProviderBrandLabel', () => {
  it('returns the spoofed upstream brand label for Ollama brands', () => {
    expect(resolveProviderBrandLabel('ollama', 'qwen3.5:9b')).toBe('Alibaba')
    expect(resolveProviderBrandLabel('ollama', 'nemotron3:33b')).toBe('NVIDIA')
    expect(resolveProviderBrandLabel('ollama', 'laguna-xs-2.1:q8_0')).toBe('Poolside')
  })

  it('returns null for non-Ollama providers and unbranded Ollama models', () => {
    expect(resolveProviderBrandLabel('claude', 'claude-opus-4-8')).toBeNull()
    expect(resolveProviderBrandLabel('ollama', 'mystery-model')).toBeNull()
  })
})
