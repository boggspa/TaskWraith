/**
 * Grid geometry for the 365-day daily heatmap.
 *
 * Deliberately NOT `buildHeatmapGrid`. That one is day-columns x 2-hour-rows
 * and clamps at `MAX_HEATMAP_COLUMNS = 180`; this is the calendar layout —
 * weekday rows, week columns, one cell per DAY — so a year fits in 53 columns
 * instead of 365. Keeping them separate leaves the 90-day surfaces and their
 * tests untouched.
 *
 * Cells carry the FULL per-provider breakdown, not just the winner. The
 * dominant provider colours the cell, but the tooltip reports every provider
 * that contributed that day, so a day tinted Codex still shows its Claude and
 * Cursor totals rather than hiding them behind the accent.
 */

import type { ProviderId } from '../../../main/store/types'
import {
  DAILY_USAGE_HEATMAP_DAYS,
  dailyUsageDayKey,
  dailyUsageDayKeyRange,
  dailyUsageDayRuns,
  dailyUsageDayTokens,
  dominantProviderForDay,
  type DailyUsageDayTotals,
  type DailyUsageDays
} from '../../../shared/dailyUsageRollup'
import { HEATMAP_PROVIDER_COLOR_HEX, HEATMAP_PROVIDER_ORDER } from './UsageHeatmap'

export const DAILY_HEATMAP_ROWS = 7

/** Lowest opacity a day with ANY activity may render at, so a quiet day is
 * still visibly distinct from an empty one. Below about 0.12 a provider colour
 * stops separating from the empty-cell background. Exported so tests assert the
 * floor rather than restating a number that then drifts from it. */
export const MIN_ACTIVE_INTENSITY = 0.14

/** Token-less activity (Cursor daily rows, Codex SQLite markers) reads as a
 * definite but modest mark rather than borrowing the busiest day's weight. */
const MARKER_INTENSITY = 0.2

/**
 * The ramp always spans at least this many orders of magnitude.
 *
 * Percentiles are meaningless on a nearly-empty rollup: with three active days
 * the 5th and 95th are almost the same number, the span collapses toward zero
 * and every day snaps to either the floor or full strength. Widening a narrow
 * band around its own midpoint keeps a young install looking like a heatmap
 * rather than a chessboard.
 */
const MIN_RAMP_DECADES = 1

/**
 * Map a day's token count to opacity, scaled to the distribution actually being
 * drawn.
 *
 * WHY NOT `log10(value) / log10(max)`, which is what the 90-day grids do and
 * what this used to do. That normalises against ZERO, so it answers "what
 * fraction of the busiest day's ORDER OF MAGNITUDE is this day's order of
 * magnitude" — and every real day is within a few orders of the peak. Measured
 * against a live 143-day rollup spanning 1.3M to 56.7B tokens, a 43,000x range:
 * the quietest day scored 0.57 and the median 0.80, so the whole year rendered
 * in the top 43% of the ramp and read as uniformly solid.
 *
 * Normalising against the observed RANGE instead spends the whole ramp on the
 * data that exists. The bounds are the 5th and 95th percentiles rather than the
 * extremes, because a single enormous day otherwise drags the top of the scale
 * away from everything else — on that same corpus, min..max still put 83 of 143
 * days in one fifth of the ramp, while p05..p95 spread them 26/32/45/25/15.
 *
 * Clamping at those percentiles is also exactly the requested behaviour: the
 * quietest 5% of days all read faint, the busiest 5% all read solid.
 *
 * Deliberately NOT quantile-ranked (the GitHub contribution-graph approach).
 * That spreads days perfectly evenly but makes shade mean POSITION rather than
 * size, so a 56.7B day would look barely darker than a 4.4B one. Opacity here
 * still means how much.
 */
export function buildDailyIntensityRamp(values: readonly number[]): (value: number) => number {
  // Finiteness is checked here, not just positivity. A single Infinity — from a
  // hand-edited rollup, or any future caller handing this raw data past the
  // `Number.isFinite` guard in `externalActivityRecordTokens` — used to poison
  // the entire ramp: `log(Infinity)` is Infinity, so the span came out Infinity
  // or NaN, and the min-span rescue below never fired because both `NaN < 1`
  // and `Infinity < 1` are false. Every lookup then returned NaN, so genuinely
  // good days alongside it silently vanished from the chart rather than
  // rendering wrong. Treating non-finite as "no data" matches what
  // `externalActivityRecordTokens` already does upstream.
  const active = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (active.length === 0) return () => 0

  const log = (value: number): number => Math.log10(value + 1)
  const last = active.length - 1

  // Round the bounds INWARD — ceil at the bottom, floor at the top — so the
  // extreme samples fall outside the band wherever the sample is large enough
  // to have any. Rounding to nearest instead lets p95 land ON the outlier in a
  // small sample: with eleven days, `round(0.95 * 10)` is 10, i.e. the maximum
  // itself, and the clamp protects nothing.
  const loIndex = Math.min(Math.ceil(0.05 * last), last)
  const hiIndex = Math.max(Math.floor(0.95 * last), 0)
  // With very few samples the two can cross; fall back to the full range.
  let lo = log(active[Math.min(loIndex, hiIndex)])
  let hi = log(active[Math.max(loIndex, hiIndex)])
  if (hi - lo < MIN_RAMP_DECADES) {
    const middle = (hi + lo) / 2
    lo = middle - MIN_RAMP_DECADES / 2
    hi = middle + MIN_RAMP_DECADES / 2
  }
  const span = hi - lo

  return (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) return 0
    const position = Math.min(1, Math.max(0, (log(value) - lo) / span))
    return MIN_ACTIVE_INTENSITY + (1 - MIN_ACTIVE_INTENSITY) * position
  }
}

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sept',
  'Oct',
  'Nov',
  'Dec'
]

