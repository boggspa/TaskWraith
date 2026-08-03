import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import type { GitWorkspaceStats } from '../../../main/services/GitWorkspaceStats'
import type { WorkProvenanceSnapshot } from '../../../shared/workProvenance'
import type { WorkLockProjectionSnapshot } from '../../../shared/workLockProjection'
import { workLockProjectionIsActive } from '../../../shared/workLockProjection'
import { useWorkspaceLocks } from '../hooks/useWorkspaceLocks'
import { normalizeWorkspacePath } from '../lib/composerWorktreeSelection'
import { DigitOdometer } from './DigitOdometer'
import { XSymbolIcon } from './AppChromeSymbols'
import {
  activeWorkspaceProvenanceContributorCount,
  WorkspaceProvenanceList
} from './WorkspaceProvenanceList'
import type { WorkspaceStatsContext } from './workspaceStatsContext'

const NUMBER_FORMAT = new Intl.NumberFormat('en-GB')

export function WorkspaceStatsPopover({
  context,
  containerRef,
  id,
  labelledBy,
  onClose
}: {
  context: WorkspaceStatsContext
  containerRef: RefObject<HTMLDivElement | null>
  id: string
  labelledBy: string
  onClose: () => void
}): React.JSX.Element {
  const requestKey = `${context.chatId}\u0000${context.workspacePath}`
  const [state, setState] = useState<{
    requestKey: string
    loading: boolean
    data: GitWorkspaceStats | null
    error: string | null
  }>({ requestKey: '', loading: true, data: null, error: null })
  const [provenanceState, setProvenanceState] = useState<{
    requestKey: string
    loading: boolean
    data: WorkProvenanceSnapshot | null
    error: string | null
  }>({ requestKey: '', loading: true, data: null, error: null })
  const locks = useWorkspaceLocks({
    workspacePath: context.workspacePath,
    chatId: context.chatId
  })

  useEffect(() => {
    let active = true
    const readStats = window.api.gitWorkspaceStats
    void Promise.resolve()
      .then(() => {
        if (typeof readStats !== 'function') {
          throw new Error('Local repository stats are unavailable in this build.')
        }
        return readStats({
          repoPath: context.baseWorkspacePath,
          worktreePath: context.workspacePath,
          chatId: context.chatId
        })
      })
      .then((result) => {
        if (!active) return
        if (!result.ok) {
          setState({ requestKey, loading: false, data: null, error: result.error })
          return
        }
        const expectedRoot = normalizeWorkspacePath(
          context.snapshot?.repoRoot || context.workspacePath
        )
        if (normalizeWorkspacePath(result.data.repoRoot) !== expectedRoot) {
          setState({
            requestKey,
            loading: false,
            data: null,
            error: 'Repository identity changed while Workspace Stats was opening.'
          })
          return
        }
        setState({ requestKey, loading: false, data: result.data, error: null })
      })
      .catch((error) => {
        if (!active) return
        setState({
          requestKey,
          loading: false,
          data: null,
          error: error instanceof Error ? error.message : 'Local repository stats are unavailable.'
        })
      })
    return () => {
      active = false
    }
  }, [
    context.baseWorkspacePath,
    context.chatId,
    context.snapshot?.repoRoot,
    context.workspacePath,
    requestKey
  ])

  useEffect(() => {
    let active = true
    let timer: number | null = null
    const readProvenance = window.api.gitWorkProvenance
    const schedule = (snapshot: WorkProvenanceSnapshot | null): void => {
      if (!active) return
      const hasLiveEvidence = Boolean(
        snapshot?.available &&
        snapshot.workItems.some(
          (item) => item.lifecycle === 'unresolved' && ['live', 'runtime'].includes(item.liveness)
        )
      )
      timer = window.setTimeout(query, hasLiveEvidence ? 5_000 : 30_000)
    }
    const query = (): void => {
      setProvenanceState((current) => ({
        requestKey,
        loading: current.requestKey !== requestKey || !current.data,
        data: current.requestKey === requestKey ? current.data : null,
        error: null
      }))
      void Promise.resolve()
        .then(() => {
          if (typeof readProvenance !== 'function') {
            throw new Error('Local work provenance is unavailable in this build.')
          }
          return readProvenance({
            repoPath: context.baseWorkspacePath,
            worktreePath: context.workspacePath,
            chatId: context.chatId
          })
        })
        .then((result) => {
          if (!active) return
          if (!result.ok) {
            setProvenanceState((current) => ({
              requestKey,
              loading: false,
              data: current.requestKey === requestKey ? current.data : null,
              error: result.error
            }))
            schedule(null)
            return
          }
          setProvenanceState({
            requestKey,
            loading: false,
            data: result.data,
            error: null
          })
          schedule(result.data)
        })
        .catch((error) => {
          if (!active) return
          setProvenanceState((current) => ({
            requestKey,
            loading: false,
            data: current.requestKey === requestKey ? current.data : null,
            error: error instanceof Error ? error.message : 'Local work provenance is unavailable.'
          }))
          schedule(null)
        })
    }
    query()
    return () => {
      active = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [context.baseWorkspacePath, context.chatId, context.workspacePath, requestKey])

  const currentState = state.requestKey === requestKey ? state : null
  const currentProvenanceState = provenanceState.requestKey === requestKey ? provenanceState : null
  return (
    <WorkspaceStatsPanel
      context={context}
      stats={currentState?.data || null}
      statsLoading={currentState?.loading ?? true}
      statsError={currentState?.error || null}
      provenanceSnapshot={currentProvenanceState?.data || null}
      provenanceLoading={currentProvenanceState?.loading ?? true}
      provenanceError={currentProvenanceState?.error || null}
      lockSnapshot={locks.snapshot}
      locksLoading={locks.loading}
      containerRef={containerRef}
      id={id}
      labelledBy={labelledBy}
      onClose={onClose}
    />
  )
}

export function WorkspaceStatsPanel({
  context,
  stats,
  statsLoading,
  statsError,
  provenanceSnapshot,
  provenanceLoading,
  provenanceError,
  lockSnapshot,
  locksLoading,
  containerRef,
  id,
  labelledBy,
  onClose
}: {
  context: WorkspaceStatsContext
  stats: GitWorkspaceStats | null
  statsLoading: boolean
  statsError: string | null
  provenanceSnapshot: WorkProvenanceSnapshot | null
  provenanceLoading: boolean
  provenanceError: string | null
  lockSnapshot: WorkLockProjectionSnapshot | null
  locksLoading: boolean
  containerRef?: RefObject<HTMLDivElement | null>
  id: string
  labelledBy: string
  onClose: () => void
}): React.JSX.Element {
  const snapshot = context.snapshot
  const activeLocks = useMemo(
    () => lockSnapshot?.locks.filter((lock) => workLockProjectionIsActive(lock.status)) || [],
    [lockSnapshot]
  )
  const workLanes = useMemo(() => groupWorkspaceWorkLanes(activeLocks), [activeLocks])
  const attentionLocks = activeLocks.filter(
    (lock) => lock.status === 'orphan_live' || lock.status === 'recovery_blocked'
  ).length
  const activeEvidenceContributors = provenanceSnapshot
    ? activeWorkspaceProvenanceContributorCount(provenanceSnapshot)
    : 0
  const localOnlyAhead = !snapshot?.upstream ? (stats?.totalCommits ?? null) : null
  const ahead = snapshot?.upstream ? snapshot.ahead : localOnlyAhead
  const behind = snapshot?.upstream ? snapshot.behind : localOnlyAhead === null ? null : 0
  const statsStatus = statsLoading
    ? 'Reading bounded local history…'
    : statsError
      ? statsError
      : stats && !stats.coherent
        ? stats.coherenceReason || 'Repository changed while local stats were sampled.'
        : stats?.observedAt
          ? `Observed ${formatObservedTime(stats.observedAt)}`
          : 'Local history unavailable'

  return (
    <div
      ref={containerRef}
      id={id}
      className="side-chat-layout-menu composer-combined-picker-popover workspace-stats-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
    >
      <header className="workspace-stats-header">
        <div>
          <div className="workspace-stats-eyebrow">Read-only · Local Git</div>
          <h2>Workspace Stats</h2>
          <p title={context.workspacePath}>{context.label}</p>
        </div>
        <button
          type="button"
          className="workspace-stats-close"
          data-workspace-stats-initial-focus
          onClick={onClose}
          aria-label="Close Workspace Stats"
        >
          <XSymbolIcon />
        </button>
      </header>

      <div className="workspace-stats-observation" role="status" aria-live="polite">
        <span>{statsStatus}</span>
        <span>Checkout unchanged · no fetch</span>
      </div>

      <div className="workspace-stats-grid">
        <WorkspaceStatCell
          label="Working tree"
          value={
            snapshot ? (
              <span
                className="workspace-stats-diff"
                aria-label={`${snapshot.lineStats.additions} additions and ${snapshot.lineStats.deletions} deletions`}
              >
                <span className="workspace-stats-addition">
                  <DigitOdometer value={snapshot.lineStats.additions} sign="+" />
                </span>
                <span className="workspace-stats-deletion">
                  <DigitOdometer value={snapshot.lineStats.deletions} sign="-" />
                </span>
              </span>
            ) : (
              'Unavailable'
            )
          }
          detail={
            snapshot
              ? `${formatCount(snapshot.counts.changed, 'changed path')} · ${formatCount(snapshot.counts.untracked, 'new')}`
              : 'Waiting for the authorized Git snapshot'
          }
          note={
            snapshot
              ? `${formatCount(snapshot.counts.staged, 'staged')} · ${formatCount(snapshot.counts.unstaged, 'unstaged')}`
              : undefined
          }
        />
        <WorkspaceStatCell
          label="Current checkout"
          value={snapshot?.branch || (snapshot?.detached ? 'Detached HEAD' : context.label)}
          detail={branchAndWorktreeDetail(stats, statsLoading)}
          note={snapshot?.commit ? `HEAD ${snapshot.commit}` : undefined}
        />
        <WorkspaceStatCell
          label="Commits ahead / behind"
          value={
            ahead === null || behind === null ? (
              'Unavailable'
            ) : (
              <span className="workspace-stats-divergence">
                <span className="workspace-stats-ahead">
                  <span aria-hidden>↑</span>
                  <DigitOdometer value={ahead} ariaLabel={`${ahead} commits ahead`} />
                </span>
                <span className="workspace-stats-behind">
                  <span aria-hidden>↓</span>
                  <DigitOdometer value={behind} ariaLabel={`${behind} commits behind`} />
                </span>
              </span>
            )
          }
          detail={
            snapshot?.upstream ||
            (!snapshot ? 'Tracking ref unavailable' : 'No upstream · all history local')
          }
          note={
            snapshot?.upstream
              ? 'Local tracking ref · no network refresh'
              : 'Compared with no tracking ref'
          }
        />
        <WorkspaceStatCell
          label="Commits"
          value={formatOptionalNumber(stats?.totalCommits, statsLoading)}
          detail={
            stats?.latestTag
              ? `${formatOptionalNumber(stats.commitsSinceLatestTag, false)} since ${stats.latestTag}`
              : statsLoading
                ? 'Reading reachable history'
                : 'Reachable from this HEAD'
          }
          note={stats?.latestCommit?.subject}
        />
        <WorkspaceStatCell
          label="Tracked lines"
          value={formatOptionalNumber(stats?.trackedLines, statsLoading)}
          detail="Tracked text in this checkout"
          note="Binary and untracked files excluded"
        />
        <WorkspaceStatCell
          label="Active days"
          value={activeDaysValue(stats, statsLoading)}
          detail={activeDaysDetail(stats, statsLoading)}
          note={
            stats?.historyTruncated ? 'Bounded 100,000-commit sample' : 'Local commit dates only'
          }
        />
      </div>

      <section className="workspace-stats-provenance" aria-label="TaskWraith work evidence">
        <div
          className={`workspace-stats-provenance-summary${provenanceSnapshot?.stale ? ' is-stale' : ''}`}
        >
          <div>
            <span className="workspace-stats-provenance-dot" aria-hidden />
            <strong>Work evidence</strong>
          </div>
          <span>
            {workProvenanceSummary(
              provenanceSnapshot,
              provenanceLoading,
              provenanceError,
              activeEvidenceContributors
            )}
          </span>
        </div>
        {provenanceLoading && !provenanceSnapshot && (
          <div className="workspace-provenance-empty">
            <span aria-hidden />
            <div>
              <strong>Classifying current Git evidence…</strong>
              <small>TaskWraith is reading a bounded local projection.</small>
            </div>
          </div>
        )}
        {!provenanceLoading && provenanceError && !provenanceSnapshot && (
          <div className="workspace-provenance-empty is-unavailable">
            <span aria-hidden />
            <div>
              <strong>Work evidence unavailable</strong>
              <small>{provenanceError}</small>
            </div>
          </div>
        )}
        {provenanceSnapshot && !provenanceSnapshot.available && (
          <div className="workspace-provenance-empty is-unavailable">
            <span aria-hidden />
            <div>
              <strong>Work evidence unavailable</strong>
              <small>
                {provenanceSnapshot.reason || 'No compatible local projection is available.'}
              </small>
            </div>
          </div>
        )}
        {provenanceSnapshot?.available && <WorkspaceProvenanceList snapshot={provenanceSnapshot} />}
      </section>

      <section className="workspace-stats-work" aria-label="TaskWraith edit authority">
        <div className={`workspace-stats-lock-summary${attentionLocks > 0 ? ' is-attention' : ''}`}>
          <div>
            <span className="workspace-stats-lock-dot" aria-hidden />
            <strong>Edit authority</strong>
          </div>
          <span>
            {workLockSummary(lockSnapshot, locksLoading, activeLocks.length, workLanes.length)}
          </span>
        </div>
        {!locksLoading && lockSnapshot && workLanes.length === 0 && (
          <div className="workspace-stats-work-empty">
            <span className="workspace-stats-work-empty-dot" aria-hidden />
            <div>
              <strong>No active TaskWraith work locks</strong>
              <small>No lane currently holds edit authority in this checkout.</small>
            </div>
            <span>Not observed</span>
          </div>
        )}
        {workLanes.slice(0, 4).map((lane) => (
          <div
            key={lane.id}
            className={`workspace-stats-work-lane${lane.needsAttention ? ' is-attention' : ''}`}
          >
            <span className="workspace-stats-work-lane-dot" aria-hidden />
            <div className="workspace-stats-work-lane-owner">
              <strong>{lane.title}</strong>
              <small>{lane.meta}</small>
            </div>
            <span className="workspace-stats-work-lane-count">
              {formatCount(lane.lockCount, 'lock')}
            </span>
            <span className="workspace-stats-work-lane-targets" title={lane.targets.join(', ')}>
              {lane.targets.join(', ') || 'Workspace authority'}
            </span>
          </div>
        ))}
        {workLanes.length > 4 && (
          <div className="workspace-stats-work-more">
            +{NUMBER_FORMAT.format(workLanes.length - 4)} more worker lanes in Edit Authority
          </div>
        )}
        {attentionLocks > 0 && (
          <div className="workspace-stats-work-attention">
            {formatCount(attentionLocks, 'lock')} need attention in the edit authority surface.
          </div>
        )}
      </section>

      <p className="workspace-stats-boundary-copy">
        Git totals describe this checkout. Provenance classifies local evidence; work locks describe
        edit authority. Neither is inferred authorship.
      </p>
    </div>
  )
}

function WorkspaceStatCell({
  label,
  value,
  detail,
  note
}: {
  label: string
  value: ReactNode
  detail: string
  note?: string
}): React.JSX.Element {
  return (
    <section className="workspace-stats-cell">
      <span className="workspace-stats-cell-label">{label}</span>
      <strong className="workspace-stats-cell-value">{value}</strong>
      <span className="workspace-stats-cell-detail">{detail}</span>
      {note && <small title={note}>{note}</small>}
    </section>
  )
}

function formatOptionalNumber(value: number | null | undefined, loading: boolean): string {
  if (typeof value === 'number') return NUMBER_FORMAT.format(value)
  return loading ? 'Loading…' : 'Unavailable'
}

function formatCount(value: number, singular: string): string {
  return `${NUMBER_FORMAT.format(value)} ${singular}${value === 1 ? '' : 's'}`
}

function branchAndWorktreeDetail(stats: GitWorkspaceStats | null, loading: boolean): string {
  if (
    typeof stats?.localBranchCount === 'number' &&
    typeof stats?.attachedWorktreeCount === 'number'
  ) {
    return `${formatCount(stats.localBranchCount, 'local branch')} · ${formatCount(stats.attachedWorktreeCount, 'worktree')}`
  }
  return loading ? 'Reading local refs and worktrees' : 'Branch/worktree count unavailable'
}

function activeDaysValue(stats: GitWorkspaceStats | null, loading: boolean): string {
  if (stats?.activeDays === null || stats?.activeDays === undefined) {
    return loading ? 'Loading…' : 'Unavailable'
  }
  if (stats.historySpanDays === null) return NUMBER_FORMAT.format(stats.activeDays)
  return `${NUMBER_FORMAT.format(stats.activeDays)} of ${NUMBER_FORMAT.format(stats.historySpanDays)}`
}

function activeDaysDetail(stats: GitWorkspaceStats | null, loading: boolean): string {
  if (loading) return 'Reading local commit dates'
  if (!stats || stats.activeDays === null) return 'Commit activity unavailable'
  if (stats.activeDays === 0) return 'No commit activity yet'
  if (stats.commitsPerActiveDay === null) return 'Commit-day count from bounded history'
  return `~${NUMBER_FORMAT.format(Math.round(stats.commitsPerActiveDay))} commits per active day`
}

function workLockSummary(
  snapshot: WorkLockProjectionSnapshot | null,
  loading: boolean,
  activeCount: number,
  laneCount: number
): string {
  if (loading) return 'Checking local edit authority…'
  if (!snapshot) return 'Edit authority unavailable'
  if (activeCount === 0) return 'No active TaskWraith work locks'
  return `${formatCount(activeCount, 'active lock')} · ${formatCount(laneCount, 'worker lane')}`
}

function workProvenanceSummary(
  snapshot: WorkProvenanceSnapshot | null,
  loading: boolean,
  error: string | null,
  activeContributors: number
): string {
  if (loading && !snapshot) return 'Reading bounded local evidence…'
  if (error && !snapshot) return 'Work evidence unavailable'
  if (!snapshot?.available) return 'Work evidence unavailable'
  const classifiedPaths = snapshot.attribution.root.files
  const state = snapshot.stale ? ' · stale' : ''
  return `${formatCount(activeContributors, 'active contributor')} · ${formatCount(classifiedPaths, 'classified path')}${state}`
}

function groupWorkspaceWorkLanes(locks: WorkLockProjectionSnapshot['locks']): Array<{
  id: string
  title: string
  meta: string
  lockCount: number
  targets: string[]
  needsAttention: boolean
}> {
  const groups = new Map<
    string,
    {
      id: string
      title: string
      meta: string
      lockCount: number
      targets: Set<string>
      needsAttention: boolean
    }
  >()
  for (const lock of locks) {
    const ownerKey =
      lock.owner.laneId || lock.owner.chatId || lock.owner.runId || lock.owner.displayName
    const id = `${ownerKey}\u0000${lock.owner.provider || ''}`
    const title = lock.owner.chatTitle || lock.owner.displayName
    const identity = [lock.owner.provider, lock.owner.displayName]
      .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
      .join(' · ')
    const group = groups.get(id) || {
      id,
      title,
      meta: identity || 'TaskWraith worker',
      lockCount: 0,
      targets: new Set<string>(),
      needsAttention: false
    }
    group.lockCount += 1
    if (lock.target.kind !== 'workspace') group.targets.add(lock.target.path)
    group.needsAttention ||= lock.status === 'orphan_live' || lock.status === 'recovery_blocked'
    groups.set(id, group)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, targets: [...group.targets].sort() }))
    .sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
}

function formatObservedTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'locally'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
