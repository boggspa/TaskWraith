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
    expect(isOllamaModelInstalled('lfm2.5', ['lfm2.5:8b'])).toBe(true)
    expect(isOllamaModelInstalled('lfm2.5:latest', ['lfm2.5:8b'])).toBe(true)
  })

  it('builds install-only pull commands for safe model ids', () => {
    expect(buildOllamaPullCommand('qwen3:4b-instruct')).toBe('ollama pull qwen3:4b-instruct')
    expect(buildOllamaPullCommand('openai/gpt-oss-20b')).toBe(
      'ollama pull openai/gpt-oss-20b'
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
