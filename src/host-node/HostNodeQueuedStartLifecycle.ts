/**
 * M2 preparation — queued-start lifecycle state machine (UNWIRED).
 *
 * Amendment A1.3 of docs/performance/independent-threads-programme.md: a
 * Host-native `composer.send` must be able to acknowledge `queued`, wait
 * OUTSIDE the receipt/observation window, and still keep one identity, one
 * cancellation correlation and one terminal outcome across both cancel gaps
 * (after the admission claim but before `provider.run`; after `beginRun` but
 * before `registerCancel`) and across a Host restart.
 *
 * This module is that lifecycle as a pure, injectable state machine. It owns
 * no transport, no receipt store and no provider port; the integration lines
 * (HostNodeDomainPorts ~:1022-1039 admission/start, HostNodeProfileRunPort
 * :340/:384-391/:434-440 begin/registerCancel/cancel at baseline) belong to
 * @IntegrationOwner behind the future flag TASKWRAITH_HOST_QUEUED_START
 * (default OFF). Nothing imports this module yet.
 *
 * Contract points the amendment pins and this module enforces:
 * - `reserve` happens BEFORE any acknowledgement and is idempotent per
 *   commandId: a duplicate same-identity request returns the SAME
 *   reservation (never a second waiter); a same-id different-payload request
 *   is a conflict, not a waiter.
 * - `claim` transfers the admission lease atomically with the cancellation
 *   latch and records a durable execution claim BEFORE spawn may begin
 *   (§7 #4, decided 2026-09-08). If the claim cannot be recorded, the start
 *   must not proceed. Every refused claim leaves the offered lease with the
 *   caller; only `claimed` transfers ownership.
 * - `cancel` before the claim settles `cancelled_before_start` and the start
 *   never spawns (`executeStart` skips). After the claim the latch is
 *   retained through BOTH gaps: a cancellation latched before
 *   `providerCancelRegistered(cb)` invokes `cb` exactly once when it lands.
 *   Cross-identity cancellation is rejected without touching state.
 * - `markStarted` is a MONOTONIC persisted-start witness: once recorded it
 *   survives immediate finish/cancel; a late success after timeout or any
 *   terminal outcome is fenced (ignored + counted), never un-settles.
 * - `beginShutdown` stops new reservations/claims, settles unclaimed AND
 *   claimed-but-undispatched reservations as `host_shutting_down` (releasing
 *   their capacity — nothing else would ever settle them), and drains
 *   dispatched ones by latching cancellation (invoking any registered
 *   provider cancel); no late spawn is possible afterwards. Every
 *   reservation settles at most once and releases its admission lease
 *   exactly once, though a lease may outlive its receipt's terminal outcome
 *   until provider completion/teardown.
 * - `reopen` implements the §7 #4 restart rule against the execution-claim
 *   store: claimed-or-unknown work stays `indeterminate` (a provider may
 *   already have started); only PROVABLY unclaimed work terminalizes as
 *   `host_shutting_down` and may be resubmitted under a NEW id. Absence is
 *   proof only when the store declares durable coverage and its listing is
 *   well-formed; any same-command claim, even under a different identity,
 *   is conflicting evidence. Queue payloads are never replayed.
 *
 * Terminal outcomes map onto EXISTING transport codes only — no new wire
 * error codes (seat decoders are allowlists): see
 * `terminalOutcomeToRejectCode`; post-start outcomes are receipt-level, not
 * admission rejections.
 */

import type { HostNodeRunAdmissionLease } from './HostNodeRunAdmission'

export type HostQueuedStartPhase = 'queued' | 'starting' | 'started'

/**
 * Terminal lifecycle outcomes. `rejected`, `cancelled_before_start` and
 * `host_shutting_down` are admission-level refusals and map onto the existing
 * HostNodeRunAdmissionRejectCode values; `start_timeout`, `completed`,
 * `cancelled`, `failed` and `indeterminate` are receipt-level outcomes the
 * integration maps through the receipt store (never new transport codes).
 */
export type HostQueuedStartTerminalOutcome =
  | 'rejected'
  | 'cancelled_before_start'
  | 'host_shutting_down'
  | 'start_timeout'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'indeterminate'

