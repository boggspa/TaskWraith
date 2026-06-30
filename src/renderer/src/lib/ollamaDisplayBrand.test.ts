import { describe, expect, it } from 'vitest'
import { OLLAMA_DISPLAY_BRANDS, resolveOllamaDisplayBrand } from './ollamaDisplayBrand'

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
    expect(resolveOllamaDisplayBrand('lfm2.5:8b', 'LFM 2.5 (8B-1A)')).toMatchObject({
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
      'openbmb'
    ])
  })
})
