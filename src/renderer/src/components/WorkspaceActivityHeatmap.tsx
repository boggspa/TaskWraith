import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { WorkspaceActivitySnapshot } from '../../../main/store/types'
import { HEATMAP_ROWS } from '../lib/UsageHeatmap'
import {
  buildWorkspaceActivityHeatmapGrid,
  formatActivityCount,
  type WorkspaceActivityHeatmapCell
} from '../lib/WorkspaceActivityHeatmap'

const TIME_LABELS = ['00', '04', '08', '12', '16', '20']
const WORKSPACE_ACTIVITY_IPC_DEADLINE_MS = 1_000
const WORKSPACE_ACTIVITY_HEATMAP_GREEN = '#39d353'

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

function scheduleWorkspaceActivityRefresh(callback: () => void): () => void {
  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 700 })
    return () => idleWindow.cancelIdleCallback?.(handle)
  }
  const handle = window.setTimeout(callback, 0)
  return () => window.clearTimeout(handle)
}

function emptyWorkspaceActivitySnapshot(
  workspacePath: string,
  dayCount: number
): WorkspaceActivitySnapshot {
  return {
    workspacePath,
    dayCount,
    generatedAt: Date.now(),
    source: 'none',
    truncated: false,
    events: [],
    stats: {
      gitRepo: false,
      commits: 0,
      worktreeFiles: 0,
      filesystemFiles: 0,
      scannedFiles: 0,
      scanLimit: 5_000
    }
  }
}

/** A renderer-side belt and braces for an interrupted/stale main process.
 * The current main handler returns a cache placeholder immediately, but a
 * heatmap must remain paintable even if an older IPC request never settles. */
function loadWorkspaceActivityWithoutBlocking(
  workspacePath: string,
  dayCount: number
): Promise<WorkspaceActivitySnapshot> {
  const fallback = emptyWorkspaceActivitySnapshot(workspacePath, dayCount)
  return new Promise((resolve) => {
    let settled = false
    const finish = (snapshot: WorkspaceActivitySnapshot): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      resolve(snapshot)
    }
    const timeout = window.setTimeout(() => finish(fallback), WORKSPACE_ACTIVITY_IPC_DEADLINE_MS)
    window.api
      .getWorkspaceActivity(workspacePath, dayCount)
      .then((snapshot) => finish(snapshot))
      .catch(() => finish(fallback))
  })
}

function WorkspaceActivityCellTile({ cell }: { cell: WorkspaceActivityHeatmapCell }) {
  const intensityPercent = `${Math.round(cell.intensity * 100)}%`
  const style = cell.active
    ? ({
        '--usage-heatmap-cell-color': WORKSPACE_ACTIVITY_HEATMAP_GREEN,
        '--usage-heatmap-cell-opacity': cell.intensity,
        '--usage-heatmap-cell-strength': intensityPercent,
        '--usage-heatmap-cell-rim': `${Math.round(24 + cell.intensity * 64)}%`,
        '--usage-heatmap-cell-glow': `${Math.round(cell.intensity * 22)}%`
      } as CSSProperties)
    : undefined
  return (
    <span
      className="usage-heatmap-cell workspace-activity-heatmap-cell"
      data-empty={cell.active ? undefined : 'true'}
      data-column={cell.column}
      data-row={cell.row}
      style={style}
      title={
        cell.count > 0
          ? `${formatActivityCount(cell.count)} workspace activity marker${cell.count === 1 ? '' : 's'}`
          : undefined
      }
    />
  )
}

interface WorkspaceActivityHeatmapProps {
  workspacePath: string
  dayCount?: number
  refreshKey?: number
  className?: string
}

export function WorkspaceActivityHeatmap({
  workspacePath,
  dayCount = 90,
  refreshKey = 0,
  className
}: WorkspaceActivityHeatmapProps) {
  const [snapshot, setSnapshot] = useState<WorkspaceActivitySnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    let requestId = 0
    setSnapshot(null)

    const loadSnapshot = () => {
      const currentRequestId = ++requestId
      setLoading(true)
      loadWorkspaceActivityWithoutBlocking(workspacePath, dayCount)
        .then((latest) => {
          if (!cancelled && currentRequestId === requestId) setSnapshot(latest)
        })
        .finally(() => {
          if (!cancelled && currentRequestId === requestId) setLoading(false)
        })
    }
    const cancelRefresh = scheduleWorkspaceActivityRefresh(() => {
      if (cancelled) return
      loadSnapshot()
    })
    const unsubscribe = window.api.onWorkspaceActivityUpdated?.((payload) => {
      if (payload.workspacePath !== workspacePath || payload.dayCount !== dayCount) return
      loadSnapshot()
    })
    return () => {
      cancelled = true
      cancelRefresh()
      unsubscribe?.()
    }
  }, [workspacePath, dayCount, refreshKey])

  const grid = useMemo(
    () => buildWorkspaceActivityHeatmapGrid(snapshot, new Date(), dayCount),
    [snapshot, dayCount]
  )

  return (
    <div
      className={`usage-heatmap usage-heatmap--workspace-activity${className ? ` ${className}` : ''}`}
      aria-label="Workspace Activity heatmap"
    >
      <div className="usage-heatmap-header">
        <span className="usage-heatmap-title">Workspace Activity</span>
        <span className="usage-heatmap-chip">
          24h <strong>{formatActivityCount(grid.totals.last24h)}</strong>
        </span>
        <span className="usage-heatmap-chip">
          7D <strong>{formatActivityCount(grid.totals.last7d)}</strong>
        </span>
        <span className="usage-heatmap-chip">
          {grid.columns}D <strong>{formatActivityCount(grid.totals.window)}</strong>
        </span>
      </div>
      <div className="usage-heatmap-grid-wrapper" aria-busy={loading}>
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
            <WorkspaceActivityCellTile key={`${cell.column}-${cell.row}`} cell={cell} />
          ))}
        </div>
      </div>
    </div>
  )
}
