import { describe, expect, it } from 'vitest'
import { matchOllamaBrand, resolveHealthEntryPresentation } from './ollamaBrandTable'
import { PI_MODEL_LABELS, PI_UPSTREAM_BRANDS } from './piBrandTable'

describe('resolveHealthEntryPresentation', () => {
  it('freezes Ollama brand label + hue class from the stamped model', () => {
    expect(resolveHealthEntryPresentation('ollama', 'qwen3.5:9b', 'Ollama')).toEqual({
      displayProviderLabel: 'Alibaba',
      displayHueClass: 'alibaba'
    })
  })

  it('falls back to the runtime provider for non-Ollama participants', () => {
    expect(resolveHealthEntryPresentation('codex', undefined, 'Codex')).toEqual({
      displayProviderLabel: 'Codex',
      displayHueClass: 'codex'
    })
  })

  it('freezes Meta presentation for Llama models', () => {
    expect(resolveHealthEntryPresentation('ollama', 'llama3.2', 'Ollama')).toEqual({
      displayProviderLabel: 'Meta',
      displayHueClass: 'meta'
    })
  })

  it('freezes every Pi upstream brand label and hue from its wire model', () => {
    for (const [upstream, brand] of Object.entries(PI_UPSTREAM_BRANDS)) {
      const modelId = Object.keys(PI_MODEL_LABELS).find((id) => id.startsWith(`${upstream}/`))
      expect(modelId, `missing representative Pi model for ${upstream}`).toBeTruthy()
      expect(resolveHealthEntryPresentation('pi', modelId, 'Pi')).toEqual({
        displayProviderLabel: brand.label,
        displayHueClass: brand.hueClass
      })
    }
  })

  it('uses generic Pi presentation when the upstream is unknown', () => {
    expect(resolveHealthEntryPresentation('pi', 'unknown/model', 'Pi')).toEqual({
      displayProviderLabel: 'Pi',
      displayHueClass: 'pi'
    })
  })
})

describe('matchOllamaBrand', () => {
  it('matches OpenBMB models', () => {
    expect(matchOllamaBrand('minicpm-v4.5:8b')?.providerLabel).toBe('OpenBMB')
  })

  it('matches Poolside Laguna models', () => {
    expect(matchOllamaBrand('laguna-xs-2.1:q8_0')).toMatchObject({
      providerLabel: 'Poolside',
      providerClass: 'poolside'
    })
  })

  it('matches both local Mistral tags onto the existing Mistral hue', () => {
    // 'mistral' is NOT a substring of 'ministral', so Ministral carries its own
    // needle — without it the tag would fall through to the generic Ollama look.
    expect(matchOllamaBrand('devstral-small-2:24b')).toMatchObject({
      providerLabel: 'Mistral',
      providerClass: 'mistral'
    })
    expect(matchOllamaBrand('ministral-3:14b')).toMatchObject({
      providerLabel: 'Mistral',
      providerClass: 'mistral'
    })
  })

  it('freezes the Mistral spoof on an Ollama health chip', () => {
    expect(resolveHealthEntryPresentation('ollama', 'devstral-small-2:24b', 'Ollama')).toEqual({
      displayProviderLabel: 'Mistral',
      displayHueClass: 'mistral'
    })
  })

  it('matches the six new tags to their five upstream brands', () => {
    expect(matchOllamaBrand('llama3.1:8b')).toMatchObject({
      providerLabel: 'Meta',
      providerClass: 'meta'
    })
    expect(matchOllamaBrand('llama3.2:3b')?.providerClass).toBe('meta')
    expect(matchOllamaBrand('deepseek-r1:8b')?.providerClass).toBe('deepseek')
    expect(matchOllamaBrand('rnj-1')?.providerLabel).toBe('Essential AI')
    expect(matchOllamaBrand('glm-4.7-flash:q4_K_M')?.providerClass).toBe('zai')
    expect(matchOllamaBrand('north-mini-code-1.0:q4_K_M')?.providerClass).toBe('cohere')
  })
})
