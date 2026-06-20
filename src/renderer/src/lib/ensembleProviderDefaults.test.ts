import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  getDefaultEnsembleParticipantConfig,
  getEnsembleModelDefaults,
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
  it('returns codex defaults: cli-default model, workspace_write, medium reasoning, fast off', () => {
    expect(getDefaultEnsembleParticipantConfig('codex')).toEqual({
      model: 'cli-default',
      permissionPresetId: 'workspace_write',
      reasoningEffort: 'medium',
      fastModeEnabled: false,
      serviceTier: ''
    })
  })

  it('returns claude defaults: cli-default model, read_only, medium reasoning, fast off', () => {
    expect(getDefaultEnsembleParticipantConfig('claude')).toEqual({
      model: 'cli-default',
      permissionPresetId: 'read_only',
      reasoningEffort: 'medium',
      fastModeEnabled: false
    })
  })

  it('returns gemini defaults: cli-default model, read_only, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('gemini')).toEqual({
      model: 'cli-default',
      permissionPresetId: 'read_only'
    })
  })

  it('returns kimi defaults: cli-default model, read_only, thinking off', () => {
    expect(getDefaultEnsembleParticipantConfig('kimi')).toEqual({
      model: 'cli-default',
      permissionPresetId: 'read_only',
      thinkingEnabled: false
    })
  })

  it('returns grok defaults: cli-default model, read_only (until G5), medium reasoning', () => {
    expect(getDefaultEnsembleParticipantConfig('grok')).toEqual({
      model: 'cli-default',
      permissionPresetId: 'read_only',
      reasoningEffort: 'medium'
    })
  })

  it('returns cursor defaults: cli-default model, read_only, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('cursor')).toEqual({
      model: 'cli-default',
      permissionPresetId: 'read_only'
    })
  })

  it('returns ollama defaults: cli-default model, read_only, no reasoning axis', () => {
    expect(getDefaultEnsembleParticipantConfig('ollama')).toEqual({
      model: 'cli-default',
      permissionPresetId: 'read_only'
    })
  })
})

describe('resolveEnsembleParticipantSettings', () => {
  it('fills missing fields from the codex provider defaults', () => {
    const resolved = resolveEnsembleParticipantSettings(participant({ provider: 'codex' }))
    expect(resolved).toEqual({
      provider: 'codex',
      model: 'cli-default',
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
  // `defaultModelId` here for the displayed default, while the
  // participant record persists `'cli-default'` until the user picks
  // something — the two intentionally differ (see the docstring on
  // `getDefaultEnsembleParticipantConfig`).
  it('exposes codex preferred model id as gpt-5.5', () => {
    expect(getEnsembleModelDefaults('codex').defaultModelId).toBe('gpt-5.5')
  })

  it('exposes kimi preferred model id as kimi-k2.7-code', () => {
    expect(getEnsembleModelDefaults('kimi').defaultModelId).toBe('kimi-k2.7-code')
  })

  it('hides temporarily unavailable Claude Fable variants from ensemble model options', () => {
    const claude = getEnsembleModelDefaults('claude')
    expect(claude.modelOptions.map((option) => option.id)).not.toEqual(
      expect.arrayContaining(['claude-fable-5', 'claude-fable-5-1m'])
    )
  })

  it('exposes grok preferred model id as Grok Composer with the effort reasoning axis', () => {
    const grok = getEnsembleModelDefaults('grok')
    expect(grok.defaultModelId).toBe('grok-composer-2.5-fast')
    expect(grok.modelOptions.map((o) => o.id)).toEqual(['grok-composer-2.5-fast', 'grok-build'])
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
    expect(cursor.defaultModelId).toBe('composer-2.5')
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
      'gpt-oss:20b',
      'minicpm-v4.5:8b',
      'granite4.1:3b',
      'granite4.1:30b',
      'nemotron3:33b'
    ])
    expect(ollama.reasoningOptions).toEqual([])
  })
})
