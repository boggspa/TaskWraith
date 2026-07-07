import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  getDefaultEnsembleParticipantConfig,
  getEnsembleModelDefaults,
  getEnsembleReasoningOptions,
  resolveEnsembleParticipantSettings
} from './ensembleProviderDefaults'

// F2 (1.0.3) — these defaults are the canonical seed values used both
// when creating a new ensemble participant and when resolving the
// effective settings the composer pickers display. The fixtures here
// intentionally mirror the previously-scattered fallbacks in App.tsx +
// EnsembleDefaults.ts + EnsembleOrchestrator.ts so a regression in any
// of them surfaces as a test failure here.

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'ensemble-codex',
    provider: 'codex',
    enabled: true,
    role: 'Worker',
    instructions: 'Work.',
    order: 1,
    ...overrides
  }
}

describe('getDefaultEnsembleParticipantConfig', () => {
  it('returns codex defaults: GPT-5.5 model, workspace_write, medium reasoning, fast off', () => {
    expect(getDefaultEnsembleParticipantConfig('codex')).toEqual({
      model: 'gpt-5.5',
      permissionPresetId: 'workspace_write',
      reasoningEffort: 'medium',
      fastModeEnabled: false,
      serviceTier: ''
    })
  })

  it('returns claude defaults: Sonnet 5 model, read_only, medium reasoning, fast off', () => {
    expect(getDefaultEnsembleParticipantConfig('claude')).toEqual({
      model: 'claude-sonnet-5',
      permissionPresetId: 'read_only',
      reasoningEffort: 'medium',
      fastModeEnabled: false
    })
  })

  it('returns gemini defaults: Flash Lite model, read_only, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('gemini')).toEqual({
      model: 'flash-lite',
      permissionPresetId: 'read_only'
    })
  })

  it('returns kimi defaults: K2.7 Code model, read_only, thinking off', () => {
    expect(getDefaultEnsembleParticipantConfig('kimi')).toEqual({
      model: 'kimi-k2.7-code',
      permissionPresetId: 'read_only',
      thinkingEnabled: false
    })
  })

  it('returns grok defaults: Build 0.1 model, read_only (until G5), medium reasoning', () => {
    expect(getDefaultEnsembleParticipantConfig('grok')).toEqual({
      model: 'grok-build',
      permissionPresetId: 'read_only',
      reasoningEffort: 'medium'
    })
  })

  it('returns cursor defaults: Composer 2.5 Fast model, read_only, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('cursor')).toEqual({
      model: 'composer-2.5-fast',
      permissionPresetId: 'read_only'
    })
  })

  it('returns ollama defaults: Qwen 3 model, read_only, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('ollama')).toEqual({
      model: 'qwen3:4b-instruct',
      permissionPresetId: 'read_only'
    })
  })
})

