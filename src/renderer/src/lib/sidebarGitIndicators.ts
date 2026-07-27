import type { GitPrSummary, GitRepositorySnapshot } from '../../../main/services/GitService'
import type { ChatGitWorkflowInput } from '../../../shared/chatGitWorkflow'

/*
 * Git status indicators for the sidebar's active-row identity ticker — the
 * small icon strip that rides the right-hand end of the "Workspace/branch"
 * face (see SidebarTitleTicker + `.sidebar-git-indicators`).
 *
 * Colour vocabulary is GitHub's, stated explicitly by the maintainer:
 *   green PR      → open, not yet merged
 *   green ✓ ring  → ready to merge (mergeable, checks clean)
 *   orange        → in the merge queue / auto-merge armed: GitHub has accepted
 *                   it but it has NOT landed yet (waiting on required checks
 *                   or its turn)
 *   purple        → merged. The final state; nothing else is.
 *   red           → closed WITHOUT merging (abandoned or superseded)
 *   green tick    → every local commit is on the upstream ("Pushed")
 *
 * NOTE this is the inverse of `.github-satellite-icon.tone-*` in shard 07,
 * which paints `open` purple and `merged` green. That mapping predates this
 * vocabulary and is wrong against GitHub; it is NOT changed here (different
 * surface, not in scope) — but do not copy it.
 *
 * Detached HEAD renders NOTHING AT ALL, by explicit request: a detached
 * checkout has no branch identity worth grading.
 *
 * Pure + dependency-free so the precedence, de-dup and cap are unit-tested
 * without a render harness or a live repo.
 */

export type SidebarGitIndicatorKind =
  /** Every local commit is on the upstream. */
  | 'pushed'
  /** Local work not yet pushed — the fallback "something is happening" signal. */
  | 'ahead'
  /** PR open, still ordinary. */
  | 'pr-open'
  /** PR open and mergeable with a clean check rollup. */
  | 'pr-ready'
  /** Auto-merge armed / merge queue: accepted, not landed. */
  | 'pr-queued'
  /** Landed. The only final-success state. */
  | 'pr-merged'
  /** Closed without merging. */
  | 'pr-closed'

/** Drives the icon colour. Names are the meaning, not the hue. */
export type SidebarGitIndicatorTone = 'synced' | 'open' | 'queued' | 'merged' | 'closed' | 'idle'

export interface SidebarGitIndicator {
  kind: SidebarGitIndicatorKind
  /** Set when the indicator is about one specific pull request. */
  prNumber?: number
  /** Commit count, `ahead` only. */
  count?: number
  /** True when this came from the thread's own durable workflow marker rather
   * than the workspace's live PR — i.e. "the PR THIS session shipped". */
  ownThread?: boolean
}

/**
 * A "MEGA BUSY" thread caps here. Three is what fits beside an ellipsizing
 * branch name without the identity face collapsing to nothing.
 */
export const MAX_SIDEBAR_GIT_INDICATORS = 3

const TONE_BY_KIND: Record<SidebarGitIndicatorKind, SidebarGitIndicatorTone> = {
  pushed: 'synced',
  ahead: 'idle',
  'pr-open': 'open',
  'pr-ready': 'open',
  'pr-queued': 'queued',
  'pr-merged': 'merged',
  'pr-closed': 'closed'
}

export function sidebarGitIndicatorTone(kind: SidebarGitIndicatorKind): SidebarGitIndicatorTone {
  return TONE_BY_KIND[kind]
}

/** Hover/tooltip copy. The strip itself is decorative, so this is where the
 * detail lives. */
export function sidebarGitIndicatorLabel(indicator: SidebarGitIndicator): string {
  const pr = typeof indicator.prNumber === 'number' ? `PR #${indicator.prNumber}` : 'PR'
  const scope = indicator.ownThread ? "this thread's " : ''
  switch (indicator.kind) {
    case 'pushed':
      return 'Pushed — every local commit is on the upstream'
    case 'ahead': {
      const count = indicator.count ?? 0
      return `${count} commit${count === 1 ? '' : 's'} ahead of the upstream`
    }
    case 'pr-open':
      return `${scope}${pr} is open`
    case 'pr-ready':
      return `${scope}${pr} is ready to merge`
    case 'pr-queued':
      return `${scope}${pr} is queued to merge — accepted, waiting on checks or its turn`
    case 'pr-merged':
      return `${scope}${pr} merged`
    case 'pr-closed':
      return `${scope}${pr} closed without merging`
  }
}

function normalise(value: string | undefined): string {
  return (value || '').trim().toUpperCase()
}

/**
 * Collapse a live PR summary into one indicator.
 *
 * Precedence is lifecycle order, most-final first: merged and closed are
 * terminal; a queued PR is further along than a merely-ready one; everything
 * else open (including draft, and the BLOCKED/BEHIND/DIRTY merge states that
 * used to read as "stale") is a plain open PR.
 */
function livePrIndicator(pr: GitPrSummary | null | undefined): SidebarGitIndicator | null {
  if (!pr || typeof pr.number !== 'number' || pr.number <= 0) return null
  const prNumber = pr.number
  const state = normalise(pr.state)
  if (state === 'MERGED') return { kind: 'pr-merged', prNumber }
  if (state === 'CLOSED') return { kind: 'pr-closed', prNumber }
  if (pr.autoMergeEnabled) return { kind: 'pr-queued', prNumber }
  if (!pr.isDraft && normalise(pr.mergeStateStatus) === 'CLEAN') {
    return { kind: 'pr-ready', prNumber }
  }
  return { kind: 'pr-open', prNumber }
}