/** Maps admission-level terminal outcomes onto EXISTING typed codes. */
export function terminalOutcomeToRejectCode(
  outcome: HostQueuedStartTerminalOutcome
): 'host_saturated' | 'host_shutting_down' | 'run_start_cancelled' | 'thread_busy' | null {
  switch (outcome) {
    case 'rejected':
      return 'thread_busy'
    case 'cancelled_before_start':
      return 'run_start_cancelled'
    case 'host_shutting_down':
      return 'host_shutting_down'
    default:
      return null
  }
}

/** Durable §7 #4 execution claim, recorded BEFORE the first provider side effect. */
export interface HostQueuedStartExecutionClaim {
  readonly commandId: string
  readonly threadId: string
  readonly fingerprint: string
  readonly claimedAt: number
}

/**
 * Execution-claim store port. The in-memory default below is for tests and
 * this unwired slice; the file-backed store arrives with integration.
 * `record` must be durable before `claim` resolves; `list` is consulted only
 * by `reopen`.
 */
export interface HostQueuedStartExecutionClaimStore {
  record(claim: HostQueuedStartExecutionClaim): void | Promise<void>
  list():
    | readonly HostQueuedStartExecutionClaim[]
    | Promise<readonly HostQueuedStartExecutionClaim[]>
  /**
   * Declare true ONLY when `record` is durable across Host restarts and
   * `list` reads that same durable domain for every command this lifecycle
   * may be asked about. `reopen` grants absence-based "provably unstarted"
   * classification ONLY under this declaration (M2 fix L4): a volatile
   * store proves nothing by being empty, so its absence evidence always
   * classifies as indeterminate. The in-memory default never declares it.
   */
  readonly declaresDurableCoverage?: boolean
}

export function createInMemoryExecutionClaimStore(): HostQueuedStartExecutionClaimStore & {
  readonly claims: HostQueuedStartExecutionClaim[]
} {
  const claims: HostQueuedStartExecutionClaim[] = []
  return {
    claims,
    record(claim) {
      claims.push(claim)
    },
    list() {
      return claims.slice()
    }
  }
}

/** Read-only external view of one reservation. */
export interface HostQueuedStartReservationView {
  readonly commandId: string
  readonly threadId: string
  readonly fingerprint: string
  readonly phase: HostQueuedStartPhase
  readonly terminalOutcome: HostQueuedStartTerminalOutcome | null
  readonly cancelLatched: boolean
  /** True once the start callback has been handed to foreign code (M2 L2). */
  readonly dispatched: boolean
  readonly providerRunBegan: boolean
  /** Monotonic persisted-start witness; survives finish/cancel once set. */
  readonly startedEvidence: boolean
}

export type HostQueuedStartReserveResult =
  | { readonly kind: 'reserved'; readonly reservation: HostQueuedStartReservationView }
  | { readonly kind: 'duplicate'; readonly reservation: HostQueuedStartReservationView }
  | {
      readonly kind: 'conflict'
      readonly reservation: HostQueuedStartReservationView
      readonly reason: string
    }
  | { readonly kind: 'refused'; readonly reason: 'host_shutting_down' }

/**
 * Lease-ownership rule (M2 fix L1): a `claimed` result transfers the offered
 * admission lease to the lifecycle, which then releases it exactly once at
 * the appropriate terminal/teardown point. EVERY `refused` result leaves the
 * lease with the caller — the lifecycle took no ownership, so the caller
 * must release it (or hand it elsewhere). This includes refusals that race
 * a cancel/shutdown landing while the durable claim write was in flight.
 */
export type HostQueuedStartClaimResult =
  | { readonly kind: 'claimed'; readonly reservation: HostQueuedStartReservationView }
  | {
      readonly kind: 'refused'
      readonly reason:
        | 'unknown'
        | 'already_claimed'
        | 'already_terminal'
        | 'host_shutting_down'
        | 'claim_record_failed'
        | 'lease_identity_mismatch'
    }

export type HostQueuedStartCancelResult =
  | {
      readonly kind: 'settled'
      readonly outcome: HostQueuedStartTerminalOutcome
    }
  | { readonly kind: 'latched' }
  | { readonly kind: 'forwarded' }
  | { readonly kind: 'already_terminal'; readonly outcome: HostQueuedStartTerminalOutcome }
  | { readonly kind: 'rejected'; readonly reason: 'identity_mismatch' }
  | { readonly kind: 'not_found' }

