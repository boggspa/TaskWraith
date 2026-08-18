/**
 * OllamaLocalAdmissionCoordinator — admission plus the clock that goes with it.
 *
 * Wraps `OllamaLocalAdmissionGate` with the two things a dispatch path needs
 * that a bare semaphore cannot provide: ownership (so a round can hand back
 * everything it holds in one call) and queue accounting (so timeouts survive
 * queueing).
 *
 * **Why the clock lives here.** Every timeout around a lane — fan-out
 * settlement, completion watchdogs — measures how long a provider is taking.
 * The moment lanes can wait for local capacity, a deadline anchored at
 * dispatch stops measuring that and starts measuring queue depth instead: the
 * twenty-fifth lane on a two-model host is minutes from starting, and a
 * settlement timer started when it was *dispatched* will fire long before it
 * has run a single token. The round then reports the lane as slow or dead,
 * which is a lie — it was never given a turn.
 *
 * So deadlines anchor at ADMISSION, not dispatch, and `effectiveDeadline()`
 * expresses that as "the base budget, plus whatever time this owner has spent
 * queued". Time spent waiting is not spent working and must not be billed
 * against the working budget. Critically the extension keeps growing while a
 * lane is *still* queued, so a lane that has never been admitted can never
 * time out — the budget only starts running down once it is actually running.
 *
 * Per-owner accounting, because one run's queueing must not silently extend
 * an unrelated run's patience.
 */
import { OllamaLocalAdmissionGate } from './OllamaLocalAdmissionGate'
import type { OllamaLocalAdmissionTicket } from './OllamaLocalAdmissionGate'

export interface OllamaLocalAdmissionCoordinatorOptions {
  /** Max distinct models in flight. `undefined` means unbounded. */
  readonly capacity?: number
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Pre-built gate, for callers that already own one. */
  readonly gate?: OllamaLocalAdmissionGate
}

interface OwnerState {
  /** Completed queue waits, in ms. */
  settledQueuedMs: number
  /** Start timestamps of waits that have not been admitted yet. */
  readonly pendingWaitStarts: Set<{ startedAt: number }>
  /** Live tickets, keyed by model, so `forget` can hand them all back. */
  readonly tickets: Map<string, OllamaLocalAdmissionTicket[]>
}

export class OllamaLocalAdmissionCoordinator {
  private readonly gate: OllamaLocalAdmissionGate
  private readonly now: () => number
  private readonly owners = new Map<string, OwnerState>()

  constructor(options: OllamaLocalAdmissionCoordinatorOptions = {}) {
    this.gate = options.gate ?? new OllamaLocalAdmissionGate({ capacity: options.capacity })
    this.now = options.now ?? Date.now
  }

  /** Distinct models currently admitted. */
  get inFlight(): number {
    return this.gate.inFlight
  }

  /** Requests queued behind capacity. */
  get waiting(): number {
    return this.gate.waiting
  }

  /** Re-size the gate as the capacity probe's opinion sharpens. */
  setCapacity(capacity?: number): void {
    this.gate.setCapacity(capacity)
  }

  /**
   * Wait for room to run `model` on behalf of `ownerId`.
   *
   * The wait is recorded against the owner whether or not it ends up queueing,
   * so `effectiveDeadline` can compensate for it later.
   */
  async admit(
    ownerId: string,
    model: string,
    signal?: AbortSignal
  ): Promise<OllamaLocalAdmissionTicket> {
    const owner = this.ownerState(ownerId)
    const wait = { startedAt: this.now() }
    owner.pendingWaitStarts.add(wait)
    try {
      const ticket = await this.gate.acquire(model, signal)
      const held = owner.tickets.get(model)
      if (held) held.push(ticket)
      else owner.tickets.set(model, [ticket])
      return ticket
    } finally {
      // Runs on the abort path too: a cancelled lane's partial wait is still
      // real time the round lost, and leaving it pending would extend the
      // owner's deadline forever.
      owner.pendingWaitStarts.delete(wait)
      owner.settledQueuedMs += Math.max(0, this.now() - wait.startedAt)
    }
  }

  /** Hand back one slot this owner holds for `model`. */
  release(ownerId: string, model: string): void {
    const owner = this.owners.get(ownerId)
    const held = owner?.tickets.get(model)
    const ticket = held?.pop()
    if (!ticket) return
    if (held && held.length === 0) owner?.tickets.delete(model)
    ticket.release()
  }

  /**
   * Total time this owner has spent waiting for local capacity.
   *
   * Includes waits still in progress, so the number keeps rising while a lane
   * sits in the queue. That is what stops an unstarted lane from timing out.
   */
  queuedMsFor(ownerId: string): number {
    const owner = this.owners.get(ownerId)
    if (!owner) return 0
    let total = owner.settledQueuedMs
    const now = this.now()
    for (const wait of owner.pendingWaitStarts) total += Math.max(0, now - wait.startedAt)
    return total
  }

  /**
   * A working budget with queue time added back.
   *
   * `baseDeadlineMs` is whatever the caller would have used before this gate
   * existed; with no queueing the result is identical, so an unconstrained
   * host sees no change in timeout behaviour at all.
   */
  effectiveDeadline(ownerId: string, baseDeadlineMs: number): number {
    return baseDeadlineMs + this.queuedMsFor(ownerId)
  }

  /**
   * Drop an owner: release everything it still holds and forget its clock.
   *
   * Call on any round exit — completed, cancelled, failed, crashed-and-
   * recovered. This is the ordinary path that keeps slots from leaking;
   * `reconcile` is the safety net for when even this is missed.
   */
  forget(ownerId: string): void {
    const owner = this.owners.get(ownerId)
    if (!owner) return
    for (const tickets of owner.tickets.values()) for (const ticket of tickets) ticket.release()
    owner.tickets.clear()
    this.owners.delete(ownerId)
  }

  /**
   * Re-derive held slots from authoritative state.
   *
   * `activeModels` is what the caller's durable record says is genuinely still
   * running. Anything else is reclaimed. See the gate's own note for why a
   * counter needs this at all.
   */
  reconcile(activeModels: Iterable<string>): void {
    this.gate.reconcile(activeModels)
  }

  private ownerState(ownerId: string): OwnerState {
    const existing = this.owners.get(ownerId)
    if (existing) return existing
    const created: OwnerState = {
      settledQueuedMs: 0,
      pendingWaitStarts: new Set(),
      tickets: new Map()
    }
    this.owners.set(ownerId, created)
    return created
  }
}
