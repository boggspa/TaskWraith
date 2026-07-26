export type CodexThreadAdmissionKind = 'turn' | 'review' | 'manual_compaction'

export interface CodexThreadAdmissionScope {
  appChatId: string
  workspaceId?: string | null
  /** Optional outer adapter join. Read lazily because the RunCoordinator sets
   * its in-flight promise immediately after the adapter reaches its first await. */
  joinAfterRelease?: () => Promise<void> | undefined
}

export type CodexThreadAdmissionHistoryScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string; chatIds?: readonly string[] }
  | { kind: 'chat' | 'truncate'; chatIds: readonly string[] }

export interface CodexThreadAdmissionHistoryHold {
  readonly scope: CodexThreadAdmissionHistoryScope
  readonly completion: Promise<void>
}

export interface CodexThreadAdmissionWaitAuthority {
  /**
   * Main-owned setup cancellation for the exact run. Aborting while queued
   * removes this reservation without disturbing the current lane owner.
   */
  readonly signal?: AbortSignal
  /**
   * Synchronous final fence for terminal claims that may precede the setup
   * abort notification. It is checked before waiting and again immediately
   * after admission is acquired.
   */
  readonly isTerminalClaimed?: () => boolean
}

export function codexProviderOperationId(message: any): string | undefined {
  const params = message?.params || {}
  const operationIds = [
    params.turn?.id,
    params.review?.id,
    params.turnId,
    params.reviewId,
    params.item?.turnId
  ]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
  const unique = [...new Set(operationIds)]
  return unique.length === 1 ? unique[0] : undefined
}

export function codexTerminalMethodMatchesAdmission(
  kind: CodexThreadAdmissionKind,
  method: unknown
): boolean {
  if (method === 'error') return true
  if (kind === 'review') {
    return (
      method === 'turn/completed' ||
      method === 'turn/failed' ||
      method === 'review/completed' ||
      method === 'review/failed'
    )
  }
  return method === 'turn/completed' || method === 'turn/failed'
}

interface CodexThreadAdmissionLane {
  owner?: CodexThreadAdmissionReservation
  waiters: CodexThreadAdmissionReservation[]
}

function normalizedIdentity(value: unknown): string {
  return String(value ?? '').trim()
}

function scopeMatches(
  reservation: CodexThreadAdmissionReservation,
  scope: CodexThreadAdmissionHistoryScope
): boolean {
  if (scope.kind === 'global') return true
  if (scope.kind === 'workspace') {
    return (
      reservation.workspaceId === normalizedIdentity(scope.workspaceId) ||
      Boolean(scope.chatIds?.includes(reservation.appChatId))
    )
  }
  return scope.chatIds.includes(reservation.appChatId)
}

/**
 * A synchronous claim on one Codex app-server thread's admission lane.
 *
 * `reserve()` creates this object and either makes it the owner immediately or
 * queues it before returning. Callers can therefore reserve before their first
 * setup await without relying on JavaScript scheduling luck. The lane remains
 * owned through the matching exact terminal projection, or until the caller
 * proves that admission never happened and releases it explicitly.
 */
export class CodexThreadAdmissionReservation {
  readonly threadId: string
  readonly kind: CodexThreadAdmissionKind
  readonly appChatId: string
  readonly workspaceId: string | null

  private acquired = false
  private released = false
  private exactOperationIdValue?: string
  private historyRevoked = false
  private readonly acquiredPromise: Promise<boolean>
  private resolveAcquired!: (acquired: boolean) => void
  private readonly settledPromise: Promise<void>
  private resolveSettled!: () => void
  private readonly joinAfterRelease?: () => Promise<void> | undefined

  constructor(
    private readonly registry: CodexThreadAdmissionRegistry,
    input: {
      threadId: string
      kind: CodexThreadAdmissionKind
      appChatId: string
      workspaceId: string | null
      joinAfterRelease?: () => Promise<void> | undefined
    }
  ) {
    this.threadId = input.threadId
    this.kind = input.kind
    this.appChatId = input.appChatId
    this.workspaceId = input.workspaceId
    this.joinAfterRelease = input.joinAfterRelease
    this.acquiredPromise = new Promise<boolean>((resolve) => {
      this.resolveAcquired = resolve
    })
    this.settledPromise = new Promise<void>((resolve) => {
      this.resolveSettled = resolve
    })
  }

  get exactOperationId(): string | undefined {
    return this.exactOperationIdValue
  }