describe('resolveEnsembleParticipantSettings', () => {
  it('fills missing fields from the codex provider defaults', () => {
    const resolved = resolveEnsembleParticipantSettings(participant({ provider: 'codex' }))
    expect(resolved).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      permissionPresetId: 'workspace_write',
      reasoningEffort: 'medium',
      fastModeEnabled: false,
      thinkingEnabled: false,
      serviceTier: ''
    })
  })

  it('respects participant overrides for codex (model + reasoning + fast tier)', () => {
    const resolved = resolveEnsembleParticipantSettings(
      participant({
        provider: 'codex',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        fastModeEnabled: true
      })
    )
    expect(resolved.model).toBe('gpt-5.5')
    expect(resolved.reasoningEffort).toBe('xhigh')
    expect(resolved.fastModeEnabled).toBe(true)
    // fastModeEnabled=true and no explicit serviceTier → inferred 'fast'
    expect(resolved.serviceTier).toBe('fast')
  })

  it('honours an explicit serviceTier over the fastModeEnabled inference', () => {
    const resolved = resolveEnsembleParticipantSettings(
      participant({
        provider: 'codex',
        fastModeEnabled: true,
        serviceTier: ''
      })
    )
    // Explicit empty string wins over the inference.
    expect(resolved.serviceTier).toBe('')
  })

  it('resolves claude defaults and override patterns', () => {
    const defaults = resolveEnsembleParticipantSettings(
      participant({ provider: 'claude', id: 'ensemble-claude' })
    )
    expect(defaults.reasoningEffort).toBe('medium')
    expect(defaults.permissionPresetId).toBe('read_only')
    expect(defaults.fastModeEnabled).toBe(false)

    const overridden = resolveEnsembleParticipantSettings(
      participant({
        provider: 'claude',
        id: 'ensemble-claude',
        reasoningEffort: 'high',
        fastModeEnabled: true
      })
    )
    expect(overridden.reasoningEffort).toBe('high')
    expect(overridden.fastModeEnabled).toBe(true)
  })

  it('coerces Claude reasoning by selected model family', () => {
    const opus = resolveEnsembleParticipantSettings(
      participant({
        provider: 'claude',
        id: 'ensemble-claude',
        model: 'claude-opus-4-8-1m',
        reasoningEffort: 'ultracode'
      })
    )
    expect(opus.reasoningEffort).toBe('ultracode')

    const sonnet = resolveEnsembleParticipantSettings(
      participant({
        provider: 'claude',
        id: 'ensemble-claude',
        model: 'claude-sonnet-4-6',
        reasoningEffort: 'xhigh'
      })
    )
    expect(sonnet.reasoningEffort).toBe('medium')

    const haiku = resolveEnsembleParticipantSettings(
      participant({
        provider: 'claude',
        id: 'ensemble-claude',
        model: 'claude-haiku-4-5',
        reasoningEffort: 'max'
      })
    )
    expect(haiku.reasoningEffort).toBe('')
  })

  it('resolves gemini with no reasoning axis (empty string)', () => {
    const resolved = resolveEnsembleParticipantSettings(
      participant({ provider: 'gemini', id: 'ensemble-gemini' })
    )
    expect(resolved.reasoningEffort).toBe('')
    expect(resolved.permissionPresetId).toBe('read_only')
    expect(resolved.fastModeEnabled).toBe(false)
    expect(resolved.thinkingEnabled).toBe(false)
  })

  it('resolves kimi thinking off by default, on when overridden', () => {
    const defaults = resolveEnsembleParticipantSettings(
      participant({ provider: 'kimi', id: 'ensemble-kimi' })
    )
    expect(defaults.thinkingEnabled).toBe(false)
    expect(defaults.permissionPresetId).toBe('read_only')

    const overridden = resolveEnsembleParticipantSettings(
      participant({
        provider: 'kimi',
        id: 'ensemble-kimi',
        thinkingEnabled: true
      })
    )
    expect(overridden.thinkingEnabled).toBe(true)
  })
})

