import type { HistoryDeletionPreparation, HistoryDeletionQuiescenceTarget } from './store'
import type { ChatRecord, ProviderId } from './store/types'

export type ScopedHistoryDeletionKind = 'chat' | 'truncate'

export interface ScopedHistoryProviderRun {
  provider: ProviderId
  runId: string
}

export interface ScopedHistoryMaintenanceCompaction {
  id: string
  provider: ProviderId
  chatId: string
}

export interface ScopedHistoryBackgroundProcessHold {
  completion: Promise<void>
}

export interface ScopedHistoryDeletionCoordinatorDeps {
  /** Synchronous, main-owned topology snapshot. No mutation may interleave before prepare. */
  resolveChatIds: (kind: ScopedHistoryDeletionKind, rootChatId: string) => string[]
  listProviderRuns: (chatIds: readonly string[]) => ScopedHistoryProviderRun[]
  /** Synchronous discovery snapshot taken before durable prepare. */
  listMaintenanceCompactions?: (chatIds: readonly string[]) => ScopedHistoryMaintenanceCompaction[]
  getPending: () => HistoryDeletionPreparation | null
  prepare: (input: {
    kind: ScopedHistoryDeletionKind
    rootChatId: string
    quiescenceTargets: HistoryDeletionQuiescenceTarget[]
  }) => HistoryDeletionPreparation
  recordQuiesced: (operationId: string, targetIds: string[]) => void
  commitDelete: (rootChatId: string) => void
  commitTruncate: (rootChatId: string) => ChatRecord | null
  /** Raises the transcript-media admission hold synchronously through commit. */
  beginTranscriptMediaMutation: (
    kind: ScopedHistoryDeletionKind,
    chatIds: readonly string[]
  ) => unknown
  endTranscriptMediaMutation: (hold: unknown) => void
  /** Raises a process-local compaction admission hold synchronously. */
  beginMaintenanceCompactionDeletion?: (
    kind: ScopedHistoryDeletionKind,
    chatIds: readonly string[]
  ) => unknown
  cancelAndJoinMaintenanceCompaction?: (
    maintenanceCompactionId: string | undefined,
    hold: unknown
  ) => Promise<void>
  endMaintenanceCompactionDeletion?: (hold: unknown) => void
  /** Synchronously fences agent-started processes owned by the frozen chats. */
  beginBackgroundProcessDeletion?: (
    kind: ScopedHistoryDeletionKind,
    chatIds: readonly string[]
  ) => ScopedHistoryBackgroundProcessHold
  /** Releases the process admission hold only after the outer commit. */
  endBackgroundProcessDeletion?: (hold: ScopedHistoryBackgroundProcessHold) => void
  /** Persists the correlated usage intent and raises append admission synchronously. */
  beginUsageHistoryMutation: (preparation: HistoryDeletionPreparation) => unknown
  /** Resolves only after every usage artifact in the frozen scope is purged. */
  purgeUsageHistoryStrict: (preparation: HistoryDeletionPreparation, hold: unknown) => Promise<void>
  /** Releases the usage intent only after the outer store commit. */
  endUsageHistoryMutation: (preparation: HistoryDeletionPreparation, hold: unknown) => void
  /** Raises the Project-reference ownership admission hold synchronously. */
  beginProjectReferenceMutation: (
    kind: ScopedHistoryDeletionKind,
    chatIds: readonly string[]
  ) => unknown
  /** Revokes the exact frozen owner pairs and awaits zero-ref byte deletion. */
  clearProjectReferenceArtifacts: (scope: {
    appChatIds: readonly string[]
    runIds: readonly string[]
  }) => Promise<void>
  /** Releases the Project-reference hold only after the outer commit. */
  endProjectReferenceMutation: (hold: unknown) => void
  /** Raises the Canvas admission/generation hold synchronously before returning. */
  beginCanvasClear: (chatId: string) => void | Promise<void>
  endCanvasClear: (chatId: string) => void
  /** Synchronously fences the exact in-memory Ensemble round, then joins its cancellation. */
  beginEnsembleClear?: (chatId: string) => void | Promise<void>
  /** Claims runs and revokes approvals, questions, and path capabilities synchronously. */
  revokeChatAuthority: (chatId: string) => void
  terminateProviderRun: (run: ScopedHistoryProviderRun) => Promise<void>
  clearExecutionGraph: (chatId: string) => Promise<void>
  clearTranscriptMedia: (chatIds: readonly string[], hold: unknown) => Promise<void>
  /** Loud, non-throwing diagnostic after a deletion committed but a hold release failed. */
  reportPostCommitReleaseError?: (error: AggregateError) => void
}

