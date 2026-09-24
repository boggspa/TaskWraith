import { describe, expect, it } from 'vitest'
import {
  hasApiUsageBillingProvider,
  nextMonthlyResetAt,
  normalizeApiUsageBillingSettings
} from './apiUsageBilling'

describe('normalizeApiUsageBillingSettings', () => {
  it('keeps bounded display-only readings and canonicalizes dates and currencies', () => {
    const normalized = normalizeApiUsageBillingSettings({
      deepseek: { totalTopUp: '10', monthlyBudgetUsd: 25, apiKey: 'must-not-survive' },
      cerebras: {
        purchasedCredits: 20,
        currentBalance: '6.5',
        currency: 'gbp',
        monthlyBudgetUsd: 40
      },
      meta: {
        preloadCredits: 15,
        remainingBalance: 14.95,
        paymentThreshold: 20,
        spent: 0.05,
        currency: 'eur',
        resetAt: '2026-09-01',
        planName: '  API   Credits  ',
        monthlyBudgetUsd: 15,
        anchorUpdatedAt: '2026-08-15T12:00:00Z',
        accessToken: 'must-not-survive'
      }
    })

    expect(normalized).toEqual({
      deepseek: { totalTopUp: 10, monthlyBudgetUsd: 25 },
      cerebras: {
        purchasedCredits: 20,
        currentBalance: 6.5,
        currency: 'GBP',
        monthlyBudgetUsd: 40
      },
      meta: {
        preloadCredits: 15,
        remainingBalance: 14.95,
        paymentThreshold: 20,
        spent: 0.05,
        currency: 'EUR',
        resetAt: '2026-09-01T00:00:00.000Z',
        planName: 'API Credits',
        monthlyBudgetUsd: 15,
        anchorUpdatedAt: '2026-08-15T12:00:00.000Z'
      }
    })
    expect(JSON.stringify(normalized)).not.toContain('must-not-survive')
  })

  it('drops invalid, negative, unbounded and empty readings', () => {
    expect(
      normalizeApiUsageBillingSettings({
        deepseek: { totalTopUp: 0, monthlyBudgetUsd: 1_000_001 },
        cerebras: { purchasedCredits: -1, currentBalance: Infinity, currency: 'BTC' },
        meta: {
          preloadCredits: 0,
          remainingBalance: -1,
          spent: NaN,
          resetAt: 'later',
          planName: '\u0000hidden'
        }
      })
    ).toBeUndefined()
    expect(normalizeApiUsageBillingSettings(null)).toBeUndefined()
  })
})

describe('hasApiUsageBillingProvider', () => {
  it('reports only providers with a retained reading', () => {
    const settings = normalizeApiUsageBillingSettings({ meta: { spent: 0 } })
    expect(hasApiUsageBillingProvider(settings, 'meta')).toBe(true)
    expect(hasApiUsageBillingProvider(settings, 'deepseek')).toBe(false)
  })
})

describe('normalizeApiUsageBillingSettings custom reset dates', () => {
  it('round-trips deepseek/cerebras resetAt and the openrouter block, discarding unknown keys', () => {
    const normalized = normalizeApiUsageBillingSettings({
      deepseek: { resetAt: '2026-09-15' },
      cerebras: { purchasedCredits: 20, currentBalance: 6.5, resetAt: '2026-09-20' },
      openrouter: {
        monthlyBudgetUsd: 20,
        currency: 'eur',
        resetAt: '2026-09-01',
        apiKey: 'must-not-survive'
      }
    })

    expect(normalized).toEqual({
      deepseek: { resetAt: '2026-09-15T00:00:00.000Z' },
      cerebras: { purchasedCredits: 20, currentBalance: 6.5, resetAt: '2026-09-20T00:00:00.000Z' },
      openrouter: {
        monthlyBudgetUsd: 20,
        currency: 'EUR',
        resetAt: '2026-09-01T00:00:00.000Z'
      }
    })
    // Settings-injection boundary: smuggled keys must not survive normalization.
    expect(JSON.stringify(normalized)).not.toContain('must-not-survive')
  })

  it('drops invalid openrouter readings entirely', () => {
    expect(
      normalizeApiUsageBillingSettings({
        openrouter: { monthlyBudgetUsd: 0, currency: 'BTC', resetAt: 'soon' }
      })
    ).toBeUndefined()
    expect(
      normalizeApiUsageBillingSettings({
        openrouter: { monthlyBudgetUsd: 1_000_001 }
      })
    ).toBeUndefined()
  })

  it('drops invalid deepseek/cerebras reset dates but keeps the rest', () => {
    expect(
      normalizeApiUsageBillingSettings({
        deepseek: { totalTopUp: 10, resetAt: 'next month' },
        cerebras: { purchasedCredits: 20, currentBalance: 6.5, resetAt: '' }
      })
    ).toEqual({
      deepseek: { totalTopUp: 10 },
      cerebras: { purchasedCredits: 20, currentBalance: 6.5 }
    })
  })
})

