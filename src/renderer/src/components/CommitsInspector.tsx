import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ChatRecord } from '../../../main/store/types'
import type {
  GitUnpushedCommit,
  GitUnpushedCommitStack
} from '../../../shared/gitUnpushedCommits'
import type { GitPullRequestWorkspaceSnapshot } from '../../../main/services/GitPullRequestWorkflow'
import type { GitPrSummary } from '../../../main/services/GitService'
import type { CloseoutCommit } from '../lib/taskWraithCloseoutMessage'
import {
  collectTaskWraithCommitAttributions,
  loadWorkspaceTaskWraithCommitAttributions,
  type TaskWraithCommitAttribution,
  resolveTaskWraithCommitAttribution
} from '../lib/commitAttribution'
import {
  useWorkspaceUnpushedCommitState,
  workspaceUnpushedCommitStore
} from '../lib/workspaceUnpushedCommitStore'
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
  chats: readonly ChatRecord[],
  workspaceAttributions?: ReadonlyMap<string, TaskWraithCommitAttribution>
): CloseoutCommit[] {
  const attributions = workspaceAttributions || collectTaskWraithCommitAttributions(chats)
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
  loadingMore?: boolean
  loadError?: string | null
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
  loadingMore = false,
  loadError,
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
              {selectedHashes.size} of {rows.length}
              {loadingMore ? ' loaded' : ''} selected
            </span>
            <div>
              <button
                type="button"
                onClick={onSelectAll}
                disabled={selectedHashes.size === rows.length}
              >
                {loadingMore ? 'Select loaded' : 'Select all'}
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
            commitCountLabel={loadingMore ? `${rows.length}+ commits · loading older…` : undefined}
          />
          {loadingMore && (
            <div className="commits-inspector-page-status" role="status">
              Loading older commits in the background · newest {rows.length} ready
            </div>
          )}
          {loadError && (
            <div className="commits-inspector-page-status is-error" role="alert">
              Older commits paused: {loadError}
            </div>
          )}
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
  const commitState = useWorkspaceUnpushedCommitState(workspacePath)
  const { stack, loading, loadingMore, error } = commitState
  const [selectedHashes, setSelectedHashes] = useState<Set<string>>(() => new Set())
  const [requestOpen, setRequestOpen] = useState(false)
  const [pullRequestWorkspace, setPullRequestWorkspace] =
    useState<GitPullRequestWorkspaceSnapshot | null>(null)
  const [loadedAttributions, setLoadedAttributions] = useState<{
    workspaceId: string
    values: Map<string, TaskWraithCommitAttribution>
  } | null>(null)

  const attributionWorkspaceId = useMemo(() => {
    const current = chatId ? chats.find((chat) => chat.appChatId === chatId) : undefined
    if (current?.workspaceId) return current.workspaceId
    return chats.find((chat) => chat.workspacePath === workspacePath)?.workspaceId
  }, [chatId, chats, workspacePath])
  const workspaceChats = useMemo(
    () =>
      attributionWorkspaceId
        ? chats.filter((chat) => chat.workspaceId === attributionWorkspaceId)
        : chatId
          ? chats.filter((chat) => chat.appChatId === chatId)
          : [],
    [attributionWorkspaceId, chatId, chats]
  )
  const workspaceSummaryRevision = useMemo(
    () =>
      workspaceChats
        .flatMap((chat) => {
          const summary = chat as ChatRecord & {
            summaryOnly?: boolean
            messageCount?: number
            sourceChatMtimeMs?: number
            sourceChatSize?: number
          }
          if (summary.summaryOnly !== true) return []
          return [
            [
              chat.appChatId,
              chat.persistenceRevision,
              chat.updatedAt,
              summary.messageCount,
              summary.sourceChatMtimeMs,
              summary.sourceChatSize
            ].join(':')
          ]
        })
        .sort()
        .join('|'),
    [workspaceChats]
  )

  useEffect(() => {
    if (!attributionWorkspaceId) return
    let cancelled = false
    const timeout = window.setTimeout(() => {
      void loadWorkspaceTaskWraithCommitAttributions({
        chats: [],
        workspaceId: attributionWorkspaceId,
        loadWorkspaceChats: (workspaceId) => window.api.getChats(workspaceId)
      })
        .then((values) => {
          if (!cancelled) setLoadedAttributions({ workspaceId: attributionWorkspaceId, values })
        })
        .catch(() => {
          // The active chat still supplies live evidence; Git's author remains
          // the truthful fallback if historical transcript hydration fails.
        })
    }, 100)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [attributionWorkspaceId, workspaceSummaryRevision])

  const commitAttributions = useMemo(() => {
    const values = new Map<string, TaskWraithCommitAttribution>()
    const loaded = loadedAttributions
    if (loaded && loaded.workspaceId === attributionWorkspaceId) {
      for (const [hash, attribution] of loaded.values) values.set(hash, attribution)
    }
    for (const [hash, attribution] of collectTaskWraithCommitAttributions(workspaceChats)) {
      values.set(hash, attribution)
    }
    return values
  }, [attributionWorkspaceId, loadedAttributions, workspaceChats])

  const refresh = useCallback(() => {
    if (!workspacePath) return Promise.resolve()
    return workspaceUnpushedCommitStore.refresh({ workspacePath, chatId })
  }, [chatId, workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!stack) return
    const available = new Set(stack.commits.map((commit) => commit.hash))
    setSelectedHashes((current) => {
      const next = new Set(Array.from(current).filter((hash) => available.has(hash)))
      return next.size === current.size ? current : next
    })
  }, [stack])

  const rows = useMemo(
    () => (stack ? inspectorCommitRows(stack, workspaceChats, commitAttributions) : []),
    [commitAttributions, stack, workspaceChats]
  )
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
        loadingMore={loadingMore}
        loadError={stack ? error : null}
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
