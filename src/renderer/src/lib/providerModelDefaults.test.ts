import { describe, expect, it } from 'vitest'
import { resolveOllamaReasoningSupport } from '../../../shared/ollamaReasoning'
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
  MISTRAL_DEFAULT_MODELS,
  MUSE_DEFAULT_MODELS,
  isClaudeModelId
} from './providerModelDefaults'

describe('UltraTask fallback capability metadata', () => {
  it('marks every curated concrete row explicitly and leaves custom ids unknown', () => {
    const catalogs = [
      CODEX_DEFAULT_MODELS,
      CLAUDE_DEFAULT_MODELS,
      GEMINI_DEFAULT_MODELS,
      GROK_DEFAULT_MODELS,
      KIMI_DEFAULT_MODELS,
      CURSOR_DEFAULT_MODELS,
      MISTRAL_DEFAULT_MODELS,
      MUSE_DEFAULT_MODELS,
      OLLAMA_DEFAULT_MODELS
    ]
    for (const model of catalogs.flat()) {
      if (model.id === 'custom') {
        expect(model.ultraTaskSupported).toBeUndefined()
      } else if (model.id === 'claude-haiku-4-5') {
        expect(model.ultraTaskSupported).toBe(false)
      } else {
        expect(model.ultraTaskSupported, model.id).toBe(true)
      }
    }
  })
})

