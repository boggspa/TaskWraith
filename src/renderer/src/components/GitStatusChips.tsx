import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'
import { DigitOdometer } from './DigitOdometer'

/*
 * Shared Git-status chips for the composer workspace lines (the primary
 * workspace row AND each external-path row). Centralising them guarantees one
 * consistent shape + styling everywhere, so branch / merge / sync / CI never
 * drift between row instances — the unification the above-rows needed.
 *
 * They deliberately reuse the existing `.git-status-*` chip styles so there's a
 * single visual language (no parallel class system, no dead CSS). Sync can open
 * the Commits Inspector when local-only work exists; CI and PR chips open GitHub.
 */

/** Branch-name → tone bucket for Claude-app-style colour coding. */
export function branchTone(branch: string | undefined, detached: boolean): string {
  if (detached) return 'detached'
  const b = (branch || '').toLowerCase()
  if (!b) return 'detached'
  if (/^(main|master|trunk|develop)$/.test(b)) return 'main'
  if (/^(feat|feature)\//.test(b)) return 'feature'
  if (/^(fix|hotfix|bug|bugfix)\//.test(b)) return 'fix'
  if (/^(release|rc)\//.test(b)) return 'release'
  return 'other'
}

export interface CiSummary {
  pass: number
  fail: number
  pending: number
  total: number
}

export function summarizeChecks(checks: GitPrSummary['checks']): CiSummary {
  const out: CiSummary = { pass: 0, fail: 0, pending: 0, total: 0 }
  if (!checks) return out
  for (const check of checks) {
    out.total += 1
    const status = (check.status || '').toLowerCase()
    const conclusion = (check.conclusion || '').toLowerCase()
    if (status && status !== 'completed') out.pending += 1
    else if (['success', 'neutral', 'skipped'].includes(conclusion)) out.pass += 1
    else if (conclusion) out.fail += 1
    else out.pending += 1
  }
  return out
}

function GitPullRequestGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4" cy="3.5" r="1.55" />
      <circle cx="4" cy="12.5" r="1.55" />
      <circle cx="12" cy="7" r="1.55" />
      <path d="M4 5.1v5.8" />
      <path d="M5.5 7H10" />
    </svg>
  )
}

function GitMergeGlyph(): React.JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.45"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="4" cy="3.5" r="1.55" />
      <circle cx="4" cy="12.5" r="1.55" />
      <circle cx="12" cy="12.5" r="1.55" />
      <path d="M4 5.1v5.8" />
      <path d="M5.4 7.2c3.7 0 5.4 1.7 6.1 3.8" />
    </svg>
  )
}

/**
 * Local HEAD and its tracking ref no longer share a straight-line history.
 * The twin monoline arrows echo Codex's "continue in a new task" fork glyph
 * while staying legible at the above-row's 13px icon scale.
 */
function GitBranchDriftGlyph(): React.JSX.Element {
  return (
    <svg
      className="git-status-drift-glyph"
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 8h2.1c3.1 0 3.1-3.7 5.9-3.7H13" />
      <path d="m11.1 2.5 1.9 1.8-1.9 1.8" />
      <path d="M4.6 8c3.1 0 3.1 3.7 5.9 3.7H13" />
      <path d="m11.1 9.9 1.9 1.8-1.9 1.8" />
    </svg>
  )
}

function normalisePrState(value: string | undefined): string {
  return (value || '').trim().toUpperCase()
}

export type PrLifecycleTone = 'open' | 'ready' | 'draft' | 'merged' | 'stale' | 'blocked' | 'closed'

