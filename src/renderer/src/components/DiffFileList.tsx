import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { createPortal } from 'react-dom'
import type { GitFileStatus } from '../../../main/services/GitService'
import type { DiffFileSummary } from '../../../main/store/types'
import { FileTypeIcon } from './FileTypeIcon'
import {
  contextMenuAnchorFromRect,
  isFileEditorContextMenuKey,
  type FileEditorContextMenuAnchor
} from './FileEditorUtils'

export interface DiffFileListProps {
  summaries: DiffFileSummary[]
  selectedPath?: string
  workspacePath?: string
  gitStatusByPath: Map<string, GitFileStatus>
  repoPathForSummary: (summary: DiffFileSummary) => string
  busyPath?: string
  onSelectPath: (path: string) => void
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
}

type DiffStageGroup = 'mixed' | 'unstaged' | 'staged' | 'untracked' | 'other'

interface DiffFileSection {
  group: DiffStageGroup
  summaries: DiffFileSummary[]
}

type DiffFileListRow =
  | {
      id: string
      kind: 'notice'
      text: string
    }
  | {
      count: number
      group: DiffStageGroup
      id: string
      kind: 'sectionHeader'
    }
  | {
      gitStatus?: GitFileStatus
      id: string
      kind: 'file'
      summary: DiffFileSummary
    }

interface DiffFileContextMenuSelection {
  anchor: FileEditorContextMenuAnchor
  gitStatus?: GitFileStatus
  summary: DiffFileSummary
}

interface DiffFileContextMenuItem {
  id: string
  label: string
  disabled?: boolean
  onSelect: () => void
}

const DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD = 450
const DIFF_FILE_LIST_ROW_HEIGHT = 34
const DIFF_FILE_LIST_OVERSCAN = 12

const diffStageGroup = (
  summary: DiffFileSummary,
  gitStatus?: GitFileStatus
): DiffStageGroup => {
  if (gitStatus?.staged && gitStatus?.unstaged) return 'mixed'
  if (gitStatus?.unstaged) return 'unstaged'
  if (gitStatus?.staged) return 'staged'
  if (summary.status === 'untracked') return 'untracked'
  return 'other'
}

const diffStageGroupLabel = (group: DiffStageGroup): string => {
  switch (group) {
    case 'mixed':
      return 'Staged + Unstaged'
    case 'unstaged':
      return 'Unstaged'
    case 'staged':
      return 'Staged'
    case 'untracked':
      return 'Untracked'
    default:
      return 'Other'
  }
}

const diffFileRowStateLabel = (gitStatus?: GitFileStatus): string => {
  if (!gitStatus) return ''
  if (gitStatus.staged && gitStatus.unstaged) return 'staged and unstaged'
  if (gitStatus.staged) return 'staged'
  if (gitStatus.unstaged) return 'unstaged'
  return ''
}

const buildDiffFileRowLabel = (summary: DiffFileSummary, gitStatus?: GitFileStatus): string => {
  const parts = [summary.path, summary.status]
  if (summary.additions !== undefined || summary.deletions !== undefined) {
    parts.push(`${summary.additions ?? 0} additions`)
    parts.push(`${summary.deletions ?? 0} deletions`)
  }
  const stateLabel = diffFileRowStateLabel(gitStatus)
  if (stateLabel) parts.push(stateLabel)
  return parts.join(', ')
}

const canOpenDiffFileInEditor = (summary: DiffFileSummary): boolean => {
  return (
    summary.status !== 'deleted' &&
    summary.status !== 'binary' &&
    summary.status !== 'hidden_sensitive' &&
    summary.previewKind !== 'binary' &&
    summary.previewKind !== 'hidden'
  )
}

export function buildDiffFileContextMenuItems({
  busyPath,
  gitStatus,
  onCopyPath,
  onOpenFile,
  onStageFile,
  onUnstageFile,
  summary
}: {
  busyPath?: string
  gitStatus?: GitFileStatus
  onCopyPath: (path: string) => void
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
  summary: DiffFileSummary
}): DiffFileContextMenuItem[] {
  const isBusy = busyPath === summary.path
  return [
    {
      id: 'open-editor',
      label: 'Open in Editor',
      disabled: !onOpenFile || !canOpenDiffFileInEditor(summary),
      onSelect: () => onOpenFile?.(summary.path)
    },
    {
      id: 'stage',
      label: isBusy ? 'Working' : 'Stage File',
      disabled: !onStageFile || !gitStatus?.unstaged || isBusy,
      onSelect: () => void onStageFile?.(summary.path)
    },
    {
      id: 'unstage',
      label: 'Unstage File',
      disabled: !onUnstageFile || !gitStatus?.staged || isBusy,
      onSelect: () => void onUnstageFile?.(summary.path)
    },
    {
      id: 'copy-path',
      label: 'Copy Relative Path',
      onSelect: () => onCopyPath(summary.path)
    }
  ]
}

