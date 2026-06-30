import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react'
import type { GitRepositorySnapshot } from '../../../main/services/GitService'
import { DiffViewer } from './DiffViewer'
import {
  FileEditorPanel,
  type FileEditorCommandKind,
  type FileEditorCommandRequest,
  type FileEditorPanelState
} from './FileEditorPanel'

export type WorkbenchView = 'editor' | 'diff' | 'split'
type WorkbenchPane = Exclude<WorkbenchView, 'split'>

type WorkspaceDiff = Awaited<ReturnType<typeof window.api.getDiff>>

interface EditorOpenRequest {
  path: string
  nonce: number
}

export interface WorkbenchOpenRequest extends EditorOpenRequest {
  view?: WorkbenchView
}

const WORKBENCH_VIEWS: WorkbenchView[] = ['editor', 'diff', 'split']
const WORKBENCH_SPLIT_RATIO_STORAGE_KEY_PREFIX = 'taskwraith.workbenchSplitRatio'
export const WORKBENCH_SPLIT_DEFAULT_RATIO = 52
export const WORKBENCH_SPLIT_MIN_RATIO = 30
export const WORKBENCH_SPLIT_MAX_RATIO = 72
export const WORKBENCH_SPLIT_KEYBOARD_STEP = 4
export const WORKBENCH_SPLIT_KEYBOARD_LARGE_STEP = 10

interface WorkbenchSplitResizeWindowTarget {
  addEventListener(
    type: 'pointercancel' | 'pointermove' | 'pointerup',
    listener: (event: PointerEvent) => void
  ): void
  removeEventListener(
    type: 'pointercancel' | 'pointermove' | 'pointerup',
    listener: (event: PointerEvent) => void
  ): void
}

interface WorkbenchSplitResizeCaptureTarget {
  hasPointerCapture?: (pointerId: number) => boolean
  releasePointerCapture?: (pointerId: number) => void
}

export interface WorkbenchSplitResizeSessionOptions {
  onFinish: () => void
  onPointerMove: (event: PointerEvent) => void
  pointerId: number
  resizerElement: WorkbenchSplitResizeCaptureTarget
  windowTarget: WorkbenchSplitResizeWindowTarget
}

export const startWorkbenchSplitResizeSession = ({
  onFinish,
  onPointerMove,
  pointerId,
  resizerElement,
  windowTarget
}: WorkbenchSplitResizeSessionOptions): (() => void) => {
  let isCleanedUp = false
  const cleanup = () => {
    if (isCleanedUp) return
    isCleanedUp = true
    windowTarget.removeEventListener('pointermove', onPointerMove)
    windowTarget.removeEventListener('pointerup', finish)
    windowTarget.removeEventListener('pointercancel', finish)
    try {
      if (resizerElement.hasPointerCapture?.(pointerId) !== false) {
        resizerElement.releasePointerCapture?.(pointerId)
      }
    } catch {
      // Pointer capture may already have been released by the platform.
    }
  }
  const finish = () => {
    if (isCleanedUp) return
    cleanup()
    onFinish()
  }

  windowTarget.addEventListener('pointermove', onPointerMove)
  windowTarget.addEventListener('pointerup', finish)
  windowTarget.addEventListener('pointercancel', finish)
  return cleanup
}

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

const viewLabel = (view: WorkbenchView): string => {
  if (view === 'editor') return 'File Editor'
  if (view === 'diff') return 'Diff Studio'
  return 'Split View'
}

export const isWorkbenchPaneHidden = (activeView: WorkbenchView, pane: WorkbenchPane): boolean => {
  return activeView !== 'split' && activeView !== pane
}

export const buildEditorWorkbenchNavMeta = (
  state: Pick<FileEditorPanelState, 'dirtyBufferCount' | 'openBufferCount'>
): string => {
  if (state.dirtyBufferCount > 0) {
    return `${state.dirtyBufferCount} dirty`
  }
  if (state.openBufferCount > 0) {
    return `${state.openBufferCount} open`
  }
  return 'Editor'
}

