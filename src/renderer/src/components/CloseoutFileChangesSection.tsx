import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import type { DiffFileSummary } from '../../../main/store/types'
import type { CloseoutFileChange } from '../lib/taskWraithCloseoutMessage'
import { DIFF_HOVER_PREVIEW_TOOLTIP_ID, getDiffHoverPreviewStats } from './DiffHoverPreview'
import { FileTypeIcon } from './FileTypeIcon'

const FILE_CHANGE_PATH_LABEL_MAX = 44

/** A wide close-out can list dozens of files and swamp the transcript, so the
 * card opens on a preview window and reveals the rest on demand. */
export const CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT = 10

/**
 * Visible slice of a close-out file list plus how many sit beyond the preview
 * cap. `hiddenCount` counts the overflow regardless of `expanded` — it is what
 * the toggle's "Show N more…" label reads, and it is what tells the card
 * whether to render the toggle at all.
 */
export function closeoutFileChangeWindow<T>(
  changes: T[],
  expanded: boolean
): { visible: T[]; hiddenCount: number } {
  const rows = Array.isArray(changes) ? changes : []
  const hiddenCount = Math.max(0, rows.length - CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT)
  const collapsed = hiddenCount > 0 && !expanded
  return {
    visible: collapsed ? rows.slice(0, CLOSEOUT_FILE_CHANGE_PREVIEW_LIMIT) : rows,
    hiddenCount
  }
}

function truncateFilePathFromHead(path: string): string {
  if (path.length <= FILE_CHANGE_PATH_LABEL_MAX) return path
  return `...${path.slice(-(FILE_CHANGE_PATH_LABEL_MAX - 3))}`
}

function filePathTailSegments(path: string): string {
  const raw = typeof path === 'string' ? path : ''
  if (!raw) return ''
  const normalized = raw.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 2) return truncateFilePathFromHead(raw)
  return truncateFilePathFromHead(`.../${segments.slice(-2).join('/')}`)
}

/**
 * Keep omitted line-count sides absent instead of accidentally presenting
 * unknown data as a zero. The spacer retains the existing two-column visual
 * alignment for a deletion-only value without putting fake text in the
 * accessibility tree.
 */
function CloseoutLineStats({
  className,
  stats
}: {
  className: string
  stats: ReturnType<typeof getDiffHoverPreviewStats>
}): ReactNode {
  if (stats.length === 0) return null

  const deletionOnly = stats.length === 1 && stats[0].kind === 'delete'
  return (
    <span
      className={className}
      role="group"
      aria-label={stats.map((stat) => stat.ariaLabel).join(', ')}
    >
      {deletionOnly && <span aria-hidden="true" className="file-change-stat-spacer" />}
      {stats.map((stat) => (
        <span
          aria-hidden="true"
          className={`file-change-stat file-change-stat-${stat.kind} ${
            stat.kind === 'add' ? 'composer-diff-add' : 'composer-diff-del'
          }`}
          key={stat.kind}
        >
          {stat.label}
        </span>
      ))}
    </span>
  )
}

/**
 * Compact File changes card for TaskWraith close-outs. The parent owns the
 * shared diff-preview overlay so persisted cards and the live footer use the
 * same sticky hover/focus behavior without mounting competing portals.
 */
