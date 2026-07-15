// MAIN-process STATEFUL owner of the per-occurrence budget kill. The pure
// threshold brain lives in WorkflowBudgetGuard.ts; THIS class arms the
// wall-clock timer, tracks live token usage per run, fires the abort through an
// INJECTED dependency (index.ts wires it to cancelProviderRun), and marks the
// scheduled task terminal. Every side effect is an injected dep (no electron /
// AppStore import) so it unit-tests under plain vitest — mirroring
// ProviderAutoFailover.ts's injected-deps style.
//
// SCOPE: SOLO scheduled-workflow runs ONLY. Ensemble occurrences carry no
// per-participant scheduledTaskId, share per-round token accounting, and never
// fail over (see maybeTriggerProviderAutoFailover's chatKind==='ensemble'
// guard). Enforcing a mid-run budget kill on one ensemble participant would
// abort a single fan-out leg while the round keeps accounting against a shared
// ledger — out of scope and explicitly NOT wired. index.ts registers ONLY at
// the solo dispatch chokepoint; an ensemble round's runId is never registered.
//
// TERMINAL MARK TIMING — the task is marked failed in triggerKill (the kill
// DECISION), NOT on the run's exit. This is deliberate and load-bearing:
//   - The default Claude path is the Agent SDK; a budget-kill abort may make
//     tryRunClaudeSdk throw/return-false before its normal terminal event. The
//     outer fallback guard now publishes a synthetic compat exit, but the task
//     failure must already be durable before transport cleanup races with it.
//   - The renderer also marks a solo scheduled task when the run ends
//     (App.tsx); a cancelled run could be marked 'cancelled' and beat a later
//     'failed'+reason. Marking at the kill decision wins that race and makes the
//     failure (with the budget reason) deterministic, incrementing failureStreak
//     via syncWorkflowFromScheduledTask. updateScheduledTask's terminal guard
//     makes any later renderer/exit mark a no-op.
// onExit is therefore CLEANUP ONLY (clear the timer + drop state so a late timer
// can't fire on a finished/reused run).
//
// PROVIDER COVERAGE of the live token signal (onUsage):
//   - claude, kimi: live, monotonic state.tokenUsage via mergeProviderUsage
//     (handleCliProviderJsonEvent) — the Claude SDK path streams through the
//     same handler, so both Claude transports are covered.
//   - codex: live via the thread/tokenUsage/updated notification.
//   - grok, cursor: their stream handlers early-return BEFORE the onUsage hook
//     and only set tokenUsage at the TERMINAL result, so there is NO live mid-run
//     token signal — they get WALL-CLOCK enforcement ONLY (the timer). A
//     maxTokens/maxCostUsd budget on a grok/cursor scheduled run does not fire
//     mid-run, and a run that already completed is not failed post-hoc for tokens.
//   - gemini: retired (separate PTY path); not wired.
// maxCostUsd is best-effort across ALL providers (cost is typically set only at
// the terminal result and mergeProviderUsage does not accumulate it) — see the
// WorkflowBudgetGuard header.

import type { ProviderId } from './store/types'
import {
  budgetLastErrorMessage,
  evaluateTokenCostBudget,
  evaluateWallclockBudget,
  type BudgetBreach,
  type OccurrenceBudget
} from './WorkflowBudgetGuard'

/** A live budget registration: the threshold inputs plus the provider to abort on. */
export type RegisteredBudget = OccurrenceBudget & { provider: ProviderId }

/**
 * Injected I/O. index.ts supplies real implementations; tests supply fakes.
 *  - abort: terminate the run MID-FLIGHT. Wired to cancelProviderRun(provider,
 *    runId) — NOT runManager.cancel, which skips Codex's turn/interrupt RPC.
 *  - markTaskFailed: settle the exact ScheduledTask occurrence terminal. The
 *    runId is deliberately carried alongside scheduledTaskId so the production
 *    owner registry can reject a stale run trying to settle a newer occurrence.
 *  - now / setTimer / clearTimer: clock + timer seam (real = Date.now /
 *    setTimeout / clearTimeout) so wall-clock arming is deterministic in tests.
 */