export const buildDiffWorkbenchNavMeta = (
  gitSnapshot: Pick<GitRepositorySnapshot, 'counts'> | null
): string => {
  if (!gitSnapshot) return 'Review'
  return gitSnapshot.counts.changed > 0 ? `${gitSnapshot.counts.changed} changed` : 'Clean'
}

export type WorkbenchBreadcrumbAction =
  | { kind: 'select-view'; view: WorkbenchView }
  | { kind: 'reveal-editor-file'; path: string }
  | { kind: 'open-diff-file'; path: string }

export interface WorkbenchBreadcrumbItem {
  action?: WorkbenchBreadcrumbAction
  current: boolean
  key: string
  label: string
  title?: string
}

export const buildWorkbenchBreadcrumbItems = ({
  activeView,
  diffSelectedPath,
  editorSelectedPath,
  workspaceName
}: {
  activeView: WorkbenchView
  diffSelectedPath?: string
  editorSelectedPath?: string
  workspaceName: string
}): WorkbenchBreadcrumbItem[] => {
  const workspaceItem: WorkbenchBreadcrumbItem = {
    action: { kind: 'select-view', view: activeView },
    current: false,
    key: 'workspace',
    label: workspaceName,
    title: `Show ${viewLabel(activeView)}`
  }

  const editorParts = editorSelectedPath?.split('/').filter(Boolean) ?? []
  if ((activeView === 'editor' || activeView === 'split') && editorParts.length > 0) {
    return [
      workspaceItem,
      ...editorParts.map((label, index) => {
        const isCurrent = index === editorParts.length - 1
        return {
          action: isCurrent
            ? ({ kind: 'reveal-editor-file', path: editorSelectedPath ?? '' } as const)
            : undefined,
          current: isCurrent,
          key: `editor-path-${index}-${label}`,
          label,
          title: isCurrent
            ? `Reveal ${editorSelectedPath} in file tree`
            : editorParts.slice(0, index + 1).join('/')
        }
      })
    ]
  }

  const diffParts = diffSelectedPath?.split('/').filter(Boolean) ?? []
  const viewItem: WorkbenchBreadcrumbItem = {
    action: { kind: 'select-view', view: activeView },
    current: diffParts.length === 0,
    key: 'view',
    label: viewLabel(activeView),
    title: `Show ${viewLabel(activeView)}`
  }
  if (diffParts.length > 0) {
    return [
      workspaceItem,
      viewItem,
      ...diffParts.map((label, index) => {
        const isCurrent = index === diffParts.length - 1
        return {
          action: isCurrent
            ? ({ kind: 'open-diff-file', path: diffSelectedPath ?? '' } as const)
            : undefined,
          current: isCurrent,
          key: `diff-path-${index}-${label}`,
          label,
          title: isCurrent
            ? `Open ${diffSelectedPath} in editor`
            : diffParts.slice(0, index + 1).join('/')
        }
      })
    ]
  }

  return [workspaceItem, viewItem]
}

export const buildWorkbenchBreadcrumbs = (
  options: Parameters<typeof buildWorkbenchBreadcrumbItems>[0]
): string[] => buildWorkbenchBreadcrumbItems(options).map((item) => item.label)

export const resolveInitialWorkbenchView = (view?: WorkbenchView): WorkbenchView => {
  return view === 'diff' || view === 'split' ? view : 'editor'
}

export const workbenchOpenRequestTargets = (
  view?: WorkbenchView
): { editor: boolean; diff: boolean } => {
  const resolvedView = resolveInitialWorkbenchView(view)
  return {
    editor: resolvedView !== 'diff',
    diff: resolvedView !== 'editor'
  }
}

export const workbenchOpenRequestKey = (
  request?: WorkbenchOpenRequest | null
): string => {
  if (!request) return ''
  return `${request.nonce}\u0000${request.view ?? 'editor'}\u0000${request.path}`
}

