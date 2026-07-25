import { describe, expect, it } from 'vitest'
import type { UsageRecord } from '../../../main/store/types'
import {
  buildHeatmapGrid,
  buildProviderFilteredHeatmapGrid,
  formatTokenCount,
  HEATMAP_COLUMNS,
  HEATMAP_PROVIDER_COLOR_HEX,
  HEATMAP_PROVIDER_FILTERS,
  HEATMAP_PROVIDER_ORDER,
  HEATMAP_ROWS
} from './UsageHeatmap'
import { getProviderLabel } from './providerLabels'

function makeRecord(
  overrides: Partial<UsageRecord> & { timestamp: number; totalTokens: number }
): UsageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    workspaceId: 'ws-1',
    chatId: 'chat-1',
    runId: 'run-1',
    model: 'cli-default',
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    provider: 'codex',
    ...overrides
  } as UsageRecord
}

describe('buildHeatmapGrid', () => {
  it('emits exactly HEATMAP_COLUMNS × HEATMAP_ROWS cells', () => {
    const grid = buildHeatmapGrid([], new Date('2026-05-22T15:00:00Z'))
    expect(grid.columns).toBe(HEATMAP_COLUMNS)
    expect(grid.cells).toHaveLength(HEATMAP_COLUMNS * HEATMAP_ROWS)
    expect(grid.cells.every((c) => c.color === null && c.intensity === 0)).toBe(true)
    expect(grid.totals).toEqual({ last24h: 0, last7d: 0, last30d: 0, window: 0 })
  })

  it('places an event in the correct (column, row) bucket', () => {
    // Reference: now = 2026-05-22T15:00:00 (local). Today is column 29 (HEATMAP_COLUMNS-1).
    // Event at 14:30 on the same day → row = Math.floor(14/2) = 7.
    const now = new Date('2026-05-22T15:00:00')
    const eventTime = new Date('2026-05-22T14:30:00').getTime()
    const grid = buildHeatmapGrid(
      [makeRecord({ timestamp: eventTime, totalTokens: 1000, provider: 'codex' })],
      now
    )
    const cell = grid.cells.find((c) => c.column === HEATMAP_COLUMNS - 1 && c.row === 7)
    expect(cell).toBeDefined()
    expect(cell!.totalTokens).toBe(1000)
    expect(cell!.eventCount).toBe(1)
    expect(cell!.dominantProvider).toBe('codex')
    expect(cell!.color).toBe('#705AFF')
  })

  it('drops events older than the 30-day window', () => {
    const now = new Date('2026-05-22T15:00:00Z')
    const oldEvent = new Date('2026-04-01T10:00:00Z').getTime() // > 30 days back
    const grid = buildHeatmapGrid([makeRecord({ timestamp: oldEvent, totalTokens: 5000 })], now)
    expect(grid.totals.last30d).toBe(0)
    expect(grid.cells.every((c) => c.totalTokens === 0)).toBe(true)
  })

  it('drops timestamps far enough in the future to fall outside the today-bucket (clock skew defensive)', () => {
    const now = new Date('2026-05-22T15:00:00Z')
    // 2 days into the future — clearly past the end-of-today bound.
    // (Events later in the SAME day are kept; that's normal usage and
    // not a clock-skew scenario.)
    const future = now.getTime() + 2 * 24 * 60 * 60 * 1000
    const grid = buildHeatmapGrid([makeRecord({ timestamp: future, totalTokens: 5000 })], now)
    expect(grid.totals.last30d).toBe(0)
  })

  it('rolls multiple events in the same bucket into a single cell', () => {
    const now = new Date('2026-05-22T15:00:00')
    const baseTime = new Date('2026-05-22T14:30:00').getTime()
    const grid = buildHeatmapGrid(
      [
        makeRecord({ timestamp: baseTime, totalTokens: 1000, provider: 'codex' }),
        makeRecord({ timestamp: baseTime + 60_000, totalTokens: 2000, provider: 'codex' }),
        makeRecord({ timestamp: baseTime + 120_000, totalTokens: 500, provider: 'claude' })
      ],
      now
    )
    const cell = grid.cells.find((c) => c.column === HEATMAP_COLUMNS - 1 && c.row === 7)!
    expect(cell.totalTokens).toBe(3500)
    expect(cell.eventCount).toBe(3)
    // Codex contributes 3000 tokens > Claude's 500 → codex dominant.
    expect(cell.dominantProvider).toBe('codex')
  })

  it('computes last24h / last7d / last30d totals correctly', () => {
    const now = new Date('2026-05-22T15:00:00')
    const grid = buildHeatmapGrid(
      [
        makeRecord({ timestamp: now.getTime() - 60_000, totalTokens: 1000 }), // 1 min ago
        makeRecord({ timestamp: now.getTime() - 10 * 60 * 60 * 1000, totalTokens: 2000 }), // 10h
        makeRecord({ timestamp: now.getTime() - 3 * 24 * 60 * 60 * 1000, totalTokens: 4000 }), // 3 days
        makeRecord({ timestamp: now.getTime() - 15 * 24 * 60 * 60 * 1000, totalTokens: 8000 }) // 15 days
      ],
      now
    )
    expect(grid.totals.last24h).toBe(3000) // 1000 + 2000
    expect(grid.totals.last7d).toBe(7000) // 3000 + 4000
    expect(grid.totals.last30d).toBe(15000) // all four
    expect(grid.totals.window).toBe(15000) // all four
  })

  it('supports wider standalone windows without changing the rolling 30-day total', () => {
    const now = new Date('2026-05-22T15:00:00Z')
    const sixtyDaysAgo = now.getTime() - 60 * 24 * 60 * 60 * 1000
    const tenDaysAgo = now.getTime() - 10 * 24 * 60 * 60 * 1000
    const grid = buildHeatmapGrid(
      [
        makeRecord({ timestamp: sixtyDaysAgo, totalTokens: 9000, provider: 'gemini' }),
        makeRecord({ timestamp: tenDaysAgo, totalTokens: 1000, provider: 'codex' })
      ],
      now,
      90
    )

    expect(grid.columns).toBe(90)
    expect(grid.cells).toHaveLength(90 * HEATMAP_ROWS)
    expect(grid.totals.last30d).toBe(1000)
    expect(grid.totals.window).toBe(10000)
    expect(grid.cells.some((c) => c.totalTokens === 9000 && c.dominantProvider === 'gemini')).toBe(
      true
    )
  })

  it('renders activity-only records without inflating token totals', () => {
    const now = new Date('2026-05-22T15:00:00')
    const grid = buildHeatmapGrid(
      [
        makeRecord({
          timestamp: new Date('2026-05-22T14:30:00').getTime(),
          totalTokens: 0,
          provider: 'cursor'
        })
      ],
      now
    )
    const cell = grid.cells.find((c) => c.column === HEATMAP_COLUMNS - 1 && c.row === 7)

    expect(cell).toBeDefined()
    expect(cell!.eventCount).toBe(1)
    expect(cell!.totalTokens).toBe(0)
    expect(cell!.dominantProvider).toBe('cursor')
    expect(cell!.intensity).toBeGreaterThan(0)
    expect(grid.totals.window).toBe(0)
  })

  it('can isolate provider tiles while preserving all-provider chip totals', () => {
    const now = new Date('2026-05-22T15:00:00')
    const bucketTime = new Date('2026-05-22T14:30:00').getTime()
    const grid = buildProviderFilteredHeatmapGrid(
      [
        makeRecord({ timestamp: bucketTime, totalTokens: 1000, provider: 'codex' }),
        makeRecord({ timestamp: bucketTime, totalTokens: 4000, provider: 'claude' })
      ],
      now,
      HEATMAP_COLUMNS,
      'codex'
    )

    const cell = grid.cells.find((c) => c.column === HEATMAP_COLUMNS - 1 && c.row === 7)
    expect(cell).toBeDefined()
    expect(cell!.totalTokens).toBe(1000)
    expect(cell!.dominantProvider).toBe('codex')
    expect(grid.totals.last24h).toBe(5000)
    expect(grid.totals.window).toBe(5000)
  })
})

