import { describe, expect, it } from 'vitest'
import { resolvePiReasoningSupport } from '../../../shared/piReasoning'
import {
  acceptedProviderReasoningEfforts,
  resolveComposerModelReasoningDefault
} from './composerProviderReasoningSelection'

describe('resolveComposerModelReasoningDefault', () => {
  const optionsForPiModel = (modelId: string): Array<{ value: string }> =>
    resolvePiReasoningSupport(modelId).efforts.map((value) => ({ value }))

  it.each([
    'openrouter/cohere/north-mini-code:free',
    'openrouter/minimax/minimax-m3:free',
    'openrouter/thinkingmachines/inkling:free',
    'openrouter/thinkingmachines/inkling-small:free'
  ])('seeds %s at High instead of the first Off stop', (modelId) => {
    expect(
      resolveComposerModelReasoningDefault({
        provider: 'pi',
        modelId,
        reasoningOptions: optionsForPiModel(modelId)
      })
    ).toBe('high')
  })

  it.each([
    'openrouter/inception/mercury-2.5',
    'openrouter/nex-agi/nex-n2.5-mini:free',
    'openrouter/nex-agi/nex-n2.5-pro:free'
  ])('seeds %s at Medium, its own ladder default, rather than Off or High', (modelId) => {
    const reasoningOptions = optionsForPiModel(modelId)
    expect(reasoningOptions.map((option) => option.value)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'max'
    ])
    expect(
      resolveComposerModelReasoningDefault({ provider: 'pi', modelId, reasoningOptions })
    ).toBe('medium')
  })

  it('keeps Inkling Minimal available without making it the fresh-model default', () => {
    const modelId = 'openrouter/thinkingmachines/inkling:free'
    const reasoningOptions = optionsForPiModel(modelId)

    expect(reasoningOptions.map((option) => option.value)).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'max'
    ])
    expect(
      resolveComposerModelReasoningDefault({ provider: 'pi', modelId, reasoningOptions })
    ).toBe('high')
  })

  it('preserves an enabled model-projected default and otherwise falls back to the first stop', () => {
    expect(
      resolveComposerModelReasoningDefault({
        provider: 'mistral',
        modelId: 'model',
        modelDefaultReasoningEffort: 'high',
        reasoningOptions: [{ value: 'off' }, { value: 'high' }]
      })
    ).toBe('high')
    expect(
      resolveComposerModelReasoningDefault({
        provider: 'mistral',
        modelId: 'model',
        modelDefaultReasoningEffort: 'unsupported',
        reasoningOptions: [{ value: 'off' }, { value: 'high' }]
      })
    ).toBe('off')
  })
})

describe('acceptedProviderReasoningEfforts', () => {
  it('accepts the Off rung the pickers seed onto an empty ladder', () => {
    // Mistral/Cursor/Ollama/Grok/Devin rows without thinking tiers get an
    // explicit Off bottom stop beside the injected UltraTask, so Off is
    // genuinely pickable. Rejecting it on read-back is what snapped the
    // slider to the provider default.
    const accepted = acceptedProviderReasoningEfforts({
      reasoningOptions: [],
      ultraTaskSupported: true
    })
    expect(accepted.has('off')).toBe(true)
    expect(accepted.has('ultraTask')).toBe(true)
  })

  it('does not invent an Off rung on a model that never offers one', () => {
    const accepted = acceptedProviderReasoningEfforts({
      reasoningOptions: [{ value: 'low' }, { value: 'high' }],
      ultraTaskSupported: true
    })
    expect(accepted.has('off')).toBe(false)
    expect([...accepted].sort()).toEqual(['high', 'low', 'ultraTask'])
  })

  it('does not seed Off when the model cannot take UltraTask either', () => {
    // No injection happens on this row, so there is no Off stop to accept.
    const accepted = acceptedProviderReasoningEfforts({
      reasoningOptions: [],
      ultraTaskSupported: false
    })
    expect(accepted.has('off')).toBe(false)
  })

  it('prefers the model capability list over the rendered options, minus disabled', () => {
    const accepted = acceptedProviderReasoningEfforts({
      reasoningOptions: [{ value: 'ignored' }],
      supportedReasoningEfforts: [
        { reasoningEffort: 'medium' },
        { reasoningEffort: 'blocked', disabled: true }
      ],
      ultraTaskSupported: true
    })
    expect([...accepted].sort()).toEqual(['medium', 'ultraTask'])
  })
})
