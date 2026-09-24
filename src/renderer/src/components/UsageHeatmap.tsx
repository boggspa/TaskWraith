/*
 * UsageHeatmap — Phase L6 slice 5.
 *
 * The 30-day × 12-bucket activity grid that sits at the foot of
 * the Model Usage Card. Each cell is a small rounded rect coloured
 * by the dominant provider in that 2-hour bucket; opacity scales
 * with token volume (logarithmic) so a single spike doesn't drown
 * out everyday usage.
 *
 * Data path: pull all `UsageRecord` entries via the existing
 * `window.api.getUsage` IPC, run them through the pure
 * `buildHeatmapGrid` helper, render the grid + the 24h / 7D / window
 * total chips.
 *
 * Mirrors another-project's `LLMActivityHeatmapView`
 * (`Shared/Views/LLMActivityHeatmapView.swift`) — same 30×12
 * grid dimensions, same per-bucket dominant-provider colouring.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { UsageRecord } from '../../../main/store/types'
import { DigitOdometer } from './DigitOdometer'
import {
  buildHeatmapGrid,
  buildProviderFilteredHeatmapGrid,
  formatTokenCount,
  HEATMAP_COLUMNS,
  HEATMAP_PROVIDER_FILTERS,
  HEATMAP_ROWS,
  type HeatmapProviderFilter,
  type HeatmapCell,
  type HeatmapGrid
} from '../lib/UsageHeatmap'
import { resolveWithinDeadline } from '../lib/backgroundHydration'
import {
  getCachedRendererUsageRecords,
  loadRendererUsageRecords,
  setCachedRendererUsageRecords,
  type RendererUsageSource
} from '../lib/usageRecordsCache'
import { buildExternalActivityPresentationRecords } from '../lib/externalActivityPresentation'

const TIME_LABELS = ['00', '04', '08', '12', '16', '20'] // hour-of-day ticks shown on the left rail
const HEATMAP_LOAD_DEADLINE_MS = 1_000
/** A single cell. Pulled out so React.memo can short-circuit
 * re-renders when the cell's bucket data hasn't changed. */
function HeatmapCellTile({ cell }: { cell: HeatmapCell }) {
  const intensityPercent = `${Math.round(cell.intensity * 100)}%`
  const style = cell.color
    ? ({
        '--usage-heatmap-cell-color': cell.color,
        '--usage-heatmap-cell-opacity': cell.intensity,
        '--usage-heatmap-cell-strength': intensityPercent,
        '--usage-heatmap-cell-rim': `${Math.round(24 + cell.intensity * 64)}%`,
        '--usage-heatmap-cell-glow': `${Math.round(cell.intensity * 22)}%`
      } as CSSProperties)
    : undefined
  return (
    <span
      className="usage-heatmap-cell"
      data-empty={cell.color ? undefined : 'true'}
      data-column={cell.column}
      data-row={cell.row}
      style={style}
      title={
        cell.eventCount > 0
          ? cell.totalTokens > 0
            ? `${formatTokenCount(cell.totalTokens)} tokens · ${cell.eventCount} call${cell.eventCount === 1 ? '' : 's'}`
            : `${cell.eventCount} activity marker${cell.eventCount === 1 ? '' : 's'}`
          : undefined
      }
    />
  )
}

function TokenCountOdometer({ value }: { value: number }) {
  const compact = formatTokenCount(value)
  const parts = /^(\d+)(?:\.(\d+))?([KMB])?$/.exec(compact)
  if (!parts) return <>{compact}</>

  const fraction = parts[2] ?? ''
  const scaledValue = Number(`${parts[1]}${fraction}`)
  const suffix = parts[3]

  return (
    <span
      className="usage-heatmap-token-count"
      role="img"
      aria-label={`${Math.max(0, Math.round(value)).toLocaleString()} tokens`}
    >
      <span aria-hidden>
        <DigitOdometer value={scaledValue} decimalPlaces={fraction.length} />
        {suffix && <span className="usage-heatmap-token-suffix">{suffix}</span>}
      </span>
    </span>
  )
}

interface UsageHeatmapProps {
  /** Refresh trigger — when the parent re-fetches usage records
   * (e.g. after a turn completes), bumping this value forces the
   * heatmap to re-query. Defaults to a stable timestamp so the
   * heatmap only loads once on mount when omitted. */
  refreshKey?: number
  /** Render the "Activity" title + 24h / 7D / rendered-window total chips. The
   * sidebar Model Usage card surfaces them inline; embeds in the
   * welcome dashboard (where total-tokens already lives in the
   * headline stat grid above) hide the header to avoid duplication.
   * Defaults to true. */
  showHeader?: boolean
  /** Number of day columns to render. Defaults to the sidebar's 30-day window. */
  dayCount?: number
  /** Data source for the rendered grid. */
  usageSource?: RendererUsageSource
  /** Optional caller-owned records. When present no IPC fetch is performed. */
  records?: UsageRecord[]
  /** TaskWraith-owned records to include for providers that the external
   * scanner cannot observe. They are projected after the raw external fetch,
   * so this does not change external hydration work. */
  supplementalTaskWraithRecords?: UsageRecord[]
  /** Header title. Defaults to the original TaskWraith "Activity" label. */
  title?: string
  /** Optional accessible label override. */
  ariaLabel?: string
  /** Show a compact provider-isolation segmented control in the header. */
  showProviderFilter?: boolean
  /** Class name appended to the root `<div>` — lets callers retune
   * sizing without forking the component. */
  className?: string
}