export const buildInitialWorkbenchOpenState = (
  request?: WorkbenchOpenRequest | null
): {
  activeView: WorkbenchView
  diffSelectedPath: string
  diffSelectionRequest: EditorOpenRequest | null
  editorOpenRequest: EditorOpenRequest | null
  handledOpenRequestKey: string
} => {
  const activeView = resolveInitialWorkbenchView(request?.view)
  if (!request) {
    return {
      activeView,
      diffSelectedPath: '',
      diffSelectionRequest: null,
      editorOpenRequest: null,
      handledOpenRequestKey: ''
    }
  }
  const targets = workbenchOpenRequestTargets(request.view)
  const requestTarget = { path: request.path, nonce: request.nonce }
  return {
    activeView,
    diffSelectedPath: targets.diff ? request.path : '',
    diffSelectionRequest: targets.diff ? requestTarget : null,
    editorOpenRequest: targets.editor ? requestTarget : null,
    handledOpenRequestKey: workbenchOpenRequestKey(request)
  }
}

type WorkbenchKeyEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'key' | 'metaKey' | 'shiftKey'
>

type WorkbenchSplitResizeKeyEventLike = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'defaultPrevented' | 'key' | 'metaKey' | 'shiftKey'
>

export type WorkbenchKeyboardCommand =
  | { type: 'editor-command'; kind: FileEditorCommandKind }
  | { type: 'select-view'; view: WorkbenchView; status: string }
  | { type: 'show-in-diff' }
  | { type: 'open-in-editor' }

export function resolveWorkbenchKeyboardCommand(
  event: WorkbenchKeyEventLike,
  options: {
    hasDiffEditorTarget: boolean
    hasEditorDiffTarget: boolean
    hasEditorSelection: boolean
  }
): WorkbenchKeyboardCommand | null {
  if (event.defaultPrevented) return null

  const key = event.key.toLowerCase()
  if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && key === 'z') {
    return { type: 'editor-command', kind: 'toggle-wrap' }
  }

  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null

  if (key === 'p' && !event.shiftKey) return { type: 'editor-command', kind: 'quick-open' }
  if (key === 'w' && !event.shiftKey) return { type: 'editor-command', kind: 'close-current' }
  if (key === 's') {
    return { type: 'editor-command', kind: event.shiftKey ? 'save-all' : 'save-current' }
  }
  if (event.shiftKey && key === 'j' && options.hasEditorSelection) {
    return { type: 'editor-command', kind: 'reveal-selected' }
  }
  if (event.shiftKey && key === 'd' && options.hasEditorDiffTarget) {
    return { type: 'show-in-diff' }
  }
  if (event.shiftKey && key === 'e' && options.hasDiffEditorTarget) {
    return { type: 'open-in-editor' }
  }
  if (key === '1') {
    return { type: 'select-view', view: 'editor', status: 'Showing File Editor' }
  }
  if (key === '2') {
    return { type: 'select-view', view: 'diff', status: 'Showing Diff Studio' }
  }
  if (key === '3') {
    return { type: 'select-view', view: 'split', status: 'Showing split view' }
  }

  return null
}

export function shouldSuppressWorkbenchKeyboardShortcut(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined') return false
  if (!(target instanceof HTMLElement)) return false
  if (target.closest('.cm-editor')) return true
  if (target.closest('[role="textbox"]')) return true
  if (target.isContentEditable) return true
  const tagName = target.tagName.toLowerCase()
  return tagName === 'input' || tagName === 'textarea' || tagName === 'select'
}

export function clampWorkbenchSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return WORKBENCH_SPLIT_DEFAULT_RATIO
  return Math.max(
    WORKBENCH_SPLIT_MIN_RATIO,
    Math.min(WORKBENCH_SPLIT_MAX_RATIO, Math.round(value))
  )
}

