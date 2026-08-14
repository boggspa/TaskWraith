import { describe, expect, it } from 'vitest'
import {
  DAILY_HEATMAP_ROWS,
  buildDailyHeatmapGrid,
  describeDailyHeatmapCell,
  formatDailyTokenCount
} from './DailyActivityHeatmap'
import { HEATMAP_PROVIDER_COLOR_HEX } from './UsageHeatmap'
import type { DailyUsageDays } from '../../../shared/dailyUsageRollup'

/** A Wednesday, so leading-blank padding is exercised by default. */
const NOW = new Date(2026, 5, 10, 12, 0, 0, 0).getTime()

function days(entries: Record<string, Record<string, [number, number]>>): DailyUsageDays {
  const out: DailyUsageDays = {}
  for (const [day, providers] of Object.entries(entries)) {
    out[day] = {}
    for (const [provider, [tokens, runs]] of Object.entries(providers)) {
      out[day][provider] = { tokens, runs }
    }
  }
  return out
}

describe('grid geometry', () => {
  it('lays a year out as 7 weekday rows of whole weeks', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 365 })
    expect(grid.rows).toBe(DAILY_HEATMAP_ROWS)
    expect(grid.cells.length).toBe(grid.columns * DAILY_HEATMAP_ROWS)
    // 365 days plus leading blanks never needs more than 54 columns.
    expect(grid.columns).toBeGreaterThanOrEqual(52)
    expect(grid.columns).toBeLessThanOrEqual(54)
  })

  it('covers exactly dayCount real days, the rest padding', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 365 })
    expect(grid.cells.filter((cell) => !cell.isOutsideWindow).length).toBe(365)
  })

  it('ends on today and starts dayCount-1 days earlier', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 365 })
    expect(grid.endDay).toBe('2026-06-10')
    expect(grid.startDay).toBe('2025-06-11')
  })

  it('places each day on its real weekday row', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 14 })
    const today = grid.cells.find((cell) => cell.day === '2026-06-10')
    // 10 June 2026 is a Wednesday.
    expect(new Date(2026, 5, 10).getDay()).toBe(3)
    expect(today!.row).toBe(3)
  })

  it('keeps the rectangle square by padding rather than omitting cells', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 10 })
    const padding = grid.cells.filter((cell) => cell.isOutsideWindow)
    expect(padding.length).toBe(grid.cells.length - 10)
    for (const cell of padding) {
      expect(cell.day).toBeNull()
      expect(cell.intensity).toBe(0)
      expect(cell.color).toBeNull()
    }
  })

  it('reads columns oldest-first', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 30 })
    const real = grid.cells.filter((cell) => !cell.isOutsideWindow)
    const first = real[0]
    const last = real[real.length - 1]
    expect(first.day).toBe(grid.startDay)
    expect(last.day).toBe(grid.endDay)
    expect(first.column).toBeLessThan(last.column)
  })

  it('labels months along the axis without repeating one', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 365 })
    const labels = grid.monthLabels.map((entry) => entry.label)
    expect(labels.length).toBeGreaterThanOrEqual(12)
    expect(labels).toContain('Sept')
    expect(labels[labels.length - 1]).toBe('Jun')
    // Columns strictly ascend, so labels never stack on one column.
    const columns = grid.monthLabels.map((entry) => entry.column)
    expect([...columns].sort((a, b) => a - b)).toEqual(columns)
    expect(new Set(columns).size).toBe(columns.length)
  })
})

