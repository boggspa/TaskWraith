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

  it('fails closed for malformed, negative, and unbounded values', () => {
    expect(parseDeepSeekBalanceResponse({})).toBeNull()
    expect(
      parseDeepSeekBalanceResponse({
        is_available: true,
        balance_infos: [
          {
            currency: 'USD',
            total_balance: '-1',
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
})

describe('createTaskWraithQuotaSnapshotHook', () => {
  it('combines the official DeepSeek balance with TaskWraith-owned Cerebras and Meta estimates', async () => {
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
          }),
          expect.objectContaining({
            label: 'Estimated this month',
            valueText: '~$3.00'
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
        windows: [
          expect.objectContaining({ label: 'Estimated this month', valueText: '~$1.10' }),
          expect.objectContaining({ label: 'Estimated last 30 days', valueText: '~$1.10' })
        ]
      }),
      expect.objectContaining({
        provider: 'meta',
        planType: 'Muse local estimate',
        windows: [
          expect.objectContaining({
            label: 'Estimated this month',
            valueText: '~$5.50',
            usedPercent: expect.closeTo(36.6666667)
          }),
          expect.objectContaining({ label: 'Estimated last 30 days', valueText: '~$5.50' })
        ]
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

  it('surfaces a bounded retry reason when the first official balance read fails', async () => {
    const read = createTaskWraithQuotaSnapshotHook({
      loadPiKeys: () => ({ status: 'ok', keys: { deepseek: 'ds-secret' } }),
      getUsageRecords: () => [],
      getProviderRates: () => providerRates,
      getMuseConfigured: () => false,
      getMuseMonthlySpendCapUsd: () => undefined,
      fetchImpl: vi.fn(async () => response({ message: 'nope' }, 401)),
      now: () => NOW
    })

    await expect(read()).resolves.toEqual([
      expect.objectContaining({
        provider: 'deepseek',
        configured: true,
        windows: [],
        error: expect.stringContaining('retry automatically')
      }),
      expect.objectContaining({ provider: 'cerebras', configured: false }),
      expect.objectContaining({ provider: 'meta', configured: false })
    ])
  })
})
