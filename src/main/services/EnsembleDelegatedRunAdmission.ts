import type { ChatRun, EnsembleRunIdentity, ProviderId } from '../store/types'
import type { DispatchResult } from './RunCoordinator'
import { EnsembleHostAdmissionRuntime } from './EnsembleHostAdmissionRuntime'

export interface EnsembleDelegatedRunOrigin {
  readonly parentRunId: string
  readonly parentChatId: string
  readonly roundId: string
  readonly participantId: string
  readonly laneId?: string
}

export function resolveEnsembleDelegatedRunOrigin(input: {
  readonly parentRunId?: string
  readonly parentChatId?: string
  readonly activeIdentity?: EnsembleRunIdentity
  readonly persistedParentRun?: ChatRun
}): EnsembleDelegatedRunOrigin | undefined {
  const parentRunId = input.parentRunId?.trim()
  const parentChatId = input.parentChatId?.trim()
  const roundId = (
    input.activeIdentity?.roundId ||
    input.persistedParentRun?.ensembleRoundId ||
    ''
  ).trim()
  const participantId = (
    input.activeIdentity?.participantId ||
    input.persistedParentRun?.ensembleParticipantId ||
    ''
  ).trim()
  if (!parentRunId || !parentChatId || !roundId || !participantId) return undefined
  const laneId = (
    input.activeIdentity?.laneId ||
    input.persistedParentRun?.ensembleLaneId ||
    ''
  ).trim()
  return {
    parentRunId,
    parentChatId,
    roundId,
    participantId,
    ...(laneId ? { laneId } : {})
  }
}

export interface EnsembleDelegatedRunAdmissionRequest {
  readonly origin: EnsembleDelegatedRunOrigin
  readonly childRunId: string
  readonly childChatId: string
  readonly provider: ProviderId
  /** A terminal parent no longer occupies a dependency slot and needs no promotion. */
  readonly parentRunActive: boolean
  /** Rechecked after every admission await and immediately before RunCoordinator. */
  readonly mayStart: () => boolean
  readonly dispatch: () => Promise<DispatchResult>
}

export type EnsembleDelegatedRunAdmissionRejectionCode =
  | 'cancelled_before_reservation'
  | 'parent_capacity'
  | 'duplicate_run'
  | 'queue_full'
  | 'shutting_down'

export type EnsembleDelegatedRunCompletion =
  | {
      readonly kind: 'dispatch'
      readonly result: DispatchResult
      readonly queuedForMs: number
    }
  | {
      readonly kind: 'cancelled'
      readonly reason: string
      readonly queuedForMs: number
    }

export type EnsembleDelegatedRunAdmissionStart =
  | {
      readonly ok: true
      readonly initialState: 'admitted' | 'queued'
      readonly completion: Promise<EnsembleDelegatedRunCompletion>
      /** Resolve only after the caller has consumed completion and sealed UI/durable state. */
      readonly completeConsumer: () => void
    }
  | {
      readonly ok: false
      readonly code: EnsembleDelegatedRunAdmissionRejectionCode
      readonly retryable: boolean
      readonly message: string
    }

export interface EnsembleDelegatedRunAdmissionSnapshot {
  readonly runId: string
  readonly childChatId: string
  readonly parentChatId: string
  readonly provider: ProviderId
  readonly phase: 'reserved' | 'claiming' | 'claimed_prelaunch' | 'dispatching' | 'settled'
  /** Admission plus the caller's transcript/finalizer continuation. */
  readonly settlement: Promise<void>
}

interface DelegatedRunEntry {
  readonly runId: string
  readonly childChatId: string
  readonly parentChatId: string
  readonly provider: ProviderId
  phase: 'reserved' | 'claiming' | 'claimed_prelaunch' | 'dispatching' | 'settled'
  cancelledReason?: string
  confirmTransportGone?: (reason: string) => void
  admissionSettlement?: Promise<EnsembleDelegatedRunCompletion>
  consumerSettlement: Promise<void>
  completeConsumer: () => void
  consumerCompleted: boolean
  settlement?: Promise<void>
}