export interface DailyHeatmapProviderTotal {
  provider: string
  label: string
  tokens: number
  runs: number
}

export interface DailyHeatmapCell {
  /** Week index, 0 = oldest column. */
  column: number
  /** Weekday index, 0 = Sunday. */
  row: number
  /** 'YYYY-MM-DD', or null for a padding cell outside the window. */
  day: string | null
  /** Padding cells keep the rectangle square; they render invisible. */
  isOutsideWindow: boolean
  color: string | null
  intensity: number
  totalTokens: number
  runCount: number
  dominantProvider: ProviderId | null
  /** Every provider active that day, busiest first. Drives the tooltip. */
  providers: DailyHeatmapProviderTotal[]
}

export interface DailyHeatmapMonthLabel {
  /** Column the month's first full week starts at. */
  column: number
  label: string
}

export interface DailyHeatmapGrid {
  columns: number
  rows: number
  cells: DailyHeatmapCell[]
  monthLabels: DailyHeatmapMonthLabel[]
  startDay: string
  endDay: string
  totalTokens: number
  totalRuns: number
  /** Days in the window that saw any activity. */
  activeDays: number
}

function providerLabelFor(provider: string, labelFor: (id: string) => string): string {
  try {
    return labelFor(provider)
  } catch {
    return provider
  }
}

function providerBreakdown(
  totals: DailyUsageDayTotals | undefined,
  labelFor: (id: string) => string
): DailyHeatmapProviderTotal[] {
  if (!totals) return []
  return Object.entries(totals)
    .filter(([, value]) => value.tokens > 0 || value.runs > 0)
    .map(([provider, value]) => ({
      provider,
      label: providerLabelFor(provider, labelFor),
      tokens: value.tokens,
      runs: value.runs
    }))
    .sort((a, b) => {
      if (b.tokens !== a.tokens) return b.tokens - a.tokens
      if (b.runs !== a.runs) return b.runs - a.runs
      return a.provider.localeCompare(b.provider)
    })
}

export interface BuildDailyHeatmapGridOptions {
  /** Required for the same reason as the fold's: keeps the builder pure. */
  now: number
  dayCount?: number
  /** Canonical provider label lookup, injected so this module stays pure. */
  labelFor?: (id: string) => string
  /** Restrict tiles to one provider while leaving totals alone. */
  providerFilter?: ProviderId | 'all'
}

/**
 * Lay the window out as weekday rows x week columns.
 *
 * The first column is back-padded to the Sunday on or before the oldest day and
 * the last forward-padded past today, so the grid is a clean rectangle. Padding
 * cells are marked `isOutsideWindow` and render invisible rather than being
 * omitted, which would shear the columns.
 */
