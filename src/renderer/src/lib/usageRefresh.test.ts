import { describe, expect, it } from 'vitest'

import {
  fingerprintUsageSummary,
  hasUsageSummaryChanged,
  shouldLoadUsageRecords,
  shouldRunUsageRefresh
} from './usageRefresh'

describe('fingerprintUsageSummary', () => {
  it('produces equal fingerprints for structurally equal payloads', () => {
    const a = [
      {
        provider: 'gemini' as const,
        model: 'usage limits',
        windows: [
          {
            id: 'gemini-pro',
            label: 'Pro 3.1 (preview)',
            limitLabel: '42% remaining',
            resetAt: '2026-05-16T22:00:00.000Z',
            usedPercent: 58,
            remainingPercent: 42
          }
        ]
      }
    ]
    const b = [
      {
        provider: 'gemini' as const,
        model: 'usage limits',
        windows: [
          {
            id: 'gemini-pro',
            label: 'Pro 3.1 (preview)',
            limitLabel: '42% remaining',
            resetAt: '2026-05-16T22:00:00.000Z',
            usedPercent: 58,
            remainingPercent: 42
          }
        ]
      }
    ]
    expect(fingerprintUsageSummary(a)).toBe(fingerprintUsageSummary(b))
    expect(hasUsageSummaryChanged(a, b)).toBe(false)
  })

  it('detects meter changes via remainingPercent', () => {
    const prev = [
      {
        provider: 'claude' as const,
        model: 'usage limits',
        windows: [
          {
            id: 'claude-5h',
            label: 'Session',
            limitLabel: '70% remaining',
            usedPercent: 30,
            remainingPercent: 70
          }
        ]
      }
    ]
    const next = [
      {
        provider: 'claude' as const,
        model: 'usage limits',
        windows: [
          {
            id: 'claude-5h',
            label: 'Session',
            limitLabel: '65% remaining',
            usedPercent: 35,
            remainingPercent: 65
          }
        ]
      }
    ]
    expect(hasUsageSummaryChanged(prev, next)).toBe(true)
  })

  it('treats missing resetAt and undefined percent as a single canonical form', () => {
    const a = [
      {
        provider: 'kimi' as const,
        model: 'usage limits',
        windows: [{ id: 'kimi-5h', label: '5H', limitLabel: '100% remaining' }]
      }
    ]
    const b = [
      {
        provider: 'kimi' as const,
        model: 'usage limits',
        windows: [
          {
            id: 'kimi-5h',
            label: '5H',
            limitLabel: '100% remaining',
            resetAt: undefined,
            usedPercent: undefined,
            remainingPercent: undefined
          }
        ]
      }
    ]
    expect(hasUsageSummaryChanged(a, b)).toBe(false)
  })

  it('ignores fetch-only timestamps but detects rendered telemetry changes', () => {
    const prev = [
      {
        provider: 'cursor' as const,
        model: 'usage limits',
        quotaFetchedAt: '2026-07-17T12:00:00.000Z',
        balances: [{ id: 'spend', label: 'On-Demand Spend', amount: 8, unit: 'USD' }]
      }
    ]
    const timestampOnly = [
      {
        ...prev[0],
        quotaFetchedAt: '2026-07-17T12:01:30.000Z'
      }
    ]
    const changedBalance = [
      {
        ...timestampOnly[0],
        balances: [{ id: 'spend', label: 'On-Demand Spend', amount: 9, unit: 'USD' }]
      }
    ]

    expect(hasUsageSummaryChanged(prev, timestampOnly)).toBe(false)
    expect(hasUsageSummaryChanged(prev, changedBalance)).toBe(true)
  })
})

describe('shouldLoadUsageRecords', () => {
  it('skips the historical record sweep for an initialized quota heartbeat', () => {
    expect(shouldLoadUsageRecords({ quotaOnly: true, recordsInitialized: true })).toBe(false)
  })

  it('hydrates records before the first quota-only refresh can reuse aggregates', () => {
    expect(shouldLoadUsageRecords({ quotaOnly: true, recordsInitialized: false })).toBe(true)
  })

  it('loads records for normal refreshes after initialization', () => {
    expect(shouldLoadUsageRecords({ quotaOnly: false, recordsInitialized: true })).toBe(true)
  })
})

describe('shouldRunUsageRefresh', () => {
  const base = {
    msSinceLastRefresh: 90_000,
    intervalMs: 90_000,
    inFlight: false,
    windowFocused: true,
    online: true
  }

  it('allows refresh on the standard heartbeat', () => {
    expect(shouldRunUsageRefresh(base)).toBe(true)
  })

  it('skips when a previous refresh is in flight', () => {
    expect(shouldRunUsageRefresh({ ...base, inFlight: true })).toBe(false)
  })

  it('skips when the window is not focused', () => {
    expect(shouldRunUsageRefresh({ ...base, windowFocused: false })).toBe(false)
  })

  it('skips when offline', () => {
    expect(shouldRunUsageRefresh({ ...base, online: false })).toBe(false)
  })

  it('allows initial refresh when no prior run is recorded', () => {
    expect(shouldRunUsageRefresh({ ...base, msSinceLastRefresh: null })).toBe(true)
  })

  it('debounces back-to-back fires (e.g. focus-resume right after a heartbeat)', () => {
    expect(shouldRunUsageRefresh({ ...base, msSinceLastRefresh: 500 })).toBe(false)
  })

  it('lets a focus-resume win after the debounce window passes', () => {
    expect(shouldRunUsageRefresh({ ...base, msSinceLastRefresh: 6_000 })).toBe(true)
  })
})