interface CanvasAttempt {
  promise: Promise<void>
  status: 'pending' | 'fulfilled' | 'rejected'
}

interface RetainedOperation {
  preparation: HistoryDeletionPreparation
  canvasHoldCounts: Map<string, number>
  canvasAttempts: Map<string, CanvasAttempt>
  ensembleAttempts: Map<string, CanvasAttempt>
  transcriptMediaHold?: { value: unknown }
  projectReferenceHold?: { value: unknown }
  maintenanceCompactionHold?: { value: unknown }
  backgroundProcessHold?: { value: ScopedHistoryBackgroundProcessHold }
  usageHistoryHold?: { value: unknown }
}

export interface ScopedHistoryDeletionResult {
  chatIds: string[]
  truncated: ChatRecord | null
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort()
}

function scopeKey(kind: ScopedHistoryDeletionKind, rootChatId: string): string {
  return `${kind}:${rootChatId}`
}

function targetsFor(
  chatIds: readonly string[],
  providerRuns: readonly ScopedHistoryProviderRun[],
  maintenanceCompactions: readonly ScopedHistoryMaintenanceCompaction[] = [],
  maintenanceBarrier = false
): HistoryDeletionQuiescenceTarget[] {
  const targets: HistoryDeletionQuiescenceTarget[] = []
  if (maintenanceBarrier) {
    targets.push({
      id: 'maintenance-compaction:chat-batch',
      kind: 'maintenance-compaction'
    })
  }
  const seenCompactions = new Set<string>()
  for (const compaction of maintenanceCompactions) {
    if (!compaction.id || seenCompactions.has(compaction.id)) continue
    seenCompactions.add(compaction.id)
    targets.push({
      id: `maintenance-compaction:${compaction.id}`,
      kind: 'maintenance-compaction',
      maintenanceCompactionId: compaction.id,
      provider: compaction.provider,
      chatId: compaction.chatId
    })
  }
  const seenRuns = new Set<string>()
  for (const run of providerRuns) {
    if (!run.runId || seenRuns.has(run.runId)) continue
    seenRuns.add(run.runId)
    targets.push({
      id: `provider-run:${run.runId}`,
      kind: 'provider-run',
      runId: run.runId,
      provider: run.provider
    })
  }
  for (const chatId of chatIds) {
    targets.push(
      { id: `canvas:chat:${chatId}`, kind: 'canvas', chatId },
      { id: `execution-graph:chat:${chatId}`, kind: 'execution-graph', chatId }
    )
  }
  targets.push(
    { id: 'usage:chat-batch', kind: 'usage' },
    { id: 'project-reference:chat-run-batch', kind: 'project-reference' },
    { id: 'media:chat-batch', kind: 'media' }
  )
  return targets
}

/**
 * Main-process single-flight for destructive chat history mutations.
 *
 * A failed attempt deliberately keeps its Canvas/admission holds and durable
 * intent. A retry reuses that operation, re-runs only targets without durable
 * receipts, then releases every retained hold only after commit succeeds.
 */
export class ScopedHistoryDeletionCoordinator {
  private readonly inFlightByScope = new Map<string, Promise<ScopedHistoryDeletionResult>>()
  private readonly retainedByOperation = new Map<string, RetainedOperation>()

  constructor(private readonly deps: ScopedHistoryDeletionCoordinatorDeps) {}