export function resolveWorkbenchSplitResizeRatio(
  event: WorkbenchSplitResizeKeyEventLike,
  currentRatio: number
): number | null {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return null
  const ratio = clampWorkbenchSplitRatio(currentRatio)
  const step = event.shiftKey ? WORKBENCH_SPLIT_KEYBOARD_LARGE_STEP : WORKBENCH_SPLIT_KEYBOARD_STEP
  switch (event.key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return clampWorkbenchSplitRatio(ratio - step)
    case 'ArrowRight':
    case 'ArrowDown':
      return clampWorkbenchSplitRatio(ratio + step)
    case 'Home':
      return WORKBENCH_SPLIT_MIN_RATIO
    case 'End':
      return WORKBENCH_SPLIT_MAX_RATIO
    default:
      return null
  }
}

const workbenchSplitRatioStorageKey = (workspacePath: string): string =>
  `${WORKBENCH_SPLIT_RATIO_STORAGE_KEY_PREFIX}.${workspacePath || 'default'}`

const readStoredWorkbenchSplitRatio = (workspacePath: string): number => {
  if (typeof window === 'undefined') return WORKBENCH_SPLIT_DEFAULT_RATIO
  try {
    const stored = window.localStorage?.getItem(workbenchSplitRatioStorageKey(workspacePath))
    const parsed = stored ? Number(stored) : WORKBENCH_SPLIT_DEFAULT_RATIO
    return clampWorkbenchSplitRatio(parsed)
  } catch {
    return WORKBENCH_SPLIT_DEFAULT_RATIO
  }
}

const storeWorkbenchSplitRatio = (workspacePath: string, ratio: number): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.setItem(
      workbenchSplitRatioStorageKey(workspacePath),
      String(clampWorkbenchSplitRatio(ratio))
    )
  } catch {
    // Local split sizing is best-effort.
  }
}

