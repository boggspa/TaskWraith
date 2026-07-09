import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  getDefaultEnsembleParticipantConfig,
  getDefaultEnsembleRoleName,
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
  // Every live provider seeds new participants with the 'default'
  // (Default Approval) preset — deterministic, never inherited from the
  // selected chip. Roster presets / Agent Pool are the only inheritance
  // paths; the seeded default panel (EnsembleDefaults.ts) keeps its own
  // curated writer/reader split and is pinned in EnsembleDefaults.test.ts.
  it('returns codex defaults: GPT-5.5 model, default approval, medium reasoning, fast off', () => {
    expect(getDefaultEnsembleParticipantConfig('codex')).toEqual({
      model: 'gpt-5.5',
      permissionPresetId: 'default',
      reasoningEffort: 'medium',
      fastModeEnabled: false,
      serviceTier: ''
    })
  })

  it('returns claude defaults: Sonnet 5 model, default approval, medium reasoning, fast off', () => {
    expect(getDefaultEnsembleParticipantConfig('claude')).toEqual({
      model: 'claude-sonnet-5',
      permissionPresetId: 'default',
      reasoningEffort: 'medium',
      fastModeEnabled: false
    })
  })

  it('returns gemini (retired) defaults: Flash Lite model, read_only, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('gemini')).toEqual({
      model: 'flash-lite',
      permissionPresetId: 'read_only'
    })
  })

  it('returns kimi defaults: K2.7 Code model, default approval, thinking ON', () => {
    expect(getDefaultEnsembleParticipantConfig('kimi')).toEqual({
      model: 'kimi-k2.7-code',
      permissionPresetId: 'default',
      thinkingEnabled: true
    })
  })

  it('returns grok defaults: Grok 4.5 model, default approval, high reasoning', () => {
    expect(getDefaultEnsembleParticipantConfig('grok')).toEqual({
      model: 'grok-4.5',
      permissionPresetId: 'default',
      reasoningEffort: 'high'
    })
  })

  it('returns cursor defaults: Composer 2.5 Fast model, default approval, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('cursor')).toEqual({
      model: 'composer-2.5-fast',
      permissionPresetId: 'default',
      fastModeEnabled: true
    })
  })

  it('returns ollama defaults: Qwen 3.5 model, default approval, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('ollama')).toEqual({
      model: 'qwen3.5:9b',
      permissionPresetId: 'default'
    })
  })
})

describe('getDefaultEnsembleRoleName', () => {
  it('maps each live provider to its deterministic default role name', () => {
    expect(getDefaultEnsembleRoleName('codex')).toBe('Codex')
    expect(getDefaultEnsembleRoleName('claude')).toBe('Claude')
    expect(getDefaultEnsembleRoleName('kimi')).toBe('Kimi')
    expect(getDefaultEnsembleRoleName('grok')).toBe('Grok')
    expect(getDefaultEnsembleRoleName('cursor')).toBe('Cursor')
    // Ollama seats read "Local" — mirrors the seeded default panel.
    expect(getDefaultEnsembleRoleName('ollama')).toBe('Local')
  })
})

