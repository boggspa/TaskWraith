import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ensembleRoundDispatchRefusal } from './ensembleRoundDispatchReceipt'

describe('ensembleRoundDispatchRefusal', () => {
  it('accepts every status that proves main retained the request', () => {
    expect(ensembleRoundDispatchRefusal({ status: 'started' })).toBeNull()
    expect(ensembleRoundDispatchRefusal({ status: 'queued' })).toBeNull()
    expect(ensembleRoundDispatchRefusal({ status: 'steered' })).toBeNull()
  })

  it('refuses the statuses that resolve rather than throw', () => {
    expect(ensembleRoundDispatchRefusal({ status: 'ignored' })?.reason).toBe('ignored')
    expect(ensembleRoundDispatchRefusal({ status: 'busy' })?.reason).toBe('busy')
  })

  it('refuses a missing receipt, which is what a null orchestrator resolves', () => {
    // ensembleRoundHandlers optional-chains the orchestrator, so a missing one
    // resolves the whole IPC call to undefined AND skips the durability
    // barrier. That must not read as a successful send.
    expect(ensembleRoundDispatchRefusal(undefined)?.reason).toBe('no-receipt')
    expect(ensembleRoundDispatchRefusal(null)?.reason).toBe('no-receipt')
    expect(ensembleRoundDispatchRefusal({})?.reason).toBe('no-receipt')
  })

  it('always carries operator-facing text, including for an unknown status', () => {
    const refusal = ensembleRoundDispatchRefusal({ status: 'brand-new-status' })
    expect(refusal?.reason).toBe('brand-new-status')
    expect(refusal?.message).toContain('brand-new-status')
    for (const status of ['ignored', 'busy']) {
      expect(ensembleRoundDispatchRefusal({ status })?.message.length).toBeGreaterThan(0)
    }
  })
})

describe('a cause-specific refusal reason from main reaches the surface', () => {
  // Main knows WHY it refused -- not-owned, rolled-over, append-unavailable --
  // but the receipt type had no channel for it, so every refusal rendered as
  // the same generic sentence. The canonical case is the orchestrator's
  // 'No active Ensemble round' for a round the user can watch running: text
  // that names the wrong cause is worse than text that names none.
  it('prefers the reason main sent over the canned message', () => {
    const refusal = ensembleRoundDispatchRefusal({
      status: 'ignored',
      error: 'That round rolled over while the message was in flight.'
    })
    expect(refusal?.reason).toBe('ignored')
    expect(refusal?.message).toBe('That round rolled over while the message was in flight.')
  })

  it('prefers it over the unknown-status fallback too', () => {
    expect(
      ensembleRoundDispatchRefusal({ status: 'brand-new-status', error: 'Seat is not accepting.' })
        ?.message
    ).toBe('Seat is not accepting.')
  })

  it('falls back to the canned message when the reason is absent or blank', () => {
    expect(ensembleRoundDispatchRefusal({ status: 'busy', error: '   ' })?.message).toBe(
      'Ensemble is still finishing another round.'
    )
    expect(
      ensembleRoundDispatchRefusal({ status: 'busy', error: 42 as unknown as string })?.message
    ).toBe('Ensemble is still finishing another round.')
    expect(ensembleRoundDispatchRefusal({ status: 'busy' })?.message).toBe(
      'Ensemble is still finishing another round.'
    )
  })

  it('never turns an accepted send into a refusal because a reason rode along', () => {
    expect(ensembleRoundDispatchRefusal({ status: 'steered', error: 'stale' })).toBeNull()
    expect(ensembleRoundDispatchRefusal({ status: 'queued', error: 'stale' })).toBeNull()
  })
})

describe('the ensemble send call site consumes the dispatch receipt', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const MARKER = 'await window.api.runEnsembleRound('

  function sendSiteSlice(): string {
    const start = app.indexOf(MARKER)
    // Positive anchor: a moved marker must fail loudly here rather than
    // silently yielding '' and passing every negative assertion below.
    expect(start).toBeGreaterThanOrEqual(0)
    // Reach back far enough to capture the binding the call is assigned to.
    const slice = app.slice(Math.max(0, start - 200), start + 4000)
    expect(slice.length).toBeGreaterThan(1000)
    return slice
  }

  it('assigns the receipt instead of awaiting it for its side effects', () => {
    expect(sendSiteSlice()).toContain('= await window.api.runEnsembleRound(')
  })

  it('routes the receipt through the extracted refusal classifier', () => {
    expect(sendSiteSlice()).toContain('ensembleRoundDispatchRefusal(')
  })

  it('imports the classifier from its module', () => {
    expect(app).toMatch(
      /ensembleRoundDispatchRefusal[^\n]*from '\.\/lib\/ensembleRoundDispatchReceipt'/
    )
  })
})