export function prLifecycle(
  pr: GitPrSummary,
  snapshot?: GitRepositorySnapshot | null
): {
  tone: PrLifecycleTone
  label: string
  title: string
  merged: boolean
} {
  const state = normalisePrState(pr.state)
  const mergeState = normalisePrState(pr.mergeStateStatus)
  const numberLabel = typeof pr.number === 'number' ? `#${pr.number}` : 'PR'
  const headMatchesLocal =
    Boolean(snapshot?.commit && pr.headRefOid) && snapshot?.commit === pr.headRefOid
  const headDiffersFromLocal =
    Boolean(snapshot?.commit && pr.headRefOid) && snapshot?.commit !== pr.headRefOid

  if (state === 'MERGED') {
    return {
      tone: 'merged',
      label: `${numberLabel} merged`,
      title: `${numberLabel} merged${pr.baseRefName ? ` into ${pr.baseRefName}` : ''}`,
      merged: true
    }
  }
  if (state === 'CLOSED') {
    return {
      tone: 'closed',
      label: `${numberLabel} closed`,
      title: `${numberLabel} closed without merge`,
      merged: false
    }
  }
  if (pr.isDraft) {
    return {
      tone: 'draft',
      label: `${numberLabel} draft`,
      title: `${numberLabel} is a draft pull request`,
      merged: false
    }
  }
  if (['BLOCKED', 'UNKNOWN'].includes(mergeState)) {
    return {
      tone: 'blocked',
      label: `${numberLabel} blocked`,
      title: `${numberLabel} is blocked from merging${mergeState ? ` (${mergeState})` : ''}`,
      merged: false
    }
  }
  if (headDiffersFromLocal || ['DIRTY', 'BEHIND', 'UNSTABLE'].includes(mergeState)) {
    return {
      tone: 'stale',
      label: `${numberLabel} stale`,
      title: headDiffersFromLocal
        ? `${numberLabel} head differs from local HEAD`
        : `${numberLabel} needs attention${mergeState ? ` (${mergeState})` : ''}`,
      merged: false
    }
  }
  return {
    tone: headMatchesLocal || mergeState === 'CLEAN' ? 'ready' : 'open',
    label: numberLabel,
    title: `${numberLabel} is open${mergeState ? ` (${mergeState})` : ''}`,
    merged: false
  }
}

