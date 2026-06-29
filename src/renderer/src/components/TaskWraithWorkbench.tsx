import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { DiffViewer } from './DiffViewer'
import {
  FileEditorPanel,
  type FileEditorCommandKind,
  type FileEditorCommandRequest,
  type FileEditorPanelState
} from './FileEditorPanel'

type WorkbenchView = 'editor' | 'diff'

type WorkspaceDiff = Awaited<ReturnType<typeof window.api.getDiff>>

interface EditorOpenRequest {
  path: string
  nonce: number
}

interface WorkbenchOpenRequest extends EditorOpenRequest {
  view?: WorkbenchView
}

const WORKBENCH_VIEWS: WorkbenchView[] = ['editor', 'diff']

const DEFAULT_EDITOR_STATE: FileEditorPanelState = {
  selectedPath: '',
  dirtyBufferCount: 0,
  openBufferCount: 0,
  cursorStatus: { line: 1, column: 1, selectedChars: 0 },
  gitSnapshot: null,
  lineWrapEnabled: false,
  isLoading: false,
  isListLoading: false,
  status: '',
  gitMessage: ''
}

interface TaskWraithWorkbenchProps {
  workspacePath: string
  workspaceName: string
  refreshTick: number
  openFileRequest?: WorkbenchOpenRequest | null
  onDirtyChange?: (dirtyBufferCount: number) => void
}

const viewLabel = (view: WorkbenchView): string =>
  view === 'editor' ? 'File Editor' : 'Diff Studio'

function WorkbenchNavIcon({ view }: { view: WorkbenchView }) {
  return (
    <span className="workbench-nav-icon" aria-hidden="true">
      {view === 'editor' ? (
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 5h5l2 2h5v12H6z" />
          <path d="M9 11h6M9 14h5M9 17h7" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 6h5M6 10h4M6 15h6M6 19h5" />
          <path d="M15 7l2 2-2 2M17 9h-5M17 14l-2 2 2 2M12 16h5" />
        </svg>
      )}
    </span>
  )
}

