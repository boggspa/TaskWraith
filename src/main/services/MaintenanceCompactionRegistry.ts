import { randomUUID } from 'node:crypto'

import type { ProviderId } from '../store/types'

export type MaintenanceCompactionDeletionScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string; chatIds?: readonly string[] }
  | { kind: 'chat'; chatIds: readonly string[] }
  | { kind: 'truncate'; chatIds: readonly string[] }

export interface MaintenanceCompactionReservationInput {
  chatId: string
  workspaceId?: string
  provider: ProviderId
  participantId?: string
}

export interface MaintenanceCompactionReservation {
  readonly id: string
  readonly chatId: string
  readonly workspaceId?: string
  readonly provider: ProviderId
  readonly participantId?: string
  readonly generation: number
  readonly signal: AbortSignal
}

export interface MaintenanceCompactionSnapshot {
  id: string
  chatId: string
  workspaceId?: string
  provider: ProviderId
  participantId?: string
}

export interface MaintenanceCompactionHistoryHold {
  readonly id: string
  readonly scope: MaintenanceCompactionDeletionScope
  /** Exact process-local reservations invalidated when this hold was raised. */
  readonly reservationIds: readonly string[]
}

interface ReservationState {
  token: MaintenanceCompactionReservation
  controller: AbortController
  nativeActivityCount: number
  workFinished: boolean
  workFinishedResolve: () => void
  workFinishedPromise: Promise<void>
  nativeQuiescedResolve: () => void
  nativeQuiescedPromise: Promise<void>
  deletionObserved: boolean
}

interface HistoryHoldState {
  hold: MaintenanceCompactionHistoryHold
  released: boolean
}

export class MaintenanceCompactionAdmissionError extends Error {
  constructor(message = 'History deletion is blocking provider context compaction.') {
    super(message)
    this.name = 'MaintenanceCompactionAdmissionError'
  }
}

function normalizedIds(values: readonly string[] | undefined): Set<string> {
  return new Set((values || []).map((value) => value.trim()).filter(Boolean))
}

