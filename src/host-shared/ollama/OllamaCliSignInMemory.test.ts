import { describe, expect, it } from 'vitest'
import {
  applyRememberedOllamaCliSignIn,
  confirmOllamaSignOut,
  nextOllamaCliSignInRecord,
  normalizeOllamaCliSignIn,
  requiresOllamaSignOutConfirmation,
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

describe('sign-out confirmation', () => {
  it('asks for confirmation only when a 401 would overwrite a remembered sign-in', () => {
    expect(
      requiresOllamaSignOutConfirmation(signedIn('pro'), { supported: true, authenticated: false })
    ).toBe(true)
    expect(requiresOllamaSignOutConfirmation(null, { supported: true, authenticated: false })).toBe(
      false
    )
    expect(
      requiresOllamaSignOutConfirmation(
        normalizeOllamaCliSignIn({ signedIn: false, updatedAt: EARLIER }),
        {
          supported: true,
          authenticated: false
        }
      )
    ).toBe(false)
    expect(
      requiresOllamaSignOutConfirmation(signedIn('pro'), { supported: true, authenticated: true })
    ).toBe(false)
    expect(
      requiresOllamaSignOutConfirmation(signedIn('pro'), { supported: true, authenticated: null })
    ).toBe(false)
    // A key-authenticated observation never records a CLI state, so it never confirms one.
    expect(
      requiresOllamaSignOutConfirmation(signedIn('pro'), {
        supported: true,
        authenticated: false,
        apiKeyConfigured: true
      })
    ).toBe(false)
  })

  it('confirms only on a second definitive answer', () => {
    const first = { supported: true, authenticated: false as const }
    expect(confirmOllamaSignOut(first, { supported: true, authenticated: false })).toEqual({
      supported: true,
      authenticated: false
    })
    expect(
      confirmOllamaSignOut(first, { supported: true, authenticated: true, plan: 'max' })
    ).toEqual({
      supported: true,
      authenticated: true,
      plan: 'max'
    })
    expect(confirmOllamaSignOut(first, { supported: false, authenticated: null })).toEqual({
      supported: true,
      authenticated: null
    })
    expect(confirmOllamaSignOut(first, null)).toEqual({ supported: true, authenticated: null })
  })

  it('folds to the record it found when the re-probe did not confirm', () => {
    const previous = signedIn('pro')
    const unconfirmed = confirmOllamaSignOut({ supported: true, authenticated: false }, null)
    expect(nextOllamaCliSignInRecord(previous, unconfirmed, NOW)).toBe(previous)
    const confirmed = confirmOllamaSignOut(
      { supported: true, authenticated: false },
      { supported: true, authenticated: false }
    )
    expect(nextOllamaCliSignInRecord(previous, confirmed, NOW)).toEqual({
      signedIn: false,
      updatedAt: NOW
    })
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

  // An absent daemon refuses every request: none of the arms below may fire,
  // and the card keeps saying so rather than claiming a Cloud connection.
  it('leaves an unsupported snapshot alone when the daemon refused the probe', () => {
    const cloud = {
      supported: false,
      enabled: true,
      authenticated: null,
      accountProbe: 'refused' as const,
      models: []
    }
    expect(applyRememberedOllamaCliSignIn(cloud, signedIn('pro'))).toBe(cloud)
    expect(
      applyRememberedOllamaCliSignIn(cloud, signedIn('pro'), {
        localReachable: false,
        timedOut: false
      })
    ).toBe(cloud)
  })

  // The relaunch window: `/api/tags` answered, so the daemon is provably up,
  // and the account probe was cut off or refused mid-stall rather than answered.
  it('answers from memory when the daemon served its model list but no cloud endpoint', () => {
    const cloud = {
      supported: false,
      enabled: true,
      authenticated: null,
      accountProbe: 'refused' as const,
      models: []
    }
    expect(
      applyRememberedOllamaCliSignIn(cloud, signedIn('pro'), { localReachable: true })
    ).toEqual({ ...cloud, authenticated: true, plan: 'pro', authenticatedFromMemory: true })
  })

  it('answers from memory when its own deadline cut the probe off', () => {
    const timedOutAccount = {
      supported: false,
      enabled: true,
      authenticated: null,
      accountProbe: 'timed-out' as const,
      models: []
    }
    expect(applyRememberedOllamaCliSignIn(timedOutAccount, signedIn('pro'))).toMatchObject({
      authenticated: true,
      authenticatedFromMemory: true
    })
    const timedOutList = { supported: false, enabled: true, authenticated: null, models: [] }
    expect(
      applyRememberedOllamaCliSignIn(timedOutList, signedIn('pro'), { timedOut: true })
    ).toMatchObject({ authenticated: true, authenticatedFromMemory: true })
  })

  // An older daemon answers 404 on /api/me: present and reachable, but it has
  // no account state to stand in for — that stays honestly unsupported.
  it('does not read a daemon that answered without a sign-in state as signed in', () => {
    const answered = {
      supported: false,
      enabled: true,
      authenticated: null,
      accountProbe: 'answered' as const,
      models: []
    }
    expect(
      applyRememberedOllamaCliSignIn(answered, signedIn('pro'), { localReachable: true })
    ).toBe(answered)
  })

  it('never leaks the probe context into the repaired snapshot', () => {
    const repaired = applyRememberedOllamaCliSignIn(
      { supported: false, enabled: true, authenticated: null, models: [] },
      signedIn('pro'),
      { localReachable: true, timedOut: true }
    )
    expect(repaired.authenticated).toBe(true)
    expect(repaired).not.toHaveProperty('localReachable')
    expect(repaired).not.toHaveProperty('timedOut')
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