describe('accents and intensity', () => {
  it('gives the day the accent of the provider with the most tokens', () => {
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [100, 1], claude: [900, 1] } }),
      { now: NOW, dayCount: 30 }
    )
    const cell = grid.cells.find((entry) => entry.day === '2026-06-10')!
    expect(cell.dominantProvider).toBe('claude')
    expect(cell.color).toBe(HEATMAP_PROVIDER_COLOR_HEX.claude)
  })

  it('scales intensity logarithmically against the busiest day', () => {
    const grid = buildDailyHeatmapGrid(
      days({
        '2026-06-10': { codex: [1_000_000, 10] },
        '2026-06-09': { codex: [1_000, 1] }
      }),
      { now: NOW, dayCount: 30 }
    )
    const busy = grid.cells.find((cell) => cell.day === '2026-06-10')!
    const quiet = grid.cells.find((cell) => cell.day === '2026-06-09')!
    expect(busy.intensity).toBeCloseTo(1, 2)
    expect(quiet.intensity).toBeGreaterThan(0.2)
    expect(quiet.intensity).toBeLessThan(busy.intensity)
  })

  it('keeps a quiet day visibly distinct from an empty one', () => {
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [10_000_000, 1] }, '2026-06-09': { codex: [1, 1] } }),
      { now: NOW, dayCount: 30 }
    )
    const quiet = grid.cells.find((cell) => cell.day === '2026-06-09')!
    const empty = grid.cells.find((cell) => cell.day === '2026-06-08')!
    expect(quiet.intensity).toBeGreaterThanOrEqual(0.2)
    expect(empty.intensity).toBe(0)
  })

  it('gives token-less activity markers a definite but modest mark', () => {
    const grid = buildDailyHeatmapGrid(days({ '2026-06-10': { cursor: [0, 4] } }), {
      now: NOW,
      dayCount: 30
    })
    const cell = grid.cells.find((entry) => entry.day === '2026-06-10')!
    expect(cell.totalTokens).toBe(0)
    expect(cell.runCount).toBe(4)
    expect(cell.intensity).toBeGreaterThan(0)
    expect(cell.color).toBe(HEATMAP_PROVIDER_COLOR_HEX.cursor)
  })

  it('aggregates window totals across every provider and day', () => {
    const grid = buildDailyHeatmapGrid(
      days({
        '2026-06-10': { codex: [100, 1], claude: [50, 2] },
        '2026-06-09': { grok: [25, 1] }
      }),
      { now: NOW, dayCount: 30 }
    )
    expect(grid.totalTokens).toBe(175)
    expect(grid.totalRuns).toBe(4)
    expect(grid.activeDays).toBe(2)
  })

  it('excludes days outside the window from the totals', () => {
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [100, 1] }, '2020-01-01': { codex: [9_999, 9] } }),
      { now: NOW, dayCount: 30 }
    )
    expect(grid.totalTokens).toBe(100)
  })
})

describe('provider filter', () => {
  it('dims days the filtered provider was absent from', () => {
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [100, 1] }, '2026-06-09': { claude: [100, 1] } }),
      { now: NOW, dayCount: 30, providerFilter: 'codex' }
    )
    expect(grid.cells.find((cell) => cell.day === '2026-06-10')!.intensity).toBeGreaterThan(0)
    expect(grid.cells.find((cell) => cell.day === '2026-06-09')!.intensity).toBe(0)
  })

  it('leaves the tooltip breakdown and totals whole while filtering', () => {
    // Filtering answers "when did I use Codex", not "rewrite history".
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [100, 1], claude: [900, 2] } }),
      { now: NOW, dayCount: 30, providerFilter: 'codex' }
    )
    const cell = grid.cells.find((entry) => entry.day === '2026-06-10')!
    expect(cell.totalTokens).toBe(1000)
    expect(cell.providers.map((entry) => entry.provider)).toEqual(['claude', 'codex'])
    expect(cell.color).toBe(HEATMAP_PROVIDER_COLOR_HEX.codex)
  })
})

describe('tooltip', () => {
  it('states EVERY provider that contributed, not just the winner', () => {
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [900, 3], claude: [100, 1], cursor: [0, 2] } }),
      { now: NOW, dayCount: 30, labelFor: (id) => id.toUpperCase() }
    )
    const cell = grid.cells.find((entry) => entry.day === '2026-06-10')!
    const text = describeDailyHeatmapCell(cell)!
    expect(text).toContain('1.0K tokens · 6 calls')
    expect(text).toContain('CODEX — 900 · 3 calls')
    expect(text).toContain('CLAUDE — 100 · 1 call')
    expect(text).toContain('CURSOR — 2 markers')
  })

  it('names the date', () => {
    const grid = buildDailyHeatmapGrid(days({ '2026-06-10': { codex: [5, 1] } }), {
      now: NOW,
      dayCount: 30
    })
    const cell = grid.cells.find((entry) => entry.day === '2026-06-10')!
    expect(describeDailyHeatmapCell(cell)).toContain('2026')
  })

  it('says so plainly on an empty day', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 30 })
    const cell = grid.cells.find((entry) => entry.day === '2026-06-10')!
    expect(describeDailyHeatmapCell(cell)).toContain('No activity')
  })

  it('has no tooltip at all for padding cells', () => {
    const grid = buildDailyHeatmapGrid({}, { now: NOW, dayCount: 10 })
    const padding = grid.cells.find((cell) => cell.isOutsideWindow)!
    expect(describeDailyHeatmapCell(padding)).toBeUndefined()
  })
})

describe('formatDailyTokenCount', () => {
  it('formats across magnitudes', () => {
    expect(formatDailyTokenCount(0)).toBe('0')
    expect(formatDailyTokenCount(812)).toBe('812')
    expect(formatDailyTokenCount(1_200)).toBe('1.2K')
    expect(formatDailyTokenCount(94_000)).toBe('94K')
    expect(formatDailyTokenCount(1_250_000)).toBe('1.3M')
    expect(formatDailyTokenCount(2_400_000_000)).toBe('2.4B')
  })
})
