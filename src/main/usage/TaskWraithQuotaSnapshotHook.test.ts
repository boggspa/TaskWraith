import { describe, expect, it, vi } from 'vitest'
import type { UsageRecord } from '../store/types'
import {
  createTaskWraithQuotaSnapshotHook,
  parseDeepSeekBalanceResponse
} from './TaskWraithQuotaSnapshotHook'

const NOW = Date.parse('2026-08-13T12:00:00.000Z')
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function response(value: unknown, status = 200): Response {
  const text = JSON.stringify(value)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-length' ? `${text.length}` : null)
    },
    text: async () => text
  } as unknown as Response
}

function deepSeekBalance(total = '9.08'): unknown {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: 'CNY',
        total_balance: '70',
        granted_balance: '0',
        topped_up_balance: '70'
      },
      {
        currency: 'USD',
        total_balance: total,
        granted_balance: '1.25',
        topped_up_balance: '7.83'
      }
    ]
  }
}

function usage(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: 'usage-1',
    provider: 'pi',
    timestamp: NOW - 1_000,
    workspaceId: 'workspace-1',
    chatId: 'chat-1',
    runId: 'run-1',
    usageKind: 'run',
    model: 'deepseek/deepseek-v4-pro',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    durationMs: 1_000,
    ...overrides
  }
}

const providerRates = {
  baseline: {
    pi: {
      models: [
        {
          modelId: 'deepseek/deepseek-v4-pro',
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2,
          cachedInputUsdPerMillion: 0.1
        },
        {
          modelId: 'cerebras/gpt-oss-120b',
          inputUsdPerMillion: 0.35,
          outputUsdPerMillion: 0.75,
          cachedInputUsdPerMillion: 0.35
        }
      ]
    },
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

describe('parseDeepSeekBalanceResponse', () => {
  it('prefers the USD balance and parses the documented string amounts', () => {
    expect(parseDeepSeekBalanceResponse(deepSeekBalance())).toEqual({
      isAvailable: true,
      currency: 'USD',
      totalBalance: 9.08,
      grantedBalance: 1.25,
      toppedUpBalance: 7.83
    })
  })

  it('fails closed for malformed and unbounded values', () => {
    expect(parseDeepSeekBalanceResponse({})).toBeNull()
    expect(
      parseDeepSeekBalanceResponse({
        is_available: true,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '1e100',
            granted_balance: '0',
            topped_up_balance: '0'
          }
        ]
      })
    ).toBeNull()
    expect(
      parseDeepSeekBalanceResponse({
        is_available: true,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '1e100',
            granted_balance: '0',
            topped_up_balance: '0'
          }
        ]
      })
    ).toBeNull()
  })

  it('preserves a bounded negative total balance for an overdrawn account', () => {
    expect(
      parseDeepSeekBalanceResponse({
        is_available: false,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '-0.03',
            granted_balance: '0',
            topped_up_balance: '0'
          }
        ]
      })
    ).toEqual({
      isAvailable: false,
      currency: 'USD',
      totalBalance: -0.03,
      grantedBalance: 0,
      toppedUpBalance: 0
    })

    // The vendor reading is preserved for every pool, matching
    // LLMUsageCounter's decoder: only unbounded magnitudes fail closed.
    expect(
      parseDeepSeekBalanceResponse({
        is_available: false,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '-0.03',
            granted_balance: '-0.01',
            topped_up_balance: '0'
          }
        ]
      })
    ).toEqual({
      isAvailable: false,
      currency: 'USD',
      totalBalance: -0.03,
      grantedBalance: -0.01,
      toppedUpBalance: 0
    })
  })

  it('defaults a missing is_available and reads null or omitted amounts as zero', () => {
    // Live payloads have shipped without `is_available` and with null pool
    // amounts; LLMUsageCounter's decoder tolerates both, and a whole reading
    // must not void because an unused pool is null.
    expect(
      parseDeepSeekBalanceResponse({
        balance_infos: [{ currency: 'USD', total_balance: '9.08', granted_balance: null }]
      })
    ).toEqual({
      isAvailable: true,
      currency: 'USD',
      totalBalance: 9.08,
      grantedBalance: 0,
      toppedUpBalance: 0
    })
    // A present but non-boolean availability flag still fails closed.
    expect(
      parseDeepSeekBalanceResponse({
        is_available: 'yes',
        balance_infos: [{ currency: 'USD', total_balance: '9.08' }]
      })
    ).toBeNull()
  })

  it('parses comma-grouped string amounts', () => {
    expect(
      parseDeepSeekBalanceResponse({
        is_available: true,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '1,234.56',
            granted_balance: 0,
            topped_up_balance: 1234
          }
        ]
      })
    ).toEqual({
      isAvailable: true,
      currency: 'USD',
      totalBalance: 1234.56,
      grantedBalance: 0,
      toppedUpBalance: 1234
    })
  })
})

