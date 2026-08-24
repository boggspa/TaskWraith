import { describe, expect, it } from 'vitest'
import {
  buildUltraTaskModelCapabilityCatalog,
  materializeDiscoveredUltraTaskSupport,
  mergeUltraTaskCatalogCapabilityMetadata
} from './UltraTaskModelCatalog'

describe('materializeDiscoveredUltraTaskSupport', () => {
  it('admits an exact live model but rejects a control-ineligible row', () => {
    expect(
      materializeDiscoveredUltraTaskSupport('ollama', [
        { id: 'future-local:latest', label: 'Future Local' }
      ])
    ).toEqual([
      {
        id: 'future-local:latest',
        label: 'Future Local',
        ultraTaskSupported: true
      }
    ])
    expect(
      materializeDiscoveredUltraTaskSupport('claude', [{ id: 'claude-haiku-4-5', label: 'Haiku' }])
    ).toEqual([
      {
        id: 'claude-haiku-4-5',
        label: 'Haiku',
        ultraTaskSupported: false
      }
    ])
  })

  it('preserves explicit booleans and never classifies sentinel rows', () => {
    expect(
      materializeDiscoveredUltraTaskSupport('codex', [
        { id: 'gpt-5.5', ultraTaskSupported: false },
        { id: 'future-codex', ultraTaskSupported: true },
        { id: 'cli-default' },
        { id: 'custom' }
      ])
    ).toEqual([
      { id: 'gpt-5.5', ultraTaskSupported: false },
      { id: 'future-codex', ultraTaskSupported: true },
      { id: 'cli-default' },
      { id: 'custom' }
    ])
  })
})

describe('mergeUltraTaskCatalogCapabilityMetadata', () => {
  it('fills only missing exact-model capability fields without mutating live rows', () => {
    const live = [
      { id: 'gpt-5.6-sol', label: 'Account Sol', disabled: false },
      { id: 'future-model', label: 'Future Model' }
    ]
    const fallback = [
      {
        id: 'GPT-5.6-SOL',
        label: 'Static Sol',
        disabled: true,
        ultraTaskSupported: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'ultracode' }]
      }
    ]

    expect(mergeUltraTaskCatalogCapabilityMetadata(live, fallback)).toEqual([
      {
        id: 'gpt-5.6-sol',
        label: 'Account Sol',
        disabled: false,
        ultraTaskSupported: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'ultracode' }]
      },
      { id: 'future-model', label: 'Future Model' }
    ])
    expect(live).toEqual([
      { id: 'gpt-5.6-sol', label: 'Account Sol', disabled: false },
      { id: 'future-model', label: 'Future Model' }
    ])
  })

  it('preserves an explicit live opt-out and live reasoning metadata', () => {
    expect(
      mergeUltraTaskCatalogCapabilityMetadata(
        [
          {
            id: 'claude-haiku-4-5',
            ultraTaskSupported: false,
            supportedReasoningEfforts: []
          }
        ],
        [
          {
            id: 'claude-haiku-4-5',
            ultraTaskSupported: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
          }
        ]
      )
    ).toEqual([
      {
        id: 'claude-haiku-4-5',
        ultraTaskSupported: false,
        supportedReasoningEfforts: []
      }
    ])
  })
})