describe('formatTokenCount', () => {
  it('formats single-digit ranges as plain integers', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(150)).toBe('150')
    expect(formatTokenCount(999)).toBe('999')
  })

  it('formats thousands with one decimal under 10K, integer thereafter', () => {
    expect(formatTokenCount(1_500)).toBe('1.5K')
    expect(formatTokenCount(12_300)).toBe('12K')
  })

  it('formats millions with one decimal under 10M, integer thereafter', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(120_000_000)).toBe('120M')
  })

  it('formats billions with two decimals', () => {
    expect(formatTokenCount(1_500_000_000)).toBe('1.50B')
  })
})

describe('HEATMAP_PROVIDER_ORDER', () => {
  // The colour map is `Record<ProviderId, string>`, so the compiler already
  // forces it complete. Anchoring the order to it turns "someone added a tenth
  // provider and forgot the usage surfaces" into a failing test rather than an
  // uncoloured, unfilterable bar. This is a HISTORY surface: retired providers
  // (gemini) stay listed on purpose — see shared/retiredProviders.
  it('covers every provider that can appear in a usage record', () => {
    expect([...HEATMAP_PROVIDER_ORDER].sort()).toEqual(
      Object.keys(HEATMAP_PROVIDER_COLOR_HEX).sort()
    )
  })

  it('lists each provider exactly once', () => {
    expect(new Set(HEATMAP_PROVIDER_ORDER).size).toBe(HEATMAP_PROVIDER_ORDER.length)
  })

  it('builds filter tabs as All plus every provider, canonically labelled', () => {
    expect(HEATMAP_PROVIDER_FILTERS[0]).toEqual({ id: 'all', label: 'All' })
    expect(HEATMAP_PROVIDER_FILTERS.slice(1)).toEqual(
      HEATMAP_PROVIDER_ORDER.map((id) => ({ id, label: getProviderLabel(id) }))
    )
  })
})
