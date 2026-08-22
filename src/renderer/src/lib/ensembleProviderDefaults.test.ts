import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import { PI_STATIC_MODELS } from '../../../main/pi/PiModels'
import { activePiModelRows } from '../../../shared/piModelLifecycle'
import {
  buildCodexModelChangeParticipantPatch,
  buildKimiReasoningPickerPatch,
  buildProviderModelChangeParticipantPatch,
  getDefaultEnsembleParticipantConfig,
  getDefaultEnsembleRoleName,
  getEnsembleModelDefaults,
  getEnsembleReasoningOptions,
  normalizeProviderModelSelection,
  resolveEnsembleParticipantSettings,
  resolveKimiReasoningPickerSelection,
  resolveReasoningEffortForSeatChange
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
  // (Accept Edits) preset — deterministic, never inherited from the
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

  it('returns kimi defaults: K2.7 Coding, Standard speed, thinking On', () => {
    expect(getDefaultEnsembleParticipantConfig('kimi')).toEqual({
      model: 'kimi-k2.7-code',
      permissionPresetId: 'default',
      reasoningEffort: 'on',
      fastModeEnabled: false,
      thinkingEnabled: true,
      serviceTier: 'standard'
    })
  })

  it('returns grok defaults: Grok 4.6 model, default approval, high reasoning', () => {
    expect(getDefaultEnsembleParticipantConfig('grok')).toEqual({
      model: 'grok-4.6',
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

  it('returns Ollama defaults with its boolean thinking control enabled', () => {
    expect(getDefaultEnsembleParticipantConfig('ollama')).toEqual({
      model: 'qwen3.5:9b',
      permissionPresetId: 'default',
      reasoningEffort: 'on'
    })
  })
})

describe('Kimi reasoning picker selection', () => {
  it('keeps K3 effort separate from K2.7 Coding\'s fixed thinking state', () => {
    expect(resolveKimiReasoningPickerSelection('kimi-k3', 'max')).toBe('max')
    expect(resolveKimiReasoningPickerSelection('kimi-k3', 'high')).toBe('high')
    expect(resolveKimiReasoningPickerSelection('kimi-k3', undefined)).toBe('max')
    expect(resolveKimiReasoningPickerSelection('kimi-k2.7-code', 'max')).toBe('on')
  })

  it('persists K3 ladder choices as reasoning effort rather than the legacy thinking flag', () => {
    expect(buildKimiReasoningPickerPatch('kimi-k3', 'high')).toEqual({
      reasoningEffort: 'high',
      thinkingEnabled: true
    })
    expect(buildKimiReasoningPickerPatch('kimi-k2.7-code', 'on')).toEqual({
      thinkingEnabled: true
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

describe('normalizeProviderModelSelection', () => {
  it('uses the selected Codex model default reasoning and starts Fast off', () => {
    expect(normalizeProviderModelSelection('codex', 'gpt-5.6-sol')).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'low',
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: ''
    })

    expect(
      normalizeProviderModelSelection('codex', 'gpt-live', {
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' }
        ],
        defaultReasoningEffort: 'high',
        additionalSpeedTiers: ['fast']
      })
    ).toEqual({
      model: 'gpt-live',
      reasoningEffort: 'high',
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: ''
    })
  })

  it('clears reasoning for a Claude model with no enabled efforts and starts Fast off', () => {
    expect(normalizeProviderModelSelection('claude', 'claude-haiku-4-5')).toEqual({
      model: 'claude-haiku-4-5',
      reasoningEffort: undefined,
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })

    expect(
      normalizeProviderModelSelection('claude', 'claude-live-no-reasoning', {
        supportedReasoningEfforts: [],
        defaultReasoningEffort: 'medium',
        additionalSpeedTiers: ['fast']
      })
    ).toEqual({
      model: 'claude-live-no-reasoning',
      reasoningEffort: undefined,
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
  })

  it('seeds Kimi thinking with the Standard speed tier', () => {
    expect(normalizeProviderModelSelection('kimi', 'kimi-k2.7-code')).toEqual({
      model: 'kimi-k2.7-code',
      reasoningEffort: 'on',
      fastModeEnabled: false,
      thinkingEnabled: true,
      serviceTier: 'standard'
    })
  })

  it('keeps Grok 4.6 and 4.5 reasoning but treats permanent Fast as provider encoded', () => {
    expect(normalizeProviderModelSelection('grok', 'grok-4.6')).toEqual({
      model: 'grok-4.6',
      reasoningEffort: 'high',
      fastModeEnabled: undefined,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
    expect(normalizeProviderModelSelection('grok', 'grok-4.5')).toEqual({
      model: 'grok-4.5',
      reasoningEffort: 'high',
      fastModeEnabled: undefined,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
    expect(normalizeProviderModelSelection('grok', 'grok-composer-2.5-fast')).toEqual({
      model: 'grok-composer-2.5-fast',
      reasoningEffort: undefined,
      fastModeEnabled: undefined,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
  })

  it('normalizes Cursor Composer variants and Cursor Grok independently', () => {
    expect(normalizeProviderModelSelection('cursor', 'composer-2.5')).toEqual({
      model: 'composer-2.5',
      reasoningEffort: undefined,
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
    expect(normalizeProviderModelSelection('cursor', 'composer-2.5-fast')).toEqual({
      model: 'composer-2.5-fast',
      reasoningEffort: undefined,
      fastModeEnabled: true,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
    expect(normalizeProviderModelSelection('cursor', 'grok-4.6')).toEqual({
      model: 'grok-4.6',
      reasoningEffort: 'high',
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
    expect(normalizeProviderModelSelection('cursor', 'grok-4.5')).toEqual({
      model: 'grok-4.5',
      reasoningEffort: 'high',
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: undefined
    })
  })
})

describe('buildCodexModelChangeParticipantPatch', () => {
  it('replaces stale Sol max reasoning when GPT-5.5 live metadata omits its default', () => {
    const previous = participant({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      fastModeEnabled: true,
      serviceTier: 'fast'
    })
    const patch = buildCodexModelChangeParticipantPatch('gpt-5.5', {
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' },
        { reasoningEffort: 'xhigh' }
      ],
      additionalSpeedTiers: ['fast']
    })

    expect(patch).toEqual({ model: 'gpt-5.5', reasoningEffort: 'medium' })
    expect({ ...previous, ...patch }).toMatchObject({
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      fastModeEnabled: true,
      serviceTier: 'fast'
    })
  })
})

describe('buildProviderModelChangeParticipantPatch', () => {
  it('atomically applies provider hygiene then overrides its generic model seed', () => {
    expect(buildProviderModelChangeParticipantPatch('cursor', 'composer-2.5')).toEqual({
      provider: 'cursor',
      model: 'composer-2.5',
      runtimeProfileId: undefined,
      geminiAuthProfileId: null,
      permissionPresetId: 'default',
      permissionOverrides: undefined,
      reasoningEffort: undefined,
      fastModeEnabled: false,
      thinkingEnabled: undefined,
      serviceTier: undefined,
      linkedProviderSessionId: null
    })
  })

  it('carries seat permissions, closest effort, and Fast across a provider change', () => {
    const previous = participant({
      provider: 'claude',
      permissionPresetId: 'workspace_write',
      permissionOverrides: { approvalMode: 'full_access' },
      reasoningEffort: 'max',
      fastModeEnabled: true
    })
    expect(
      buildProviderModelChangeParticipantPatch('codex', 'gpt-5.5', undefined, previous)
    ).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.5',
      permissionPresetId: 'workspace_write',
      permissionOverrides: { approvalMode: 'full_access' },
      reasoningEffort: 'xhigh',
      fastModeEnabled: true,
      serviceTier: 'fast',
      linkedProviderSessionId: null
    })
  })

  it('preserves a supported Grok effort when switching to a Mistral model', () => {
    const previous = participant({
      provider: 'grok',
      permissionPresetId: 'default',
      reasoningEffort: 'high',
      fastModeEnabled: true
    })
    expect(
      buildProviderModelChangeParticipantPatch('mistral', 'mistral-medium-3.5', undefined, previous)
    ).toMatchObject({
      provider: 'mistral',
      reasoningEffort: 'high',
      model: 'mistral-medium-3.5'
    })
  })
})

describe('resolveReasoningEffortForSeatChange', () => {
  it('keeps an effort that remains enabled and otherwise snaps to the nearest ladder stop', () => {
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'codex',
        model: 'gpt-5.5',
        previousEffort: 'high'
      })
    ).toBe('high')
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'codex',
        model: 'gpt-5.5',
        previousEffort: 'max'
      })
    ).toBe('xhigh')
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'codex',
        model: 'gpt-5.6-sol',
        previousEffort: 'ultracode'
      })
    ).toBe('ultracode')
  })

  it('preserves Muse wire ultra/minimal and rank-snaps Codex ultra→ultracode', () => {
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'muse',
        model: 'muse-spark-1.2',
        previousEffort: 'ultra'
      })
    ).toBe('ultra')
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'muse',
        model: 'muse-spark-1.2',
        previousEffort: 'minimal'
      })
    ).toBe('minimal')
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'muse',
        model: 'muse-spark-1.2',
        previousEffort: 'xhigh'
      })
    ).toBe('xhigh')
    // Legacy Muse seats may still carry Codex-shaped ultracode from the old
    // ultra→ultracode rewrite — snap back to Muse wire ultra.
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'muse',
        model: 'muse-spark-1.2',
        previousEffort: 'ultracode'
      })
    ).toBe('ultra')
    // Off/none floor → Muse minimal (never emit none on Meta argv).
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'muse',
        model: 'muse-spark-1.2',
        previousEffort: 'none'
      })
    ).toBe('minimal')
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'muse',
        model: 'muse-spark-1.2',
        previousEffort: 'off'
      })
    ).toBe('minimal')
    // Codex does not list wire `ultra`; shared rank 6 snaps to ultracode.
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'codex',
        model: 'gpt-5.6-sol',
        previousEffort: 'ultra'
      })
    ).toBe('ultracode')
    // Live model/list may still advertise defaultReasoningEffort: "ultra"
    // while the enabled catalog lists only ultracode.
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'codex',
        model: 'gpt-5.6-sol',
        previousEffort: undefined,
        modelMetadata: { defaultReasoningEffort: 'ultra' }
      })
    ).toBe('ultracode')
  })

  it('keeps Grok 4.6 Extra High and snaps it to High when moving back to 4.5', () => {
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'grok',
        model: 'grok-4.6',
        previousEffort: 'xhigh'
      })
    ).toBe('xhigh')
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'grok',
        model: 'grok-4.5',
        previousEffort: 'xhigh'
      })
    ).toBe('high')
    expect(
      resolveReasoningEffortForSeatChange({
        provider: 'cursor',
        model: 'grok-4.6',
        previousEffort: 'xhigh'
      })
    ).toBe('xhigh')
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

  it('reflects a legacy GPT-OSS Local Scout profile until the user picks an effort', () => {
    const legacy = resolveEnsembleParticipantSettings(
      participant({
        provider: 'ollama',
        model: 'gpt-oss:20b',
        reasoningEffort: undefined,
        ollamaRunProfile: 'local_scout'
      })
    )
    expect(legacy.reasoningEffort).toBe('medium')

    const selected = resolveEnsembleParticipantSettings(
      participant({
        provider: 'ollama',
        model: 'gpt-oss:20b',
        reasoningEffort: 'low',
        ollamaRunProfile: 'local_scout'
      })
    )
    expect(selected.reasoningEffort).toBe('low')
  })

  it('keeps kimi thinking ON even when stale metadata requests off', () => {
    const defaults = resolveEnsembleParticipantSettings(
      participant({ provider: 'kimi', id: 'ensemble-kimi' })
    )
    expect(defaults.thinkingEnabled).toBe(true)
    expect(defaults.fastModeEnabled).toBe(false)
    expect(defaults.serviceTier).toBe('standard')
    expect(defaults.permissionPresetId).toBe('default')

    const overridden = resolveEnsembleParticipantSettings(
      participant({
        provider: 'kimi',
        id: 'ensemble-kimi',
        thinkingEnabled: false
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
    expect(getEnsembleReasoningOptions('codex', 'gpt-5.5').map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    // Official GA tiers (2026-07-09): max on all three; ultra('ultracode') on
    // Sol + Terra only — Luna stops at max.
    expect(
      getEnsembleReasoningOptions('codex', 'gpt-5.6-sol').map((option) => option.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      getEnsembleReasoningOptions('codex', 'gpt-5.6-terra').map((option) => option.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      getEnsembleReasoningOptions('codex', 'gpt-5.6-luna').map((option) => option.value)
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // Stale pre-un-gate placeholder ids keep resolving their concrete slug's
    // ladder so a persisted roster row renders the right reasoning options.
    expect(
      getEnsembleReasoningOptions('codex', 'preview:openai:gpt-5.6:sol').map(
        (option) => option.value
      )
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(
      getEnsembleReasoningOptions('codex', 'preview:openai:gpt-5.6:luna').map(
        (option) => option.value
      )
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
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

  it('warns before Cerebras GLM-4.7 retires and removes only that row on the date', () => {
    const before = getEnsembleModelDefaults('pi', new Date(2026, 7, 16, 23, 59))
    expect(
      before.modelOptions.find((option) => option.id === 'cerebras/zai-glm-4.7')
    ).toMatchObject({
      label: 'GLM-4.7 (Cerebras)',
      retiresAt: '2026-08-17'
    })

    const retired = getEnsembleModelDefaults('pi', new Date(2026, 7, 17, 0, 0))
    expect(retired.modelOptions.some((option) => option.id === 'cerebras/zai-glm-4.7')).toBe(false)
    expect(retired.modelOptions.some((option) => option.id === 'zai/glm-4.7')).toBe(true)
    expect(retired.modelOptions.some((option) => option.id === 'cerebras/gpt-oss-120b')).toBe(true)
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

  it('exposes K2.7 Coding as Fast-capable with fixed thinking on', () => {
    const kimi = getEnsembleModelDefaults('kimi')
    expect(kimi.defaultModelId).toBe('kimi-k2.7-code')
    expect(kimi.defaultReasoning).toBe('on')
    expect(getEnsembleReasoningOptions('kimi', 'kimi-k2.7-code')).toEqual([
      expect.objectContaining({ value: 'on', label: 'On' })
    ])
    expect(kimi.fastModeCapableModelIds.has('kimi-k2.7-code')).toBe(true)
  })

  it('lists K3 after K2.7 Coding with Low, High, and Max but no Fast capability', () => {
    const kimi = getEnsembleModelDefaults('kimi')
    expect(kimi.modelOptions.map((option) => option.id)).toEqual(['kimi-k2.7-code', 'kimi-k3'])
    expect(getEnsembleReasoningOptions('kimi', 'kimi-k3').map((option) => option.value)).toEqual([
      'low',
      'high',
      'max'
    ])
    // K3 has no Highspeed tier — Fast stays a K2.7 Coding exclusive — and the
    // provider default remains K2.7 Coding.
    expect(kimi.fastModeCapableModelIds.has('kimi-k3')).toBe(false)
    expect(kimi.defaultModelId).toBe('kimi-k2.7-code')
    expect(
      resolveEnsembleParticipantSettings(
        participant({
          provider: 'kimi',
          model: 'kimi-k3',
          reasoningEffort: undefined,
          thinkingEnabled: false,
          fastModeEnabled: true
        })
      )
    ).toMatchObject({ reasoningEffort: 'max', thinkingEnabled: true, fastModeEnabled: false })
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
    // Current models first, the Legacy cluster (4.8 1M now among them) below.
    expect(claude.modelOptions.map((option) => option.id)).toEqual([
      'claude-opus-5',
      'claude-fable-5',
      'claude-sonnet-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8-1m',
      'claude-opus-4-7-1m',
      'claude-haiku-4-5'
    ])
    expect(claude.defaultModelId).toBe('claude-sonnet-5')
    expect(claude.fastModeCapableModelIds.has('claude-opus-5')).toBe(true)
    expect(claude.fastModeCapableModelIds.has('claude-opus-4-8-1m')).toBe(true)
    expect(claude.fastModeCapableModelIds.has('claude-opus-4-7-1m')).toBe(true)
    expect(claude.fastModeCapableModelIds.has('claude-fable-5')).toBe(false)
    expect(claude.fastModeCapableModelIds.has('claude-fable-5-1m')).toBe(false)
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

  it('defaults Grok to 4.6 while retaining 4.5 with its narrower effort ladder', () => {
    const grok = getEnsembleModelDefaults('grok')
    expect(grok.defaultModelId).toBe('grok-4.6')
    expect(grok.modelOptions.map((o) => o.id)).toEqual([
      'grok-4.6',
      'grok-4.5',
      'grok-composer-2.5-fast'
    ])
    expect(grok.defaultReasoning).toBe('high')
    expect(grok.reasoningOptions.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(getEnsembleReasoningOptions('grok', 'grok-4.6').map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(getEnsembleReasoningOptions('grok', 'grok-4.5').map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high'
    ])
    for (const alias of ['grok-build', 'grok-build-0.1', 'grok-build-latest']) {
      expect(getEnsembleReasoningOptions('grok', alias).map((o) => o.value)).toEqual([
        'low',
        'medium',
        'high'
      ])
    }
    expect(getEnsembleReasoningOptions('grok', 'grok-composer-2.5-fast')).toEqual([])
    expect(grok.fastModeCapableModelIds.has('grok-4.6')).toBe(true)
    expect(grok.fastModeCapableModelIds.has('grok-4.5')).toBe(true)
  })

  it('keeps Cursor Composer default while exposing Grok 4.6 and 4.5 with reasoning/Fast', () => {
    const cursor = getEnsembleModelDefaults('cursor')
    expect(cursor.defaultModelId).toBe('composer-2.5-fast')
    expect(cursor.modelOptions.map((o) => o.id)).toEqual([
      'composer-2.5-fast',
      'composer-2.5',
      'grok-4.6',
      'grok-4.5'
    ])
    expect(cursor.modelOptions.find((option) => option.id === 'grok-4.6')?.label).toBe(
      'Cursor Grok 4.6'
    )
    expect(cursor.modelOptions.find((option) => option.id === 'grok-4.5')?.label).toBe(
      'Cursor Grok 4.5'
    )
    expect(cursor.reasoningOptions).toEqual([])
    expect(getEnsembleReasoningOptions('cursor', 'composer-2.5')).toEqual([])
    expect(getEnsembleReasoningOptions('cursor', 'composer-2.5-fast')).toEqual([])
    expect(getEnsembleReasoningOptions('cursor', 'grok-4.6').map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
    expect(getEnsembleReasoningOptions('cursor', 'grok-4.5').map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high'
    ])
    expect(cursor.fastModeCapableModelIds.has('grok-4.6')).toBe(true)
    expect(cursor.fastModeCapableModelIds.has('grok-4.5')).toBe(true)
  })

  it('exposes local Ollama models with Qwen 3.5 as the default', () => {
    const ollama = getEnsembleModelDefaults('ollama')
    expect(ollama.defaultModelId).toBe('qwen3.5:9b')
    expect(ollama.modelOptions.map((o) => o.id)).toEqual([
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
      'llama3.2:3b'
    ])
    expect(ollama.reasoningOptions.map((option) => option.value)).toEqual(['off', 'on'])
    expect(ollama.defaultReasoning).toBe('on')
  })

  it('distinguishes Ollama boolean thinking, GPT-OSS levels, unsupported, and live models', () => {
    expect(getEnsembleReasoningOptions('ollama', 'ornith-1.5:35b').map((o) => o.value)).toEqual([
      'off',
      'on'
    ])
    expect(getEnsembleReasoningOptions('ollama', 'gpt-oss:20b').map((o) => o.value)).toEqual([
      'low',
      'medium',
      'high'
    ])
    expect(getEnsembleReasoningOptions('ollama', 'gemma3:4b')).toEqual([])
    expect(
      getEnsembleReasoningOptions('ollama', 'custom-thinking:latest', {
        capabilities: ['completion', 'thinking']
      }).map((o) => o.value)
    ).toEqual(['off', 'on'])
  })
})

describe('muse reasoning options', () => {
  it('includes xhigh between high and ultra (Meta /effort ladder)', () => {
    expect(getEnsembleReasoningOptions('muse').map((option) => option.value)).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra'
    ])
  })
})

describe('mistral configurable reasoning support', () => {
  it('unlocks Devstral Small and Mistral Medium 3.5 to configurable reasoning', () => {
    expect(getEnsembleReasoningOptions('mistral', 'mistral-medium-3.5')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
  })

  it('mirrors the Mistral-hosted lock on the Pi BYOK lane and gives general Pi models the full thinking ladder', () => {
    // Pi-Mistral-hosted ids keep their known model-specific ladder; general
    // Pi API-key models (DeepSeek, ZAI, Cerebras, OpenRouter…) now surface
    // the piReasoningEffort ladder dispatched as Pi thinkingLevel.
    expect(getEnsembleReasoningOptions('pi', 'mistral/mistral-medium-3.5')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
  })

  it('unlocks Devstral Small in both live and Pi BYOK lanes', () => {
    expect(getEnsembleReasoningOptions('mistral', 'devstral-small')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
    expect(getEnsembleReasoningOptions('pi', 'mistral/devstral-small')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
  })

  it('gives general Pi API-key models the full piReasoningEffort ladder', () => {
    const PI_LADDER = [
      { value: 'off', label: 'Off' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra High' },
      { value: 'max', label: 'Max' }
    ]
    expect(getEnsembleReasoningOptions('pi', 'deepseek/deepseek-v4-pro')).toEqual(PI_LADDER)
    expect(getEnsembleReasoningOptions('pi', 'zai/glm-5.2')).toEqual(PI_LADDER)
    expect(getEnsembleReasoningOptions('pi', 'cerebras/gpt-oss-120b')).toEqual(PI_LADDER)
    expect(getEnsembleReasoningOptions('pi', 'openrouter/stealth/ox-alpha')).toEqual(PI_LADDER)
    // Unset model still resolves to the provider-level Pi ladder.
    expect(getEnsembleReasoningOptions('pi', undefined)).toEqual(PI_LADDER)
  })

  it('seeds the Pi add-participant defaults with the full reasoning ladder and a medium default', () => {
    const pi = getEnsembleModelDefaults('pi')
    expect(pi.reasoningOptions.map((option) => option.value)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(pi.defaultReasoning).toBe('medium')
  })

  it('keeps legacy Mistral aliases configurable for picker continuity', () => {
    expect(getEnsembleReasoningOptions('mistral', 'mistral-vibe-cli-latest')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
    expect(getEnsembleReasoningOptions('mistral', 'mistral-small-2603')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
    expect(getEnsembleReasoningOptions('mistral', 'mistral-medium-latest')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
    expect(getEnsembleReasoningOptions('pi', 'mistral/mistral-medium-latest')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
    expect(getEnsembleReasoningOptions('pi', 'mistral/mistral-small-2603')).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' }
    ])
  })

  it('keeps unsupported models on an empty reasoning set', () => {
    expect(getEnsembleReasoningOptions('mistral', undefined)).toEqual([])
  })
})

/*
 * PI_MODELS (the add-participant / model popover list) is a SECOND, hand-kept
 * copy of the Pi catalogue that lives in the renderer because it may not import
 * from src/main at runtime. Unlike the label map (piBrandTable.test.ts) and the
 * rate table (ProviderRateService.test.ts), it had no parity guard — so a model
 * added to the catalogue would appear in the composer picker, which derives
 * from PI_STATIC_MODELS, while silently never showing up when adding an
 * ensemble participant. Both lists are filtered through the same retirement
 * helper so a retiring model can't make this look like drift.
 */
describe('Pi add-participant model options', () => {
  it('offers exactly the active catalogued Pi models, with matching labels', () => {
    const now = new Date('2026-08-06T00:00:00.000Z')
    const offered = Object.fromEntries(
      getEnsembleModelDefaults('pi', now).modelOptions.map((option) => [option.id, option.label])
    )
    const catalogued = Object.fromEntries(
      activePiModelRows(
        PI_STATIC_MODELS.map((model) => ({ id: model.wireId, label: model.label })),
        now
      ).map((model) => [model.id, model.label])
    )

    expect(offered).toEqual(catalogued)
  })
})
