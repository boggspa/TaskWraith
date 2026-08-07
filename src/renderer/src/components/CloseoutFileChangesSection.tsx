import type { ReactNode } from 'react'
import type { CloseoutFileChange } from '../lib/taskWraithCloseoutMessage'
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
 * Compact File changes card for historical TaskWraith close-outs.
 * Path + status + +/- only — no Workbench/diff hover of the live footer.
 */
export function CloseoutFileChangesSection({
  changes,
  workspacePath
}: {
  changes: CloseoutFileChange[]
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
        {changes.map((item) => (
          <div className="file-change-summary-item" key={`${item.path}-${item.status}`}>
            <span className="file-change-summary-row-content">
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
          </div>
        ))}
      </div>
    </section>
  )
}