describe('Codex provider model defaults', () => {
  it('offers Light/low reasoning on every fallback Codex model row', () => {
    for (const model of CODEX_DEFAULT_MODELS) {
      expect(model.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toContain(
        'low'
      )
    }
  })

  it('offers the full Spark ladder in the provider/model/reasoning popover fallback', () => {
    const spark = CODEX_DEFAULT_MODELS.find((model) => model.id === 'gpt-5.3-codex-spark')
    expect(spark?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
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

  it('keeps active GPT-5.4 fallbacks without a retirement warning', () => {
    const byId = new Map(CODEX_DEFAULT_MODELS.map((model) => [model.id, model]))
    expect(byId.get('gpt-5.4')?.retiresAt).toBeUndefined()
    expect(byId.get('gpt-5.4-mini')?.retiresAt).toBeUndefined()
  })
})

describe('Cursor provider model defaults', () => {
  it('prefixes resold Grok rows so they cannot be confused with Grok-provider rows', () => {
    // Resold Cursor rows carry the host prefix in a flat picker scan. Chips
    // remain short because the composer formatter resolves them by model id.
    expect(CURSOR_DEFAULT_MODELS.find((model) => model.id === 'grok-4.6')).toMatchObject({
      label: 'Cursor Grok 4.6',
      description: 'First-party Cursor model pool - 256K context',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' }
      ],
      defaultReasoningEffort: 'high',
      additionalSpeedTiers: ['fast']
    })
    expect(CURSOR_DEFAULT_MODELS.find((model) => model.id === 'grok-4.5')).toMatchObject({
      label: 'Cursor Grok 4.5'
    })
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
    expect(
      CLAUDE_DEFAULT_MODELS.find((model) => model.id === 'claude-haiku-4-5')?.ultraTaskSupported
    ).toBe(false)
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
    expect(isClaudeModelId('claude-opus-5')).toBe(true)
  })

  it('exposes only 1M Opus defaults while keeping Sonnet as the default model', () => {
    const ids = CLAUDE_DEFAULT_MODELS.map((model) => model.id)
    // Opus 5 is 1M by default, so its base id IS the 1M row (no -1m variant).
    expect(ids).toContain('claude-opus-5')
    expect(ids).not.toContain('claude-opus-5-1m')
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
    expect(byId.get('claude-opus-5')?.additionalSpeedTiers).toContain('fast')
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
      'qwen3.5:2b',
      'qwen3.5:4b',
      'qwen3.5:9b',
      'qwen3.6:35b',
      'qwen3.8:27b-mlx',
      'gemma3:4b',
      'gemma4:12b',
      'gemma4:31b-mlx',
      'ornith:9b',
      'ornith:35b',
      'ornith-1.5:9b',
      'ornith-1.5:35b',
      'laguna-xs-2.1:q8_0',
      'gpt-oss:20b',
      'lfm2.5-thinking:1.2b',
      'lfm2.5:8b',
      'minicpm-v4.5:8b',
      'granite4:3b',
      'granite4.1:3b',
      'granite4.1:30b',
      'nemotron-3-nano:4b',
      'nemotron3:33b',
      'nemotron-3.5-lightning:30b-mlx',
      'devstral-small-2:24b',
      'ministral-3:3b',
      'ministral-3:14b',
      'muse-glimmer:30b-mlx',
      'llama3.1:8b',
      'deepseek-r1:1.5b',
      'deepseek-r1:8b',
      'rnj-1',
      'glm-4.7-flash:q4_K_M',
      'north-mini-code-1.0:q4_K_M',
      'llama3.2:3b',
      'custom'
    ])
  })

  it('classifies every curated Ollama row without an unknown reasoning state', () => {
    const classifications = OLLAMA_DEFAULT_MODELS.filter((model) => model.id !== 'custom').map(
      (model) => [model.id, resolveOllamaReasoningSupport({ modelId: model.id }).kind] as const
    )
    expect(classifications.filter(([, kind]) => kind === 'toggle')).toHaveLength(24)
    expect(classifications.filter(([, kind]) => kind === 'levels')).toEqual([
      ['gpt-oss:20b', 'levels']
    ])
    expect(classifications.filter(([, kind]) => kind === 'unsupported')).toHaveLength(10)
    expect(classifications.filter(([, kind]) => kind === 'unknown')).toEqual([])
  })
})

describe('Grok provider model defaults', () => {
  it('uses Grok 4.6 as the default while retaining Grok 4.5 and Composer', () => {
    expect(GROK_DEFAULT_MODELS[0]).toMatchObject({
      id: 'grok-4.6',
      label: 'Grok 4.6 Fast',
      description: '500K context - low/medium/high/extra-high reasoning',
      isDefault: true
    })
    expect(
      GROK_DEFAULT_MODELS[0].supportedReasoningEfforts?.map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(GROK_DEFAULT_MODELS.map((model) => model.id)).toEqual([
      'grok-4.6',
      'grok-4.5',
      'grok-composer-2.5-fast'
    ])
    expect(GROK_DEFAULT_MODELS[1]).toMatchObject({
      id: 'grok-4.5',
      label: 'Grok 4.5 Fast'
    })
    expect(GROK_DEFAULT_MODELS[2].supportedReasoningEfforts).toBeUndefined()
  })
})

describe('provider model picker sentinels', () => {
  it('keeps K2.7 Coding as the Fast-capable default row with both K3 routes after it', () => {
    expect(KIMI_DEFAULT_MODELS.map((model) => model.id)).toEqual([
      'kimi-k2.7-code',
      'kimi-k3',
      'kimi-k3-256k'
    ])
    expect(KIMI_DEFAULT_MODELS[0]).toMatchObject({
      id: 'kimi-k2.7-code',
      label: 'K2.7 Coding',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'on' }],
      defaultReasoningEffort: 'on',
      additionalSpeedTiers: ['fast']
    })
    // Neither K3 route is the default or Highspeed-capable; both expose the
    // same always-on effort choices.
    for (const modelId of ['kimi-k3', 'kimi-k3-256k']) {
      const k3 = KIMI_DEFAULT_MODELS.find((model) => model.id === modelId)
      expect(k3?.defaultReasoningEffort).toBe('max')
      expect(k3?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
        'low',
        'high',
        'max'
      ])
      expect(k3?.isDefault).toBeUndefined()
      expect(k3?.additionalSpeedTiers).toBeUndefined()
    }
    expect(KIMI_DEFAULT_MODELS.find((model) => model.id === 'kimi-k3')?.label).toBe('K3 (up to 1M)')
    expect(KIMI_DEFAULT_MODELS.find((model) => model.id === 'kimi-k3-256k')?.label).toBe('K3 256K')
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
