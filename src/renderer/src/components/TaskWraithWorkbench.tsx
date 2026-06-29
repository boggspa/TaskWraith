import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { DiffViewer } from './DiffViewer'
import { FileEditorPanel, type FileEditorPanelState } from './FileEditorPanel'

type WorkbenchView = 'editor' | 'diff'

type WorkspaceDiff = Awaited<ReturnType<typeof window.api.getDiff>>

interface EditorOpenRequest {
  path: string
  nonce: number
}

const DEFAULT_EDITOR_STATE: FileEditorPanelState = {
  selectedPath: '',
  dirtyBufferCount: 0,
  cursorStatus: { line: 1, column: 1, selectedChars: 0 },
  gitSnapshot: null
}

interface TaskWraithWorkbenchProps {
  workspacePath: string
  workspaceName: string
  refreshTick: number
  onDirtyChange?: (dirtyBufferCount: number) => void
}

const viewLabel = (view: WorkbenchView): string =>
  view === 'editor' ? 'File Editor' : 'Diff Studio'

export function TaskWraithWorkbench({
  workspacePath,
  workspaceName,
  refreshTick,
  onDirtyChange
}: TaskWraithWorkbenchProps) {
  const [activeView, setActiveView] = useState<WorkbenchView>('editor')
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [diffGitSnapshot, setDiffGitSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [status, setStatus] = useState('Workbench ready')
  const [editorRefreshTick, setEditorRefreshTick] = useState(refreshTick)
  const [editorOpenRequest, setEditorOpenRequest] = useState<EditorOpenRequest | null>(null)
  const [editorState, setEditorState] = useState<FileEditorPanelState>(DEFAULT_EDITOR_STATE)
  const [diffActionPath, setDiffActionPath] = useState('')
  const diffRefreshSeqRef = useRef(0)

  const breadcrumbs = useMemo(
    () =>
      activeView === 'editor' && editorState.selectedPath
        ? [workspaceName, ...editorState.selectedPath.split('/').filter(Boolean)]
        : [workspaceName, viewLabel(activeView)],
    [activeView, editorState.selectedPath, workspaceName]
  )
  const activeGitSnapshot =
    activeView === 'diff' ? diffGitSnapshot : editorState.gitSnapshot
  const branchLabel = useMemo(() => {
    if (!activeGitSnapshot) return 'No git status'
    if (activeGitSnapshot.detached) {
      return activeGitSnapshot.commit ? `Detached ${activeGitSnapshot.commit}` : 'Detached HEAD'
    }
    return activeGitSnapshot.branch || 'Git repository'
  }, [activeGitSnapshot])
  const changeSummary = activeGitSnapshot
    ? `${activeGitSnapshot.counts.changed} changed · ${activeGitSnapshot.counts.staged} staged · ${activeGitSnapshot.counts.unstaged} unstaged`
    : ''
  const editorCursorSummary =
    activeView === 'editor' && editorState.selectedPath
      ? `Ln ${editorState.cursorStatus.line}, Col ${editorState.cursorStatus.column}${
          editorState.cursorStatus.selectedChars > 0
            ? ` · ${editorState.cursorStatus.selectedChars} selected`
            : ''
        }`
      : viewLabel(activeView)
  const editorDirtySummary =
    editorState.dirtyBufferCount > 0
      ? `${editorState.dirtyBufferCount} unsaved ${
          editorState.dirtyBufferCount === 1 ? 'file' : 'files'
        }`
      : ''

  const refreshDiff = useCallback(async () => {
    if (!workspacePath) return
    const requestId = diffRefreshSeqRef.current + 1
    diffRefreshSeqRef.current = requestId
    setStatus('Refreshing diff')
    try {
      const [nextDiff, nextGitSnapshot] = await Promise.all([
        window.api.getDiff(workspacePath),
        window.api.gitSnapshot({ workspacePath })
      ])
      if (requestId !== diffRefreshSeqRef.current) return
      setDiff(nextDiff)
      setDiffGitSnapshot(nextGitSnapshot.ok ? nextGitSnapshot.data : null)
      setStatus('Diff refreshed')
    } catch (error) {
      if (requestId !== diffRefreshSeqRef.current) return
      setDiff({
        type: 'error',
        text: error instanceof Error ? error.message : 'Could not load workspace diff'
      })
      setDiffGitSnapshot(null)
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

  const openFileInEditor = useCallback((path: string) => {
    setActiveView('editor')
    setEditorOpenRequest((current) => ({
      path,
      nonce: (current?.nonce ?? 0) + 1
    }))
    setStatus(`Opening ${path}`)
  }, [])

  const stageDiffFile = useCallback(
    async (path: string) => {
      if (!workspacePath) return
      setDiffActionPath(path)
      setStatus(`Staging ${path}`)
      try {
        const result = await window.api.gitStage({ workspacePath, paths: [path] })
        if (result.ok) {
          setDiffGitSnapshot(result.data)
          await refreshDiff()
        } else {
          setStatus(result.error)
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not stage file')
      } finally {
        setDiffActionPath('')
      }
    },
    [refreshDiff, workspacePath]
  )

  const unstageDiffFile = useCallback(
    async (path: string) => {
      if (!workspacePath) return
      setDiffActionPath(path)
      setStatus(`Unstaging ${path}`)
      try {
        const result = await window.api.gitUnstage({ workspacePath, paths: [path] })
        if (result.ok) {
          setDiffGitSnapshot(result.data)
          await refreshDiff()
        } else {
          setStatus(result.error)
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not unstage file')
      } finally {
        setDiffActionPath('')
      }
    },
    [refreshDiff, workspacePath]
  )

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
                <span
                  title={
                    index === 0
                      ? workspacePath
                      : activeView === 'editor'
                        ? editorState.selectedPath
                        : undefined
                  }
                >
                  {crumb}
                </span>
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
          <div className="workbench-pane" hidden={activeView !== 'editor'}>
            <FileEditorPanel
              workspacePath={workspacePath}
              refreshTick={editorRefreshTick}
              openRequest={editorOpenRequest}
              onDirtyChange={onDirtyChange}
              onEditorStateChange={setEditorState}
            />
          </div>
          <div className="workbench-pane" hidden={activeView !== 'diff'}>
            <div className="diff-studio popout-diff-studio">
              <DiffViewer
                diff={diff}
                workspacePath={workspacePath}
                gitSnapshot={diffGitSnapshot}
                busyPath={diffActionPath}
                onOpenFile={openFileInEditor}
                onStageFile={stageDiffFile}
                onUnstageFile={unstageDiffFile}
              />
            </div>
          </div>
        </div>
        <footer className="workbench-bottom-bar">
          <span title={changeSummary ? `${branchLabel} · ${changeSummary}` : branchLabel}>
            {branchLabel}
            {changeSummary ? ` · ${changeSummary}` : ''}
          </span>
          <span>
            {editorDirtySummary ? `${editorDirtySummary} · ` : ''}
            {editorCursorSummary}
          </span>
        </footer>
      </div>
    </section>
  )
}