export function DiffFileList({
  summaries,
  selectedPath,
  workspacePath,
  gitStatusByPath,
  repoPathForSummary,
  busyPath,
  onSelectPath,
  onOpenFile,
  onStageFile,
  onUnstageFile
}: DiffFileListProps) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 })
  const [contextMenuSelection, setContextMenuSelection] =
    useState<DiffFileContextMenuSelection | null>(null)
  const groupedSummaries: DiffFileSection[] = useMemo(() => {
    const groupOrder: DiffStageGroup[] = ['mixed', 'unstaged', 'staged', 'untracked', 'other']
    const groups = new Map<DiffStageGroup, DiffFileSummary[]>()
    for (const summary of summaries) {
      const group = diffStageGroup(summary, gitStatusByPath.get(repoPathForSummary(summary)))
      const entries = groups.get(group) ?? []
      entries.push(summary)
      groups.set(group, entries)
    }
    return groupOrder
      .map((group) => ({ group, summaries: groups.get(group) ?? [] }))
      .filter((section) => section.summaries.length > 0)
  }, [gitStatusByPath, repoPathForSummary, summaries])
  const rows = useMemo<DiffFileListRow[]>(() => {
    return groupedSummaries.flatMap((section) => [
      {
        count: section.summaries.length,
        group: section.group,
        id: `${section.group}:header`,
        kind: 'sectionHeader' as const
      },
      ...section.summaries.map((summary) => ({
        gitStatus: gitStatusByPath.get(repoPathForSummary(summary)),
        id: `${section.group}:file:${summary.path}`,
        kind: 'file' as const,
        summary
      }))
    ])
  }, [gitStatusByPath, groupedSummaries, repoPathForSummary])
  const useVirtualization = rows.length > DIFF_FILE_LIST_VIRTUALIZATION_THRESHOLD
  const renderRows = useMemo<DiffFileListRow[]>(() => {
    if (!useVirtualization) return rows
    return [
      {
        id: 'virtualized-file-list-notice',
        kind: 'notice',
        text: `Showing ${summaries.length.toLocaleString()} changed files. Filter to narrow.`
      },
      ...rows
    ]
  }, [rows, summaries.length, useVirtualization])
  const fileRows = useMemo(
    () =>
      rows.filter(
        (row): row is Extract<DiffFileListRow, { kind: 'file' }> => row.kind === 'file'
      ),
    [rows]
  )
  const selectedFileIndex = selectedPath
    ? fileRows.findIndex((row) => row.summary.path === selectedPath)
    : -1

  const focusFileRow = useCallback((path: string) => {
    const focus = () => {
      const buttons = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>('.diff-file-row') ?? []
      )
      const button = buttons.find((item) => item.dataset.diffFilePath === path)
      button?.focus()
      return Boolean(button)
    }
    window.requestAnimationFrame(() => {
      if (!focus()) {
        window.requestAnimationFrame(focus)
      }
    })
  }, [])

  const selectFileAt = useCallback(
    (index: number) => {
      const row = fileRows[index]
      if (!row) return
      onSelectPath(row.summary.path)
      focusFileRow(row.summary.path)
    },
    [fileRows, focusFileRow, onSelectPath]
  )

  useEffect(() => {
    const listElement = listRef.current
    if (!listElement) return

    const updateViewport = () => {
      setViewport({
        height: listElement.clientHeight,
        scrollTop: listElement.scrollTop
      })
    }

    updateViewport()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateViewport)
      observer.observe(listElement)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', updateViewport)
    return () => window.removeEventListener('resize', updateViewport)
  }, [renderRows.length, useVirtualization])

  useEffect(() => {
    if (!useVirtualization || !selectedPath || !listRef.current) return
    const selectedIndex = renderRows.findIndex(
      (row) => row.kind === 'file' && row.summary.path === selectedPath
    )
    if (selectedIndex < 0) return
    const listElement = listRef.current
    const rowTop = selectedIndex * DIFF_FILE_LIST_ROW_HEIGHT
    const rowBottom = rowTop + DIFF_FILE_LIST_ROW_HEIGHT
    const viewportTop = listElement.scrollTop
    const viewportBottom = viewportTop + listElement.clientHeight
    if (rowTop < viewportTop) {
      listElement.scrollTop = rowTop
    } else if (rowBottom > viewportBottom) {
      listElement.scrollTop = Math.max(0, rowBottom - listElement.clientHeight)
    }
  }, [renderRows, selectedPath, useVirtualization])

  const visibleRange = (() => {
    if (!useVirtualization) {
      return {
        endIndex: renderRows.length,
        paddingBottom: 0,
        paddingTop: 0,
        startIndex: 0
      }
    }
    const viewportHeight = Math.max(viewport.height, DIFF_FILE_LIST_ROW_HEIGHT * 16)
    const visibleCount =
      Math.ceil(viewportHeight / DIFF_FILE_LIST_ROW_HEIGHT) + DIFF_FILE_LIST_OVERSCAN * 2
    const startIndex = Math.max(
      0,
      Math.floor(viewport.scrollTop / DIFF_FILE_LIST_ROW_HEIGHT) - DIFF_FILE_LIST_OVERSCAN
    )
    const endIndex = Math.min(renderRows.length, startIndex + visibleCount)
    return {
      endIndex,
      paddingBottom: Math.max(0, renderRows.length - endIndex) * DIFF_FILE_LIST_ROW_HEIGHT,
      paddingTop: startIndex * DIFF_FILE_LIST_ROW_HEIGHT,
      startIndex
    }
  })()
  const currentVirtualSection = (() => {
    if (!useVirtualization) return null
    for (
      let index = Math.min(renderRows.length - 1, visibleRange.startIndex);
      index >= 0;
      index -= 1
    ) {
      const row = renderRows[index]
      if (row?.kind === 'sectionHeader') {
        return {
          count: row.count,
          label: diffStageGroupLabel(row.group)
        }
      }
    }
    const firstSection = renderRows.find((row) => row.kind === 'sectionHeader')
    return firstSection?.kind === 'sectionHeader'
      ? {
          count: firstSection.count,
          label: diffStageGroupLabel(firstSection.group)
        }
      : null
  })()
  const visibleRows = renderRows.slice(visibleRange.startIndex, visibleRange.endIndex)

  const handleScroll = () => {
    const listElement = listRef.current
    if (!listElement) return
    setViewport({
      height: listElement.clientHeight,
      scrollTop: listElement.scrollTop
    })
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (fileRows.length === 0 || event.defaultPrevented) return
    const currentIndex = selectedFileIndex >= 0 ? selectedFileIndex : 0
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      selectFileAt(Math.min(fileRows.length - 1, currentIndex + 1))
      return
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      selectFileAt(Math.max(0, currentIndex - 1))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      selectFileAt(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      selectFileAt(fileRows.length - 1)
    }
  }

  const openContextMenu = useCallback(
    (
      summary: DiffFileSummary,
      gitStatus: GitFileStatus | undefined,
      anchor: FileEditorContextMenuAnchor
    ) => {
      onSelectPath(summary.path)
      setContextMenuSelection({ anchor, gitStatus, summary })
    },
    [onSelectPath]
  )

  const copyPath = useCallback((path: string) => {
    void navigator.clipboard?.writeText(path)
  }, [])

  const contextMenuItems = contextMenuSelection
    ? buildDiffFileContextMenuItems({
        busyPath,
        gitStatus: contextMenuSelection.gitStatus,
        onCopyPath: copyPath,
        onOpenFile,
        onStageFile,
        onUnstageFile,
        summary: contextMenuSelection.summary
      })
    : []

  return (
    <div
      ref={listRef}
      className={`diff-file-list ${useVirtualization ? 'virtualized' : ''}`}
      onKeyDown={handleKeyDown}
      onScroll={handleScroll}
      aria-label="Changed files"
      role="listbox"
      data-total-rows={rows.length}
      data-visible-rows={visibleRows.length}
    >
      {currentVirtualSection && (
        <div className="diff-file-list-floating-header" aria-hidden="true">
          <span>{currentVirtualSection.label}</span>
          <small>{currentVirtualSection.count}</small>
        </div>
      )}
      <div
        className="diff-file-list-virtual-window"
        style={
          useVirtualization
            ? {
                paddingBottom: `${visibleRange.paddingBottom}px`,
                paddingTop: `${visibleRange.paddingTop}px`
              }
            : undefined
        }
      >
        {visibleRows.map((row) =>
          row.kind === 'notice' ? (
            <div key={row.id} className="diff-file-list-virtual-note" role="note">
              {row.text}
            </div>
          ) : row.kind === 'sectionHeader' ? (
            <div key={row.id} className="diff-file-section-header">
              <span>{diffStageGroupLabel(row.group)}</span>
              <small>{row.count}</small>
            </div>
          ) : (
            <DiffFileRow
              key={row.id}
              gitStatus={row.gitStatus}
              isSelected={selectedPath === row.summary.path}
              onOpenContextMenu={openContextMenu}
              onSelectPath={onSelectPath}
              summary={row.summary}
              workspacePath={workspacePath}
            />
          )
        )}
      </div>
      <DiffFileContextMenu
        selection={contextMenuSelection}
        items={contextMenuItems}
        onClose={() => setContextMenuSelection(null)}
      />
    </div>
  )
}

