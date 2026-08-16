import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitRevisionDiffResult, GitRevisionDiffTarget } from '../../../main/DiffService'
import type {
  GitUnpushedCommit,
  GitUnpushedCommitStack
} from '../../../shared/gitUnpushedCommits'
import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'
import type { ChatRecord } from '../../../main/store/types'
import { taskWraithCommitGroupHashes } from '../../../shared/gitPullRequestGroups'
import {
  collectTaskWraithCommitAttributions,
  loadWorkspaceTaskWraithCommitAttributions,
  resolveTaskWraithCommitAttribution,
  type TaskWraithCommitAttribution
} from '../lib/commitAttribution'
import { SeatStateChips } from './SeatChangeRow'
import { DiffViewer } from './DiffViewer'

export type RevisionDiffIpcTarget = { workspacePath: string } | { repoPath: string; chatId: string }

interface RevisionDiffSelectionRequest {
  path: string
  nonce: number
  view?: 'editor' | 'diff'
}

interface RevisionDiffBaseEntry {
  key: string
  title: string
  detail: string
  attributions: TaskWraithCommitAttribution[]
}

export interface WorkingTreeRevisionEntry extends RevisionDiffBaseEntry {
  kind: 'working-tree'
}

export interface CommitRevisionEntry extends RevisionDiffBaseEntry {
  kind: 'commit'
  commit: GitUnpushedCommit
}

export interface PullRequestRevisionEntry extends RevisionDiffBaseEntry {
  kind: 'pull-request'
  pullRequest: GitPrSummary
}

export type RevisionDiffEntry =
  | WorkingTreeRevisionEntry
  | CommitRevisionEntry
  | PullRequestRevisionEntry

export interface RevisionDiffCatalogue {
  workingTree: WorkingTreeRevisionEntry
  commits: CommitRevisionEntry[]
  pullRequests: PullRequestRevisionEntry[]
  remoteName?: string
}

type WorkspaceDiff = Awaited<ReturnType<typeof window.api.getDiff>>

function commitDetail(commit: GitUnpushedCommit): string {
  const files = `${commit.filesChanged} file${commit.filesChanged === 1 ? '' : 's'}`
  const additions = commit.additions > 0 ? `+${commit.additions}` : ''
  const deletions = commit.deletions > 0 ? `−${commit.deletions}` : ''
  return [commit.hash.slice(0, 9), files, additions, deletions].filter(Boolean).join(' · ')
}

function uniqueAttributions(
  values: Array<TaskWraithCommitAttribution | null>
): TaskWraithCommitAttribution[] {
  const seen = new Set<string>()
  const result: TaskWraithCommitAttribution[] = []
  for (const attribution of values) {
    if (!attribution) continue
    const key = attribution.participantId || attribution.seatLink.participantId || attribution.hash
    if (seen.has(key)) continue
    seen.add(key)
    result.push(attribution)
  }
  return result
}

export function buildRevisionDiffCatalogue(
  stack: GitUnpushedCommitStack | null,
  pullRequests: readonly GitPrSummary[],
  attributions: ReadonlyMap<string, TaskWraithCommitAttribution>
): RevisionDiffCatalogue {
  return {
    workingTree: {
      key: 'working-tree',
      kind: 'working-tree',
      title: 'Working tree',
      detail: 'Live workspace changes',
      attributions: []
    },
    commits: (stack?.commits || []).map((commit) => ({
      key: `commit:${commit.hash}`,
      kind: 'commit' as const,
      title: commit.subject,
      detail: commitDetail(commit),
      commit,
      attributions: uniqueAttributions([
        resolveTaskWraithCommitAttribution(attributions, commit.hash)
      ])
    })),
    pullRequests: pullRequests.map((pullRequest, index) => ({
      key: `pull-request:${pullRequest.number || pullRequest.headRefOid || pullRequest.url || index}`,
      kind: 'pull-request' as const,
      title: pullRequest.title || `Pull request #${pullRequest.number || '?'}`,
      detail: [
        pullRequest.number ? `#${pullRequest.number}` : 'Pull request',
        pullRequest.isDraft ? 'Draft' : pullRequest.state
      ]
        .filter(Boolean)
        .join(' · '),
      pullRequest,
      attributions: uniqueAttributions(
        taskWraithCommitGroupHashes(pullRequest.body).map((hash) =>
          resolveTaskWraithCommitAttribution(attributions, hash)
        )
      )
    })),
    remoteName: stack?.remoteName
  }
}

