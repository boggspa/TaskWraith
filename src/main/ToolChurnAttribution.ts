/**
 * Attribute TREE-MEASURED churn to the tool call that caused it — the producer
 * half of the `git_numstat` source that `toolDiffSummaryMerge` was built to
 * consume.
 *
 * The merge rule already knows a measured summary outranks every estimate
 * regardless of magnitude (the estimators systematically over-count: a
 * `string_replace` reports the whole replaced block, `content` reports every
 * line of a rewritten file). Nothing was producing one, so the branch was
 * unreachable and every odometer read as an estimate.
 *
 * WHY A DELTA AND NOT `diff HEAD`. `git diff --numstat HEAD` reports churn since
 * the last COMMIT, which in a normally-dirty tree is dominated by work that
 * predates the tool call. Attributing that to one call would report the same
 * cumulative number on every edit to the same file. So this works on a
 * `WorkspaceChurnDelta` — two samples subtracted — which is per-call churn.
 *
 * Pure / no I/O: callers supply the delta (see `DiffService.sampleWorkspaceChurn`
 * + `WorkspaceChurn.diffWorkspaceChurn`), which keeps attribution unit-testable
 * without a repository fixture.
 */
import type { ToolDiffFileSummary, ToolDiffSummary } from './store/types'
import type { WorkspaceChurnDelta, WorkspaceChurnEntry } from './WorkspaceChurn'

/**
 * Reduce a path to the repo-relative, forward-slash form `git diff --numstat`
 * emits, so a tool's parameter (often absolute, sometimes `./`-prefixed, on
 * Windows backslash-separated) can be matched against a churn entry.
 *
 * Deliberately NOT a general path resolver: it does not touch the filesystem,
 * because attribution runs on the hot tool-settle path and a `realpath` per
 * call would be a syscall per write.
 */
export function normaliseChurnPath(rawPath: string, workspacePath?: string | null): string {
  let value = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
  if (!value) return ''
  const workspace = String(workspacePath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
  if (workspace && value.toLowerCase().startsWith(`${workspace.toLowerCase()}/`)) {
    value = value.slice(workspace.length + 1)
  }
  return value.replace(/^\.\//, '').replace(/^\/+/, '')
}

export interface ToolChurnAttributionInput {
  /** `diffWorkspaceChurn(baselineTakenBeforeTheCall, sampleTakenAfterIt)`. */
  delta: WorkspaceChurnDelta
  /** Paths this tool call named, in any form — normalised here. */
  touchedPaths: readonly string[]
  /** Workspace root, used only to strip an absolute prefix off `touchedPaths`. */
  workspacePath?: string | null
  /**
   * Was this the ONLY write in flight across the sampled interval?
   *
   * When false the delta cannot be cleanly attributed — a peer seat's edit lands
   * in the same two samples — so the result degrades to `estimated`. That is not
   * a cosmetic downgrade: `isMeasuredDiffSummary` requires `exact`, so a degraded
   * summary correctly stops outranking the estimate it cannot improve on.
   */
  exclusive: boolean
}

function isBinaryEntry(entry: WorkspaceChurnEntry): boolean {
  return entry.kind === 'binary'
}

/**
 * Build a `git_numstat` summary for one tool call, or `undefined` when the
 * measurement has nothing to say about it.
 *
 * RETURNS UNDEFINED RATHER THAN A ZERO, on purpose and in two distinct cases:
 *
 *  1. No touched path — a shell command, or a writer whose parameters this build
 *     does not model. The whole-tree delta is available and it is tempting to
 *     attribute it wholesale, but a concurrent seat's edit would then be
 *     reported as this call's work. Guessing is worse than declining.
 *  2. Touched paths that appear in NO entry. A delta only lists paths that
 *     CHANGED, so absence is ambiguous: the file may be unchanged (a no-op
 *     rewrite) or invisible to git (ignored, outside the repo, or a sample that
 *     declined). Those are indistinguishable from here, and claiming an exact
 *     `+0/-0` for the second would be a measured-looking lie that outranks a
 *     correct estimate. The estimate stands instead.
 */
export function attributeToolChurn(
  input: ToolChurnAttributionInput
): ToolDiffSummary | undefined {
  const touched = new Set(
    input.touchedPaths
      .map((entry) => normaliseChurnPath(entry, input.workspacePath))
      .filter(Boolean)
  )
  if (touched.size === 0) return undefined

  const matched = input.delta.entries.filter((entry) =>
    touched.has(normaliseChurnPath(entry.path, input.workspacePath))
  )
  if (matched.length === 0) return undefined

  const files: ToolDiffFileSummary[] = []
  let additions = 0
  let deletions = 0
  let sawCountedEntry = false

  for (const entry of matched) {
    if (isBinaryEntry(entry)) {
      // Present but uncountable. Named without numbers so the card can still
      // show the file, while the totals stay truthful about what was measured.
      files.push({ path: entry.path, status: 'modified' })
      continue
    }
    sawCountedEntry = true
    additions += entry.additions
    deletions += entry.deletions
    files.push({
      path: entry.path,
      status: entry.kind === 'untracked' || entry.kind === 'appeared' ? 'created' : 'modified',
      additions: entry.additions,
      deletions: entry.deletions
    })
  }

  // Every matched path was binary: there is a file list worth showing but no
  // line counts, and emitting `+0/-0` would read as "measured no change".
  if (!sawCountedEntry) {
    return { files, source: 'git_numstat', confidence: 'estimated' }
  }

  return {
    additions,
    deletions,
    files,
    source: 'git_numstat',
    confidence: input.exclusive ? 'exact' : 'estimated'
  }
}
