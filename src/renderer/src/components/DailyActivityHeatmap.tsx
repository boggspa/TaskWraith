/*
 * DailyActivityHeatmap — the 365-day calendar grid.
 *
 * A sibling of `UsageHeatmap`, not a variant of it. That one draws day columns
 * against 2-hour rows and clamps at 180 columns; this draws ONE CELL PER DAY on
 * weekday rows and week columns, so a year reads as ~53 columns.
 *
 * DATA PATH, and why it is two sources rather than one. The persisted daily
 * rollup holds the long tail — days the 90-day scan can no longer reach — but
 * it is only as fresh as the last completed scan, and on a new install it is
 * empty until one finishes. So the live records the renderer already has are
 * folded OVER it through the same shared rule main uses.
 *
 * That fold is PER PROVIDER and treats absence as "not observed" rather than
 * "zero", which is what makes this safe: the renderer knows how far back it
 * ASKED to look but not how far the records actually reach, and an earlier
 * per-day version of the rule deleted 75 days of real history on a real corpus
 * because of exactly that gap. See `dailyUsageRollup.ts`.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, UsageRecord } from '../../../main/store/types'
import {
  DAILY_USAGE_HEATMAP_DAYS,
  dailyUsageDayBounds,
  dailyUsageDayKey,
  foldUsageRecordsIntoDailyRollup,
  type DailyUsageDays
} from '../../../shared/dailyUsageRollup'
import {
  DAILY_HEATMAP_ROWS,
  buildDailyHeatmapGrid,
  describeDailyHeatmapCell,
  formatDailyTokenCount,
  type DailyHeatmapCell
} from '../lib/DailyActivityHeatmap'
import { HEATMAP_PROVIDER_FILTERS, type HeatmapProviderFilter } from '../lib/UsageHeatmap'
import { getProviderLabel } from '../lib/providerLabels'
import { loadRendererUsageRecords } from '../lib/usageRecordsCache'
import { buildExternalActivityPresentationRecords } from '../lib/externalActivityPresentation'

/**
 * How far back the live records are treated as a possible CORRECTION rather
 * than merely an addition. Mirrors `DEFAULT_LOOKBACK_DAYS` in
 * `src/main/ExternalProviderActivity.ts`, restated because
 * `guard:architecture` admits no renderer edge into main.
 *
 * An earlier version of this file claimed authority over the whole window and
 * deleted every day inside it that the records did not mention — measured
 * against a real corpus, records spanned 15 days against this 90, so 75 days
 * of real history vanished from the chart. The fold is now per-provider and
 * monotonic: absence means "not observed", zero markers cannot erase spend,
 * and repeated overlays remain idempotent rather than additive.
 */
const EXTERNAL_SCAN_WINDOW_DAYS = 90

const MS_PER_DAY = 86_400_000

function DailyHeatmapCellTile({ cell }: { cell: DailyHeatmapCell }) {
  const style: React.CSSProperties = {
    gridColumn: cell.column + 1,
    gridRow: cell.row + 1
  }
  if (cell.color) {
    style.backgroundColor = cell.color
    style.opacity = cell.intensity
  }
  return (
    <span
      className="daily-heatmap-cell"
      data-empty={cell.color ? undefined : 'true'}
      data-outside={cell.isOutsideWindow ? 'true' : undefined}
      style={style}
      title={describeDailyHeatmapCell(cell)}
    />
  )
}

export interface DailyActivityHeatmapProps {
  refreshKey?: number
  showHeader?: boolean
  dayCount?: number
  title?: string
  ariaLabel?: string
  showProviderFilter?: boolean
  className?: string
  /** TaskWraith records, merged in for providers with no scanner lane. */
  supplementalTaskWraithRecords?: UsageRecord[]
  /** Pre-resolved data. Test seam; production loads over IPC. */
  rollupDays?: DailyUsageDays
  externalRecords?: UsageRecord[]
}