describe('nextMonthlyResetAt', () => {
  it('returns undefined for an absent or invalid anchor', () => {
    expect(nextMonthlyResetAt(undefined, new Date('2026-09-03T00:00:00.000Z'))).toBeUndefined()
    expect(nextMonthlyResetAt('garbage', new Date('2026-09-03T00:00:00.000Z'))).toBeUndefined()
    expect(nextMonthlyResetAt('', new Date('2026-09-03T00:00:00.000Z'))).toBeUndefined()
  })

  it('returns an anchor in the future unchanged', () => {
    expect(nextMonthlyResetAt('2026-12-15T00:00:00.000Z', new Date('2026-09-03T00:00:00.000Z'))).toBe(
      '2026-12-15T00:00:00.000Z'
    )
  })

  it('rolls a past anchor forward whole months to strictly after now', () => {
    expect(nextMonthlyResetAt('2026-01-15T00:00:00.000Z', new Date('2026-09-03T00:00:00.000Z'))).toBe(
      '2026-09-15T00:00:00.000Z'
    )
  })

  it('rolls a multi-year-stale anchor forward to the current cycle', () => {
    expect(nextMonthlyResetAt('2020-06-15T00:00:00.000Z', new Date('2026-09-03T00:00:00.000Z'))).toBe(
      '2026-09-15T00:00:00.000Z'
    )
  })

  it('clamps Jan 31 to Feb 28 in a common year and Feb 29 in a leap year', () => {
    expect(nextMonthlyResetAt('2025-01-31T00:00:00.000Z', new Date('2025-02-01T00:00:00.000Z'))).toBe(
      '2025-02-28T00:00:00.000Z'
    )
    expect(nextMonthlyResetAt('2024-01-31T00:00:00.000Z', new Date('2024-02-01T00:00:00.000Z'))).toBe(
      '2024-02-29T00:00:00.000Z'
    )
  })

  it('restores the anchor day after a clamped short month', () => {
    // Jan 31 anchor: February clamps to 28, but March must return to 31.
    expect(nextMonthlyResetAt('2025-01-31T00:00:00.000Z', new Date('2025-03-01T00:00:00.000Z'))).toBe(
      '2025-03-31T00:00:00.000Z'
    )
  })

  it('rolls December anchors into January of the next year', () => {
    expect(nextMonthlyResetAt('2025-12-10T00:00:00.000Z', new Date('2025-12-15T00:00:00.000Z'))).toBe(
      '2026-01-10T00:00:00.000Z'
    )
  })

  it('rolls an anchor exactly equal to now to the next month', () => {
    expect(nextMonthlyResetAt('2026-09-03T10:00:00.000Z', new Date('2026-09-03T10:00:00.000Z'))).toBe(
      '2026-10-03T10:00:00.000Z'
    )
  })

  it('preserves the anchor time-of-day when rolling forward', () => {
    expect(nextMonthlyResetAt('2026-08-20T13:30:45.123Z', new Date('2026-09-01T00:00:00.000Z'))).toBe(
      '2026-09-20T13:30:45.123Z'
    )
  })
})
