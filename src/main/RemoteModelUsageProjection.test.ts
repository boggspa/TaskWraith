import { describe, expect, it } from 'vitest'
import type { UsageRecord } from './store/types'
import { projectRemoteModelUsageExtras } from './RemoteModelUsageProjection'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: 'usage-1',
    provider: 'antigravity',
    timestamp: NOW - 60_000,
    workspaceId: 'ws-1',
    chatId: 'chat-1',
    runId: 'run-1',
    model: 'gemini-api:gemini-2.5-flash',
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    totalTokens: 2_000_000,
    cacheReadInputTokens: 500_000,
    durationMs: 1_000,
    ...overrides
  }
}

const rates = {
  baseline: {
    antigravity: {
      models: [
        {
          modelId: 'gemini-api:gemini-2.5-flash',
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 10,
          cachedInputUsdPerMillion: 0.5
        }
      ]
    }
  }
}

describe('projectRemoteModelUsageExtras', () => {
  it('projects compact spend rows and the AntiGravity calendar-month budget', () => {
    const extras = projectRemoteModelUsageExtras({
      records: [record(), record({ id: 'reset', usageKind: 'reset_hint' })],
      settings: {
        currency: 'USD',
        antigravityGeminiApiMonthlySpendCapUsd: 10
      },
      providerRates: rates,
      fxRates: { rates: { USD: 1 } },
      now: NOW
    })

    const antigravity = extras.spend?.providers.find((entry) => entry.provider === 'antigravity')
    expect(antigravity?.windows).toEqual([
      { id: 'day', label: 'Day', totalTokens: 2_000_000, runs: 1, costText: '$7.25' },
      { id: 'week', label: '7d', totalTokens: 2_000_000, runs: 1, costText: '$7.25' },
      { id: 'month', label: '30d', totalTokens: 2_000_000, runs: 1, costText: '$7.25' }
    ])
    expect(extras.antigravityBudget).toMatchObject({
      provider: 'antigravity',
      spentText: '$7.25',
      capText: '$10.00',
      usedPercent: 73,
      resetAt: new Date(2026, 7, 1).toISOString()
    })
  })

  it('omits absent optional additions so old quota-only iOS clients keep their current view', () => {
    expect(
      projectRemoteModelUsageExtras({
        records: [record({ timestamp: NOW - 31 * 24 * 60 * 60 * 1000 })],
        settings: { currency: 'USD' },
        providerRates: rates,
        fxRates: { rates: { USD: 1 } },
        now: NOW
      })
    ).toEqual({})
  })

  it('projects Muse spend and the default $15 calendar-month budget once Muse has month spend', () => {
    const museRates = {
      baseline: {
        muse: {
          models: [
            {
              modelId: 'muse-spark-1.2',
              inputUsdPerMillion: 1.25,
              outputUsdPerMillion: 4.25,
              cachedInputUsdPerMillion: 0.15
            }
          ]
        }
      }
    }
    const extras = projectRemoteModelUsageExtras({
      records: [
        record({
          id: 'muse-1',
          provider: 'muse',
          model: 'muse-spark-1.2',
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          cacheReadInputTokens: 0
        })
      ],
      settings: { currency: 'USD' },
      providerRates: museRates,
      fxRates: { rates: { USD: 1 } },
      now: NOW
    })
    expect(extras.spend?.providers.some((entry) => entry.provider === 'muse')).toBe(true)
    expect(extras.museBudget).toMatchObject({
      provider: 'muse',
      spentText: '$1.25',
      capText: '$15.00',
      usedPercent: 8,
      resetAt: new Date(2026, 7, 1).toISOString()
    })
  })

  it('keeps ACU-billed Devin records as zero-cost spend rows instead of dropping the seat', () => {
    const extras = projectRemoteModelUsageExtras({
      records: [record({ id: 'devin-1', provider: 'devin', model: 'cli-default' })],
      settings: { currency: 'USD' },
      providerRates: rates,
      fxRates: { rates: { USD: 1 } },
      now: NOW
    })

    // Devin bills in ACUs, so there is no USD rate row and costText stays
    // unset — but the seat must still surface its token/run windows.
    const devin = extras.spend?.providers.find((entry) => entry.provider === 'devin')
    expect(devin?.windows).toEqual([
      { id: 'day', label: 'Day', totalTokens: 2_000_000, runs: 1 },
      { id: 'week', label: '7d', totalTokens: 2_000_000, runs: 1 },
      { id: 'month', label: '30d', totalTokens: 2_000_000, runs: 1 }
    ])
  })

  it('keeps Cursor Grok 4.6 standard and Fast projections on distinct rate rows', () => {
    const cursorRates = {
      baseline: {
        cursor: {
          models: [
            {
              modelId: 'grok-4.6',
              inputUsdPerMillion: 2,
              outputUsdPerMillion: 6,
              cachedInputUsdPerMillion: 0.5
            },
            {
              modelId: 'grok-4.6-fast',
              inputUsdPerMillion: 4,
              outputUsdPerMillion: 12,
              cachedInputUsdPerMillion: 1
            }
          ]
        }
      }
    }
    const extras = projectRemoteModelUsageExtras({
      records: [
        record({
          id: 'cursor-standard',
          provider: 'cursor',
          model: 'cursor-grok-4.6-high',
          inputTokens: 1_000_000,
          cacheReadInputTokens: 0,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000
        }),
        record({
          id: 'cursor-fast',
          provider: 'cursor',
          model: 'cursor-grok-4.6-high-fast',
          inputTokens: 1_000_000,
          cacheReadInputTokens: 0,
          outputTokens: 1_000_000,
          totalTokens: 2_000_000
        })
      ],
      settings: { currency: 'USD' },
      providerRates: cursorRates,
      fxRates: { rates: { USD: 1 } },
      now: NOW
    })

    const cursor = extras.spend?.providers.find((entry) => entry.provider === 'cursor')
    expect(cursor?.windows[0]).toEqual({
      id: 'day',
      label: 'Day',
      totalTokens: 4_000_000,
      runs: 2,
      costText: '$24.00'
    })
  })

  it('uses Grok 4.6 long-context rates for the entire request at 200k prompt tokens', () => {
    const grokRates = {
      baseline: {
        grok: {
          models: [
            {
              modelId: 'grok-4.6',
              inputUsdPerMillion: 2,
              outputUsdPerMillion: 6,
              cachedInputUsdPerMillion: 0.5,
              longContextThresholdTokens: 200_000,
              longContextInputUsdPerMillion: 4,
              longContextOutputUsdPerMillion: 12,
              longContextCachedInputUsdPerMillion: 1
            }
          ]
        }
      }
    }
    const extras = projectRemoteModelUsageExtras({
      records: [
        record({
          id: 'grok-long-context',
          provider: 'grok',
          model: 'grok-build',
          inputTokens: 100_000,
          cacheReadInputTokens: 50_000,
          cacheCreationInputTokens: 50_000,
          outputTokens: 1_000_000,
          totalTokens: 1_200_000
        })
      ],
      settings: { currency: 'USD' },
      providerRates: grokRates,
      fxRates: { rates: { USD: 1 } },
      now: NOW
    })

    const grok = extras.spend?.providers.find((entry) => entry.provider === 'grok')
    expect(grok?.windows[0].costText).toBe('$12.65')
  })
})
