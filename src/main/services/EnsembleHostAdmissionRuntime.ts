import {
  EnsembleHostAdmissionScheduler,
  type EnsembleHostAdmissionLease,
  type EnsembleHostAdmissionPromotionResult,
  type EnsembleHostAdmissionRequest,
  type EnsembleHostAdmissionReservation,
  type EnsembleHostAdmissionReservationResult,
  type EnsembleHostAdmissionSchedulerOptions,
  type EnsembleHostAdmissionSnapshot
} from './EnsembleHostAdmissionScheduler'

export interface EnsembleHostAdmissionRuntimeOptions {
  readonly scheduler?: EnsembleHostAdmissionScheduler
  readonly schedulerOptions?: EnsembleHostAdmissionSchedulerOptions
  readonly onSnapshot?: (snapshot: EnsembleHostAdmissionSnapshot) => void
  /** Must defer the callback to a later macrotask; defaults to setImmediate. */
  readonly scheduleBuildTurn?: (task: () => void) => void
}

export type EnsembleHostAdmissionClaimResult =
  | { readonly ok: true; readonly queuedForMs: number }
  | { readonly ok: false; readonly reason: string }

export type EnsembleHostAdmissionMaintenanceResult<T> =
  | { readonly ok: true; readonly value: T; readonly queuedForMs: number }
  | { readonly ok: false; readonly reason: string }

type AdmissionEntryPhase = 'reserved' | 'claiming' | 'claimed'

interface AdmissionEntry {
  readonly runId: string
  readonly generation: symbol
  readonly reservation: EnsembleHostAdmissionReservation
  phase: AdmissionEntryPhase
  lease?: EnsembleHostAdmissionLease
}

/**
 * Per-orchestrator ownership adapter around the fair scheduler.
 *
 * It owns reservation/lease handoff state keyed only by run id, keeping that
 * bookkeeping out of the orchestration monolith and preserving the scheduler's
 * lightweight-metadata boundary.
 */
