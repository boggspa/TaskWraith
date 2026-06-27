import { describe, it, expect } from 'vitest'
import {
  codexModelContextConfig,
  getStaticProviderModels,
  normalizeCliProviderModel
} from './StaticProviderModels'

describe('codexModelContextConfig', () => {
  const longContextConfig = {
    model_context_window: 1_050_000,
    model_auto_compact_token_limit: 850_000
  }

  it('returns the explicit 1M config for long-context Codex models', () => {
    expect(codexModelContextConfig('gpt-5.5')).toEqual(longContextConfig)
    expect(codexModelContextConfig('gpt-5.4')).toEqual(longContextConfig)
  })

  it('maps TaskWraith default aliases to GPT-5.5 context config', () => {
    expect(codexModelContextConfig(undefined)).toEqual(longContextConfig)
    expect(codexModelContextConfig('cli-default')).toEqual(longContextConfig)
    expect(codexModelContextConfig('auto')).toEqual(longContextConfig)
  })

  it('does not override short-context Codex models', () => {
    expect(codexModelContextConfig('gpt-5.4-mini')).toBeNull()
    expect(codexModelContextConfig('gpt-5.3-codex-spark')).toBeNull()
  })
})

describe('normalizeCliProviderModel (claude)', () => {
  it('strips the TaskWraith-internal -1m marker so the CLI gets the base model id', () => {
    // The 1M window is entitlement-based on the base id.
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8-1m')).toBe('claude-opus-4-8')
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-7-1m')).toBe('claude-opus-4-7')
  })

  it('passes through base claude ids and bare family aliases unchanged', () => {
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8')
    for (const alias of ['sonnet', 'opus', 'haiku']) {
      expect(normalizeCliProviderModel('claude', alias)).toBe(alias)
    }
  })

  it('maps temporarily unavailable Fable ids back to the concrete Claude default', () => {
    expect(normalizeCliProviderModel('claude', 'fable')).toBe('claude-sonnet-4-6')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5')).toBe('claude-sonnet-4-6')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5-1m')).toBe('claude-sonnet-4-6')
  })

  it('maps empty / sentinel ids to Sonnet 4.6', () => {
    expect(normalizeCliProviderModel('claude', '')).toBe('claude-sonnet-4-6')
    expect(normalizeCliProviderModel('claude', 'default')).toBe('claude-sonnet-4-6')
    expect(normalizeCliProviderModel('claude', 'cli-default')).toBe('claude-sonnet-4-6')
    expect(normalizeCliProviderModel('claude', 'custom')).toBe('claude-sonnet-4-6')
  })
})

interface StaticModelShape {
  id: string
  disabled?: boolean
  disabledReason?: string
  additionalSpeedTiers?: string[]
  supportedReasoningEfforts?: Array<{
    reasoningEffort: string
    disabled?: boolean
    disabledReason?: string
  }>
}

describe('getStaticProviderModels (provider-specific catalogs)', () => {
  it('does not expose generic Default or CLI Default model rows', () => {
    for (const provider of [
      'codex',
      'claude',
      'gemini',
      'kimi',
      'grok',
      'cursor',
      'ollama'
    ] as const) {
      const models = getStaticProviderModels(provider)
      expect(models.map((model) => model.id)).not.toEqual(
        expect.arrayContaining(['default', 'cli-default'])
      )
      expect(models.map((model) => model.label)).not.toEqual(
        expect.arrayContaining(['Default', 'CLI Default'])
      )
    }
  })

  it('returns distinct model lists for gemini, grok, and cursor', () => {
    const gemini = getStaticProviderModels('gemini').map((m) => m.id)
    const grok = getStaticProviderModels('grok').map((m) => m.id)
    const cursor = getStaticProviderModels('cursor').map((m) => m.id)
    expect(gemini).toContain('flash')
    expect(grok).toEqual(['grok-build', 'grok-composer-2.5-fast'])
    expect(cursor).toEqual(['composer-2.5-fast', 'composer-2.5'])
  })

  it('normalizes invalid cross-provider model ids back to provider defaults', () => {
    expect(normalizeCliProviderModel('grok', 'flash')).toBe('grok-build')
    expect(normalizeCliProviderModel('cursor', 'pro')).toBe('composer-2.5-fast')
    expect(normalizeCliProviderModel('gemini', 'flash')).toBe('flash')
    expect(normalizeCliProviderModel('gemini', 'cli-default')).toBe('flash-lite')
  })

  it('uses Grok Build as the default while keeping Grok Composer selectable', () => {
    expect(normalizeCliProviderModel('grok', undefined)).toBe('grok-build')
    expect(normalizeCliProviderModel('grok', 'cli-default')).toBe('grok-build')
    expect(normalizeCliProviderModel('grok', 'grok-composer-2.5-fast')).toBe(
      'grok-composer-2.5-fast'
    )
    expect(normalizeCliProviderModel('grok', 'composer-2.5-fast')).toBe('grok-build')
  })

  it('exposes the curated optional Ollama model tags', () => {
    const ollama = getStaticProviderModels('ollama').map((m) => m.id)
    expect(ollama).toEqual([
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

describe('normalizeCliProviderModel (kimi)', () => {
  it('uses Kimi K2.7 Code as the CLI default and maps legacy aliases to it', () => {
    expect(normalizeCliProviderModel('kimi', '')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'cli-default')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2.6')).toBe('kimi-k2.7-code')
    expect(normalizeCliProviderModel('kimi', 'kimi-k2-thinking')).toBe('kimi-k2.7-code')
  })
})

describe('getStaticProviderModels (claude)', () => {
  const models = getStaticProviderModels('claude') as StaticModelShape[]
  const byId = new Map(models.map((m) => [m.id, m]))

  it('marks temporarily unavailable Fable 1M disabled in the picker catalog', () => {
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('default')
    expect(ids).not.toContain('claude-fable-5')
    expect(ids).toContain('claude-fable-5-1m')
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).toContain('claude-opus-4-8-1m')
    expect(byId.get('claude-fable-5-1m')).toMatchObject({
      disabled: true,
      disabledReason: 'Temporarily unavailable from Anthropic'
    })
  })

  it('marks Claude Sonnet 4.6 as the concrete default', () => {
    expect(byId.get('claude-sonnet-4-6')).toMatchObject({ isDefault: true })
  })

  it('keeps the paid Fast tier on the default 1M Opus rows', () => {
    expect(byId.get('claude-opus-4-8-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-opus-4-7-1m')?.additionalSpeedTiers).toContain('fast')
  })

  it('offers family-specific Claude reasoning efforts', () => {
    const sonnetReasoning = byId.get('claude-sonnet-4-6')?.supportedReasoningEfforts ?? []
    const opusReasoning = byId.get('claude-opus-4-8-1m')?.supportedReasoningEfforts ?? []
    const haikuReasoning = byId.get('claude-haiku-4-5')?.supportedReasoningEfforts ?? []
    expect(
      sonnetReasoning.map((e) => e.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      sonnetReasoning
        .filter((e) => e.disabled)
        .map((e) => e.reasoningEffort)
    ).toEqual(['xhigh', 'ultracode'])
    expect(opusReasoning.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(opusReasoning.every((e) => !e.disabled)).toBe(true)
    expect(haikuReasoning.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(haikuReasoning.every((e) => e.disabled)).toBe(true)
  })
})