export function buildDailyHeatmapGrid(
  days: DailyUsageDays,
  options: BuildDailyHeatmapGridOptions
): DailyHeatmapGrid {
  const now = options.now
  const dayCount = Math.max(1, Math.round(options.dayCount ?? DAILY_USAGE_HEATMAP_DAYS))
  const labelFor = options.labelFor ?? ((id: string) => id)
  const filter = options.providerFilter ?? 'all'

  const windowKeys = dailyUsageDayKeyRange(now, dayCount)
  const startDay = windowKeys[0]
  const endDay = windowKeys[windowKeys.length - 1]

  const firstDate = new Date(now)
  firstDate.setHours(0, 0, 0, 0)
  firstDate.setDate(firstDate.getDate() - (dayCount - 1))
  const leadingBlanks = firstDate.getDay()

  const gridStart = new Date(firstDate)
  gridStart.setDate(gridStart.getDate() - leadingBlanks)
  const totalCells = Math.ceil((leadingBlanks + dayCount) / DAILY_HEATMAP_ROWS) * DAILY_HEATMAP_ROWS
  const columns = totalCells / DAILY_HEATMAP_ROWS

  const windowKeySet = new Set(windowKeys)

  // Build the ramp from the values actually being DRAWN, not from all-provider
  // totals. Those are the same thing unfiltered, but under a provider filter
  // the plotted value is that provider's share — normalising against the
  // all-provider peak made every day of a quiet provider render near the floor,
  // so filtering to it looked like it had barely been used at all.
  const tokensForDay = (key: string): number =>
    filter === 'all' ? dailyUsageDayTokens(days[key]) : (days[key]?.[filter]?.tokens ?? 0)
  const intensityFor = buildDailyIntensityRamp(windowKeys.map(tokensForDay))

  const cells: DailyHeatmapCell[] = []
  const monthLabels: DailyHeatmapMonthLabel[] = []
  let seenMonth = -1
  let totalTokens = 0
  let totalRuns = 0
  let activeDays = 0

  for (let index = 0; index < totalCells; index += 1) {
    const date = new Date(gridStart)
    date.setDate(gridStart.getDate() + index)
    const column = Math.floor(index / DAILY_HEATMAP_ROWS)
    const row = index % DAILY_HEATMAP_ROWS
    const key = dailyUsageDayKey(date)
    const inWindow = windowKeySet.has(key)

    if (inWindow && row === 0) {
      // Label a column when its week opens a month the axis has not shown yet.
      const month = date.getMonth()
      if (month !== seenMonth) {
        seenMonth = month
        monthLabels.push({ column, label: MONTH_LABELS[month] })
      }
    }

    if (!inWindow) {
      cells.push({
        column,
        row,
        day: null,
        isOutsideWindow: true,
        color: null,
        intensity: 0,
        totalTokens: 0,
        runCount: 0,
        dominantProvider: null,
        providers: []
      })
      continue
    }

    const totals = days[key]
    const dayTokens = dailyUsageDayTokens(totals)
    const dayRuns = dailyUsageDayRuns(totals)
    totalTokens += dayTokens
    totalRuns += dayRuns
    if (dayTokens > 0 || dayRuns > 0) activeDays += 1

    const providers = providerBreakdown(totals, labelFor)
    const dominant = dominantProviderForDay(totals, HEATMAP_PROVIDER_ORDER) as ProviderId | null

    // Filtering dims the tiles but never rewrites the tooltip or the totals —
    // the day's real composition is what the reader asked to see.
    const visible = filter === 'all' || providers.some((entry) => entry.provider === filter)
    // Same helper the ramp was built from, deliberately — not a second copy of
    // the expression. The ramp is only meaningful if it is scaled to exactly
    // the quantity it is later applied to, and two textually separate but
    // identical expressions are one careless edit away from disagreeing.
    const filteredTokens = tokensForDay(key)
    const filteredRuns = filter === 'all' ? dayRuns : (totals?.[filter]?.runs ?? 0)

    let intensity = 0
    if (visible && filteredTokens > 0) {
      intensity = intensityFor(filteredTokens)
    } else if (visible && filteredRuns > 0) {
      intensity = MARKER_INTENSITY
    }

    const accent = filter === 'all' ? dominant : filter
    cells.push({
      column,
      row,
      day: key,
      isOutsideWindow: false,
      color: intensity > 0 && accent ? (HEATMAP_PROVIDER_COLOR_HEX[accent] ?? null) : null,
      intensity: Math.min(1, intensity),
      totalTokens: dayTokens,
      runCount: dayRuns,
      dominantProvider: dominant,
      providers
    })
  }

  return {
    columns,
    rows: DAILY_HEATMAP_ROWS,
    cells,
    monthLabels,
    startDay,
    endDay,
    totalTokens,
    totalRuns,
    activeDays
  }
}

const COMPACT_UNITS: Array<{ limit: number; divisor: number; suffix: string }> = [
  { limit: 1_000_000_000, divisor: 1_000_000_000, suffix: 'B' },
  { limit: 1_000_000, divisor: 1_000_000, suffix: 'M' },
  { limit: 1_000, divisor: 1_000, suffix: 'K' }
]

/** Compact token count for chips and tooltips: 1.2M, 940K, 812. */
export function formatDailyTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  for (const unit of COMPACT_UNITS) {
    if (value >= unit.limit) {
      const scaled = value / unit.divisor
      return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)}${unit.suffix}`
    }
  }
  return String(Math.round(value))
}

/** Human date for a tooltip: "Mon 10 Jun 2026". */
export function formatDailyHeatmapDate(dayKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return dayKey
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
}

/**
 * Tooltip text for one day.
 *
 * States EVERY provider's total for that day, not just the winner's — the
 * accent already says who dominated, and hiding the rest would make a mixed day
 * unreadable. Newlines survive in a native `title`, which is what the 90-day
 * heatmap uses too.
 */
export function describeDailyHeatmapCell(cell: DailyHeatmapCell): string | undefined {
  if (cell.isOutsideWindow || !cell.day) return undefined
  const date = formatDailyHeatmapDate(cell.day)
  if (cell.providers.length === 0) return `${date}\nNo activity`

  const lines = [date]
  lines.push(
    cell.totalTokens > 0
      ? `${formatDailyTokenCount(cell.totalTokens)} tokens · ${cell.runCount} call${cell.runCount === 1 ? '' : 's'}`
      : `${cell.runCount} activity marker${cell.runCount === 1 ? '' : 's'}`
  )
  for (const entry of cell.providers) {
    lines.push(
      entry.tokens > 0
        ? `  ${entry.label} — ${formatDailyTokenCount(entry.tokens)} · ${entry.runs} call${entry.runs === 1 ? '' : 's'}`
        : `  ${entry.label} — ${entry.runs} marker${entry.runs === 1 ? '' : 's'}`
    )
  }
  return lines.join('\n')
}