/**
 * Admission owner for provider runs spawned by an already-admitted Ensemble
 * participant through delegate_to_subthread or delegate_wave.
 *
 * Direct Ensemble turns remain owned by EnsembleOrchestrator. This coordinator
 * reserves exactly one additional lane for each distinct child provider run,
 * so a parent and its child count as two real executions without charging the
 * parent twice. Claimed work is released only by this operation's settlement;
 * cancellation may release a claim early solely while the phase still proves
 * that RunCoordinator has not been entered.
 */
export class EnsembleDelegatedRunAdmission {
  private readonly entries = new Map<string, DelegatedRunEntry>()
  private shuttingDown = false

  constructor(private readonly runtime: EnsembleHostAdmissionRuntime) {}

  start(request: EnsembleDelegatedRunAdmissionRequest): EnsembleDelegatedRunAdmissionStart {
    if (this.shuttingDown) {
      return {
        ok: false,
        code: 'shutting_down',
        retryable: true,
        message: 'The Ensemble host is shutting down; the delegated child was not started.'
      }
    }
    if (!request.mayStart()) {
      return {
        ok: false,
        code: 'cancelled_before_reservation',
        retryable: false,
        message: 'The delegated child was cancelled before host admission.'
      }
    }
    if (this.entries.has(request.childRunId)) {
      return {
        ok: false,
        code: 'duplicate_run',
        retryable: false,
        message: `Delegated run ${request.childRunId} still has an admission or consumer owner.`
      }
    }
    const reservation = this.runtime.reserve({
      runId: request.childRunId,
      chatId: request.origin.parentChatId,
      roundId: request.origin.roundId,
      participantId: request.origin.participantId,
      provider: request.provider,
      kind: 'lane'
    })
    if (reservation.kind === 'rejected') {
      return {
        ok: false,
        code: reservation.code,
        retryable: reservation.code !== 'duplicate_run',
        message: reservation.message
      }
    }

    let resolveConsumer!: () => void
    const consumerSettlement = new Promise<void>((resolve) => {
      resolveConsumer = resolve
    })
    const entry: DelegatedRunEntry = {
      runId: request.childRunId,
      childChatId: request.childChatId,
      parentChatId: request.origin.parentChatId,
      provider: request.provider,
      phase: 'reserved',
      consumerSettlement,
      consumerCompleted: false,
      completeConsumer: () => {
        if (entry.consumerCompleted) return
        entry.consumerCompleted = true
        resolveConsumer()
        this.deleteIfFullySettled(entry)
      }
    }
    this.entries.set(entry.runId, entry)
    const admissionSettlement = this.run(entry, request)
    entry.admissionSettlement = admissionSettlement
    entry.settlement = Promise.allSettled([
      admissionSettlement.then(() => undefined),
      consumerSettlement
    ]).then(() => undefined)
    return {
      ok: true,
      initialState: reservation.initialState,
      completion: admissionSettlement,
      completeConsumer: entry.completeConsumer
    }
  }

  cancelBeforeDispatch(runId: string, provider: ProviderId, reason: string): boolean {
    const entry = this.entries.get(runId)
    if (
      !entry ||
      entry.provider !== provider ||
      entry.phase === 'dispatching' ||
      entry.phase === 'settled'
    ) {
      return false
    }
    entry.cancelledReason ||= reason
    if (!this.runtime.cancel(runId, entry.cancelledReason)) {
      // A grant may have crossed from admitted-unclaimed to claimed between the
      // wrapper's await and this cancellation. The wrapper phase still proves
      // RunCoordinator has not been entered, so releasing that exact claim is safe.
      this.runtime.release(runId)
    }
    return true
  }

  /**
   * Resolve a dispatching wrapper only after its exact cancellation owner has
   * proven that no provider transport remains. This is the non-TTL escape hatch
   * for an adapter promise that never settles after successful cancellation.
   */
  confirmDispatchingTransportGone(runId: string, reason: string): boolean {
    const entry = this.entries.get(runId)
    const confirm = entry?.phase === 'dispatching' ? entry.confirmTransportGone : undefined
    if (!entry || !confirm) return false
    entry.cancelledReason ||= reason
    entry.confirmTransportGone = undefined
    confirm(entry.cancelledReason)
    // The proof says there is no provider left to own this slot. The wrapper's
    // finally repeats release idempotently when the cancellation race resolves.
    this.runtime.release(runId)
    return true
  }

