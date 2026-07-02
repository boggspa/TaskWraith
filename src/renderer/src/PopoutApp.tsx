import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitRepositorySnapshot } from '../../main/services/GitService'
import { DiffViewer } from './components/DiffViewer'
import { FileEditorPanel } from './components/FileEditorPanel'
import { TaskWraithWorkbench } from './components/TaskWraithWorkbench'
import { useAppearance } from './hooks/useAppearance'

export type PopoutKind = 'file-editor' | 'diff-studio' | 'workbench'

type WorkspaceDiff = Awaited<ReturnType<typeof window.api.getDiff>>

interface PopoutOpenFileRequest {
  path: string
  nonce: number
  view: 'editor' | 'diff'
}

const parsePopoutKind = (value: string | null): PopoutKind | null => {
  return value === 'file-editor' || value === 'diff-studio' || value === 'workbench'
    ? value
    : null
}

const basename = (path: string): string => {
  const cleaned = path.replace(/[\\/]+$/, '')
  return cleaned.split(/[\\/]/).filter(Boolean).pop() || path
}

const parseTargetView = (
  value: string | null,
  kind: PopoutKind | null
): 'editor' | 'diff' => {
  return resolvePopoutOpenFileView(kind, value)
}

export const popoutKindReceivesOpenFileBroadcast = (kind: PopoutKind | null): boolean => {
  return kind === 'file-editor' || kind === 'diff-studio' || kind === 'workbench'
}

export const resolvePopoutOpenFileView = (
  kind: PopoutKind | null,
  value: unknown
): 'editor' | 'diff' => {
  if (kind === 'diff-studio') return 'diff'
  if (kind === 'file-editor') return 'editor'
  return value === 'diff' ? 'diff' : 'editor'
}

