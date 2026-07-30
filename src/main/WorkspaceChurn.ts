/**
 * TREE-DERIVED workspace churn — the `git`-measured counterpart to the
 * claim-derived per-file digest in `EnsemblePrompt.formatFileChangeDigest`.
 *
 * Why this exists at all: the transcript's `(files changed: src/foo.ts +42/-7)`
 * line is built from `ToolActivity.diffSummary`, and that is derived from a tool
 * call's *parameters* (`bridgeToolDiffStats`) — i.e. what a write said it would
 * do. A reviewer seat auditing only that number is auditing the writer's own
 * vocabulary: a partially applied patch, a shell command the parameter parser
 * does not model, or churn past the digest's 6-path cap is simply invisible. A
 * confident writer can therefore be wrong (or over-claim) with no contradicting
 * evidence anywhere in the prompt.
 *
 * This module supplies the contradicting evidence: `git diff --numstat` sampled
 * against a per-round baseline, so what the panel reads is what the tree holds.
 * It deliberately does NOT replace the claim-derived digest — the two are shown
 * side by side, because the DIVERGENCE between them is the signal worth having.
 *
 * Pure / no I/O: the caller supplies raw `git` output (see
 * `DiffService.sampleWorkspaceChurn`), which keeps the delta and formatting
 * logic unit-testable without a repository fixture.
 */

/** Per-file churn as `git diff --numstat` reports it. */
export interface WorkspaceChurnFileStat {
  additions: number
  deletions: number
  /** git reported `-`/`-` — binary or otherwise unmeasurable as lines. */
  binary?: boolean
}

/**
 * One observation of the workspace.
 *
 * `tracked` is churn measured against the last commit (staged and unstaged
 * combined, which is what `diff HEAD` gives). `untracked` is paths git knows
 * nothing about yet: numstat cannot see them at all, so the sampler counts
 * their lines directly and records them in the same shape.
 *
 * Counting untracked lines is not a nicety. When they were name-only, a file
 * became invisible after the turn it first appeared — a seat could add 400 more
 * lines to a new module across later turns and the panel would see nothing,
 * which is precisely the scope-explosion this stanza exists to expose. Caught by
 * a live probe against a checkout where the new file WAS the untracked one.
 */
export interface WorkspaceChurnSample {
  tracked: Record<string, WorkspaceChurnFileStat>
  untracked: Record<string, WorkspaceChurnFileStat>
}

export type WorkspaceChurnEntryKind =
  /** Already differed from HEAD at baseline; differs MORE now. */
  | 'changed'
  /** Matched HEAD at baseline; differs now. */
  | 'appeared'
  /** Binary/unmeasurable — presence is the only fact available. */
  | 'binary'
  /** First appearance of a file git is not tracking yet. */
  | 'untracked'

export interface WorkspaceChurnEntry {
  path: string
  /** Lines added SINCE the baseline, not since HEAD. */
  additions: number
  /** Lines deleted SINCE the baseline, not since HEAD. */
  deletions: number
  kind: WorkspaceChurnEntryKind
}

export interface WorkspaceChurnDelta {
  entries: WorkspaceChurnEntry[]
  /**
   * Paths whose divergence from HEAD SHRANK since the baseline. Deliberately
   * not called "reverted": a refactor can legitimately reduce churn. But a seat
   * quietly undoing a peer's work also lands here, and that is precisely the
   * unapproved-behaviour class the panel cannot otherwise see, so it is surfaced
   * as a neutral fact rather than an accusation.
   */
  decreasedPaths: string[]
}

const EMPTY_STAT: WorkspaceChurnFileStat = { additions: 0, deletions: 0 }

/**
 * Parse `git diff --numstat` into a per-path map.
 *
 * Note this is NOT the aggregate `parseNumstat` already private to
 * DiffService — that one sums a single file's counts; this one keys by path so
 * two samples can be subtracted.
 *
 * Rename lines carry a fourth field (`add del old new`); the NEW path wins,
 * since that is where the content now lives. Binary files arrive as `- -`.
 * The non-`-z` form is parsed on purpose: git quotes exotic paths, so every
 * record stays on exactly one line, and the quoting is identical in both
 * samples so it cannot perturb a delta.
 */
export function parseNumstatByPath(stdout: string): Record<string, WorkspaceChurnFileStat> {
  const tracked: Record<string, WorkspaceChurnFileStat> = {}
  if (!stdout) return tracked
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    const fields = line.split('\t')
    if (fields.length < 3) continue
    const addField = fields[0].trim()
    const delField = fields[1].trim()
    // Rename: `add del old new` — the new path is the last field.
    const filePath = fields[fields.length - 1].trim()
    if (!filePath) continue
    if (addField === '-' || delField === '-') {
      tracked[filePath] = { additions: 0, deletions: 0, binary: true }
      continue
    }
    const additions = Number.parseInt(addField, 10)
    const deletions = Number.parseInt(delField, 10)
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) continue
    tracked[filePath] = { additions, deletions }
  }
  return tracked
}

function totalChurn(stat: WorkspaceChurnFileStat): number {
  return stat.additions + stat.deletions
}

/**
 * Subtract `baseline` from `current`.
 *
 * Churn is measured relative to the BASELINE, not relative to HEAD, which is
 * the whole point: in a repository that is already dirty (the normal case) the
 * absolute `diff HEAD` numbers are dominated by work that predates the round,
 * and status-code comparison alone — the approach `computeRunDiff` takes — would
 * miss a further edit to a file that was already `modified` before the round
 * started.
 */