describe('createTaskWraithQuotaSnapshotHook', () => {
  it('serves the official DeepSeek balance and anchor-less Cerebras/Meta lanes without estimate windows', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('GET')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ds-secret')
      return response(deepSeekBalance())
    })
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({
        status: 'ok',
        keys: { deepseek: 'ds-secret', cerebras: 'cerebras-secret' }
      }),
      getUsageRecords: () => [
        usage({}),
        usage({
          id: 'usage-2',
          model: 'cerebras/gpt-oss-120b'
        }),
        usage({
          id: 'usage-3',
          provider: 'muse',
          model: 'muse-spark-1.2'
        })
      ],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.79 } }),
      getApiUsageBilling: () => undefined,
      getMuseConfigured: () => true,
      getMuseMonthlySpendCapUsd: () => 15,
      fetchImpl,
      now: () => NOW
    })

    const snapshots = await read()

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.deepseek.com/user/balance',
      expect.objectContaining({ redirect: 'error' })
    )
    // The 'Estimated this month' / 'Estimated last 30 days' windows are
    // RETIRED (only official balances and Credit-used anchors meter now), so
    // an anchor-less lane shows its plan tag and no windows — never a
    // fabricated estimate bar.
    expect(snapshots).toEqual([
      expect.objectContaining({
        provider: 'deepseek',
        source: 'taskwraith-native',
        configured: true,
        windows: [
          expect.objectContaining({
            label: 'Available balance',
            valueText: '$9.08',
            limitLabel: expect.stringContaining('official DeepSeek balance API')
          })
        ],
        balances: [
          expect.objectContaining({ label: 'Total available', amount: 9.08, unit: 'USD' }),
          expect.objectContaining({ label: 'Prepaid remaining', amount: 7.83, unit: 'USD' }),
          expect.objectContaining({ label: 'Granted', amount: 1.25, unit: 'USD' })
        ]
      }),
      expect.objectContaining({
        provider: 'cerebras',
        planType: 'TaskWraith estimate',
        windows: []
      }),
      expect.objectContaining({
        provider: 'meta',
        planType: 'Muse local estimate',
        windows: []
      })
    ])
    expect(JSON.stringify(snapshots)).not.toContain('ds-secret')
    expect(JSON.stringify(snapshots)).not.toContain('cerebras-secret')
  })

  it('returns configured-false tombstones without touching the network when providers are absent', async () => {
    const fetchImpl = vi.fn()
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'missing' }),
      getUsageRecords: () => [],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.79 } }),
      getApiUsageBilling: () => undefined,
      getMuseConfigured: () => false,
      getMuseMonthlySpendCapUsd: () => undefined,
      fetchImpl,
      now: () => NOW
    })

    await expect(read()).resolves.toEqual([
      expect.objectContaining({ provider: 'deepseek', configured: false, windows: [] }),
      expect.objectContaining({ provider: 'cerebras', configured: false, windows: [] }),
      expect.objectContaining({ provider: 'meta', configured: false, windows: [] })
    ])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('combines manual API billing anchors with native balances and post-anchor Muse spend', async () => {
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({
        status: 'ok',
        keys: { deepseek: 'ds-secret', cerebras: 'cerebras-secret' }
      }),
      getUsageRecords: () => [
        usage({ id: 'cerebras-usage', model: 'cerebras/gpt-oss-120b' }),
        usage({ id: 'meta-usage', provider: 'muse', model: 'muse-spark-1.2' })
      ],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.8 } }),
      getApiUsageBilling: () => ({
        deepseek: { totalTopUp: 10, monthlyBudgetUsd: 20 },
        cerebras: {
          purchasedCredits: 20,
          currentBalance: 6.5,
          currency: 'GBP',
          monthlyBudgetUsd: 25
        },
        meta: {
          preloadCredits: 15,
          remainingBalance: 14.95,
          paymentThreshold: 20,
          spent: 0.05,
          currency: 'GBP',
          resetAt: '2026-09-01T00:00:00.000Z',
          anchorUpdatedAt: new Date(NOW - 2_000).toISOString()
        }
      }),
      getMuseConfigured: () => true,
      getMuseMonthlySpendCapUsd: () => 15,
      fetchImpl: vi.fn(async () => response(deepSeekBalance())),
      now: () => NOW
    })

    const snapshots = await read()
    expect(snapshots[0]).toEqual(
      expect.objectContaining({
        provider: 'deepseek',
        windows: [
          expect.objectContaining({
            label: 'Credit used',
            valueText: '$0.92',
            usedPercent: expect.closeTo(9.2)
          })
        ],
        balances: expect.arrayContaining([
          expect.objectContaining({ label: 'Total topped up', amount: 10 })
        ])
      })
    )
    // Credit-used is the ONLY meter each anchored lane keeps — the estimate
    // and 'Spend this billing period' companions are retired.
    expect(snapshots[1]).toEqual(
      expect.objectContaining({
        provider: 'cerebras',
        planType: 'Cloud billing anchor',
        windows: [
          expect.objectContaining({
            label: 'Credit used',
            valueText: '£13.50',
            usedPercent: 67.5
          })
        ]
      })
    )
    expect(snapshots[2]).toEqual(
      expect.objectContaining({
        provider: 'meta',
        planType: 'API Credits',
        windows: [expect.objectContaining({ label: 'Credit used', valueText: '£4.45' })],
        balances: expect.arrayContaining([
          expect.objectContaining({ label: 'Remaining balance', amount: 10.55, unit: 'GBP' })
        ])
      })
    )
  })

  it('fills DeepSeek credit usage against its soft budget when no top-up anchor exists', async () => {
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'ok', keys: { deepseek: 'ds-secret' } }),
      getUsageRecords: () => [],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.79 } }),
      getApiUsageBilling: () => ({ deepseek: { monthlyBudgetUsd: 10 } }),
      getMuseConfigured: () => false,
      getMuseMonthlySpendCapUsd: () => undefined,
      fetchImpl: vi.fn(async () => response(deepSeekBalance('0.79'))),
      now: () => NOW
    })

    const [deepseek] = await read()

    expect(deepseek).toEqual(
      expect.objectContaining({
        provider: 'deepseek',
        windows: [
          expect.objectContaining({
            label: 'Credit used',
            valueText: '$9.21',
            usedPercent: expect.closeTo(92.1),
            remainingPercent: expect.closeTo(7.9),
            limitLabel: expect.stringContaining('$9.21 of $10.00')
          })
        ]
      })
    )
    expect(deepseek?.balances).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Total topped up' })])
    )
  })

  it('keeps a bounded DeepSeek overage visible while capping the meter at 100%', async () => {
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'ok', keys: { deepseek: 'ds-secret' } }),
      getUsageRecords: () => [],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1 } }),
      getApiUsageBilling: () => ({ deepseek: { totalTopUp: 10 } }),
      getMuseConfigured: () => false,
      getMuseMonthlySpendCapUsd: () => undefined,
      fetchImpl: vi.fn(async () =>
        response({
          is_available: false,
          balance_infos: [
            {
              currency: 'USD',
              total_balance: '-0.03',
              granted_balance: '0',
              topped_up_balance: '0'
            }
          ]
        })
      ),
      now: () => NOW
    })

    const [deepseek] = await read()
    const [creditWindow] = deepseek?.windows ?? []

    expect(deepseek).toEqual(expect.objectContaining({ planType: 'Balance unavailable' }))
    expect(creditWindow).toEqual(
      expect.objectContaining({
        label: 'Credit used',
        valueText: '$10.03',
        limitLabel: expect.stringContaining('$10.03 of $10.00'),
        usedPercent: 100,
        remainingPercent: 0
      })
    )
    expect(deepseek?.balances).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Total available', amount: -0.03 })])
    )
  })

  it('keeps a threshold-only Meta anchor visible as a balance, never a spend meter', async () => {
    const now = Date.parse('2026-08-15T12:00:00.000Z')
    const hook = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'ok', keys: {} }),
      getUsageRecords: () => [
        usage({
          provider: 'muse',
          model: 'muse-spark-1.2',
          timestamp: now - 60_000,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000
        })
      ],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.8 } }),
      getApiUsageBilling: () => ({
        meta: {
          paymentThreshold: 20,
          currency: 'USD',
          anchorUpdatedAt: new Date(now - 120_000).toISOString()
        }
      }),
      getMuseConfigured: () => true,
      getMuseMonthlySpendCapUsd: () => null,
      now: () => now
    })

    const snapshots = await hook()
    // A threshold alone cannot form a Credit-used meter (that needs preload +
    // remaining), and the retired spend window must not resurrect for it. The
    // anchor stays visible as its balance row instead.
    expect(snapshots[2]).toEqual(
      expect.objectContaining({
        provider: 'meta',
        configured: true,
        windows: [],
        balances: [expect.objectContaining({ label: 'Payment threshold', amount: 20, unit: 'USD' })]
      })
    )
  })

  it('keeps a DeepSeek billing anchor visible when its encrypted API key is absent', async () => {
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'missing' }),
      getUsageRecords: () => [],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.79 } }),
      getApiUsageBilling: () => ({ deepseek: { totalTopUp: 10 } }),
      getMuseConfigured: () => false,
      getMuseMonthlySpendCapUsd: () => undefined,
      fetchImpl: vi.fn(),
      now: () => NOW
    })

    await expect(read()).resolves.toEqual([
      expect.objectContaining({
        provider: 'deepseek',
        configured: true,
        error: expect.stringContaining('DeepSeek key')
      }),
      expect.objectContaining({ provider: 'cerebras', configured: false }),
      expect.objectContaining({ provider: 'meta', configured: false })
    ])
  })

  it('joins concurrent balance reads and keeps the last official reading through a retry failure', async () => {
    let now = NOW
    let finish!: (value: Response) => void
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve
          })
      )
      .mockRejectedValueOnce(new Error('offline'))
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'ok', keys: { deepseek: 'ds-secret' } }),
      getUsageRecords: () => [],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.79 } }),
      getApiUsageBilling: () => undefined,
      getMuseConfigured: () => false,
      getMuseMonthlySpendCapUsd: () => undefined,
      fetchImpl,
      now: () => now,
      deepSeekCacheTtlMs: 30_000,
      deepSeekFailureRetryMs: 10_000
    })

    const first = read()
    const joined = read()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    finish(response(deepSeekBalance('4.20')))
    const [firstResult, joinedResult] = await Promise.all([first, joined])
    expect(firstResult[0]?.windows[0]?.valueText).toBe('$4.20')
    expect(joinedResult[0]?.windows[0]?.valueText).toBe('$4.20')

    now += 30_001
    const retryResult = await read()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(retryResult[0]?.windows[0]?.valueText).toBe('$4.20')
    expect(retryResult[0]?.fetchedAt).toBe(firstResult[0]?.fetchedAt)

    now += 9_999
    await read()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('names the specific failure instead of one generic retry sentence', async () => {
    // A rejected key, a rate limit, a server error, and an unreadable payload
    // are different user problems; collapsing them into "temporarily
    // unavailable" is how a mis-pasted key renders as a permanent silent
    // "No data". The copy mirrors LLMUsageCounter's status mapping.
    const readWith = (fetchImpl: FetchLike) =>
      createTaskWraithQuotaSnapshotHook({
        loadPiKeys: () => ({ status: 'ok', keys: { deepseek: 'ds-secret' } }),
        getUsageRecords: () => [],
        getProviderRates: () => providerRates,
        getFxRates: () => ({ rates: { USD: 1, EUR: 0.92, GBP: 0.79 } }),
        getApiUsageBilling: () => undefined,
        getMuseConfigured: () => false,
        getMuseMonthlySpendCapUsd: () => undefined,
        fetchImpl,
        now: () => NOW
      })

    const expectDeepSeekError = async (fetchImpl: FetchLike, error: string): Promise<void> => {
      await expect(readWith(fetchImpl)()).resolves.toEqual([
        expect.objectContaining({ provider: 'deepseek', configured: true, windows: [], error }),
        expect.objectContaining({ provider: 'cerebras', configured: false }),
        expect.objectContaining({ provider: 'meta', configured: false })
      ])
    }

    await expectDeepSeekError(
      vi.fn(async () => response({ message: 'nope' }, 401)),
      'DeepSeek rejected the API key. Update it in the Pi provider card.'
    )
    await expectDeepSeekError(
      vi.fn(async () => response({ message: 'slow down' }, 429)),
      'DeepSeek rate-limited the balance check. TaskWraith will retry automatically.'
    )
    await expectDeepSeekError(
      vi.fn(async () => response({ message: 'boom' }, 503)),
      'DeepSeek returned HTTP 503. TaskWraith will retry automatically.'
    )
    await expectDeepSeekError(
      vi.fn(async () => response({ unexpected: 'shape' })),
      'DeepSeek returned no readable balance.'
    )
    await expectDeepSeekError(
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
      'DeepSeek could not be reached. TaskWraith will retry automatically.'
    )
  })

  it('formats an overdrawn anchor-less balance with the sign ahead of the symbol', async () => {
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'ok', keys: { deepseek: 'ds-secret' } }),
      getUsageRecords: () => [],
      getProviderRates: () => providerRates,
      getFxRates: () => ({ rates: { USD: 1 } }),
      getApiUsageBilling: () => undefined,
      getMuseConfigured: () => false,
      getMuseMonthlySpendCapUsd: () => undefined,
      fetchImpl: vi.fn(async () =>
        response({
          is_available: false,
          balance_infos: [
            {
              currency: 'USD',
              total_balance: '-0.03',
              granted_balance: '0',
              topped_up_balance: '0'
            }
          ]
        })
      ),
      now: () => NOW
    })

    const [deepseek] = await read()

    expect(deepseek?.windows[0]).toEqual(
      expect.objectContaining({
        label: 'Available balance',
        valueText: '-$0.03',
        limitLabel: expect.stringContaining('-$0.03 · official DeepSeek balance API')
      })
    )
    expect(deepseek?.balances).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Total available', amount: -0.03 })])
    )
  })
})