function scopeMatches(
  scope: MaintenanceCompactionDeletionScope,
  input: Pick<MaintenanceCompactionReservationInput, 'chatId' | 'workspaceId'>
): boolean {
  if (scope.kind === 'global') return true
  if (scope.kind === 'workspace') {
    if (input.workspaceId && input.workspaceId === scope.workspaceId) return true
    return normalizedIds(scope.chatIds).has(input.chatId)
  }
  return normalizedIds(scope.chatIds).has(input.chatId)
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/**
 * Main-process authority registry for detached provider maintenance turns.
 *
 * Reservations are synchronous and precede the lane's first await. A history
 * deletion hold synchronously blocks new reservations, aborts matching work,
 * and freezes the exact reservations that must join before destructive commit.
 * Request completion and native-process quiescence are tracked independently:
 * a timed-out request is not deletion-safe while its provider activity lives.
 */
export class MaintenanceCompactionRegistry {
  private generation = 0
  private readonly reservations = new Map<string, ReservationState>()
  private readonly activeLaneIds = new Map<string, string>()
  private readonly historyHolds = new Map<string, HistoryHoldState>()
  /** Same-process exact-close tombstones. They deliberately do not survive a
   * restart: an unknown pre-crash native child must fail closed. */
  private readonly quiescedDeletionReservations = new Map<string, number>()

  constructor(
    private readonly admissionAllowed: (
      input: MaintenanceCompactionReservationInput
    ) => boolean = () => true
  ) {}

  reserve(input: MaintenanceCompactionReservationInput): MaintenanceCompactionReservation {
    const chatId = input.chatId.trim()
    if (!chatId)
      throw new MaintenanceCompactionAdmissionError('Compaction chat authority is missing.')
    const normalized: MaintenanceCompactionReservationInput = {
      ...input,
      chatId,
      ...(input.workspaceId?.trim() ? { workspaceId: input.workspaceId.trim() } : {}),
      ...(input.participantId?.trim() ? { participantId: input.participantId.trim() } : {})
    }
    if (
      !this.admissionAllowed(normalized) ||
      [...this.historyHolds.values()].some(
        (state) => !state.released && scopeMatches(state.hold.scope, normalized)
      )
    ) {
      throw new MaintenanceCompactionAdmissionError()
    }
    const laneId = this.laneId(normalized)
    if (this.activeLaneIds.has(laneId)) {
      throw new MaintenanceCompactionAdmissionError(
        'A compaction is already in progress for this provider seat.'
      )
    }
    const controller = new AbortController()
    const generation = ++this.generation
    const token: MaintenanceCompactionReservation = Object.freeze({
      id: randomUUID(),
      chatId,
      ...(normalized.workspaceId ? { workspaceId: normalized.workspaceId } : {}),
      provider: normalized.provider,
      ...(normalized.participantId ? { participantId: normalized.participantId } : {}),
      generation,
      signal: controller.signal
    })
    const workFinished = deferred()
    const nativeQuiesced = deferred()
    this.reservations.set(token.id, {
      token,
      controller,
      nativeActivityCount: 0,
      workFinished: false,
      workFinishedResolve: workFinished.resolve,
      workFinishedPromise: workFinished.promise,
      nativeQuiescedResolve: nativeQuiesced.resolve,
      nativeQuiescedPromise: nativeQuiesced.promise,
      deletionObserved: false
    })
    this.activeLaneIds.set(laneId, token.id)
    return token
  }

  canWrite(token: MaintenanceCompactionReservation): boolean {
    const state = this.reservations.get(token.id)
    return Boolean(
      state &&
      state.token === token &&
      state.token.generation === token.generation &&
      !state.controller.signal.aborted &&
      !state.workFinished
    )
  }

  /** Must be called immediately before a provider process/turn can start. */
  beginNativeActivity(token: MaintenanceCompactionReservation): boolean {
    const state = this.reservations.get(token.id)
    if (!state || !this.canWrite(token)) return false
    if (state.nativeActivityCount === 0) {
      // Native quiescence is an edge, not a one-shot lifetime event. Grok can
      // run sequential summary children; child A closing must not leave a
      // resolved promise that falsely receipts child B as already closed.
      const nextNativeQuiesced = deferred()
      state.nativeQuiescedPromise = nextNativeQuiesced.promise
      state.nativeQuiescedResolve = nextNativeQuiesced.resolve
    }
    state.nativeActivityCount += 1
    return true
  }

  /** Exact provider close/terminal evidence for one begun native activity. */
  endNativeActivity(token: MaintenanceCompactionReservation): boolean {
    const state = this.reservations.get(token.id)
    if (!state || state.token !== token || state.nativeActivityCount <= 0) return false
    state.nativeActivityCount -= 1
    this.maybeSettle(state)
    return true
  }

  /** Marks every post-await continuation in the maintenance request finished. */
  finish(token: MaintenanceCompactionReservation): boolean {
    const state = this.reservations.get(token.id)
    if (!state || state.token !== token || state.workFinished) return false
    state.workFinished = true
    state.workFinishedResolve()
    this.maybeSettle(state)
    return true
  }

  list(scope: MaintenanceCompactionDeletionScope): MaintenanceCompactionSnapshot[] {
    const matching = [...this.reservations.values()].filter((state) =>
      scopeMatches(scope, state.token)
    )
    for (const state of matching) state.deletionObserved = true
    return matching
      .map((state) => ({
        id: state.token.id,
        chatId: state.token.chatId,
        ...(state.token.workspaceId ? { workspaceId: state.token.workspaceId } : {}),
        provider: state.token.provider,
        ...(state.token.participantId ? { participantId: state.token.participantId } : {})
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Raises the deletion admission hold before returning and invalidates every
   * matching reservation. The frozen ids include work admitted in the narrow
   * discovery-to-durable-prepare window.
   */
  beginHistoryDeletion(
    scope: MaintenanceCompactionDeletionScope
  ): MaintenanceCompactionHistoryHold {
    const id = randomUUID()
    const matching = [...this.reservations.values()].filter((state) =>
      scopeMatches(scope, state.token)
    )
    for (const state of matching) state.deletionObserved = true
    const hold: MaintenanceCompactionHistoryHold = Object.freeze({
      id,
      scope,
      reservationIds: Object.freeze(matching.map((state) => state.token.id).sort())
    })
    this.historyHolds.set(id, { hold, released: false })
    for (const state of matching) state.controller.abort('history-deletion')
    return hold
  }

  /**
   * Await both exact native termination and all request continuations. An
   * unknown id fails closed: a pre-crash ACP/CLI child can outlive Electron,
   * so process-local registry absence is not provider-transport termination
   * evidence. Only a same-generation exact-close tombstone is affirmative.
   */
  async cancelAndJoin(reservationId: string): Promise<boolean> {
    const state = this.reservations.get(reservationId)
    if (!state) return this.quiescedDeletionReservations.has(reservationId)
    state.controller.abort('history-deletion')
    // The abort synchronously prevents any future beginNativeActivity call.
    // Still re-check the exact current count after every edge so a stale or
    // provider-reentrant callback can never turn an old zero transition into
    // a deletion receipt.
    await state.workFinishedPromise
    while (state.nativeActivityCount > 0) {
      const currentZeroEdge = state.nativeQuiescedPromise
      await currentZeroEdge
      if (state.nativeActivityCount > 0 && state.nativeQuiescedPromise === currentZeroEdge) {
        return false
      }
    }
    return state.workFinished && state.nativeActivityCount === 0
  }

  async cancelAndJoinHold(hold: MaintenanceCompactionHistoryHold): Promise<boolean> {
    const state = this.historyHolds.get(hold.id)
    if (!state || state.hold !== hold || state.released) return false
    const confirmations = await Promise.all(hold.reservationIds.map((id) => this.cancelAndJoin(id)))
    return confirmations.every(Boolean)
  }

  endHistoryDeletion(hold: MaintenanceCompactionHistoryHold): boolean {
    const state = this.historyHolds.get(hold.id)
    if (!state || state.hold !== hold || state.released) return false
    state.released = true
    this.historyHolds.delete(hold.id)
    return true
  }

  private maybeSettle(state: ReservationState): void {
    if (state.nativeActivityCount === 0) state.nativeQuiescedResolve()
    if (!state.workFinished || state.nativeActivityCount !== 0) return
    if (state.deletionObserved) {
      this.quiescedDeletionReservations.set(state.token.id, Date.now())
      while (this.quiescedDeletionReservations.size > 2_048) {
        const oldest = this.quiescedDeletionReservations.keys().next().value
        if (typeof oldest !== 'string') break
        this.quiescedDeletionReservations.delete(oldest)
      }
    }
    this.reservations.delete(state.token.id)
    const laneId = this.laneId(state.token)
    if (this.activeLaneIds.get(laneId) === state.token.id) this.activeLaneIds.delete(laneId)
  }

  private laneId(
    input: Pick<MaintenanceCompactionReservationInput, 'chatId' | 'provider' | 'participantId'>
  ): string {
    return `${input.provider}:${input.chatId}:${input.participantId || 'solo'}`
  }
}