export type HostQueuedStartReopenOutcome =
  | {
      readonly commandId: string
      readonly outcome: 'indeterminate'
      /** Claimed-or-unknown work is NEVER safe to resubmit. */
      readonly resubmittable: null
    }
  | {
      readonly commandId: string
      readonly outcome: 'host_shutting_down'
      /** Provably unclaimed: safe only under a NEW command id. */
      readonly resubmittable: { readonly newIdRequired: true }
    }

export interface HostQueuedStartLifecycleOptions {
  readonly executionClaimStore?: HostQueuedStartExecutionClaimStore
  /** Observer notified exactly once per reservation at terminal settle. */
  readonly onTerminal?: (
    reservation: HostQueuedStartReservationView,
    outcome: HostQueuedStartTerminalOutcome
  ) => void
  readonly now?: () => number
}

interface ReservationRecord {
  readonly commandId: string
  readonly threadId: string
  readonly fingerprint: string
  phase: HostQueuedStartPhase
  terminalOutcome: HostQueuedStartTerminalOutcome | null
  cancelLatched: boolean
  cancelCallback: (() => void) | null
  cancelInvoked: boolean
  /** Synchronous claim-in-progress ownership; closes the double-claim window (L1). */
  claiming: boolean
  /** Settles when the in-flight claim attempt settles either way (L1). */
  claimReady: Promise<void> | null
  /** The lease object currently being claimed; prevents same-lease aliasing (R2). */
  pendingLease: HostNodeRunAdmissionLease | null
  /** Set atomically BEFORE the start callback is invoked (L2). */
  dispatched: boolean
  providerRunBegan: boolean
  startedEvidence: boolean
  lease: HostNodeRunAdmissionLease | null
  leaseReleased: boolean
  view: HostQueuedStartReservationView
}

/**
 * Create the lifecycle. All state transitions are synchronous and total; the
 * only async boundaries are the injected claim store (durable write before
 * spawn) and `executeStart` (the provider start callback it guards).
 */
