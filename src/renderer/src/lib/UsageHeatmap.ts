/*
 * UsageHeatmap — Phase L6 slice 5.
 *
 * Pure helper that buckets `UsageRecord` events into a day-count × 12
 * (2-hour) grid for the activity heatmap, plus computes per-cell
 * colour and opacity. Mirrors another-project's
 * `LLMActivityHeatmapView` bucketing (`Shared/Views/
 * LLMActivityHeatmapView.swift`).
 *
 * Pure module — no React, no DOM. Easy to unit-test the bucket
 * coordinates and the colour-mixing logic.
 */

import type { ProviderId, UsageRecord } from '../../../main/store/types'
import {
  externalActivityRecordTokens,
  externalActivityWindowBounds
} from '../../../shared/usageAccounting'

export const HEATMAP_COLUMNS = 30 // days (default sidebar window)
export const HEATMAP_ROWS = 12 // 2-hour buckets per day (00-02, 02-04, …, 22-24)
const BUCKET_HOURS = 24 / HEATMAP_ROWS
const MAX_HEATMAP_COLUMNS = 180

/** Per-provider hex used for colouring heatmap cells. Mirrors the
 * Limit Counter palette + the TaskWraith `--provider-{id}-color`
 * theme tokens so the heatmap reads as a sibling of the bars
 * above it. */
export const HEATMAP_PROVIDER_COLOR_HEX: Record<ProviderId, string> = {
  gemini: '#346EEC',
  codex: '#705AFF',
  claude: '#B16105',
  kimi: '#0073E6',
  grok: '#757575',
  cursor: '#8D7312',
  ollama: '#1A8562'
}

export interface HeatmapCell {
  /** 0..columns-1 — 0 is the OLDEST day, columns-1 is today. */
  column: number
  /** 0..HEATMAP_ROWS-1 — 0 is `00:00-02:00`, 11 is `22:00-24:00`. */
  row: number
  /** Hex string for the cell fill. Empty cells return null so the
   * caller can render a neutral background. */
  color: string | null
  /** 0..1 opacity multiplier. 0 = empty cell; 1 = highest-intensity
   * cell in this grid. Intensity is logarithmic on token-count so a
   * 100k-token spike doesn't drown out a normal 1k-token call. */
  intensity: number
  /** Cumulative tokens across all events in this bucket. */
  totalTokens: number
  /** Number of events in this bucket — used for tooltip text. */
  eventCount: number
  /** Dominant provider in the bucket (most tokens). `null` when no
   * events landed in this bucket. */
  dominantProvider: ProviderId | null
}

export interface HeatmapGrid {
  /** Number of day columns in the rendered window. */
  columns: number
  cells: HeatmapCell[]
  /** Token totals across known time windows, derived from the same
   * event list so the header chips don't need an independent query. */
  totals: {
    last24h: number
    last7d: number
    last30d: number
    window: number
  }
  /** ISO date of the column-0 origin (the oldest column shown). */
  startDay: string
  /** ISO date of the last-column (today) anchor. */
  endDay: string
}

export type HeatmapProviderFilter = 'all' | ProviderId

/**
 * Bucket usage records into the day-count × 12 heatmap grid relative to a
 * reference `now`. Records older than the requested window are dropped; future-
 * timestamped records (clock skew) are dropped too. Column 0 is the
 * oldest day shown; column `columns - 1` is the day containing `now`.
 */
