import { describe, it, expect } from 'vitest'
import { getStaticProviderModels, normalizeCliProviderModel } from './StaticProviderModels'

describe('normalizeCliProviderModel (claude)', () => {
  it('strips the TaskWraith-internal -1m marker so the CLI gets the base model id', () => {
    // The 1M window is entitlement-based on the base id.
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8-1m')).toBe('claude-opus-4-8')
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-7-1m')).toBe('claude-opus-4-7')
  })

  it('passes through base claude ids and bare family aliases unchanged', () => {
    expect(normalizeCliProviderModel('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8')
    for (const alias of ['default', 'sonnet', 'opus', 'haiku']) {
      expect(normalizeCliProviderModel('claude', alias)).toBe(alias)
    }
  })

  it('maps temporarily unavailable Fable ids back to the Claude default', () => {
    expect(normalizeCliProviderModel('claude', 'fable')).toBe('default')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5')).toBe('default')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5-1m')).toBe('default')
  })

  it('maps empty / sentinel ids to default', () => {
    expect(normalizeCliProviderModel('claude', '')).toBe('default')
    expect(normalizeCliProviderModel('claude', 'cli-default')).toBe('default')
    expect(normalizeCliProviderModel('claude', 'custom')).toBe('default')
  })
})

interface StaticModelShape {
  id: string
  additionalSpeedTiers?: string[]
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>
}

describe('getStaticProviderModels (provider-specific catalogs)', () => {
  it('returns distinct model lists for gemini, grok, and cursor', () => {
    const gemini = getStaticProviderModels('gemini').map((m) => m.id)
    const grok = getStaticProviderModels('grok').map((m) => m.id)
    const cursor = getStaticProviderModels('cursor').map((m) => m.id)
    expect(gemini).toContain('flash')
    expect(grok).toEqual(['grok-composer-2.5-fast', 'grok-build'])
    expect(cursor).toEqual(['composer-2.5-fast', 'composer-2.5'])
  })

  it('normalizes invalid cross-provider model ids back to provider defaults', () => {
    expect(normalizeCliProviderModel('grok', 'flash')).toBe('grok-composer-2.5-fast')
    expect(normalizeCliProviderModel('cursor', 'pro')).toBe('composer-2.5-fast')
    expect(normalizeCliProviderModel('gemini', 'flash')).toBe('flash')
  })

  it('keeps Grok Composer distinct from Cursor Composer ids', () => {
    expect(normalizeCliProviderModel('grok', undefined)).toBe('grok-composer-2.5-fast')
    expect(normalizeCliProviderModel('grok', 'cli-default')).toBe('grok-composer-2.5-fast')
    expect(normalizeCliProviderModel('grok', 'grok-composer-2.5-fast')).toBe(
      'grok-composer-2.5-fast'
    )
    expect(normalizeCliProviderModel('grok', 'composer-2.5-fast')).toBe(
      'grok-composer-2.5-fast'
    )
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

  it('hides temporarily unavailable Fable variants from the picker catalog', () => {
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('claude-fable-5')
    expect(ids).not.toContain('claude-fable-5-1m')
    expect(ids.indexOf('claude-opus-4-8')).toBeGreaterThan(-1)
  })

  it('keeps the paid Fast tier Opus-only', () => {
    expect(byId.get('claude-opus-4-8')?.additionalSpeedTiers).toContain('fast')
  })

  it('offers the standard Claude thinking efforts on picker-visible thinking models', () => {
    for (const id of ['claude-opus-4-8', 'claude-opus-4-8-1m', 'claude-sonnet-4-6']) {
      const efforts = byId.get(id)?.supportedReasoningEfforts?.map((e) => e.reasoningEffort)
      expect(efforts).toEqual(['off', 'low', 'medium', 'high'])
    }
  })
})