export function diffWorkspaceChurn(
  baseline: WorkspaceChurnSample,
  current: WorkspaceChurnSample
): WorkspaceChurnDelta {
  const entries: WorkspaceChurnEntry[] = []
  const decreasedPaths: string[] = []

  const compare = (
    filePath: string,
    currentStat: WorkspaceChurnFileStat,
    priorStat: WorkspaceChurnFileStat | undefined,
    freshKind: WorkspaceChurnEntryKind
  ): void => {
    if (currentStat.binary) {
      // A binary file carries no line counts, so "more churn" is not
      // expressible. Report it when it was not already dirty at baseline.
      if (!priorStat) entries.push({ path: filePath, additions: 0, deletions: 0, kind: 'binary' })
      return
    }
    const prior = priorStat ?? EMPTY_STAT
    const additions = currentStat.additions - prior.additions
    const deletions = currentStat.deletions - prior.deletions
    if (additions > 0 || deletions > 0) {
      entries.push({
        path: filePath,
        additions: Math.max(0, additions),
        deletions: Math.max(0, deletions),
        kind: priorStat ? 'changed' : freshKind
      })
      return
    }
    if (totalChurn(currentStat) < totalChurn(prior)) decreasedPaths.push(filePath)
  }

  for (const [filePath, currentStat] of Object.entries(current.tracked)) {
    // A file `git add`ed mid-round moves from the untracked map to the tracked
    // one. Carry its baseline line count across so the add is not re-reported
    // as if the whole file had just been written.
    compare(
      filePath,
      currentStat,
      baseline.tracked[filePath] ?? baseline.untracked[filePath],
      'appeared'
    )
  }

  for (const [filePath, currentStat] of Object.entries(current.untracked)) {
    compare(filePath, currentStat, baseline.untracked[filePath], 'untracked')
  }

  // A path that was dirty at baseline and is clean now no longer appears in the
  // current sample at all — that is a decrease to zero.
  for (const [filePath, priorStat] of [
    ...Object.entries(baseline.tracked),
    ...Object.entries(baseline.untracked)
  ]) {
    if (!current.tracked[filePath] && !current.untracked[filePath] && totalChurn(priorStat) > 0) {
      decreasedPaths.push(filePath)
    }
  }

  entries.sort((a, b) => {
    const churnDelta = totalChurn(b) - totalChurn(a)
    if (churnDelta !== 0) return churnDelta
    return a.path.localeCompare(b.path)
  })
  return {
    entries,
    decreasedPaths: [...new Set(decreasedPaths)].sort((a, b) => a.localeCompare(b))
  }
}

export const WORKSPACE_CHURN_MAX_PATHS = 12

function formatEntry(entry: WorkspaceChurnEntry): string {
  switch (entry.kind) {
    case 'binary':
      return `  - ${entry.path} (binary — changed, lines not measurable)`
    case 'untracked':
      return `  - ${entry.path} +${entry.additions} (new file, not yet tracked by git)`
    default:
      return `  - ${entry.path} +${entry.additions}/-${entry.deletions}`
  }
}

/**
 * Render the stanza, or `null` when there is genuinely nothing to report.
 *
 * `heading` is supplied by the caller so this module carries no ensemble
 * vocabulary. The cap reports the churn it DROPPED, not merely the file count:
 * a bare "+3 more" reads as a rounding error when it might be the largest edit
 * in the round, and a bounded instrument that hides its own bound is exactly the
 * self-report problem this module exists to fix.
 */
export function formatWorkspaceChurnStanza(
  delta: WorkspaceChurnDelta,
  options: { heading: string; maxPaths?: number }
): string | null {
  const { entries, decreasedPaths } = delta
  if (entries.length === 0 && decreasedPaths.length === 0) return null
  const maxPaths = Math.max(1, options.maxPaths ?? WORKSPACE_CHURN_MAX_PATHS)
  const shown = entries.slice(0, maxPaths)
  const dropped = entries.slice(maxPaths)

  const lines = [options.heading]
  lines.push(...shown.map(formatEntry))

  if (dropped.length > 0) {
    const droppedAdditions = dropped.reduce((sum, entry) => sum + entry.additions, 0)
    const droppedDeletions = dropped.reduce((sum, entry) => sum + entry.deletions, 0)
    lines.push(
      `  - …and ${dropped.length} more ${dropped.length === 1 ? 'file' : 'files'} totalling +${droppedAdditions}/-${droppedDeletions} (not listed — read the workspace if you need them).`
    )
  }

  if (decreasedPaths.length > 0) {
    const shownDecreased = decreasedPaths.slice(0, maxPaths)
    const extraDecreased = decreasedPaths.length - shownDecreased.length
    lines.push(
      `  - Moved BACK toward the last commit (someone reduced or undid existing changes): ${shownDecreased.join(', ')}${
        extraDecreased > 0 ? ` …(+${extraDecreased} more)` : ''
      }`
    )
  }

  // The instrument states its own limits. Without this an agent reads the
  // stanza as "the panel's edits", when it is really "the tree's edits" — and
  // in a checkout shared with other tooling those are not the same set.
  lines.push(
    '  Provenance: measured by `git diff --numstat` (plus a direct line count for files git does not track yet) against a snapshot taken at the start of this round, so these numbers are the tree, not a self-report — prefer them over any per-turn `(files changed: …)` figure they contradict. Caveats: counts cover the whole workspace, so edits made outside this panel appear here too; binary and oversized files are named without line counts; and these are net line counts, so a rewritten line shows as one addition and one deletion.'
  )
  return lines.join('\n')
}
