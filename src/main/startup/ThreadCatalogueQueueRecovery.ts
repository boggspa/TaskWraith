import {
  reconcileOrphanedRunQueueJobs,
  type OrphanedRunQueueJobLike,
  type OrphanedRunQueueJobSettlement
} from '../ChatRunReconciler'
import type { ThreadCatalogueMirror } from '../store/ThreadCatalogueMirror'
import type {
  ThreadCatalogueOpenResult,
  ThreadIndexedObject
} from '../../shared/threadCatalogueTypes'

class QueueRecoveryCleanupError extends Error {
  constructor(readonly failure: unknown) {
    super(failure instanceof Error ? failure.message : 'Catalogue lease cleanup failed')
  }
}

/** Queue recovery is independent of whether a chat has any unsettled runs. */
export class ThreadCatalogueQueueRecovery {
  private running: Promise<void> | null = null
  private shuttingDown = false
  private passDebt: unknown = null
  private readonly cleanupDebt = new Set<string>()
  private readonly settlementDebt = new Map<string, unknown>()
  constructor(
    private readonly deps: {
      mirror: ThreadCatalogueMirror
      jobs(): readonly OrphanedRunQueueJobLike[]
      isRunLive(runId: string): boolean
      isErasing(chatId: string, workspaceId?: string): boolean
      settle(settlement: OrphanedRunQueueJobSettlement): void
    }
  ) {}

  /** Refuse new passes; an admitted pass retains its settlement authority. */
  beginShutdown(): void {
    this.shuttingDown = true
  }

  /** Fence immediately and join the admitted pass, including lease cleanup. */
  async quiesce(): Promise<void> {
    this.beginShutdown()
    let joinedFailure: unknown = null
    if (this.running) {
      try {
        await this.running
      } catch (error) {
        joinedFailure = error
      }
    }
    const cleanupFailures: unknown[] = []
    for (const leaseId of [...this.cleanupDebt]) {
      try {
        await this.deps.mirror.port.query({ method: 'release', leaseId })
        this.cleanupDebt.delete(leaseId)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (joinedFailure !== null) throw joinedFailure
    if (cleanupFailures.length > 0) throw cleanupFailures[0]
    if (this.passDebt !== null) {
      await this.startPass()
    }
  }

  reconcile(): void {
    if (this.shuttingDown || this.running) return
    void this.startPass().catch(() => undefined)
  }

  private startPass(): Promise<void> {
    this.running = this.run()
      .then(
        () => {
          this.passDebt = null
        },
        (error: unknown) => {
          if (!(error instanceof QueueRecoveryCleanupError)) this.passDebt = error
          throw error
        }
      )
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  private async run(): Promise<void> {
    const port = this.deps.mirror.port
    let cleanupFailure: unknown = null
    for (const candidate of this.deps.jobs()) {
      let opened: ThreadCatalogueOpenResult | null = null
      let settling = false
      try {
        if (this.deps.isRunLive(candidate.runId)) continue
        const chatId =
          candidate.chatId ??
          (await port.query<{ chatId: string } | null>({ method: 'run', runId: candidate.runId }))
            ?.chatId
        if (
          !chatId ||
          this.deps.isErasing(chatId, this.deps.mirror.get(chatId)?.summary.workspaceId)
        )
          continue
        opened = await port.query({ method: 'open', chatId, mode: 'runs' })
        if (!opened || opened.entry.snapshot || opened.entry.projection.sourceComplete === false)
          continue
        const ordinal = await port.query<number | null>({
          method: 'ordinal',
          leaseId: opened.leaseId,
          kind: 'run-summary',
          recordId: candidate.runId
        })
        if (ordinal === null) continue
        const values = await port.query<ThreadIndexedObject[] | null>({
          method: 'objects',
          leaseId: opened.leaseId,
          kind: 'run-summary',
          before: ordinal + 1,
          ...(ordinal ? { after: ordinal - 1 } : {}),
          maxObjects: 1,
          maxBytes: 16 * 1024
        })
        const value = values?.[0]
        if (value?.kind !== 'inline') continue
        const run = value.value as { runId?: string; status?: string }
        if (run.runId !== candidate.runId || !run.status) continue
        const current = await port.query<{ sourceWitness: string } | null>({
          method: 'summary',
          chatId
        })
        if (
          current?.sourceWitness !== opened.entry.sourceWitness ||
          this.deps.isErasing(chatId, opened.entry.projection.summary.workspaceId)
        )
          continue
        const job = this.deps.jobs().find((entry) => entry.runId === candidate.runId)
        if (!job) continue
        settling = true
        for (const settlement of reconcileOrphanedRunQueueJobs(
          [job],
          new Map([[run.runId, run.status]]),
          { isRunLive: this.deps.isRunLive }
        )) {
          this.deps.settle(settlement)
          this.settlementDebt.delete(candidate.runId)
        }
      } catch (error) {
        if (settling) {
          this.settlementDebt.set(candidate.runId, error)
          this.passDebt = error
          throw error
        }
        // Incomplete or changing metadata is not terminal evidence. A later
        // migration delta or the ordinary recovery tick retries this job.
      } finally {
        if (opened) {
          this.cleanupDebt.add(opened.leaseId)
          try {
            await port.query({ method: 'release', leaseId: opened.leaseId })
            this.cleanupDebt.delete(opened.leaseId)
          } catch (error) {
            // Finish other admitted candidates; only failed leases need retry.
            cleanupFailure = error
          }
        }
      }
    }
    if (this.settlementDebt.size > 0) throw this.settlementDebt.values().next().value
    if (cleanupFailure !== null) throw new QueueRecoveryCleanupError(cleanupFailure)
  }
}
