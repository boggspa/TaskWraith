import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { createPortal } from 'react-dom'
import { keymap, EditorView, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import {
  acceptCompletion,
  autocompletion,
  completeAnyWord,
  completionStatus,
  type CompletionSource
} from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { markdown } from '@codemirror/lang-markdown'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { cpp } from '@codemirror/lang-cpp'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { tags } from '@lezer/highlight'
import type { WorkspaceFileEntry, WorkspaceFileReadResult } from '../../../main/store/types'
import type { GitFileStatus, GitRepositorySnapshot } from '../../../main/services/GitService'
import {
  bufferFromReadResult,
  closeBuffer,
  isBufferDirty,
  mergeSavedBufferResult,
  updateBuffer,
  upsertBuffer,
  type EditorBuffer
} from './FileEditorBufferModel'
import { FileTypeIcon } from './FileTypeIcon'
import { EditorPane } from './FileEditorPane'
import { FileEditorGitActions } from './FileEditorGitActions'
import {
  FileEditorStatusBar,
  type EditorCursorStatus
} from './FileEditorStatusBar'
import { EditorTabStrip } from './FileEditorTabStrip'
import {
  fileNameForPath,
  formatBytes,
  parentDirectoryForPath,
  type FileEditorContextMenuAnchor
} from './FileEditorUtils'
import { WorkspaceFileTree } from './WorkspaceFileTree'

interface FileEditorPanelProps {
  workspacePath?: string
  width?: number
  refreshTick?: number
  openRequest?: FileEditorOpenRequest | null
  commandRequest?: FileEditorCommandRequest | null
  onDirtyChange?: (dirtyBufferCount: number) => void
  onEditorStateChange?: (state: FileEditorPanelState) => void
}

interface FileEditorOpenRequest {
  path: string
  nonce: number
}

export type FileEditorCommandKind =
  | 'save-current'
  | 'save-all'
  | 'quick-open'
  | 'reveal-selected'
  | 'toggle-wrap'

export interface FileEditorCommandRequest {
  kind: FileEditorCommandKind
  nonce: number
}

interface WorkspaceFileListOptions {
  path?: string
  query?: string
  limit?: number
}

interface WorkspaceFileListResult {
  entries: WorkspaceFileEntry[]
  truncated: boolean
}

type FileEditorContextMenuSelection =
  | {
      kind: 'tree'
      anchor: FileEditorContextMenuAnchor
      entry: WorkspaceFileEntry
    }
  | {
      kind: 'tab'
      anchor: FileEditorContextMenuAnchor
      path: string
    }

export type FileEditorDirtyActionKind = 'reload' | 'discard'

interface FileEditorPendingDirtyAction {
  kind: FileEditorDirtyActionKind
  path: string
}

interface FileEditorContextMenuItem {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  onSelect: () => void
}

interface FileEditorContextMenuProps {
  selection: FileEditorContextMenuSelection | null
  items: FileEditorContextMenuItem[]
  onClose: () => void
}

export interface FileEditorPanelState {
  selectedPath: string
  dirtyBufferCount: number
  openBufferCount: number
  cursorStatus: EditorCursorStatus
  gitSnapshot: GitRepositorySnapshot | null
  lineWrapEnabled: boolean
  isLoading: boolean
  isListLoading: boolean
  status: string
  gitMessage: string
}

interface QuickOpenPaletteProps {
  workspacePath?: string
  query: string
  results: WorkspaceFileEntry[]
  status: string
  isLoading: boolean
  selectedIndex: number
  onQueryChange: (value: string) => void
  onSelectedIndexChange: (index: number) => void
  onOpenPath: (path: string) => void | Promise<void>
  onClose: () => void
}

const ROOT_DIR_KEY = ''
const FILE_EDITOR_DIRECTORY_LIMIT = 500
const FILE_EDITOR_SEARCH_LIMIT = 500
const DEFAULT_CURSOR_STATUS: EditorCursorStatus = { line: 1, column: 1, selectedChars: 0 }

const normalizeAbsolutePath = (path: string): string => {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

const pathCompletionSource = (entries: WorkspaceFileEntry[]): CompletionSource => {
  const completionEntries = entries.filter((entry) => !entry.isDirectory)
  return (context) => {
    const token = context.matchBefore(/[\w./@-]+/)
    if (!token) return null
    const query = token.text.trim()
    if (!context.explicit && !query.includes('/') && !query.startsWith('.')) return null
    const lowerQuery = query.replace(/^\.\//, '').toLowerCase()
    const options = completionEntries
      .filter((entry) => entry.path.toLowerCase().includes(lowerQuery))
      .slice(0, 80)
      .map((entry) => ({
        label: entry.path,
        type: 'file',
        detail: formatBytes(entry.sizeBytes)
      }))
    if (options.length === 0) return null
    return {
      from: token.from,
      options,
      validFor: /^[\w./@-]*$/
    }
  }
}

export const explicitOnlyCompletionSource = (source: CompletionSource): CompletionSource => {
  return (context) => (context.explicit ? source(context) : null)
}

const codeEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      background: 'transparent',
      color: 'var(--text-primary)',
      fontSize: '12px'
    },
    '&.cm-focused': {
      outline: 'none'
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: '20px',
      background: 'transparent',
      overflow: 'auto'
    },
    '.cm-content': {
      padding: 'var(--space-sm) 0',
      caretColor: 'var(--accent)',
      background: 'transparent',
      minWidth: 'max-content'
    },
    '.cm-line': {
      padding: '0 var(--space-sm)',
      background: 'transparent',
      whiteSpace: 'pre'
    },
    '.cm-gutters': {
      background: 'var(--cm-gutter-bg)',
      color: 'var(--text-muted)',
      borderRight: '1px solid var(--cm-gutter-border)'
    },
    '.cm-activeLine': {
      background: 'var(--cm-active-line)'
    },
    '.cm-activeLineGutter': {
      background: 'var(--cm-active-line)',
      color: 'var(--text-secondary)'
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      background: 'color-mix(in srgb, var(--accent) 34%, transparent)'
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      background: 'var(--cm-bracket-match)',
      outline: '1px solid var(--accent)'
    },
    '.cm-line ::selection, .cm-content ::selection': {
      background: 'color-mix(in srgb, var(--accent) 34%, transparent)'
    }
  },
  { dark: true }
)

const codeLineWrapTheme = EditorView.theme({
  '.cm-content': {
    minWidth: '0'
  },
  '.cm-line': {
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere'
  }
})

const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--cm-keyword)', fontWeight: '600' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName], color: 'var(--cm-name)' },
  { tag: [tags.propertyName, tags.variableName, tags.labelName], color: 'var(--cm-property)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--cm-function)'
  },
  { tag: [tags.className, tags.definition(tags.typeName), tags.typeName], color: 'var(--cm-type)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--cm-number)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--cm-string)' },
  { tag: [tags.regexp, tags.escape], color: 'var(--cm-regexp)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--cm-comment)',
    fontStyle: 'italic'
  },
  { tag: tags.meta, color: 'var(--cm-meta)' },
  { tag: tags.heading, color: 'var(--cm-heading)', fontWeight: '700' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--cm-invalid)' }
])

const shellLanguage = StreamLanguage.define(shell)

const extensionForPath = (filePath: string): Extension[] => {
  const lower = filePath.toLowerCase()
  if (/\.(js|jsx|mjs|cjs)$/.test(lower)) return [javascript({ jsx: true })]
  if (/\.(ts|tsx)$/.test(lower)) return [javascript({ jsx: lower.endsWith('x'), typescript: true })]
  if (/\.py$/.test(lower)) return [python()]
  if (/\.(md|markdown)$/.test(lower)) return [markdown()]
  if (/\.json(c)?$/.test(lower)) return [json()]
  if (/\.(html|htm|xml|svg)$/.test(lower)) return [html()]
  if (/\.(css|scss|sass|less)$/.test(lower)) return [css()]
  if (/\.(c|h|cc|cpp|cxx|hpp|hh|m|mm|metal|swift)$/.test(lower)) return [cpp()]
  if (
    /\.(sh|bash|zsh|fish|command|env)$/.test(lower) ||
    /(^|\/)(bashrc|zshrc|profile|env)$/.test(lower)
  )
    return [shellLanguage]
  return []
}