function PopoutChromeIcon({ kind }: { kind: PopoutKind }) {
  if (kind === 'diff-studio') {
    return (
      <span className="popout-title-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 5h7M6 9h5M6 15h6M6 19h9" />
          <path d="M17 7l2 2-2 2M19 9h-6M15 13l-2 2 2 2M13 15h6" />
        </svg>
      </span>
    )
  }

  if (kind === 'workbench') {
    return (
      <span className="popout-title-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M5 5h6v6H5zM13 5h6v4h-6zM13 11h6v8h-6zM5 13h6v6H5z" />
        </svg>
      </span>
    )
  }

  return (
    <span className="popout-title-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M7 4h7l3 3v13H7z" />
        <path d="M14 4v4h4M10 12h5M10 15h6M10 18h4" />
      </svg>
    </span>
  )
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
  const targetFilePath = params.get('file') || ''
  const targetView = parseTargetView(params.get('view'), kind)
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [diffGitSnapshot, setDiffGitSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [status, setStatus] = useState('')
  const [dirtyBufferCount, setDirtyBufferCount] = useState(0)
  const [diffActionPath, setDiffActionPath] = useState('')
  const [openFileRequest, setOpenFileRequest] = useState<PopoutOpenFileRequest | null>(() =>
    targetFilePath ? { path: targetFilePath, nonce: 1, view: targetView } : null
  )
  // File Editor receives this as an in-place refresh signal. Do not
  // remount the panel here: open tabs and dirty buffers live inside it.
  const [fileEditorRefreshTick, setFileEditorRefreshTick] = useState(0)
  const diffRefreshSeqRef = useRef(0)

  const refreshDiff = useCallback(async () => {
    if (kind !== 'diff-studio' || !workspacePath) return
    const requestId = diffRefreshSeqRef.current + 1
    diffRefreshSeqRef.current = requestId
    setStatus('Refreshing diff...')
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
  }, [kind, workspacePath])

  const openDiffFileInEditor = useCallback(
    async (path: string) => {
      if (!workspacePath) return
      setStatus(`Opening ${path} in editor...`)
      try {
        await window.api.openWorkspacePopout({
          kind: 'file-editor',
          workspacePath,
          targetPath: path,
          targetView: 'editor'
        })
        setStatus(`Opened ${path} in editor`)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open file editor')
      }
    },
    [workspacePath]
  )

  const openEditorFileInDiff = useCallback(
    async (path: string) => {
      if (!workspacePath) return
      setStatus(`Opening ${path} in Diff Studio...`)
      try {
        await window.api.openWorkspacePopout({
          kind: 'diff-studio',
          workspacePath,
          targetPath: path,
          targetView: 'diff'
        })
        setStatus(`Opened ${path} in Diff Studio`)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open Diff Studio')
      }
    },
    [workspacePath]
  )

  const stageDiffFile = useCallback(
    async (path: string) => {
      if (!workspacePath) return
      setDiffActionPath(path)
      setStatus(`Staging ${path}...`)
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
      setStatus(`Unstaging ${path}...`)
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

  useEffect(() => {
    if (!workspacePath || !popoutKindReceivesOpenFileBroadcast(kind)) return
    const unsubscribe = window.api.onWorkspacePopoutOpenFile((payload) => {
      if (payload.workspacePath !== workspacePath || !payload.path) return
      setOpenFileRequest((current) => ({
        path: payload.path,
        nonce: (current?.nonce ?? 0) + 1,
        view: resolvePopoutOpenFileView(kind, payload.view)
      }))
    })
    return () => {
      unsubscribe?.()
    }
  }, [kind, workspacePath])

  useEffect(() => {
    if (kind !== 'file-editor' && kind !== 'workbench') {
      setDirtyBufferCount(0)
    }
  }, [kind])

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyBufferCount <= 0) return
      event.preventDefault()
      event.returnValue = ''
      return ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [dirtyBufferCount])

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
  const dirtyStatus =
    dirtyBufferCount > 0
      ? `${dirtyBufferCount} unsaved ${dirtyBufferCount === 1 ? 'file' : 'files'}`
      : ''
  const popoutFamily =
    kind === 'file-editor' || kind === 'diff-studio' || kind === 'workbench'
      ? 'workspace'
      : undefined

  return (
    <main className="popout-root" data-popout-kind={kind} data-popout-family={popoutFamily}>
      <header className="popout-header">
        <div className="popout-title-block">
          <div className="popout-title-line">
            <PopoutChromeIcon kind={kind} />
            <strong>{title}</strong>
          </div>
          <span title={workspacePath}>{workspaceName}</span>
        </div>
        {kind === 'diff-studio' && (
          <div className="popout-actions">
            <span className="popout-status" role="status" aria-live="polite">
              {status}
            </span>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => void refreshDiff()}
              aria-label={`Refresh diff for ${workspaceName}`}
            >
              Refresh
            </button>
          </div>
        )}
        {(kind === 'file-editor' || kind === 'workbench') && dirtyStatus && (
          <div className="popout-actions">
            <span className="popout-status" role="status" aria-live="polite">
              {dirtyStatus}
            </span>
          </div>
        )}
      </header>
      <section className="popout-body">
        {kind === 'file-editor' ? (
          <FileEditorPanel
            workspacePath={workspacePath}
            refreshTick={fileEditorRefreshTick}
            openRequest={openFileRequest}
            onShowInDiff={openEditorFileInDiff}
            onDirtyChange={setDirtyBufferCount}
          />
        ) : kind === 'diff-studio' ? (
          <div className="diff-studio popout-diff-studio">
            <DiffViewer
              diff={diff}
              gitSnapshot={diffGitSnapshot}
              busyPath={diffActionPath}
              workspacePath={workspacePath}
              selectionRequest={openFileRequest}
              onOpenFile={openDiffFileInEditor}
              onStageFile={stageDiffFile}
              onUnstageFile={unstageDiffFile}
            />
          </div>
        ) : (
          <TaskWraithWorkbench
            workspacePath={workspacePath}
            workspaceName={workspaceName}
            refreshTick={fileEditorRefreshTick}
            openFileRequest={openFileRequest}
            onDirtyChange={setDirtyBufferCount}
          />
        )}
      </section>
    </main>
  )
}
