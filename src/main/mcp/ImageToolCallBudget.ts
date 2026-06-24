/**
 * Per-run image-tool call budget.
 *
 * Bounds asset/disk flooding from the image MCP tools (`image_edit`,
 * `svg_rasterize`, `image_generate`). Each successful call writes a distinct
 * content-addressed asset to `transcript-media/`; identical outputs dedupe by
 * sha256, but an agent can trivially vary crop region / resize dims / prompt to
 * produce DISTINCT outputs and flood the directory with up-to-8MB files. This
 * caps how many image-tool invocations a single run may make.
 *
 * Keyed on the run id (one agent turn == one run, falling back to chat id /
 * `'global'` at the dispatch site), so the budget resets each turn: the cap
 * targets a flooding loop within a turn, not legitimate image work spread across
 * a long conversation. The key Map is itself size-bounded (oldest-inserted key
 * evicted) so it cannot grow without bound across a long-lived app session.
 *
 * In-memory only — counts reset on app restart, matching the volatile
 * per-process contract of `ApprovalBudgetTracker` / `DelegationApprovalBudgetGuard`,
 * the sibling anti-spam budgets this mirrors.
 */

/** Default cap on image-tool calls per run. Generous headroom for a legitimate
 * multi-step image turn while still stopping a runaway flooding loop. */
export const DEFAULT_MAX_IMAGE_TOOL_CALLS_PER_RUN = 100
/** Default ceiling on tracked run keys — bounds the Map across a long session. */
export const DEFAULT_MAX_IMAGE_TOOL_RUN_KEYS = 1000

export class ImageToolCallBudget {
  /** runKey → calls consumed so far */
  private readonly counts = new Map<string, number>()
  private readonly maxCallsPerRun: number
  private readonly maxRunKeys: number

  constructor(
    maxCallsPerRun: number = DEFAULT_MAX_IMAGE_TOOL_CALLS_PER_RUN,
    maxRunKeys: number = DEFAULT_MAX_IMAGE_TOOL_RUN_KEYS
  ) {
    // Defensive: a malformed (non-finite / negative) cap collapses to 0, which
    // blocks every call rather than silently allowing unbounded flooding.
    this.maxCallsPerRun = Number.isFinite(maxCallsPerRun) ? Math.max(0, Math.floor(maxCallsPerRun)) : 0
    this.maxRunKeys = Number.isFinite(maxRunKeys) ? Math.max(1, Math.floor(maxRunKeys)) : 1
  }

  /**
   * Consume one call slot for `runKey`. Returns `true` when the call is within
   * budget (and should proceed), `false` once the run has exhausted its cap.
   *
   * The attempt is ALWAYS counted — a run that has blown its budget stays
   * rejected on every subsequent call rather than oscillating. Inserting a new
   * run key when the Map is full evicts the oldest-inserted key first.
   */
  tryConsume(runKey: string): boolean {
    const next = (this.counts.get(runKey) ?? 0) + 1
    if (!this.counts.has(runKey) && this.counts.size >= this.maxRunKeys) {
      const oldest = this.counts.keys().next().value
      if (oldest !== undefined) this.counts.delete(oldest)
    }
    this.counts.set(runKey, next)
    return next <= this.maxCallsPerRun
  }

  /** Calls consumed so far for `runKey` (0 if never seen). Pure read. */
  getConsumed(runKey: string): number {
    return this.counts.get(runKey) ?? 0
  }

  /** Test-only reset of all state. */
  __reset(): void {
    this.counts.clear()
  }
}