const editorApi = {
  listFiles: (
    workspacePath: string,
    options: WorkspaceFileListOptions = {}
  ): Promise<WorkspaceFileListResult> => {
    return window.api.listWorkspaceFilesForEditor(workspacePath, options)
  },
  readFile: (workspacePath: string, filePath: string): Promise<WorkspaceFileReadResult> => {
    return window.api.readWorkspaceFile(workspacePath, filePath)
  },
  writeFile: (
    workspacePath: string,
    filePath: string,
    content: string,
    baseEtag?: string | null
  ): Promise<WorkspaceFileReadResult> => {
    return window.api.writeWorkspaceFile(workspacePath, filePath, content, baseEtag)
  },
  deleteFile: (
    workspacePath: string,
    filePath: string,
    baseEtag?: string | null
  ): Promise<{ path: string }> => {
    return window.api.deleteWorkspaceFile(workspacePath, filePath, baseEtag)
  },
  gitSnapshot: (workspacePath: string) => {
    return window.api.gitSnapshot({ workspacePath })
  },
  gitStageFile: (workspacePath: string, filePath: string) => {
    return window.api.gitStage({ workspacePath, paths: [filePath] })
  },
  gitUnstageFile: (workspacePath: string, filePath: string) => {
    return window.api.gitUnstage({ workspacePath, paths: [filePath] })
  },
  gitCommit: (workspacePath: string, message: string) => {
    return window.api.gitCommit({ workspacePath, message })
  }
}

export const fileEditorDirtyActionCopy = (
  kind: FileEditorDirtyActionKind,
  path: string
): { title: string; body: string; confirmLabel: string; danger: boolean } => {
  if (kind === 'reload') {
    return {
      title: 'Reload from disk?',
      body: `Reloading ${path} will replace your unsaved edits with the file on disk.`,
      confirmLabel: 'Reload',
      danger: false
    }
  }
  return {
    title: 'Discard changes?',
    body: `Discard unsaved edits in ${path}?`,
    confirmLabel: 'Discard',
    danger: true
  }
}

export const isFileEditorPromptDismissKey = (key: string): boolean => key === 'Escape'

