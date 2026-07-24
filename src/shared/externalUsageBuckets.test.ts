import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../main/store/types'
import {
  EXTERNAL_USAGE_MINUTE_BUCKET_WINDOW_MS,
  aggregateExternalUsageRecords,
  usageRecordRunCount
} from './externalUsageBuckets'

// Fixed local reference: 2026-07-24 12:00:00 local time.
const NOW = new Date(2026, 6, 24, 12, 0, 0, 0).getTime()

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: `raw-${Math.abs(overrides.timestamp ?? 0)}-${overrides.model ?? 'm'}-${
      overrides.totalTokens ?? 0
    }`,
    provider: 'codex',
    timestamp: NOW,
    workspaceId: 'external',
    chatId: 'external-codex',
    runId: 'external-codex',
    usageKind: 'run',
    model: 'gpt-5.3-codex',
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
    ...overrides
  }
}

describe('aggregateExternalUsageRecords', () => {
  it('merges old records within one local hour and stamps the hour start', () => {
    const base = new Date(2026, 6, 20, 14, 0, 0, 0).getTime() // >48h before NOW
    const out = aggregateExternalUsageRecords(
      [
        record({ timestamp: base + 5 * 60_000, inputTokens: 10, outputTokens: 2, totalTokens: 12 }),
        record({ timestamp: base + 40 * 60_000, inputTokens: 7, outputTokens: 1, totalTokens: 8 })
      ],
      NOW
    )
    expect(out).toHaveLength(1)
    expect(out[0].timestamp).toBe(base)
    expect(out[0].inputTokens).toBe(17)
    expect(out[0].outputTokens).toBe(3)
    expect(out[0].totalTokens).toBe(20)
    expect(out[0].runCount).toBe(2)
    expect(out[0].workspaceId).toBe('external')
    expect(out[0].chatId).toBe('external-codex')
  })

  it('keeps recent records at minute granularity', () => {
    const minute = NOW - 30 * 60_000 // inside the 48h minute window
    const out = aggregateExternalUsageRecords(
      [
        record({ timestamp: minute + 100, totalTokens: 5 }),
        record({ timestamp: minute + 900, totalTokens: 6 }),
        record({ timestamp: minute + 61_000, totalTokens: 7 }) // next minute
      ],
      NOW
    )
    expect(out).toHaveLength(2)
    const merged = out.find((r) => r.totalTokens === 11)
    expect(merged?.timestamp).toBe(minute)
    expect(merged?.runCount).toBe(2)
    const solo = out.find((r) => r.totalTokens === 7)
    expect(solo?.runCount).toBe(1)
  })

  it('never merges across a local midnight', () => {
    const lateNight = new Date(2026, 6, 18, 23, 59, 0, 0).getTime()
    const nextDay = new Date(2026, 6, 19, 0, 1, 0, 0).getTime()
    const out = aggregateExternalUsageRecords(
      [
        record({ timestamp: lateNight, totalTokens: 3 }),
        record({ timestamp: nextDay, totalTokens: 4 })
      ],
      NOW
    )
    expect(out).toHaveLength(2)
    const days = out.map((r) => new Date(r.timestamp).getDate()).sort()
    expect(days).toEqual([18, 19])
  })

  it('accumulates the effective token value for parts-only records', () => {
    const ts = new Date(2026, 6, 20, 9, 10, 0, 0).getTime()
    const out = aggregateExternalUsageRecords(
      [
        record({ timestamp: ts, totalTokens: 0, inputTokens: 10, outputTokens: 5 }),
        record({ timestamp: ts, totalTokens: 20, inputTokens: 12, outputTokens: 8 })
      ],
      NOW
    )
    expect(out).toHaveLength(1)
    // 15 effective from the parts-fallback record + 20 reported.
    expect(out[0].totalTokens).toBe(35)
  })

  it('buckets zero-signal marker rows separately from token-bearing rows', () => {
    const ts = new Date(2026, 6, 20, 9, 10, 0, 0).getTime()
    const out = aggregateExternalUsageRecords(
      [
        record({ timestamp: ts, totalTokens: 0 }),
        record({ timestamp: ts, totalTokens: 0 }),
        record({ timestamp: ts, totalTokens: 50 })
      ],
      NOW
    )
    expect(out).toHaveLength(2)
    const markers = out.find((r) => r.totalTokens === 0)
    expect(markers?.runCount).toBe(2)
    expect(out.find((r) => r.totalTokens === 50)?.runCount).toBe(1)
  })

  it('separates providers and models sharing a bucket window', () => {
    const ts = new Date(2026, 6, 20, 9, 0, 0, 0).getTime()
    const out = aggregateExternalUsageRecords(
      [
        record({ timestamp: ts, totalTokens: 1 }),
        record({ timestamp: ts, totalTokens: 2, model: 'gpt-5.3-codex-spark' }),
        record({
          timestamp: ts,
          totalTokens: 4,
          provider: 'claude',
          chatId: 'external-claude',
          runId: 'external-claude',
          model: 'claude-fable-5'
        })
      ],
      NOW
    )
    expect(out).toHaveLength(3)
    expect(out.reduce((sum, r) => sum + r.totalTokens, 0)).toBe(7)
  })

  it('passes reset_hint and non-finite-timestamp records through untouched', () => {
    const hint = record({ usageKind: 'reset_hint', totalTokens: 999, timestamp: NOW - 1000 })
    const broken = record({ timestamp: Number.NaN, totalTokens: 5 })
    const out = aggregateExternalUsageRecords([hint, broken], NOW)
    expect(out).toContain(hint)
    expect(out).toContain(broken)
  })

  it('sums cache token components and carries runCount forward idempotently', () => {
    const ts = new Date(2026, 6, 20, 9, 10, 0, 0).getTime()
    const once = aggregateExternalUsageRecords(
      [
        record({
          timestamp: ts,
          totalTokens: 30,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 9,
          cacheCreationInputTokens: 6
        }),
        record({ timestamp: ts + 60_000, totalTokens: 7, cacheReadInputTokens: 2 })
      ],
      NOW
    )
    expect(once).toHaveLength(1)
    expect(once[0].cacheReadInputTokens).toBe(11)
    expect(once[0].cacheCreationInputTokens).toBe(6)
    expect(once[0].runCount).toBe(2)

    const twice = aggregateExternalUsageRecords(once, NOW)
    expect(twice).toHaveLength(1)
    expect(twice[0].totalTokens).toBe(once[0].totalTokens)
    expect(twice[0].runCount).toBe(2)
    expect(twice[0].id).toBe(once[0].id)
  })

  it('switches from minute to hour granularity at the recent-window boundary', () => {
    // Two records in the same local hour, different minutes. Placed just
    // OUTSIDE the 48h minute window they merge into one hour bucket; the same
    // pair placed just inside stays two minute buckets.
    const oldHour = new Date(NOW - EXTERNAL_USAGE_MINUTE_BUCKET_WINDOW_MS - 2 * 60 * 60 * 1000)
    oldHour.setMinutes(0, 0, 0)
    const outOld = aggregateExternalUsageRecords(
      [
        record({ timestamp: oldHour.getTime() + 5 * 60_000, totalTokens: 1 }),
        record({ timestamp: oldHour.getTime() + 25 * 60_000, totalTokens: 2 })
      ],
      NOW
    )
    expect(outOld).toHaveLength(1)

    const recentHour = new Date(NOW - 60 * 60 * 1000)
    recentHour.setMinutes(0, 0, 0)
    const outRecent = aggregateExternalUsageRecords(
      [
        record({ timestamp: recentHour.getTime() + 5 * 60_000, totalTokens: 1 }),
        record({ timestamp: recentHour.getTime() + 25 * 60_000, totalTokens: 2 })
      ],
      NOW
    )
    expect(outRecent).toHaveLength(2)
  })

  it('returns newest-first ordering', () => {
    const out = aggregateExternalUsageRecords(
      [
        record({ timestamp: new Date(2026, 6, 18, 8, 0).getTime(), totalTokens: 1 }),
        record({ timestamp: new Date(2026, 6, 20, 8, 0).getTime(), totalTokens: 2 }),
        record({ timestamp: NOW - 60_000, totalTokens: 3 })
      ],
      NOW
    )
    const stamps = out.map((r) => r.timestamp)
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a))
  })

  it('produces stable ids for identical corpora', () => {
    const make = () =>
      aggregateExternalUsageRecords(
        [
          record({ timestamp: new Date(2026, 6, 20, 9, 5).getTime(), totalTokens: 5 }),
          record({ timestamp: new Date(2026, 6, 20, 9, 25).getTime(), totalTokens: 6 })
        ],
        NOW
      )
    expect(make().map((r) => r.id)).toEqual(make().map((r) => r.id))
  })
})

describe('usageRecordRunCount', () => {
  it('defaults to 1 and clamps invalid values', () => {
    expect(usageRecordRunCount({})).toBe(1)
    expect(usageRecordRunCount({ runCount: undefined })).toBe(1)
    expect(usageRecordRunCount({ runCount: 0 })).toBe(1)
    expect(usageRecordRunCount({ runCount: -3 })).toBe(1)
    expect(usageRecordRunCount({ runCount: Number.NaN })).toBe(1)
    expect(usageRecordRunCount({ runCount: 4 })).toBe(4)
    expect(usageRecordRunCount({ runCount: 2.9 })).toBe(2)
  })
})