describe('buildUltraTaskModelCapabilityCatalog', () => {
  it('builds exact candidates and never emits sentinel rows', () => {
    const result = buildUltraTaskModelCapabilityCatalog({
      provider: 'codex',
      source: 'live',
      runtimeEvidence: {
        'gpt-5.6-sol': { state: 'available' }
      },
      models: [
        { id: 'cli-default', label: 'CLI Default', ultraTaskSupported: true },
        { id: 'default', label: 'Default', ultraTaskSupported: true },
        { id: 'custom', label: 'Custom', ultraTaskSupported: true },
        {
          id: 'gpt-5.6-sol',
          label: 'GPT-5.6-Sol',
          ultraTaskSupported: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'ultracode' }]
        }
      ]
    })

    expect(result).toEqual([
      expect.objectContaining({
        provider: 'codex',
        modelId: 'gpt-5.6-sol',
        runtimeAvailability: 'available',
        reasoning: {
          mode: 'configurable',
          ceiling: 'ultracode',
          supported: ['high', 'ultracode']
        }
      })
    ])
  })

  it('does not infer support or runtime availability from a catalog row', () => {
    const [candidate] = buildUltraTaskModelCapabilityCatalog({
      provider: 'muse',
      source: 'static',
      models: [{ id: 'muse-spark-1.2', label: 'Muse Spark 1.2' }]
    })
    expect(candidate).toMatchObject({
      ultraTaskSupported: false,
      runtimeAvailability: 'unknown',
      reasoning: { mode: 'none' }
    })
  })

  it('fills only missing TaskWraith capability metadata from an exact static row', () => {
    const [candidate] = buildUltraTaskModelCapabilityCatalog({
      provider: 'codex',
      source: 'live',
      runtimeEvidence: { 'gpt-5.6-terra': { state: 'available' } },
      models: [{ id: 'gpt-5.6-terra', label: 'Live Terra' }],
      fallbackModels: [
        {
          id: 'gpt-5.6-terra',
          label: 'Static Terra',
          disabled: true,
          ultraTaskSupported: true,
          supportedReasoningEfforts: [
            { reasoningEffort: 'xhigh' },
            { reasoningEffort: 'ultracode' }
          ]
        }
      ]
    })

    expect(candidate).toMatchObject({
      modelId: 'gpt-5.6-terra',
      label: 'Live Terra',
      ultraTaskSupported: true,
      runtimeAvailability: 'available',
      reasoning: {
        mode: 'configurable',
        ceiling: 'ultracode',
        supported: ['xhigh', 'ultracode']
      }
    })
  })

  it('never lets fallback support override an explicit live opt-out', () => {
    const [candidate] = buildUltraTaskModelCapabilityCatalog({
      provider: 'claude',
      source: 'live',
      runtimeEvidence: { 'claude-haiku-4-5': { state: 'available' } },
      models: [
        {
          id: 'claude-haiku-4-5',
          label: 'Live Haiku',
          ultraTaskSupported: false
        }
      ],
      fallbackModels: [
        {
          id: 'claude-haiku-4-5',
          ultraTaskSupported: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'high' }]
        }
      ]
    })
    expect(candidate).toMatchObject({
      ultraTaskSupported: false,
      runtimeAvailability: 'available',
      reasoning: { mode: 'none' }
    })
  })

  it('maps fixed and configurable provider ceilings without inventing high', () => {
    const [kimiFixed] = buildUltraTaskModelCapabilityCatalog({
      provider: 'kimi',
      source: 'live',
      runtimeEvidence: { 'kimi-k2.7-code': { state: 'available' } },
      models: [
        {
          id: 'kimi-k2.7-code',
          label: 'K2.7 Coding',
          ultraTaskSupported: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'on' }]
        }
      ]
    })
    expect(kimiFixed?.reasoning).toEqual({ mode: 'fixed', ceiling: 'on', supported: ['on'] })

    const [piConfigurable] = buildUltraTaskModelCapabilityCatalog({
      provider: 'pi',
      source: 'live',
      runtimeEvidence: { 'deepseek/deepseek-v4-flash': { state: 'available' } },
      models: [
        {
          id: 'deepseek/deepseek-v4-flash',
          label: 'DeepSeek V4 Flash',
          ultraTaskSupported: true
        }
      ]
    })
    expect(piConfigurable?.reasoning).toEqual({
      mode: 'configurable',
      ceiling: 'max',
      supported: ['max']
    })
  })

  it('represents models with no reasoning axis honestly', () => {
    const [candidate] = buildUltraTaskModelCapabilityCatalog({
      provider: 'grok',
      source: 'live',
      runtimeEvidence: { 'grok-composer-2.5-fast': { state: 'available' } },
      models: [
        {
          id: 'grok-composer-2.5-fast',
          label: 'Composer 2.5 Fast',
          ultraTaskSupported: true
        }
      ]
    })
    expect(candidate).toMatchObject({
      ultraTaskSupported: true,
      runtimeAvailability: 'available',
      reasoning: { mode: 'none' }
    })
  })

  it('turns provider/model control contradictions into unavailable evidence', () => {
    const [candidate] = buildUltraTaskModelCapabilityCatalog({
      provider: 'claude',
      source: 'live',
      runtimeEvidence: { 'claude-haiku-4-5': { state: 'available' } },
      models: [
        {
          id: 'claude-haiku-4-5',
          label: 'Haiku 4.5',
          ultraTaskSupported: true
        }
      ]
    })
    expect(candidate).toMatchObject({
      ultraTaskSupported: true,
      runtimeAvailability: 'unavailable',
      runtimeUnavailableReason: expect.stringMatching(/reasoningEffort/i)
    })
  })

  it('keeps disabled evidence stronger than caller-supplied availability', () => {
    const [candidate] = buildUltraTaskModelCapabilityCatalog({
      provider: 'codex',
      source: 'live',
      runtimeEvidence: { 'gpt-5.5': { state: 'available' } },
      models: [
        {
          id: 'gpt-5.5',
          label: 'GPT-5.5',
          disabled: true,
          disabledReason: 'Not admitted for this account.',
          ultraTaskSupported: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }]
        }
      ]
    })
    expect(candidate).toMatchObject({
      runtimeAvailability: 'unavailable',
      runtimeUnavailableReason: 'Not admitted for this account.'
    })
  })
})
