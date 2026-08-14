import type {
  WorkspaceLockRunLifecycleSnapshot,
  WorkspaceLockRunLifecycleTracker,
  WorkspaceLockRunLifecycleViolation
} from './WorkspaceLockRunLifecycle'
import type {
  WorkspaceLockRuntime,
  WorkspaceLockUnresolvedRunReconciliationResult
} from './WorkspaceLockRuntime'
import type {
  HostCommandOperationCancellation,
  HostCommandOperationRegistry
} from './run/HostCommandOperationRegistry'

interface TerminalCancellation {
  completion: Promise<void>
  operationIds: readonly string[]
  processTreeStopped: Promise<boolean>
  settled: boolean
}

export interface WorkspaceLockTerminalReconcilerDependencies {
  lifecycle: Pick<
    WorkspaceLockRunLifecycleTracker,
    'terminal' | 'snapshot' | 'reconcileUnresolvedOperation'
  >
  hostCommands: Pick<HostCommandOperationRegistry, 'beginRunCancellation' | 'hasRun'>
  getRuntime: () => Pick<WorkspaceLockRuntime, 'reconcileUnresolvedRunOperation'> | null | undefined
  getBlockedReason: () => string | null
  clearBlockedReason: (expectedReason: string) => boolean
  logError?: (message: string, error: unknown) => void
}

/**
 * Couples run terminalization to host-command cancellation and owns the one
 * restartless recovery path for a watchdog poison. Recovery requires all three
 * independent facts: the exact command tree joined, the exact lifecycle
 * operation is the one that timed out, and durable authority reports no lease
 * for that run.
 */
export class WorkspaceLockTerminalReconciler {
  private readonly cancellations = new Map<string, TerminalCancellation>()
  private readonly recoveries = new Set<string>()

  constructor(private readonly deps: WorkspaceLockTerminalReconcilerDependencies) {}

  terminal(runId: string): void {
    const normalizedRunId = requireRunId(runId)
    this.ensureCancellation(normalizedRunId)
    this.deps.lifecycle.terminal(normalizedRunId)
  }

  handleViolation(violation: WorkspaceLockRunLifecycleViolation, blockedReason: string): void {
    if (violation.kind !== 'unresolved-operation') return
    const normalizedReason = blockedReason.trim()
    if (!normalizedReason || this.deps.getBlockedReason() !== normalizedReason) return
    const recoveryKey = `${violation.runId}\u0000${violation.operationId}\u0000${normalizedReason}`
    if (this.recoveries.has(recoveryKey)) return
    this.recoveries.add(recoveryKey)
    const cancellation = this.ensureCancellation(violation.runId)
    void this.recover(violation, normalizedReason, cancellation)
      .catch((error) =>
        this.deps.logError?.('Workspace-lock terminal reconciliation failed.', error)
      )
      .finally(() => {
        this.recoveries.delete(recoveryKey)
        if (cancellation.settled) this.cancellations.delete(violation.runId)
      })
  }

  private ensureCancellation(runId: string): TerminalCancellation {
    const existing = this.cancellations.get(runId)
    if (existing) return existing
    let cancellation: HostCommandOperationCancellation
    try {
      cancellation = this.deps.hostCommands.beginRunCancellation(runId, 'run-terminal')
    } catch (error) {
      this.deps.logError?.(`Host-command cancellation could not start for run ${runId}.`, error)
      const retained: TerminalCancellation = {
        completion: new Promise<void>(() => undefined),
        operationIds: [],
        processTreeStopped: Promise.resolve(false),
        settled: false
      }
      this.cancellations.set(runId, retained)
      return retained
    }
    const tracked: TerminalCancellation = {
      completion: cancellation.completion,
      operationIds: cancellation.operationIds,
      processTreeStopped: cancellation.processTreeStopped,
      settled: false
    }
    this.cancellations.set(runId, tracked)
    void tracked.completion.then(() => {
      tracked.settled = true
      if (![...this.recoveries].some((key) => key.startsWith(`${runId}\u0000`))) {
        this.cancellations.delete(runId)
      }
    })
    return tracked
  }

  private async recover(
    violation: Extract<WorkspaceLockRunLifecycleViolation, { kind: 'unresolved-operation' }>,
    blockedReason: string,
    cancellation: TerminalCancellation
  ): Promise<void> {
    await cancellation.completion
    // A run without a selected command has no command-tree death proof. It may
    // be a provider/setup/review lifecycle operation, so retain the wall.
    if (cancellation.operationIds.length === 0) return
    if (!(await cancellation.processTreeStopped)) return
    if (this.deps.hostCommands.hasRun(violation.runId)) return
    if (this.deps.getBlockedReason() !== blockedReason) return
    const runtime = this.deps.getRuntime()
    if (!runtime) return
    const snapshot = this.deps.lifecycle.snapshot(violation.runId)
    if (!operationCanBeReconciled(snapshot, violation.operationId)) return
    const result: WorkspaceLockUnresolvedRunReconciliationResult =
      runtime.reconcileUnresolvedRunOperation({
        runId: violation.runId,
        expectedUnhealthyReason: blockedReason,
        processTreeStopped: true
      })
    if (!result.ok) return
    if (
      snapshot?.operations.some((operation) => operation.operationId === violation.operationId) &&
      !this.deps.lifecycle.reconcileUnresolvedOperation(violation.runId, violation.operationId)
    ) {
      return
    }
    this.deps.clearBlockedReason(blockedReason)
  }
}

function operationCanBeReconciled(
  snapshot: WorkspaceLockRunLifecycleSnapshot | null,
  operationId: string
): boolean {
  if (!snapshot) return false
  const operation = snapshot.operations.find((candidate) => candidate.operationId === operationId)
  if (operation) {
    return snapshot.terminalRequested && operation.unresolved && snapshot.operations.length === 1
  }
  return snapshot.terminalRequested && snapshot.releaseState === 'released'
}

function requireRunId(runId: string): string {
  const normalized = runId.trim()
  if (!normalized) throw new Error('Workspace-lock terminal reconciliation requires a run id.')
  return normalized
}
