import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolvePiReasoningSupport } from '../../../shared/piReasoning'
import {
  acceptedProviderReasoningEfforts,
  acceptsStoredProviderReasoning,
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

describe('acceptsStoredProviderReasoning', () => {
  const claudeLadder = new Set(['low', 'medium', 'high'])

  it('accepts the active provider’s stored rung when its ladder offers it', () => {
    expect(acceptsStoredProviderReasoning('claude', 'claude', claudeLadder, 'high')).toBe(true)
  })

  it('still clamps the active provider’s stored rung when its ladder dropped it', () => {
    // The offer/accept clamp is correct HERE and must stay: this provider does
    // have a model selected, and the rung is genuinely no longer on its rail.
    expect(acceptsStoredProviderReasoning('claude', 'claude', claudeLadder, 'ultra')).toBe(false)
  })

  it('keeps another provider’s stored rung the active ladder has never heard of', () => {
    // Muse's Max judged against Claude's rail. A chat stores an effort per
    // provider but selects a model for one, so there is nothing here that can
    // say this value is wrong -- and answering anyway lost the user's pick.
    expect(acceptsStoredProviderReasoning('muse', 'claude', claudeLadder, 'max')).toBe(true)
  })

  it('keeps another provider’s rung even when it collides with a rejected one', () => {
    expect(acceptsStoredProviderReasoning('ollama', 'claude', claudeLadder, 'ultra')).toBe(true)
  })
})

/**
 * The renderer has no DOM test environment, so `getChatComposerSelection` is
 * fenced by its source shape. Every per-provider acceptance check in it must go
 * through the scoped predicate; a bare `providerReasoningEfforts.has(metadata.…)`
 * is the cross-provider clamp coming back, and nothing else would catch it --
 * it compiles, types and renders perfectly.
 */
describe('the composer read-back’s acceptance checks', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  it('scopes every stored per-provider effort to the active provider', () => {
    expect(app).not.toMatch(/providerReasoningEfforts\.has\(metadata\./)
    expect(app).not.toMatch(/enabledClaudeReasoningEfforts\.has\(metadata\./)
  })

  it('still checks one per provider, so a dropped call site is visible', () => {
    // Eight providers reach the shared predicate; Claude carries its own
    // accepted set and is scoped by a direct call, which is why it is counted
    // separately. Codex deliberately has no acceptance check at all.
    expect(app.match(/acceptsStoredReasoning\('/g) ?? []).toHaveLength(8)
    expect(app.match(/acceptsStoredProviderReasoning\(\n\s+'claude'/g) ?? []).toHaveLength(1)
  })
})
