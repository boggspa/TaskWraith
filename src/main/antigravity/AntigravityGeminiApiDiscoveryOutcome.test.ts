import { describe, expect, it } from 'vitest'
import {
  AntigravityGeminiApiDiscoveryOutcomeStore,
  MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT
} from './AntigravityGeminiApiDiscoveryOutcome'

function createStore(): AntigravityGeminiApiDiscoveryOutcomeStore {
  let tick = 0
  return new AntigravityGeminiApiDiscoveryOutcomeStore({
    now: () => new Date(Date.UTC(2026, 6, 24, 12, 0, tick++))
  })
}

describe('AntigravityGeminiApiDiscoveryOutcomeStore', () => {
  it('starts empty so the card says nothing before the first probe of this run', () => {
    expect(createStore().getLastOutcome()).toBeNull()
  })

  it('records a successful pass with its model count and a canonical timestamp', () => {
    const store = createStore()
    store.record('ok', 12)
    expect(store.getLastOutcome()).toEqual({
      status: 'ok',
      modelCount: 12,
      checkedAt: '2026-07-24T12:00:00.000Z'
    })
  })

  it('keeps only the latest outcome so a stale verdict cannot outlive a retry', () => {
    const store = createStore()
    store.record('unauthorized')
    store.record('ok', 3)
    expect(store.getLastOutcome()).toMatchObject({ status: 'ok', modelCount: 3 })

    store.record('rateLimited')
    expect(store.getLastOutcome()).toMatchObject({ status: 'rateLimited', modelCount: 0 })
  })

  it('refuses to let a failed status carry a model count', () => {
    // "Google rejected this key" and "9 models available" must never be able to
    // render together, whatever the caller passes.
    const store = createStore()
    for (const status of ['unauthorized', 'rateLimited', 'timedOut', 'empty'] as const) {
      store.record(status, 9)
      expect(store.getLastOutcome()?.modelCount).toBe(0)
    }
  })

  it('bounds and normalizes an implausible count', () => {
    const store = createStore()
    for (const [input, expected] of [
      [-1, 0],
      [0, 0],
      [1.5, 0],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
      [10_000, MAX_ANTIGRAVITY_GEMINI_API_OUTCOME_MODEL_COUNT]
    ] as const) {
      store.record('ok', input)
      expect(store.getLastOutcome()?.modelCount).toBe(expected)
    }
  })

  it('ignores an unrecognised status rather than recording it', () => {
    const store = createStore()
    store.record('ok', 4)
    store.record('somethingNew' as never, 1)
    expect(store.getLastOutcome()).toMatchObject({ status: 'ok', modelCount: 4 })
  })

  it('clears so a replaced key does not inherit the previous key’s verdict', () => {
    const store = createStore()
    store.record('unauthorized')
    store.clear()
    expect(store.getLastOutcome()).toBeNull()
  })

  it('records nothing that could carry secret material', () => {
    const store = createStore()
    store.record('ok', 5)
    expect(Object.keys(store.getLastOutcome() ?? {}).sort()).toEqual([
      'checkedAt',
      'modelCount',
      'status'
    ])
  })
})