export interface WorkflowBudgetRegistryDeps {
  abort: (provider: ProviderId, runId: string) => void
  markTaskFailed: (failure: {
    runId: string
    scheduledTaskId: string
    lastError: string
  }) => void
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** Optional structured log/observability hook (e.g. emit a durable event). */
  onEvent?: (event: WorkflowBudgetEvent) => void
}

export type WorkflowBudgetEvent =
  | { kind: 'registered'; runId: string; provider: ProviderId; scheduledTaskId: string }
  | { kind: 'killed'; runId: string; provider: ProviderId; scheduledTaskId: string; breach: BudgetBreach }
  | {
      kind: 'task-failed'
      runId: string
      scheduledTaskId: string
      lastError: string
      // Present only for the POST-HOC grok/cursor overage (onTerminalUsage); the
      // mid-run kill carries the breach on its 'killed' event instead. Lets a
      // ledger consumer record the breach for the post-hoc path too.
      breach?: BudgetBreach
    }

interface RunEntry {
  budget: RegisteredBudget
  timer: unknown | null
}

export class WorkflowBudgetRegistry {
  private readonly deps: WorkflowBudgetRegistryDeps
  private readonly runs = new Map<string, RunEntry>()
  /** Idempotency: runIds we've already triggered a kill on. Kept until onExit so
   * a racing onUsage / wall-clock fire after the abort no-ops, and so isKilled
   * gates the Claude SDK→CLI fallback (RC2) for the lifetime of the killed run. */
  private readonly killedRuns = new Set<string>()

  constructor(deps: WorkflowBudgetRegistryDeps) {
    this.deps = deps
  }

  /**
   * Register a run for budget enforcement and arm its wall-clock timer (if a
   * positive timeoutSeconds is set). Callers gate registration on
   * hasAnyBudget(limits) + the settings escape hatch, so a no-budget run never
   * reaches here. Re-registering the same runId replaces the prior entry and
   * re-arms the timer (defensive; should not happen for a fresh appRunId).
   */
  register(budget: RegisteredBudget): void {
    // A runId that's already been killed must not be resurrected by a late /
    // duplicate register (e.g. a reused id) — drop it.
    if (this.killedRuns.has(budget.runId)) return
    // Replace any stale prior entry for this id (clear its timer first).
    this.clearRunTimer(budget.runId)

    let timer: unknown | null = null
    if (typeof budget.timeoutSeconds === 'number' && Number.isFinite(budget.timeoutSeconds) && budget.timeoutSeconds > 0) {
      // Arm relative to the budget's own startedAtMs (not now) so a registration
      // that lands slightly after dispatch still fires at the correct deadline.
      const elapsed = this.deps.now() - budget.startedAtMs
      const remainingMs = Math.max(0, budget.timeoutSeconds * 1000 - elapsed)
      timer = this.deps.setTimer(() => this.onWallclock(budget.runId), remainingMs)
    }
    this.runs.set(budget.runId, { budget, timer })
    this.deps.onEvent?.({
      kind: 'registered',
      runId: budget.runId,
      provider: budget.provider,
      scheduledTaskId: budget.scheduledTaskId
    })
  }

  /**
   * Feed a LIVE usage snapshot from the token stream. Evaluates the
   * token/cost threshold and triggers a kill on the first breach. No-op for an
   * unregistered or already-killed run. NEVER throws (the pure evaluator is
   * defensive and this guards its own lookups) — it runs in the hot per-event
   * path where usage is loosely typed.
   */
  onUsage(runId: string, usage: { total_tokens?: number; total_cost_usd?: number } | null | undefined): void {
    const entry = this.runs.get(runId)
    if (!entry) return
    const breach = evaluateTokenCostBudget(entry.budget, usage)
    if (breach) this.triggerKill(runId, breach)
  }

