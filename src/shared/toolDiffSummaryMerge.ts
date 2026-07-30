/**
 * Precedence for merging a newly observed `ToolDiffSummary` into the one a tool
 * activity already carries.
 *
 * Extracted from the inline chain in `index.ts` for two reasons: the rule now
 * has unit tests instead of being asserted only by the odometer's appearance,
 * and the hot shared file keeps a call site rather than a growing if/else.
 *
 * THE INVERSION THIS FIXES. The original rule was LARGER-WINS: on a source
 * mismatch, incoming stats overwrote only when `additions` or `deletions`
 * exceeded what was already there. That is sound while every source is an
 * estimate of the same patch — a streamed patch preview genuinely does grow, and
 * the first snapshot can be partial.
 *
 * It inverts the moment a source is MEASURED rather than estimated, because the
 * estimators systematically over-count:
 *   - `string_replace` counts the whole replaced block (`newString` lines added,
 *     `oldString` lines deleted), so a one-character fix inside a forty-line
 *     block reports +40/-40 rather than +1/-1.
 *   - `content` counts every line of a written file as an addition with zero
 *     deletions, so rewriting a 500-line file reports +500/-0 regardless of what
 *     actually changed.
 * Tree-measured churn is therefore usually SMALLER than the estimate it should
 * replace, and larger-wins rejects it for precisely that reason — the truthful
 * number loses because it is truthful.
 *
 * So exactness, not magnitude, decides whenever exactness is on the table.
 * Everything else keeps the previous behaviour byte for byte; the tests pin that
 * so this stays additive for every source shipping today.
 */
import type { ToolDiffSummary } from '../main/store/types'

/**
 * Sources whose numbers come from measuring the workspace rather than inferring
 * from a tool's parameters or streamed output. Membership is deliberately narrow:
 * a source belongs here only if being wrong would be a defect rather than an
 * expected approximation.
 */
const MEASURED_SOURCES: ReadonlySet<ToolDiffSummary['source']> = new Set(['git_numstat'])

/**
 * Is this summary measured truth — a source that read the workspace, reporting
 * `exact` confidence? Both halves are required: a `git_numstat` summary that
 * degraded to `estimated` (a capped or partially attributed sample) has no claim
 * to outrank anything.
 *
 * Deliberately a plain boolean and NOT a `summary is ToolDiffSummary` type
 * predicate. A predicate would assert that a FALSE result means "not a
 * ToolDiffSummary", which is untrue — an estimating summary is still one — and
 * it narrowed the else-branches of `mergeToolDiffSummary` to `never`, which the
 * typechecker caught.
 */
export function isMeasuredDiffSummary(summary: ToolDiffSummary | undefined): boolean {
  return Boolean(summary && MEASURED_SOURCES.has(summary.source) && summary.confidence === 'exact')
}

/**
 * Minimal guard for the two lanes that do NOT use `mergeToolDiffSummary`.
 *
 * Three code paths write `ToolActivity.diffSummary` and each settled on its own
 * precedence: the bridge lane merges (this module), the DESKTOP lane in
 * `ToolParser.pairToolResult` lets a freshly derived summary win unconditionally,
 * and the ENSEMBLE lane's `mergeToolDiffSummaries` is first-counts-wins. Both of
 * the latter would discard a measured summary — in opposite ways.
 *
 * Rather than re-point those two at the full merge (their existing rules are
 * deliberate: "fresh wins" lets a result-derived diff beat a parameter guess, and
 * first-counts-wins keeps a streamed ensemble activity stable), this asserts ONLY
 * the property architecture A needs: measured truth is never displaced. Every
 * estimate-versus-estimate outcome in those lanes stays byte-identical, so this
 * cannot regress behaviour that ships today.
 *
 * Returns `existing` when it is measured, otherwise whatever the lane decided.
 */
export function preserveMeasuredDiffSummary(
  existing: ToolDiffSummary | undefined,
  laneResult: ToolDiffSummary | undefined
): ToolDiffSummary | undefined {
  return isMeasuredDiffSummary(existing) && !isMeasuredDiffSummary(laneResult)
    ? existing
    : laneResult
}

/**
 * Merge `incoming` into `existing`, returning the summary the activity should
 * carry. Pure — neither argument is mutated.
 *
 * Order matters:
 *   1. Nothing yet → take the observation.
 *   2. Existing is measured truth → keep it. No estimate displaces it, however
 *      large, and a second measurement of the same call has nothing to add.
 *   3. Incoming is measured truth → it wins outright, REGARDLESS of magnitude.
 *      This is the branch larger-wins made unreachable.
 *   4. Same source → merge (the streaming-growth case).
 *   5. Different source → larger-wins, exactly as before.
 */
export function mergeToolDiffSummary(
  existing: ToolDiffSummary | undefined,
  incoming: ToolDiffSummary
): ToolDiffSummary {
  if (!existing) return incoming
  if (isMeasuredDiffSummary(existing)) return existing
  if (isMeasuredDiffSummary(incoming)) return { ...existing, ...incoming }
  if (existing.source === incoming.source) return { ...existing, ...incoming }
  if (
    (incoming.additions ?? 0) > (existing.additions ?? 0) ||
    (incoming.deletions ?? 0) > (existing.deletions ?? 0)
  ) {
    return { ...existing, ...incoming }
  }
  return existing
}
