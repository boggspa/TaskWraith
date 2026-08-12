import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import type {
  GitUnpushedCommit,
  GitUnpushedCommitStack
} from '../../../main/services/GitCommitStack'
import type { GitPullRequestWorkspaceSnapshot } from '../../../main/services/GitPullRequestWorkflow'
import type { GitPrSummary } from '../../../main/services/GitService'
import type { CloseoutCommit } from '../lib/taskWraithCloseoutMessage'
import {
  collectTaskWraithCommitAttributions,
  resolveTaskWraithCommitAttribution
} from '../lib/commitAttribution'
import {
  RunCompleteEpicStack,
  type CommitAttributionFallback,
  type CommitFilePreviewLoadResult
} from './RunCompleteEpicStack'
import { PullRequestWorkflowPanel, pullRequestsByOriginalCommit } from './PullRequestWorkflowPanel'

function commitStats(commit: GitUnpushedCommit): string {
  const fileLabel = `${commit.filesChanged} file${commit.filesChanged === 1 ? '' : 's'}`
  const changes = [
    commit.additions > 0 ? `+${commit.additions}` : null,
    commit.deletions > 0 ? `−${commit.deletions}` : null
  ].filter(Boolean)
  return changes.length > 0 ? `${fileLabel}, ${changes.join(' ')}` : fileLabel
}

export function inspectorCommitRows(
  stack: GitUnpushedCommitStack,
  chats: readonly ChatRecord[]
): CloseoutCommit[] {
  const attributions = collectTaskWraithCommitAttributions(chats)
  return stack.commits.map((commit) => {
    const attribution = resolveTaskWraithCommitAttribution(attributions, commit.hash)
    return {
      hash: commit.hash,
      subject: commit.subject,
      stats: commitStats(commit),
      ...(attribution?.seatLink ? { seatLink: attribution.seatLink } : {}),
      ...(attribution?.participantId ? { participantId: attribution.participantId } : {})
    }
  })
}

function genericAttribution(commit: GitUnpushedCommit): CommitAttributionFallback {
  const details = [
    commit.author.email ? `${commit.author.name} <${commit.author.email}>` : commit.author.name,
    commit.author.authoredAt
  ].filter(Boolean)
  return { text: commit.author.name, title: details.join(' · ') }
}

export interface CommitsInspectorViewProps {
  stack: GitUnpushedCommitStack
  rows: CloseoutCommit[]
  selectedHashes: ReadonlySet<string>
  onToggleCommit: (commit: CloseoutCommit) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onRefresh: () => void
  refreshing?: boolean
  onStartPrRequest?: (commits: GitUnpushedCommit[]) => void
  pullRequestsByCommit?: ReadonlyMap<string, GitPrSummary[]>
  loadCommitFiles?: (commit: CloseoutCommit) => Promise<CommitFilePreviewLoadResult | null>
}

