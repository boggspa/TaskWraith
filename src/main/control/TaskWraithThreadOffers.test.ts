import { describe, expect, it } from 'vitest'

import {
  resolveTaskWraithThreadOffers,
  validateTaskWraithThreadSelection
} from './TaskWraithThreadOffers'

describe('TaskWraithThreadOffers', () => {
  it('projects a bounded curated catalogue and validates only projected ids', () => {
    const offers = resolveTaskWraithThreadOffers({
      threadId: 'thread-1',
      provider: 'codex',
      currentModel: 'gpt-5.6-sol',
      currentReasoningEffort: 'high'
    })

    expect(offers.threadId).toBe('thread-1')
    expect(offers.provider.runtimeProvider).toBe('codex')
    expect(offers.models.length).toBeGreaterThan(1)
    expect(offers.models.length).toBeLessThanOrEqual(40)
    expect(offers.models.find((offer) => offer.current)?.id).toBe('gpt-5.6-sol')

    const selectable = offers.models.find(
      (offer) => !offer.disabled && offer.reasoningEfforts.some((effort) => !effort.disabled)
    )!
    const effort = selectable.reasoningEfforts.find((candidate) => !candidate.disabled)!
    expect(
      validateTaskWraithThreadSelection(offers, {
        model: selectable.id,
        reasoningEffort: effort.id
      })
    ).toEqual({
      ok: true,
      value: { model: selectable.id, reasoningEffort: effort.id }
    })
    expect(validateTaskWraithThreadSelection(offers, { model: 'claude-opus-5' })).toEqual({
      ok: false,
      error: 'That model is not offered for this thread.'
    })
    expect(
      validateTaskWraithThreadSelection(offers, {
        model: selectable.id,
        reasoningEffort: 'invented-effort'
      })
    ).toEqual({
      ok: false,
      error: 'That reasoning effort is not offered for the selected model.'
    })
  })

  it('retains an off-catalogue current model without opening arbitrary nomination', () => {
    const offers = resolveTaskWraithThreadOffers({
      threadId: 'thread-custom',
      provider: 'claude',
      currentModel: 'claude-nightly-private',
      currentReasoningEffort: 'high'
    })

    expect(offers.models[0]).toMatchObject({
      id: 'claude-nightly-private',
      current: true,
      reasoningEfforts: [{ id: 'high', isDefault: true }]
    })
    expect(validateTaskWraithThreadSelection(offers, { model: 'claude-nightly-private' })).toEqual({
      ok: true,
      value: { model: 'claude-nightly-private' }
    })
  })

  it('locks ensemble and machine-dependent catalogues with an explicit reason', () => {
    const ensemble = resolveTaskWraithThreadOffers({
      threadId: 'thread-ensemble',
      provider: 'codex',
      ensemble: true
    })
    expect(ensemble.locked).toMatch(/Ensemble/)
    expect(validateTaskWraithThreadSelection(ensemble, { model: 'gpt-5.6-sol' })).toEqual({
      ok: false,
      error: ensemble.locked
    })

    const ollama = resolveTaskWraithThreadOffers({
      threadId: 'thread-ollama',
      provider: 'ollama'
    })
    expect(ollama.models).toEqual([])
    expect(ollama.locked).toMatch(/Ollama/)
  })
})
