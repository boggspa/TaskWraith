import { isExecutionRunTerminal, type ExecutionRunProjection } from './ExecutionGraphRun'
import type { ExecutionGraphServiceDiagnostic } from '../ipc/executionGraphHandlers'
import type {
  ExecutionGraphCoordinator,
  ExecutionGraphRecoveryDiagnostic
} from '../services/ExecutionGraphCoordinator'

/** The coordinator surface recovery needs; narrowed so tests can hand in a fake. */
export type ExecutionGraphRecoveryCoordinator = Pick<
  ExecutionGraphCoordinator,
  'recover' | 'recoverExecutions' | 'archiveExecution'
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
   * The snapshot's service channel, for a launch pass that fails as a whole.
   * One stack refusing is a paused diagnostic, never a throw; a throw means the
   * pass itself failed, and it runs later from a timer, past the launch
   * sequence's own try/catch, so it is reported here or nowhere.
   */
  reportServiceDiagnostic: (diagnostic: ExecutionGraphServiceDiagnostic) => void
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
   * The launch pass. Records every refusal, then arms ONE automatic retry for
   * the paused set; a second launch pass in the same process (a deferred
   * workspace-lock replay) records again but never arms another.
   *
   * A pass that throws as a whole is reported on the service channel once per
   * process (a replay that fails again adds nothing new) and is not rethrown:
   * the owner-metadata starter that calls this would file it as a deferred
   * owner lookup and silently retry it every 2 s. The paused set stays as the
   * last good pass recorded it, since this pass recovered nothing.
   */
  runStartupRecovery(): readonly ExecutionGraphRecoveryDiagnostic[] {
    const coordinator = this.deps.coordinator()
    let diagnostics: readonly ExecutionGraphRecoveryDiagnostic[]
    try {
      diagnostics = coordinator ? coordinator.recover() : []
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 2_048)
      this.log(`[ExecutionGraph] startup recovery failed: ${message}`)
      if (!this.startupFailureReported) {
        this.startupFailureReported = true
        this.deps.reportServiceDiagnostic({ code: 'startup_recovery_failed', message })
      }
      return this.deps.readDiagnostics()
    }
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
