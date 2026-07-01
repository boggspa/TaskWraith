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
      label: 'GPT-5.6 Sol',
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
  it('exposes Sonnet 5, Fable 5, and Mythos 5 as real rows', () => {
    const ids = CLAUDE_DEFAULT_MODELS.map((model) => model.id)
    expect(ids).not.toContain('default')
    expect(ids).toContain('claude-fable-5')
    expect(ids).toContain('claude-mythos-5')
    expect(ids).not.toContain('claude-fable-5-1m')
    expect(ids).toContain('claude-sonnet-5')
    expect(ids).not.toContain('preview:anthropic:claude-sonnet-5')
    expect(ids).not.toContain('preview:anthropic:claude-fable-5')
    expect(ids).not.toContain('preview:anthropic:claude-mythos-5')
  })

  it('uses Sonnet 5 as the concrete Claude fallback model', () => {
    expect(CLAUDE_DEFAULT_MODELS.find((model) => model.isDefault)?.id).toBe('claude-sonnet-5')
  })

  it('accepts returned Fable / Mythos selections while rejecting preview placeholders', () => {
    expect(isClaudeModelId('default')).toBe(false)
    expect(isClaudeModelId('cli-default')).toBe(false)
    expect(isClaudeModelId('fable')).toBe(true)
    expect(isClaudeModelId('mythos')).toBe(true)
    expect(isClaudeModelId('claude-sonnet-5')).toBe(true)
    expect(isClaudeModelId('claude-fable-5')).toBe(true)
    expect(isClaudeModelId('claude-fable-5-1m')).toBe(true)
    expect(isClaudeModelId('claude-mythos-5')).toBe(true)
    expect(isClaudeModelId('preview:anthropic:claude-sonnet-5')).toBe(false)
    expect(isClaudeModelId('preview:anthropic:claude-fable-5')).toBe(false)
    expect(isClaudeModelId('preview:anthropic:claude-mythos-5')).toBe(false)
    expect(isClaudeModelId('claude-opus-4-8')).toBe(true)
  })

  it('exposes only 1M Opus defaults while keeping Sonnet as the default model', () => {
    const ids = CLAUDE_DEFAULT_MODELS.map((model) => model.id)
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).not.toContain('claude-opus-4-7')
    expect(ids).not.toContain('claude-opus-4-6')
    expect(ids).toContain('claude-opus-4-8-1m')
    expect(ids).toContain('claude-opus-4-7-1m')
    expect(ids).toContain('claude-fable-5')
    expect(ids).toContain('claude-mythos-5')
  })

  it('resolves family-specific Claude reasoning defaults', () => {
    const byId = new Map(CLAUDE_DEFAULT_MODELS.map((model) => [model.id, model]))
    const sonnet5Reasoning = resolveClaudeReasoningEfforts(byId.get('claude-sonnet-5'))
    const opusReasoning = resolveClaudeReasoningEfforts(byId.get('claude-opus-4-8-1m'))
    const fableReasoning = resolveClaudeReasoningEfforts(byId.get('claude-fable-5'))
    const mythosReasoning = resolveClaudeReasoningEfforts(byId.get('claude-mythos-5'))
    const haikuReasoning = resolveClaudeReasoningEfforts(byId.get('claude-haiku-4-5'))
    // Sonnet 5 shares the full Opus ladder with every effort enabled (unlike the
    // retired Sonnet 4.6, which capped xhigh/ultracode).
    expect(sonnet5Reasoning.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(sonnet5Reasoning.filter((option) => option.disabled)).toEqual([])
    expect(opusReasoning.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(opusReasoning.every((option) => !option.disabled)).toBe(true)
    expect(fableReasoning.every((option) => !option.disabled)).toBe(true)
    expect(mythosReasoning.every((option) => !option.disabled)).toBe(true)
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
