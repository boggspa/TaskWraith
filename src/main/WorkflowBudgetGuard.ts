// MAIN-process per-occurrence BUDGET KILL threshold logic (decision 6: a
// scheduled run that blows its cost/token/wall-clock budget is aborted MID-RUN,
// not merely blocked from continuing). Pure — no I/O, no Electron. The index.ts
// registry arms the wall-clock timer, hooks the live token stream, triggers the
// abort through the EXISTING cancelProviderRun path, and marks the scheduled task
// terminal; this module is only the threshold brain it consults.
//
// WHY THIS EXISTS
// ---------------
// WorkflowLimits.timeoutSeconds / maxTokens / maxCostUsd are currently DEAD —
// defined on the type but with zero runtime readers. This module makes them
// enforceable. Wall-clock and maxTokens are real mid-run signals (state.tokenUsage
// is a live, monotonic per-event accumulator for Claude/Kimi/Gemini, and the Codex
// notification stream carries token usage). maxCostUsd is BEST-EFFORT: most
// providers populate total_cost_usd only at the terminal result event and
// mergeProviderUsage does not accumulate cost, so a mid-run cost threshold rarely
// trips — kept opportunistic + documented, never load-bearing.

export interface OccurrenceBudgetLimits {
  /** Wall-clock cap in seconds from run start. */
  timeoutSeconds?: number
  /** Cumulative total_tokens cap. */
  maxTokens?: number
  /** Cumulative total_cost_usd cap (best-effort; see file header). */
  maxCostUsd?: number
}

export interface OccurrenceBudget extends OccurrenceBudgetLimits {
  runId: string
  scheduledTaskId: string
  /** ms epoch when the run was dispatched (wall-clock basis). */
  startedAtMs: number
}

export type BudgetBreachKind = 'wallclock' | 'tokens' | 'cost'

export interface BudgetBreach {
  kind: BudgetBreachKind
  /** The configured limit (ms for wallclock, tokens, or USD). */
  limit: number
  /** The observed value at breach time (same unit as limit). */
  observed: number
}

function isPositive(n: number | undefined): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n > 0
}

function numberOrZero(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0
}

/**
 * True iff at least one positive budget is set. Guards registration: a run with
 * no real budget arms nothing (no timer, no token-hook overhead).
 */
export function hasAnyBudget(limits: OccurrenceBudgetLimits | undefined): boolean {
  if (!limits) return false
  return isPositive(limits.timeoutSeconds) || isPositive(limits.maxTokens) || isPositive(limits.maxCostUsd)
}

/**
 * Pure threshold check against a LIVE usage snapshot, evaluated on every stream
 * event. Returns the FIRST breach (tokens before the weaker cost signal) or null.
 * Defensive: missing / NaN usage fields read as 0 (no breach) and this NEVER
 * throws — it runs inside the hot per-event path where state.tokenUsage is typed
 * loosely (`any`).
 */
export function evaluateTokenCostBudget(
  budget: OccurrenceBudgetLimits,
  usage: { total_tokens?: number; total_cost_usd?: number } | null | undefined
): BudgetBreach | null {
  const tokens = numberOrZero(usage?.total_tokens)
  if (isPositive(budget.maxTokens) && tokens >= (budget.maxTokens as number)) {
    return { kind: 'tokens', limit: budget.maxTokens as number, observed: tokens }
  }
  const cost = numberOrZero(usage?.total_cost_usd)
  if (isPositive(budget.maxCostUsd) && cost >= (budget.maxCostUsd as number)) {
    return { kind: 'cost', limit: budget.maxCostUsd as number, observed: cost }
  }
  return null
}

/**
 * Wall-clock breach check. The arming timer fires at `timeoutSeconds`, but this
 * also re-validates against the real clock (so a coalesced / delayed timer can't
 * kill early). Returns a breach iff elapsed >= the limit.
 */
export function evaluateWallclockBudget(budget: OccurrenceBudget, nowMs: number): BudgetBreach | null {
  if (!isPositive(budget.timeoutSeconds)) return null
  const limitMs = (budget.timeoutSeconds as number) * 1000
  const elapsed = nowMs - budget.startedAtMs
  if (elapsed >= limitMs) return { kind: 'wallclock', limit: limitMs, observed: elapsed }
  return null
}

/**
 * Human-readable terminal reason, persisted onto the task's lastError + the
 * durable event. `terminal: true` is the POST-HOC case (Grok, plus historical
 * Cursor records: the run already FINISHED over budget), so the copy says
 * "finished over its …" instead of "aborted: … exceeded". The non-terminal
 * phrasing is preserved byte-for-byte.
 */
export function budgetLastErrorMessage(
  breach: BudgetBreach,
  opts: { terminal?: boolean } = {}
): string {
  const noun =
    breach.kind === 'wallclock'
      ? 'wall-clock budget'
      : breach.kind === 'tokens'
        ? 'token budget'
        : breach.kind === 'cost'
          ? 'cost budget'
          : 'budget'
  const amount =
    breach.kind === 'wallclock'
      ? `${Math.round(breach.observed / 1000)}s / ${Math.round(breach.limit / 1000)}s cap`
      : breach.kind === 'tokens'
        ? `${breach.observed} / ${breach.limit} tokens`
        : breach.kind === 'cost'
          ? `$${breach.observed.toFixed(4)} / $${breach.limit.toFixed(2)} cap`
          : ''
  const tail = amount ? ` (${amount})` : ''
  return opts.terminal
    ? `Scheduled run finished over its ${noun}${tail}.`
    : `Scheduled run aborted: ${noun} exceeded${tail}.`
}
