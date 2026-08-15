import { describe, expect, it, vi } from 'vitest'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import {
  ANTIGRAVITY_QUOTA_REFRESH_INTERVALS_MS,
  createAntigravityQuotaClient
} from './AntigravityQuotaClient'

const NOW = Date.parse('2026-08-15T12:00:00.000Z')

function quotaSnapshot(remainingPercent = 42): NormalizedProviderUsageSnapshot {
  return {
    provider: 'antigravity',
    source: 'agy-usage-tui',
    configured: true,
    fetchedAt: new Date(NOW).toISOString(),
    windows: [
      {
        id: 'agy-gemini-weekly',
        label: 'Gemini Weekly',
        runs: 0,
        totalTokens: 0,
        limitLabel: `${remainingPercent}% remaining`,
        trackingOnly: false,
        usedPercent: 100 - remainingPercent,
        remainingPercent
      }
    ]
  }
}

function failureSnapshot(): NormalizedProviderUsageSnapshot {
  return {
    provider: 'antigravity',
    source: 'agy-usage-tui',
    configured: true,
    fetchedAt: new Date(NOW).toISOString(),
    error: 'Quota unavailable: official agy /usage timed out.'
  }
}

describe('createAntigravityQuotaClient', () => {
  it('uses Limit Counter’s rotating autonomous cadence around agy-owned reads', async () => {
    expect(ANTIGRAVITY_QUOTA_REFRESH_INTERVALS_MS).toEqual(
      [4, 7, 16, 3, 21].map((minutes) => minutes * 60 * 1000)
    )

    let now = NOW
    const fetchQuota = vi.fn(async () => quotaSnapshot())
    const read = createAntigravityQuotaClient({ fetchQuota, now: () => now })

    await read()
    expect(fetchQuota).toHaveBeenCalledOnce()

    now += 4 * 60 * 1000 - 1
    await read()
    expect(fetchQuota).toHaveBeenCalledOnce()

    now += 1
    await read()
    expect(fetchQuota).toHaveBeenCalledTimes(2)

    now += 7 * 60 * 1000
    await read()
    expect(fetchQuota).toHaveBeenCalledTimes(3)
  })

  it('joins concurrent callers into one agy PTY probe', async () => {
    let finish: ((snapshot: NormalizedProviderUsageSnapshot) => void) | undefined
    const fetchQuota = vi.fn(
      () =>
        new Promise<NormalizedProviderUsageSnapshot>((resolve) => {
          finish = resolve
        })
    )
    const read = createAntigravityQuotaClient({ fetchQuota, now: () => NOW })

    const first = read()
    const joined = read()
    expect(fetchQuota).toHaveBeenCalledOnce()
    finish?.(quotaSnapshot())
    await expect(Promise.all([first, joined])).resolves.toHaveLength(2)
  })

  it('serves a fresh cache and clamps repeated manual refreshes', async () => {
    let now = NOW
    const fetchQuota = vi.fn(async () => quotaSnapshot())
    const read = createAntigravityQuotaClient({ fetchQuota, now: () => now })

    await read()
    now += 60_000
    await read({ force: true })
    expect(fetchQuota).toHaveBeenCalledOnce()

    now += 5 * 60 * 1000
    await read({ force: true })
    expect(fetchQuota).toHaveBeenCalledTimes(2)
  })

  it('keeps the last successful quota through a failed agy session', async () => {
    let now = NOW
    const fetchQuota = vi
      .fn<() => Promise<NormalizedProviderUsageSnapshot>>()
      .mockResolvedValueOnce(quotaSnapshot(42))
      .mockResolvedValueOnce(failureSnapshot())
      .mockResolvedValueOnce(quotaSnapshot(30))
    const read = createAntigravityQuotaClient({
      fetchQuota,
      now: () => now,
      refreshIntervalsMs: [100]
    })

    await read()
    now += 100
    await expect(read()).resolves.toEqual(
      expect.objectContaining({ windows: [expect.objectContaining({ remainingPercent: 42 })] })
    )

    now += 99
    await read()
    expect(fetchQuota).toHaveBeenCalledTimes(2)

    now += 1
    await expect(read()).resolves.toEqual(
      expect.objectContaining({ windows: [expect.objectContaining({ remainingPercent: 30 })] })
    )
  })

  it('returns bounded unavailable data when the agy-owned read throws', async () => {
    const read = createAntigravityQuotaClient({
      fetchQuota: vi.fn(async () => {
        throw new Error('raw terminal/session data')
      }),
      now: () => NOW
    })

    const snapshot = await read()
    expect(snapshot.error).toBe(
      'Quota unavailable: the official agy /usage session could not be read.'
    )
    expect(JSON.stringify(snapshot)).not.toContain('raw terminal/session data')
  })
})
