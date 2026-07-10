import { describe, expect, it } from 'vitest'
import type { UsageRecord } from './types'
import {
  partitionUsageRecordsForRotation,
  USAGE_ROTATION_RETENTION_MS
} from './usageRotation'

function usageRecord(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: 'test',
    timestamp: 0,
    workspaceId: 'w',
    chatId: 'c',
    runId: 'r',
    usageKind: 'run',
    model: 'm',
    provider: 'claude',
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    durationMs: 0,
    ...overrides
  } as UsageRecord
}

describe('partitionUsageRecordsForRotation', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z')

  it('rotates records older than the retention window and keeps the rest', () => {
    const old = usageRecord({ id: 'old', timestamp: now - USAGE_ROTATION_RETENTION_MS - 1 })
    const boundary = usageRecord({ id: 'boundary', timestamp: now - USAGE_ROTATION_RETENTION_MS })
    const fresh = usageRecord({ id: 'fresh', timestamp: now - 1000 })

    const { keep, rotate } = partitionUsageRecordsForRotation([old, boundary, fresh], now)

    expect(rotate.map((record) => record.id)).toEqual(['old'])
    expect(keep.map((record) => record.id)).toEqual(['boundary', 'fresh'])
  })

  it('never rotates records with unparseable timestamps', () => {
    const invalid = usageRecord({ id: 'invalid', timestamp: Number.NaN })
    const { keep, rotate } = partitionUsageRecordsForRotation([invalid], now)
    expect(rotate).toHaveLength(0)
    expect(keep.map((record) => record.id)).toEqual(['invalid'])
  })

  it('retention window is at least the 180-day DailyTokenSeries cap', () => {
    expect(USAGE_ROTATION_RETENTION_MS).toBeGreaterThanOrEqual(180 * 24 * 60 * 60 * 1000)
  })
})
