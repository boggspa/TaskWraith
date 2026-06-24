import { describe, it, expect } from 'vitest'
import { routeDueScheduledTask } from './HeadlessScheduledDispatch'

const ready = {
  rendererAvailable: false,
  headlessEnabled: true,
  soloDispatchReady: true,
  ensembleDispatchReady: true
}

describe('routeDueScheduledTask (Stage 0b-dispatch decision)', () => {
  it('broadcasts whenever a renderer is available (verified path wins)', () => {
    expect(routeDueScheduledTask({ kind: undefined }, { ...ready, rendererAvailable: true })).toBe(
      'broadcast'
    )
    // rendererAvailable beats every other flag — even an ensemble task, a disabled
    // kill-switch, or unwired dispatchers still route to the renderer when one is up.
    expect(
      routeDueScheduledTask(
        { kind: 'ensemble' },
        {
          rendererAvailable: true,
          headlessEnabled: false,
          soloDispatchReady: false,
          ensembleDispatchReady: false
        }
      )
    ).toBe('broadcast')
  })

  it('dispatches a SOLO task headless when windowless + enabled + solo dispatcher ready', () => {
    expect(routeDueScheduledTask({ kind: undefined }, ready)).toBe('headless')
    expect(routeDueScheduledTask({ kind: 'single' }, ready)).toBe('headless')
  })

  it('dispatches an ENSEMBLE task headless when the orchestrator is ready', () => {
    expect(routeDueScheduledTask({ kind: 'ensemble' }, ready)).toBe('headless')
  })

  it('defers when the headless kill-switch is off', () => {
    expect(routeDueScheduledTask({ kind: undefined }, { ...ready, headlessEnabled: false })).toBe(
      'defer'
    )
    expect(routeDueScheduledTask({ kind: 'ensemble' }, { ...ready, headlessEnabled: false })).toBe(
      'defer'
    )
  })

  it('defers a SOLO task when the solo dispatcher is not yet wired (but ensemble may still go)', () => {
    expect(routeDueScheduledTask({ kind: 'single' }, { ...ready, soloDispatchReady: false })).toBe(
      'defer'
    )
    // ensemble readiness is independent — an ensemble task still dispatches.
    expect(
      routeDueScheduledTask({ kind: 'ensemble' }, { ...ready, soloDispatchReady: false })
    ).toBe('headless')
  })

  it('defers an ENSEMBLE task when the orchestrator is not yet wired (but solo may still go)', () => {
    expect(
      routeDueScheduledTask({ kind: 'ensemble' }, { ...ready, ensembleDispatchReady: false })
    ).toBe('defer')
    expect(routeDueScheduledTask({ kind: 'single' }, { ...ready, ensembleDispatchReady: false })).toBe(
      'headless'
    )
  })

  it('a deferred task is the retry path — getDueScheduledTasks re-returns "due" each tick', () => {
    // Documents the invariant the module relies on: defer is safe ONLY because a
    // 'due' task is re-evaluated next tick. When its dispatcher becomes ready the
    // same task then routes to 'headless'; if a window opens, to 'broadcast'.
    const ensemble = { kind: 'ensemble' as const }
    expect(routeDueScheduledTask(ensemble, { ...ready, ensembleDispatchReady: false })).toBe('defer')
    expect(routeDueScheduledTask(ensemble, ready)).toBe('headless')
    expect(routeDueScheduledTask(ensemble, { ...ready, rendererAvailable: true })).toBe('broadcast')
  })
})