describe('resolveEnsembleParticipantSettings', () => {
  it('fills missing fields from the codex provider defaults', () => {
    const resolved = resolveEnsembleParticipantSettings(participant({ provider: 'codex' }))
    expect(resolved).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
      permissionPresetId: 'default',
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
    expect(defaults.permissionPresetId).toBe('default')
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

  it('resolves kimi thinking ON by default, off when overridden', () => {
    const defaults = resolveEnsembleParticipantSettings(
      participant({ provider: 'kimi', id: 'ensemble-kimi' })
    )
    expect(defaults.thinkingEnabled).toBe(true)
    expect(defaults.permissionPresetId).toBe('default')

    const overridden = resolveEnsembleParticipantSettings(
      participant({
        provider: 'kimi',
        id: 'ensemble-kimi',
        thinkingEnabled: false
      })
    )
    expect(overridden.thinkingEnabled).toBe(false)
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
    expect(getEnsembleReasoningOptions('codex', 'gpt-5.5').map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    // All three trio models top out at max — codex's ultra tier is deliberately
    // not offered (crashes TaskWraith's app-server via its multi-agent path).
    const codexTop = ['low', 'medium', 'high', 'xhigh', 'max']
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(getEnsembleReasoningOptions('codex', id).map((option) => option.value)).toEqual(
        codexTop
      )
    }
    // Stale pre-un-gate placeholder ids keep resolving their concrete slug's
    // ladder so a persisted roster row renders the right reasoning options.
    for (const id of ['preview:openai:gpt-5.6:sol', 'preview:openai:gpt-5.6:luna']) {
      expect(getEnsembleReasoningOptions('codex', id).map((option) => option.value)).toEqual(
        codexTop
      )
    }
    const sol = codex.modelOptions.find((option) => option.id === 'gpt-5.6-sol')
    expect(sol).toMatchObject({ label: 'GPT-5.6-Sol' })
    expect(sol?.disabled).toBeUndefined()
    expect(codex.modelOptions.map((option) => option.id)).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    )
    // GA parity: ensemble seats get the Fast toggle the trio already gets solo.
    expect(codex.fastModeCapableModelIds.has('gpt-5.6-sol')).toBe(true)
    expect(codex.fastModeCapableModelIds.has('gpt-5.6-terra')).toBe(true)
    expect(codex.fastModeCapableModelIds.has('gpt-5.6-luna')).toBe(true)
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

  it('exposes kimi preferred model id as kimi-k2.7-code with thinking on by default', () => {
    expect(getEnsembleModelDefaults('kimi').defaultModelId).toBe('kimi-k2.7-code')
    expect(getEnsembleModelDefaults('kimi').defaultReasoning).toBe('on')
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
    expect(
      claude.modelOptions.find((option) => option.id === 'claude-sonnet-5')?.disabled
    ).toBeFalsy()
    expect(
      claude.modelOptions.find((option) => option.id === 'claude-fable-5')?.disabled
    ).toBeFalsy()
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
    expect(opus.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
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

  it('exposes grok preferred model id as Grok 4.5 with the effort reasoning axis', () => {
    const grok = getEnsembleModelDefaults('grok')
    expect(grok.defaultModelId).toBe('grok-4.5')
    expect(grok.modelOptions.map((o) => o.id)).toEqual(['grok-4.5', 'grok-composer-2.5-fast'])
    expect(grok.defaultReasoning).toBe('high')
    expect(grok.reasoningOptions.map((o) => o.value)).toEqual(['low', 'medium', 'high'])
    expect(getEnsembleReasoningOptions('grok', 'grok-composer-2.5-fast')).toEqual([])
  })

  it('exposes cursor Composer without reasoning and Cursor Grok 4.5 with reasoning/Fast', () => {
    const cursor = getEnsembleModelDefaults('cursor')
    expect(cursor.defaultModelId).toBe('composer-2.5-fast')
    expect(cursor.modelOptions.map((o) => o.id)).toEqual([
      'composer-2.5-fast',
      'composer-2.5',
      'grok-4.5'
    ])
    expect(cursor.reasoningOptions).toEqual([])
    expect(getEnsembleReasoningOptions('cursor', 'composer-2.5')).toEqual([])
    expect(getEnsembleReasoningOptions('cursor', 'composer-2.5-fast')).toEqual([])
    expect(getEnsembleReasoningOptions('cursor', 'grok-4.5').map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high'
    ])
    expect(cursor.fastModeCapableModelIds.has('grok-4.5')).toBe(true)
  })

  it('exposes local Ollama models with Qwen 3.5 as the default', () => {
    const ollama = getEnsembleModelDefaults('ollama')
    expect(ollama.defaultModelId).toBe('qwen3.5:9b')
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
