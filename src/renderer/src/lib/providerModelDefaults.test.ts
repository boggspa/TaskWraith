import { describe, expect, it } from 'vitest'
import {
  CODEX_DEFAULT_MODELS,
  CODEX_DEFAULT_MODEL,
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

  it('exposes GPT-5.6 rows with official GA metadata (tiers, names, defaults)', () => {
    // Official (2026-07-09): hyphenated names; Sol defaults LOW; max on all
    // three; ultra('ultracode') on Sol + Terra only.
    const byId = new Map(CODEX_DEFAULT_MODELS.map((model) => [model.id, model]))
    expect(byId.get('gpt-5.6-sol')).toMatchObject({
      label: 'GPT-5.6-Sol',
      defaultReasoningEffort: 'low'
    })
    expect(
      byId.get('gpt-5.6-sol')?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(byId.get('gpt-5.6-terra')).toMatchObject({
      label: 'GPT-5.6-Terra',
      defaultReasoningEffort: 'medium'
    })
    expect(
      byId.get('gpt-5.6-terra')?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(byId.get('gpt-5.6-luna')).toMatchObject({
      label: 'GPT-5.6-Luna',
      defaultReasoningEffort: 'medium'
    })
    expect(
      byId.get('gpt-5.6-luna')?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('leads the picker with the GPT-5.6 trio (above 5.5) but keeps 5.5 the default', () => {
    const ids = CODEX_DEFAULT_MODELS.map((model) => model.id)
    // Trio sits at the very top, in Sol → Terra → Luna order, above 5.5.
    expect(ids.slice(0, 3)).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    expect(ids.indexOf('gpt-5.6-sol')).toBeLessThan(ids.indexOf('gpt-5.5'))
    // The default must NOT follow the reorder to position 0 — it stays 5.5.
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.5')
  })
})

describe('Claude provider model defaults', () => {
  it('exposes Sonnet 5 and Fable 5 as real rows while keeping Mythos out of the picker', () => {
    const ids = CLAUDE_DEFAULT_MODELS.map((model) => model.id)
    expect(ids).not.toContain('default')
    expect(ids).toContain('claude-fable-5')
    expect(ids).not.toContain('claude-mythos-5')
    expect(ids).not.toContain('claude-fable-5-1m')
    expect(ids).toContain('claude-sonnet-5')
    expect(ids).toContain('claude-sonnet-4-6')
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
    expect(ids).not.toContain('claude-mythos-5')
  })

  it('offers Fast mode on supported Opus rows but not Fable 5', () => {
    const byId = new Map(CLAUDE_DEFAULT_MODELS.map((model) => [model.id, model]))
    expect(byId.get('claude-opus-4-8-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-opus-4-7-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-fable-5')?.additionalSpeedTiers ?? []).not.toContain('fast')
  })

  it('resolves family-specific Claude reasoning defaults', () => {
    const byId = new Map(CLAUDE_DEFAULT_MODELS.map((model) => [model.id, model]))
    const sonnet5Reasoning = resolveClaudeReasoningEfforts(byId.get('claude-sonnet-5'))
    const legacySonnetReasoning = resolveClaudeReasoningEfforts(byId.get('claude-sonnet-4-6'))
    const opusReasoning = resolveClaudeReasoningEfforts(byId.get('claude-opus-4-8-1m'))
    const fableReasoning = resolveClaudeReasoningEfforts(byId.get('claude-fable-5'))
    const haikuReasoning = resolveClaudeReasoningEfforts(byId.get('claude-haiku-4-5'))
    // Sonnet 5 shares the full Opus ladder with every effort enabled; legacy
    // Sonnet 4.6 still caps xhigh/ultracode.
    expect(sonnet5Reasoning.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(sonnet5Reasoning.filter((option) => option.disabled)).toEqual([])
    expect(
      legacySonnetReasoning
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
    expect(fableReasoning.every((option) => !option.disabled)).toBe(true)
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
      'laguna-xs-2.1:q8_0',
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
  it('uses Grok 4.5 as the concrete Grok default while keeping Composer reasoning-free', () => {
    expect(GROK_DEFAULT_MODELS[0]).toMatchObject({
      id: 'grok-4.5',
      label: 'Grok 4.5 Fast',
      isDefault: true
    })
    expect(
      GROK_DEFAULT_MODELS[0].supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high'])
    expect(GROK_DEFAULT_MODELS.map((model) => model.id)).toEqual([
      'grok-4.5',
      'grok-composer-2.5-fast'
    ])
    expect(GROK_DEFAULT_MODELS[1].supportedReasoningEfforts).toBeUndefined()
  })
})

describe('provider model picker sentinels', () => {
  it('keeps K2.7 Coding as the Fast-capable default row with K3 selectable after it', () => {
    expect(KIMI_DEFAULT_MODELS.map((model) => model.id)).toEqual(['kimi-k2.7-code', 'kimi-k3'])
    expect(KIMI_DEFAULT_MODELS[0]).toMatchObject({
      id: 'kimi-k2.7-code',
      label: 'K2.7 Coding',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'on' }],
      defaultReasoningEffort: 'on',
      additionalSpeedTiers: ['fast']
    })
    // K3 is NOT the default and has no Highspeed tier — Fast stays exclusive
    // to K2.7 Coding; K3 exposes its always-on effort choices.
    const k3 = KIMI_DEFAULT_MODELS.find((model) => model.id === 'kimi-k3')
    expect(k3?.label).toBe('K3')
    expect(k3?.defaultReasoningEffort).toBe('max')
    expect(k3?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'high',
      'max'
    ])
    expect(k3?.isDefault).toBeUndefined()
    expect(k3?.additionalSpeedTiers).toBeUndefined()
  })

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
