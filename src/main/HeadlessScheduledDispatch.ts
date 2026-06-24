// Stage 0b-dispatch — the PURE decision brain for windowless scheduled-run
// dispatch. When a scheduled task comes due, the renderer normally receives a
// 'scheduled-task-due' broadcast and dispatches it (composeRun -> runAgent). If
// the app is running WINDOWLESS (window closed, process alive — the common macOS
// "close the window, keep running" state), that broadcast no-ops and the run
// never starts until a window reopens. This module decides, for one due task,
// whether MAIN should dispatch it itself, broadcast to a live renderer, or leave
// it 'due' to retry. The effects (broadcast / dispatchDueScheduledTaskHeadless /
// leave 'due') live in index.ts; this stays pure so it unit-tests under plain
// vitest — mirroring WorkflowBudgetGuard / BossmanAutoApproval.
//
// 'defer' is SAFE because AppStore.getDueScheduledTasks re-returns every task
// whose status is 'due' on EVERY scheduler tick — so a deferred task is retried
// until a renderer opens (re-broadcast) or the composer becomes ready.

import type { ScheduledTask } from './store/types'

export interface HeadlessDispatchContext {
  /** A live renderer (mainWindow with a non-destroyed webContents) can receive
   * the 'scheduled-task-due' broadcast and run the verified renderer path. */
  rendererAvailable: boolean
  /** The kill-switch: settings.headlessScheduledDispatchEnabled !== false.
   * Default ON; lets a user revert to renderer-only dispatch. */
  headlessEnabled: boolean
  /** The main-side composer + dispatch refs are wired (whenReady has run). Before
   * that, main cannot compose a run, so defer (retried once ready). */
  composerReady: boolean
}

export type ScheduledDispatchRoute = 'broadcast' | 'headless' | 'defer'

/**
 * Decide how a DUE scheduled task should be dispatched.
 *  - 'broadcast': a renderer is up → send 'scheduled-task-due' (renderer
 *    dispatches; the existing, verified path — unchanged behaviour).
 *  - 'headless': no renderer, headless enabled, composer wired, and a SOLO task
 *    → main composes + dispatches it directly.
 *  - 'defer': no renderer AND (headless disabled | composer not ready | an
 *    ENSEMBLE occurrence) → leave it 'due' to retry next tick. Ensemble
 *    occurrences dispatch through runEnsembleRound (the orchestrator), a path not
 *    yet bridged headless, so they wait for a window.
 *
 * rendererAvailable takes precedence over everything: whenever a renderer can do
 * the work, it does (headless dispatch only ever fills the no-renderer gap).
 */
export function routeDueScheduledTask(
  task: Pick<ScheduledTask, 'kind'>,
  ctx: HeadlessDispatchContext
): ScheduledDispatchRoute {
  if (ctx.rendererAvailable) return 'broadcast'
  if (!ctx.headlessEnabled) return 'defer'
  if (!ctx.composerReady) return 'defer'
  if (task.kind === 'ensemble') return 'defer'
  return 'headless'
}