export function DailyActivityHeatmap({
  refreshKey = 0,
  showHeader = true,
  dayCount = DAILY_USAGE_HEATMAP_DAYS,
  title = 'External Activity',
  ariaLabel,
  showProviderFilter = false,
  className,
  supplementalTaskWraithRecords,
  rollupDays: providedRollupDays,
  externalRecords: providedExternalRecords
}: DailyActivityHeatmapProps) {
  const [loadedRollupDays, setLoadedRollupDays] = useState<DailyUsageDays>({})
  const [loadedExternalRecords, setLoadedExternalRecords] = useState<UsageRecord[]>([])
  const [providerFilter, setProviderFilter] = useState<HeatmapProviderFilter>('all')

  // Props win outright rather than being mirrored into state — a setState in an
  // effect body just to copy a prop is a cascading render for nothing.
  const rollupDays = providedRollupDays ?? loadedRollupDays
  const externalRecords = providedExternalRecords ?? loadedExternalRecords

  useEffect(() => {
    if (providedRollupDays) return
    let cancelled = false
    void (async () => {
      try {
        const payload = await window.api?.getDailyUsageRollup?.()
        if (!cancelled && payload?.days) setLoadedRollupDays(payload.days)
      } catch {
        // The live-record overlay below still renders the recent window.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [providedRollupDays, refreshKey])

  useEffect(() => {
    if (providedExternalRecords) return
    let cancelled = false
    void (async () => {
      try {
        const records = await loadRendererUsageRecords('external')
        if (!cancelled) setLoadedExternalRecords(records)
      } catch {
        // Rollup-only is a valid render.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [providedExternalRecords, refreshKey])

  const grid = useMemo(() => {
    // `new Date()` inside the memo, as the sibling heatmap and token chart do:
    // the memo only re-runs when its inputs change, and `Date.now` in the
    // render body is an impure call the lint rule rightly refuses.
    const now = dailyUsageDayBounds(dailyUsageDayKey(new Date()))?.endMs ?? new Date().getTime()
    const presentation = buildExternalActivityPresentationRecords(
      externalRecords,
      supplementalTaskWraithRecords ?? []
    )
    const days =
      presentation.length > 0
        ? foldUsageRecordsIntoDailyRollup(rollupDays, presentation, {
            observedFromMs: now - EXTERNAL_SCAN_WINDOW_DAYS * MS_PER_DAY,
            observedToMs: now,
            now
          })
        : rollupDays
    return buildDailyHeatmapGrid(days, {
      now,
      dayCount,
      labelFor: (id) => getProviderLabel(id as ProviderId),
      providerFilter
    })
  }, [rollupDays, externalRecords, supplementalTaskWraithRecords, dayCount, providerFilter])

  const rootClassName = [
    'daily-heatmap',
    showProviderFilter ? 'daily-heatmap--with-filter' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClassName} aria-label={ariaLabel || `${title} 365-day activity heatmap`}>
      {showHeader && (
        <div className="daily-heatmap-header">
          <span className="daily-heatmap-title">{title}</span>
          {showProviderFilter && (
            <div className="daily-heatmap-provider-filter" aria-label={`${title} provider filter`}>
              {HEATMAP_PROVIDER_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={providerFilter === filter.id}
                  className={`daily-heatmap-provider-filter-tab provider-${filter.id}`}
                  data-active={providerFilter === filter.id ? 'true' : undefined}
                  onClick={() => setProviderFilter(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          )}
          <span className="daily-heatmap-chips" aria-label={`${title} all-provider totals`}>
            <span className="daily-heatmap-chip">
              365D <strong>{formatDailyTokenCount(grid.totalTokens)}</strong>
            </span>
            <span className="daily-heatmap-chip">
              {grid.activeDays} active {grid.activeDays === 1 ? 'day' : 'days'}
            </span>
          </span>
        </div>
      )}
      <div className="daily-heatmap-grid-wrapper">
        <div
          className="daily-heatmap-grid"
          style={{
            gridTemplateColumns: `repeat(${grid.columns}, 1fr)`,
            gridTemplateRows: `repeat(${DAILY_HEATMAP_ROWS}, 1fr)`
          }}
        >
          {grid.cells.map((cell) => (
            <DailyHeatmapCellTile key={`${cell.column}-${cell.row}`} cell={cell} />
          ))}
        </div>
        <div
          className="daily-heatmap-month-axis"
          style={{ gridTemplateColumns: `repeat(${grid.columns}, 1fr)` }}
          aria-hidden
        >
          {grid.monthLabels.map((entry) => (
            <span
              key={`${entry.column}-${entry.label}`}
              className="daily-heatmap-month-label"
              style={{ gridColumn: entry.column + 1 }}
            >
              {entry.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export default DailyActivityHeatmap
