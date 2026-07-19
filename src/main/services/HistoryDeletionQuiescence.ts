import type {
  HistoryDeletionPreparation,
  HistoryDeletionQuiescenceKind,
  HistoryDeletionQuiescenceTarget
} from '../store'

type MaybePromise<T> = T | Promise<T>

export type HistoryDeletionQuiescenceCompletion = void | boolean

export type HistoryDeletionQuiescenceHandler = (
  target: HistoryDeletionQuiescenceTarget,
  preparation: HistoryDeletionPreparation
) => MaybePromise<HistoryDeletionQuiescenceCompletion>

export interface HistoryDeletionQuiescenceHandlers {
  /** Cancels and exactly joins detached provider maintenance work. */
  maintenanceCompaction: HistoryDeletionQuiescenceHandler
  /** Provider termination must return true to prove that the process stopped. */
  providerRun: (
    target: HistoryDeletionQuiescenceTarget,
    preparation: HistoryDeletionPreparation
  ) => MaybePromise<boolean>
  canvas: HistoryDeletionQuiescenceHandler
  executionGraph: HistoryDeletionQuiescenceHandler
  /** Purges the correlated durable UsageJournalStore inner transaction. */
  usage: HistoryDeletionQuiescenceHandler
  /** Revokes frozen Project-reference owners and deletes bytes at zero refs. */
  projectReference: HistoryDeletionQuiescenceHandler
  media: HistoryDeletionQuiescenceHandler
  /** Begin any bridge hold synchronously, then resolve only after strict purge. */
  bridge: HistoryDeletionQuiescenceHandler
  record: (operationId: string, targetIds: string[]) => MaybePromise<void>
}

const QUIESCENCE_KIND_ORDER: Readonly<Record<HistoryDeletionQuiescenceKind, number>> = {
  'provider-run': 0,
  'maintenance-compaction': 1,
  canvas: 2,
  'execution-graph': 3,
  usage: 4,
  'project-reference': 5,
  media: 6,
  bridge: 7
}

function compareTargets(
  left: HistoryDeletionQuiescenceTarget,
  right: HistoryDeletionQuiescenceTarget
): number {
  const kindOrder = QUIESCENCE_KIND_ORDER[left.kind] - QUIESCENCE_KIND_ORDER[right.kind]
  if (kindOrder !== 0) return kindOrder
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function handlerForTarget(
  target: HistoryDeletionQuiescenceTarget,
  handlers: HistoryDeletionQuiescenceHandlers
): HistoryDeletionQuiescenceHandler {
  switch (target.kind) {
    case 'maintenance-compaction':
      return handlers.maintenanceCompaction
    case 'provider-run':
      return handlers.providerRun
    case 'canvas':
      return handlers.canvas
    case 'execution-graph':
      return handlers.executionGraph
    case 'usage':
      return handlers.usage
    case 'project-reference':
      return handlers.projectReference
    case 'media':
      return handlers.media
    case 'bridge':
      return handlers.bridge
  }
}

export class HistoryDeletionQuiescenceError extends Error {
  readonly operationId: string
  readonly targetId: string
  readonly targetKind: HistoryDeletionQuiescenceKind
  readonly causeValue?: unknown

  constructor(
    preparation: HistoryDeletionPreparation,
    target: HistoryDeletionQuiescenceTarget,
    message: string,
    causeValue?: unknown
  ) {
    super(message)
    this.name = 'HistoryDeletionQuiescenceError'
    this.operationId = preparation.operationId
    this.targetId = target.id
    this.targetKind = target.kind
    this.causeValue = causeValue
  }
}

/** Durable receipts do not recreate process-local admission holds after a
 * restart. Remove selected hold-backed targets from the completed projection
 * so their newly acquired strict promises are always awaited and re-receipted
 * idempotently before commit. */
export function requireReacquiredHistoryDeletionHolds(
  preparation: HistoryDeletionPreparation,
  kinds: readonly HistoryDeletionQuiescenceKind[] = [
    'maintenance-compaction',
    'canvas',
    'usage',
    'project-reference',
    'media',
    'bridge'
  ]
): HistoryDeletionPreparation {
  const requiredKinds = new Set(kinds)
  const requiredTargetIds = new Set(
    preparation.quiescenceTargets
      .filter(
        (target) =>
          requiredKinds.has(target.kind) &&
          // Exact compaction receipts are durable termination evidence and
          // remain closed on recovery. Only the process-local scope barrier
          // must be reacquired. Reopening an exact target would discard its
          // proof and confuse restart absence with successful termination.
          (target.kind !== 'maintenance-compaction' || !target.maintenanceCompactionId)
      )
      .map((target) => target.id)
  )
  return {
    ...preparation,
    completedQuiescenceTargetIds: preparation.completedQuiescenceTargetIds.filter(
      (targetId) => !requiredTargetIds.has(targetId)
    )
  }
}

/**
 * Strictly quiesce every external persistence sink before store commit.
 *
 * The caller must synchronously acquire every process-local admission hold
 * before calling this async sequencer. On restart those holds must be reacquired
 * even for targets with durable receipts; a receipt does not survive as a live
 * in-memory fence.
 *
 * Durable receipts make restart recovery resumable. Handlers must themselves be
 * idempotent because a process can crash after a handler succeeds but before
 * its receipt is recorded.
 */
export async function quiescePreparedHistoryDeletion(
  preparation: HistoryDeletionPreparation,
  handlers: HistoryDeletionQuiescenceHandlers
): Promise<string[]> {
  const completed = new Set(preparation.completedQuiescenceTargetIds)
  const recordedThisRun: string[] = []
  const targets = [...preparation.quiescenceTargets].sort(compareTargets)

  for (const target of targets) {
    if (completed.has(target.id)) continue

    let result: HistoryDeletionQuiescenceCompletion
    try {
      result = await handlerForTarget(target, handlers)(target, preparation)
    } catch (error) {
      throw new HistoryDeletionQuiescenceError(
        preparation,
        target,
        `History deletion quiescence failed for ${target.id}.`,
        error
      )
    }

    if (target.kind === 'provider-run' ? result !== true : result === false) {
      throw new HistoryDeletionQuiescenceError(
        preparation,
        target,
        `History deletion quiescence was not confirmed for ${target.id}.`
      )
    }

    try {
      await handlers.record(preparation.operationId, [target.id])
    } catch (error) {
      throw new HistoryDeletionQuiescenceError(
        preparation,
        target,
        `History deletion quiescence receipt failed for ${target.id}.`,
        error
      )
    }
    completed.add(target.id)
    recordedThisRun.push(target.id)
  }

  return recordedThisRun
}