export function createHostNodeQueuedStartLifecycle(options: HostQueuedStartLifecycleOptions = {}): {
  reserve(input: {
    commandId: string
    threadId: string
    fingerprint: string
  }): HostQueuedStartReserveResult
  claim(commandId: string, lease: HostNodeRunAdmissionLease): Promise<HostQueuedStartClaimResult>
  cancel(input: { commandId: string; threadId?: string }): HostQueuedStartCancelResult
  executeStart(
    commandId: string,
    start: () => void | Promise<void>
  ): Promise<
    | { readonly kind: 'started' }
    | { readonly kind: 'skipped'; readonly reason: string }
    | { readonly kind: 'fenced'; readonly outcome: HostQueuedStartTerminalOutcome }
    | { readonly kind: 'failed'; readonly error: unknown }
  >
  providerRunStarted(commandId: string): void
  providerCancelRegistered(
    commandId: string,
    callback: () => void
  ): { readonly kind: 'registered' | 'invoked' | 'ignored' }
  markStarted(commandId: string): { readonly kind: 'recorded' | 'fenced' | 'unknown' }
  expireStartWait(commandId: string): boolean
  settle(commandId: string, outcome: 'completed' | 'cancelled' | 'failed'): boolean
  providerRunEnded(commandId: string): boolean
  beginShutdown(): void
  reopen(
    candidates: readonly { commandId: string; threadId: string; fingerprint: string }[]
  ): Promise<HostQueuedStartReopenOutcome[]>
  getReservation(commandId: string): HostQueuedStartReservationView | undefined
  stats(): {
    readonly reservations: number
    readonly terminal: number
    readonly fencedLateStarts: number
    readonly callbackErrors: number
    readonly claimRecordFailures: number
  }
} {
  const store = options.executionClaimStore ?? createInMemoryExecutionClaimStore()
  const now = options.now ?? (() => Date.now())
  const reservations = new Map<string, ReservationRecord>()
  let shuttingDown = false
  let fencedLateStarts = 0
  let callbackErrors = 0
  let claimRecordFailures = 0

  const invokeCancelCallback = (record: ReservationRecord): void => {
    if (!record.cancelCallback || record.cancelInvoked) return
    record.cancelInvoked = true
    try {
      record.cancelCallback()
    } catch {
      // A provider cancel callback must never corrupt the lifecycle that
      // delivered it; the failure is observable via stats().
      callbackErrors += 1
    }
  }

  const releaseRetainedLease = (record: ReservationRecord): boolean => {
    if (!record.lease || record.leaseReleased) return false
    record.leaseReleased = true
    record.lease.release()
    return true
  }

  /**
   * Records the single terminal RECEIPT outcome. Capacity is released with it
   * unless `keepLease` is set (M2 fix L3): once the start callback has been
   * dispatched, a provider child may be running, so the admission lease must
   * survive the receipt's terminalization until provider completion/teardown
   * (`settle` on the ended run, or `providerRunEnded`).
   */
  const settleTerminal = (
    record: ReservationRecord,
    outcome: HostQueuedStartTerminalOutcome,
    keepLease = false
  ): boolean => {
    if (record.terminalOutcome !== null) return false
    record.terminalOutcome = outcome
    if (!keepLease) releaseRetainedLease(record)
    if (options.onTerminal) {
      try {
        options.onTerminal(record.view, outcome)
      } catch {
        callbackErrors += 1
      }
    }
    return true
  }

  const api = {
    reserve(input: {
      commandId: string
      threadId: string
      fingerprint: string
    }): HostQueuedStartReserveResult {
      const existing = reservations.get(input.commandId)
      if (existing) {
        if (existing.threadId === input.threadId && existing.fingerprint === input.fingerprint) {
          // Idempotent replay of the SAME reservation: one waiter, one identity.
          return { kind: 'duplicate', reservation: existing.view }
        }
        return {
          kind: 'conflict',
          reservation: existing.view,
          reason: 'same command id with a different thread or payload fingerprint'
        }
      }
      if (shuttingDown) return { kind: 'refused', reason: 'host_shutting_down' }
      const record: ReservationRecord = {
        commandId: input.commandId,
        threadId: input.threadId,
        fingerprint: input.fingerprint,
        phase: 'queued',
        terminalOutcome: null,
        cancelLatched: false,
        cancelCallback: null,
        cancelInvoked: false,
        claiming: false,
        claimReady: null,
        pendingLease: null,
        dispatched: false,
        providerRunBegan: false,
        startedEvidence: false,
        lease: null,
        leaseReleased: false,
        view: undefined as never
      }
      const view: HostQueuedStartReservationView = {
        get commandId() {
          return record.commandId
        },
        get threadId() {
          return record.threadId
        },
        get fingerprint() {
          return record.fingerprint
        },
        get phase() {
          return record.phase
        },
        get terminalOutcome() {
          return record.terminalOutcome
        },
        get cancelLatched() {
          return record.cancelLatched
        },
        get dispatched() {
          return record.dispatched
        },
        get providerRunBegan() {
          return record.providerRunBegan
        },
        get startedEvidence() {
          return record.startedEvidence
        }
      }
      record.view = view
      reservations.set(record.commandId, record)
      return { kind: 'reserved', reservation: view }
    },

    async claim(
      commandId: string,
      lease: HostNodeRunAdmissionLease
    ): Promise<HostQueuedStartClaimResult> {
      const record = reservations.get(commandId)
      if (!record) return { kind: 'refused', reason: 'unknown' }
      // Identity BEFORE durability (M2 fix L1): a lease minted for another
      // command or thread must never be bound to this reservation, and no
      // durable claim may be written on its authority.
      if (lease.commandId !== record.commandId || lease.threadId !== record.threadId) {
        return { kind: 'refused', reason: 'lease_identity_mismatch' }
      }
      if (record.terminalOutcome !== null) return { kind: 'refused', reason: 'already_terminal' }
      if (shuttingDown) return { kind: 'refused', reason: 'host_shutting_down' }
      // Ownership is reserved SYNCHRONOUSLY, before the durability await:
      // a second concurrent claim must lose here, not after both awaits
      // resolve and the later assignment overwrites the earlier lease (L1).
      // Track the lease identity to prevent the SAME lease object being offered
      // twice (R2): a refused same-lease caller must not be able to release
      // the winner's lease by releasing its alias of the same object.
      if (record.lease || record.claiming) return { kind: 'refused', reason: 'already_claimed' }
      if (record.pendingLease && record.pendingLease === lease) {
        // Same lease object offered again while first attempt is in flight
        // or after refusal: refuse but do NOT treat this as an ownership
        // transfer, so the lease stays with its current owner.
        return { kind: 'refused', reason: 'already_claimed' }
      }
      record.claiming = true
      record.pendingLease = lease
      const attempt = (async (): Promise<HostQueuedStartClaimResult> => {
        // §7 #4: the durable execution claim precedes ANY provider side
        // effect. If it cannot be recorded, this start must not proceed.
        try {
          await store.record({
            commandId: record.commandId,
            threadId: record.threadId,
            fingerprint: record.fingerprint,
            claimedAt: now()
          })
        } catch {
          claimRecordFailures += 1
          return { kind: 'refused', reason: 'claim_record_failed' }
        }
        // A cancel/shutdown that landed while the durable write was in
        // flight found the reservation still queued and settled it; honour
        // that over the claim. The offered lease stays with the caller.
        if (record.terminalOutcome !== null) return { kind: 'refused', reason: 'already_terminal' }
        if (shuttingDown) return { kind: 'refused', reason: 'host_shutting_down' }
        record.lease = lease
        record.phase = 'starting'
        return { kind: 'claimed', reservation: record.view }
      })()
      // Readiness handed to the startup continuation: executeStart awaits
      // this before deciding, so a start issued while the durable write is
      // still in flight cannot be lost to a not_claimed skip (L1).
      record.claimReady = attempt.then(
        () => undefined,
        () => undefined
      )
      try {
        return await attempt
      } finally {
        record.claiming = false
        record.pendingLease = null
      }
    },

    cancel(input: { commandId: string; threadId?: string }): HostQueuedStartCancelResult {
      const record = reservations.get(input.commandId)
      if (!record) return { kind: 'not_found' }
      if (input.threadId !== undefined && input.threadId !== record.threadId) {
        // Cross-identity cancellation never touches the reservation.
        return { kind: 'rejected', reason: 'identity_mismatch' }
      }
      if (record.terminalOutcome !== null) {
        return { kind: 'already_terminal', outcome: record.terminalOutcome }
      }
      record.cancelLatched = true
      if (record.cancelCallback) {
        invokeCancelCallback(record)
        return { kind: 'forwarded' }
      }
      if (!record.dispatched && !record.providerRunBegan) {
        // Pre-claim or post-claim-but-before-DISPATCH: no foreign start code
        // has been handed the callback, so the spawn is fenced off by the
        // latch (executeStart refuses) and the reservation settles as
        // never-started. Once dispatch began, settling here would free
        // capacity while the provider start is executing (M2 fix L2) — the
        // latch alone holds, and the pending dispatch observes it. The latch
        // stays set so a racing late providerCancelRegistered still receives
        // the cancellation exactly once.
        settleTerminal(record, 'cancelled_before_start')
        return record.lease
          ? { kind: 'latched' }
          : { kind: 'settled', outcome: 'cancelled_before_start' }
      }
      return { kind: 'latched' }
    },

    async executeStart(
      commandId: string,
      start: () => void | Promise<void>
    ): Promise<
      | { readonly kind: 'started' }
      | { readonly kind: 'skipped'; readonly reason: string }
      | { readonly kind: 'fenced'; readonly outcome: HostQueuedStartTerminalOutcome }
      | { readonly kind: 'failed'; readonly error: unknown }
    > {
      const record = reservations.get(commandId)
      if (!record) return { kind: 'skipped', reason: 'unknown' }
      // A claim may still be writing its durable evidence; the start must
      // wait for that attempt to settle rather than skip as not_claimed and
      // lose the run (M2 fix L1).
      if (record.claimReady) await record.claimReady
      if (record.terminalOutcome !== null) {
        return { kind: 'skipped', reason: `terminal:${record.terminalOutcome}` }
      }
      if (record.cancelLatched) return { kind: 'skipped', reason: 'cancel_latched' }
      if (shuttingDown) return { kind: 'skipped', reason: 'host_shutting_down' }
      if (record.phase !== 'starting') return { kind: 'skipped', reason: 'not_claimed' }
      // Dispatch-once (M2 fix L2): the token is taken atomically BEFORE any
      // foreign start code runs, so repeated or concurrent executeStart calls
      // can never invoke the provider callback twice.
      if (record.dispatched) return { kind: 'skipped', reason: 'already_dispatched' }
      record.dispatched = true
      try {
        await start()
      } catch (error) {
        // Sync throw or async reject in the start callback: one terminal
        // outcome, no spawn evidence fabricated. If the reservation
        // terminalized while the dispatch was pending (its lease retained
        // for a possibly-running provider), this failure proves the start
        // attempt is over, BUT if providerRunBegan is true the provider may
        // still be running (R1): keep the lease retained until
        // providerRunEnded/settle confirms completion/teardown.
        const keepLease = record.providerRunBegan
        if (!settleTerminal(record, 'failed', keepLease)) {
          if (!keepLease) releaseRetainedLease(record)
        }
        return { kind: 'failed', error }
      }
      record.providerRunBegan = true
      if (record.terminalOutcome !== null) {
        // Cancel/timeout/shutdown terminalized the receipt while the start
        // was executing. The provider DID begin — never report a clean
        // start against a settled reservation; fence and count it (L2).
        fencedLateStarts += 1
        return { kind: 'fenced', outcome: record.terminalOutcome }
      }
      return { kind: 'started' }
    },

    providerRunStarted(commandId: string): void {
      const record = reservations.get(commandId)
      if (!record || record.terminalOutcome !== null) return
      record.providerRunBegan = true
    },

    providerCancelRegistered(
      commandId: string,
      callback: () => void
    ): { readonly kind: 'registered' | 'invoked' | 'ignored' } {
      const record = reservations.get(commandId)
      if (!record) return { kind: 'ignored' }
      record.cancelCallback = callback
      if (record.cancelLatched) {
        // Gap 2 closure: the cancellation arrived BEFORE the provider was
        // ready to hear it; the latch delivers it now, exactly once.
        invokeCancelCallback(record)
        return { kind: 'invoked' }
      }
      return { kind: 'registered' }
    },

    markStarted(commandId: string): { readonly kind: 'recorded' | 'fenced' | 'unknown' } {
      const record = reservations.get(commandId)
      if (!record) return { kind: 'unknown' }
      if (record.terminalOutcome !== null) {
        // Late success after timeout/terminalization is fenced: ignored and
        // counted, never a state change. startedEvidence stays monotonic.
        fencedLateStarts += 1
        return { kind: 'fenced' }
      }
      record.startedEvidence = true
      record.phase = 'started'
      return { kind: 'recorded' }
    },

    expireStartWait(commandId: string): boolean {
      const record = reservations.get(commandId)
      if (!record || record.terminalOutcome !== null) return false
      if (record.dispatched || record.providerRunBegan) {
        // The start was handed to foreign code: a provider may be running.
        // Terminalize the RECEIPT as start_timeout but retain the admission
        // capacity, latch cancellation and deliver it to any registered
        // provider cancel; the lease is released only at provider
        // completion/teardown (M2 fix L3).
        const settled = settleTerminal(record, 'start_timeout', true)
        record.cancelLatched = true
        invokeCancelCallback(record)
        return settled
      }
      return settleTerminal(record, 'start_timeout')
    },

    settle(commandId: string, outcome: 'completed' | 'cancelled' | 'failed'): boolean {
      const record = reservations.get(commandId)
      if (!record) return false
      const settled = settleTerminal(record, outcome)
      if (!settled) {
        // The receipt already terminalized (e.g. start_timeout with retained
        // capacity). This call is the provider-completion signal, so the
        // retained lease is released now; the recorded outcome is unchanged.
        releaseRetainedLease(record)
      }
      return settled
    },

    /**
     * Provider completion/teardown signal for a reservation whose receipt
     * already terminalized with retained capacity (M2 fix L3). Returns true
     * when a retained admission lease was released by this call.
     */
    providerRunEnded(commandId: string): boolean {
      const record = reservations.get(commandId)
      if (!record || record.terminalOutcome === null) return false
      return releaseRetainedLease(record)
    },

    beginShutdown(): void {
      if (shuttingDown) return
      shuttingDown = true
      for (const record of reservations.values()) {
        if (record.terminalOutcome !== null) {
          // Terminal records need no shutdown action: the only path that
          // leaves a terminal record holding capacity (expireStartWait on a
          // dispatched run) already latched and delivered cancellation, and
          // its lease is owed to settle/providerRunEnded at provider end.
          continue
        }
        if (record.lease === null) {
          // Unclaimed (queued) starts settle immediately as never-started.
          settleTerminal(record, 'host_shutting_down')
        } else if (!record.dispatched && !record.providerRunBegan) {
          // Claimed but never dispatched: no foreign start code exists and
          // executeStart refuses behind the fence, so nothing will ever
          // settle or release this work later. Settle it now and free its
          // capacity instead of leaving a nonterminal lease open forever
          // (M2 fix L3).
          settleTerminal(record, 'host_shutting_down')
        } else {
          // Dispatched starts are DRAINED: cancellation is latched and
          // handed to a registered provider cancel; executeStart refuses
          // from here, so no late spawn can follow the shutdown fence.
          record.cancelLatched = true
          invokeCancelCallback(record)
        }
      }
    },

    async reopen(
      candidates: readonly { commandId: string; threadId: string; fingerprint: string }[]
    ): Promise<HostQueuedStartReopenOutcome[]> {
      shuttingDown = true
      // Absence-based classification is only as strong as the evidence
      // domain (M2 fix L4): the store must DECLARE durable coverage, the
      // listing must be well-formed, and any same-command claim — even one
      // recorded under a different thread or fingerprint — is conflicting
      // evidence, never absence. Anything less proves nothing, and unproven
      // work is indeterminate (a provider may already have started).
      let claimedCommandIds: ReadonlySet<string> | null = null
      if (store.declaresDurableCoverage === true) {
        try {
          const listed = await store.list()
          if (Array.isArray(listed)) {
            const ids = new Set<string>()
            let malformed = false
            for (const entry of listed) {
              // R3: full claim record validation. A malformed or incomplete
              // record poisons the whole absence argument.
              if (entry === null || typeof entry !== 'object') {
                malformed = true
                break
              }
              const { commandId, threadId, fingerprint, claimedAt } = entry as {
                commandId?: unknown
                threadId?: unknown
                fingerprint?: unknown
                claimedAt?: unknown
              }
              if (
                typeof commandId !== 'string' ||
                commandId === '' ||
                typeof threadId !== 'string' ||
                threadId === '' ||
                typeof fingerprint !== 'string' ||
                fingerprint === '' ||
                typeof claimedAt !== 'number' ||
                !Number.isFinite(claimedAt)
              ) {
                malformed = true
                break
              }
              ids.add(commandId)
            }
            if (!malformed) claimedCommandIds = ids
          }
        } catch {
          // The claim evidence itself is unreadable: nothing is provably
          // unclaimed, so EVERYTHING is unknown → indeterminate.
        }
      }
      return candidates.map((candidate) => {
        if (claimedCommandIds === null || claimedCommandIds.has(candidate.commandId)) {
          return { commandId: candidate.commandId, outcome: 'indeterminate', resubmittable: null }
        }
        // Provably unclaimed: the durable-coverage store would have recorded
        // a claim before any provider side effect, and it holds none for
        // this command id.
        return {
          commandId: candidate.commandId,
          outcome: 'host_shutting_down',
          resubmittable: { newIdRequired: true }
        }
      })
    },

    getReservation(commandId: string): HostQueuedStartReservationView | undefined {
      return reservations.get(commandId)?.view
    },

    stats() {
      let terminal = 0
      for (const record of reservations.values()) {
        if (record.terminalOutcome !== null) terminal += 1
      }
      return {
        reservations: reservations.size,
        terminal,
        fencedLateStarts,
        callbackErrors,
        claimRecordFailures
      }
    }
  }

  return api
}
