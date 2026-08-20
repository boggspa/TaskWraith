/**
 * Delegation-approval anti-spam budget.
 *
 * Wires the in-memory `ApprovalBudgetTracker` into the live
 * `delegate_to_subthread` approval gate (see `index.ts`). A runaway
 * agent that calls `delegate_to_subthread` in a tight loop would
 * otherwise flood the user with approval modals — and kick off a
 * provider run per attempt — without bound. This guard caps how many
 * delegation approvals a single parent run may generate; once the cap
 * is crossed, further delegation attempts from that run are declined
 * BEFORE a modal is shown and the agent gets a tool_result explaining
 * the block (so it stops looping and continues the parent turn).
 *
 * Keyed on the parent run id (one agent turn == one run), so the
 * budget resets each turn: the cap targets a delegation *loop* within
 * a turn, not legitimate delegation spread across a long conversation.
 * In-memory only — matches `ApprovalBudgetTracker`'s volatile
 * per-process contract; counts reset on app restart.
 *
 * This guard is the sole live consumer of `ApprovalBudgetTracker`; it
 * keys on the parent run id (its generic `(key, budget)` API is
 * key-agnostic) and caps delegation approvals per agent turn.
 */

import { DEFAULT_MAX_WAVE_AGENTS } from '../shared/fleetWave'
import { ApprovalBudgetTracker, type ApprovalBudgetDecision } from './ApprovalBudgetTracker'

/** Env override for the per-parent-run delegation-approval cap. */
export const DELEGATION_APPROVAL_BUDGET_ENV = 'TASKWRAITH_DELEGATION_APPROVAL_BUDGET'

/**
 * Default cap. Generous headroom for a legitimate multi-delegation
 * turn while still stopping a runaway loop (which could otherwise
 * spawn hundreds of provider runs from one turn).
 *
 * Derived from the wave default rather than picked, because a wave
 * reserves one slot per worker and this budget is per turn: the two
 * numbers are coupled whether or not anyone writes it down. Two full
 * waves is the headroom a real turn wants — one big fan-out plus a
 * follow-up — and is still two orders of magnitude short of a loop.
 */
export const DEFAULT_DELEGATION_APPROVAL_BUDGET = DEFAULT_MAX_WAVE_AGENTS * 2

/**
 * Resolve the cap from the environment, falling back to the default
 * for unset / empty / malformed (non-finite or negative) values. `0`
 * is honoured — it blocks all delegation, which is a usable kill
 * switch and matches `ApprovalBudgetTracker`'s `budget=0` semantics.
 */
export function resolveDelegationApprovalBudget(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[DELEGATION_APPROVAL_BUDGET_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_DELEGATION_APPROVAL_BUDGET
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DELEGATION_APPROVAL_BUDGET
  return Math.floor(parsed)
}

/**
 * Per-process guard wrapping a single `ApprovalBudgetTracker`. The cap
 * is fixed at construction; the tracker holds the consumed count per
 * parent-run key.
 */
export class DelegationApprovalBudgetGuard {
  private readonly tracker = new ApprovalBudgetTracker()
  private readonly budget: number

  constructor(budget: number = resolveDelegationApprovalBudget()) {
    this.budget = budget
  }

  /**
   * Consume one delegation-approval slot for the parent run. Returns
   * `'allowed'` (and increments the consumed count) or `'exhausted'`
   * (and leaves it untouched). An empty key is always `'allowed'`:
   * with no parent run to scope the cap to there is nothing to
   * rate-limit, mirroring the tracker's pass-through for empty ids.
   */
  tryConsume(parentRunKey: string): ApprovalBudgetDecision {
    return this.tracker.tryConsume(parentRunKey, this.budget)
  }

  /**
   * Refund previously consumed slots for the parent run. Used when a
   * wave reserved N slots and then did not spawn (user deny, policy
   * deny, parent cancelled, or all-or-nothing spawn rollback). Clamped
   * at 0 per underlying `releaseOne` — never goes negative.
   */
  release(parentRunKey: string, count: number = 1): void {
    const n = Math.max(0, Math.floor(count))
    for (let i = 0; i < n; i++) {
      this.tracker.releaseOne(parentRunKey)
    }
  }

  /** Remaining slots for the parent run (`Infinity` if uncapped). */
  remaining(parentRunKey: string): number {
    return this.tracker.getRemaining(parentRunKey, this.budget)
  }

  /** Clear the counter for a parent run (e.g. on chat archival). */
  reset(parentRunKey: string): void {
    this.tracker.reset(parentRunKey)
  }

  /** The configured cap — for messaging / UI affordances. */
  cap(): number {
    return this.budget
  }
}

/** Process-wide guard used by the delegation gate in `index.ts`. */
export const delegationApprovalBudget = new DelegationApprovalBudgetGuard()

/**
 * Tool-result text shown to the delegating agent when the budget is
 * exhausted. Mirrors the policy-decline wording so the agent reacts
 * the same way: stop delegating, continue the parent turn directly.
 */
export function delegationApprovalBudgetExhaustedMessage(
  parentProviderLabel: string,
  targetProviderLabel: string,
  cap: number
): string {
  return (
    `Sub-thread delegation to ${targetProviderLabel} was blocked: this run reached its ` +
    `delegation-approval budget (${cap}). This anti-spam cap stops a delegation loop from ` +
    `flooding approvals and spawning unbounded provider runs. ${parentProviderLabel} should stop ` +
    `delegating and continue the parent turn directly; the budget resets on the next turn.`
  )
}
