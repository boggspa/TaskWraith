import { describe, expect, it } from 'vitest'
import {
  applyRememberedOllamaCliSignIn,
  nextOllamaCliSignInRecord,
  normalizeOllamaCliSignIn,
  shouldApplyRememberedOllamaCliSignIn,
  type OllamaCliSignInRecord
} from './OllamaCliSignInMemory'

const NOW = '2026-08-29T00:00:00.000Z'
const EARLIER = '2026-08-01T00:00:00.000Z'

const signedIn = (plan?: string): OllamaCliSignInRecord =>
  normalizeOllamaCliSignIn({ signedIn: true, plan, updatedAt: EARLIER })!

describe('normalizeOllamaCliSignIn', () => {
  it('reads a persisted record back', () => {
    expect(normalizeOllamaCliSignIn({ signedIn: true, plan: 'pro', updatedAt: EARLIER })).toEqual({
      signedIn: true,
      plan: 'pro',
      updatedAt: EARLIER
    })
  })

  it('rejects anything that is not a record', () => {
    expect(normalizeOllamaCliSignIn(null)).toBeNull()
    expect(normalizeOllamaCliSignIn('pro')).toBeNull()
    expect(normalizeOllamaCliSignIn({ plan: 'pro', updatedAt: EARLIER })).toBeNull()
    expect(normalizeOllamaCliSignIn({ signedIn: true })).toBeNull()
    expect(normalizeOllamaCliSignIn({ signedIn: true, updatedAt: 'whenever' })).toBeNull()
  })

  it('drops a plan from a signed-out record so it cannot resurface as one', () => {
    expect(normalizeOllamaCliSignIn({ signedIn: false, plan: 'pro', updatedAt: EARLIER })).toEqual({
      signedIn: false,
      updatedAt: EARLIER
    })
  })
})

describe('nextOllamaCliSignInRecord', () => {
  it('records the daemon saying yes', () => {
    expect(
      nextOllamaCliSignInRecord(null, { supported: true, authenticated: true, plan: 'pro' }, NOW)
    ).toEqual({ signedIn: true, plan: 'pro', updatedAt: NOW })
  })

  it('records the daemon saying no', () => {
    expect(
      nextOllamaCliSignInRecord(signedIn('pro'), { supported: true, authenticated: false }, NOW)
    ).toEqual({ signedIn: false, updatedAt: NOW })
  })

  // The whole point of the memory: an unreachable /api/me is not a sign-out.
  it('leaves the memory untouched when the account answer is unknown', () => {
    const previous = signedIn('pro')
    expect(nextOllamaCliSignInRecord(previous, { supported: true, authenticated: null }, NOW)).toBe(
      previous
    )
    expect(
      nextOllamaCliSignInRecord(previous, { supported: false, authenticated: null }, NOW)
    ).toBe(previous)
    expect(
      nextOllamaCliSignInRecord(null, { supported: false, authenticated: null }, NOW)
    ).toBeNull()
  })

  // A key authenticates the direct Cloud API without any CLI sign-in existing.
  it('never records a stored API key as a CLI sign-in', () => {
    expect(
      nextOllamaCliSignInRecord(
        null,
        { supported: true, authenticated: true, apiKeyConfigured: true },
        NOW
      )
    ).toBeNull()
    const previous = signedIn('pro')
    expect(
      nextOllamaCliSignInRecord(
        previous,
        { supported: true, authenticated: true, apiKeyConfigured: true },
        NOW
      )
    ).toBe(previous)
  })

  it('keeps the existing record when nothing changed', () => {
    const previous = signedIn('pro')
    expect(
      nextOllamaCliSignInRecord(
        previous,
        { supported: true, authenticated: true, plan: 'pro' },
        NOW
      )
    ).toBe(previous)
  })

  it('re-stamps when the daemon reports a different plan', () => {
    expect(
      nextOllamaCliSignInRecord(
        signedIn('pro'),
        { supported: true, authenticated: true, plan: 'max' },
        NOW
      )
    ).toEqual({ signedIn: true, plan: 'max', updatedAt: NOW })
  })

  it('keeps the remembered plan when a yes arrives without one', () => {
    expect(
      nextOllamaCliSignInRecord(signedIn('pro'), { supported: true, authenticated: true }, NOW)
    ).toEqual({ signedIn: true, plan: 'pro', updatedAt: EARLIER })
  })
})

describe('applyRememberedOllamaCliSignIn', () => {
  it('answers an unknown account from memory when the daemon is otherwise reachable', () => {
    expect(
      applyRememberedOllamaCliSignIn(
        { supported: true, enabled: true, authenticated: null, models: [] },
        signedIn('pro')
      )
    ).toEqual({
      supported: true,
      enabled: true,
      authenticated: true,
      plan: 'pro',
      models: [],
      authenticatedFromMemory: true
    })
  })

  // An unreachable daemon must not read as a live Cloud connection.
  it('leaves an unsupported snapshot alone', () => {
    const cloud = { supported: false, enabled: true, authenticated: null, models: [] }
    expect(applyRememberedOllamaCliSignIn(cloud, signedIn('pro'))).toBe(cloud)
  })

  it('never overrides a definitive live answer', () => {
    const signedOut = { supported: true, enabled: true, authenticated: false, models: [] }
    expect(applyRememberedOllamaCliSignIn(signedOut, signedIn('pro'))).toBe(signedOut)
  })

  it('does not invent a sign-in the memory never saw', () => {
    const unknown = { supported: true, enabled: true, authenticated: null, models: [] }
    expect(applyRememberedOllamaCliSignIn(unknown, null)).toBe(unknown)
    expect(
      applyRememberedOllamaCliSignIn(
        unknown,
        normalizeOllamaCliSignIn({ signedIn: false, updatedAt: EARLIER })
      )
    ).toBe(unknown)
  })

  it('prefers the live plan over the remembered one', () => {
    expect(
      applyRememberedOllamaCliSignIn(
        { supported: true, enabled: true, authenticated: null, plan: 'max', models: [] },
        signedIn('pro')
      )
    ).toMatchObject({ authenticated: true, plan: 'max' })
  })

  it('agrees with its own predicate', () => {
    expect(
      shouldApplyRememberedOllamaCliSignIn(
        { supported: true, authenticated: null },
        signedIn('pro')
      )
    ).toBe(true)
    expect(
      shouldApplyRememberedOllamaCliSignIn({ supported: true, authenticated: true }, signedIn())
    ).toBe(false)
  })
})
