import { describe, expect, it } from 'vitest'
import {
  CODEX_DEFAULT_MODELS,
  CLAUDE_DEFAULT_MODELS,
  GEMINI_DEFAULT_MODELS,
  GROK_DEFAULT_MODELS,
  KIMI_DEFAULT_MODELS,
  CURSOR_DEFAULT_MODELS,
  OLLAMA_DEFAULT_MODELS,
  isClaudeModelId
} from './providerModelDefaults'

describe('Claude provider model defaults', () => {
  it('hides temporarily unavailable Fable variants from the renderer fallback picker list', () => {
    const ids = CLAUDE_DEFAULT_MODELS.map((model) => model.id)
    expect(ids).not.toContain('default')
    expect(ids).not.toContain('claude-fable-5')
    expect(ids).not.toContain('claude-fable-5-1m')
  })

  it('uses Sonnet 4.6 as the concrete Claude fallback model', () => {
    expect(CLAUDE_DEFAULT_MODELS.find((model) => model.isDefault)?.id).toBe('claude-sonnet-4-6')
  })

  it('treats stale Fable and generic default selections as invalid so the composer falls back', () => {
    expect(isClaudeModelId('default')).toBe(false)
    expect(isClaudeModelId('cli-default')).toBe(false)
    expect(isClaudeModelId('fable')).toBe(false)
    expect(isClaudeModelId('claude-fable-5')).toBe(false)
    expect(isClaudeModelId('claude-fable-5-1m')).toBe(false)
    expect(isClaudeModelId('claude-opus-4-8')).toBe(true)
  })
})

describe('Ollama provider model defaults', () => {
  it('includes the optional curated local model tags without changing the default', () => {
    expect(OLLAMA_DEFAULT_MODELS[0].id).toBe('qwen3:4b-instruct')
    expect(OLLAMA_DEFAULT_MODELS.map((model) => model.id)).toEqual([
      'qwen3:4b-instruct',
      'qwen3.5:9b',
      'qwen3.6:35b',
      'gemma4:12b',
      'gpt-oss:20b',
      'minicpm-v4.5:8b',
      'granite4.1:3b',
      'granite4.1:30b',
      'nemotron3:33b',
      'custom'
    ])
  })
})

describe('Grok provider model defaults', () => {
  it('uses Grok Build as the concrete Grok default while keeping Composer selectable', () => {
    expect(GROK_DEFAULT_MODELS[0]).toMatchObject({
      id: 'grok-build',
      label: 'Grok Build 0.1',
      isDefault: true
    })
    expect(GROK_DEFAULT_MODELS.map((model) => model.id)).toEqual([
      'grok-build',
      'grok-composer-2.5-fast'
    ])
  })
})

describe('provider model picker sentinels', () => {
  it('does not expose Default or CLI Default as selectable model rows', () => {
    const catalogs = [
      CODEX_DEFAULT_MODELS,
      CLAUDE_DEFAULT_MODELS,
      GEMINI_DEFAULT_MODELS,
      KIMI_DEFAULT_MODELS,
      GROK_DEFAULT_MODELS,
      CURSOR_DEFAULT_MODELS,
      OLLAMA_DEFAULT_MODELS
    ]
    for (const models of catalogs) {
      expect(models.map((model) => model.id)).not.toEqual(
        expect.arrayContaining(['default', 'cli-default'])
      )
      expect(models.map((model) => model.label)).not.toEqual(
        expect.arrayContaining(['Default', 'CLI Default'])
      )
    }
  })
})
