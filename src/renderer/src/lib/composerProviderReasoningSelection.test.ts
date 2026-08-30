import { describe, expect, it } from 'vitest'
import { resolvePiReasoningSupport } from '../../../shared/piReasoning'
import { resolveComposerModelReasoningDefault } from './composerProviderReasoningSelection'

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