  list(): readonly EnsembleDelegatedRunAdmissionSnapshot[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.settlement
        ? [
            {
              runId: entry.runId,
              childChatId: entry.childChatId,
              parentChatId: entry.parentChatId,
              provider: entry.provider,
              phase: entry.phase,
              settlement: entry.settlement
            }
          ]
        : []
    )
  }

  async shutdownBeforeDispatch(): Promise<void> {
    this.shuttingDown = true
    const settlements: Array<Promise<void>> = []
    for (const entry of this.entries.values()) {
      if (entry.phase === 'dispatching' || !entry.settlement) continue
      settlements.push(entry.settlement)
      if (entry.phase !== 'settled') {
        this.cancelBeforeDispatch(
          entry.runId,
          entry.provider,
          'The Ensemble host shut down before child dispatch.'
        )
      }
    }
    const results = await Promise.allSettled(settlements)
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Delegated child pre-dispatch shutdown failed.')
    }
  }

  private async run(
    entry: DelegatedRunEntry,
    request: EnsembleDelegatedRunAdmissionRequest
  ): Promise<EnsembleDelegatedRunCompletion> {
    let queuedForMs = 0
    try {
      entry.phase = 'claiming'
      const claim = await this.runtime.claim(entry.runId)
      if (!claim.ok) {
        return {
          kind: 'cancelled',
          reason: entry.cancelledReason || claim.reason,
          queuedForMs
        }
      }
      queuedForMs = claim.queuedForMs
      entry.phase = 'claimed_prelaunch'
      if (entry.cancelledReason || this.shuttingDown || !request.mayStart()) {
        return {
          kind: 'cancelled',
          reason:
            entry.cancelledReason ||
            (this.shuttingDown
              ? 'The Ensemble host shut down before child dispatch.'
              : 'The delegated child was cancelled before provider dispatch.'),
          queuedForMs
        }
      }

      await this.runtime.waitForBuildTurn()
      if (entry.cancelledReason || this.shuttingDown || !request.mayStart()) {
        return {
          kind: 'cancelled',
          reason:
            entry.cancelledReason ||
            (this.shuttingDown
              ? 'The Ensemble host shut down before child dispatch.'
              : 'The delegated child was cancelled before provider dispatch.'),
          queuedForMs
        }
      }

      // No await is permitted between this phase transition and dispatch().
      // Once dispatching is visible, RunManager/provider cancellation owns the
      // transport and this coordinator may no longer release the slot early.
      entry.phase = 'dispatching'
      let confirmTransportGone!: (reason: string) => void
      const confirmedCancellation = new Promise<{ kind: 'cancelled'; reason: string }>(
        (resolve) => {
          confirmTransportGone = (reason) => resolve({ kind: 'cancelled', reason })
        }
      )
      entry.confirmTransportGone = confirmTransportGone
      const dispatchOperation = request
        .dispatch()
        .then((result) => ({ kind: 'dispatch' as const, result }))
      const outcome = await Promise.race([dispatchOperation, confirmedCancellation])
      entry.confirmTransportGone = undefined
      if (outcome.kind === 'cancelled') {
        return { kind: 'cancelled', reason: outcome.reason, queuedForMs }
      }
      return { kind: 'dispatch', result: outcome.result, queuedForMs }
    } finally {
      entry.phase = 'settled'
      this.runtime.release(entry.runId)
      this.deleteIfFullySettled(entry)
    }
  }

  private deleteIfFullySettled(entry: DelegatedRunEntry): void {
    if (
      entry.phase === 'settled' &&
      entry.consumerCompleted &&
      this.entries.get(entry.runId) === entry
    ) {
      this.entries.delete(entry.runId)
    }
  }
}
