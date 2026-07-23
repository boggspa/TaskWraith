import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../store/types'
import { isAuthenticatedAntigravityConfiguredProvider } from './AntigravityConfiguredProvider'

const optedIn = { antigravityEnabled: true, antigravityOptInAcceptedAt: 1 }
const models = new Map<ProviderId, readonly { id: string; label: string }[]>([
  ['antigravity', [{ id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' }]]
])

describe('isAuthenticatedAntigravityConfiguredProvider', () => {
  it('requires consent, a completed configured snapshot, and a nonempty catalog', () => {
    expect(
      isAuthenticatedAntigravityConfiguredProvider(optedIn, {
        ready: true,
        configuredProviders: new Set(['antigravity'])
      }, models)
    ).toBe(true)

    expect(
      isAuthenticatedAntigravityConfiguredProvider({}, {
        ready: true,
        configuredProviders: new Set(['antigravity'])
      }, models)
    ).toBe(false)
    expect(
      isAuthenticatedAntigravityConfiguredProvider(optedIn, {
        ready: false,
        configuredProviders: new Set(['antigravity'])
      }, models)
    ).toBe(false)
    expect(
      isAuthenticatedAntigravityConfiguredProvider(optedIn, {
        ready: true,
        configuredProviders: new Set(['antigravity'])
      }, new Map())
    ).toBe(false)
  })
})