  run(kind: ScopedHistoryDeletionKind, rootChatId: string): Promise<ScopedHistoryDeletionResult> {
    const key = scopeKey(kind, rootChatId)
    const joined = this.inFlightByScope.get(key)
    if (joined) return joined

    const pending = this.deps.getPending()
    let preparation: HistoryDeletionPreparation
    if (pending) {
      if (pending.kind !== kind || pending.rootChatId !== rootChatId) {
        throw new Error(
          `History deletion ${pending.operationId} is still pending; complete it before starting another scope.`
        )
      }
      // A durable intent is the frozen authority on retry/restart, including
      // after a partial commit removed one of its descendant chat files.
      preparation = pending
    } else {
      // Everything through durable prepare is synchronous. JavaScript cannot
      // interleave a topology mutation between this snapshot and the fsynced
      // intent, and a competing deletion sees that intent before side effects.
      const previewChatIds = uniqueSorted(this.deps.resolveChatIds(kind, rootChatId))
      const providerRuns = this.deps.listProviderRuns(previewChatIds)
      const maintenanceCompactions = this.deps.listMaintenanceCompactions?.(previewChatIds) || []
      preparation = this.deps.prepare({
        kind,
        rootChatId,
        quiescenceTargets: targetsFor(
          previewChatIds,
          providerRuns,
          maintenanceCompactions,
          Boolean(this.deps.beginMaintenanceCompactionDeletion)
        )
      })

      const preparedChatIds = uniqueSorted(preparation.chatIds)
      if (
        preparedChatIds.length !== previewChatIds.length ||
        preparedChatIds.some((chatId, index) => chatId !== previewChatIds[index])
      ) {
        throw new Error(
          'History deletion topology changed before durable prepare; external deletion was stopped.'
        )
      }
    }

    let retained = this.retainedByOperation.get(preparation.operationId)
    if (!retained) {
      retained = {
        preparation,
        canvasHoldCounts: new Map<string, number>(),
        canvasAttempts: new Map<string, CanvasAttempt>(),
        ensembleAttempts: new Map<string, CanvasAttempt>()
      }
      this.retainedByOperation.set(preparation.operationId, retained)
    } else {
      retained.preparation = preparation
    }

    const operation = this.executeAttempt(kind, rootChatId, retained)
    this.inFlightByScope.set(key, operation)
    void operation
      .finally(() => {
        if (this.inFlightByScope.get(key) === operation) this.inFlightByScope.delete(key)
      })
      .catch(() => {})
    return operation
  }

