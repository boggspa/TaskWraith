import { describe, expect, it } from 'vitest'
import { matchOllamaBrand, resolveHealthEntryPresentation } from './ollamaBrandTable'

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

  it('uses generic Ollama presentation when the model is unbranded', () => {
    expect(resolveHealthEntryPresentation('ollama', 'llama3.2', 'Ollama')).toEqual({
      displayProviderLabel: 'Ollama',
      displayHueClass: 'ollama'
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
})
