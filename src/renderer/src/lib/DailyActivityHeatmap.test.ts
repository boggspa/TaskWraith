import { describe, expect, it } from 'vitest'
import {
  DAILY_HEATMAP_ROWS,
  MIN_ACTIVE_INTENSITY,
  buildDailyHeatmapGrid,
  buildDailyIntensityRamp,
  describeDailyHeatmapCell,
  formatDailyTokenCount
} from './DailyActivityHeatmap'
import { HEATMAP_PROVIDER_COLOR_HEX } from './UsageHeatmap'
import type { DailyUsageDays } from '../../../shared/dailyUsageRollup'

/** A Wednesday, so leading-blank padding is exercised by default. */
const NOW = new Date(2026, 5, 10, 12, 0, 0, 0).getTime()

/** The local day key `back` days before NOW. Building keys by decrementing the
 * day NUMBER silently produces nonsense like `2026-06--9` past the start of the
 * month, which lands outside the window and makes an assertion pass on a cell
 * that was never populated. */
function dayKeyBefore(back: number): string {
  const date = new Date(NOW)
  date.setDate(date.getDate() - back)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

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

  it('runs the quietest day to the floor and the busiest to full strength', () => {
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
    expect(quiet.intensity).toBeCloseTo(MIN_ACTIVE_INTENSITY, 2)
    expect(quiet.intensity).toBeLessThan(busy.intensity)
  })

  it('keeps a quiet day visibly distinct from an empty one', () => {
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [10_000_000, 1] }, '2026-06-09': { codex: [1, 1] } }),
      { now: NOW, dayCount: 30 }
    )
    const quiet = grid.cells.find((cell) => cell.day === '2026-06-09')!
    const empty = grid.cells.find((cell) => cell.day === '2026-06-08')!
    expect(quiet.intensity).toBeGreaterThanOrEqual(MIN_ACTIVE_INTENSITY)
    expect(empty.intensity).toBe(0)
  })

  it('SPREADS a realistic year across the whole ramp instead of pinning it solid', () => {
    // The regression this replaced: `log10(x)/log10(max)` normalises against
    // ZERO, so on a real 143-day rollup spanning 1.3M..56.7B the quietest day
    // scored 0.57 and the median 0.80 — every day rendered above 57% opacity
    // and the year read as uniformly solid.
    const spread: Record<string, Record<string, [number, number]>> = {}
    const sampleCount = 60
    for (let index = 0; index < sampleCount; index += 1) {
      // Log-uniform across four decades, the shape real usage actually takes.
      const tokens = Math.round(10 ** (6 + (4 * index) / (sampleCount - 1)))
      spread[dayKeyBefore(index)] = { codex: [tokens, 1] }
    }
    const grid = buildDailyHeatmapGrid(days(spread), { now: NOW, dayCount: 90 })
    const shades = Object.keys(spread)
      .map((day) => grid.cells.find((cell) => cell.day === day)!.intensity)
      .sort((a, b) => a - b)

    expect(shades[0]).toBeCloseTo(MIN_ACTIVE_INTENSITY, 2)
    expect(shades[shades.length - 1]).toBeCloseTo(1, 2)

    // Every fifth of the ramp carries some of the year, and the busiest fifth
    // does not swallow it. Under the old formula the top fifth held all 60.
    const fifths = [0, 0, 0, 0, 0]
    for (const shade of shades) {
      const band = Math.min(
        4,
        Math.floor(((shade - MIN_ACTIVE_INTENSITY) / (1 - MIN_ACTIVE_INTENSITY)) * 5)
      )
      fifths[Math.max(0, band)] += 1
    }
    for (const count of fifths) expect(count).toBeGreaterThan(0)
    expect(fifths[4]).toBeLessThan(sampleCount / 2)

    // And the middle of the data sits near the middle of the ramp.
    const median = shades[Math.floor(shades.length / 2)]
    expect(median).toBeGreaterThan(0.35)
    expect(median).toBeLessThan(0.8)
  })

  it('never emits an opacity outside [0,1], whatever the rollup contains', () => {
    // A non-finite value used to poison the whole ramp. The min-span guard is
    // `hi - lo < MIN_RAMP_DECADES`, and both `NaN < 1` and `Infinity < 1` are
    // false — so the one case that most needs widening was the one case that
    // skipped it, and the span came out NaN or Infinity. Every subsequent
    // lookup then returned NaN, including for the perfectly good days
    // alongside it.
    const poisoned: number[][] = [
      [Infinity],
      [-Infinity],
      [Number.NaN],
      [1000, Infinity],
      [1000, Number.NaN],
      [0, 0, 0],
      []
    ]
    for (const values of poisoned) {
      const ramp = buildDailyIntensityRamp(values)
      for (const probe of [0, 1, 1000, 1e12, Infinity, -Infinity, Number.NaN, -5]) {
        const result = ramp(probe)
        expect(Number.isFinite(result), `ramp(${probe}) on ${JSON.stringify(values)}`).toBe(true)
        expect(result).toBeGreaterThanOrEqual(0)
        expect(result).toBeLessThanOrEqual(1)
        // A non-finite day reads as NO DATA, not as the busiest day of the
        // year. Without the guard in the returned function it clamps to 1,
        // which is in range but is the loudest possible way to be wrong.
        if (!Number.isFinite(probe) || probe <= 0) {
          expect(result, `ramp(${probe}) should be exactly 0`).toBe(0)
        }
      }
    }
  })

  it('keeps a real day readable next to a corrupt one', () => {
    // The silent-data-loss half: with `[1000, Infinity]` the real 1000-token
    // day was pinned to the floor because the band stretched to infinity.
    const ramp = buildDailyIntensityRamp([1000, Infinity])
    expect(ramp(1000)).toBeGreaterThan(MIN_ACTIVE_INTENSITY)
  })

  it('excludes the extremes from the band even on a SMALL sample', () => {
    // Exercised directly, because the difference only shows when the sample is
    // small: with eleven values, rounding the 95th percentile to NEAREST gives
    // index 10 — the outlier itself — so the clamp protects nothing and the
    // other ten days squash toward the floor. Rounding inward gives index 9.
    const ordinary = Array.from({ length: 10 }, (_, index) => (index + 1) * 1e6)
    const ramp = buildDailyIntensityRamp([...ordinary, 5e12])
    expect(ramp(5e12)).toBeCloseTo(1, 2)
    expect(ramp(1e6)).toBeCloseTo(MIN_ACTIVE_INTENSITY, 2)
    // The discriminating pair: the ordinary days still climb the ramp. Round
    // the bounds to nearest instead and the band stretches to the outlier,
    // dropping these to roughly 0.19 and 0.23.
    expect(ramp(5e6)).toBeGreaterThan(0.5)
    expect(ramp(10e6)).toBeGreaterThan(0.8)
  })

  it('does not let one enormous day compress everything else', () => {
    // Absolute min..max still put 83 of 143 real days into one fifth of the
    // ramp; clamping at the 5th/95th percentiles is what stops that.
    const base: Record<string, Record<string, [number, number]>> = {}
    for (let index = 0; index < 30; index += 1) {
      base[dayKeyBefore(index)] = { codex: [(index + 1) * 1e6, 1] }
    }
    const withoutOutlier = buildDailyHeatmapGrid(days(base), { now: NOW, dayCount: 40 })
    const withOutlier = buildDailyHeatmapGrid(
      days({ ...base, '2026-05-01': { codex: [5e12, 1] } }),
      { now: NOW, dayCount: 60 }
    )
    const median = dayKeyBefore(15)
    const before = withoutOutlier.cells.find((cell) => cell.day === median)!.intensity
    const after = withOutlier.cells.find((cell) => cell.day === median)!.intensity
    expect(Math.abs(after - before)).toBeLessThan(0.15)
  })

  it('stays a heatmap rather than a chessboard on a nearly empty rollup', () => {
    // Percentiles are meaningless over two days; without the minimum span the
    // ramp collapses and every day snaps to floor or full.
    const grid = buildDailyHeatmapGrid(
      days({ '2026-06-10': { codex: [1_000, 1] }, '2026-06-09': { codex: [1_100, 1] } }),
      { now: NOW, dayCount: 30 }
    )
    const a = grid.cells.find((cell) => cell.day === '2026-06-10')!.intensity
    const b = grid.cells.find((cell) => cell.day === '2026-06-09')!.intensity
    // Near-identical days should look near-identical, not opposite extremes.
    expect(Math.abs(a - b)).toBeLessThan(0.2)
    expect(a).toBeGreaterThan(MIN_ACTIVE_INTENSITY)
    expect(a).toBeLessThan(1)
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

  it('scales the ramp to the FILTERED provider, not the all-provider peak', () => {
    // Codex is a rounding error next to Claude here. Normalising against the
    // all-provider peak put every Codex day within a hair of the floor, so
    // filtering to a quiet provider made it look barely used at all — the ramp
    // has to be built from the quantity actually being drawn.
    const entries: Record<string, Record<string, [number, number]>> = {}
    for (let index = 0; index < 30; index += 1) {
      entries[dayKeyBefore(index)] = {
        codex: [Math.round(10 ** (3 + (2 * index) / 29)), 1],
        claude: [50_000_000_000, 1]
      }
    }
    const grid = buildDailyHeatmapGrid(days(entries), {
      now: NOW,
      dayCount: 60,
      providerFilter: 'codex'
    })
    const shades = Object.keys(entries)
      .map((day) => grid.cells.find((cell) => cell.day === day)!.intensity)
      .sort((a, b) => a - b)
    expect(shades[0]).toBeCloseTo(MIN_ACTIVE_INTENSITY, 2)
    expect(shades[shades.length - 1]).toBeCloseTo(1, 2)
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