export class EnsembleHostAdmissionRuntime {
  private readonly scheduler: EnsembleHostAdmissionScheduler
  private readonly entries = new Map<string, AdmissionEntry>()
  private readonly claimOperations = new Set<Promise<EnsembleHostAdmissionClaimResult>>()
  private buildTurnTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: EnsembleHostAdmissionRuntimeOptions = {}) {
    this.scheduler =
      options.scheduler ?? new EnsembleHostAdmissionScheduler(options.schedulerOptions)
  }

  /** Process recorder already wired onto the scheduler; absent means no sink. */
  get workSpans(): EnsembleHostAdmissionSchedulerOptions['spans'] {
    return this.scheduler.workSpans
  }

  reserve(request: EnsembleHostAdmissionRequest): EnsembleHostAdmissionReservationResult {
    const result = this.scheduler.reserve(request)
    if (result.kind === 'reserved') {
      this.entries.set(request.runId, {
        runId: request.runId,
        generation: Symbol('ensemble-host-admission-generation'),
        reservation: result,
        phase: 'reserved'
      })
    }
    this.publish()
    return result
  }

  claim(runId: string): Promise<EnsembleHostAdmissionClaimResult> {
    const entry = this.entries.get(runId)
    if (!entry) {
      return Promise.resolve({
        ok: false,
        reason: 'Host admission reservation is unavailable.'
      })
    }
    if (entry.phase !== 'reserved') {
      return Promise.resolve({
        ok: false,
        reason:
          entry.phase === 'claiming'
            ? 'Host admission claim is already in progress.'
            : 'Host admission was already claimed.'
      })
    }
    entry.phase = 'claiming'
    const operation = this.claimEntry(entry)
    this.claimOperations.add(operation)
    void operation.finally(() => this.claimOperations.delete(operation))
    return operation
  }

  private async claimEntry(entry: AdmissionEntry): Promise<EnsembleHostAdmissionClaimResult> {
    const outcome = await entry.reservation.admission
    if (outcome.kind === 'cancelled') {
      this.deleteIfCurrent(entry)
      this.publish()
      return { ok: false, reason: outcome.reason }
    }
    if (this.entries.get(entry.runId) !== entry || entry.phase !== 'claiming') {
      outcome.lease.release()
      return { ok: false, reason: 'Host admission ownership changed before claim.' }
    }
    if (!outcome.lease.claim()) {
      this.deleteIfCurrent(entry)
      this.publish()
      return { ok: false, reason: 'Host admission was cancelled before dispatch.' }
    }
    entry.phase = 'claimed'
    entry.lease = outcome.lease
    this.publish()
    return { ok: true, queuedForMs: outcome.lease.queuedForMs }
  }

  cancel(runId: string, reason: string): boolean {
    const entry = this.entries.get(runId)
    if (!entry || entry.phase === 'claimed') return false
    const cancelled = entry.reservation.cancel(reason) === true
    if (cancelled) {
      this.deleteIfCurrent(entry)
      this.publish()
    } else if (this.scheduler.stateForRun(runId) === undefined) {
      // The scheduler already settled cancellation; retain no stale metadata.
      this.deleteIfCurrent(entry)
    }
    return cancelled
  }

  promoteToForeground(runId: string): EnsembleHostAdmissionPromotionResult {
    const result = this.scheduler.promoteToForeground(runId)
    this.publish()
    return result
  }

  isForeground(runId: string): boolean {
    return this.scheduler.isForeground(runId)
  }

  release(runId: string): boolean {
    const entry = this.entries.get(runId)
    if (!entry) return false
    if (entry.phase !== 'claimed') {
      const cancelled = entry.reservation.cancel('Released before host admission claim.') === true
      if (cancelled || this.scheduler.stateForRun(runId) === undefined) {
        this.deleteIfCurrent(entry)
        if (cancelled) this.publish()
      }
      return cancelled
    }
    const released = entry.lease?.release() === true
    if (released) {
      this.deleteIfCurrent(entry)
      this.publish()
    }
    return released
  }

  queuedForMs(runId: string): number {
    return this.scheduler.queuedForMs(runId)
  }

  effectiveDeadline(baseDeadlineMs: number, runIds: Iterable<string>): number {
    return this.scheduler.effectiveDeadline(baseDeadlineMs, runIds)
  }

  /**
   * Admit exactly one heavyweight prompt build per macrotask. Concurrent callers
   * form a promise chain, so their setImmediate callbacks cannot collapse into
   * one check phase and recreate the fan-out main-loop burst.
   */
  waitForBuildTurn(): Promise<void> {
    const schedule = this.options.scheduleBuildTurn ?? setImmediate
    const turn = this.buildTurnTail
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            try {
              schedule(resolve)
            } catch {
              setImmediate(resolve)
            }
          })
      )
    this.buildTurnTail = turn
    return turn
  }

  /**
   * Run provider-side maintenance under the same lightweight host cap. The
   * caller owns the task closure; the scheduler retains request metadata only.
   */
  async runMaintenance<T>(
    request: EnsembleHostAdmissionRequest,
    task: () => Promise<T> | T,
    shouldRun: () => boolean = () => true
  ): Promise<EnsembleHostAdmissionMaintenanceResult<T>> {
    const reservation = this.reserve(request)
    if (reservation.kind === 'rejected') return { ok: false, reason: reservation.message }
    const claim = await this.claim(request.runId)
    if (!claim.ok) return claim
    try {
      await this.waitForBuildTurn()
      if (!shouldRun()) {
        return { ok: false, reason: 'Host maintenance ownership ended before dispatch.' }
      }
      return { ok: true, value: await task(), queuedForMs: claim.queuedForMs }
    } finally {
      this.release(request.runId)
    }
  }

  snapshot(): EnsembleHostAdmissionSnapshot {
    return this.scheduler.snapshot()
  }

  whenIdle(): Promise<void> {
    return this.scheduler.whenIdle()
  }

  shutdown(): ReturnType<EnsembleHostAdmissionScheduler['shutdown']> {
    const result = this.scheduler.shutdown()
    for (const entry of [...this.entries.values()]) {
      if (entry.phase === 'reserved' && this.scheduler.stateForRun(entry.runId) === undefined) {
        this.deleteIfCurrent(entry)
      }
    }
    this.publish()
    return result
  }

  async awaitPendingClaims(): Promise<void> {
    while (this.claimOperations.size > 0) {
      await Promise.allSettled([...this.claimOperations])
    }
  }

  private deleteIfCurrent(entry: AdmissionEntry): boolean {
    const current = this.entries.get(entry.runId)
    if (!current || current.generation !== entry.generation) return false
    return this.entries.delete(entry.runId)
  }

  private publish(): void {
    try {
      this.options.onSnapshot?.(this.scheduler.snapshot())
    } catch {
      // Metrics are observational and never own execution.
    }
  }
}
