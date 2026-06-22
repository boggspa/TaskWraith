import { useCallback, useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { keymap, EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap, historyKeymap } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
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
import { FileTypeIcon } from './FileTypeIcon'

interface FileEditorPanelProps {
  workspacePath?: string
  width?: number
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

const ROOT_DIR_KEY = ''
const FILE_EDITOR_DIRECTORY_LIMIT = 500
const FILE_EDITOR_SEARCH_LIMIT = 500

const formatBytes = (value?: number): string => {
  if (!value) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const parentDirectoryForPath = (filePath: string): string => {
  const parts = filePath.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

const normalizeAbsolutePath = (path: string): string => {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
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
    filePath: string
  ): Promise<{ path: string }> => {
    return window.api.deleteWorkspaceFile(workspacePath, filePath)
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

export function FileEditorPanel({ workspacePath, width }: FileEditorPanelProps) {
  const [childrenByDirectory, setChildrenByDirectory] = useState<
    Record<string, WorkspaceFileEntry[]>
  >({})
  const [truncatedDirectories, setTruncatedDirectories] = useState<Record<string, boolean>>({})
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set())
  const [searchFiles, setSearchFiles] = useState<WorkspaceFileEntry[]>([])
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [content, setContent] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const [savedEtag, setSavedEtag] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [listMessage, setListMessage] = useState('')
  const [gitSnapshot, setGitSnapshot] = useState<GitRepositorySnapshot | null>(null)
  const [gitMessage, setGitMessage] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isListLoading, setIsListLoading] = useState(false)
  const [pendingOpenEntry, setPendingOpenEntry] = useState<WorkspaceFileEntry | null>(null)
  const isDirty = content !== savedContent
  const selectedName = selectedPath.split('/').filter(Boolean).pop() || selectedPath
  const trimmedFilter = filter.trim()
  const isFiltering = trimmedFilter.length > 0

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

  const selectedRepoPath = useMemo(() => {
    if (!selectedPath) return ''
    const repoRoot = gitSnapshot?.repoRoot
    if (!repoRoot || !workspacePath) return selectedPath
    const normalizedRepo = normalizeAbsolutePath(repoRoot)
    const normalizedWorkspace = normalizeAbsolutePath(workspacePath)
    if (normalizedWorkspace === normalizedRepo) return selectedPath
    if (normalizedWorkspace.startsWith(`${normalizedRepo}/`)) {
      return `${normalizedWorkspace.slice(normalizedRepo.length + 1)}/${selectedPath}`
    }
    return selectedPath
  }, [gitSnapshot?.repoRoot, selectedPath, workspacePath])

  const selectedGitFile = useMemo<GitFileStatus | undefined>(() => {
    if (!selectedRepoPath) return undefined
    return gitSnapshot?.files.find((file) => file.path === selectedRepoPath)
  }, [gitSnapshot?.files, selectedRepoPath])

  const stagedCount = gitSnapshot?.counts.staged ?? 0
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

  const editorExtensions = useMemo<Extension[]>(
    () => [
      codeEditorTheme,
      syntaxHighlighting(codeHighlightStyle),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      ...extensionForPath(selectedPath)
    ],
    [selectedPath]
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

  const refreshGitSnapshot = useCallback(async () => {
    if (!workspacePath) {
      setGitSnapshot(null)
      setGitMessage('')
      return
    }
    try {
      const result = await editorApi.gitSnapshot(workspacePath)
      if (result.ok) {
        setGitSnapshot(result.data)
        setGitMessage('')
      } else {
        setGitSnapshot(null)
        setGitMessage(result.error)
      }
    } catch (error) {
      setGitSnapshot(null)
      setGitMessage(error instanceof Error ? error.message : 'Could not read git status')
    }
  }, [workspacePath])

  const refreshFiles = useCallback(async () => {
    if (!workspacePath) {
      setChildrenByDirectory({})
      setTruncatedDirectories({})
      setExpandedDirectories(new Set())
      setSearchFiles([])
      setSearchTruncated(false)
      setFilter('')
      setListMessage('')
      setGitSnapshot(null)
      setGitMessage('')
      return
    }

    setIsListLoading(true)
    setListMessage('')
    try {
      setChildrenByDirectory({})
      setTruncatedDirectories({})
      setExpandedDirectories(new Set())
      setSearchFiles([])
      setSearchTruncated(false)
      setFilter('')
      await loadDirectory(ROOT_DIR_KEY)
      void refreshGitSnapshot()
    } catch (error) {
      setListMessage(error instanceof Error ? error.message : 'Could not load files')
    } finally {
      setIsListLoading(false)
    }
  }, [loadDirectory, refreshGitSnapshot, workspacePath])

  useEffect(() => {
    if (!workspacePath) {
      setSearchFiles([])
      setSearchTruncated(false)
      setListMessage('')
      setIsListLoading(false)
      return
    }

    if (!trimmedFilter) {
      setSearchFiles([])
      setSearchTruncated(false)
      setListMessage('')
      setIsListLoading(false)
      return
    }

    let cancelled = false
    setIsListLoading(true)
    setListMessage('')

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
    queueMicrotask(() => {
      if (cancelled) return
      setSelectedPath('')
      setContent('')
      setSavedContent('')
      setSavedEtag(null)
      setPendingOpenEntry(null)
      setStatus('')
      setGitSnapshot(null)
      setGitMessage('')
      void refreshFiles()
    })
    return () => {
      cancelled = true
    }
  }, [refreshFiles])

  const expandDirectoryPath = async (dirPath: string) => {
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
  }

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

  const openFile = async (entry: WorkspaceFileEntry) => {
    if (!workspacePath) return
    if (entry.isDirectory) {
      await toggleDirectory(entry)
      return
    }
    if (isDirty) {
      setPendingOpenEntry(entry)
      setStatus(`Unsaved changes in ${selectedPath}`)
      return
    }

    setIsLoading(true)
    setStatus(`Opening ${entry.path}`)
    try {
      const result = await editorApi.readFile(workspacePath, entry.path)
      setSelectedPath(result.path)
      setContent(result.content)
      setSavedContent(result.content)
      setSavedEtag(result.etag ?? null)
      setStatus(`${result.path} · ${formatBytes(result.sizeBytes)}`)
      void refreshGitSnapshot()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not open file')
    } finally {
      setIsLoading(false)
    }
  }

  const saveFile = async () => {
    if (!workspacePath || !selectedPath || !isDirty) return

    setIsLoading(true)
    setStatus(`Saving ${selectedPath}`)
    try {
      const nextPendingEntry = pendingOpenEntry
      const result = await editorApi.writeFile(workspacePath, selectedPath, content, savedEtag)
      setContent(result.content)
      setSavedContent(result.content)
      setSavedEtag(result.etag ?? savedEtag)
      setPendingOpenEntry(null)
      if (nextPendingEntry) {
        setStatus(`Opening ${nextPendingEntry.path}`)
        const nextResult = await editorApi.readFile(workspacePath, nextPendingEntry.path)
        setSelectedPath(nextResult.path)
        setContent(nextResult.content)
        setSavedContent(nextResult.content)
        setSavedEtag(nextResult.etag ?? null)
        setStatus(`${nextResult.path} · ${formatBytes(nextResult.sizeBytes)}`)
      } else {
        setStatus(`Saved ${result.path} · ${formatBytes(result.sizeBytes)}`)
      }
      void loadDirectory(parentDirectoryForPath(result.path))
      void refreshGitSnapshot()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not save or open file')
    } finally {
      setIsLoading(false)
    }
  }

  const discardChangesAndOpenPending = async () => {
    const nextEntry = pendingOpenEntry
    setPendingOpenEntry(null)
    setContent(savedContent)
    if (!workspacePath || !nextEntry) {
      return
    }

    setIsLoading(true)
    setStatus(`Opening ${nextEntry.path}`)
    try {
      const result = await editorApi.readFile(workspacePath, nextEntry.path)
      setSelectedPath(result.path)
      setContent(result.content)
      setSavedContent(result.content)
      setSavedEtag(result.etag ?? null)
      setStatus(`${result.path} · ${formatBytes(result.sizeBytes)}`)
      void refreshGitSnapshot()
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not open file')
    } finally {
      setIsLoading(false)
    }
  }

  const cancelPendingOpen = () => {
    setPendingOpenEntry(null)
    setStatus(selectedPath ? `${selectedPath} · unsaved changes` : status)
  }

  const deleteSelectedFile = async () => {
    if (!workspacePath || !selectedPath || isDirty) return

    setIsLoading(true)
    setShowDeleteConfirm(false)
    setStatus(`Deleting ${selectedPath}`)
    try {
      const deletedPath = selectedPath
      const result = await editorApi.deleteFile(workspacePath, selectedPath)
      setSelectedPath('')
      setContent('')
      setSavedContent('')
      setSavedEtag(null)
      setPendingOpenEntry(null)
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

  return (
    <aside className="app-file-editor" style={width ? { width } : undefined}>
      <section className="file-editor-files">
        <div className="file-editor-header">
          <strong>Files</strong>
          <button
            className="btn btn-sm btn-ghost"
            type="button"
            onClick={refreshFiles}
            disabled={!workspacePath || isListLoading}
          >
            Refresh
          </button>
        </div>
        <input
          className="file-editor-filter"
          aria-label="Filter workspace files"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter files"
          disabled={!workspacePath}
        />
        <div className="file-editor-list-status" role="status" aria-live="polite">
          {fileListStatus}
        </div>
        <div className="file-editor-list">
          {displayedFiles.length > 0 ? (
            displayedFiles.map((entry) => {
              const isExpanded = entry.isDirectory && expandedDirectories.has(entry.path)
              return (
                <button
                  key={`${entry.isDirectory ? 'dir' : 'file'}-${entry.path}`}
                  className={`file-editor-row ${entry.isDirectory ? 'directory' : 'file'} ${selectedPath === entry.path ? 'active' : ''} ${isExpanded ? 'expanded' : ''}`}
                  style={{ paddingLeft: `calc(var(--space-sm) + ${entry.depth * 12}px)` }}
                  type="button"
                  onClick={() => void openFile(entry)}
                  disabled={isLoading}
                  title={entry.path}
                >
                  <span className="file-editor-disclosure" aria-hidden="true">
                    {entry.isDirectory && entry.hasChildren ? (isExpanded ? '▾' : '▸') : ''}
                  </span>
                  <FileTypeIcon
                    path={entry.path}
                    size={14}
                    className="file-editor-file-icon"
                    workspacePath={workspacePath}
                  />
                  <span className="file-editor-file-name">{isFiltering ? entry.path : entry.name}</span>
                  {!entry.isDirectory && (
                    <span className="file-editor-file-size">{formatBytes(entry.sizeBytes)}</span>
                  )}
                </button>
              )
            })
          ) : (
            <div className="file-editor-empty">
              {fileListStatus || 'No workspace files found'}
            </div>
          )}
        </div>
      </section>

      <section
        className="file-editor-code"
        onKeyDown={(event) => {
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
          <div className="file-editor-actions">
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              disabled={!workspacePath || !selectedPath || isDirty || isLoading}
              aria-label="Delete editor file"
              title={isDirty ? 'Save or discard changes before deleting' : 'Delete editor file'}
            >
              Delete
            </button>
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => void stageSelectedFile()}
              disabled={
                !workspacePath ||
                !selectedPath ||
                isDirty ||
                isLoading ||
                !selectedHasUnstagedChanges
              }
              aria-label="Stage editor file"
              title={isDirty ? 'Save before staging this file' : 'Stage editor file'}
            >
              Stage
            </button>
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => void unstageSelectedFile()}
              disabled={!workspacePath || !selectedPath || isLoading || !selectedHasStagedChanges}
              aria-label="Unstage editor file"
              title="Unstage editor file"
            >
              Unstage
            </button>
            <button
              className="btn btn-sm btn-ghost"
              type="button"
              onClick={() => setShowCommitDialog(true)}
              disabled={!workspacePath || stagedCount === 0 || isLoading}
              aria-label="Commit staged changes"
              title={stagedCount > 0 ? `Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}` : 'No staged files'}
            >
              Commit
            </button>
            <button
              className="btn btn-sm"
              type="button"
              onClick={saveFile}
              disabled={!workspacePath || !selectedPath || !isDirty || isLoading}
              aria-label="Save editor file"
              title="Save editor file"
            >
              Save
            </button>
          </div>
        </div>
        {showDeleteConfirm && selectedPath && (
          <div className="file-editor-modal-backdrop">
            <div className="file-editor-confirm-card" role="alertdialog" aria-modal="true">
              <strong>Delete file?</strong>
              <span>{selectedPath} will be removed from this workspace.</span>
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
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
        {showCommitDialog && (
          <div className="file-editor-modal-backdrop">
            <div className="file-editor-confirm-card" role="dialog" aria-modal="true">
              <strong>Commit staged changes</strong>
              <span>{stagedCount} staged file{stagedCount === 1 ? '' : 's'} will be committed.</span>
              <input
                className="file-editor-commit-input"
                aria-label="Commit message"
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
                  disabled={!commitMessage.trim() || isLoading || stagedCount === 0}
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
        {pendingOpenEntry && (
          <div
            className="file-editor-unsaved-card"
            role="alertdialog"
            aria-label="Unsaved editor changes"
          >
            <strong>Unsaved changes</strong>
            <span>Save or discard changes before opening {pendingOpenEntry.path}.</span>
            <div className="file-editor-unsaved-actions">
              <button className="btn btn-sm" type="button" onClick={() => void saveFile()}>
                Save
              </button>
              <button
                className="btn btn-sm btn-ghost"
                type="button"
                onClick={() => void discardChangesAndOpenPending()}
              >
                Discard
              </button>
              <button className="btn btn-sm btn-ghost" type="button" onClick={cancelPendingOpen}>
                Cancel
              </button>
            </div>
          </div>
        )}
        <div className="file-editor-code-surface">
          {selectedPath ? (
            <CodeMirror
              value={content}
              height="100%"
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                rectangularSelection: false,
                crosshairCursor: false
              }}
              editable={!isLoading}
              readOnly={isLoading}
              extensions={editorExtensions}
              onChange={(value) => setContent(value)}
            />
          ) : (
            <div className="file-editor-placeholder">Select a text file</div>
          )}
        </div>
        <div className="file-editor-status">
          <span role="status" aria-live="polite">
            {isDirty ? 'Unsaved changes' : status}
            {!isDirty && gitMessage ? ` · ${gitMessage}` : ''}
          </span>
        </div>
      </section>
    </aside>
  )
}
