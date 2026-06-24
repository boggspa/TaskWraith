// MAIN-process "workflow stall reconciler" (wedge detector). Pure logic only —
// no electron / node-builtin imports (anything reachable from a renderer module
// that imports node builtins blanks the window). The store + index.ts seams
// inject I/O (the run-queue liveness probe, the settle writer).
//
// WHY THIS EXISTS
// ---------------
// A scheduled workflow stamps `WorkflowDefinition.activeExecutionId` at
// materialize time and SKIPS the next occurrence while that execution is
// non-terminal (store: materializeWorkflowTask). If an occurrence wedges
// (renderer closed mid-dispatch, a leak that never marks the task terminal),
// the workflow is silently disabled forever — no error, no auto-disable.
//
// This module is the universal BACKSTOP: after a backstop window with no live
// run, settle the wedged task to 'failed'. The store's existing
// `syncWorkflowFromScheduledTask` then clears `activeExecutionId` (unblocking
// future occurrences), bumps `failureStreak`, and engages
// `maxConsecutiveFailures` auto-disable. The transition guard makes the settle
// idempotent, so a genuinely-alive run's real terminal write is never lost.

import type { ScheduledTask } from './store/types'

/**
 * Backstop after which a non-terminal, non-live scheduled-workflow occurrence is
 * considered wedged and settled to 'failed'. ~6h: long enough to never
 * false-fail a legitimately long run, short enough that a wedge self-heals
 * within a day. Single named export — the store + index.ts both default to it.
 */
export const DEFAULT_STALL_BACKSTOP_MS = 6 * 60 * 60 * 1000

export interface StalledScheduledTask {
  task: ScheduledTask
  /** Which timestamp field drove the staleness decision. */
  basis: 'runningSince' | 'firedAt' | 'runAt'
  basisMs: number
  ageMs: number
}

/**
 * Only workflow-bound occurrences hold `activeExecutionId`, so only they can
 * wedge a workflow. A non-workflow scheduled task settling to 'failed' would be
 * a behaviour change (it has no backstop semantics today) — scope strictly.
 */
function isWorkflowOccurrence(task: ScheduledTask): boolean {
  return Boolean(task.workflowId && task.workflowExecutionId)
}

/**
 * The wall-clock a task's staleness is measured from. NEVER `updatedAt` (a benign
 * re-patch would reset the clock and the wedge would never age out).
 *   - 'running'  -> `runningSince` (stamped on the into-running transition),
 *                  falling back to `firedAt` for legacy tasks.
 *   - 'due'      -> `firedAt` (stamped when emitDueScheduledTasks marks it due),
 *                  falling back to `runAt`.
 *   - 'pending'  -> `runAt` (overdue pending: runAt already in the past).
 * Returns NaN when no usable basis exists (caller excludes it).
 */
export function stallBasisMs(task: ScheduledTask): {
  basis: StalledScheduledTask['basis']
  ms: number
} {
  const parse = (v?: string): number => (v ? Date.parse(v) : Number.NaN)
  if (task.status === 'running') {
    const since = parse(task.runningSince)
    if (Number.isFinite(since)) return { basis: 'runningSince', ms: since }
    const fired = parse(task.firedAt)
    if (Number.isFinite(fired)) return { basis: 'firedAt', ms: fired }
    return { basis: 'runningSince', ms: Number.NaN }
  }
  if (task.status === 'due') {
    const fired = parse(task.firedAt)
    if (Number.isFinite(fired)) return { basis: 'firedAt', ms: fired }
    const runAt = parse(task.runAt)
    return { basis: 'runAt', ms: runAt }
  }
  // pending (overdue)
  const runAt = parse(task.runAt)
  return { basis: 'runAt', ms: runAt }
}

/**
 * PURE wedge detector. Returns the occurrences that should be settled to
 * 'failed'. Does NOT write — the store seam applies the settle.
 *
 * Eligibility:
 *   1. Workflow-bound (`workflowId` + `workflowExecutionId`).
 *   2. Status is a non-terminal occupant of `activeExecutionId`: 'running' (held
 *      via syncWorkflow on into-running), 'due' (held at materialize time), or
 *      'pending' ONLY when overdue (runAt <= nowMs).
 *   3. Aged past `backstopMs` from its basis (NaN basis -> excluded; never settle
 *      a task we can't time).
 *   4. LIVENESS: a 'running' task with a live RunQueueJob is NEVER settled — that
 *      would false-fail a real multi-hour or approval-paused run into a permanent
 *      'failed' + spurious auto-disable, and its real terminal write would then be
 *      rejected by the transition guard. 'due'/'pending' tasks have no runId -> no
 *      live job -> eligible once aged.
 *
 * @param isRunLive (runId) => boolean. Injected for testability. True iff a
 *        run-queue job for that runId is still alive.
 */
export function findStalledScheduledTasks(
  tasks: readonly ScheduledTask[],
  isRunLive: (runId: string) => boolean,
  nowMs: number,
  backstopMs: number = DEFAULT_STALL_BACKSTOP_MS
): StalledScheduledTask[] {
  const out: StalledScheduledTask[] = []
  for (const task of tasks) {
    if (!isWorkflowOccurrence(task)) continue

    const status = task.status
    if (status !== 'running' && status !== 'due' && status !== 'pending') continue

    // Overdue gate for pending: a not-yet-fired pending is not a wedge.
    if (status === 'pending') {
      const runAtMs = Date.parse(task.runAt)
      if (!Number.isFinite(runAtMs) || runAtMs > nowMs) continue
    }

    const { basis, ms: basisMs } = stallBasisMs(task)
    if (!Number.isFinite(basisMs)) continue

    const ageMs = nowMs - basisMs
    if (ageMs < backstopMs) continue

    // Liveness cross-check (running only — these carry a runId).
    if (status === 'running' && task.runId && isRunLive(task.runId)) continue

    out.push({ task, basis, basisMs, ageMs })
  }
  return out
}

/**
 * Human-readable settle reason, persisted onto `lastError` + the durable run
 * event. Self-contained (no I/O); hours are rounded for legibility.
 */
export function stallReason(
  task: ScheduledTask,
  basis: StalledScheduledTask['basis'],
  ageMs: number,
  backstopMs: number = DEFAULT_STALL_BACKSTOP_MS
): string {
  const hours = (ms: number): string => {
    const h = ms / (60 * 60 * 1000)
    return h >= 1 ? `${Math.round(h * 10) / 10}h` : `${Math.round(ms / 60000)}m`
  }
  const what =
    task.status === 'running'
      ? 'started running'
      : task.status === 'due'
        ? 'became due'
        : 'was scheduled'
  return (
    `Scheduled workflow occurrence wedged: ${what} ${hours(ageMs)} ago ` +
    `(basis: ${basis}) with no live run and exceeded the ${hours(backstopMs)} ` +
    `stall backstop. Settled to failed to unblock future occurrences.`
  )
}
