import { useCallback, useEffect, useMemo, useState } from 'react'
import { DiffViewer } from './DiffViewer'
import { FileEditorPanel } from './FileEditorPanel'

type WorkbenchView = 'editor' | 'diff'

type WorkspaceDiff = Awaited<ReturnType<typeof window.api.getDiff>>

interface TaskWraithWorkbenchProps {
  workspacePath: string
  workspaceName: string
  refreshTick: number
}

const viewLabel = (view: WorkbenchView): string =>
  view === 'editor' ? 'File Editor' : 'Diff Studio'

export function TaskWraithWorkbench({
  workspacePath,
  workspaceName,
  refreshTick
}: TaskWraithWorkbenchProps) {
  const [activeView, setActiveView] = useState<WorkbenchView>('editor')
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [status, setStatus] = useState('Workbench ready')
  const [editorRefreshTick, setEditorRefreshTick] = useState(refreshTick)

  const breadcrumbs = useMemo(
    () => [workspaceName, viewLabel(activeView)],
    [activeView, workspaceName]
  )

  const refreshDiff = useCallback(async () => {
    if (!workspacePath) return
    setStatus('Refreshing diff')
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
  }, [workspacePath])

  const refreshActiveView = useCallback(() => {
    if (activeView === 'diff') {
      void refreshDiff()
      return
    }
    setEditorRefreshTick((tick) => tick + 1)
    setStatus('Editor refreshed')
  }, [activeView, refreshDiff])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setEditorRefreshTick(refreshTick)
      if (activeView === 'diff') {
        void refreshDiff()
      }
    })
    return () => {
      cancelled = true
    }
  }, [activeView, refreshDiff, refreshTick])

  useEffect(() => {
    if (activeView !== 'diff' || diff) return
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void refreshDiff()
    })
    return () => {
      cancelled = true
    }
  }, [activeView, diff, refreshDiff])

  return (
    <section className="workbench-shell" aria-label="TaskWraith Workbench">
      <aside className="workbench-navigator" aria-label="Workbench navigator">
        <button
          className={`workbench-nav-item ${activeView === 'editor' ? 'active' : ''}`}
          type="button"
          onClick={() => setActiveView('editor')}
          aria-pressed={activeView === 'editor'}
        >
          <span>Files</span>
          <small>Editor</small>
        </button>
        <button
          className={`workbench-nav-item ${activeView === 'diff' ? 'active' : ''}`}
          type="button"
          onClick={() => setActiveView('diff')}
          aria-pressed={activeView === 'diff'}
        >
          <span>Diff</span>
          <small>Review</small>
        </button>
      </aside>
      <div className="workbench-main">
        <div className="workbench-toolbar">
          <div className="workbench-breadcrumbs" aria-label="Workbench breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`}>
                {index > 0 && <span aria-hidden="true">/</span>}
                <span title={index === 0 ? workspacePath : undefined}>{crumb}</span>
              </span>
            ))}
          </div>
          <div className="workbench-actions">
            <span className="workbench-status" role="status" aria-live="polite">
              {status}
            </span>
            <button className="btn btn-sm" type="button" onClick={refreshActiveView}>
              Refresh
            </button>
          </div>
        </div>
        <div className="workbench-stage">
          {activeView === 'editor' ? (
            <FileEditorPanel workspacePath={workspacePath} refreshTick={editorRefreshTick} />
          ) : (
            <div className="diff-studio popout-diff-studio">
              <DiffViewer diff={diff} workspacePath={workspacePath} />
            </div>
          )}
        </div>
        <footer className="workbench-bottom-bar">
          <span>{workspaceName}</span>
          <span>{viewLabel(activeView)}</span>
        </footer>
      </div>
    </section>
  )
}
