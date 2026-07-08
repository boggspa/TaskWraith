import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import type { WorkspaceFileEntry } from '../../../main/store/types'
import { FileTypeIcon } from './FileTypeIcon'
import {
  contextMenuAnchorFromRect,
  formatBytes,
  isFileEditorContextMenuKey,
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
  onContextMenuEntry: (
    entry: WorkspaceFileEntry,
    anchor: FileEditorContextMenuAnchor,
    opener?: HTMLElement | null
  ) => void
}

const FILE_TREE_VIRTUALIZATION_THRESHOLD = 700
const FILE_TREE_ROW_HEIGHT = 32
const FILE_TREE_OVERSCAN = 16

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
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 })
  const useVirtualization = displayedFiles.length > FILE_TREE_VIRTUALIZATION_THRESHOLD

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
  }, [displayedFiles.length, useVirtualization])

  useEffect(() => {
    if (!useVirtualization || !selectedPath || !listRef.current) return
    const selectedIndex = displayedFiles.findIndex((entry) => entry.path === selectedPath)
    if (selectedIndex < 0) return
    const listElement = listRef.current
    const rowTop = selectedIndex * FILE_TREE_ROW_HEIGHT
    const rowBottom = rowTop + FILE_TREE_ROW_HEIGHT
    const viewportTop = listElement.scrollTop
    const viewportBottom = viewportTop + listElement.clientHeight
    if (rowTop < viewportTop) {
      listElement.scrollTop = rowTop
    } else if (rowBottom > viewportBottom) {
      listElement.scrollTop = Math.max(0, rowBottom - listElement.clientHeight)
    }
  }, [displayedFiles, selectedPath, useVirtualization])

  const visibleRange = useMemo(() => {
    if (!useVirtualization) {
      return {
        endIndex: displayedFiles.length,
        paddingBottom: 0,
        paddingTop: 0,
        startIndex: 0
      }
    }
    const viewportHeight = Math.max(viewport.height, FILE_TREE_ROW_HEIGHT * 16)
    const visibleCount =
      Math.ceil(viewportHeight / FILE_TREE_ROW_HEIGHT) + FILE_TREE_OVERSCAN * 2
    const startIndex = Math.max(
      0,
      Math.floor(viewport.scrollTop / FILE_TREE_ROW_HEIGHT) - FILE_TREE_OVERSCAN
    )
    const endIndex = Math.min(displayedFiles.length, startIndex + visibleCount)
    return {
      endIndex,
      paddingBottom: Math.max(0, displayedFiles.length - endIndex) * FILE_TREE_ROW_HEIGHT,
      paddingTop: startIndex * FILE_TREE_ROW_HEIGHT,
      startIndex
    }
  }, [displayedFiles.length, useVirtualization, viewport.height, viewport.scrollTop])

  const visibleFiles = displayedFiles.slice(visibleRange.startIndex, visibleRange.endIndex)

  const rowForIndex = useCallback((index: number): HTMLButtonElement | null => {
    return (
      listRef.current?.querySelector<HTMLButtonElement>(
        `.file-editor-row[data-file-editor-index="${index}"]`
      ) ?? null
    )
  }, [])

  const focusRowAt = useCallback(
    (index: number) => {
      if (displayedFiles.length === 0) return
      const nextIndex = Math.max(0, Math.min(displayedFiles.length - 1, index))
      const focus = () => {
        const row = rowForIndex(nextIndex)
        row?.focus()
        return Boolean(row)
      }

      if (useVirtualization && listRef.current) {
        const listElement = listRef.current
        const rowTop = nextIndex * FILE_TREE_ROW_HEIGHT
        const rowBottom = rowTop + FILE_TREE_ROW_HEIGHT
        const viewportTop = listElement.scrollTop
        const viewportBottom = viewportTop + listElement.clientHeight
        if (rowTop < viewportTop) {
          listElement.scrollTop = rowTop
        } else if (rowBottom > viewportBottom) {
          listElement.scrollTop = Math.max(0, rowBottom - listElement.clientHeight)
        }
        setViewport({
          height: listElement.clientHeight,
          scrollTop: listElement.scrollTop
        })
      }

      if (!focus()) {
        window.requestAnimationFrame(() => {
          if (!focus()) window.requestAnimationFrame(focus)
        })
      }
    },
    [displayedFiles.length, rowForIndex, useVirtualization]
  )

  const handleScroll = () => {
    const listElement = listRef.current
    if (!listElement) return
    setViewport({
      height: listElement.clientHeight,
      scrollTop: listElement.scrollTop
    })
  }

  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (displayedFiles.length === 0) return
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const activeIndex = Number(activeElement?.dataset.fileEditorIndex)
    const fallbackIndex = selectedPath
      ? Math.max(0, displayedFiles.findIndex((entry) => entry.path === selectedPath))
      : 0
    const currentIndex =
      Number.isInteger(activeIndex) && activeIndex >= 0 ? activeIndex : fallbackIndex
    const currentEntry = displayedFiles[currentIndex]

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRowAt(currentIndex + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusRowAt(currentIndex - 1)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focusRowAt(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      focusRowAt(displayedFiles.length - 1)
      return
    }
    if (!currentEntry) return
    if (isFileEditorContextMenuKey(event.key, event.shiftKey)) {
      event.preventDefault()
      event.stopPropagation()
      const currentRow = rowForIndex(currentIndex)
      onContextMenuEntry(
        currentEntry,
        contextMenuAnchorFromRect(
          (currentRow ?? listRef.current)?.getBoundingClientRect() ?? {
            height: 0,
            left: 0,
            top: 0,
            width: 0
          }
        ),
        currentRow
      )
      currentRow?.focus()
      return
    }
    const isExpanded = currentEntry.isDirectory && expandedDirectories.has(currentEntry.path)
    if (event.key === 'ArrowRight' && currentEntry.isDirectory) {
      event.preventDefault()
      if (!isExpanded && currentEntry.hasChildren) {
        void onOpenEntry(currentEntry)
        return
      }
      const nextEntry = displayedFiles[currentIndex + 1]
      if (nextEntry && nextEntry.depth > currentEntry.depth) {
        focusRowAt(currentIndex + 1)
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
        const parentIndex = displayedFiles.findIndex(
          (entry) => entry.path === parentPath && entry.isDirectory
        )
        if (parentIndex >= 0) focusRowAt(parentIndex)
      }
    }
  }

  return (
    <section className="file-editor-files">
      <div className="file-editor-header">
        <strong>Files</strong>
        <button
          className="segmented-control-action segmented-control-action--compact"
          type="button"
          onClick={() => void onRefresh()}
          disabled={!workspacePath || isListLoading}
        >
          Refresh
        </button>
      </div>
      <input
        className="file-editor-filter"
        aria-label="Search all workspace files"
        value={filter}
        onChange={(event) => onFilterChange(event.target.value)}
        placeholder="Search all files"
        disabled={!workspacePath}
      />
      <div className="file-editor-list-status" role="status" aria-live="polite">
        {fileListStatus}
      </div>
      <div
        className={`file-editor-list ${useVirtualization ? 'virtualized' : ''}`}
        ref={listRef}
        onKeyDown={handleListKeyDown}
        onScroll={handleScroll}
        role="tree"
        aria-label="Workspace file navigator"
        aria-busy={isListLoading ? 'true' : undefined}
        data-total-rows={displayedFiles.length}
        data-visible-rows={visibleFiles.length}
      >
        {displayedFiles.length > 0 ? (
          <div
            className="file-editor-list-virtual-window"
            role="presentation"
            style={
              useVirtualization
                ? {
                    paddingBottom: `${visibleRange.paddingBottom}px`,
                    paddingTop: `${visibleRange.paddingTop}px`
                  }
                : undefined
            }
          >
            {visibleFiles.map((entry, offset) => {
              const rowIndex = visibleRange.startIndex + offset
              const isExpanded = entry.isDirectory && expandedDirectories.has(entry.path)
              return (
                <button
                  key={`${entry.isDirectory ? 'dir' : 'file'}-${entry.path}`}
                  className={`file-editor-row ${entry.isDirectory ? 'directory' : 'file'} ${selectedPath === entry.path ? 'active' : ''} ${isExpanded ? 'expanded' : ''}`}
                  style={{ paddingLeft: `calc(var(--space-sm) + ${entry.depth * 12}px)` }}
                  type="button"
                  role="treeitem"
                  onClick={() => void onOpenEntry(entry)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onContextMenuEntry(
                      entry,
                      { x: event.clientX, y: event.clientY },
                      event.currentTarget
                    )
                  }}
                  data-file-editor-index={rowIndex}
                  data-file-editor-path={entry.path}
                  data-file-editor-directory={entry.isDirectory ? 'true' : 'false'}
                  aria-level={entry.depth + 1}
                  aria-current={selectedPath === entry.path ? 'true' : undefined}
                  aria-expanded={entry.isDirectory && entry.hasChildren ? isExpanded : undefined}
                  aria-haspopup="menu"
                  aria-keyshortcuts="ContextMenu Shift+F10"
                  aria-selected={selectedPath === entry.path}
                  disabled={isLoading}
                  title={entry.path}
                >
                  <span className="file-editor-disclosure" aria-hidden="true">
                    {entry.isDirectory && entry.hasChildren ? (isExpanded ? '▾' : '▸') : ''}
                  </span>
                  <FileTypeIcon
                    path={entry.path}
                    isDirectory={entry.isDirectory}
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
            })}
          </div>
        ) : (
          <div className="file-editor-empty">{fileListStatus || 'No workspace files found'}</div>
        )}
      </div>
    </section>
  )
}