export function TaskWraithWorkbench({
  workspacePath,
  workspaceName,
  refreshTick,
  openFileRequest,
  onDirtyChange
}: TaskWraithWorkbenchProps) {
  const [activeView, setActiveView] = useState<WorkbenchView>('editor')
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [diffGitSnapshot, setDiffGitSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [status, setStatus] = useState('Workbench ready')
  const [editorRefreshTick, setEditorRefreshTick] = useState(refreshTick)
  const [editorOpenRequest, setEditorOpenRequest] = useState<EditorOpenRequest | null>(null)
  const [editorCommandRequest, setEditorCommandRequest] =
    useState<FileEditorCommandRequest | null>(null)
  const [diffSelectionRequest, setDiffSelectionRequest] = useState<EditorOpenRequest | null>(null)
  const [editorState, setEditorState] = useState<FileEditorPanelState>(DEFAULT_EDITOR_STATE)
  const [diffActionPath, setDiffActionPath] = useState('')
  const diffRefreshSeqRef = useRef(0)
  const editorNavRef = useRef<HTMLButtonElement | null>(null)
  const diffNavRef = useRef<HTMLButtonElement | null>(null)

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
  const editorBufferSummary =
    editorState.openBufferCount > 0
      ? `${editorState.openBufferCount} open ${
          editorState.openBufferCount === 1 ? 'tab' : 'tabs'
        }`
      : 'No open files'
  const editorDirtySummary =
    editorState.dirtyBufferCount > 0
      ? `${editorState.dirtyBufferCount} unsaved ${
          editorState.dirtyBufferCount === 1 ? 'file' : 'files'
        }`
      : ''
  const editorBusy = editorState.isLoading || editorState.isListLoading
  const workbenchStatus =
    activeView === 'editor' ? editorState.status || editorState.gitMessage || status : status

  const focusNavItem = useCallback((view: WorkbenchView) => {
    const navButton = view === 'editor' ? editorNavRef.current : diffNavRef.current
    navButton?.focus()
  }, [])

  const selectWorkbenchView = useCallback(
    (view: WorkbenchView, options?: { focusNav?: boolean }) => {
      setActiveView(view)
      if (options?.focusNav) {
        window.requestAnimationFrame(() => focusNavItem(view))
      }
    },
    [focusNavItem]
  )

  const dispatchEditorCommand = useCallback((kind: FileEditorCommandKind) => {
    selectWorkbenchView('editor')
    setEditorCommandRequest((current) => ({
      kind,
      nonce: (current?.nonce ?? 0) + 1
    }))
    setStatus(
      kind === 'quick-open'
        ? 'Opening quick open'
        : kind === 'save-all'
          ? 'Saving all dirty files'
          : kind === 'save-current'
            ? 'Saving current file'
            : kind === 'reveal-selected'
              ? 'Revealing selected file'
              : 'Toggling line wrap'
    )
  }, [selectWorkbenchView])

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
    setStatus('Refreshing editor')
  }, [activeView, refreshDiff])

  const handleWorkbenchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (!(event.metaKey || event.ctrlKey) || event.defaultPrevented) return
      const key = event.key.toLowerCase()
      if (key === 'p') {
        event.preventDefault()
        dispatchEditorCommand('quick-open')
        return
      }
      if (key === 's') {
        event.preventDefault()
        dispatchEditorCommand(event.shiftKey ? 'save-all' : 'save-current')
        return
      }
      if (key === '1') {
        event.preventDefault()
        selectWorkbenchView('editor', { focusNav: true })
        setStatus('Showing File Editor')
        return
      }
      if (key === '2') {
        event.preventDefault()
        selectWorkbenchView('diff', { focusNav: true })
        setStatus('Showing Diff Studio')
      }
    },
    [dispatchEditorCommand, selectWorkbenchView]
  )

  const openFileInEditor = useCallback((path: string) => {
    selectWorkbenchView('editor')
    setEditorOpenRequest((current) => ({
      path,
      nonce: (current?.nonce ?? 0) + 1
    }))
    setStatus(`Opening ${path}`)
  }, [selectWorkbenchView])

  const showFileInDiff = useCallback((path: string) => {
    selectWorkbenchView('diff')
    setDiffSelectionRequest((current) => ({
      path,
      nonce: (current?.nonce ?? 0) + 1
    }))
    setStatus(`Showing diff for ${path}`)
  }, [selectWorkbenchView])

  const handleNavKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, view: WorkbenchView) => {
      const currentIndex = WORKBENCH_VIEWS.indexOf(view)
      if (currentIndex < 0) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault()
        selectWorkbenchView(WORKBENCH_VIEWS[(currentIndex + 1) % WORKBENCH_VIEWS.length], {
          focusNav: true
        })
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault()
        selectWorkbenchView(
          WORKBENCH_VIEWS[(currentIndex - 1 + WORKBENCH_VIEWS.length) % WORKBENCH_VIEWS.length],
          { focusNav: true }
        )
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        selectWorkbenchView(WORKBENCH_VIEWS[0], { focusNav: true })
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        selectWorkbenchView(WORKBENCH_VIEWS[WORKBENCH_VIEWS.length - 1], { focusNav: true })
      }
    },
    [selectWorkbenchView]
  )

  useEffect(() => {
    if (!openFileRequest) return
    if (openFileRequest.view === 'diff') {
      showFileInDiff(openFileRequest.path)
      return
    }
    openFileInEditor(openFileRequest.path)
  }, [openFileInEditor, openFileRequest, showFileInDiff])

  const stageDiffFile = useCallback(
    async (path: string) => {
      if (!workspacePath) return
      setDiffActionPath(path)
      setStatus(`Staging ${path}`)
      try {
        const result = await window.api.gitStage({ workspacePath, paths: [path] })
        if (result.ok) {
          setDiffGitSnapshot(result.data)
          setEditorState((current) => ({ ...current, gitSnapshot: result.data }))
          setEditorRefreshTick((tick) => tick + 1)
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
          setEditorState((current) => ({ ...current, gitSnapshot: result.data }))
          setEditorRefreshTick((tick) => tick + 1)
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
    <section
      className="workbench-shell"
      aria-label="TaskWraith Workbench"
      onKeyDown={handleWorkbenchKeyDown}
    >
      <aside
        className="workbench-navigator"
        role="tablist"
        aria-label="Workbench views"
        aria-orientation="vertical"
      >
        <button
          ref={editorNavRef}
          className={`workbench-nav-item ${activeView === 'editor' ? 'active' : ''}`}
          type="button"
          role="tab"
          id="workbench-editor-tab"
          aria-selected={activeView === 'editor'}
          aria-controls="workbench-editor-panel"
          aria-keyshortcuts="Meta+1 Control+1"
          tabIndex={activeView === 'editor' ? 0 : -1}
          onClick={() => selectWorkbenchView('editor')}
          onKeyDown={(event) => handleNavKeyDown(event, 'editor')}
        >
          <WorkbenchNavIcon view="editor" />
          <span>Files</span>
          <small>Editor</small>
        </button>
        <button
          ref={diffNavRef}
          className={`workbench-nav-item ${activeView === 'diff' ? 'active' : ''}`}
          type="button"
          role="tab"
          id="workbench-diff-tab"
          aria-selected={activeView === 'diff'}
          aria-controls="workbench-diff-panel"
          aria-keyshortcuts="Meta+2 Control+2"
          tabIndex={activeView === 'diff' ? 0 : -1}
          onClick={() => selectWorkbenchView('diff')}
          onKeyDown={(event) => handleNavKeyDown(event, 'diff')}
        >
          <WorkbenchNavIcon view="diff" />
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
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => dispatchEditorCommand('quick-open')}
              disabled={editorBusy}
              aria-keyshortcuts="Meta+P Control+P"
              title="Quick open file"
            >
              Quick Open
            </button>
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => dispatchEditorCommand('save-all')}
              disabled={editorState.dirtyBufferCount === 0 || editorBusy}
              aria-keyshortcuts="Meta+Shift+S Control+Shift+S"
              title={
                editorState.dirtyBufferCount > 0
                  ? `Save ${editorState.dirtyBufferCount} dirty file${
                      editorState.dirtyBufferCount === 1 ? '' : 's'
                    }`
                  : 'No dirty files'
              }
            >
              Save All
            </button>
            <span className="workbench-status" role="status" aria-live="polite">
              {workbenchStatus}
            </span>
            <button className="btn btn-sm" type="button" onClick={refreshActiveView}>
              Refresh
            </button>
          </div>
        </div>
        <div className="workbench-stage">
          <div
            className="workbench-pane"
            role="tabpanel"
            id="workbench-editor-panel"
            aria-labelledby="workbench-editor-tab"
            hidden={activeView !== 'editor'}
          >
            <FileEditorPanel
              workspacePath={workspacePath}
              refreshTick={editorRefreshTick}
              openRequest={editorOpenRequest}
              commandRequest={editorCommandRequest}
              onDirtyChange={onDirtyChange}
              onEditorStateChange={setEditorState}
            />
          </div>
          <div
            className="workbench-pane"
            role="tabpanel"
            id="workbench-diff-panel"
            aria-labelledby="workbench-diff-tab"
            hidden={activeView !== 'diff'}
          >
            <div className="diff-studio popout-diff-studio">
              <DiffViewer
                diff={diff}
                workspacePath={workspacePath}
                gitSnapshot={diffGitSnapshot}
                busyPath={diffActionPath}
                selectionRequest={diffSelectionRequest}
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
            {activeView === 'editor' ? `${editorBufferSummary} · ` : ''}
            {editorDirtySummary ? `${editorDirtySummary} · ` : ''}
            {editorCursorSummary}
            {activeView === 'editor' ? ` · ${editorState.lineWrapEnabled ? 'Wrap' : 'No wrap'}` : ''}
          </span>
        </footer>
      </div>
    </section>
  )
}
