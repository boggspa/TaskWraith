import { describe, it, expect } from 'vitest'
import {
  codexReasoningEffortsForModel,
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

  it('keeps returned Fable and Mythos ids runnable', () => {
    expect(normalizeCliProviderModel('claude', 'fable')).toBe('claude-fable-5')
    expect(normalizeCliProviderModel('claude', 'mythos')).toBe('claude-mythos-5')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5')).toBe('claude-fable-5')
    expect(normalizeCliProviderModel('claude', 'claude-fable-5-1m')).toBe('claude-fable-5')
    expect(normalizeCliProviderModel('claude', 'claude-mythos-5')).toBe('claude-mythos-5')
  })

  it('maps non-runnable / stale Claude preview placeholders back to the concrete default', () => {
    // claude-sonnet-5 is GA, but a persisted preview-namespaced id from before
    // it shipped still maps to the concrete default rather than dispatching an
    // invalid `preview:` model name.
    expect(normalizeCliProviderModel('claude', 'preview:anthropic:claude-sonnet-5')).toBe(
      'claude-sonnet-5'
    )
    expect(normalizeCliProviderModel('claude', 'preview:anthropic:claude-fable-5')).toBe(
      'claude-sonnet-5'
    )
    expect(normalizeCliProviderModel('claude', 'preview:anthropic:claude-mythos-5')).toBe(
      'claude-sonnet-5'
    )
  })

  it('maps empty / sentinel ids to Sonnet 5', () => {
    expect(normalizeCliProviderModel('claude', '')).toBe('claude-sonnet-5')
    expect(normalizeCliProviderModel('claude', 'default')).toBe('claude-sonnet-5')
    expect(normalizeCliProviderModel('claude', 'cli-default')).toBe('claude-sonnet-5')
    expect(normalizeCliProviderModel('claude', 'custom')).toBe('claude-sonnet-5')
  })

  it('keeps the legacy Sonnet 4.6 id runnable for historical selections', () => {
    expect(normalizeCliProviderModel('claude', 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })
})

interface StaticModelShape {
  id: string
  isDefault?: boolean
  disabled?: boolean
  disabledReason?: string
  defaultReasoningEffort?: string | null
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
      'ornith:9b',
      'ornith:35b',
      'laguna-xs-2.1:q8_0',
      'gpt-oss:20b',
      'minicpm-v4.5:8b',
      'granite4.1:3b',
      'granite4.1:30b',
      'nemotron3:33b',
      'custom'
    ])
  })

  it('keeps GPT-5.5 as the Codex default and hides GPT-5.6 previews by default', () => {
    const models = getStaticProviderModels('codex') as StaticModelShape[]
    expect(models.find((model) => model.isDefault)?.id).toBe('gpt-5.5')
    expect(models.map((model) => model.id)).not.toEqual(
      expect.arrayContaining([
        'preview:openai:gpt-5.6:sol',
        'preview:openai:gpt-5.6:terra',
        'preview:openai:gpt-5.6:luna'
      ])
    )
  })

  it('advertises Light/low reasoning on GPT-5 Codex models', () => {
    const models = getStaticProviderModels('codex') as StaticModelShape[]
    for (const modelId of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(
        models
          .find((model) => model.id === modelId)
          ?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)
      ).toContain('low')
    }
  })

  it('fills missing Light/low reasoning from stale live Codex model metadata', () => {
    expect(
      codexReasoningEffortsForModel('gpt-5.5', [
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' }
      ]).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('can expose disabled OpenAI preview placeholders behind the preview catalog flag', () => {
    const models = getStaticProviderModels('codex', {
      includePreviewModels: true
    }) as StaticModelShape[]
    expect(models.find((model) => model.isDefault)?.id).toBe('gpt-5.5')
    const sol = models.find((model) => model.id === 'preview:openai:gpt-5.6:sol')
    const terra = models.find((model) => model.id === 'preview:openai:gpt-5.6:terra')
    const luna = models.find((model) => model.id === 'preview:openai:gpt-5.6:luna')
    expect(sol).toMatchObject({
      disabled: true,
      disabledReason: 'Requires OpenAI preview access',
      defaultReasoningEffort: 'medium'
    })
    expect(sol?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(terra).toMatchObject({
      disabled: true,
      disabledReason: 'Requires OpenAI preview access'
    })
    expect(terra?.supportedReasoningEfforts?.map((option) => option.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(luna).toMatchObject({
      disabled: true,
      disabledReason: 'Requires OpenAI preview access'
    })
  })

  it('maps non-runnable OpenAI preview placeholder IDs back to GPT-5.5', () => {
    expect(normalizeCliProviderModel('codex', 'preview:openai:gpt-5.6:sol')).toBe(
      'gpt-5.5'
    )
  })

  it('adds Max reasoning only for GPT-5.6 Sol Codex rows', () => {
    expect(
      codexReasoningEffortsForModel('gpt-5.6-sol', [
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' }
      ]).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(
      codexReasoningEffortsForModel('gpt-5.6-terra', [
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' }
      ]).map((option) => option.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
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

  it('hides Claude preview placeholders unless explicitly requested', () => {
    const ids = models.map((m) => m.id)
    expect(ids).not.toContain('default')
    expect(ids).toContain('claude-fable-5')
    expect(ids).not.toContain('claude-mythos-5')
    expect(ids).not.toContain('claude-fable-5-1m')
    expect(ids).not.toContain('preview:anthropic:claude-sonnet-5')
    expect(ids).not.toContain('preview:anthropic:claude-fable-5')
    expect(ids).not.toContain('preview:anthropic:claude-mythos-5')
    expect(ids).not.toContain('claude-opus-4-8')
    expect(ids).toContain('claude-opus-4-8-1m')
    // Sonnet 5 and Fable 5 are selectable rows; Mythos 5 stays runnable as a
    // historical/tombstoned model but is no longer offered in pickers.
    expect(ids).toContain('claude-sonnet-5')
  })

  it('keeps retired Claude preview placeholders out behind the preview catalog flag', () => {
    const previewModels = getStaticProviderModels('claude', {
      includePreviewModels: true
    }) as StaticModelShape[]
    const previewById = new Map(previewModels.map((m) => [m.id, m]))
    expect(previewById.get('preview:anthropic:claude-sonnet-5')).toBeUndefined()
    expect(previewById.get('preview:anthropic:claude-fable-5')).toBeUndefined()
    expect(previewById.get('preview:anthropic:claude-mythos-5')).toBeUndefined()
    expect(previewById.get('claude-fable-5')?.disabled).toBeFalsy()
    expect(previewById.get('claude-mythos-5')).toBeUndefined()
  })

  it('marks Claude Sonnet 5 as the default and keeps Sonnet 4.6 Legacy selectable', () => {
    expect(byId.get('claude-sonnet-5')).toMatchObject({
      isDefault: true,
      description: '1M context window — extended thinking'
    })
    expect(byId.get('claude-sonnet-4-6')).toMatchObject({
      label: 'Claude Sonnet 4.6 Legacy',
      description: '200K context window — legacy Sonnet'
    })
  })

  it('keeps the paid Fast tier on the default 1M Opus rows', () => {
    expect(byId.get('claude-opus-4-8-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-opus-4-7-1m')?.additionalSpeedTiers).toContain('fast')
    expect(byId.get('claude-fable-5')?.additionalSpeedTiers).toContain('fast')
  })

  it('offers family-specific Claude reasoning efforts', () => {
    const sonnetReasoning = byId.get('claude-sonnet-5')?.supportedReasoningEfforts ?? []
    const legacySonnetReasoning = byId.get('claude-sonnet-4-6')?.supportedReasoningEfforts ?? []
    const opusReasoning = byId.get('claude-opus-4-8-1m')?.supportedReasoningEfforts ?? []
    const fableReasoning = byId.get('claude-fable-5')?.supportedReasoningEfforts ?? []
    const haikuReasoning = byId.get('claude-haiku-4-5')?.supportedReasoningEfforts ?? []
    expect(
      sonnetReasoning.map((e) => e.reasoningEffort)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    // Sonnet 5 unlocks the full Opus ladder — none of its efforts are disabled.
    expect(
      sonnetReasoning
        .filter((e) => e.disabled)
        .map((e) => e.reasoningEffort)
    ).toEqual([])
    expect(
      legacySonnetReasoning
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
    expect(fableReasoning.every((e) => !e.disabled)).toBe(true)
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
