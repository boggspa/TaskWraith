import { isExecutionRunTerminal, type ExecutionRunProjection } from './ExecutionGraphRun'
import type { ExecutionGraphServiceDiagnostic } from '../ipc/executionGraphHandlers'
import type {
  ExecutionGraphCoordinator,
  ExecutionGraphRecoveryDiagnostic
} from '../services/ExecutionGraphCoordinator'

/** The coordinator surface recovery needs; narrowed so tests can hand in a fake. */
export type ExecutionGraphRecoveryCoordinator = Pick<
  ExecutionGraphCoordinator,
  'recover' | 'recoverExecutions' | 'archiveExecution' | 'listExecutions' | 'getExecution'
>

export interface ExecutionGraphRecoveryControllerDeps {
  /** Null while graph initialization failed or has not run for this process. */
  coordinator: () => ExecutionGraphRecoveryCoordinator | null
  /**
   * The paused-at-startup diagnostics live in the composition root's snapshot
   * state; the controller reads and rewrites them through these two seams so
   * the IPC snapshot keeps one source of truth.
   */
  readDiagnostics: () => readonly ExecutionGraphRecoveryDiagnostic[]
  writeDiagnostics: (next: readonly ExecutionGraphRecoveryDiagnostic[]) => void
  /**
   * The snapshot's service list, for a startup pass that keeps failing as a
   * whole. One stack refusing is a paused diagnostic, never a throw; a throw
   * means the pass itself failed (its listing, or recovery), and it happens
   * later, from the starter's timer, past the launch sequence's own try/catch.
   * The controller adds and withdraws only its `startup_recovery_failed`.
   */
  readServiceDiagnostics: () => readonly ExecutionGraphServiceDiagnostic[]
  writeServiceDiagnostics: (next: readonly ExecutionGraphServiceDiagnostic[]) => void
  /** Injected for tests; defaults to `setTimeout` with the timer unref'd. */
  schedule?: (callback: () => void, delayMs: number) => void
  automaticRetryDelayMs?: number
  log?: (message: string) => void
}

export interface ExecutionGraphRecoveryRetryInput {
  /** One paused execution; omit to retry every execution paused at startup. */
  readonly executionId?: string
}

/**
 * A recovery write refused at launch is a tolerated race (the ledger file
 * stamp moved between verify and append), so one bounded retry shortly after
 * startup resolves the ordinary case without the user noticing. Anything still
 * paused after that is a real condition and stays reported until the user
 * retries or archives it.
 */
export const EXECUTION_GRAPH_RECOVERY_AUTOMATIC_RETRY_DELAY_MS = 2_000

function defaultSchedule(callback: () => void, delayMs: number): void {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
}

/**
 * Owns what happens to a stack whose startup recovery was refused.
 *
 * Until this existed the coordinator reported the refusal once, at launch,
 * and nothing in the session ever looked again: the same stacks re-raised the
 * root notice at every launch with no retry and no way out. The controller
 * keeps recovery on the coordinator's own verify-then-append path (it never
 * writes a ledger itself), retries exactly once automatically, and offers the
 * user-driven retry and archive that the renderer's notices dispatch.
 */
export class ExecutionGraphRecoveryController {
  private automaticRetryArmed = false
  /** The whole launch pass has run; every later startup pass covers only the paused set. */
  private launchPassCompleted = false
  private consecutivePassFailures = 0
  private startupFailureReported = false
  private readonly schedule: (callback: () => void, delayMs: number) => void
  private readonly automaticRetryDelayMs: number
  private readonly log: (message: string) => void

  constructor(private readonly deps: ExecutionGraphRecoveryControllerDeps) {
    this.schedule = deps.schedule ?? defaultSchedule
    this.automaticRetryDelayMs =
      deps.automaticRetryDelayMs ?? EXECUTION_GRAPH_RECOVERY_AUTOMATIC_RETRY_DELAY_MS
    this.log = deps.log ?? ((message) => console.error(message))
  }

  /**
   * The owners a startup pass must preload before it runs: every live stack's
   * owner for the launch pass, then only the paused stacks' owners, because a
   * later pass recovers nothing else. A listing that throws fails the pass; the
   * starter hands it to `startupPassFailed` like any other.
   */
  startupOwnerIds(): readonly string[] {
    const coordinator = this.deps.coordinator()
    if (!coordinator) return []
    const executions = this.launchPassCompleted
      ? this.deps.readDiagnostics().flatMap((diagnostic) => {
          const execution = coordinator.getExecution(diagnostic.executionId)
          return execution ? [execution] : []
        })
      : coordinator.listExecutions({ includeTerminal: false })
    return [
      ...new Set(
        executions.flatMap((execution) => (execution.owner ? [execution.owner.threadId] : []))
      )
    ]
  }

