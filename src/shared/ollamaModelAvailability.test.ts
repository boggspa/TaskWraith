import { describe, expect, it } from 'vitest'
import {
  buildOllamaPullCommand,
  isOllamaModelInstalled,
  ollamaModelIdsMatch
} from './ollamaModelAvailability'

describe('ollama model availability helpers', () => {
  it('matches exact ids and :latest aliases', () => {
    expect(ollamaModelIdsMatch('llama3', 'llama3:latest')).toBe(true)
    expect(ollamaModelIdsMatch('qwen3:4b-instruct', 'qwen3:4b-instruct')).toBe(true)
    expect(ollamaModelIdsMatch('qwen3:4b-instruct', 'qwen3.5:9b')).toBe(false)
  })

  it('matches curated Ollama aliases used by runtime preflight', () => {
    expect(isOllamaModelInstalled('gpt-oss:20b', ['gpt-oss:latest'])).toBe(true)
    expect(isOllamaModelInstalled('gpt-oss', ['openai/gpt-oss-20b'])).toBe(true)
    expect(isOllamaModelInstalled('ornith', ['ornith:9b'])).toBe(true)
    expect(isOllamaModelInstalled('ornith:35b', ['ornith:9b'])).toBe(false)
    expect(isOllamaModelInstalled('gemma3:4b', ['gemma3:latest'])).toBe(true)
    expect(isOllamaModelInstalled('gemma3', ['gemma3:4b'])).toBe(true)
    expect(
      isOllamaModelInstalled('lfm2.5-thinking:1.2b', ['lfm2.5-thinking:latest'])
    ).toBe(true)
    expect(isOllamaModelInstalled('lfm2.5-thinking', ['lfm2.5-thinking:1.2b'])).toBe(true)
    expect(isOllamaModelInstalled('lfm2.5', ['lfm2.5:8b'])).toBe(true)
    expect(isOllamaModelInstalled('lfm2.5:latest', ['lfm2.5:8b'])).toBe(true)
    expect(isOllamaModelInstalled('rnj-1', ['rnj-1:latest'])).toBe(true)
    expect(isOllamaModelInstalled('rnj-1:8b', ['rnj-1:latest'])).toBe(true)
    expect(
      isOllamaModelInstalled('glm-4.7-flash:q4_K_M', ['glm-4.7-flash:q4_K_M'])
    ).toBe(true)
    expect(
      isOllamaModelInstalled('north-mini-code-1.0:q4_K_M', [
        'north-mini-code-1.0:q4_K_M'
      ])
    ).toBe(true)
  })

  it('builds install-only pull commands for safe model ids', () => {
    expect(buildOllamaPullCommand('qwen3:4b-instruct')).toBe('ollama pull qwen3:4b-instruct')
    expect(buildOllamaPullCommand('openai/gpt-oss-20b')).toBe(
      'ollama pull openai/gpt-oss-20b'
    )
    expect(buildOllamaPullCommand('laguna-xs-2.1:q8_0')).toBe(
      'ollama pull laguna-xs-2.1:q8_0'
    )
    expect(buildOllamaPullCommand('glm-4.7-flash:q4_K_M')).toBe(
      'ollama pull glm-4.7-flash:q4_K_M'
    )
    expect(buildOllamaPullCommand('north-mini-code-1.0:q4_K_M')).toBe(
      'ollama pull north-mini-code-1.0:q4_K_M'
    )
  })

  it('refuses shell-unsafe model ids', () => {
    expect(buildOllamaPullCommand('custom')).toBeNull()
    expect(buildOllamaPullCommand('-bad')).toBeNull()
    expect(buildOllamaPullCommand('qwen3:4b; rm -rf /')).toBeNull()
    expect(buildOllamaPullCommand('qwen3:4b\nwhoami')).toBeNull()
    expect(buildOllamaPullCommand('$(whoami)')).toBeNull()
  })
})
