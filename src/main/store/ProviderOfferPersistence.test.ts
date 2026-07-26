import { describe, expect, it, vi } from 'vitest'
import { coerceProviderForPersistence } from './ProviderOfferPersistence'

describe('coerceProviderForPersistence', () => {
  const walled = {
    antigravityEnabled: false,
    antigravityOptInAcceptedAt: null
  }

  it('retains every static provider independently of run-management maturity', () => {
    for (const provider of ['codex', 'claude', 'kimi', 'cursor', 'grok', 'ollama', 'pi'] as const) {
      expect(coerceProviderForPersistence(provider, walled, () => false)).toBe(provider)
    }
  })

  it('retains AntiGravity through either independent admission lane', () => {
    expect(coerceProviderForPersistence('antigravity', walled, () => true)).toBe('antigravity')
    expect(
      coerceProviderForPersistence(
        'antigravity',
        {
          antigravityEnabled: true,
          antigravityOptInAcceptedAt: 1_700_000_000_000
        },
        () => false
      )
    ).toBe('antigravity')
  })

  it('fails closed for walled AntiGravity and historical Gemini', () => {
    const keyProbe = vi.fn(() => false)
    expect(coerceProviderForPersistence('antigravity', walled, keyProbe)).toBe('claude')
    expect(coerceProviderForPersistence('gemini', walled, keyProbe)).toBe('claude')
  })
})