export function CommitsInspectorView({
  stack,
  rows,
  selectedHashes,
  onToggleCommit,
  onSelectAll,
  onClearSelection,
  onRefresh,
  refreshing = false,
  onStartPrRequest,
  pullRequestsByCommit,
  loadCommitFiles
}: CommitsInspectorViewProps): ReactNode {
  const commitsByHash = new Map(stack.commits.map((commit) => [commit.hash, commit]))
  const selectedCommits = stack.commits.filter((commit) => selectedHashes.has(commit.hash))
  const boundaryLabel = stack.upstream || 'all remote-tracking refs'
  return (
    <div className="commits-inspector">
      <header className="commits-inspector-header">
        <div>
          <span className="commits-inspector-eyebrow">Version control</span>
          <h2>Commits</h2>
          <p>
            {stack.branch || 'Detached checkout'} · not on {boundaryLabel}
          </p>
        </div>
        <button type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {rows.length > 0 ? (
        <>
          <div className="commits-inspector-selection" aria-label="Commit selection controls">
            <span>
              {selectedHashes.size} of {rows.length} selected
            </span>
            <div>
              <button
                type="button"
                onClick={onSelectAll}
                disabled={selectedHashes.size === rows.length}
              >
                Select all
              </button>
              <button type="button" onClick={onClearSelection} disabled={selectedHashes.size === 0}>
                Clear
              </button>
              <button
                type="button"
                className="commits-inspector-pr-action"
                disabled={selectedCommits.length === 0 || !onStartPrRequest}
                onClick={() => onStartPrRequest?.(selectedCommits)}
              >
                Create PR request
              </button>
            </div>
          </div>
          <RunCompleteEpicStack
            commits={rows}
            commitRowLimit={null}
            commitAttributionLabel="Attribution"
            commitNumbering
            commitAttributionFallback={(row) => {
              const commit = commitsByHash.get(row.hash)
              return commit ? genericAttribution(commit) : null
            }}
            commitSelection={{ selectedHashes, onToggle: onToggleCommit }}
            commitHashAdornment={(row) => {
              const pullRequests = pullRequestsByCommit?.get(row.hash.toLowerCase()) || []
              if (pullRequests.length === 0) return null
              return (
                <span className="commits-inspector-pr-links">
                  {pullRequests.map((pullRequest, index) => (
                    <button
                      type="button"
                      className="commits-inspector-pr-link"
                      key={String(
                        pullRequest.number || pullRequest.url || pullRequest.headRefName || index
                      )}
                      title={`Open ${pullRequest.title || `PR #${pullRequest.number || 'request'}`}`}
                      disabled={!pullRequest.url}
                      onClick={(event) => {
                        event.stopPropagation()
                        if (pullRequest.url) {
                          void window.api.openExternalOrPath(pullRequest.url)
                        }
                      }}
                    >
                      #{pullRequest.number || 'PR'}
                    </button>
                  ))}
                </span>
              )
            }}
            loadCommitFiles={loadCommitFiles}
          />
        </>
      ) : (
        <section className="file-change-summary-card commits-inspector-empty">
          <strong>Everything is pushed</strong>
          <span>No commits on this checkout are ahead of {boundaryLabel}.</span>
        </section>
      )}
    </div>
  )
}

export function CommitsInspector({
  workspacePath,
  chatId,
  chats = []
}: {
  workspacePath?: string
  chatId?: string
  chats?: ChatRecord[]
}): ReactNode {
  const [stack, setStack] = useState<GitUnpushedCommitStack | null>(null)
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestOpen, setRequestOpen] = useState(false)
  const [pullRequestWorkspace, setPullRequestWorkspace] =
    useState<GitPullRequestWorkspaceSnapshot | null>(null)
  const requestIdRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setStack(null)
      setError(null)
      return
    }
    const requestId = ++requestIdRef.current
    setLoading(true)
    const result = await window.api
      .gitUnpushedCommits({ workspacePath, chatId })
      .catch((cause) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : 'Could not read unpushed commits.'
      }))
    if (requestId !== requestIdRef.current) return
    setLoading(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setStack(result.data)
  }, [chatId, workspacePath])

  useEffect(() => {
    void refresh()
    if (!workspacePath) return
    return window.api.gitSubscribeSnapshot({ workspacePath, chatId }, () => {
      void refresh()
    })
  }, [chatId, refresh, workspacePath])

  useEffect(() => {
    if (!stack) return
    const available = new Set(stack.commits.map((commit) => commit.hash))
    setSelectedHashes((current) => {
      const next = new Set(Array.from(current).filter((hash) => available.has(hash)))
      return next.size === current.size ? current : next
    })
  }, [stack])

  const rows = useMemo(() => (stack ? inspectorCommitRows(stack, chats) : []), [chats, stack])
  const pullRequestsByCommit = useMemo(
    () => pullRequestsByOriginalCommit(pullRequestWorkspace?.pullRequests || []),
    [pullRequestWorkspace?.pullRequests]
  )
  const selectedCommits = useMemo(
    () => stack?.commits.filter((commit) => selectedHashes.has(commit.hash)) || [],
    [selectedHashes, stack]
  )
  const loadCommitFiles = useCallback(
    async (commit: CloseoutCommit): Promise<CommitFilePreviewLoadResult | null> => {
      if (!workspacePath) return null
      const result = await window.api.getCommitFilePreview({
        workspacePath,
        chatId,
        commitHash: commit.hash
      })
      return result.ok ? { files: result.files, totalFiles: result.totalFiles } : null
    },
    [chatId, workspacePath]
  )
  const toggleCommit = useCallback((commit: CloseoutCommit) => {
    setSelectedHashes((current) => {
      const next = new Set(current)
      if (next.has(commit.hash)) next.delete(commit.hash)
      else next.add(commit.hash)
      return next
    })
  }, [])

  if (!workspacePath) {
    return <div className="commits-inspector-state">Open a workspace to inspect its commits.</div>
  }
  if (!stack && loading) {
    return <div className="commits-inspector-state">Loading unpushed commits…</div>
  }
  if (!stack && error) {
    return (
      <div className="commits-inspector-state is-error">
        <strong>Commits unavailable</strong>
        <span>{error}</span>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    )
  }
  if (!stack) return null

  return (
    <div className="commits-inspector-scroll">
      <CommitsInspectorView
        stack={stack}
        rows={rows}
        selectedHashes={selectedHashes}
        onToggleCommit={toggleCommit}
        onSelectAll={() => setSelectedHashes(new Set(stack.commits.map((commit) => commit.hash)))}
        onClearSelection={() => setSelectedHashes(new Set())}
        onStartPrRequest={() => setRequestOpen(true)}
        onRefresh={() => void refresh()}
        refreshing={loading}
        pullRequestsByCommit={pullRequestsByCommit}
        loadCommitFiles={loadCommitFiles}
      />
      <PullRequestWorkflowPanel
        workspacePath={workspacePath}
        chatId={chatId}
        selectedCommits={selectedCommits}
        requestOpen={requestOpen}
        fallbackBaseBranch={
          stack.upstream?.includes('/')
            ? stack.upstream.slice(stack.upstream.indexOf('/') + 1)
            : undefined
        }
        onRequestOpenChange={setRequestOpen}
        onCreated={() => {
          setSelectedHashes(new Set())
          void refresh()
        }}
        onSnapshot={setPullRequestWorkspace}
      />
    </div>
  )
}