  waitUntilAcquired(): Promise<boolean> {
    return this.acquiredPromise
  }

  async waitUntilSettled(): Promise<void> {
    await this.settledPromise
    const outer = this.joinAfterRelease?.()
    if (outer) await outer.then(() => undefined, () => undefined)
  }

  isHistoryRevoked(): boolean {
    return this.historyRevoked
  }

  isAdmissionOwner(): boolean {
    return this.acquired && !this.released && this.registry.isOwner(this)
  }

  /**
   * Bind the first provider identity only while this reservation owns the lane.
   * Replays of the same id are accepted; a different id can never replace it.
   * The lane remains owned through terminal projection because RunManager's
   * provider-session lookup has only one state slot per persistent thread.
   */
  bindExactOperationId(rawOperationId: unknown): boolean {
    const operationId = String(rawOperationId ?? '').trim()
    if (!operationId) return false
    if (this.exactOperationIdValue) return this.exactOperationIdValue === operationId
    if (!this.isAdmissionOwner()) return false
    this.exactOperationIdValue = operationId
    return true
  }

  matchesExactOperationId(rawOperationId: unknown): boolean {
    const operationId = String(rawOperationId ?? '').trim()
    return Boolean(operationId && this.exactOperationIdValue === operationId)
  }

  releaseAfterExactTerminal(rawOperationId: unknown): boolean {
    if (!this.matchesExactOperationId(rawOperationId)) return false
    this.registry.release(this)
    return true
  }

  /** Release only when the caller has proof that no provider operation exists. */
  releaseBeforeAdmission(): void {
    if (this.exactOperationIdValue) return
    this.registry.release(this)
  }

  /** Cancel a queued reservation (for example, a history-deletion abort). */
  cancelBeforeAcquired(): void {
    if (this.acquired || this.exactOperationIdValue) return
    this.registry.release(this)
  }

  revokeForHistory(): void {
    this.historyRevoked = true
    if (!this.acquired) this.registry.cancelQueuedForHistory(this)
  }

  markAcquired(): void {
    if (this.released) return
    this.acquired = true
    this.resolveAcquired(true)
  }

  markReleasedBeforeAcquired(): void {
    if (this.acquired || this.released) return
    this.released = true
    this.resolveAcquired(false)
    this.resolveSettled()
  }

  markHistoryCancelledBeforeAcquired(): void {
    if (this.acquired || this.released) return
    this.resolveAcquired(false)
  }

  markReleased(): void {
    if (this.released) return
    this.released = true
    this.resolveSettled()
  }
}

/** FIFO admission serialization for the long-lived shared Codex app-server. */
export class CodexThreadAdmissionRegistry {
  private readonly lanes = new Map<string, CodexThreadAdmissionLane>()
  private readonly historyHolds = new Set<CodexThreadAdmissionHistoryHold>()

  reserve(input: {
    threadId: string
    kind: CodexThreadAdmissionKind
    scope: CodexThreadAdmissionScope
  }): CodexThreadAdmissionReservation {
    const threadId = input.threadId.trim()
    if (!threadId) throw new Error('Codex thread admission requires an exact thread id.')
    const appChatId = normalizedIdentity(input.scope.appChatId)
    const workspaceId = normalizedIdentity(input.scope.workspaceId) || null
    if (!appChatId) throw new Error('Codex thread admission requires an exact chat owner.')
    const reservation = new CodexThreadAdmissionReservation(this, {
      threadId,
      kind: input.kind,
      appChatId,
      workspaceId,
      joinAfterRelease: input.scope.joinAfterRelease
    })
    if ([...this.historyHolds].some((hold) => scopeMatches(reservation, hold.scope))) {
      reservation.revokeForHistory()
      return reservation
    }
    const lane = this.lanes.get(threadId) ?? { waiters: [] }
    this.lanes.set(threadId, lane)
    if (!lane.owner) {
      lane.owner = reservation
      reservation.markAcquired()
    } else {
      lane.waiters.push(reservation)
    }
    return reservation
  }

  beginHistoryClear(scope: CodexThreadAdmissionHistoryScope): CodexThreadAdmissionHistoryHold {
    const reservations = new Set<CodexThreadAdmissionReservation>()
    for (const lane of this.lanes.values()) {
      if (lane.owner && scopeMatches(lane.owner, scope)) reservations.add(lane.owner)
      for (const waiter of [...lane.waiters]) {
        if (scopeMatches(waiter, scope)) reservations.add(waiter)
      }
    }
    const hold: CodexThreadAdmissionHistoryHold = Object.freeze({
      scope,
      completion: Promise.all(
        [...reservations].map((reservation) => {
          reservation.revokeForHistory()
          return reservation.waitUntilSettled()
        })
      ).then(() => undefined)
    })
    this.historyHolds.add(hold)
    return hold
  }

