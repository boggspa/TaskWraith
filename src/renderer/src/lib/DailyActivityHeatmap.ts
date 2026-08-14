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
 * still visibly distinct from an empty one. */
const MIN_ACTIVE_INTENSITY = 0.2

/** Token-less activity (Cursor daily rows, Codex SQLite markers) reads as a
 * definite but modest mark rather than borrowing the busiest day's weight. */
const MARKER_INTENSITY = 0.26

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
  now?: number
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
  options: BuildDailyHeatmapGridOptions = {}
): DailyHeatmapGrid {
  const now = options.now ?? Date.now()
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

  // Peak weight sets the top of the ramp. Logarithmic, so one enormous day does
  // not flatten a year of ordinary ones into a single dim shade.
  let maxTokens = 0
  for (const key of windowKeys) {
    const tokens = dailyUsageDayTokens(days[key])
    if (tokens > maxTokens) maxTokens = tokens
  }
  const maxLog = Math.log10(maxTokens + 1) || 1

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
    const filteredTokens = filter === 'all' ? dayTokens : (totals?.[filter]?.tokens ?? 0)
    const filteredRuns = filter === 'all' ? dayRuns : (totals?.[filter]?.runs ?? 0)

    let intensity = 0
    if (visible && filteredTokens > 0) {
      intensity = Math.max(MIN_ACTIVE_INTENSITY, Math.log10(filteredTokens + 1) / maxLog)
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
