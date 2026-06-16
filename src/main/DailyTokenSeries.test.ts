import { describe, expect, it } from 'vitest'
import type { UsageRecord } from './store/types'
import { buildDailyTokenSeries } from './DailyTokenSeries'

const DAY = 24 * 60 * 60 * 1000
// 16 Jun 2026, local noon — local day boundaries make bucket placement stable.
const NOW = new Date(2026, 5, 16, 12, 0, 0).getTime()

function rec(partial: Partial<UsageRecord>): UsageRecord {
  return {
    id: 'r',
    timestamp: NOW,
    provider: 'codex',
    totalTokens: 0,
    usageKind: 'request',
    ...partial
  } as unknown as UsageRecord
}

describe('buildDailyTokenSeries', () => {
  it('produces dayCount buckets oldest→newest with today in the last bucket', () => {
    const series = buildDailyTokenSeries([rec({ timestamp: NOW, totalTokens: 100 })], NOW, 7)
    expect(series.buckets).toHaveLength(7)
    expect(series.buckets[6].tokens).toBe(100)
    expect(series.buckets[6].provider).toBe('codex')
    expect(series.buckets.slice(0, 6).every((b) => b.tokens === 0)).toBe(true)
    expect(series.totalTokens).toBe(100)
  })

  it('defaults to 90 buckets', () => {
    expect(buildDailyTokenSeries([], NOW).buckets).toHaveLength(90)
  })

  it('sums tokens per day and picks the dominant provider', () => {
    const series = buildDailyTokenSeries(
      [
        rec({ timestamp: NOW, totalTokens: 30, provider: 'codex' }),
        rec({ timestamp: NOW, totalTokens: 70, provider: 'claude' }),
        rec({ timestamp: NOW - DAY, totalTokens: 10, provider: 'gemini' })
      ],
      NOW,
      7
    )
    expect(series.buckets[6].tokens).toBe(100)
    expect(series.buckets[6].provider).toBe('claude')
    expect(series.buckets[5].tokens).toBe(10)
    expect(series.buckets[5].provider).toBe('gemini')
    expect(series.totalTokens).toBe(110)
  })

  it('skips reset_hint and out-of-window records', () => {
    const series = buildDailyTokenSeries(
      [
        rec({ timestamp: NOW, totalTokens: 50, usageKind: 'reset_hint' }),
        rec({ timestamp: NOW - 30 * DAY, totalTokens: 999 }),
        rec({ timestamp: NOW, totalTokens: 5 })
      ],
      NOW,
      7
    )
    expect(series.totalTokens).toBe(5)
  })

  it('falls back to input+output when totalTokens is absent', () => {
    const series = buildDailyTokenSeries(
      [rec({ timestamp: NOW, totalTokens: 0, inputTokens: 12, outputTokens: 8 })],
      NOW,
      7
    )
    expect(series.buckets[6].tokens).toBe(20)
  })

  it('labels the window start and end', () => {
    const series = buildDailyTokenSeries([], NOW, 7)
    expect(series.endLabel).toBe('16 Jun')
    expect(series.startLabel).toBe('10 Jun')
  })
})
