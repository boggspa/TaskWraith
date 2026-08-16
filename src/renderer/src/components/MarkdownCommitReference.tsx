import { useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import type { GitUnpushedCommit } from '../../../main/services/GitCommitStack'
import {
  buildTraceableCommitIndex,
  resolveTraceableCommitReference
} from '../lib/traceableCommitReferences'
import {
  useWorkspaceUnpushedCommitState,
  workspaceUnpushedCommitStore
} from '../lib/workspaceUnpushedCommitStore'
import {
  DIFF_HOVER_PREVIEW_TOOLTIP_ID,
  DiffHoverPreviewOverlay,
  type DiffHoverPreviewFile,
  type DiffHoverPreviewState,
  diffHoverPreviewBoundaryForElement,
  useDiffHoverPreviewDismiss,
  useDiffHoverPreviewState
} from './DiffHoverPreview'
import { MarkdownCommitReferenceContext } from './MarkdownCommitReferenceContext'

const COMMIT_REFERENCE_HOVER_OPEN_DELAY_MS = 800
const COMMIT_REFERENCE_HOVER_CLOSE_DELAY_MS = 1400
const COMMIT_FILES_LOADING_MESSAGE = 'Loading files changed by this commit…'
const COMMIT_FILES_UNAVAILABLE_MESSAGE = 'Commit files are unavailable.'
const COMMIT_FILES_EMPTY_MESSAGE = 'No changed files were reported for this commit.'

interface CommitFilePreviewResult {
  files: DiffHoverPreviewFile[]
  totalFiles: number
}

type CommitFilePreviewCacheEntry =
  | { status: 'loading'; promise: Promise<CommitFilePreviewResult | null> }
  | { status: 'loaded'; result: CommitFilePreviewResult }
  | { status: 'unavailable' }

const commitFilePreviewCache = new Map<string, CommitFilePreviewCacheEntry>()

function commitFilePreviewCacheKey(workspacePath: string, hash: string): string {
  return `${workspacePath}\u0000${hash.toLowerCase()}`
}

function commitPreviewStatus(commit: GitUnpushedCommit): string {
  return `${commit.filesChanged} file${commit.filesChanged === 1 ? '' : 's'}`
}

export function MarkdownCommitReference({
  hash,
  children
}: {
  hash: string
  children?: ReactNode
}): ReactNode {
  const context = useContext(MarkdownCommitReferenceContext)
  const state = useWorkspaceUnpushedCommitState(context?.index ? undefined : context?.workspacePath)
  useEffect(() => {
    if (!context || context.index) return
    void workspaceUnpushedCommitStore.ensure({
      workspacePath: context.workspacePath,
      chatId: context.chatId
    })
  }, [context])
  const index = useMemo(() => {
    if (context?.index) return context.index
    return state.stack ? buildTraceableCommitIndex(state.stack.commits, state.complete) : null
  }, [context?.index, state.complete, state.stack])
  const commit = index ? resolveTraceableCommitReference(index, hash) : null
  const {
    closePreview,
    keepPreviewOpen,
    preview,
    scheduleClosePreview,
    scheduleShowPreview,
    showPreview
  } = useDiffHoverPreviewState(
    COMMIT_REFERENCE_HOVER_CLOSE_DELAY_MS,
    COMMIT_REFERENCE_HOVER_OPEN_DELAY_MS
  )
  useDiffHoverPreviewDismiss(preview, closePreview)
  const activeRef = useRef(false)
  useEffect(
    () => () => {
      activeRef.current = false
    },
    []
  )

  const openPreview = useCallback(
    (anchorElement: HTMLElement, focusTarget?: DiffHoverPreviewState['focusTarget']) => {
      if (!commit || !context) return
      activeRef.current = true
      const buildPreview = (
        result: CommitFilePreviewResult | null,
        emptyMessage?: string,
        emptyFooterLabel?: string
      ): DiffHoverPreviewState | null => {
        if (!anchorElement.isConnected) return null
        return {
          anchor: anchorElement.getBoundingClientRect(),
          boundary: diffHoverPreviewBoundaryForElement(anchorElement),
          summary: {
            actionLabel: `Commit ${commit.hash.slice(0, 9)}`,
            path: `Commit ${commit.hash.slice(0, 9)}${commit.subject ? ` — ${commit.subject}` : ''}`,
            status: commitPreviewStatus(commit),
            additions: commit.additions,
            deletions: commit.deletions,
            files: result?.files ?? [],
            fileCount: result?.totalFiles ?? 0,
            emptyMessage,
            emptyFooterLabel,
            source: 'commit-reference'
          },
          focusTarget
        }
      }
      const produce = (): DiffHoverPreviewState | null => {
        const cacheKey = commitFilePreviewCacheKey(context.workspacePath, commit.hash)
        const cached = commitFilePreviewCache.get(cacheKey)
        const showLoadedResult = (loaded: CommitFilePreviewResult | null): void => {
          if (!activeRef.current || !anchorElement.isConnected) return
          const nextPreview = loaded
            ? loaded.files.length > 0
              ? buildPreview(loaded)
              : buildPreview(loaded, COMMIT_FILES_EMPTY_MESSAGE, 'No files reported')
            : buildPreview(null, COMMIT_FILES_UNAVAILABLE_MESSAGE, 'Preview unavailable')
          if (nextPreview) showPreview(nextPreview)
        }
        if (cached?.status === 'loaded') {
          return cached.result.files.length > 0
            ? buildPreview(cached.result)
            : buildPreview(cached.result, COMMIT_FILES_EMPTY_MESSAGE, 'No files reported')
        }
        if (cached?.status === 'unavailable') {
          return buildPreview(null, COMMIT_FILES_UNAVAILABLE_MESSAGE, 'Preview unavailable')
        }
        if (cached?.status === 'loading') {
          void cached.promise.then(showLoadedResult)
          return buildPreview(null, COMMIT_FILES_LOADING_MESSAGE, 'Loading files…')
        }

        const pending = window.api
          .getCommitFilePreview({
            workspacePath: context.workspacePath,
            chatId: context.chatId,
            commitHash: commit.hash
          })
          .then((result): CommitFilePreviewResult | null => {
            const loaded = result.ok ? { files: result.files, totalFiles: result.totalFiles } : null
            commitFilePreviewCache.set(
              cacheKey,
              loaded ? { status: 'loaded', result: loaded } : { status: 'unavailable' }
            )
            showLoadedResult(loaded)
            return loaded
          })
          .catch(() => {
            commitFilePreviewCache.set(cacheKey, { status: 'unavailable' })
            showLoadedResult(null)
            return null
          })
        commitFilePreviewCache.set(cacheKey, { status: 'loading', promise: pending })
        return buildPreview(null, COMMIT_FILES_LOADING_MESSAGE, 'Loading files…')
      }

      if (focusTarget) {
        const nextPreview = produce()
        if (nextPreview) showPreview(nextPreview)
      } else {
        scheduleShowPreview(produce)
      }
    },
    [commit, context, scheduleShowPreview, showPreview]
  )

  if (!commit || !context) return children ?? hash

  const leavePreview = () => {
    activeRef.current = false
    scheduleClosePreview()
  }
  const keepOpen = () => {
    activeRef.current = true
    keepPreviewOpen()
  }
  return (
    <>
      <span
        className="markdown-commit-reference"
        data-commit-hash={commit.hash}
        tabIndex={0}
        aria-label={`Preview commit ${commit.hash.slice(0, 9)}: ${commit.subject}`}
        aria-describedby={preview ? DIFF_HOVER_PREVIEW_TOOLTIP_ID : undefined}
        onMouseEnter={(event) => openPreview(event.currentTarget)}
        onMouseLeave={leavePreview}
        onFocus={(event) => openPreview(event.currentTarget, 'preview')}
        onBlur={leavePreview}
      >
        {children ?? hash}
      </span>
      <DiffHoverPreviewOverlay
        preview={preview}
        onFocus={keepOpen}
        onBlur={leavePreview}
        onMouseEnter={keepOpen}
        onMouseLeave={leavePreview}
      />
    </>
  )
}
