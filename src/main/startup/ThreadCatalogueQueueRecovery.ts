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

/** Queue recovery is independent of whether a chat has any unsettled runs. */
export class ThreadCatalogueQueueRecovery {
  private running: Promise<void> | null = null
  constructor(
    private readonly deps: {
      mirror: ThreadCatalogueMirror
      jobs(): readonly OrphanedRunQueueJobLike[]
      isRunLive(runId: string): boolean
      isErasing(chatId: string, workspaceId?: string): boolean
      settle(settlement: OrphanedRunQueueJobSettlement): void
    }
  ) {}

  reconcile(): void {
    if (this.running) return
    this.running = this.run().finally(() => {
      this.running = null
    })
  }

  private async run(): Promise<void> {
    const port = this.deps.mirror.port
    for (const candidate of this.deps.jobs()) {
      let opened: ThreadCatalogueOpenResult | null = null
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
        for (const settlement of reconcileOrphanedRunQueueJobs(
          [job],
          new Map([[run.runId, run.status]]),
          { isRunLive: this.deps.isRunLive }
        ))
          this.deps.settle(settlement)
      } catch {
        // Incomplete or changing metadata is not terminal evidence. A later
        // migration delta or the ordinary recovery tick retries this job.
      } finally {
        if (opened)
          await port.query({ method: 'release', leaseId: opened.leaseId }).catch(() => undefined)
      }
    }
  }
}