function DiffFileRow({
  gitStatus,
  isSelected,
  onOpenContextMenu,
  onSelectPath,
  summary,
  workspacePath
}: {
  gitStatus?: GitFileStatus
  isSelected: boolean
  onOpenContextMenu: (
    summary: DiffFileSummary,
    gitStatus: GitFileStatus | undefined,
    anchor: FileEditorContextMenuAnchor
  ) => void
  onSelectPath: (path: string) => void
  summary: DiffFileSummary
  workspacePath?: string
}) {
  const openPointerContextMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    onOpenContextMenu(summary, gitStatus, { x: event.clientX, y: event.clientY })
  }

  const openKeyboardContextMenu = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isFileEditorContextMenuKey(event.key, event.shiftKey)) return
    event.preventDefault()
    onOpenContextMenu(
      summary,
      gitStatus,
      contextMenuAnchorFromRect(event.currentTarget.getBoundingClientRect())
    )
  }

  return (
    <button
      type="button"
      className={`diff-file-row ${isSelected ? 'selected' : ''}`}
      onClick={() => onSelectPath(summary.path)}
      onContextMenu={openPointerContextMenu}
      onKeyDown={openKeyboardContextMenu}
      aria-label={buildDiffFileRowLabel(summary, gitStatus)}
      aria-haspopup="menu"
      aria-keyshortcuts="ContextMenu Shift+F10"
      aria-selected={isSelected}
      data-diff-file-path={summary.path}
      role="option"
      tabIndex={isSelected ? 0 : -1}
      title={`Show diff for ${summary.path}`}
    >
      <FileTypeIcon
        path={summary.path}
        size={14}
        className="diff-file-type-icon"
        workspacePath={workspacePath}
      />
      <span className="diff-file-name">{summary.path}</span>
      <span className={`diff-file-badge ${summary.status}`}>
        {summary.additions !== undefined && summary.deletions !== undefined ? (
          <>
            <span className="diff-file-stat diff-file-stat-add">+{summary.additions}</span>
            <span className="diff-file-stat-divider">|</span>
            <span className="diff-file-stat diff-file-stat-delete">-{summary.deletions}</span>
          </>
        ) : (
          summary.status
        )}
      </span>
      {gitStatus && (
        <span className="diff-file-state">
          {gitStatus.staged && gitStatus.unstaged
            ? 'S+U'
            : gitStatus.staged
              ? 'S'
              : gitStatus.unstaged
                ? 'U'
                : ''}
        </span>
      )}
    </button>
  )
}

function DiffFileContextMenu({
  selection,
  items,
  onClose
}: {
  selection: DiffFileContextMenuSelection | null
  items: DiffFileContextMenuItem[]
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!selection) return
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target)) return
      onClose()
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [selection, onClose])

  if (!selection || items.length === 0) return null

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const heightEstimate = 18 + items.length * 34
  const left = Math.max(8, Math.min(selection.anchor.x, viewportWidth - 224))
  const top = Math.max(8, Math.min(selection.anchor.y, viewportHeight - heightEstimate))
  const menu = (
    <div
      ref={menuRef}
      className="file-editor-context-menu diff-file-context-menu"
      style={{ position: 'fixed', left: `${left}px`, top: `${top}px` }}
      role="menu"
      aria-label={`Actions for ${selection.summary.path}`}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="file-editor-context-menu-item"
          disabled={item.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (item.disabled) return
            item.onSelect()
            onClose()
          }}
        >
          <span className="file-editor-context-menu-label">{item.label}</span>
        </button>
      ))}
    </div>
  )

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}
