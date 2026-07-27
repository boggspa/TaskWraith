import type { HistoryDeletionPreparation } from '../store'

export interface UsageHistoryDeletionMutationInput {
  operationId: string
  kind: HistoryDeletionPreparation['kind']
  workspaceId?: string
  chatIds: readonly string[]
  runIds: readonly string[]
}

export interface UsageHistoryDeletionStore<THold> {
  /** Must synchronously persist the inner intent and raise append admission. */
  beginHistoryMutation: (input: UsageHistoryDeletionMutationInput) => THold
  /** Must not resolve until every usage artifact in the frozen scope is durable. */
  purgeHistoryStrict: (hold: THold) => void | Promise<void>
  /** Clears the inner intent. Call only after the outer deletion commits. */
  endHistoryMutation: (hold: THold) => boolean
}

export interface UsageHistoryDeletionHold<THold> {
  readonly scope: Readonly<UsageHistoryDeletionMutationInput>
  readonly storeHold: THold
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter(Boolean))].sort())
}

function scopeFromPreparation(
  preparation: HistoryDeletionPreparation
): Readonly<UsageHistoryDeletionMutationInput> {
  if (!preparation.operationId) {
    throw new Error('Usage history deletion requires an outer operation id.')
  }
  if (preparation.kind === 'workspace' && !preparation.workspaceId) {
    throw new Error('Workspace usage history deletion requires a workspace id.')
  }
  return Object.freeze({
    operationId: preparation.operationId,
    kind: preparation.kind,
    ...(preparation.kind === 'workspace' && preparation.workspaceId
      ? { workspaceId: preparation.workspaceId }
      : {}),
    chatIds: uniqueSorted(preparation.chatIds),
    runIds: uniqueSorted(preparation.runIds)
  })
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertMatchesPreparation<THold>(
  preparation: HistoryDeletionPreparation,
  acquired: UsageHistoryDeletionHold<THold>
): void {
  const current = scopeFromPreparation(preparation)
  const frozen = acquired.scope
  if (
    current.operationId !== frozen.operationId ||
    current.kind !== frozen.kind ||
    current.workspaceId !== frozen.workspaceId ||
    !equalStrings(current.chatIds, frozen.chatIds) ||
    !equalStrings(current.runIds, frozen.runIds)
  ) {
    throw new Error(
      `Usage history deletion hold for ${frozen.operationId} does not match the outer deletion preparation.`
    )
  }
}

/**
 * Deletion-side adapter for UsageJournalStore's durable inner transaction.
 *
 * `acquire` is deliberately synchronous: the usage store fsyncs its correlated
 * inner intent and raises append admission before the first external teardown
 * await. `purgeStrict` preserves the exact returned promise, so the caller can
 * write the durable `usage:*` receipt only after every checkpoint, journal,
 * spill, claimed input, archive, quarantine, and corrupt-backup rewrite has
 * settled. The caller owns the outer commit boundary. It normally invokes
 * `releaseAfterCommit` afterwards. A scoped coordinator uses
 * `releaseAfterCompletion`, which also covers a timed-out attempt after every
 * late sink continuation has settled and its outer commit was explicitly
 * refused.
 */
export class UsageHistoryDeletionTarget<THold> {
  constructor(private readonly store: UsageHistoryDeletionStore<THold>) {}

  acquire(preparation: HistoryDeletionPreparation): UsageHistoryDeletionHold<THold> {
    const scope = scopeFromPreparation(preparation)
    const storeHold = this.store.beginHistoryMutation(scope)
    return Object.freeze({ scope, storeHold })
  }

  async purgeStrict(
    preparation: HistoryDeletionPreparation,
    acquired: UsageHistoryDeletionHold<THold>
  ): Promise<void> {
    assertMatchesPreparation(preparation, acquired)
    await this.store.purgeHistoryStrict(acquired.storeHold)
  }

  releaseAfterCommit(
    preparation: HistoryDeletionPreparation,
    acquired: UsageHistoryDeletionHold<THold>
  ): void {
    this.release(preparation, acquired, 'after commit')
  }

  releaseAfterCompletion(
    preparation: HistoryDeletionPreparation,
    acquired: UsageHistoryDeletionHold<THold>
  ): void {
    this.release(preparation, acquired, 'after coordinator completion')
  }

  private release(
    preparation: HistoryDeletionPreparation,
    acquired: UsageHistoryDeletionHold<THold>,
    phase: string
  ): void {
    assertMatchesPreparation(preparation, acquired)
    if (!this.store.endHistoryMutation(acquired.storeHold)) {
      throw new Error(
        `Usage history deletion hold for ${preparation.operationId} was not active ${phase}.`
      )
    }
  }
}
