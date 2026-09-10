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