export function gitRevisionTargetForSelection(
  selection: RevisionDiffEntry,
  remoteName?: string
): GitRevisionDiffTarget | null {
  if (selection.kind === 'working-tree') return null
  if (selection.kind === 'commit') {
    return { kind: 'commit', commitHash: selection.commit.hash }
  }
  const headHash = selection.pullRequest.headRefOid
  const baseRefName = selection.pullRequest.baseRefName
  if (!headHash || !baseRefName) return null
  return {
    kind: 'pull-request',
    headHash,
    baseRefName,
    ...(remoteName ? { remoteName } : {})
  }
}

function RevisionAttribution({
  attribution
}: {
  attribution: TaskWraithCommitAttribution
}): ReactNode {
  const seat = attribution.seatLink.after
  const label = seat.role || attribution.participantId || seat.provider
  return (
    <span className="revision-diff-attribution" title={`${label} · ${seat.provider} ${seat.model}`}>
      <span className="revision-diff-attribution-label">{label}</span>
      <SeatStateChips seat={seat} />
    </span>
  )
}

function RevisionAttributions({
  entry,
  compact = false
}: {
  entry: RevisionDiffEntry
  compact?: boolean
}): ReactNode {
  if (entry.attributions.length > 0) {
    const shown = compact ? entry.attributions.slice(0, 1) : entry.attributions.slice(0, 3)
    return (
      <span className="revision-diff-attributions">
        {shown.map((attribution) => (
          <RevisionAttribution
            attribution={attribution}
            key={attribution.participantId || attribution.seatLink.participantId}
          />
        ))}
        {entry.attributions.length > shown.length && (
          <span className="revision-diff-attribution-more">
            +{entry.attributions.length - shown.length}
          </span>
        )}
      </span>
    )
  }
  if (entry.kind === 'commit') {
    return (
      <span
        className="revision-diff-git-author"
        title={
          entry.commit.author.email
            ? `${entry.commit.author.name} <${entry.commit.author.email}>`
            : entry.commit.author.name
        }
      >
        {entry.commit.author.name}
      </span>
    )
  }
  if (entry.kind === 'pull-request') {
    return <span className="revision-diff-git-author">GitHub PR</span>
  }
  return null
}

