/**
 * The two halves of catalogue erasure.
 *
 * `begin` runs straight after the durable deletion intent and before any source
 * is removed. It raises the catalogue fence and then joins everything that could
 * write the chat again: the mirror, recovery claims, source publications, the
 * ownership activation, queued save intents, log followers and receipt
 * evidence. It reports the fences it holds so the deletion can record them.
 *
 * `finish` lifts those fences. The deletion calls it only from its success
 * epilogue, after residual verification and before the intent is removed, so a
 * failed or interrupted deletion keeps the fence and a restart resumes it under
 * the recorded generation instead of minting another.
 */
import type { CatalogueErasureFence, HistoryDeletionPreparation } from '../store'
import type { ThreadCatalogueMaintenanceQuery } from '../../shared/threadCatalogueProtocol'

/** Ownership-side joins. All optional: ownership activation is not always composed. */
export interface CatalogueErasureJoins {
  readonly coordinator?: { deactivate(chatId: string): Promise<void> }
  readonly followers?: { forget(chatId: string): void; close(): void }
  readonly receiptStore?: { forgetChat(chatId: string): Promise<void>; forgetAll(): Promise<void> }
}

export interface CatalogueErasureDeps {
  maintain<T>(query: ThreadCatalogueMaintenanceQuery): Promise<T>
  drainPublications(chatIds?: readonly string[]): Promise<void>
  readonly mirror: { forget(chatId: string): void; forgetAll(): void }
  /** Resolved at call time: recovery and the publisher are created after the install. */
  recovery(): { forgetErased(chatId?: string): void } | null | undefined
  publisher(): { forgetErased(chatId?: string): void } | null | undefined
  readonly saveIntents: { forget(chatId: string): boolean; forgetAll(): void }
  readonly joins?: CatalogueErasureJoins
}

export function createCatalogueErasureCallbacks(deps: CatalogueErasureDeps): {
  begin(
    preparation: HistoryDeletionPreparation,
    recorded: readonly CatalogueErasureFence[]
  ): Promise<CatalogueErasureFence[]>
  finish(
    preparation: HistoryDeletionPreparation,
    fences: readonly CatalogueErasureFence[]
  ): Promise<void>
} {
  const scopeOf = (chatId: string | undefined) => (chatId ? { chatId } : {})

  return {
    async begin(preparation, recorded) {
      const global = preparation.kind === 'global'
      const scopes: Array<string | undefined> = global ? [undefined] : preparation.chatIds
      await deps.drainPublications(global ? undefined : preparation.chatIds)

      const fences: CatalogueErasureFence[] = []
      for (const chatId of scopes) {
        // A recorded fence means an earlier run already began this erasure:
        // keep its generation and purge again rather than start a second one.
        const prior = recorded.find((fence) => fence.chatId === chatId)
        const generation = prior
          ? await deps.maintain<string>({
              method: 'reestablish-erasure',
              generation: prior.generation,
              ...scopeOf(chatId)
            })
          : await deps.maintain<string>({ method: 'erase', ...scopeOf(chatId) })
        fences.push(chatId ? { chatId, generation } : { generation })
        if (chatId) deps.mirror.forget(chatId)
        else deps.mirror.forgetAll()
        // Both throw while source writes are still live, which fails the step
        // and keeps the fence: the writers were drained before the fence rose.
        deps.recovery()?.forgetErased(chatId)
        deps.publisher()?.forgetErased(chatId)
      }

      // Ownership joins. Each runs even if an earlier one failed, so one stuck
      // chat does not leave the rest able to append; the failures surface together.
      const failures: unknown[] = []
      const attempt = async (work: () => void | Promise<void>): Promise<void> => {
        try {
          await work()
        } catch (error) {
          failures.push(error)
        }
      }
      // Deactivation first: it joins an activation in flight, which could still
      // be appending and recording receipts that the later joins then discard.
      for (const chatId of preparation.chatIds) {
        await attempt(() => deps.joins?.coordinator?.deactivate(chatId))
      }
      await attempt(() => {
        if (global) deps.saveIntents.forgetAll()
        else for (const chatId of preparation.chatIds) deps.saveIntents.forget(chatId)
      })
      await attempt(() => {
        if (global) deps.joins?.followers?.close()
        else for (const chatId of preparation.chatIds) deps.joins?.followers?.forget(chatId)
      })
      if (global) await attempt(() => deps.joins?.receiptStore?.forgetAll())
      else
        for (const chatId of preparation.chatIds)
          await attempt(() => deps.joins?.receiptStore?.forgetChat(chatId))
      if (failures.length > 0)
        throw new AggregateError(failures, 'History erasure could not join every writer')
      return fences
    },

    async finish(_preparation, fences) {
      for (const fence of fences) {
        const acknowledged = await deps.maintain<boolean>({
          method: 'finish-erasure',
          generation: fence.generation,
          ...scopeOf(fence.chatId)
        })
        if (!acknowledged) throw new Error('History catalogue erasure was not acknowledged')
      }
    }
  }
}