export function UsageHeatmap({
  refreshKey = 0,
  showHeader = true,
  dayCount = HEATMAP_COLUMNS,
  usageSource = 'taskwraith',
  records: providedRecords,
  supplementalTaskWraithRecords,
  title = 'Activity',
  ariaLabel,
  showProviderFilter = false,
  className
}: UsageHeatmapProps) {
  // PRE-WARM: seed from the per-source cache (if any) via a lazy
  // initializer so a remount paints the retained grid synchronously on the
  // first render — before the IPC fetch below resolves — instead of
  // flashing an empty grid. Falls back to [] on the very first ever fetch.
  const [fetched, setFetched] = useState<{ source: RendererUsageSource; records: UsageRecord[] }>(
    () => ({
      source: usageSource,
      records: providedRecords ?? getCachedRendererUsageRecords(usageSource)
    })
  )
  const [loading, setLoading] = useState(false)
  const [providerFilter, setProviderFilter] = useState<HeatmapProviderFilter>('all')

  useEffect(() => {
    if (providedRecords) {
      setCachedRendererUsageRecords(usageSource, providedRecords)
    }
  }, [providedRecords, usageSource])

  useEffect(() => {
    if (providedRecords) return
    let cancelled = false
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return
      setLoading(true)
      resolveWithinDeadline(
        loadRendererUsageRecords(usageSource),
        getCachedRendererUsageRecords(usageSource),
        HEATMAP_LOAD_DEADLINE_MS
      )
        .then((latest) => {
          if (!cancelled) setFetched({ source: usageSource, records: latest })
        })
        .catch(() => {
          // Best-effort: render an empty heatmap rather than crashing
          // the whole card if the IPC fails. Leave any cached grid in
          // place — don't clobber a good cache on a transient failure.
          if (!cancelled) {
            setFetched({ source: usageSource, records: getCachedRendererUsageRecords(usageSource) })
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
    }
  }, [providedRecords, refreshKey, usageSource])

  const rawDisplayRecords =
    providedRecords ??
    (fetched.source === usageSource ? fetched.records : getCachedRendererUsageRecords(usageSource))
  const displayRecords = useMemo(
    () =>
      usageSource === 'external'
        ? buildExternalActivityPresentationRecords(
            rawDisplayRecords,
            supplementalTaskWraithRecords ?? []
          )
        : rawDisplayRecords,
    [rawDisplayRecords, supplementalTaskWraithRecords, usageSource]
  )
  const grid: HeatmapGrid = useMemo(
    () =>
      showProviderFilter
        ? buildProviderFilteredHeatmapGrid(displayRecords, new Date(), dayCount, providerFilter)
        : buildHeatmapGrid(displayRecords, new Date(), dayCount),
    [displayRecords, dayCount, showProviderFilter, providerFilter]
  )
  const windowLabel = grid.columns === HEATMAP_COLUMNS ? '30D' : `${grid.columns}D`
  const rootClassName = [
    'usage-heatmap',
    showProviderFilter ? 'usage-heatmap--with-provider-filter' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClassName} aria-label={ariaLabel || `${title} usage activity heatmap`}>
      {showHeader && (
        <div className="usage-heatmap-header">
          <span className="usage-heatmap-title">{title}</span>
          {showProviderFilter && (
            <div className="usage-heatmap-provider-filter" aria-label={`${title} provider filter`}>
              {HEATMAP_PROVIDER_FILTERS.map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  aria-pressed={providerFilter === filter.id}
                  className={`usage-heatmap-provider-filter-tab provider-${filter.id}`}
                  data-active={providerFilter === filter.id ? 'true' : undefined}
                  onClick={() => setProviderFilter(filter.id)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          )}
          <span className="usage-heatmap-chips" aria-label={`${title} all-provider totals`}>
            <span className="usage-heatmap-chip">
              24h{' '}
              <strong>
                <TokenCountOdometer value={grid.totals.last24h} />
              </strong>
            </span>
            <span className="usage-heatmap-chip">
              7D{' '}
              <strong>
                <TokenCountOdometer value={grid.totals.last7d} />
              </strong>
            </span>
            <span className="usage-heatmap-chip">
              {windowLabel}{' '}
              <strong>
                <TokenCountOdometer value={grid.totals.window} />
              </strong>
            </span>
          </span>
        </div>
      )}
      <div className="usage-heatmap-grid-wrapper" aria-busy={providedRecords ? false : loading}>
        <div className="usage-heatmap-time-labels" aria-hidden>
          {TIME_LABELS.map((label) => (
            <span key={label} className="usage-heatmap-time-label">
              {label}
            </span>
          ))}
        </div>
        <div
          className="usage-heatmap-grid"
          style={{
            aspectRatio: `${grid.columns} / ${HEATMAP_ROWS}`,
            gridTemplateColumns: `repeat(${grid.columns}, 1fr)`,
            gridTemplateRows: `repeat(${HEATMAP_ROWS}, 1fr)`
          }}
        >
          {grid.cells.map((cell) => (
            <HeatmapCellTile key={`${cell.column}-${cell.row}`} cell={cell} />
          ))}
        </div>
      </div>
    </div>
  )
}