const dismissFileEditorPromptOnEscape = (
  event: ReactKeyboardEvent,
  onDismiss: () => void
): void => {
  if (!isFileEditorPromptDismissKey(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  onDismiss()
}

function focusFileEditorContextMenuButton(
  menu: HTMLDivElement,
  direction: 'first' | 'last' | 'next' | 'previous'
): void {
  const buttons = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('.file-editor-context-menu-item:not(:disabled)')
  )
  if (buttons.length === 0) return
  const activeIndex = buttons.findIndex((button) => button === document.activeElement)
  if (direction === 'first') {
    buttons[0]?.focus()
    return
  }
  if (direction === 'last') {
    buttons[buttons.length - 1]?.focus()
    return
  }
  const fallbackIndex = direction === 'next' ? -1 : 0
  const currentIndex = activeIndex >= 0 ? activeIndex : fallbackIndex
  const delta = direction === 'next' ? 1 : -1
  const nextIndex = (currentIndex + delta + buttons.length) % buttons.length
  buttons[nextIndex]?.focus()
}

export function FileEditorPanel({
  workspacePath,
  width,
  refreshTick = 0,
  openRequest,
  commandRequest,
  onDirtyChange,
  onEditorStateChange
}: FileEditorPanelProps) {
  const [childrenByDirectory, setChildrenByDirectory] = useState<
    Record<string, WorkspaceFileEntry[]>
  >({})
  const [truncatedDirectories, setTruncatedDirectories] = useState<Record<string, boolean>>({})
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set())
  const [searchFiles, setSearchFiles] = useState<WorkspaceFileEntry[]>([])
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [filter, setFilter] = useState('')
  const [buffers, setBuffers] = useState<EditorBuffer[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [cursorStatus, setCursorStatus] = useState<EditorCursorStatus>(DEFAULT_CURSOR_STATUS)
  const [status, setStatus] = useState('')
  const [listMessage, setListMessage] = useState('')
  const [gitSnapshot, setGitSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [gitMessage, setGitMessage] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isListLoading, setIsListLoading] = useState(false)
  const [pendingClosePath, setPendingClosePath] = useState('')
  const [pendingDirtyAction, setPendingDirtyAction] =
    useState<FileEditorPendingDirtyAction | null>(null)
  const [lineWrapEnabled, setLineWrapEnabled] = useState(false)
  const [showQuickOpen, setShowQuickOpen] = useState(false)
  const [quickOpenQuery, setQuickOpenQuery] = useState('')
  const [quickOpenResults, setQuickOpenResults] = useState<WorkspaceFileEntry[]>([])
  const [quickOpenTruncated, setQuickOpenTruncated] = useState(false)
  const [quickOpenMessage, setQuickOpenMessage] = useState('')
  const [isQuickOpenLoading, setIsQuickOpenLoading] = useState(false)
  const [quickOpenSelectedIndex, setQuickOpenSelectedIndex] = useState(0)
  const [contextMenuSelection, setContextMenuSelection] =
    useState<FileEditorContextMenuSelection | null>(null)
  const lastRefreshTickRef = useRef(refreshTick)
  const lastOpenRequestRef = useRef<number | null>(null)
  const lastCommandRequestRef = useRef<number | null>(null)
  const refreshRequestSeqRef = useRef(0)
  const commandHandlersRef = useRef<Partial<Record<FileEditorCommandKind, () => void>>>({})
  const activeBuffer = useMemo(
    () => buffers.find((buffer) => buffer.path === selectedPath) ?? null,
    [buffers, selectedPath]
  )
  const content = activeBuffer?.content ?? ''
  const isDirty = isBufferDirty(activeBuffer)
  const selectedName = fileNameForPath(selectedPath)
  const trimmedFilter = filter.trim()
  const isFiltering = trimmedFilter.length > 0
  const dirtyBufferCount = buffers.filter(isBufferDirty).length

  useEffect(() => {
    onDirtyChange?.(dirtyBufferCount)
  }, [dirtyBufferCount, onDirtyChange])

  useEffect(() => {
    onEditorStateChange?.({
      selectedPath,
      dirtyBufferCount,
      openBufferCount: buffers.length,
      cursorStatus,
      gitSnapshot,
      lineWrapEnabled,
      isLoading,
      isListLoading,
      status,
      gitMessage
    })
  }, [
    buffers.length,
    cursorStatus,
    dirtyBufferCount,
    gitMessage,
    gitSnapshot,
    isLoading,
    isListLoading,
    lineWrapEnabled,
    onEditorStateChange,
    selectedPath,
    status
  ])

  const browseFiles = useMemo(() => {
    const rows: WorkspaceFileEntry[] = []
    const appendChildren = (dirPath: string): void => {
      for (const entry of childrenByDirectory[dirPath] ?? []) {
        rows.push(entry)
        if (entry.isDirectory && expandedDirectories.has(entry.path)) {
          appendChildren(entry.path)
        }
      }
    }
    appendChildren(ROOT_DIR_KEY)
    return rows
  }, [childrenByDirectory, expandedDirectories])

  const displayedFiles = isFiltering ? searchFiles : browseFiles
  const quickOpenTrimmedQuery = quickOpenQuery.trim()
  const completionFiles = useMemo(() => {
    const byPath = new Map<string, WorkspaceFileEntry>()
    for (const entry of browseFiles) byPath.set(entry.path, entry)
    for (const entry of searchFiles) byPath.set(entry.path, entry)
    return Array.from(byPath.values())
  }, [browseFiles, searchFiles])
  const displayedQuickOpenFiles = useMemo(() => {
    if (quickOpenTrimmedQuery) return quickOpenResults
    return completionFiles.filter((entry) => !entry.isDirectory).slice(0, 80)
  }, [completionFiles, quickOpenResults, quickOpenTrimmedQuery])
  const quickOpenStatus = useMemo(() => {
    if (!workspacePath) return 'No workspace selected'
    if (isQuickOpenLoading) return 'Searching...'
    if (quickOpenMessage) return quickOpenMessage
    if (quickOpenTrimmedQuery) {
      return `${displayedQuickOpenFiles.length} ${
        displayedQuickOpenFiles.length === 1 ? 'match' : 'matches'
      }${quickOpenTruncated ? ' · keep narrowing' : ''}`
    }
    if (displayedQuickOpenFiles.length === 0) return 'No files loaded'
    return `${displayedQuickOpenFiles.length} visible ${
      displayedQuickOpenFiles.length === 1 ? 'file' : 'files'
    }`
  }, [
    displayedQuickOpenFiles.length,
    isQuickOpenLoading,
    quickOpenMessage,
    quickOpenTrimmedQuery,
    quickOpenTruncated,
    workspacePath
  ])

  const workspaceRepoPrefix = useMemo(() => {
    const repoRoot = gitSnapshot?.repoRoot
    if (!repoRoot || !workspacePath) return ''
    const normalizedRepo = normalizeAbsolutePath(repoRoot)
    const normalizedWorkspace = normalizeAbsolutePath(workspacePath)
    if (normalizedWorkspace === normalizedRepo) return ''
    if (normalizedWorkspace.startsWith(`${normalizedRepo}/`)) {
      return normalizedWorkspace.slice(normalizedRepo.length + 1)
    }
    return ''
  }, [gitSnapshot?.repoRoot, workspacePath])

  const selectedRepoPath = useMemo(() => {
    if (!selectedPath) return ''
    if (workspaceRepoPrefix) return `${workspaceRepoPrefix}/${selectedPath}`
    return selectedPath
  }, [selectedPath, workspaceRepoPrefix])

  const selectedGitFile = useMemo<GitFileStatus | undefined>(() => {
    if (!selectedRepoPath) return undefined
    return gitSnapshot?.files.find((file) => file.path === selectedRepoPath)
  }, [gitSnapshot?.files, selectedRepoPath])

  const stagedFileCounts = useMemo(() => {
    const stagedFiles = (gitSnapshot?.files ?? []).filter((file) => file.staged)
    if (!workspaceRepoPrefix) {
      return { staged: stagedFiles.length, outOfScope: 0 }
    }
    const prefix = `${workspaceRepoPrefix}/`
    let staged = 0
    let outOfScope = 0
    for (const file of stagedFiles) {
      if (file.path === workspaceRepoPrefix || file.path.startsWith(prefix)) {
        staged += 1
      } else {
        outOfScope += 1
      }
    }
    return { staged, outOfScope }
  }, [gitSnapshot?.files, workspaceRepoPrefix])
  const stagedCount = stagedFileCounts.staged
  const outOfScopeStagedCount = stagedFileCounts.outOfScope
  const selectedHasUnstagedChanges = Boolean(selectedGitFile?.unstaged)
  const selectedHasStagedChanges = Boolean(selectedGitFile?.staged)

  const fileListStatus = useMemo(() => {
    if (!workspacePath) return 'No workspace selected'
    if (isFiltering) {
      if (listMessage) return listMessage
      if (isListLoading) return `Searching "${trimmedFilter}"...`
      if (searchFiles.length === 0) return `No matches for "${trimmedFilter}"`
      return `${searchFiles.length} ${searchFiles.length === 1 ? 'match' : 'matches'}${
        searchTruncated ? ' · keep typing to narrow' : ''
      }`
    }
    if (listMessage) return listMessage
    const rootEntries = childrenByDirectory[ROOT_DIR_KEY] ?? []
    if (isListLoading && rootEntries.length === 0) return 'Loading files...'
    return `${rootEntries.length} ${rootEntries.length === 1 ? 'item' : 'items'} in root${
      truncatedDirectories[ROOT_DIR_KEY] ? ' · folder truncated; filter searches workspace' : ''
    }`
  }, [
    childrenByDirectory,
    isFiltering,
    isListLoading,
    listMessage,
    searchFiles.length,
    searchTruncated,
    trimmedFilter,
    truncatedDirectories,
    workspacePath
  ])

  const updateCursorStatus = useCallback((update: ViewUpdate) => {
    const selection = update.state.selection
    const head = selection.main.head
    const line = update.state.doc.lineAt(head)
    const selectedChars = selection.ranges.reduce(
      (total, range) => total + Math.abs(range.to - range.from),
      0
    )
    setCursorStatus({
      line: line.number,
      column: head - line.from + 1,
      selectedChars
    })
  }, [])

  const editorExtensions = useMemo<Extension[]>(
    () => [
      codeEditorTheme,
      ...(lineWrapEnabled ? [EditorView.lineWrapping, codeLineWrapTheme] : []),
      syntaxHighlighting(codeHighlightStyle),
      highlightSelectionMatches(),
      autocompletion({
        override: [
          pathCompletionSource(completionFiles),
          explicitOnlyCompletionSource(completeAnyWord)
        ],
        defaultKeymap: true
      }),
      EditorView.updateListener.of(updateCursorStatus),
      keymap.of([
        {
          key: 'Tab',
          run: (view) => {
            if (completionStatus(view.state) !== 'active') return false
            return acceptCompletion(view)
          }
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap
      ]),
      ...extensionForPath(selectedPath)
    ],
    [completionFiles, lineWrapEnabled, selectedPath, updateCursorStatus]
  )

  const loadDirectory = useCallback(
    async (dirPath = ROOT_DIR_KEY): Promise<WorkspaceFileListResult> => {
      if (!workspacePath) return { entries: [], truncated: false }

      const result = await editorApi.listFiles(workspacePath, {
        path: dirPath,
        limit: FILE_EDITOR_DIRECTORY_LIMIT
      })
      setChildrenByDirectory((current) => ({
        ...current,
        [dirPath]: result.entries
      }))
      setTruncatedDirectories((current) => ({
        ...current,
        [dirPath]: result.truncated
      }))
      return result
    },
    [workspacePath]
  )

  const refreshGitSnapshot = useCallback(async (requestId?: number) => {
    const isCurrentRefresh = () =>
      requestId === undefined || requestId === refreshRequestSeqRef.current
    if (!workspacePath) {
      if (!isCurrentRefresh()) return
      setGitSnapshot(null)
      setGitMessage('')
      return
    }
    try {
      const result = await editorApi.gitSnapshot(workspacePath)
      if (!isCurrentRefresh()) return
      if (result.ok) {
        setGitSnapshot(result.data)
        setGitMessage('')
      } else {
        setGitSnapshot(null)
        setGitMessage(result.error)
      }
    } catch (error) {
      if (!isCurrentRefresh()) return
      setGitSnapshot(null)
      setGitMessage(error instanceof Error ? error.message : 'Could not read git status')
    }
  }, [workspacePath])

  const refreshFiles = useCallback(
    async (
      options: {
        resetNavigation?: boolean
        expandedPaths?: string[]
        filterQuery?: string
        requestId?: number
      } = {}
    ): Promise<boolean> => {
      const isCurrentRefresh = () =>
        options.requestId === undefined || options.requestId === refreshRequestSeqRef.current
      if (!workspacePath) {
        if (!isCurrentRefresh()) return false
        setChildrenByDirectory({})
        setTruncatedDirectories({})
        setExpandedDirectories(new Set())
        setSearchFiles([])
        setSearchTruncated(false)
        setFilter('')
        setListMessage('')
        setGitSnapshot(null)
        setGitMessage('')
        return true
      }

      const expandedPaths = options.resetNavigation ? [] : (options.expandedPaths ?? [])
      const filterQuery = options.resetNavigation ? '' : (options.filterQuery?.trim() ?? '')

      setIsListLoading(true)
      setListMessage('')
      try {
        if (options.resetNavigation) {
          setExpandedDirectories(new Set())
          setFilter('')
        }
        const nextChildren: Record<string, WorkspaceFileEntry[]> = {}
        const nextTruncated: Record<string, boolean> = {}
        const root = await editorApi.listFiles(workspacePath, {
          path: ROOT_DIR_KEY,
          limit: FILE_EDITOR_DIRECTORY_LIMIT
        })
        if (!isCurrentRefresh()) return false
        nextChildren[ROOT_DIR_KEY] = root.entries
        nextTruncated[ROOT_DIR_KEY] = root.truncated
        for (const path of expandedPaths) {
          try {
            const result = await editorApi.listFiles(workspacePath, {
              path,
              limit: FILE_EDITOR_DIRECTORY_LIMIT
            })
            if (!isCurrentRefresh()) return false
            nextChildren[path] = result.entries
            nextTruncated[path] = result.truncated
          } catch {
            /* Directory may have been removed; keep the rest of the refresh. */
          }
        }
        setChildrenByDirectory(nextChildren)
        setTruncatedDirectories(nextTruncated)
        if (filterQuery) {
          const search = await editorApi.listFiles(workspacePath, {
            query: filterQuery,
            limit: FILE_EDITOR_SEARCH_LIMIT
          })
          if (!isCurrentRefresh()) return false
          setSearchFiles(search.entries)
          setSearchTruncated(search.truncated)
        } else {
          setSearchFiles([])
          setSearchTruncated(false)
        }
        await refreshGitSnapshot(options.requestId)
        return isCurrentRefresh()
      } catch (error) {
        if (!isCurrentRefresh()) return false
        setListMessage(error instanceof Error ? error.message : 'Could not load files')
        return false
      } finally {
        if (isCurrentRefresh()) setIsListLoading(false)
      }
    },
    [refreshGitSnapshot, workspacePath]
  )

  const refreshOpenBuffers = useCallback(async (requestId?: number): Promise<boolean> => {
    const isCurrentRefresh = () =>
      requestId === undefined || requestId === refreshRequestSeqRef.current
    if (!workspacePath || buffers.length === 0) return true
    let refreshed = true
    for (const buffer of buffers) {
      if (isBufferDirty(buffer)) continue
      try {
        const result = await editorApi.readFile(workspacePath, buffer.path)
        if (!isCurrentRefresh()) return false
        const nextBuffer = bufferFromReadResult(result)
        setBuffers((current) =>
          updateBuffer(current, result.path, (currentBuffer) =>
            isBufferDirty(currentBuffer) ? currentBuffer : nextBuffer
          )
        )
      } catch (error) {
        if (!isCurrentRefresh()) return false
        refreshed = false
        setStatus(
          `Could not refresh ${buffer.path}: ${
            error instanceof Error ? error.message : 'file unavailable'
          }`
        )
      }
    }
    return refreshed && isCurrentRefresh()
  }, [buffers, workspacePath])

  const refreshCurrentView = useCallback(async () => {
    if (!workspacePath) return
    const requestId = refreshRequestSeqRef.current + 1
    refreshRequestSeqRef.current = requestId
    setStatus('Refreshing editor')
    const filesRefreshed = await refreshFiles({
      expandedPaths: Array.from(expandedDirectories),
      filterQuery: trimmedFilter,
      requestId
    })
    if (!filesRefreshed || requestId !== refreshRequestSeqRef.current) return
    const buffersRefreshed = await refreshOpenBuffers(requestId)
    if (buffersRefreshed && requestId === refreshRequestSeqRef.current) {
      setStatus(dirtyBufferCount > 0 ? 'Editor refreshed; dirty tabs kept' : 'Editor refreshed')
    }
  }, [
    dirtyBufferCount,
    expandedDirectories,
    refreshFiles,
    refreshOpenBuffers,
    trimmedFilter,
    workspacePath
  ])

  useEffect(() => {
    let cancelled = false
    const resetSearch = () => {
      queueMicrotask(() => {
        if (cancelled) return
        setSearchFiles([])
        setSearchTruncated(false)
        setListMessage('')
        setIsListLoading(false)
      })
    }

    if (!workspacePath) {
      resetSearch()
      return () => {
        cancelled = true
      }
    }

    if (!trimmedFilter) {
      resetSearch()
      return () => {
        cancelled = true
      }
    }

    queueMicrotask(() => {
      if (cancelled) return
      setIsListLoading(true)
      setListMessage('')
    })

    const timer = window.setTimeout(() => {
      editorApi
        .listFiles(workspacePath, {
          query: trimmedFilter,
          limit: FILE_EDITOR_SEARCH_LIMIT
        })
        .then((result) => {
          if (cancelled) return
          setSearchFiles(result.entries)
          setSearchTruncated(result.truncated)
        })
        .catch((error) => {
          if (cancelled) return
          setSearchFiles([])
          setSearchTruncated(false)
          setListMessage(error instanceof Error ? error.message : 'Could not search files')
        })
        .finally(() => {
          if (!cancelled) setIsListLoading(false)
        })
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [trimmedFilter, workspacePath])

  useEffect(() => {
    let cancelled = false
    const resetQuickOpenSearch = () => {
      queueMicrotask(() => {
        if (cancelled) return
        setQuickOpenResults([])
        setQuickOpenTruncated(false)
        setQuickOpenMessage('')
        setIsQuickOpenLoading(false)
      })
    }

    if (!showQuickOpen || !workspacePath || !quickOpenTrimmedQuery) {
      resetQuickOpenSearch()
      return () => {
        cancelled = true
      }
    }

    queueMicrotask(() => {
      if (cancelled) return
      setIsQuickOpenLoading(true)
      setQuickOpenMessage('')
    })

    const timer = window.setTimeout(() => {
      editorApi
        .listFiles(workspacePath, {
          query: quickOpenTrimmedQuery,
          limit: FILE_EDITOR_SEARCH_LIMIT
        })
        .then((result) => {
          if (cancelled) return
          setQuickOpenResults(result.entries.filter((entry) => !entry.isDirectory))
          setQuickOpenTruncated(result.truncated)
        })
        .catch((error) => {
          if (cancelled) return
          setQuickOpenResults([])
          setQuickOpenTruncated(false)
          setQuickOpenMessage(error instanceof Error ? error.message : 'Could not search files')
        })
        .finally(() => {
          if (!cancelled) setIsQuickOpenLoading(false)
        })
    }, 120)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [quickOpenTrimmedQuery, showQuickOpen, workspacePath])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) setQuickOpenSelectedIndex(0)
    })
    return () => {
      cancelled = true
    }
  }, [displayedQuickOpenFiles.length, quickOpenTrimmedQuery])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      setSelectedPath('')
      setBuffers([])
      setCursorStatus(DEFAULT_CURSOR_STATUS)
      setPendingClosePath('')
      setStatus('')
      setGitSnapshot(null)
      setGitMessage('')
      setContextMenuSelection(null)
      void refreshFiles({ resetNavigation: true })
    })
    return () => {
      cancelled = true
    }
  }, [refreshFiles, workspacePath])

  useEffect(() => {
    if (refreshTick === lastRefreshTickRef.current) return
    lastRefreshTickRef.current = refreshTick
    if (!workspacePath) return
    queueMicrotask(() => {
      void refreshCurrentView()
    })
  }, [refreshCurrentView, refreshTick, workspacePath])

  const expandDirectoryPath = useCallback(
    async (dirPath: string) => {
      if (!workspacePath) return

      const parts = dirPath.split('/').filter(Boolean)
      const chain = parts.map((_, index) => parts.slice(0, index + 1).join('/'))
      setIsListLoading(true)
      setListMessage('')
      try {
        await loadDirectory(ROOT_DIR_KEY)
        for (const path of chain) {
          await loadDirectory(path)
        }
        setExpandedDirectories((current) => {
          const next = new Set(current)
          chain.forEach((path) => next.add(path))
          return next
        })
      } catch (error) {
        setListMessage(error instanceof Error ? error.message : `Could not open ${dirPath}`)
      } finally {
        setIsListLoading(false)
      }
    },
    [loadDirectory, workspacePath]
  )

  const toggleDirectory = async (entry: WorkspaceFileEntry) => {
    if (!workspacePath || !entry.isDirectory) return

    if (isFiltering) {
      setFilter('')
      await expandDirectoryPath(entry.path)
      return
    }

    if (expandedDirectories.has(entry.path)) {
      setExpandedDirectories((current) => {
        const next = new Set(current)
        next.delete(entry.path)
        return next
      })
      setListMessage('')
      return
    }

    setExpandedDirectories((current) => {
      const next = new Set(current)
      next.add(entry.path)
      return next
    })

    if (childrenByDirectory[entry.path]) {
      setListMessage('')
      return
    }

    setIsListLoading(true)
    setListMessage('')
    try {
      const result = await loadDirectory(entry.path)
      if (result.truncated) {
        setListMessage(
          `Showing first ${result.entries.length} items in ${entry.path}; filter to search workspace`
        )
      }
    } catch (error) {
      setExpandedDirectories((current) => {
        const next = new Set(current)
        next.delete(entry.path)
        return next
      })
      setListMessage(error instanceof Error ? error.message : `Could not open ${entry.path}`)
    } finally {
      setIsListLoading(false)
    }
  }

  const openFilePath = useCallback(
    async (filePath: string) => {
      if (!workspacePath || !filePath) return

      setFilter('')
      if (buffers.some((buffer) => buffer.path === filePath)) {
        setSelectedPath(filePath)
        setCursorStatus(DEFAULT_CURSOR_STATUS)
        setStatus(`${filePath} · already open`)
        const parentPath = parentDirectoryForPath(filePath)
        if (parentPath) void expandDirectoryPath(parentPath)
        void refreshGitSnapshot()
        return
      }

      setIsLoading(true)
      setStatus(`Opening ${filePath}`)
      try {
        const result = await editorApi.readFile(workspacePath, filePath)
        const nextBuffer = bufferFromReadResult(result)
        setBuffers((current) => upsertBuffer(current, nextBuffer))
        setSelectedPath(result.path)
        setCursorStatus(DEFAULT_CURSOR_STATUS)
        setStatus(`${result.path} · ${formatBytes(result.sizeBytes)}`)
        const parentPath = parentDirectoryForPath(result.path)
        if (parentPath) void expandDirectoryPath(parentPath)
        void refreshGitSnapshot()
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not open file')
      } finally {
        setIsLoading(false)
      }
    },
    [buffers, expandDirectoryPath, refreshGitSnapshot, workspacePath]
  )

  useEffect(() => {
    if (!openRequest || openRequest.nonce === lastOpenRequestRef.current) return
    lastOpenRequestRef.current = openRequest.nonce
    queueMicrotask(() => {
      void openFilePath(openRequest.path)
    })
  }, [openFilePath, openRequest])

  const openQuickOpen = useCallback(() => {
    if (!workspacePath) return
    setQuickOpenQuery('')
    setQuickOpenResults([])
    setQuickOpenTruncated(false)
    setQuickOpenMessage('')
    setQuickOpenSelectedIndex(0)
    setStatus('Quick open')
    setShowQuickOpen(true)
  }, [workspacePath])

  const openQuickOpenPath = useCallback(
    async (filePath: string) => {
      setShowQuickOpen(false)
      setQuickOpenQuery('')
      await openFilePath(filePath)
    },
    [openFilePath]
  )

  const revealFilePathInTree = useCallback(
    async (filePath: string) => {
      if (!workspacePath || !filePath) return
      setFilter('')
      const parentPath = parentDirectoryForPath(filePath)
      if (parentPath) {
        await expandDirectoryPath(parentPath)
      } else {
        await loadDirectory(ROOT_DIR_KEY)
      }
      setSelectedPath(filePath)
      setStatus(`${filePath} · revealed`)
    },
    [expandDirectoryPath, loadDirectory, workspacePath]
  )

  const revealSelectedFileInTree = async () => {
    if (!selectedPath) return
    await revealFilePathInTree(selectedPath)
  }

  const copyFilePath = useCallback((filePath: string) => {
    if (!filePath) return
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      setStatus('Clipboard unavailable')
      return
    }
    void navigator.clipboard
      .writeText(filePath)
      .then(() => setStatus(`Copied ${filePath}`))
      .catch(() => setStatus('Could not copy path'))
  }, [])

  const closeOtherCleanBuffers = (path: string) => {
    const selectedBuffer = buffers.find((buffer) => buffer.path === path)
    if (!selectedBuffer) return
    const nextBuffers = buffers.filter((buffer) => buffer.path === path || isBufferDirty(buffer))
    const closedCount = buffers.length - nextBuffers.length
    const keptDirtyCount = nextBuffers.filter(
      (buffer) => buffer.path !== path && isBufferDirty(buffer)
    ).length
    setBuffers(nextBuffers)
    setSelectedPath(path)
    setPendingClosePath('')
    setCursorStatus(DEFAULT_CURSOR_STATUS)
    if (closedCount === 0 && keptDirtyCount > 0) {
      setStatus(`Kept ${keptDirtyCount} dirty tab${keptDirtyCount === 1 ? '' : 's'} open`)
      return
    }
    if (keptDirtyCount > 0) {
      setStatus(
        `Closed ${closedCount} clean tab${closedCount === 1 ? '' : 's'}; kept ${keptDirtyCount} dirty`
      )
      return
    }
    setStatus(`Closed ${closedCount} other tab${closedCount === 1 ? '' : 's'}`)
  }

  const openFile = async (entry: WorkspaceFileEntry) => {
    if (!workspacePath) return
    if (entry.isDirectory) {
      await toggleDirectory(entry)
      return
    }
    await openFilePath(entry.path)
  }

  const saveBuffer = async (path: string): Promise<boolean> => {
    if (!workspacePath || !path) return false
    const buffer = buffers.find((item) => item.path === path)
    if (!buffer || !isBufferDirty(buffer)) return true

    setIsLoading(true)
    setStatus(`Saving ${path}`)
    const savedContentSnapshot = buffer.content
    const savedEtagSnapshot = buffer.savedEtag
    try {
      const result = await editorApi.writeFile(
        workspacePath,
        path,
        savedContentSnapshot,
        savedEtagSnapshot
      )
      const nextBuffer = bufferFromReadResult(result)
      setBuffers((current) =>
        updateBuffer(current, result.path, (currentBuffer) =>
          mergeSavedBufferResult(currentBuffer, nextBuffer, savedContentSnapshot, savedEtagSnapshot)
        )
      )
      setStatus(`Saved ${result.path} · ${formatBytes(result.sizeBytes)}`)
      void loadDirectory(parentDirectoryForPath(result.path))
      void refreshGitSnapshot()
      return true
    } catch (error) {
      setSelectedPath(path)
      setStatus(error instanceof Error ? error.message : 'Could not save file')
      return false
    } finally {
      setIsLoading(false)
    }
  }

  const saveFile = async () => {
    if (!selectedPath) return
    await saveBuffer(selectedPath)
  }

  const saveAllFiles = async () => {
    if (!workspacePath || dirtyBufferCount === 0) return
    setIsLoading(true)
    let failedPath = ''
    try {
      const dirtyBuffers = buffers.filter(isBufferDirty)
      let savedCount = 0
      for (const buffer of dirtyBuffers) {
        failedPath = buffer.path
        setStatus(`Saving ${buffer.path}`)
        const savedContentSnapshot = buffer.content
        const savedEtagSnapshot = buffer.savedEtag
        const result = await editorApi.writeFile(
          workspacePath,
          buffer.path,
          savedContentSnapshot,
          savedEtagSnapshot
        )
        const nextBuffer = bufferFromReadResult(result)
        setBuffers((current) =>
          updateBuffer(current, result.path, (currentBuffer) =>
            mergeSavedBufferResult(
              currentBuffer,
              nextBuffer,
              savedContentSnapshot,
              savedEtagSnapshot
            )
          )
        )
        void loadDirectory(parentDirectoryForPath(result.path))
        savedCount += 1
      }
      setStatus(`Saved ${savedCount} open file${savedCount === 1 ? '' : 's'}`)
      void refreshGitSnapshot()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save all files')
      if (failedPath) setSelectedPath(failedPath)
    } finally {
      setIsLoading(false)
    }
  }

  const reloadBufferFromDisk = useCallback(
    async (path: string): Promise<boolean> => {
      if (!workspacePath || !path) return false

      setIsLoading(true)
      setStatus(`Reloading ${path}`)
      try {
        const result = await editorApi.readFile(workspacePath, path)
        const nextBuffer = bufferFromReadResult(result)
        setBuffers((current) => upsertBuffer(current, nextBuffer))
        setSelectedPath(result.path)
        setCursorStatus(DEFAULT_CURSOR_STATUS)
        setPendingClosePath('')
        setPendingDirtyAction(null)
        setStatus(`Reloaded ${result.path} from disk`)
        void loadDirectory(parentDirectoryForPath(result.path))
        void refreshGitSnapshot()
        return true
      } catch (error) {
        setSelectedPath(path)
        setStatus(error instanceof Error ? error.message : 'Could not reload file')
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [loadDirectory, refreshGitSnapshot, workspacePath]
  )

  const requestReloadBufferFromDisk = useCallback(
    (path: string) => {
      const buffer = buffers.find((item) => item.path === path)
      if (isBufferDirty(buffer)) {
        setSelectedPath(path)
        setPendingDirtyAction({ kind: 'reload', path })
        setStatus(`Confirm reload for ${path}`)
        return
      }
      void reloadBufferFromDisk(path)
    },
    [buffers, reloadBufferFromDisk]
  )

  const applyDiscardBufferChanges = useCallback(
    (path: string) => {
      const buffer = buffers.find((item) => item.path === path)
      if (!buffer) return
      if (!isBufferDirty(buffer)) {
        setSelectedPath(path)
        setStatus(`${path} has no local changes`)
        return
      }
      setBuffers((current) =>
        updateBuffer(current, path, (currentBuffer) => ({
          ...currentBuffer,
          content: currentBuffer.savedContent
        }))
      )
      setSelectedPath(path)
      setCursorStatus(DEFAULT_CURSOR_STATUS)
      setPendingClosePath('')
      setPendingDirtyAction(null)
      setStatus(`Discarded local changes in ${path}`)
    },
    [buffers]
  )

  const requestDiscardBufferChanges = useCallback(
    (path: string) => {
      const buffer = buffers.find((item) => item.path === path)
      if (isBufferDirty(buffer)) {
        setSelectedPath(path)
        setPendingDirtyAction({ kind: 'discard', path })
        setStatus(`Confirm discard for ${path}`)
        return
      }
      applyDiscardBufferChanges(path)
    },
    [applyDiscardBufferChanges, buffers]
  )

  const confirmPendingDirtyAction = useCallback(() => {
    if (!pendingDirtyAction) return
    const action = pendingDirtyAction
    setPendingDirtyAction(null)
    if (action.kind === 'reload') {
      void reloadBufferFromDisk(action.path)
      return
    }
    applyDiscardBufferChanges(action.path)
  }, [applyDiscardBufferChanges, pendingDirtyAction, reloadBufferFromDisk])

  const closeEditorBuffer = (path: string) => {
    const result = closeBuffer(buffers, path)
    const nextSelectedPath = path === selectedPath ? result.nextSelectedPath : selectedPath
    setBuffers(result.buffers)
    setSelectedPath(nextSelectedPath)
    if (path === selectedPath) setCursorStatus(DEFAULT_CURSOR_STATUS)
    setPendingClosePath('')
    setPendingDirtyAction(null)
    if (path === selectedPath) {
      setStatus(nextSelectedPath ? `${nextSelectedPath} · selected` : 'No file selected')
    }
  }

  const requestCloseBuffer = (path: string) => {
    const buffer = buffers.find((item) => item.path === path)
    if (isBufferDirty(buffer)) {
      setPendingClosePath(path)
      setStatus(`Unsaved changes in ${path}`)
      return
    }
    closeEditorBuffer(path)
  }

  const contextMenuItems: FileEditorContextMenuItem[] = (() => {
    if (!contextMenuSelection) return []
    if (contextMenuSelection.kind === 'tree') {
      const { entry } = contextMenuSelection
      const isExpanded = entry.isDirectory && expandedDirectories.has(entry.path)
      const openLabel = entry.isDirectory
        ? isExpanded
          ? 'Collapse Folder'
          : 'Open Folder'
        : 'Open File'
      return [
        {
          id: 'open',
          label: openLabel,
          onSelect: () => void openFile(entry)
        },
        ...(entry.isDirectory
          ? []
          : [
              {
                id: 'reveal',
                label: 'Reveal in Tree',
                onSelect: () => void revealFilePathInTree(entry.path)
              }
            ]),
        {
          id: 'copy-path',
          label: 'Copy Relative Path',
          onSelect: () => copyFilePath(entry.path)
        }
      ]
    }

    const buffer = buffers.find((item) => item.path === contextMenuSelection.path)
    const tabDirty = isBufferDirty(buffer)
    return [
      {
        id: 'reveal',
        label: 'Reveal in Tree',
        onSelect: () => void revealFilePathInTree(contextMenuSelection.path)
      },
      {
        id: 'save',
        label: 'Save',
        shortcut: 'Cmd S',
        disabled: !tabDirty,
        onSelect: () => void saveBuffer(contextMenuSelection.path)
      },
      {
        id: 'reload',
        label: 'Reload From Disk',
        disabled: !buffer || isLoading,
        onSelect: () => requestReloadBufferFromDisk(contextMenuSelection.path)
      },
      {
        id: 'discard',
        label: 'Discard Changes',
        disabled: !tabDirty,
        danger: true,
        onSelect: () => requestDiscardBufferChanges(contextMenuSelection.path)
      },
      {
        id: 'close',
        label: 'Close',
        onSelect: () => requestCloseBuffer(contextMenuSelection.path)
      },
      {
        id: 'close-others',
        label: 'Close Clean Others',
        disabled: buffers.length <= 1,
        onSelect: () => closeOtherCleanBuffers(contextMenuSelection.path)
      },
      {
        id: 'copy-path',
        label: 'Copy Relative Path',
        onSelect: () => copyFilePath(contextMenuSelection.path)
      }
    ]
  })()

  const saveAndClosePendingBuffer = async () => {
    const path = pendingClosePath
    if (!path) return
    const saved = await saveBuffer(path)
    if (saved) closeEditorBuffer(path)
  }

  const deleteSelectedFile = async () => {
    if (!workspacePath || !selectedPath || isDirty) return
    if (!activeBuffer?.savedEtag) {
      setStatus('Reload file before deleting.')
      setShowDeleteConfirm(false)
      return
    }

    setIsLoading(true)
    setShowDeleteConfirm(false)
    setStatus(`Deleting ${selectedPath}`)
    try {
      const deletedPath = selectedPath
      const result = await editorApi.deleteFile(workspacePath, selectedPath, activeBuffer.savedEtag)
      const closed = closeBuffer(buffers, deletedPath)
      setBuffers(closed.buffers)
      setSelectedPath(closed.nextSelectedPath)
      setCursorStatus(DEFAULT_CURSOR_STATUS)
      setStatus(`Deleted ${result.path}`)
      await loadDirectory(parentDirectoryForPath(deletedPath))
      if (isFiltering) {
        const search = await editorApi.listFiles(workspacePath, {
          query: trimmedFilter,
          limit: FILE_EDITOR_SEARCH_LIMIT
        })
        setSearchFiles(search.entries)
        setSearchTruncated(search.truncated)
      }
      void refreshGitSnapshot()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not delete file')
    } finally {
      setIsLoading(false)
    }
  }

  const stageSelectedFile = async () => {
    if (!workspacePath || !selectedPath || isDirty || !selectedHasUnstagedChanges) return

    setIsLoading(true)
    setStatus(`Staging ${selectedPath}`)
    try {
      const result = await editorApi.gitStageFile(workspacePath, selectedPath)
      if (result.ok) {
        setGitSnapshot(result.data)
        setGitMessage('')
        setStatus(`Staged ${selectedPath}`)
      } else {
        setGitMessage(result.error)
        setStatus(result.error)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not stage file'
      setGitMessage(message)
      setStatus(message)
    } finally {
      setIsLoading(false)
    }
  }

  const unstageSelectedFile = async () => {
    if (!workspacePath || !selectedPath || !selectedHasStagedChanges) return

    setIsLoading(true)
    setStatus(`Unstaging ${selectedPath}`)
    try {
      const result = await editorApi.gitUnstageFile(workspacePath, selectedPath)
      if (result.ok) {
        setGitSnapshot(result.data)
        setGitMessage('')
        setStatus(`Unstaged ${selectedPath}`)
      } else {
        setGitMessage(result.error)
        setStatus(result.error)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not unstage file'
      setGitMessage(message)
      setStatus(message)
    } finally {
      setIsLoading(false)
    }
  }

  const commitStagedChanges = async () => {
    const message = commitMessage.trim()
    if (!workspacePath || !message || stagedCount === 0) return
    if (outOfScopeStagedCount > 0) {
      const nextMessage = `${outOfScopeStagedCount} staged ${
        outOfScopeStagedCount === 1 ? 'file is' : 'files are'
      } outside this workspace. Unstage or commit them elsewhere first.`
      setGitMessage(nextMessage)
      setStatus(nextMessage)
      return
    }

    setIsLoading(true)
    setStatus('Committing staged changes')
    try {
      const result = await editorApi.gitCommit(workspacePath, message)
      if (result.ok) {
        setGitSnapshot(result.data)
        setGitMessage('')
        setCommitMessage('')
        setShowCommitDialog(false)
        setStatus('Committed staged changes')
      } else {
        setGitMessage(result.error)
        setStatus(result.error)
      }
    } catch (error) {
      const nextMessage = error instanceof Error ? error.message : 'Could not commit staged changes'
      setGitMessage(nextMessage)
      setStatus(nextMessage)
    } finally {
      setIsLoading(false)
    }
  }

  commandHandlersRef.current = {
    'quick-open': openQuickOpen,
    'save-current': () => void saveFile(),
    'save-all': () => void saveAllFiles(),
    'reveal-selected': () => void revealSelectedFileInTree(),
    'toggle-wrap': () => {
      setLineWrapEnabled((enabled) => !enabled)
      setStatus(lineWrapEnabled ? 'Line wrap disabled' : 'Line wrap enabled')
    }
  }

  useEffect(() => {
    if (!commandRequest || commandRequest.nonce === lastCommandRequestRef.current) return
    lastCommandRequestRef.current = commandRequest.nonce
    queueMicrotask(() => {
      commandHandlersRef.current[commandRequest.kind]?.()
    })
  }, [commandRequest])

  const pendingDirtyActionCopy = pendingDirtyAction
    ? fileEditorDirtyActionCopy(pendingDirtyAction.kind, pendingDirtyAction.path)
    : null

  return (
    <aside className="app-file-editor" style={width ? { width } : undefined}>
      <WorkspaceFileTree
        workspacePath={workspacePath}
        filter={filter}
        fileListStatus={fileListStatus}
        displayedFiles={displayedFiles}
        expandedDirectories={expandedDirectories}
        selectedPath={selectedPath}
        isFiltering={isFiltering}
        isLoading={isLoading}
        isListLoading={isListLoading}
        onFilterChange={setFilter}
        onRefresh={refreshCurrentView}
        onOpenEntry={openFile}
        onContextMenuEntry={(entry, anchor) => {
          setContextMenuSelection({ kind: 'tree', entry, anchor })
        }}
      />

      <section
        className="file-editor-code"
        onKeyDown={(event) => {
          if (
            !showQuickOpen &&
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === 'p'
          ) {
            event.preventDefault()
            openQuickOpen()
            return
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            void saveFile()
          }
        }}
      >
        <div className="file-editor-header">
          <strong className="file-editor-title">
            {selectedPath ? (
              <>
                <FileTypeIcon
                  path={selectedPath}
                  size={14}
                  className="file-editor-file-icon"
                  workspacePath={workspacePath}
                />
                <span>{selectedName}</span>
                {isDirty && <span className="file-editor-dirty-dot" title="Unsaved changes" />}
              </>
            ) : (
              'Editor'
            )}
          </strong>
          <FileEditorGitActions
            workspacePath={workspacePath}
            selectedPath={selectedPath}
            isDirty={isDirty}
            isLoading={isLoading}
            selectedHasUnstagedChanges={selectedHasUnstagedChanges}
            selectedHasStagedChanges={selectedHasStagedChanges}
            stagedCount={stagedCount}
            outOfScopeStagedCount={outOfScopeStagedCount}
            dirtyBufferCount={dirtyBufferCount}
            lineWrapEnabled={lineWrapEnabled}
            onDeleteRequest={() => setShowDeleteConfirm(true)}
            onStage={stageSelectedFile}
            onUnstage={unstageSelectedFile}
            onCommitRequest={() => setShowCommitDialog(true)}
            onSaveAll={saveAllFiles}
            onSave={saveFile}
            onReloadSelected={() => {
              if (selectedPath) requestReloadBufferFromDisk(selectedPath)
            }}
            onToggleLineWrap={() => setLineWrapEnabled((enabled) => !enabled)}
            onOpenQuickOpen={openQuickOpen}
            onRevealInTree={revealSelectedFileInTree}
          />
        </div>
        <EditorTabStrip
          buffers={buffers}
          selectedPath={selectedPath}
          workspacePath={workspacePath}
          onSelect={(path) => {
            setSelectedPath(path)
            setCursorStatus(DEFAULT_CURSOR_STATUS)
          }}
          onClose={requestCloseBuffer}
          onContextMenuTab={(path, anchor) => {
            setSelectedPath(path)
            setContextMenuSelection({ kind: 'tab', path, anchor })
          }}
        />
        <FileEditorContextMenu
          selection={contextMenuSelection}
          items={contextMenuItems}
          onClose={() => setContextMenuSelection(null)}
        />
        {showDeleteConfirm && selectedPath && (
          <div className="file-editor-modal-backdrop">
            <div
              className="file-editor-confirm-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="file-editor-delete-title"
              aria-describedby="file-editor-delete-body"
              onKeyDown={(event) =>
                dismissFileEditorPromptOnEscape(event, () => setShowDeleteConfirm(false))
              }
            >
              <strong id="file-editor-delete-title">Delete file?</strong>
              <span id="file-editor-delete-body">
                {selectedPath} will be removed from this workspace.
              </span>
              <div className="file-editor-unsaved-actions">
                <button
                  className="btn btn-sm btn-danger"
                  type="button"
                  onClick={() => void deleteSelectedFile()}
                >
                  Delete
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  autoFocus
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        {showCommitDialog && (
          <div className="file-editor-modal-backdrop">
            <div
              className="file-editor-confirm-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="file-editor-commit-title"
              aria-describedby="file-editor-commit-body"
              onKeyDown={(event) =>
                dismissFileEditorPromptOnEscape(event, () => setShowCommitDialog(false))
              }
            >
              <strong id="file-editor-commit-title">Commit staged changes</strong>
              {outOfScopeStagedCount > 0 ? (
                <span id="file-editor-commit-body">
                  {outOfScopeStagedCount} staged{' '}
                  {outOfScopeStagedCount === 1 ? 'file is' : 'files are'} outside this workspace.
                  Unstage or commit {outOfScopeStagedCount === 1 ? 'it' : 'them'} elsewhere first.
                </span>
              ) : (
                <span id="file-editor-commit-body">
                  {stagedCount} staged file{stagedCount === 1 ? '' : 's'} will be committed.
                </span>
              )}
              <input
                className="file-editor-commit-input"
                aria-label="Commit message"
                aria-describedby="file-editor-commit-body"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                autoFocus
              />
              <div className="file-editor-unsaved-actions">
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => void commitStagedChanges()}
                  disabled={
                    !commitMessage.trim() ||
                    isLoading ||
                    stagedCount === 0 ||
                    outOfScopeStagedCount > 0
                  }
                >
                  Commit
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  type="button"
                  onClick={() => setShowCommitDialog(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        {showQuickOpen && (
          <QuickOpenPalette
            workspacePath={workspacePath}
            query={quickOpenQuery}
            results={displayedQuickOpenFiles}
            status={quickOpenStatus}
            isLoading={isQuickOpenLoading}
            selectedIndex={quickOpenSelectedIndex}
            onQueryChange={setQuickOpenQuery}
            onSelectedIndexChange={setQuickOpenSelectedIndex}
            onOpenPath={openQuickOpenPath}
            onClose={() => setShowQuickOpen(false)}
          />
        )}
        {pendingClosePath && (
          <div
            className="file-editor-unsaved-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="file-editor-unsaved-title"
            aria-describedby="file-editor-unsaved-body"
            onKeyDown={(event) =>
              dismissFileEditorPromptOnEscape(event, () => setPendingClosePath(''))
            }
          >
            <strong id="file-editor-unsaved-title">Unsaved changes</strong>
            <span id="file-editor-unsaved-body">
              Save or discard changes before closing {pendingClosePath}.
            </span>
            <div className="file-editor-unsaved-actions">
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => void saveAndClosePendingBuffer()}
              >
                Save
              </button>
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => closeEditorBuffer(pendingClosePath)}
              >
                Discard
              </button>
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => setPendingClosePath('')}
                autoFocus
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {pendingDirtyAction && pendingDirtyActionCopy && (
          <div
            className="file-editor-unsaved-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="file-editor-dirty-action-title"
            aria-describedby="file-editor-dirty-action-body"
            onKeyDown={(event) =>
              dismissFileEditorPromptOnEscape(event, () => setPendingDirtyAction(null))
            }
          >
            <strong id="file-editor-dirty-action-title">{pendingDirtyActionCopy.title}</strong>
            <span id="file-editor-dirty-action-body">{pendingDirtyActionCopy.body}</span>
            <div className="file-editor-unsaved-actions">
              <button
                className={`btn btn-sm${pendingDirtyActionCopy.danger ? ' btn-danger' : ''}`}
                type="button"
                onClick={confirmPendingDirtyAction}
              >
                {pendingDirtyActionCopy.confirmLabel}
              </button>
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => setPendingDirtyAction(null)}
                autoFocus
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <EditorPane
          selectedPath={selectedPath}
          content={content}
          isLoading={isLoading}
          editorExtensions={editorExtensions}
          onContentChange={(value) => {
            const path = selectedPath
            if (!path) return
            setBuffers((current) =>
              updateBuffer(current, path, (buffer) => ({ ...buffer, content: value }))
            )
          }}
        />
        <FileEditorStatusBar
          activeBuffer={activeBuffer}
          isDirty={isDirty}
          status={status}
          gitMessage={gitMessage}
          cursorStatus={cursorStatus}
          selectedGitFile={selectedGitFile}
          selectedHasStagedChanges={selectedHasStagedChanges}
          selectedHasUnstagedChanges={selectedHasUnstagedChanges}
          lineWrapEnabled={lineWrapEnabled}
        />
      </section>
    </aside>
  )
}

function FileEditorContextMenu({
  selection,
  items,
  onClose
}: FileEditorContextMenuProps) {
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

  useEffect(() => {
    if (!selection) return
    const frame = window.requestAnimationFrame(() => {
      if (!menuRef.current) return
      focusFileEditorContextMenuButton(menuRef.current, 'first')
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selection, items.length])

  if (!selection || items.length === 0) return null

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 768
  const heightEstimate = 18 + items.length * 34
  const left = Math.max(8, Math.min(selection.anchor.x, viewportWidth - 224))
  const top = Math.max(8, Math.min(selection.anchor.y, viewportHeight - heightEstimate))
  const targetLabel = selection.kind === 'tree' ? selection.entry.path : selection.path

  const menu = (
    <div
      ref={menuRef}
      className="file-editor-context-menu"
      style={{ position: 'fixed', left: `${left}px`, top: `${top}px` }}
      role="menu"
      aria-label={`Actions for ${targetLabel}`}
      onKeyDown={(event) => {
        if (!menuRef.current) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          focusFileEditorContextMenuButton(menuRef.current, 'next')
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          focusFileEditorContextMenuButton(menuRef.current, 'previous')
        } else if (event.key === 'Home') {
          event.preventDefault()
          focusFileEditorContextMenuButton(menuRef.current, 'first')
        } else if (event.key === 'End') {
          event.preventDefault()
          focusFileEditorContextMenuButton(menuRef.current, 'last')
        }
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className={`file-editor-context-menu-item${item.danger ? ' is-danger' : ''}`}
          disabled={item.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (item.disabled) return
            item.onSelect()
            onClose()
          }}
        >
          <span className="file-editor-context-menu-label">{item.label}</span>
          {item.shortcut && (
            <span className="file-editor-context-menu-shortcut">{item.shortcut}</span>
          )}
        </button>
      ))}
    </div>
  )

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}

function QuickOpenPalette({
  workspacePath,
  query,
  results,
  status,
  isLoading,
  selectedIndex,
  onQueryChange,
  onSelectedIndexChange,
  onOpenPath,
  onClose
}: QuickOpenPaletteProps) {
  const clampedIndex = results.length === 0 ? 0 : Math.min(selectedIndex, results.length - 1)
  const selectedEntry = results[clampedIndex]

  const moveSelection = (delta: number) => {
    if (results.length === 0) return
    onSelectedIndexChange((clampedIndex + delta + results.length) % results.length)
  }

  return (
    <div className="file-editor-modal-backdrop">
      <div
        className="file-editor-quick-open-card"
        role="dialog"
        aria-modal="true"
        aria-label="Quick open file"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            moveSelection(1)
            return
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            moveSelection(-1)
            return
          }
          if (event.key === 'Enter' && selectedEntry) {
            event.preventDefault()
            void onOpenPath(selectedEntry.path)
          }
        }}
      >
        <input
          className="file-editor-quick-open-input"
          aria-label="Quick open file path"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search files"
          disabled={!workspacePath}
          autoFocus
        />
        <div className="file-editor-quick-open-status" role="status" aria-live="polite">
          {status}
        </div>
        <div className="file-editor-quick-open-list">
          {results.length > 0 ? (
            results.map((entry, index) => {
              const isSelected = index === clampedIndex
              return (
                <button
                  key={entry.path}
                  className={`file-editor-quick-open-row ${isSelected ? 'active' : ''}`}
                  type="button"
                  onMouseEnter={() => onSelectedIndexChange(index)}
                  onClick={() => void onOpenPath(entry.path)}
                  aria-pressed={isSelected}
                  title={entry.path}
                >
                  <FileTypeIcon
                    path={entry.path}
                    size={14}
                    className="file-editor-file-icon"
                    workspacePath={workspacePath}
                  />
                  <span>{entry.path}</span>
                  <small>{formatBytes(entry.sizeBytes)}</small>
                </button>
              )
            })
          ) : (
            <div className="file-editor-quick-open-empty">
              {isLoading ? 'Searching...' : 'No matching files'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