/** In-progress merge / rebase / cherry-pick + unmerged-file count. */
export function GitMergeBadge({
  snapshot
}: {
  snapshot: GitRepositorySnapshot
}): React.JSX.Element | null {
  const conflicts = snapshot.conflicts ?? 0
  if (!snapshot.mergeState && conflicts === 0) return null
  const hasConflicts = conflicts > 0
  const stateLabel =
    snapshot.mergeState === 'merge'
      ? 'merging'
      : snapshot.mergeState === 'rebase'
        ? 'rebasing'
        : snapshot.mergeState === 'cherry-pick'
          ? 'cherry-pick'
          : null
  const title = [
    stateLabel ? `${stateLabel} in progress` : null,
    hasConflicts ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span
      className={`git-status-merge ${hasConflicts ? 'git-merge-conflict' : 'git-merge-progress'}`}
      title={title}
    >
      <span className="git-status-merge-glyph" aria-hidden>
        {hasConflicts ? '⚠' : '⟳'}
      </span>
      {hasConflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}` : stateLabel}
    </span>
  )
}

/**
 * Ahead/behind vs upstream — consolidates the old state-pill "push" flag and the
 * separate ↑↓ row into one sync chip. Renders nothing when in sync, so a tidy
 * repo stays quiet.
 */
export function GitSyncChip({
  snapshot,
  onOpenCommits
}: {
  snapshot: GitRepositorySnapshot
  onOpenCommits?: () => void
}): React.JSX.Element | null {
  if (snapshot.detached || !snapshot.branch) return null

  const commitLabel = (count: number): string => `${count} commit${count === 1 ? '' : 's'}`
  if (!snapshot.upstream) {
    const clickable = Boolean(onOpenCommits)
    const totalCommits = snapshot.totalCommits ?? 0
    if (totalCommits <= 0) return null
    const commitsLabel = commitLabel(totalCommits)
    const open = (): void => onOpenCommits?.()
    return (
      <span
        className={`git-status-push git-status-no-upstream${
          clickable ? ' git-status-push-clickable' : ''
        }`}
        title={`No upstream — ${commitsLabel} in this repository · push to publish this branch${
          clickable ? ' · open unpushed commits' : ''
        }`}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onClick={clickable ? open : undefined}
        onKeyDown={
          clickable
            ? (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                open()
            }
            : undefined
        }
      >
        <DigitOdometer value={totalCommits} ariaLabel={`${commitsLabel} in this repository`} />
      </span>
    )
  }
  const ahead = snapshot.ahead ?? 0
  const behind = snapshot.behind ?? 0
  if (ahead === 0 && behind === 0) {
    // Fully synced renders NOTHING here — the workspace rows keep only the
    // ahead/behind counts, and the green tick moved to the timecode bar's
    // git satellite cluster as the "Pushed" indicator (GitHubSatelliteRow).
    return null
  }
  const diverged = ahead > 0 && behind > 0
  const syncState = diverged ? 'diverged' : behind > 0 ? 'behind' : 'ahead'
  const clickable = ahead > 0 && Boolean(onOpenCommits)
  const open = (): void => onOpenCommits?.()
  const statusTitle = diverged
    ? `Diverged from local tracking ref ${snapshot.upstream} · ${commitLabel(ahead)} local-only · ${commitLabel(behind)} upstream-only · fetch to refresh remote state.`
    : behind > 0
      ? `This checkout is ${commitLabel(behind)} behind local tracking ref ${snapshot.upstream}; fetch to refresh remote state.`
      : `${commitLabel(ahead)} ahead of local tracking ref ${snapshot.upstream}.`
  const title = `${statusTitle}${clickable ? ` Open ${commitLabel(ahead)} in the Commits Inspector.` : ''}`
  return (
    <span
      className={`git-status-push git-sync-${syncState}${
        clickable ? ' git-status-push-clickable' : ''
      }`}
      data-sync-state={syncState}
      title={title}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? open : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              open()
            }
          : undefined
      }
    >
      {ahead > 0 && (
        <span className="git-status-ahead">
          <span aria-hidden>↑</span>
          <DigitOdometer value={ahead} ariaLabel={`${ahead} ahead`} />
        </span>
      )}
      {behind > 0 && (
        <span className={`git-status-behind${diverged ? ' git-status-diverged' : ''}`}>
          <GitBranchDriftGlyph />
          <DigitOdometer value={behind} ariaLabel={`${behind} behind`} />
        </span>
      )}
    </span>
  )
}

export function GitPrLifecycleChip({
  pr,
  snapshot
}: {
  pr: GitPrSummary | null
  snapshot?: GitRepositorySnapshot | null
}): React.JSX.Element | null {
  if (!pr) return null
  const lifecycle = prLifecycle(pr, snapshot)
  const clickable = Boolean(pr.url)
  const open = (): void => {
    if (pr.url && typeof window.api.openExternalOrPath === 'function') {
      void window.api.openExternalOrPath(pr.url)
    }
  }
  return (
    <span
      className={`git-status-pr git-pr-${lifecycle.tone}${
        clickable ? ' git-status-pr-clickable' : ''
      }`}
      title={`${lifecycle.title}${clickable ? ' — open' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? open : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }
          : undefined
      }
    >
      <span className="git-status-pr-glyph" aria-hidden>
        {lifecycle.merged ? <GitMergeGlyph /> : <GitPullRequestGlyph />}
      </span>
      <span>{lifecycle.label}</span>
    </span>
  )
}

/** CI check rollup — clickable: opens the PR page, else the first failing run. */
export function GitCiChip({ pr }: { pr: GitPrSummary | null }): React.JSX.Element | null {
  const ci = summarizeChecks(pr?.checks)
  if (ci.total === 0) return null
  const tone = ci.fail > 0 ? 'fail' : ci.pending > 0 ? 'pending' : 'pass'
  const glyph = ci.fail > 0 ? '✗' : ci.pending > 0 ? '●' : '✓'
  const count = ci.fail > 0 ? ci.fail : ci.pending > 0 ? ci.pending : ci.pass
  const url =
    pr?.url ||
    pr?.checks?.find((check) => {
      const conclusion = (check.conclusion || '').toLowerCase()
      return conclusion && !['success', 'neutral', 'skipped'].includes(conclusion)
    })?.url
  const clickable = Boolean(url)
  const open = (): void => {
    if (url && typeof window.api.openExternalOrPath === 'function') {
      void window.api.openExternalOrPath(url)
    }
  }
  return (
    <span
      className={`git-status-ci git-ci-${tone}${clickable ? ' git-status-ci-clickable' : ''}`}
      title={`CI: ${ci.pass} passed · ${ci.fail} failed · ${ci.pending} pending${
        clickable ? ' — open' : ''
      }`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? open : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                open()
              }
            }
          : undefined
      }
    >
      <span className="git-status-ci-glyph">{glyph}</span>
      {count}
      <span className="git-status-ci-label">CI</span>
    </span>
  )
}
