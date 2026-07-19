import type {
  HistoryDeletionPreparation,
  HistoryDeletionPrepareInput
} from './store'

export interface HistoryDeletionTransactionCoordinatorDeps<THolds> {
  prepare: (input: HistoryDeletionPrepareInput) => HistoryDeletionPreparation
  /** Reacquire every process-local fence synchronously, including receipted sinks. */
  acquireHolds: (preparation: HistoryDeletionPreparation) => THolds
  /** Recreate only strict attempts that rejected; retain successful/pending
   * admission holds and generation fences across an in-process retry. */
  refreshHolds?: (preparation: HistoryDeletionPreparation, holds: THolds) => THolds
  quiesce: (preparation: HistoryDeletionPreparation, holds: THolds) => Promise<void>
  commit: (operationId: string) => void
  releaseHolds: (preparation: HistoryDeletionPreparation, holds: THolds) => void
}

interface RetainedOperation<THolds> {
  preparation: HistoryDeletionPreparation
  holds: THolds
}

/**
 * Main-process single-flight for global/workspace history deletion.
 *
 * Durable prepare happens before any external teardown. A same-operation
 * caller joins the exact promise; a different pending scope is rejected by the
 * store's prepare step before `acquireHolds` can produce side effects. Failed
 * attempts retain their live process fences and can resume from durable sink
 * receipts. Startup recovery enters through `resume` and reacquires every hold
 * before inspecting which external targets remain.
 */
export class HistoryDeletionTransactionCoordinator<THolds> {
  private readonly inFlightByOperation = new Map<string, Promise<void>>()
  private readonly retainedByOperation = new Map<string, RetainedOperation<THolds>>()

  constructor(private readonly deps: HistoryDeletionTransactionCoordinatorDeps<THolds>) {}

  run(input: HistoryDeletionPrepareInput): Promise<void> {
    // This synchronous fsynced prepare also rejects an overlapping scope before
    // any external hold/teardown callback runs.
    return this.resume(this.deps.prepare(input))
  }

  resume(preparation: HistoryDeletionPreparation): Promise<void> {
    const joined = this.inFlightByOperation.get(preparation.operationId)
    if (joined) return joined

    let retained = this.retainedByOperation.get(preparation.operationId)
    if (!retained) {
      // acquireHolds must not await. It raises every in-memory generation and
      // admission fence even when all corresponding durable receipts exist.
      retained = {
        preparation,
        holds: this.deps.acquireHolds(preparation)
      }
      this.retainedByOperation.set(preparation.operationId, retained)
    } else {
      retained.preparation = preparation
      retained.holds = this.deps.refreshHolds?.(preparation, retained.holds) ?? retained.holds
    }

    const operation = this.execute(retained)
    this.inFlightByOperation.set(preparation.operationId, operation)
    void operation
      .finally(() => {
        if (this.inFlightByOperation.get(preparation.operationId) === operation) {
          this.inFlightByOperation.delete(preparation.operationId)
        }
      })
      .catch(() => {})
    return operation
  }

  private async execute(retained: RetainedOperation<THolds>): Promise<void> {
    const { preparation, holds } = retained
    await this.deps.quiesce(preparation, holds)
    this.deps.commit(preparation.operationId)
    this.retainedByOperation.delete(preparation.operationId)
    this.deps.releaseHolds(preparation, holds)
  }
}