  /**
   * POST-HOC token/cost check for providers with NO live token signal (grok,
   * cursor): their tokenUsage is known only at the terminal exit, by which point
   * the run has FINISHED and a mid-run abort is impossible. Called from
   * sendAgentCompatExit (before onExit). If the FINAL usage exceeded a token/cost
   * budget, mark the ScheduledTask FAILED — so failureStreak bumps + the user sees
   * the overage — but do NOT abort (the process already exited). No-op for an
   * unregistered or already-killed run (a live-signal run already mid-run-killed
   * must not be double-marked). Sets the killed flag for idempotency so a racing
   * onExit/onUsage no-ops.
   */
  onTerminalUsage(
    runId: string,
    usage: { total_tokens?: number; total_cost_usd?: number } | null | undefined
  ): void {
    if (this.killedRuns.has(runId)) return
    const entry = this.runs.get(runId)
    if (!entry) return
    const breach = evaluateTokenCostBudget(entry.budget, usage)
    if (!breach) return
    this.killedRuns.add(runId)
    this.clearRunTimer(runId)
    const lastError = budgetLastErrorMessage(breach, { terminal: true })
    this.deps.markTaskFailed({
      runId,
      scheduledTaskId: entry.budget.scheduledTaskId,
      lastError
    })
    this.deps.onEvent?.({
      kind: 'task-failed',
      runId,
      scheduledTaskId: entry.budget.scheduledTaskId,
      lastError,
      breach
    })
  }

  /**
   * Wall-clock deadline reached (timer fired) — re-validate against the real
   * clock before killing, so a coalesced / delayed timer can't kill early.
   * No-op for an unregistered or already-killed run.
   */
  onWallclock(runId: string): void {
    const entry = this.runs.get(runId)
    if (!entry) return
    const breach = evaluateWallclockBudget(entry.budget, this.deps.now())
    if (breach) this.triggerKill(runId, breach)
  }

  /**
   * Abort the run + mark its scheduled task failed. IDEMPOTENT: a second trigger
   * (e.g. token + wall-clock racing) does nothing. Order: flag killed → clear
   * timer → MARK the task failed (the kill decision is authoritative; see the
   * "TERMINAL MARK TIMING" note in the file header) → abort LAST. Abort is last
   * because deps.abort may synchronously drive the run to exit (re-entering
   * onExit on the same stack); by then killed is set, the timer is cleared, and
   * the mark is done, so re-entry is well-defined (cleanup only).
   */
  triggerKill(runId: string, breach: BudgetBreach): void {
    if (this.killedRuns.has(runId)) return
    const entry = this.runs.get(runId)
    if (!entry) return
    this.killedRuns.add(runId)
    this.clearRunTimer(runId)

    const { provider, scheduledTaskId } = entry.budget
    const lastError = budgetLastErrorMessage(breach)
    this.deps.onEvent?.({ kind: 'killed', runId, provider, scheduledTaskId, breach })
    this.deps.markTaskFailed({ runId, scheduledTaskId, lastError })
    this.deps.onEvent?.({ kind: 'task-failed', runId, scheduledTaskId, lastError })

    this.deps.abort(provider, runId)
  }

  /**
   * Called on EVERY terminal exit (killed or not). CLEANUP ONLY: clear the armed
   * timer + drop per-run state so a
   * late timer can't fire on a finished or reused run. The terminal mark already
   * happened in triggerKill. Idempotent + a no-op for unregistered runs. Drops
   * the killed flag so a fresh run with a reused id starts clean.
   */
  onExit(runId: string): void {
    this.clearRunTimer(runId)
    this.runs.delete(runId)
    this.killedRuns.delete(runId)
  }

  /** True iff this run was budget-killed — gates the Claude SDK→CLI fallback (RC2). */
  isKilled(runId: string): boolean {
    return this.killedRuns.has(runId)
  }

  /** Clear EVERY armed timer (for app will-quit) and empty the live set. */
  disposeAll(): void {
    for (const [, entry] of this.runs) {
      if (entry.timer !== null) this.deps.clearTimer(entry.timer)
      entry.timer = null
    }
    this.runs.clear()
  }

  /** Test/diagnostic: number of live (registered, not-yet-exited) runs. */
  get size(): number {
    return this.runs.size
  }

  private clearRunTimer(runId: string): void {
    const entry = this.runs.get(runId)
    if (entry && entry.timer !== null) {
      this.deps.clearTimer(entry.timer)
      entry.timer = null
    }
  }
}
