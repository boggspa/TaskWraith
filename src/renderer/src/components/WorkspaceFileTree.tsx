import { useRef, type KeyboardEvent } from 'react'
import type { WorkspaceFileEntry } from '../../../main/store/types'
import { FileTypeIcon } from './FileTypeIcon'
import {
  formatBytes,
  parentDirectoryForPath,
  type FileEditorContextMenuAnchor
} from './FileEditorUtils'

export interface WorkspaceFileTreeProps {
  workspacePath?: string
  filter: string
  fileListStatus: string
  displayedFiles: WorkspaceFileEntry[]
  expandedDirectories: Set<string>
  selectedPath: string
  isFiltering: boolean
  isLoading: boolean
  isListLoading: boolean
  onFilterChange: (value: string) => void
  onRefresh: () => void | Promise<void>
  onOpenEntry: (entry: WorkspaceFileEntry) => void | Promise<void>
  onContextMenuEntry: (entry: WorkspaceFileEntry, anchor: FileEditorContextMenuAnchor) => void
}

export function WorkspaceFileTree({
  workspacePath,
  filter,
  fileListStatus,
  displayedFiles,
  expandedDirectories,
  selectedPath,
  isFiltering,
  isLoading,
  isListLoading,
  onFilterChange,
  onRefresh,
  onOpenEntry,
  onContextMenuEntry
}: WorkspaceFileTreeProps) {
  const listRef = useRef<HTMLDivElement | null>(null)

  const focusRowAt = (rows: HTMLButtonElement[], index: number) => {
    const nextIndex = Math.max(0, Math.min(rows.length - 1, index))
    rows[nextIndex]?.focus()
  }

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('.file-editor-row:not(:disabled)') ?? []
    )
    if (rows.length === 0) return
    const activeIndex = rows.findIndex((row) => row === document.activeElement)
    const currentIndex = activeIndex >= 0 ? activeIndex : 0
    const currentEntry = displayedFiles[currentIndex]

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRowAt(rows, currentIndex + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusRowAt(rows, currentIndex - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focusRowAt(rows, 0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      focusRowAt(rows, rows.length - 1)
      return
    }
    if (!currentEntry) return
    const isExpanded = currentEntry.isDirectory && expandedDirectories.has(currentEntry.path)
    if (event.key === 'ArrowRight' && currentEntry.isDirectory) {
      event.preventDefault()
      if (!isExpanded && currentEntry.hasChildren) {
        void onOpenEntry(currentEntry)
        return
      }
      const nextEntry = displayedFiles[currentIndex + 1]
      if (nextEntry && nextEntry.depth > currentEntry.depth) {
        focusRowAt(rows, currentIndex + 1)
      }
      return
    }
    if (event.key === 'ArrowLeft') {
      if (currentEntry.isDirectory && isExpanded) {
        event.preventDefault()
        void onOpenEntry(currentEntry)
        return
      }
      const parentPath = parentDirectoryForPath(currentEntry.path)
      if (parentPath) {
        event.preventDefault()
        const parentIndex = rows.findIndex(
          (row) =>
            row.dataset.fileEditorPath === parentPath &&
            row.dataset.fileEditorDirectory === 'true'
        )
        if (parentIndex >= 0) focusRowAt(rows, parentIndex)
      }
    }
  }

  return (
    <section className="file-editor-files">
      <div className="file-editor-header">
        <strong>Files</strong>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          onClick={() => void onRefresh()}
          disabled={!workspacePath || isListLoading}
        >
          Refresh
        </button>
      </div>
      <input
        className="file-editor-filter"
        aria-label="Filter workspace files"
        value={filter}
        onChange={(event) => onFilterChange(event.target.value)}
        placeholder="Filter files"
        disabled={!workspacePath}
      />
      <div className="file-editor-list-status" role="status" aria-live="polite">
        {fileListStatus}
      </div>
      <div
        className="file-editor-list"
        ref={listRef}
        onKeyDown={handleListKeyDown}
        aria-label="Workspace file navigator"
      >
        {displayedFiles.length > 0 ? (
          displayedFiles.map((entry) => {
            const isExpanded = entry.isDirectory && expandedDirectories.has(entry.path)
            return (
              <button
                key={`${entry.isDirectory ? 'dir' : 'file'}-${entry.path}`}
                className={`file-editor-row ${entry.isDirectory ? 'directory' : 'file'} ${selectedPath === entry.path ? 'active' : ''} ${isExpanded ? 'expanded' : ''}`}
                style={{ paddingLeft: `calc(var(--space-sm) + ${entry.depth * 12}px)` }}
                type="button"
                onClick={() => void onOpenEntry(entry)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onContextMenuEntry(entry, { x: event.clientX, y: event.clientY })
                }}
                data-file-editor-path={entry.path}
                data-file-editor-directory={entry.isDirectory ? 'true' : 'false'}
                aria-current={selectedPath === entry.path ? 'true' : undefined}
                aria-expanded={entry.isDirectory && entry.hasChildren ? isExpanded : undefined}
                disabled={isLoading}
                title={entry.path}
              >
                <span className="file-editor-disclosure" aria-hidden="true">
                  {entry.isDirectory && entry.hasChildren ? (isExpanded ? '▾' : '▸') : ''}
                </span>
                <FileTypeIcon
                  path={entry.path}
                  size={14}
                  className="file-editor-file-icon"
                  workspacePath={workspacePath}
                />
                <span className="file-editor-file-name">
                  {isFiltering ? entry.path : entry.name}
                </span>
                {!entry.isDirectory && (
                  <span className="file-editor-file-size">{formatBytes(entry.sizeBytes)}</span>
                )}
              </button>
            )
          })
        ) : (
          <div className="file-editor-empty">{fileListStatus || 'No workspace files found'}</div>
        )}
      </div>
    </section>
  )
}