describe('getEnsembleModelDefaults (existing helper)', () => {
  // Sanity check that the previously-existing model-options helper is
  // untouched by the F2 consolidation. The chip picker reads
  // `defaultModelId` here should match the concrete model persisted by
  // `getDefaultEnsembleParticipantConfig`; generic Default/CLI Default rows
  // must not reappear in the picker.
  it('exposes codex preferred model id as gpt-5.5', () => {
    const codex = getEnsembleModelDefaults('codex')
    expect(codex.defaultModelId).toBe('gpt-5.5')
    expect(codex.reasoningOptions.map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(
      getEnsembleReasoningOptions('codex', 'gpt-5.5').map((option) => option.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(
      getEnsembleReasoningOptions('codex', 'gpt-5.6-sol').map((option) => option.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Stale pre-un-gate placeholder ids keep resolving Sol's Max ladder so a
    // persisted roster row renders the right reasoning options.
    expect(
      getEnsembleReasoningOptions('codex', 'preview:openai:gpt-5.6:sol').map(
        (option) => option.value
      )
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    const sol = codex.modelOptions.find((option) => option.id === 'gpt-5.6-sol')
    expect(sol).toMatchObject({ label: 'GPT-5.6 Sol' })
    expect(sol?.disabled).toBeUndefined()
    expect(codex.modelOptions.map((option) => option.id)).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    )
  })

  it('does not expose Default or CLI Default as ensemble picker model rows', () => {
    for (const provider of [
      'codex',
      'claude',
      'gemini',
      'kimi',
      'grok',
      'cursor',
      'ollama'
    ] as const) {
      const options = getEnsembleModelDefaults(provider).modelOptions
      expect(options.map((option) => option.id)).not.toEqual(
        expect.arrayContaining(['default', 'cli-default'])
      )
      expect(options.map((option) => option.label)).not.toEqual(
        expect.arrayContaining(['Default', 'CLI Default'])
      )
    }
  })

  it('exposes kimi preferred model id as kimi-k2.7-code', () => {
    expect(getEnsembleModelDefaults('kimi').defaultModelId).toBe('kimi-k2.7-code')
  })

  it('exposes returned Claude 5 family rows and Sonnet 4.6 Legacy without Mythos', () => {
    const claude = getEnsembleModelDefaults('claude')
    expect(claude.modelOptions.map((option) => option.id)).not.toEqual(
      expect.arrayContaining([
        'default',
        'cli-default',
        'claude-opus-4-8',
        'claude-opus-4-7',
        'claude-opus-4-6',
        'preview:anthropic:claude-sonnet-5',
        'preview:anthropic:claude-fable-5',
        'preview:anthropic:claude-mythos-5',
        'claude-mythos-5',
        'claude-fable-5-1m'
      ])
    )
    expect(claude.modelOptions.find((option) => option.id === 'claude-sonnet-5')?.disabled).toBeFalsy()
    expect(claude.modelOptions.find((option) => option.id === 'claude-fable-5')?.disabled).toBeFalsy()
    expect(claude.modelOptions.map((option) => option.id)).toEqual([
      'claude-opus-4-8-1m',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-4-7-1m',
      'claude-haiku-4-5'
    ])
    expect(claude.defaultModelId).toBe('claude-sonnet-5')
  })

  it('returns model-aware Claude reasoning options for ensemble pickers', () => {
    const sonnet5 = getEnsembleReasoningOptions('claude', 'claude-sonnet-5')
    const sonnetLegacy = getEnsembleReasoningOptions('claude', 'claude-sonnet-4-6')
    const opus = getEnsembleReasoningOptions('claude', 'claude-opus-4-8-1m')
    const fable = getEnsembleReasoningOptions('claude', 'claude-fable-5')
    const mythos = getEnsembleReasoningOptions('claude', 'claude-mythos-5')
    const haiku = getEnsembleReasoningOptions('claude', 'claude-haiku-4-5')
    // Sonnet 5 unlocks the full Opus ladder with nothing disabled.
    expect(sonnet5.map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(sonnet5.filter((o) => o.disabled).map((o) => o.value)).toEqual([])
    // Future Sonnet 5 variants (e.g. a 1M row) share the full ladder...
    expect(
      getEnsembleReasoningOptions('claude', 'claude-sonnet-5-1m')
        .filter((o) => o.disabled)
        .map((o) => o.value)
    ).toEqual([])
    // ...but the retired Sonnet 4.x line — and a numeric lookalike — stay capped.
    expect(sonnetLegacy.filter((o) => o.disabled).map((o) => o.value)).toEqual([
      'xhigh',
      'ultracode'
    ])
    expect(
      getEnsembleReasoningOptions('claude', 'claude-sonnet-50')
        .filter((o) => o.disabled)
        .map((o) => o.value)
    ).toEqual(['xhigh', 'ultracode'])
    expect(opus.map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(opus.every((o) => !o.disabled)).toBe(true)
    expect(fable.every((o) => !o.disabled)).toBe(true)
    expect(mythos.every((o) => !o.disabled)).toBe(true)
    expect(haiku.map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode'
    ])
    expect(haiku.every((o) => o.disabled)).toBe(true)
  })

  it('exposes grok preferred model id as Grok Build with the effort reasoning axis', () => {
    const grok = getEnsembleModelDefaults('grok')
    expect(grok.defaultModelId).toBe('grok-build')
    expect(grok.modelOptions.map((o) => o.id)).toEqual(['grok-build', 'grok-composer-2.5-fast'])
    expect(grok.defaultReasoning).toBe('medium')
    expect(grok.reasoningOptions.map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  it('exposes cursor models (composer-2.5 + fast) with no reasoning axis', () => {
    const cursor = getEnsembleModelDefaults('cursor')
    expect(cursor.defaultModelId).toBe('composer-2.5-fast')
    expect(cursor.modelOptions.map((o) => o.id)).toEqual(['composer-2.5', 'composer-2.5-fast'])
    expect(cursor.reasoningOptions).toEqual([])
  })

  it('exposes local Ollama models without changing the Qwen default', () => {
    const ollama = getEnsembleModelDefaults('ollama')
    expect(ollama.defaultModelId).toBe('qwen3:4b-instruct')
    expect(ollama.modelOptions.map((o) => o.id)).toEqual([
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
      'nemotron3:33b'
    ])
    expect(ollama.reasoningOptions).toEqual([])
  })
})
