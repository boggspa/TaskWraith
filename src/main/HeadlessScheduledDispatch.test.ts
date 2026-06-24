import { describe, it, expect } from 'vitest'
import { routeDueScheduledTask } from './HeadlessScheduledDispatch'

const ready = { rendererAvailable: false, headlessEnabled: true, composerReady: true }

describe('routeDueScheduledTask (Stage 0b-dispatch decision)', () => {
  it('broadcasts whenever a renderer is available (verified path wins)', () => {
    expect(routeDueScheduledTask({ kind: undefined }, { ...ready, rendererAvailable: true })).toBe(
      'broadcast'
    )
    // rendererAvailable beats every other flag — even an ensemble task or a
    // disabled kill-switch still routes to the renderer when one is up.
    expect(
      routeDueScheduledTask(
        { kind: 'ensemble' },
        { rendererAvailable: true, headlessEnabled: false, composerReady: false }
      )
    ).toBe('broadcast')
  })

  it('dispatches a SOLO task headless when windowless + enabled + composer ready', () => {
    expect(routeDueScheduledTask({ kind: undefined }, ready)).toBe('headless')
    expect(routeDueScheduledTask({ kind: 'single' }, ready)).toBe('headless')
  })

  it('defers when the headless kill-switch is off', () => {
    expect(routeDueScheduledTask({ kind: undefined }, { ...ready, headlessEnabled: false })).toBe(
      'defer'
    )
  })

  it('defers when the main-side composer is not yet wired', () => {
    expect(routeDueScheduledTask({ kind: undefined }, { ...ready, composerReady: false })).toBe(
      'defer'
    )
  })

  it('defers an ensemble occurrence (no headless orchestrator bridge yet)', () => {
    expect(routeDueScheduledTask({ kind: 'ensemble' }, ready)).toBe('defer')
  })

  it('a deferred task is the retry path — getDueScheduledTasks re-returns "due" each tick', () => {
    // Documents the invariant the module relies on: defer is safe ONLY because a
    // 'due' task is re-evaluated next tick. If composer becomes ready, the same
    // task then routes to 'headless'; if a window opens, to 'broadcast'.
    const ensemble = { kind: 'ensemble' as const }
    expect(routeDueScheduledTask(ensemble, ready)).toBe('defer')
    expect(routeDueScheduledTask(ensemble, { ...ready, rendererAvailable: true })).toBe('broadcast')
  })
})
