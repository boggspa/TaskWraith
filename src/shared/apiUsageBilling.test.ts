import { describe, expect, it } from 'vitest'
import { hasApiUsageBillingProvider, normalizeApiUsageBillingSettings } from './apiUsageBilling'

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