  /**
   * One startup pass. The first is the launch pass over every stack: it
   * records each refusal and arms ONE automatic retry for the paused set.
   *
   * Every later pass (the starter re-runs for owners that failed to preload,
   * and a deferred workspace-lock replay starts another starter) covers only
   * the stacks still paused, as `retry()` does. Recovery re-evaluates a stack
   * as if the process had just restarted, so a pass over a stack that has been
   * recovered and dispatched since would park it while its provider run went
   * on. A throw propagates: the starter re-runs the pass on its backoff and
   * reports it through `startupPassFailed`, and the paused set stays as the
   * last good pass left it.
   */
  runStartupRecovery(): readonly ExecutionGraphRecoveryDiagnostic[] {
    const coordinator = this.deps.coordinator()
    if (!coordinator) {
      this.deps.writeDiagnostics([])
      return []
    }
    if (this.launchPassCompleted) {
      const next = this.retry()
      this.startupPassSucceeded()
      return next
    }
    const diagnostics = coordinator.recover()
    this.launchPassCompleted = true
    this.startupPassSucceeded()
    this.deps.writeDiagnostics(diagnostics)
    for (const diagnostic of diagnostics) {
      this.log(
        `[ExecutionGraph] startup recovery failed for executionId=${diagnostic.executionId}: ${diagnostic.message}`
      )
    }
    if (diagnostics.length > 0 && !this.automaticRetryArmed) {
      this.automaticRetryArmed = true
      this.schedule(() => {
        try {
          this.retry()
        } catch (error) {
          this.log(
            `[ExecutionGraph] automatic recovery retry failed: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }, this.automaticRetryDelayMs)
    }
    return diagnostics
  }

  /**
   * A startup pass threw: its owner listing, or recovery itself. Logged every
   * time. Reported on the service list once it has survived a re-run (a
   * listing that fails between the owner preload and recovery is a race the
   * next pass absorbs) or when no further pass will run, and only once until a
   * later pass succeeds and withdraws it.
   */
  startupPassFailed(error: unknown, retrying: boolean): void {
    const message = String(error instanceof Error ? error.message : error).slice(0, 2_048)
    this.consecutivePassFailures += 1
    this.log(
      `[ExecutionGraph] startup recovery pass failed${retrying ? ' and will run again' : ''}: ${message}`
    )
    if (this.startupFailureReported || (retrying && this.consecutivePassFailures < 2)) return
    this.startupFailureReported = true
    this.deps.writeServiceDiagnostics([
      ...this.deps
        .readServiceDiagnostics()
        .filter((diagnostic) => diagnostic.code !== 'startup_recovery_failed'),
      { code: 'startup_recovery_failed', message }
    ])
  }

  /** A pass got through: startup recovery has run, so a standing failure report is withdrawn. */
  private startupPassSucceeded(): void {
    this.consecutivePassFailures = 0
    const service = this.deps.readServiceDiagnostics()
    const remaining = service.filter((diagnostic) => diagnostic.code !== 'startup_recovery_failed')
    this.startupFailureReported = false
    if (remaining.length !== service.length) this.deps.writeServiceDiagnostics(remaining)
  }

  /**
   * Re-run recovery for one paused execution, or every paused one, and replace
   * their diagnostics with the fresh outcome. Only executions the launch pass
   * reported may be retried: recovery re-evaluates a graph as if the process
   * had just restarted, which is wrong for a graph that has been live since.
   */
  retry(input: ExecutionGraphRecoveryRetryInput = {}): readonly ExecutionGraphRecoveryDiagnostic[] {
    const coordinator = this.deps.coordinator()
    if (!coordinator) throw new Error('Durable Stack recovery is unavailable in this session.')
    const paused = this.deps.readDiagnostics()
    const executionIds = input.executionId
      ? [input.executionId]
      : [...new Set(paused.map((diagnostic) => diagnostic.executionId))]
    if (
      input.executionId &&
      !paused.some((diagnostic) => diagnostic.executionId === input.executionId)
    ) {
      throw new Error(`Execution "${input.executionId}" is not paused in startup recovery.`)
    }
    if (executionIds.length === 0) return paused
    const retried = coordinator.recoverExecutions(executionIds)
    // Merge in place: a stack that is still paused keeps its position, so the
    // renderer's notice order (and the card the user is looking at) holds
    // still across a retry; a resolved stack simply drops out.
    const retriedById = new Map(retried.map((diagnostic) => [diagnostic.executionId, diagnostic]))
    const merged = new Set<string>()
    const next = Object.freeze(
      paused.flatMap((diagnostic) => {
        if (!executionIds.includes(diagnostic.executionId)) return [diagnostic]
        if (merged.has(diagnostic.executionId)) return []
        merged.add(diagnostic.executionId)
        const fresh = retriedById.get(diagnostic.executionId)
        return fresh ? [fresh] : []
      })
    )
    this.deps.writeDiagnostics(next)
    for (const diagnostic of retried) {
      this.log(
        `[ExecutionGraph] recovery retry still paused for executionId=${diagnostic.executionId}: ${diagnostic.message}`
      )
    }
    return next
  }

  /** Terminalize the execution through the coordinator and drop its paused diagnostic. */
  async archive(executionId: string, reason?: string): Promise<ExecutionRunProjection> {
    const coordinator = this.deps.coordinator()
    if (!coordinator) throw new Error('Durable Stack recovery is unavailable in this session.')
    const projection = await coordinator.archiveExecution(executionId, reason)
    if (isExecutionRunTerminal(projection.state)) {
      this.deps.writeDiagnostics(
        this.deps.readDiagnostics().filter((diagnostic) => diagnostic.executionId !== executionId)
      )
    }
    return projection
  }
}
