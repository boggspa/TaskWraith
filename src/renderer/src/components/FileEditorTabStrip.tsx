import type { KeyboardEvent } from 'react'
import { FileTypeIcon } from './FileTypeIcon'
import {
  fileNameForPath,
  type FileEditorContextMenuAnchor
} from './FileEditorUtils'

export interface FileEditorTabBuffer {
  path: string
  content: string
  savedContent: string
  savedEtag: string | null
  sizeBytes: number
  mtimeMs?: number
}

export interface EditorTabStripProps {
  buffers: FileEditorTabBuffer[]
  selectedPath: string
  workspacePath?: string
  onSelect: (path: string) => void
  onClose: (path: string) => void
  onContextMenuTab: (path: string, anchor: FileEditorContextMenuAnchor) => void
}

const isBufferDirty = (buffer: FileEditorTabBuffer | null | undefined): boolean => {
  return Boolean(buffer && buffer.content !== buffer.savedContent)
}

export function EditorTabStrip({
  buffers,
  selectedPath,
  workspacePath,
  onSelect,
  onClose,
  onContextMenuTab
}: EditorTabStripProps) {
  if (buffers.length === 0) return null

  const focusTabButton = (tabStrip: HTMLElement | null, index: number) => {
    if (!tabStrip) return
    const tabs = Array.from(
      tabStrip.querySelectorAll<HTMLButtonElement>('.file-editor-tab-select')
    )
    tabs[index]?.focus()
  }

  const selectTabAt = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextBuffer = buffers[index]
    if (!nextBuffer) return
    const tabStrip = event.currentTarget.closest<HTMLElement>('.file-editor-tab-strip')
    event.preventDefault()
    onSelect(nextBuffer.path)
    window.requestAnimationFrame(() => {
      focusTabButton(tabStrip, index)
    })
  }

  return (
    <div className="file-editor-tab-strip" role="tablist" aria-label="Open editor files">
      {buffers.map((buffer, index) => {
        const tabDirty = isBufferDirty(buffer)
        const isActive = selectedPath === buffer.path
        return (
          <div
            key={buffer.path}
            className={`file-editor-tab ${isActive ? 'active' : ''} ${tabDirty ? 'dirty' : ''}`}
            title={buffer.path}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onSelect(buffer.path)
              onContextMenuTab(buffer.path, { x: event.clientX, y: event.clientY })
            }}
          >
            <button
              className="file-editor-tab-select"
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onSelect(buffer.path)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  selectTabAt(event, (index + 1) % buffers.length)
                  return
                }
                if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  selectTabAt(event, (index - 1 + buffers.length) % buffers.length)
                  return
                }
                if (event.key === 'Home') {
                  selectTabAt(event, 0)
                  return
                }
                if (event.key === 'End') {
                  selectTabAt(event, buffers.length - 1)
                  return
                }
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault()
                  onClose(buffer.path)
                }
              }}
            >
              <FileTypeIcon
                path={buffer.path}
                size={13}
                className="file-editor-file-icon"
                workspacePath={workspacePath}
              />
              <span className="file-editor-tab-name">{fileNameForPath(buffer.path)}</span>
              {tabDirty && <span className="file-editor-dirty-dot" title="Unsaved changes" />}
            </button>
            <button
              type="button"
              className="file-editor-tab-close"
              aria-label={`Close ${buffer.path}`}
              title={`Close ${buffer.path}`}
              onClick={() => onClose(buffer.path)}
            >
              &times;
            </button>
          </div>
        )
      })}
    </div>
  )
}
