import { describe, expect, it } from 'vitest'
import {
  buildOllamaPullCommand,
  isOllamaCloudModelId,
  isOllamaModelInstalled,
  ollamaCloudBaseModelId,
  ollamaCloudModelId,
  ollamaCloudModelDisplayName,
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

  it('classifies current and legacy Ollama Cloud source suffixes', () => {
    expect(isOllamaCloudModelId('kimi-k2.5:cloud')).toBe(true)
    expect(isOllamaCloudModelId('gpt-oss:120b-cloud')).toBe(true)
    expect(isOllamaCloudModelId('kimi-k2.5:latest-cloud')).toBe(true)
    expect(isOllamaCloudModelId('qwen3.5:9b')).toBe(false)
    expect(ollamaCloudBaseModelId('kimi-k2.5:cloud')).toBe('kimi-k2.5')
    expect(ollamaCloudBaseModelId('gpt-oss:120b-cloud')).toBe('gpt-oss:120b')
    expect(ollamaCloudBaseModelId('kimi-k2.5:latest-cloud')).toBe('kimi-k2.5:latest')
    expect(ollamaCloudModelId('kimi-k2.7-code')).toBe('kimi-k2.7-code:cloud')
    expect(ollamaCloudModelId('gpt-oss:120b')).toBe('gpt-oss:120b:cloud')
    expect(ollamaCloudModelId('glm-5.2:cloud')).toBe('glm-5.2:cloud')
  })

  it('resolves curated Cloud ids to display names without altering unknown ids', () => {
    expect(ollamaCloudModelDisplayName('glm-5.2:cloud')).toBe('GLM 5.2')
    expect(ollamaCloudModelDisplayName('minimax-m3:cloud')).toBe('MiniMax M3')
    expect(ollamaCloudModelDisplayName('GLM-5.2')).toBe('GLM 5.2')
    expect(ollamaCloudModelDisplayName('future-model:cloud')).toBeUndefined()
  })

  it('never offers a local pull command for a cloud source model', () => {
    expect(buildOllamaPullCommand('kimi-k2.5:cloud')).toBeNull()
    expect(buildOllamaPullCommand('gpt-oss:120b-cloud')).toBeNull()
  })

  it('refuses shell-unsafe model ids', () => {
    expect(buildOllamaPullCommand('custom')).toBeNull()
    expect(buildOllamaPullCommand('-bad')).toBeNull()
    expect(buildOllamaPullCommand('qwen3:4b; rm -rf /')).toBeNull()
    expect(buildOllamaPullCommand('qwen3:4b\nwhoami')).toBeNull()
    expect(buildOllamaPullCommand('$(whoami)')).toBeNull()
  })
})