/**
 * The thread's own durable marker (`chat.gitWorkflow`) — transition-gated, so
 * it means "the PR THIS session shipped reached this state", not "the
 * workspace happens to be near a PR".
 *
 * Only terminal outcomes are surfaced: a stale `open`/`draft` marker would
 * duplicate the live PR without adding anything, and the marker is not
 * refreshed while the thread is unfocused.
 */
function markerIndicator(
  workflow: ChatGitWorkflowInput | null | undefined
): SidebarGitIndicator | null {
  if (!workflow) return null
  const prNumber = typeof workflow.prNumber === 'number' ? workflow.prNumber : undefined
  if (workflow.state === 'merged') return { kind: 'pr-merged', prNumber, ownThread: true }
  if (workflow.state === 'closed') return { kind: 'pr-closed', prNumber, ownThread: true }
  return null
}

export interface BuildSidebarGitIndicatorsInput {
  snapshot?: GitRepositorySnapshot | null
  /** The workspace's live PR for this branch. */
  pr?: GitPrSummary | null
  /** The chat's durable per-thread workflow marker. */
  workflow?: ChatGitWorkflowInput | null
}

/**
 * Assemble the strip. Display order mirrors GitHubSatelliteRow (sync state
 * first, then pull requests) so the two surfaces read the same way.
 *
 * The live PR and the thread's own marker are independent sources and BOTH can
 * show — that's the "multiple PRs" case: this thread's #10 merged (purple)
 * while the branch's current #12 is open (green). They collapse to one
 * indicator when they are the same PR, since two icons for one PR is noise.
 */
export function buildSidebarGitIndicators(
  input: BuildSidebarGitIndicatorsInput
): SidebarGitIndicator[] {
  const snapshot = input.snapshot
  // Detached HEAD: no branch identity to grade, so the strip stays empty.
  if (snapshot?.detached) return []

  const live = livePrIndicator(input.pr)
  const marker = markerIndicator(input.workflow)
  const prIndicators: SidebarGitIndicator[] = []
  if (live) prIndicators.push(live)
  if (marker) {
    const duplicate =
      live &&
      // Same PR — or either side lost its number, in which case a second icon
      // for the same lifecycle state is still just noise.
      (marker.prNumber === live.prNumber ||
        marker.prNumber === undefined ||
        live.prNumber === undefined) &&
      marker.kind === live.kind
    if (!duplicate) prIndicators.push(marker)
  }

  const ahead = Math.max(0, snapshot?.ahead ?? 0)
  const hasBranch = Boolean(snapshot?.branch)
  const hasUpstream = Boolean(snapshot?.upstream)
  const sync: SidebarGitIndicator | null =
    hasBranch && hasUpstream && ahead === 0
      ? { kind: 'pushed' }
      : // "Work is active and no other git status applies" — the ahead count is
        // the fallback signal, so it yields to any pull-request indicator.
        ahead > 0 && prIndicators.length === 0
        ? { kind: 'ahead', count: ahead }
        : null

  const out = sync ? [sync, ...prIndicators] : prIndicators
  return out.slice(0, MAX_SIDEBAR_GIT_INDICATORS)
}

/* ------------------------------------------------------------------
 * Primitive transport
 * ------------------------------------------------------------------
 * The sidebar rows are memoised with hand-written comparators, and anything
 * sourced from App state must reach them as a PRIMITIVE or it silently never
 * updates (a fresh array each render either churns the memo or, compared by
 * reference against a stale one, never changes). So the strip crosses the prop
 * chain as one encoded string and is decoded at the leaf.
 * ------------------------------------------------------------------ */

/** `"pushed|pr-merged:12:own|pr-open:14"` — empty string when there's nothing. */
export function encodeSidebarGitIndicators(indicators: readonly SidebarGitIndicator[]): string {
  return indicators
    .map((indicator) => {
      const parts: string[] = [indicator.kind]
      if (indicator.kind === 'ahead') parts.push(String(indicator.count ?? 0))
      else parts.push(indicator.prNumber === undefined ? '' : String(indicator.prNumber))
      if (indicator.ownThread) parts.push('own')
      return parts.join(':')
    })
    .join('|')
}

export function decodeSidebarGitIndicators(
  encoded: string | null | undefined
): SidebarGitIndicator[] {
  if (!encoded) return []
  const out: SidebarGitIndicator[] = []
  for (const token of encoded.split('|')) {
    const [kind, value, own] = token.split(':')
    if (!(kind in TONE_BY_KIND)) continue
    const indicator: SidebarGitIndicator = { kind: kind as SidebarGitIndicatorKind }
    const parsed = value ? Number.parseInt(value, 10) : NaN
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      if (indicator.kind === 'ahead') indicator.count = parsed
      else indicator.prNumber = parsed
    }
    if (own === 'own') indicator.ownThread = true
    out.push(indicator)
  }
  return out.slice(0, MAX_SIDEBAR_GIT_INDICATORS)
}