  endHistoryClear(hold: CodexThreadAdmissionHistoryHold): boolean {
    return this.historyHolds.delete(hold)
  }

  /**
   * Live owner/waiter reservations across all thread lanes. Non-zero means a
   * turn, native review, or manual compaction still holds or awaits admission
   * on the shared daemon — including work that owns no RunManager session and
   * no startup lease, which a daemon restart would otherwise tear down
   * ungated.
   */
  get activeLaneReservationCount(): number {
    let count = 0
    for (const lane of this.lanes.values()) {
      if (lane.owner) count += 1
      count += lane.waiters.length
    }
    return count
  }

  isOwner(reservation: CodexThreadAdmissionReservation): boolean {
    return this.lanes.get(reservation.threadId)?.owner === reservation
  }

  release(reservation: CodexThreadAdmissionReservation): void {
    const lane = this.lanes.get(reservation.threadId)
    if (!lane) {
      reservation.markReleasedBeforeAcquired()
      reservation.markReleased()
      return
    }
    if (lane.owner === reservation) {
      reservation.markReleased()
      lane.owner = undefined
      while (lane.waiters.length > 0 && !lane.owner) {
        const next = lane.waiters.shift()!
        lane.owner = next
        next.markAcquired()
      }
    } else {
      const queuedIndex = lane.waiters.indexOf(reservation)
      if (queuedIndex >= 0) lane.waiters.splice(queuedIndex, 1)
      reservation.markReleasedBeforeAcquired()
      reservation.markReleased()
    }
    if (!lane.owner && lane.waiters.length === 0) this.lanes.delete(reservation.threadId)
  }

  cancelQueuedForHistory(reservation: CodexThreadAdmissionReservation): void {
    const lane = this.lanes.get(reservation.threadId)
    if (lane?.owner === reservation) return
    if (lane) {
      const queuedIndex = lane.waiters.indexOf(reservation)
      if (queuedIndex >= 0) lane.waiters.splice(queuedIndex, 1)
      if (!lane.owner && lane.waiters.length === 0) this.lanes.delete(reservation.threadId)
    }
    // Wake the caller, but retain its settlement join until the caller observes
    // revocation and explicitly releases its pre-admission work.
    reservation.markHistoryCancelledBeforeAcquired()
  }
}

/**
 * Wait for one thread-lane reservation without leaving an aborted/terminal
 * request queued behind another operation.
 *
 * A queued cancellation uses `cancelBeforeAcquired()`, so it cannot release
 * the current owner. If cancellation races with promotion, the post-acquire
 * fence uses `releaseBeforeAdmission()` while no exact provider operation can
 * exist yet. Once this helper returns `true`, it removes its abort listener and
 * lifecycle ownership passes to the caller's exact-operation binding.
 */
export async function waitForCodexThreadAdmission(
  reservation: CodexThreadAdmissionReservation,
  authority: CodexThreadAdmissionWaitAuthority = {}
): Promise<boolean> {
  const authorityRevoked = (): boolean =>
    authority.signal?.aborted === true || authority.isTerminalClaimed?.() === true
  const releaseUnadmittedReservation = (): void => {
    if (reservation.isAdmissionOwner()) reservation.releaseBeforeAdmission()
    else reservation.cancelBeforeAcquired()
  }

  try {
    if (authorityRevoked()) {
      releaseUnadmittedReservation()
      return false
    }

    const onAbort = (): void => {
      // This is intentionally queued-only. If promotion won the race, the
      // post-await authority fence below owns the pre-admission release.
      reservation.cancelBeforeAcquired()
    }
    authority.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const acquired = await reservation.waitUntilAcquired()
      if (!acquired) {
        // History revocation wakes a queued waiter without settling it so the
        // caller can first stop any setup work. At this helper boundary there
        // is no setup work yet, so settle the reservation exactly once.
        reservation.releaseBeforeAdmission()
        return false
      }
      if (authorityRevoked()) {
        reservation.releaseBeforeAdmission()
        return false
      }
      return true
    } finally {
      authority.signal?.removeEventListener('abort', onAbort)
    }
  } catch (error) {
    releaseUnadmittedReservation()
    throw error
  }
}