function WorkbenchNavIcon({ view }: { view: WorkbenchView }) {
  return (
    <span className="workbench-nav-icon" aria-hidden="true">
      {view === 'editor' ? (
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 5h5l2 2h5v12H6z" />
          <path d="M9 11h6M9 14h5M9 17h7" />
        </svg>
      ) : view === 'diff' ? (
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M6 6h5M6 10h4M6 15h6M6 19h5" />
          <path d="M15 7l2 2-2 2M17 9h-5M17 14l-2 2 2 2M12 16h5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M5 5h6v14H5zM13 5h6v14h-6z" />
          <path d="M7.5 9h1M7.5 12h1M15.5 9h1M15.5 12h1M15.5 15h1" />
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
  const [initialOpenState] = useState(() => buildInitialWorkbenchOpenState(openFileRequest))
  const [activeView, setActiveView] = useState<WorkbenchView>(initialOpenState.activeView)
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null)
  const [diffGitSnapshot, setDiffGitSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [status, setStatus] = useState('Workbench ready')
  const [editorRefreshTick, setEditorRefreshTick] = useState(refreshTick)
  const [editorOpenRequest, setEditorOpenRequest] = useState<EditorOpenRequest | null>(
    initialOpenState.editorOpenRequest
  )
  const [editorCommandRequest, setEditorCommandRequest] =
    useState<FileEditorCommandRequest | null>(null)
  const [diffSelectionRequest, setDiffSelectionRequest] = useState<EditorOpenRequest | null>(
    initialOpenState.diffSelectionRequest
  )
  const [diffSelectedPath, setDiffSelectedPath] = useState(initialOpenState.diffSelectedPath)
  const [splitRatio, setSplitRatio] = useState(() => readStoredWorkbenchSplitRatio(workspacePath))
  const [editorState, setEditorState] = useState<FileEditorPanelState>(DEFAULT_EDITOR_STATE)
  const [diffActionPath, setDiffActionPath] = useState('')
  const diffRefreshSeqRef = useRef(0)
  const handledOpenRequestKeyRef = useRef(initialOpenState.handledOpenRequestKey)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const splitResizeCleanupRef = useRef<(() => void) | null>(null)
  const editorNavRef = useRef<HTMLButtonElement | null>(null)
  const diffNavRef = useRef<HTMLButtonElement | null>(null)
  const splitNavRef = useRef<HTMLButtonElement | null>(null)
  const splitStageStyle =
    activeView === 'split'
      ? ({
          '--workbench-editor-split': `${splitRatio}%`
        } as CSSProperties)
      : undefined

  const breadcrumbItems = useMemo(
    () =>
      buildWorkbenchBreadcrumbItems({
        activeView,
        diffSelectedPath,
        editorSelectedPath: editorState.selectedPath,
        workspaceName
      }),
    [activeView, diffSelectedPath, editorState.selectedPath, workspaceName]
  )
  const activeGitSnapshot =
    activeView === 'diff' || activeView === 'split'
      ? (diffGitSnapshot ?? editorState.gitSnapshot)
      : editorState.gitSnapshot
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
    (activeView === 'editor' || activeView === 'split') && editorState.selectedPath
      ? `Ln ${editorState.cursorStatus.line}, Col ${editorState.cursorStatus.column}${
          editorState.cursorStatus.selectedChars > 0
            ? ` · ${editorState.cursorStatus.selectedChars} selected`
            : ''
        }`
      : activeView === 'diff' && diffSelectedPath
        ? diffSelectedPath
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
  const editorNavMeta = buildEditorWorkbenchNavMeta(editorState)
  const diffNavMeta = buildDiffWorkbenchNavMeta(diffGitSnapshot)
  const editorBusy = editorState.isLoading || editorState.isListLoading
  const workbenchStatus =
    activeView === 'editor' || activeView === 'split'
      ? editorState.status || editorState.gitMessage || status
      : status
  const editorDiffActionPath =
    activeView === 'editor' || activeView === 'split' ? editorState.selectedPath : ''
  const diffEditorActionPath =
    activeView === 'diff' || activeView === 'split' ? diffSelectedPath : ''

  const focusNavItem = useCallback((view: WorkbenchView) => {
    const navButton =
      view === 'editor'
        ? editorNavRef.current
        : view === 'diff'
          ? diffNavRef.current
          : splitNavRef.current
    navButton?.focus()
  }, [])

  const updateSplitRatio = useCallback(
    (ratio: number) => {
      const nextRatio = clampWorkbenchSplitRatio(ratio)
      setSplitRatio(nextRatio)
      storeWorkbenchSplitRatio(workspacePath, nextRatio)
      return nextRatio
    },
    [workspacePath]
  )

  useEffect(() => {
    setSplitRatio(readStoredWorkbenchSplitRatio(workspacePath))
  }, [workspacePath])

  const selectWorkbenchView = useCallback(
    (view: WorkbenchView, options?: { focusNav?: boolean }) => {
      handledOpenRequestKeyRef.current = workbenchOpenRequestKey(openFileRequest)
      setActiveView(view)
      if (options?.focusNav) {
        window.requestAnimationFrame(() => focusNavItem(view))
      }
    },
    [focusNavItem, openFileRequest]
  )

  const dispatchEditorCommand = useCallback(
    (kind: FileEditorCommandKind) => {
      if (activeView !== 'split') {
        selectWorkbenchView('editor')
      }
      setEditorCommandRequest((current) => ({
        kind,
        nonce: (current?.nonce ?? 0) + 1
      }))
      setStatus(
        kind === 'quick-open'
          ? 'Opening quick open'
          : kind === 'close-current'
            ? 'Closing current file'
            : kind === 'save-all'
              ? 'Saving all dirty files'
              : kind === 'save-current'
                ? 'Saving current file'
                : kind === 'reveal-selected'
                  ? 'Revealing selected file'
                  : 'Toggling line wrap'
      )
    },
    [activeView, selectWorkbenchView]
  )

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
    if (activeView === 'split') {
      setEditorRefreshTick((tick) => tick + 1)
      void refreshDiff()
      setStatus('Refreshing workbench')
      return
    }
    setEditorRefreshTick((tick) => tick + 1)
    setStatus('Refreshing editor')
  }, [activeView, refreshDiff])

  const openFileInEditor = useCallback((path: string) => {
    if (activeView !== 'split') {
      selectWorkbenchView('editor')
    }
    setEditorOpenRequest((current) => ({
      path,
      nonce: (current?.nonce ?? 0) + 1
    }))
    setStatus(`Opening ${path}`)
  }, [activeView, selectWorkbenchView])

  const openFileInSplit = useCallback(
    (path: string) => {
      selectWorkbenchView('split')
      setEditorOpenRequest((current) => ({
        path,
        nonce: (current?.nonce ?? 0) + 1
      }))
      setDiffSelectedPath(path)
      setDiffSelectionRequest((current) => ({
        path,
        nonce: (current?.nonce ?? 0) + 1
      }))
      setStatus(`Opening split view for ${path}`)
    },
    [selectWorkbenchView]
  )

  const showFileInDiff = useCallback((path: string) => {
    if (activeView !== 'split') {
      selectWorkbenchView('diff')
    }
    setDiffSelectedPath(path)
    setDiffSelectionRequest((current) => ({
      path,
      nonce: (current?.nonce ?? 0) + 1
    }))
    setStatus(`Showing diff for ${path}`)
  }, [activeView, selectWorkbenchView])

  const handleWorkbenchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (shouldSuppressWorkbenchKeyboardShortcut(event.target)) return
      const command = resolveWorkbenchKeyboardCommand(event, {
        hasDiffEditorTarget: Boolean(diffEditorActionPath),
        hasEditorDiffTarget: Boolean(editorDiffActionPath),
        hasEditorSelection: Boolean(editorState.selectedPath)
      })
      if (!command) return

      event.preventDefault()
      if (command.type === 'editor-command') {
        dispatchEditorCommand(command.kind)
        return
      }
      if (command.type === 'select-view') {
        selectWorkbenchView(command.view, { focusNav: true })
        setStatus(command.status)
        return
      }
      if (command.type === 'show-in-diff') {
        showFileInDiff(editorDiffActionPath)
        return
      }
      openFileInEditor(diffEditorActionPath)
    },
    [
      diffEditorActionPath,
      dispatchEditorCommand,
      editorDiffActionPath,
      editorState.selectedPath,
      openFileInEditor,
      selectWorkbenchView,
      showFileInDiff
    ]
  )

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

  const handleSplitResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const nextRatio = resolveWorkbenchSplitResizeRatio(event, splitRatio)
      if (nextRatio === null) return
      event.preventDefault()
      event.stopPropagation()
      updateSplitRatio(nextRatio)
      setStatus(`Editor pane ${nextRatio}%`)
    },
    [splitRatio, updateSplitRatio]
  )

  const handleSplitResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (activeView !== 'split') return
      const stageElement = stageRef.current
      if (!stageElement) return
      event.preventDefault()
      event.stopPropagation()
      const pointerId = event.pointerId
      const resizerElement = event.currentTarget
      splitResizeCleanupRef.current?.()
      resizerElement.setPointerCapture?.(pointerId)
      let latestRatio = splitRatio
      const updateFromClientX = (clientX: number) => {
        const rect = stageElement.getBoundingClientRect()
        if (rect.width <= 0) return
        latestRatio = updateSplitRatio(((clientX - rect.left) / rect.width) * 100)
      }
      updateFromClientX(event.clientX)
      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault()
        updateFromClientX(moveEvent.clientX)
      }
      const cleanupSession = startWorkbenchSplitResizeSession({
        onFinish: () => {
          splitResizeCleanupRef.current = null
          setStatus(`Editor pane ${latestRatio}%`)
        },
        onPointerMove: handlePointerMove,
        pointerId,
        resizerElement,
        windowTarget: window
      })
      splitResizeCleanupRef.current = () => {
        cleanupSession()
        splitResizeCleanupRef.current = null
      }
    },
    [activeView, splitRatio, updateSplitRatio]
  )

  const runBreadcrumbAction = useCallback(
    (item: WorkbenchBreadcrumbItem) => {
      if (!item.action) return
      if (item.action.kind === 'select-view') {
        selectWorkbenchView(item.action.view, { focusNav: true })
        setStatus(`Showing ${viewLabel(item.action.view)}`)
        return
      }
      if (item.action.kind === 'reveal-editor-file') {
        dispatchEditorCommand('reveal-selected')
        return
      }
      openFileInEditor(item.action.path)
    },
    [dispatchEditorCommand, openFileInEditor, selectWorkbenchView]
  )

  useEffect(() => {
    if (activeView !== 'split') {
      splitResizeCleanupRef.current?.()
    }
  }, [activeView])

  useEffect(() => {
    return () => {
      splitResizeCleanupRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (!openFileRequest) return
    const requestKey = workbenchOpenRequestKey(openFileRequest)
    if (handledOpenRequestKeyRef.current === requestKey) return
    handledOpenRequestKeyRef.current = requestKey
    if (openFileRequest.view === 'diff') {
      showFileInDiff(openFileRequest.path)
      return
    }
    if (openFileRequest.view === 'split') {
      openFileInSplit(openFileRequest.path)
      return
    }
    openFileInEditor(openFileRequest.path)
  }, [openFileInEditor, openFileInSplit, openFileRequest, showFileInDiff])

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
      if (activeView === 'diff' || activeView === 'split') {
        void refreshDiff()
      }
    })
    return () => {
      cancelled = true
    }
  }, [activeView, refreshDiff, refreshTick])

  useEffect(() => {
    if ((activeView !== 'diff' && activeView !== 'split') || diff) return
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
          <small>{editorNavMeta}</small>
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
          <small>{diffNavMeta}</small>
        </button>
        <button
          ref={splitNavRef}
          className={`workbench-nav-item ${activeView === 'split' ? 'active' : ''}`}
          type="button"
          role="tab"
          id="workbench-split-tab"
          aria-selected={activeView === 'split'}
          aria-controls="workbench-editor-panel workbench-diff-panel"
          aria-keyshortcuts="Meta+3 Control+3"
          tabIndex={activeView === 'split' ? 0 : -1}
          onClick={() => selectWorkbenchView('split')}
          onKeyDown={(event) => handleNavKeyDown(event, 'split')}
        >
          <WorkbenchNavIcon view="split" />
          <span>Split</span>
          <small>Editor + diff</small>
        </button>
      </aside>
      <div className="workbench-main">
        <div className="workbench-toolbar">
          <nav className="workbench-breadcrumbs" aria-label="Workbench breadcrumbs">
            {breadcrumbItems.map((item, index) => (
              <span key={item.key}>
                {index > 0 && <span aria-hidden="true">/</span>}
                {item.action ? (
                  <button
                    className={`workbench-breadcrumb-button${item.current ? ' current' : ''}`}
                    type="button"
                    onClick={() => runBreadcrumbAction(item)}
                    title={index === 0 ? `${item.title} · ${workspacePath}` : item.title}
                    aria-label={item.title}
                    aria-current={item.current ? 'page' : undefined}
                  >
                    {item.label}
                  </button>
                ) : (
                  <span
                    className="workbench-breadcrumb-label"
                    title={item.title}
                    aria-current={item.current ? 'page' : undefined}
                  >
                    {item.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
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
            {(activeView === 'editor' || activeView === 'split') && (
              <>
                <button
                  className="btn btn-sm btn-ghost"
                  type="button"
                  onClick={() => dispatchEditorCommand('reveal-selected')}
                  disabled={!editorState.selectedPath || editorBusy}
                  aria-label={
                    editorState.selectedPath
                      ? `Reveal ${editorState.selectedPath} in file tree`
                      : 'Reveal selected file in file tree'
                  }
                  aria-keyshortcuts="Meta+Shift+J Control+Shift+J"
                  title={
                    editorState.selectedPath
                      ? `Reveal ${editorState.selectedPath} in file tree`
                      : 'Select a file to reveal it in the tree'
                  }
                >
                  Reveal
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  type="button"
                  onClick={() => dispatchEditorCommand('toggle-wrap')}
                  disabled={editorBusy}
                  aria-keyshortcuts="Alt+Z"
                  aria-pressed={editorState.lineWrapEnabled}
                  title={
                    editorState.lineWrapEnabled ? 'Disable line wrap' : 'Enable line wrap'
                  }
                >
                  Wrap
                </button>
              </>
            )}
            {(activeView === 'editor' || activeView === 'split') && (
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => {
                  if (editorDiffActionPath) showFileInDiff(editorDiffActionPath)
                }}
                disabled={!editorDiffActionPath || editorBusy}
                aria-keyshortcuts="Meta+Shift+D Control+Shift+D"
                aria-label={
                  editorDiffActionPath
                    ? `Show ${editorDiffActionPath} in Diff Studio`
                    : 'Show selected file in Diff Studio'
                }
                title={
                  editorDiffActionPath
                    ? `Show ${editorDiffActionPath} in Diff Studio`
                    : 'Select a file to show its diff'
                }
              >
                Show in Diff
              </button>
            )}
            {diffEditorActionPath && (
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => openFileInEditor(diffEditorActionPath)}
                disabled={editorBusy}
                aria-keyshortcuts="Meta+Shift+E Control+Shift+E"
                aria-label={`Open ${diffEditorActionPath} in editor`}
                title={`Open ${diffEditorActionPath} in editor`}
              >
                Open in Editor
              </button>
            )}
            <span className="workbench-status" role="status" aria-live="polite">
              {workbenchStatus}
            </span>
            <button className="btn btn-sm" type="button" onClick={refreshActiveView}>
              Refresh
            </button>
          </div>
        </div>
        <div
          ref={stageRef}
          className={`workbench-stage ${activeView === 'split' ? 'split' : ''}`}
          style={splitStageStyle}
        >
          <div
            className="workbench-pane workbench-editor-pane"
            role="tabpanel"
            id="workbench-editor-panel"
            aria-labelledby={activeView === 'split' ? 'workbench-split-tab' : 'workbench-editor-tab'}
            hidden={isWorkbenchPaneHidden(activeView, 'editor')}
          >
            <FileEditorPanel
              workspacePath={workspacePath}
              refreshTick={editorRefreshTick}
              openRequest={editorOpenRequest}
              commandRequest={editorCommandRequest}
              onShowInDiff={showFileInDiff}
              onDirtyChange={onDirtyChange}
              onEditorStateChange={setEditorState}
            />
          </div>
          {activeView === 'split' && (
            <div
              className="workbench-split-resizer"
              role="separator"
              aria-label="Resize editor and diff panes"
              aria-orientation="vertical"
              aria-valuemin={WORKBENCH_SPLIT_MIN_RATIO}
              aria-valuemax={WORKBENCH_SPLIT_MAX_RATIO}
              aria-valuenow={splitRatio}
              aria-valuetext={`Editor pane ${splitRatio}%`}
              tabIndex={0}
              title="Drag to resize split panes"
              onKeyDown={handleSplitResizeKeyDown}
              onPointerDown={handleSplitResizePointerDown}
            >
              <span aria-hidden="true" />
            </div>
          )}
          <div
            className="workbench-pane workbench-diff-pane"
            role="tabpanel"
            id="workbench-diff-panel"
            aria-labelledby={activeView === 'split' ? 'workbench-split-tab' : 'workbench-diff-tab'}
            hidden={isWorkbenchPaneHidden(activeView, 'diff')}
          >
            <div className="diff-studio popout-diff-studio">
              <DiffViewer
                diff={diff}
                workspacePath={workspacePath}
                gitSnapshot={diffGitSnapshot}
                busyPath={diffActionPath}
                selectionRequest={diffSelectionRequest}
                onSelectedPathChange={(path) => setDiffSelectedPath(path ?? '')}
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
            {activeView === 'editor' || activeView === 'split' ? `${editorBufferSummary} · ` : ''}
            {editorDirtySummary ? `${editorDirtySummary} · ` : ''}
            {editorCursorSummary}
            {activeView === 'editor' || activeView === 'split'
              ? ` · ${editorState.lineWrapEnabled ? 'Wrap' : 'No wrap'}`
              : ''}
          </span>
        </footer>
      </div>
    </section>
  )
}