  private executeAttempt(
    kind: ScopedHistoryDeletionKind,
    rootChatId: string,
    retained: RetainedOperation
  ): Promise<ScopedHistoryDeletionResult> {
    const preparation = retained.preparation
    const completed = new Set(preparation.completedQuiescenceTargetIds)
    if (!retained.usageHistoryHold) {
      try {
        retained.usageHistoryHold = {
          value: this.deps.beginUsageHistoryMutation(preparation)
        }
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (!retained.projectReferenceHold) {
      try {
        retained.projectReferenceHold = {
          value: this.deps.beginProjectReferenceMutation(kind, preparation.chatIds)
        }
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (!retained.transcriptMediaHold) {
      try {
        retained.transcriptMediaHold = {
          value: this.deps.beginTranscriptMediaMutation(kind, preparation.chatIds)
        }
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (!retained.maintenanceCompactionHold && this.deps.beginMaintenanceCompactionDeletion) {
      try {
        retained.maintenanceCompactionHold = {
          value: this.deps.beginMaintenanceCompactionDeletion(kind, preparation.chatIds)
        }
      } catch (error) {
        return Promise.reject(error)
      }
    }
    if (!retained.backgroundProcessHold && this.deps.beginBackgroundProcessDeletion) {
      try {
        retained.backgroundProcessHold = {
          value: this.deps.beginBackgroundProcessDeletion(kind, preparation.chatIds)
        }
      } catch (error) {
        return Promise.reject(error)
      }
    }
    const canvasTargetsByChat = new Map(
      preparation.quiescenceTargets
        .filter(
          (target): target is HistoryDeletionQuiescenceTarget & { chatId: string } =>
            target.kind === 'canvas' && Boolean(target.chatId)
        )
        .map((target) => [target.chatId, target])
    )

    // Reacquire every process-local Canvas hold after restart even when the
    // durable Canvas receipt already exists. On an in-process retry, reuse a
    // pending/fulfilled attempt; only a rejected close/purge needs a new hold.
    for (const chatId of preparation.chatIds) {
      const target = canvasTargetsByChat.get(chatId)
      if (!target) {
        return Promise.reject(new Error(`Canvas deletion target for ${chatId} is missing.`))
      }
      const existing = retained.canvasAttempts.get(chatId)
      if (existing && existing.status !== 'rejected') continue
      let promise: Promise<void>
      try {
        promise = Promise.resolve(this.deps.beginCanvasClear(chatId))
        retained.canvasHoldCounts.set(chatId, (retained.canvasHoldCounts.get(chatId) ?? 0) + 1)
      } catch (error) {
        promise = Promise.reject(error)
      }
      const attempt: CanvasAttempt = { promise, status: 'pending' }
      retained.canvasAttempts.set(chatId, attempt)
      void promise.then(
        () => {
          attempt.status = 'fulfilled'
        },
        () => {
          attempt.status = 'rejected'
        }
      )
    }
    // The Canvas begin above raises the per-chat history admission gate in
    // main synchronously. Cancel the exact Ensemble runtime in the same stack,
    // before any sink await, and retain its join promise across retries.
    if (this.deps.beginEnsembleClear) {
      for (const chatId of preparation.chatIds) {
        const existing = retained.ensembleAttempts.get(chatId)
        if (existing && existing.status !== 'rejected') continue
        let promise: Promise<void>
        try {
          promise = Promise.resolve(this.deps.beginEnsembleClear(chatId))
        } catch (error) {
          promise = Promise.reject(error)
        }
        const attempt: CanvasAttempt = { promise, status: 'pending' }
        retained.ensembleAttempts.set(chatId, attempt)
        void promise.then(
          () => {
            attempt.status = 'fulfilled'
          },
          () => {
            attempt.status = 'rejected'
          }
        )
      }
    }
    // Claims/revocations happen only after durable prepare, but still before
    // the first provider/Canvas/graph/media await.
    for (const chatId of preparation.chatIds) this.deps.revokeChatAuthority(chatId)

    return this.settleAndCommit(kind, rootChatId, retained, completed, canvasTargetsByChat)
  }

  private async settleAndCommit(
    kind: ScopedHistoryDeletionKind,
    rootChatId: string,
    retained: RetainedOperation,
    completed: Set<string>,
    canvasTargetsByChat: Map<string, HistoryDeletionQuiescenceTarget & { chatId: string }>
  ): Promise<ScopedHistoryDeletionResult> {
    const preparation = retained.preparation
    const pendingKind = (kindToMatch: HistoryDeletionQuiescenceTarget['kind']) =>
      preparation.quiescenceTargets
        .filter((target) => target.kind === kindToMatch && !completed.has(target.id))
        .sort((left, right) => left.id.localeCompare(right.id))
    const receipt = (target: HistoryDeletionQuiescenceTarget): void => {
      // A receipt is durable evidence, never an optimistic start marker.
      this.deps.recordQuiesced(preparation.operationId, [target.id])
      completed.add(target.id)
    }

    try {
      // A signal acknowledgement is not a close. The registry's exact frozen
      // child joins must settle before any provider/sink receipt or commit.
      if (retained.backgroundProcessHold) {
        await retained.backgroundProcessHold.value.completion
      }

      // A round can be waiting in health probe or seat compaction before it
      // owns a RunManager session. Its exact cancellation must settle before
      // provider discovery receipts, media purge, or transcript commit.
      for (const chatId of preparation.chatIds) {
        const attempt = retained.ensembleAttempts.get(chatId)
        if (this.deps.beginEnsembleClear && !attempt) {
          throw new Error(`Ensemble deletion target for ${chatId} was not fenced.`)
        }
        if (attempt) await attempt.promise
      }

      // Never let graph/media report success while a provider can still emit.
      for (const target of pendingKind('provider-run')) {
        if (!target.runId || !target.provider) {
          throw new Error(`Provider deletion target ${target.id} is incomplete.`)
        }
        await this.deps.terminateProviderRun({
          provider: target.provider,
          runId: target.runId
        })
        receipt(target)
      }

      // Detached maintenance turns own native processes/state outside the run
      // registry. They are independently aborted by the synchronously raised
      // hold and exactly joined after ordinary provider runs.
      const maintenanceTargets = preparation.quiescenceTargets
        .filter(
          (target) =>
            target.kind === 'maintenance-compaction' &&
            (!completed.has(target.id) || !target.maintenanceCompactionId)
        )
        .sort((left, right) => left.id.localeCompare(right.id))
      for (const target of maintenanceTargets) {
        const join = this.deps.cancelAndJoinMaintenanceCompaction
        const hold = retained.maintenanceCompactionHold?.value
        if (!join || !hold) {
          throw new Error(`Maintenance compaction target ${target.id} was not fenced.`)
        }
        await join(target.maintenanceCompactionId, hold)
        if (!completed.has(target.id)) receipt(target)
      }

      // Await every reacquired Canvas hold, including already-receipted ones.
      for (const chatId of preparation.chatIds) {
        const target = canvasTargetsByChat.get(chatId)
        const attempt = retained.canvasAttempts.get(chatId)
        if (!target || !attempt) {
          throw new Error(`Canvas deletion target for ${chatId} was not fenced.`)
        }
        await attempt.promise
        if (!completed.has(target.id)) receipt(target)
      }

      for (const target of pendingKind('execution-graph')) {
        if (!target.chatId) throw new Error(`Graph deletion target ${target.id} has no chat id.`)
        await this.deps.clearExecutionGraph(target.chatId)
        receipt(target)
      }

      const usageTargets = preparation.quiescenceTargets
        .filter((target) => target.kind === 'usage')
        .sort((left, right) => left.id.localeCompare(right.id))
      if (usageTargets.length !== 1 || !retained.usageHistoryHold) {
        throw new Error('Scoped usage history deletion target was not fenced exactly once.')
      }
      // A durable usage receipt cannot recreate the process-local hold (or the
      // inner intent after a crash between outer commit and release). Re-purge
      // and reverify the freshly acquired hold even when this target was
      // already receipted, then write a receipt only when one is still absent.
      for (const target of usageTargets) {
        await this.deps.purgeUsageHistoryStrict(preparation, retained.usageHistoryHold.value)
        if (!completed.has(target.id)) receipt(target)
      }

      const projectReferenceTargets = preparation.quiescenceTargets
        .filter((target) => target.kind === 'project-reference')
        .sort((left, right) => left.id.localeCompare(right.id))
      if (projectReferenceTargets.length !== 1 || !retained.projectReferenceHold) {
        throw new Error(
          'Scoped Project-reference history deletion target was not fenced exactly once.'
        )
      }
      // Re-run the strict owner revocation after restart even when a durable
      // receipt exists: that receipt cannot recreate this process-local hold,
      // and the ledger purge is idempotent for the frozen chat/run scope.
      for (const target of projectReferenceTargets) {
        await this.deps.clearProjectReferenceArtifacts({
          appChatIds: preparation.chatIds,
          runIds: preparation.runIds
        })
        if (!completed.has(target.id)) receipt(target)
      }

      const mediaTargets = preparation.quiescenceTargets
        .filter((target) => target.kind === 'media')
        .sort((left, right) => left.id.localeCompare(right.id))
      if (mediaTargets.length !== 1 || !retained.transcriptMediaHold) {
        throw new Error('Scoped media history deletion target was not fenced exactly once.')
      }
      // The durable media receipt cannot recreate either the transcript-media
      // admission hold or the generation fence protecting regenerable
      // PDF/staging bytes. Re-purge the freshly acquired bundle on restart.
      for (const target of mediaTargets) {
        await this.deps.clearTranscriptMedia(
          preparation.chatIds,
          retained.transcriptMediaHold.value
        )
        if (!completed.has(target.id)) receipt(target)
      }

      const unsupported = preparation.quiescenceTargets.find(
        (target) => target.kind === 'bridge' && !completed.has(target.id)
      )
      if (unsupported) {
        throw new Error(`Unsupported scoped history deletion target: ${unsupported.kind}`)
      }
    } catch (error) {
      throw new AggregateError(
        [error],
        'Scoped history deletion could not quiesce every external sink.'
      )
    }

    let truncated: ChatRecord | null = null
    if (kind === 'truncate') truncated = this.deps.commitTruncate(rootChatId)
    else this.deps.commitDelete(rootChatId)

    const releaseErrors: unknown[] = []
    if (retained.usageHistoryHold) {
      const hold = retained.usageHistoryHold.value
      retained.usageHistoryHold = undefined
      try {
        this.deps.endUsageHistoryMutation(preparation, hold)
      } catch (error) {
        releaseErrors.push(error)
      }
    }
    if (retained.maintenanceCompactionHold) {
      const hold = retained.maintenanceCompactionHold.value
      retained.maintenanceCompactionHold = undefined
      try {
        if (!this.deps.endMaintenanceCompactionDeletion) {
          throw new Error('Maintenance compaction deletion hold has no release handler.')
        }
        this.deps.endMaintenanceCompactionDeletion(hold)
      } catch (error) {
        releaseErrors.push(error)
      }
    }
    if (retained.backgroundProcessHold) {
      const hold = retained.backgroundProcessHold.value
      retained.backgroundProcessHold = undefined
      try {
        if (!this.deps.endBackgroundProcessDeletion) {
          throw new Error('Background-process deletion hold has no release handler.')
        }
        this.deps.endBackgroundProcessDeletion(hold)
      } catch (error) {
        releaseErrors.push(error)
      }
    }
    if (retained.projectReferenceHold) {
      const hold = retained.projectReferenceHold.value
      retained.projectReferenceHold = undefined
      try {
        this.deps.endProjectReferenceMutation(hold)
      } catch (error) {
        releaseErrors.push(error)
      }
    }
    if (retained.transcriptMediaHold) {
      const hold = retained.transcriptMediaHold.value
      retained.transcriptMediaHold = undefined
      try {
        this.deps.endTranscriptMediaMutation(hold)
      } catch (error) {
        releaseErrors.push(error)
      }
    }
    for (const [chatId, count] of retained.canvasHoldCounts) {
      for (let index = 0; index < count; index += 1) {
        try {
          this.deps.endCanvasClear(chatId)
        } catch (error) {
          releaseErrors.push(error)
        }
      }
    }
    retained.canvasHoldCounts.clear()
    retained.canvasAttempts.clear()
    retained.ensembleAttempts.clear()
    this.retainedByOperation.delete(preparation.operationId)
    if (releaseErrors.length > 0) {
      const diagnostic = new AggregateError(
        releaseErrors,
        'Scoped history deletion committed, but one or more admission holds could not be released.'
      )
      try {
        if (this.deps.reportPostCommitReleaseError) {
          this.deps.reportPostCommitReleaseError(diagnostic)
        } else {
          console.error('[scoped-history-deletion] post-commit hold release failed:', diagnostic)
        }
      } catch (reportError) {
        // The durable intent and payload are already gone. Diagnostics must not
        // turn a committed deletion into a retryable-looking caller rejection.
        console.error(
          '[scoped-history-deletion] post-commit hold release diagnostic failed:',
          new AggregateError([diagnostic, reportError], 'History-deletion diagnostics failed.')
        )
      }
    }
    return { chatIds: [...preparation.chatIds], truncated }
  }
}