export function CloseoutFileChangesSection({
  changes,
  getMainActionLabel,
  onActivateChange,
  onOpenPreview,
  onScheduleClosePreview,
  previewPath,
  resolveSummary,
  workspacePath
}: {
  changes: CloseoutFileChange[]
  getMainActionLabel?: (summary: DiffFileSummary) => string
  onActivateChange?: (event: MouseEvent<HTMLElement>, summary: DiffFileSummary) => void
  onOpenPreview?: (
    event: { currentTarget: HTMLElement },
    summary: DiffFileSummary,
    options?: { focusTarget?: 'action' | 'preview'; immediate?: boolean }
  ) => void
  onScheduleClosePreview?: () => void
  previewPath?: string | null
  resolveSummary?: (change: CloseoutFileChange) => DiffFileSummary
  workspacePath?: string
}): ReactNode {
  // Declared above the empty-list bail so the hook order never depends on the
  // props — a close-out that starts empty and fills in later still renders.
  const [expanded, setExpanded] = useState(false)

  if (!Array.isArray(changes) || changes.length === 0) return null

  // Totals stay over the WHOLE list: the cap below is a view window, not a
  // filter, so the header keeps describing the entire close-out.
  let adds = 0
  let dels = 0
  let additionsComplete = true
  let deletionsComplete = true
  for (const item of changes) {
    if (item.additions === undefined) additionsComplete = false
    else adds += item.additions
    if (item.deletions === undefined) deletionsComplete = false
    else dels += item.deletions
  }
  // The header describes the whole close-out, so only surface a total when
  // every listed file reported that side. A partial sum would be just as
  // misleading as the old invented zero.
  const headerStats = getDiffHoverPreviewStats({
    additions: additionsComplete ? adds : undefined,
    deletions: deletionsComplete ? dels : undefined
  })

  const { visible: visibleChanges, hiddenCount } = closeoutFileChangeWindow(changes, expanded)

  return (
    <section className="file-change-summary-card run-complete-epic-card" aria-label="File changes">
      <div className="file-change-summary-header">
        <strong>File changes</strong>
        <div className="file-change-summary-meta">
          <span>
            {changes.length} file{changes.length === 1 ? '' : 's'}
          </span>
          <CloseoutLineStats className="file-change-summary-stats" stats={headerStats} />
        </div>
      </div>
      <div className="file-change-summary-list">
        {visibleChanges.map((item) => {
          const summary = resolveSummary?.(item) || {
            ...item,
            previewKind: 'none' as const
          }
          const itemStats = getDiffHoverPreviewStats(item)
          const hasPreview = Boolean(onOpenPreview)
          const isInteractive = hasPreview || Boolean(onActivateChange)
          const rowContent = (
            /* `is-closeout` drops the owner column the live footer row carries.
             * Without it the four cells here land in the footer's five-track
             * grid, so the stats sit in the OWNER column and the unused fifth
             * track strands them ~132px short of the card's right edge. */
            <span className="file-change-summary-row-content is-closeout">
              <span className={`file-change-summary-status status-${item.status}`}>
                {item.status === 'modified' ? 'edited' : item.status}
              </span>
              <FileTypeIcon
                path={item.path}
                size={14}
                className="file-change-summary-type-icon"
                workspacePath={workspacePath}
              />
              <span className="file-change-summary-path" title={item.path}>
                <span className="file-change-summary-path-head" aria-hidden="true">
                  {item.path}
                </span>
                <span className="file-change-summary-path-tail">
                  {filePathTailSegments(item.path)}
                </span>
              </span>
              <CloseoutLineStats className="file-change-summary-item-stats" stats={itemStats} />
            </span>
          )

          if (!isInteractive) {
            return (
              <div className="file-change-summary-item" key={`${item.path}-${item.status}`}>
                {rowContent}
              </div>
            )
          }

          const actionLabel = getMainActionLabel?.(summary) || `Preview diff for ${summary.path}`
          return (
            <div
              className={`file-change-summary-item file-change-summary-item-interactive ${
                hasPreview ? 'has-diff-preview' : 'has-workbench-link'
              }`}
              key={`${item.path}-${item.status}`}
              onMouseEnter={hasPreview ? (event) => onOpenPreview?.(event, summary) : undefined}
              onMouseLeave={hasPreview ? onScheduleClosePreview : undefined}
            >
              <button
                className="file-change-summary-main-action"
                type="button"
                aria-describedby={
                  hasPreview && previewPath === summary.path
                    ? DIFF_HOVER_PREVIEW_TOOLTIP_ID
                    : undefined
                }
                aria-label={actionLabel}
                onFocus={
                  hasPreview
                    ? (event) => onOpenPreview?.(event, summary, { focusTarget: 'preview' })
                    : undefined
                }
                onBlur={hasPreview ? onScheduleClosePreview : undefined}
                onClick={(event) => {
                  if (onActivateChange) {
                    onActivateChange(event, summary)
                  } else {
                    onOpenPreview?.(event, summary, { immediate: true })
                  }
                }}
              >
                {rowContent}
              </button>
            </div>
          )
        })}
        {hiddenCount > 0 && (
          /* Renders as the row after the last visible file so the card reads as
           * one continuous list rather than a list plus a detached control. */
          <button
            className="file-change-summary-item file-change-summary-show-more"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
          >
            {expanded ? 'Show less' : `Show ${hiddenCount} more…`}
          </button>
        )}
      </div>
    </section>
  )
}
