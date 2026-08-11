import type { MouseEvent, ReactNode } from 'react'
import type { DiffFileSummary } from '../../../main/store/types'
import type { CloseoutFileChange } from '../lib/taskWraithCloseoutMessage'
import { DIFF_HOVER_PREVIEW_TOOLTIP_ID } from './DiffHoverPreview'
import { FileTypeIcon } from './FileTypeIcon'

const FILE_CHANGE_PATH_LABEL_MAX = 44

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
  if (!Array.isArray(changes) || changes.length === 0) return null

  let adds = 0
  let dels = 0
  let showStats = false
  for (const item of changes) {
    if (item.additions !== undefined || item.deletions !== undefined) {
      showStats = true
      adds += item.additions || 0
      dels += item.deletions || 0
    }
  }

  return (
    <section className="file-change-summary-card run-complete-epic-card" aria-label="File changes">
      <div className="file-change-summary-header">
        <strong>File changes</strong>
        <div className="file-change-summary-meta">
          <span>
            {changes.length} file{changes.length === 1 ? '' : 's'}
          </span>
          {showStats && (
            <span className="file-change-summary-stats">
              <span className="file-change-stat file-change-stat-add composer-diff-add">
                +{adds}
              </span>
              <span className="file-change-stat file-change-stat-delete composer-diff-del">
                -{dels}
              </span>
            </span>
          )}
        </div>
      </div>
      <div className="file-change-summary-list">
        {changes.map((item) => {
          const summary = resolveSummary?.(item) || {
            ...item,
            previewKind: 'none' as const
          }
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
              {(item.additions !== undefined || item.deletions !== undefined) && (
                <span className="file-change-summary-item-stats">
                  <span className="file-change-stat file-change-stat-add composer-diff-add">
                    +{item.additions || 0}
                  </span>
                  <span className="file-change-stat file-change-stat-delete composer-diff-del">
                    -{item.deletions || 0}
                  </span>
                </span>
              )}
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
      </div>
    </section>
  )
}
