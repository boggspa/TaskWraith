import { describe, expect, it } from 'vitest'
import {
  CODEX_DEFAULT_MODELS,
  CLAUDE_DEFAULT_MODELS,
  resolveClaudeDefaultReasoningEffort,
  resolveClaudeReasoningEfforts,
  GEMINI_DEFAULT_MODELS,
  GROK_DEFAULT_MODELS,
  KIMI_DEFAULT_MODELS,
  CURSOR_DEFAULT_MODELS,
  OLLAMA_DEFAULT_MODELS,
  isClaudeModelId
} from './providerModelDefaults'

describe('Codex provider model defaults', () => {
  it('offers Light/low reasoning on every fallback Codex model row', () => {
    for (const model of CODEX_DEFAULT_MODELS) {
      expect(model.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toContain(
        'low'
      )
    }
  })

  it('exposes disabled GPT-5.6 preview rows with Max reasoning only on Sol', () => {
    const byId = new Map(CODEX_DEFAULT_MODELS.map((model) => [model.id, model]))
    expect(byId.get('preview:openai:gpt-5.6:sol')).toMatchObject({
      label: 'GPT-5.6 Sol Preview',
      disabled: true,
      disabledReason: 'Requires OpenAI preview access',
      defaultReasoningEffort: 'medium'
    })
    expect(
      byId
        .get('preview:openai:gpt-5.6:sol')
        ?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(
      byId
        .get('preview:openai:gpt-5.6:terra')
        ?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})

describe('Claude provider model defaults', () => {
  it('keeps unavailable concrete Fable rows out while exposing disabled preview rows', () => {
    const ids = CLAUDE_DEFAULT_MODELS.map((model) => model.id)
    expect(ids).not.toContain('default')
    expect(ids).not.toContain('claude-fable-5')
    expect(ids).not.toContain('claude-fable-5-1m')
    expect(ids).toContain('preview:anthropic:claude-sonnet-5')
    expect(ids).toContain('preview:anthropic:claude-fable-5')
    expect(ids).toContain('preview:anthropic:claude-mythos-5')
  })

  it('uses Sonnet 4.6 as the concrete Claude fallback model', () => {
    expect(CLAUDE_DEFAULT_MODELS.find((model) => model.isDefault)?.id).toBe('claude-sonnet-4-6')
  })

  it('treats stale Fable and generic default selections as invalid so the composer falls back', () => {
    expect(isClaudeModelId('default')).toBe(false)
    expect(isClaudeModelId('cli-default')).toBe(false)
    expect(isClaudeModelId('fable')).toBe(false)
    expect(isClaudeModelId('claude-sonnet-5')).toBe(false)
    expect(isClaudeModelId('claude-fable-5')).toBe(false)
    expect(isClaudeModelId('claude-fable-5-1m')).toBe(false)
    expect(isClaudeModelId('preview:anthropic:claude-sonnet-5')).toBe(false)
    expect(isClaudeModelId('claude-opus-4-8')).toBe(true)
  })

  it('exposes only 1M Opus defaults while keeping Sonnet as the default model', () => {
    const ids = CLAUDE_DEFAULT_MODELS.map((model) => model.id)
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).not.toContain('claude-opus-4-7')
    expect(ids).not.toContain('claude-opus-4-6')
    expect(ids).toContain('claude-opus-4-8-1m')
    expect(ids).toContain('claude-opus-4-7-1m')
  })

  it('resolves family-specific Claude reasoning defaults', () => {
    const byId = new Map(CLAUDE_DEFAULT_MODELS.map((model) => [model.id, model]))
    const sonnetReasoning = resolveClaudeReasoningEfforts(byId.get('claude-sonnet-4-6'))
    const sonnet5Reasoning = resolveClaudeReasoningEfforts(
      byId.get('preview:anthropic:claude-sonnet-5')
    )
    const opusReasoning = resolveClaudeReasoningEfforts(byId.get('claude-opus-4-8-1m'))
    const haikuReasoning = resolveClaudeReasoningEfforts(byId.get('claude-haiku-4-5'))
    expect(
      sonnetReasoning.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      sonnetReasoning
        .filter((option) => option.disabled)
        .map((option) => option.reasoningEffort)
    ).toEqual(['xhigh', 'ultracode'])
    expect(sonnet5Reasoning.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(
      sonnet5Reasoning
        .filter((option) => option.disabled)
        .map((option) => option.reasoningEffort)
    ).toEqual(['xhigh', 'ultracode'])
    expect(opusReasoning.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(opusReasoning.every((option) => !option.disabled)).toBe(true)
    expect(haikuReasoning.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(haikuReasoning.every((option) => option.disabled)).toBe(true)
    expect(resolveClaudeDefaultReasoningEffort(byId.get('claude-haiku-4-5'))).toBe('')
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
      'ornith:9b',
      'ornith:35b',
      'gpt-oss:20b',
      'lfm2.5:8b',
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
