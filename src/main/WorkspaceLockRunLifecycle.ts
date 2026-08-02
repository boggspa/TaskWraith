export interface WorkspaceLockRunLifecycleReleaseFailure {
  runId: string
  error: unknown
}

export interface WorkspaceLockRunLifecycleUnresolvedOperation {
  kind: 'unresolved-operation'
  runId: string
  operationId: string
  startedAt: number
  observedAt: number
}

export type WorkspaceLockRunLifecycleViolation =
  | {
      kind: 'operation-after-terminal'
      runId: string
    }
  | WorkspaceLockRunLifecycleUnresolvedOperation

export interface WorkspaceLockRunLifecycleDependencies {
  releaseRun: (runId: string) => Promise<void>
  onReleased?: (runId: string) => void
  onReleaseFailure: (failure: WorkspaceLockRunLifecycleReleaseFailure) => void
  onFailClosed: (violation: WorkspaceLockRunLifecycleViolation) => void
  unresolvedOperationTimeoutMs?: number
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}

export interface WorkspaceLockRunLifecycleOperation {
  readonly operationId: string
  finish(): void
}

export interface WorkspaceLockRunLifecycleSnapshot {
  runId: string
  terminalRequested: boolean
  releaseState: 'idle' | 'releasing' | 'released' | 'failed'
  operations: Array<{
    operationId: string
    startedAt: number
    unresolved: boolean
  }>
}

interface TrackedOperation {
  operationId: string
  startedAt: number
  unresolved: boolean
  timer?: unknown
}

interface TrackedRun {
  terminalRequested: boolean
  releaseState: 'idle' | 'releasing' | 'released' | 'failed'
  operations: Map<string, TrackedOperation>
}

const DEFAULT_SET_TIMER = (callback: () => void, delayMs: number): unknown => {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return timer
}

const DEFAULT_CLEAR_TIMER = (timer: unknown): void => {
  clearTimeout(timer as ReturnType<typeof setTimeout>)
}

/**
 * Coordinates workspace-lock release with executor-owned mutation lifetimes.
 *
 * Terminal notification never releases a run while an operation is active.
 * Operations that remain unresolved past the configured terminal-transition
 * deadline stay active and poison mutation admission through `onFailClosed`;
 * releasing an unproven mutation would be less safe than retaining its lease.
 */
export class WorkspaceLockRunLifecycleTracker {
  private readonly runs = new Map<string, TrackedRun>()
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private nextOperationId = 1

  constructor(private readonly deps: WorkspaceLockRunLifecycleDependencies) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? DEFAULT_SET_TIMER
    this.clearTimer = deps.clearTimer ?? DEFAULT_CLEAR_TIMER
    if (
      deps.unresolvedOperationTimeoutMs !== undefined &&
      (!Number.isFinite(deps.unresolvedOperationTimeoutMs) ||
        deps.unresolvedOperationTimeoutMs <= 0)
    ) {
      throw new Error('Workspace-lock unresolved-operation timeout must be positive.')
    }
  }

  begin(runId: string): WorkspaceLockRunLifecycleOperation {
    const normalizedRunId = requireRunId(runId)
    const run = this.runState(normalizedRunId)
    if (run.terminalRequested || run.releaseState !== 'idle') {
      this.deps.onFailClosed({
        kind: 'operation-after-terminal',
        runId: normalizedRunId
      })
      throw new Error(
        `Workspace-lock operation cannot begin after run ${normalizedRunId} became terminal.`
      )
    }

    const operationId = `${normalizedRunId}:${this.nextOperationId++}`
    const operation: TrackedOperation = {
      operationId,
      startedAt: this.now(),
      unresolved: false
    }
    run.operations.set(operationId, operation)

    let finished = false
    return {
      operationId,
      finish: () => {
        if (finished) return
        finished = true
        this.finish(normalizedRunId, operationId)
      }
    }
  }

  async run<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const tracked = this.begin(runId)
    try {
      return await operation()
    } finally {
      tracked.finish()
    }
  }

  terminal(runId: string): void {
    const normalizedRunId = requireRunId(runId)
    const run = this.runState(normalizedRunId)
    run.terminalRequested = true
    for (const operation of run.operations.values()) {
      this.armUnresolvedOperationTimer(normalizedRunId, operation)
    }
    this.maybeRelease(normalizedRunId, run)
  }

  snapshot(runId: string): WorkspaceLockRunLifecycleSnapshot | null {
    const normalizedRunId = requireRunId(runId)
    const run = this.runs.get(normalizedRunId)
    if (!run) return null
    return {
      runId: normalizedRunId,
      terminalRequested: run.terminalRequested,
      releaseState: run.releaseState,
      operations: [...run.operations.values()].map((operation) => ({
        operationId: operation.operationId,
        startedAt: operation.startedAt,
        unresolved: operation.unresolved
      }))
    }
  }

  /**
   * Reconciles local operation bookkeeping after the durable authority has
   * already released every acquisition for this run through the explicit
   * human-recovery path. The caller owns that proof; this method never releases
   * authority itself.
   */
  reconcileExternallyReleasedRun(runId: string): void {
    const normalizedRunId = requireRunId(runId)
    const run = this.runs.get(normalizedRunId)
    if (!run || run.releaseState === 'released') return
    for (const operation of run.operations.values()) {
      if (operation.timer !== undefined) this.clearTimer(operation.timer)
    }
    run.operations.clear()
    run.terminalRequested = true
    run.releaseState = 'released'
    this.deps.onReleased?.(normalizedRunId)
  }

  private runState(runId: string): TrackedRun {
    const existing = this.runs.get(runId)
    if (existing) return existing
    const created: TrackedRun = {
      terminalRequested: false,
      releaseState: 'idle',
      operations: new Map()
    }
    this.runs.set(runId, created)
    return created
  }

  private finish(runId: string, operationId: string): void {
    const run = this.runs.get(runId)
    const operation = run?.operations.get(operationId)
    if (!run || !operation) return
    if (operation.timer !== undefined) this.clearTimer(operation.timer)
    run.operations.delete(operationId)
    this.maybeRelease(runId, run)
  }

  private markOperationUnresolved(runId: string, operationId: string): void {
    const run = this.runs.get(runId)
    const operation = run?.operations.get(operationId)
    if (!operation || operation.unresolved) return
    operation.unresolved = true
    const observedAt = this.now()
    this.deps.onFailClosed({
      kind: 'unresolved-operation',
      runId,
      operationId,
      startedAt: operation.startedAt,
      observedAt
    })
  }

  private armUnresolvedOperationTimer(runId: string, operation: TrackedOperation): void {
    const timeoutMs = this.deps.unresolvedOperationTimeoutMs
    if (timeoutMs === undefined || operation.timer !== undefined) return
    operation.timer = this.setTimer(
      () => this.markOperationUnresolved(runId, operation.operationId),
      timeoutMs
    )
  }

  private maybeRelease(runId: string, run: TrackedRun): void {
    if (!run.terminalRequested || run.operations.size > 0 || run.releaseState !== 'idle') {
      return
    }
    run.releaseState = 'releasing'
    void Promise.resolve()
      .then(() => this.deps.releaseRun(runId))
      .then(() => {
        run.releaseState = 'released'
        this.deps.onReleased?.(runId)
      })
      .catch((error) => {
        run.releaseState = 'failed'
        this.deps.onReleaseFailure({ runId, error })
      })
  }
}

function requireRunId(runId: string): string {
  const normalized = runId.trim()
  if (!normalized) throw new Error('Workspace-lock lifecycle requires an exact run id.')
  return normalized
}
