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
 * folded OVER it through the same shared rule main uses: the live window
 * replaces the days it covers, the rollup keeps everything older. The recent
 * end is therefore always current and the far end always present.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ProviderId, UsageRecord } from '../../../main/store/types'
import {
  DAILY_USAGE_HEATMAP_DAYS,
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
 * Mirrors `DEFAULT_LOOKBACK_DAYS` in `src/main/ExternalProviderActivity.ts`.
 * Restated rather than imported: `guard:architecture` admits no renderer edge
 * into main. It only has to be an UNDER-estimate to stay correct — a shorter
 * window means the fold trusts the rollup for a few more days, never that it
 * overwrites days the live records did not really cover.
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
  const [rollupDays, setRollupDays] = useState<DailyUsageDays>(providedRollupDays ?? {})
  const [externalRecords, setExternalRecords] = useState<UsageRecord[]>(
    providedExternalRecords ?? []
  )
  const [providerFilter, setProviderFilter] = useState<HeatmapProviderFilter>('all')

  useEffect(() => {
    if (providedRollupDays) {
      setRollupDays(providedRollupDays)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const payload = await window.api?.getDailyUsageRollup?.()
        if (!cancelled && payload?.days) setRollupDays(payload.days)
      } catch {
        // The live-record overlay below still renders the recent window.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [providedRollupDays, refreshKey])

  useEffect(() => {
    if (providedExternalRecords) {
      setExternalRecords(providedExternalRecords)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const records = await loadRendererUsageRecords('external')
        if (!cancelled) setExternalRecords(records)
      } catch {
        // Rollup-only is a valid render.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [providedExternalRecords, refreshKey])

  const grid = useMemo(() => {
    const now = Date.now()
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