function RevisionChoice({
  entry,
  selected,
  disabled,
  onSelect
}: {
  entry: RevisionDiffEntry
  selected: boolean
  disabled?: boolean
  onSelect: (entry: RevisionDiffEntry) => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`revision-diff-choice${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      disabled={disabled}
      title={disabled ? 'This revision is not available in the local checkout.' : entry.title}
      onClick={() => onSelect(entry)}
    >
      <span className={`revision-diff-choice-mark is-${entry.kind}`} aria-hidden="true" />
      <span className="revision-diff-choice-copy">
        <strong>{entry.title}</strong>
        <span>{entry.detail}</span>
        <RevisionAttributions entry={entry} compact />
      </span>
    </button>
  )
}

export function RevisionDiffSidebar({
  catalogue,
  selectedKey,
  onSelect,
  loading = false,
  error
}: {
  catalogue: RevisionDiffCatalogue
  selectedKey: string
  onSelect: (entry: RevisionDiffEntry) => void
  loading?: boolean
  error?: string | null
}): ReactNode {
  return (
    <aside className="revision-diff-sidebar" aria-label="Diff revisions">
      <header className="revision-diff-sidebar-header">
        <span>Review source</span>
        <strong>Changes</strong>
      </header>
      <div className="revision-diff-section">
        <RevisionChoice
          entry={catalogue.workingTree}
          selected={selectedKey === catalogue.workingTree.key}
          onSelect={onSelect}
        />
      </div>
      <div className="revision-diff-section">
        <h3>Pull requests</h3>
        {catalogue.pullRequests.map((entry) => (
          <RevisionChoice
            entry={entry}
            key={entry.key}
            selected={selectedKey === entry.key}
            disabled={!gitRevisionTargetForSelection(entry, catalogue.remoteName)}
            onSelect={onSelect}
          />
        ))}
        {!loading && catalogue.pullRequests.length === 0 && (
          <span className="revision-diff-empty">No pull requests found.</span>
        )}
      </div>
      <div className="revision-diff-section">
        <h3>Commits</h3>
        {catalogue.commits.map((entry) => (
          <RevisionChoice
            entry={entry}
            key={entry.key}
            selected={selectedKey === entry.key}
            onSelect={onSelect}
          />
        ))}
        {!loading && catalogue.commits.length === 0 && (
          <span className="revision-diff-empty">No unpushed commits.</span>
        )}
      </div>
      {loading && <span className="revision-diff-sidebar-state">Refreshing revisions…</span>}
      {error && (
        <span className="revision-diff-sidebar-state is-error" role="alert">
          {error}
        </span>
      )}
    </aside>
  )
}

function comparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function loadRevisionAttributions(
  workspacePath: string,
  chatId: string
): Promise<Map<string, TaskWraithCommitAttribution>> {
  const currentChat = chatId ? await window.api.getChat(chatId).catch(() => null) : null
  let workspaceId = currentChat?.workspaceId
  if (!workspaceId) {
    const workspaces = await window.api.getWorkspaces().catch(() => [])
    const target = comparablePath(workspacePath)
    workspaceId = workspaces.find(
      (workspace) =>
        comparablePath(workspace.path) === target ||
        (workspace.realPath ? comparablePath(workspace.realPath) === target : false)
    )?.id
  }
  const liveChats: ChatRecord[] = currentChat ? [currentChat] : []
  if (!workspaceId) return collectTaskWraithCommitAttributions(liveChats)
  try {
    return await loadWorkspaceTaskWraithCommitAttributions({
      chats: liveChats,
      workspaceId,
      loadWorkspaceChats: (id) => window.api.getChats(id)
    })
  } catch {
    return collectTaskWraithCommitAttributions(liveChats)
  }
}

function selectionTitle(selection: RevisionDiffEntry): string {
  if (selection.kind === 'working-tree') return 'Working tree'
  if (selection.kind === 'commit') return `Commit ${selection.commit.hash.slice(0, 9)}`
  return selection.pullRequest.number
    ? `Pull request #${selection.pullRequest.number}`
    : 'Pull request'
}

export function RevisionDiffStudio({
  workspacePath,
  ipcTarget,
  workingTreeDiff,
  gitSnapshot,
  busyPath,
  selectionRequest,
  refreshToken = 0,
  onOpenFile,
  onStageFile,
  onUnstageFile
}: {
  workspacePath: string
  ipcTarget: RevisionDiffIpcTarget
  workingTreeDiff: WorkspaceDiff | null
  gitSnapshot: GitRepositorySnapshot | null
  busyPath?: string
  selectionRequest?: RevisionDiffSelectionRequest | null
  refreshToken?: number
  onOpenFile?: (path: string) => void
  onStageFile?: (path: string) => void | Promise<void>
  onUnstageFile?: (path: string) => void | Promise<void>
}): ReactNode {
  const [stack, setStack] = useState<GitUnpushedCommitStack | null>(null)
  const [pullRequests, setPullRequests] = useState<GitPrSummary[]>([])
  const [attributions, setAttributions] = useState<Map<string, TaskWraithCommitAttribution>>(
    () => new Map()
  )
  const [selectedKey, setSelectedKey] = useState('working-tree')
  const [revisionDiff, setRevisionDiff] = useState<GitRevisionDiffResult | null>(null)
  const [catalogueLoading, setCatalogueLoading] = useState(true)
  const [revisionLoading, setRevisionLoading] = useState(false)
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const catalogueRequestRef = useRef(0)
  const revisionRequestRef = useRef(0)
  const chatId = 'chatId' in ipcTarget ? ipcTarget.chatId : ''

  const catalogue = useMemo(
    () => buildRevisionDiffCatalogue(stack, pullRequests, attributions),
    [attributions, pullRequests, stack]
  )
  const entries = useMemo(
    () => [catalogue.workingTree, ...catalogue.pullRequests, ...catalogue.commits],
    [catalogue]
  )
  const selection = entries.find((entry) => entry.key === selectedKey) || catalogue.workingTree
  const workingTreeReady = workingTreeDiff !== null

  const refreshCatalogue = useCallback(async () => {
    const requestId = ++catalogueRequestRef.current
    setCatalogueLoading(true)
    const [stackResult, pullRequestResult, loadedAttributions] = await Promise.all([
      window.api.gitUnpushedCommits(ipcTarget).catch((cause) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : 'Could not read unpushed commits.'
      })),
      window.api.githubPrWorkspace(ipcTarget).catch((cause) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : 'Could not read pull requests.'
      })),
      loadRevisionAttributions(workspacePath, chatId)
    ])
    if (requestId !== catalogueRequestRef.current) return
    setCatalogueLoading(false)
    if (stackResult.ok) {
      setStack(stackResult.data)
      setCatalogueError(null)
    } else {
      setStack(null)
      setCatalogueError(stackResult.error)
    }
    setPullRequests(pullRequestResult.ok ? pullRequestResult.data.pullRequests : [])
    setAttributions(loadedAttributions)
  }, [chatId, ipcTarget, workspacePath])

  useEffect(() => {
    if (!workingTreeReady) return
    void refreshCatalogue()
  }, [refreshCatalogue, refreshToken, workingTreeReady])

  useEffect(
    () => () => {
      catalogueRequestRef.current += 1
      revisionRequestRef.current += 1
    },
    []
  )

  useEffect(() => {
    if (selectedKey === 'working-tree') return
    if (!entries.some((entry) => entry.key === selectedKey)) setSelectedKey('working-tree')
  }, [entries, selectedKey])

  useEffect(() => {
    const target = gitRevisionTargetForSelection(selection, catalogue.remoteName)
    const requestId = ++revisionRequestRef.current
    if (!target) {
      setRevisionLoading(false)
      setRevisionDiff(null)
      return
    }
    setRevisionLoading(true)
    setRevisionDiff(null)
    void window.api
      .getGitRevisionDiff({ ...ipcTarget, revision: target })
      .then((result) => {
        if (requestId === revisionRequestRef.current) setRevisionDiff(result)
      })
      .catch((cause) => {
        if (requestId !== revisionRequestRef.current) return
        setRevisionDiff({
          type: 'error',
          text: cause instanceof Error ? cause.message : 'Could not load the selected revision.'
        })
      })
      .finally(() => {
        if (requestId === revisionRequestRef.current) setRevisionLoading(false)
      })
  }, [catalogue.remoteName, ipcTarget, selection])

  const historical = selection.kind !== 'working-tree'
  const displayedDiff = historical
    ? revisionLoading
      ? { type: 'no_changes', text: 'Loading selected revision…' }
      : revisionDiff
    : workingTreeDiff
  const truncation = historical && revisionDiff?.truncated
  return (
    <div className="revision-diff-studio">
      <RevisionDiffSidebar
        catalogue={catalogue}
        selectedKey={selection.key}
        onSelect={(entry) => setSelectedKey(entry.key)}
        loading={catalogueLoading}
        error={catalogueError}
      />
      <section className="revision-diff-main">
        <header className="revision-diff-context">
          <div>
            <span>{selectionTitle(selection)}</span>
            <strong>
              {selection.kind === 'working-tree' ? selection.detail : selection.title}
            </strong>
          </div>
          <RevisionAttributions entry={selection} />
          {truncation && (
            <span className="revision-diff-truncated" role="note">
              Showing the first {revisionDiff?.summaries?.length || 0} of{' '}
              {revisionDiff?.totalFiles || 0} files.
            </span>
          )}
          {historical && <span className="revision-diff-readonly">Read-only review</span>}
        </header>
        <div className="diff-studio popout-diff-studio">
          <DiffViewer
            key={selection.key}
            diff={displayedDiff}
            gitSnapshot={historical ? null : gitSnapshot}
            busyPath={historical ? '' : busyPath}
            workspacePath={workspacePath}
            selectionRequest={historical ? null : selectionRequest}
            onOpenFile={historical ? undefined : onOpenFile}
            onStageFile={historical ? undefined : onStageFile}
            onUnstageFile={historical ? undefined : onUnstageFile}
          />
        </div>
      </section>
    </div>
  )
}
