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
 *   must not proceed.
 * - `cancel` before the claim settles `cancelled_before_start` and the start
 *   never spawns (`executeStart` skips). After the claim the latch is
 *   retained through BOTH gaps: a cancellation latched before
 *   `providerCancelRegistered(cb)` invokes `cb` exactly once when it lands.
 *   Cross-identity cancellation is rejected without touching state.
 * - `markStarted` is a MONOTONIC persisted-start witness: once recorded it
 *   survives immediate finish/cancel; a late success after timeout or any
 *   terminal outcome is fenced (ignored + counted), never un-settles.
 * - `beginShutdown` stops new reservations/claims, settles unclaimed
 *   reservations as `host_shutting_down`, and drains claimed ones by
 *   latching cancellation (invoking any registered provider cancel); no late
 *   spawn is possible afterwards. Every reservation settles at most once and
 *   releases its admission lease exactly once.
 * - `reopen` implements the §7 #4 restart rule against the execution-claim
 *   store: claimed-or-unknown work stays `indeterminate` (a provider may
 *   already have started); only PROVABLY unclaimed work terminalizes as
 *   `host_shutting_down` and may be resubmitted under a NEW id. Queue
 *   payloads are never replayed.
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

  const settleTerminal = (
    record: ReservationRecord,
    outcome: HostQueuedStartTerminalOutcome
  ): boolean => {
    if (record.terminalOutcome !== null) return false
    record.terminalOutcome = outcome
    if (record.lease && !record.leaseReleased) {
      record.leaseReleased = true
      record.lease.release()
    }
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
      if (record.terminalOutcome !== null) return { kind: 'refused', reason: 'already_terminal' }
      if (shuttingDown) return { kind: 'refused', reason: 'host_shutting_down' }
      if (record.lease) return { kind: 'refused', reason: 'already_claimed' }
      // §7 #4: the durable execution claim precedes ANY provider side effect.
      // If it cannot be recorded, this start must not proceed.
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
      // A cancel that landed while the durable write was in flight found the
      // reservation still queued and settled it; honour that over the claim.
      if (record.terminalOutcome !== null) return { kind: 'refused', reason: 'already_terminal' }
      if (shuttingDown) return { kind: 'refused', reason: 'host_shutting_down' }
      record.lease = lease
      record.phase = 'starting'
      return { kind: 'claimed', reservation: record.view }
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
      if (!record.providerRunBegan) {
        // Pre-claim or post-claim-but-before-run: the spawn is fenced off by
        // the latch (executeStart refuses), and the reservation settles as
        // never-started. The latch stays set so a racing late
        // providerCancelRegistered still receives the cancellation exactly once.
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
      | { readonly kind: 'failed'; readonly error: unknown }
    > {
      const record = reservations.get(commandId)
      if (!record) return { kind: 'skipped', reason: 'unknown' }
      if (record.terminalOutcome !== null) {
        return { kind: 'skipped', reason: `terminal:${record.terminalOutcome}` }
      }
      if (record.cancelLatched) return { kind: 'skipped', reason: 'cancel_latched' }
      if (shuttingDown) return { kind: 'skipped', reason: 'host_shutting_down' }
      if (record.phase !== 'starting') return { kind: 'skipped', reason: 'not_claimed' }
      try {
        await start()
      } catch (error) {
        // Sync throw or async reject in the start callback: one terminal
        // outcome, lease released exactly once, no spawn evidence fabricated.
        settleTerminal(record, 'failed')
        return { kind: 'failed', error }
      }
      record.providerRunBegan = true
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
      return settleTerminal(record, 'start_timeout')
    },

    settle(commandId: string, outcome: 'completed' | 'cancelled' | 'failed'): boolean {
      const record = reservations.get(commandId)
      if (!record) return false
      return settleTerminal(record, outcome)
    },

    beginShutdown(): void {
      if (shuttingDown) return
      shuttingDown = true
      for (const record of reservations.values()) {
        if (record.terminalOutcome !== null) continue
        if (record.lease === null) {
          // Unclaimed (queued) starts settle immediately as never-started.
          settleTerminal(record, 'host_shutting_down')
        } else {
          // Claimed starts are DRAINED: cancellation is latched and handed
          // to a registered provider cancel; executeStart refuses from here,
          // so no late spawn can follow the shutdown fence.
          record.cancelLatched = true
          invokeCancelCallback(record)
        }
      }
    },

    async reopen(
      candidates: readonly { commandId: string; threadId: string; fingerprint: string }[]
    ): Promise<HostQueuedStartReopenOutcome[]> {
      shuttingDown = true
      let claims: readonly HostQueuedStartExecutionClaim[] | null
      try {
        claims = await store.list()
      } catch {
        // The claim evidence itself is unreadable: nothing is provably
        // unclaimed, so EVERYTHING is unknown → indeterminate.
        claims = null
      }
      return candidates.map((candidate) => {
        const claim =
          claims?.find(
            (entry) =>
              entry.commandId === candidate.commandId &&
              entry.threadId === candidate.threadId &&
              entry.fingerprint === candidate.fingerprint
          ) ?? null
        if (claims === null || claim) {
          return { commandId: candidate.commandId, outcome: 'indeterminate', resubmittable: null }
        }
        // Provably unclaimed: no durable execution claim exists, and a claim
        // would have been recorded before any provider side effect.
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
