import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { DiffViewer } from './components/DiffViewer'
import { FileEditorPanel } from './components/FileEditorPanel'
import { TaskWraithWorkbench } from './components/TaskWraithWorkbench'
import { useAppearance } from './hooks/useAppearance'

type PopoutKind = 'file-editor' | 'diff-studio' | 'workbench' | 'permission-helper'

type WorkspaceDiff = Awaited<ReturnType<typeof window.api.getDiff>>

const parsePopoutKind = (value: string | null): PopoutKind | null => {
  return value === 'file-editor' ||
    value === 'diff-studio' ||
    value === 'workbench' ||
    value === 'permission-helper'
    ? value
    : null
}

const basename = (path: string): string => {
  const cleaned = path.replace(/[\\/]+$/, '')
  return cleaned.split(/[\\/]/).filter(Boolean).pop() || path
}

// 1.0.5-PO2 — Debounce window for live-refresh signals. A burst of
// chat-updated events (e.g. during a tool-call sequence) collapses
// into a single getDiff fetch.
const REFRESH_DEBOUNCE_MS = 500

export function PopoutApp() {
  useAppearance()
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const kind = parsePopoutKind(params.get('popout'))
  const workspacePath = params.get('workspace') || ''
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [status, setStatus] = useState('')
  // File Editor receives this as an in-place refresh signal. Do not
  // remount the panel here: open tabs and dirty buffers live inside it.
  const [fileEditorRefreshTick, setFileEditorRefreshTick] = useState(0)

  const refreshDiff = useCallback(async () => {
    if (kind !== 'diff-studio' || !workspacePath) return
    setStatus('Refreshing diff...')
    try {
      const nextDiff = await window.api.getDiff(workspacePath)
      setDiff(nextDiff)
      setStatus('Diff refreshed')
    } catch (error) {
      setDiff({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not load workspace diff'
      })
      setStatus('Diff refresh failed')
    }
  }, [kind, workspacePath])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void refreshDiff()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [refreshDiff])

  // 1.0.5-PO2 — Subscribe to the main-process broadcast that fires
  // whenever a chat in this workspace has changed. Debounce the
  // re-fetch so a chatty round doesn't spam getDiff.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!workspacePath) return
    const unsubscribe = window.api.onWorkspacePopoutRefresh((payload) => {
      // Belt-and-braces: main filters by workspacePath too, but if
      // any future broadcaster forgets we don't want cross-workspace
      // churn here.
      if (payload.workspacePath !== workspacePath) return
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null
        if (kind === 'diff-studio') {
          void refreshDiff()
        } else {
          setFileEditorRefreshTick((tick) => tick + 1)
        }
      }, REFRESH_DEBOUNCE_MS)
    })
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
      unsubscribe?.()
    }
  }, [kind, workspacePath, refreshDiff])

  if (kind === 'permission-helper') {
    return <PermissionHelperPopout />
  }

  if (!kind || !workspacePath) {
    return (
      <main className="popout-root">
        <section className="popout-error" role="alert">
          <strong>Popout unavailable</strong>
          <span>This window is missing a workspace or view type.</span>
        </section>
      </main>
    )
  }

  const title =
    kind === 'file-editor' ? 'File Editor' : kind === 'diff-studio' ? 'Diff Studio' : 'Workbench'
  const workspaceName = basename(workspacePath)

  return (
    <main className="popout-root" data-popout-kind={kind}>
      <header className="popout-header">
        <div className="popout-title-block">
          <strong>{title}</strong>
          <span title={workspacePath}>{workspaceName}</span>
        </div>
        {kind === 'diff-studio' && (
          <div className="popout-actions">
            <span className="popout-status" role="status" aria-live="polite">
              {status}
            </span>
            <button className="btn btn-sm" type="button" onClick={() => void refreshDiff()}>
              Refresh
            </button>
          </div>
        )}
      </header>
      <section className="popout-body">
        {kind === 'file-editor' ? (
          <FileEditorPanel workspacePath={workspacePath} refreshTick={fileEditorRefreshTick} />
        ) : kind === 'diff-studio' ? (
          <div className="diff-studio popout-diff-studio">
            <DiffViewer diff={diff} workspacePath={workspacePath} />
          </div>
        ) : (
          <TaskWraithWorkbench
            workspacePath={workspacePath}
            workspaceName={workspaceName}
            refreshTick={fileEditorRefreshTick}
          />
        )}
      </section>
    </main>
  )
}

function PermissionHelperPopout() {
  const [status, setStatus] = useState('Drag the app tile into System Settings if macOS asks.')

  const beginDrag = useCallback((event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    window.api.startMessagesPermissionHelperDrag()
    setStatus('Dragging TaskWraith app...')
  }, [])

  const revealApp = useCallback(async () => {
    try {
      const result = await window.api.revealMessagesPermissionHelperApp()
      setStatus(
        result.ok ? 'Revealed TaskWraith in Finder.' : result.error || 'Could not reveal app.'
      )
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not reveal app.')
    }
  }, [])

  return (
    <main className="popout-root permission-helper-root" data-popout-kind="permission-helper">
      <section className="permission-helper-panel" aria-label="TaskWraith permission helper">
        <div className="permission-helper-title">
          <span>Automation setup</span>
          <strong>TaskWraith app target</strong>
        </div>
        <button
          type="button"
          className="permission-helper-drag-card"
          draggable
          onDragStart={beginDrag}
          onClick={() => void revealApp()}
          aria-label="Drag TaskWraith app into System Settings"
        >
          <div className="permission-helper-icon" aria-hidden="true">
            TW
          </div>
          <div>
            <strong>TaskWraith app</strong>
            <span>Drag into Privacy &amp; Security if needed</span>
          </div>
        </button>
        <div className="permission-helper-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => void revealApp()}>
            Reveal in Finder
          </button>
        </div>
        <p className="permission-helper-status" role="status" aria-live="polite">
          {status}
        </p>
      </section>
    </main>
  )
}