export function buildHeatmapGrid(
  records: UsageRecord[],
  now: Date = new Date(),
  columnCount: number = HEATMAP_COLUMNS
): HeatmapGrid {
  const columns = Math.max(1, Math.min(MAX_HEATMAP_COLUMNS, Math.round(columnCount)))
  // Shared with `buildExternalUsageRollup`, which feeds paired devices the same
  // chip values. Keep both on this one definition or the two surfaces drift.
  const { startMs, endMs } = externalActivityWindowBounds(now, columns)
  const oneDayMs = 24 * 60 * 60 * 1000

  // Phase 1: aggregate per-bucket token totals + per-provider sums.
  const cellMap = new Map<
    string,
    {
      totalTokens: number
      visualWeight: number
      eventCount: number
      providerTokens: Map<ProviderId, number>
    }
  >()
  let last24h = 0
  let last7d = 0
  let last30d = 0
  let window = 0
  const now24hMs = now.getTime() - 24 * 60 * 60 * 1000
  const now7dMs = now.getTime() - 7 * oneDayMs
  const now30dMs = now.getTime() - 30 * oneDayMs

  for (const record of records) {
    if (record.usageKind === 'reset_hint') continue
    if (!Number.isFinite(record.timestamp)) continue
    if (record.timestamp < startMs || record.timestamp > endMs) continue
    const tokens = externalActivityRecordTokens(record)
    // External-provider activity sources such as Cursor can report "used in
    // this bucket" without a token estimate. Keep those cells visible while
    // leaving token totals honest at zero.
    const visualWeight = tokens > 0 ? tokens : 50

    const eventDate = new Date(record.timestamp)
    const dayOffset = Math.floor((eventDate.getTime() - startMs) / oneDayMs)
    const column = Math.max(0, Math.min(columns - 1, dayOffset))
    const row = Math.max(
      0,
      Math.min(HEATMAP_ROWS - 1, Math.floor(eventDate.getHours() / BUCKET_HOURS))
    )
    const key = `${column}-${row}`
    let bucket = cellMap.get(key)
    if (!bucket) {
      bucket = { totalTokens: 0, visualWeight: 0, eventCount: 0, providerTokens: new Map() }
      cellMap.set(key, bucket)
    }
    bucket.totalTokens += tokens
    bucket.visualWeight += visualWeight
    bucket.eventCount += 1
    if (record.provider) {
      bucket.providerTokens.set(
        record.provider,
        (bucket.providerTokens.get(record.provider) ?? 0) + visualWeight
      )
    }

    window += tokens
    if (record.timestamp >= now30dMs) last30d += tokens
    if (record.timestamp >= now7dMs) last7d += tokens
    if (record.timestamp >= now24hMs) last24h += tokens
  }

  // Phase 2: figure out the max bucket weight so intensity
  // normalises against the brightest cell in this grid. Logarithmic
  // scaling keeps a single 100k spike from washing out everything
  // else — a bucket with 10× the tokens of another reads as
  // ~1.3× more intense, not 10×.
  let maxLogWeight = 0
  for (const bucket of cellMap.values()) {
    const weight = Math.log10(bucket.visualWeight + 1)
    if (weight > maxLogWeight) maxLogWeight = weight
  }

  // Phase 3: emit cells for every (column, row) in the grid. 1.0.6-CRUX43 —
  // ROW-MAJOR order (hour-bucket OUTER, day INNER) is load-bearing: the grid
  // renders `grid-template-columns: repeat(HEATMAP_COLUMNS, 1fr)` + auto-flow
  // row, so each grid ROW must be one hour-bucket spanning all days. That puts
  // Days on the X axis and Hours on the Y axis — matching the hour labels on the
  // left rail. (Previously column-major, which scrambled the axes vs the labels.)
  const cells: HeatmapCell[] = []
  for (let row = 0; row < HEATMAP_ROWS; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const key = `${column}-${row}`
      const bucket = cellMap.get(key)
      if (!bucket) {
        cells.push({
          column,
          row,
          color: null,
          intensity: 0,
          totalTokens: 0,
          eventCount: 0,
          dominantProvider: null
        })
        continue
      }
      const weight = Math.log10(bucket.visualWeight + 1)
      const intensity =
        bucket.totalTokens > 0
          ? maxLogWeight > 0
            ? Math.max(0.18, weight / maxLogWeight)
            : 0
          : 0.24
      // Dominant provider = the one contributing the most tokens to
      // this bucket. Ties broken by deterministic provider order.
      let dominantProvider: ProviderId | null = null
      let dominantTokens = -1
      for (const [providerId, providerTokens] of bucket.providerTokens.entries()) {
        if (providerTokens > dominantTokens) {
          dominantTokens = providerTokens
          dominantProvider = providerId
        }
      }
      cells.push({
        column,
        row,
        color: dominantProvider ? HEATMAP_PROVIDER_COLOR_HEX[dominantProvider] : null,
        intensity,
        totalTokens: bucket.totalTokens,
        eventCount: bucket.eventCount,
        dominantProvider
      })
    }
  }

  return {
    columns,
    cells,
    totals: { last24h, last7d, last30d, window },
    startDay: new Date(startMs).toISOString().slice(0, 10),
    endDay: new Date(endMs).toISOString().slice(0, 10)
  }
}

/**
 * Build a provider-scoped visual grid while keeping header totals anchored to
 * the full source dataset. The welcome heatmap tabs use this so "Codex" reveals
 * Codex-only tiles, but the 24h / 7D / 90D chips remain all-provider totals.
 */
export function buildProviderFilteredHeatmapGrid(
  records: UsageRecord[],
  now: Date = new Date(),
  columnCount: number = HEATMAP_COLUMNS,
  providerFilter: HeatmapProviderFilter = 'all'
): HeatmapGrid {
  const allProviderGrid = buildHeatmapGrid(records, now, columnCount)
  if (providerFilter === 'all') return allProviderGrid

  const filteredGrid = buildHeatmapGrid(
    records.filter((record) => record.provider === providerFilter),
    now,
    columnCount
  )
  return {
    ...filteredGrid,
    totals: allProviderGrid.totals
  }
}

/** Format a token count for the header chips (1.5K / 12.3M / etc.). */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1000) return Math.round(value).toString()
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}K`
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`
  return `${(value / 1_000_000_000).toFixed(2)}B`
}
