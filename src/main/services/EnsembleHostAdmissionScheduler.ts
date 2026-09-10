import type { ProviderId } from '../store/types'
import type { WorkSpanRecordInput } from '../perf/WorkSpanRecorder'

/**
 * Process-wide backpressure for Electron-hosted Ensemble provider runs.
 *
 * The scheduler retains only bounded run identity metadata. Prompt payloads,
 * chat records, provider handles and dispatch closures stay with the caller and
 * should be materialized only after the reservation is admitted.
 */

export const DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_RUNS = 30
// Leave six slots available to leaf work even when fan-out owners are waiting.
export const DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_FOREGROUND_RUNS = 24
export const DEFAULT_ENSEMBLE_HOST_MAX_QUEUED_RUNS = 256

const MAX_IDENTIFIER_CHARS = 512
const MAX_REASON_CHARS = 300
// eslint-disable-next-line no-control-regex -- admission identifiers reject C0 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/** `foreground` means fan-out-capable owner; `lane` is a leaf execution slot. */
export type EnsembleHostAdmissionKind = 'foreground' | 'lane'
export type EnsembleHostAdmissionRunState = 'queued' | 'active'

export interface EnsembleHostAdmissionRequest {
  readonly runId: string
  readonly chatId: string
  readonly roundId?: string
  readonly participantId?: string
  readonly provider: ProviderId
  readonly kind: EnsembleHostAdmissionKind
}

export interface EnsembleHostAdmissionIdentity extends EnsembleHostAdmissionRequest {
  readonly queuedAt: number
}

export interface EnsembleHostAdmissionOccupancy {
  readonly maxActive: number
  readonly maxForeground: number
  readonly reservedLaneSlots: number
  readonly maxQueued: number
  readonly active: number
  readonly activeForeground: number
  readonly activeLanes: number
  readonly queued: number
  readonly queuedForeground: number
  readonly queuedLanes: number
  readonly shuttingDown: boolean
}

export interface EnsembleHostAdmissionLease {
  readonly identity: EnsembleHostAdmissionIdentity
  readonly admittedAt: number
  readonly queuedForMs: number
  /**
   * Claim the slot synchronously before materializing a prompt or starting
   * provider work. False means cancellation won the grant handoff.
   */
  claim(): boolean
  /** Returns true only for the release that actually surrendered the slot. */
  release(): boolean
}

export type EnsembleHostAdmissionOutcome =
  | {
      readonly kind: 'admitted'
      readonly lease: EnsembleHostAdmissionLease
    }
  | {
      readonly kind: 'cancelled'
      readonly identity: EnsembleHostAdmissionIdentity
      readonly cancelledAt: number
      readonly queuedForMs: number
      readonly reason: string
    }

export interface EnsembleHostAdmissionReservation {
  readonly kind: 'reserved'
  readonly initialState: 'admitted' | 'queued'
  readonly identity: EnsembleHostAdmissionIdentity
  readonly admission: Promise<EnsembleHostAdmissionOutcome>
  readonly occupancy: EnsembleHostAdmissionOccupancy
  /**
   * Cancel while queued or admitted-but-unclaimed. Once claim() succeeds, the
   * provider lifecycle owns cancellation and this returns false.
   */
  cancel(reason?: string): boolean
}

export type EnsembleHostAdmissionRejectionCode = 'duplicate_run' | 'queue_full' | 'shutting_down'

export interface EnsembleHostAdmissionRejection {
  readonly kind: 'rejected'
  readonly code: EnsembleHostAdmissionRejectionCode
  readonly message: string
  readonly occupancy: EnsembleHostAdmissionOccupancy
}

export type EnsembleHostAdmissionReservationResult =
  | EnsembleHostAdmissionReservation
  | EnsembleHostAdmissionRejection

export type EnsembleHostAdmissionPromotionResult =
  | {
      readonly ok: true
      readonly promoted: boolean
      readonly occupancy: EnsembleHostAdmissionOccupancy
    }
  | {
      readonly ok: false
      readonly code: 'run_not_active' | 'run_not_claimed' | 'foreground_capacity'
      readonly retryable: boolean
      readonly message: string
      readonly occupancy: EnsembleHostAdmissionOccupancy
    }

export interface EnsembleHostAdmissionMetrics {
  readonly requests: number
  readonly reservations: number
  readonly initiallyQueued: number
  readonly admitted: number
  readonly released: number
  readonly cancelledQueued: number
  readonly cancelledUnclaimed: number
  readonly shutdownCancelledQueued: number
  readonly duplicateRejected: number
  readonly overflowRejected: number
  readonly shutdownRejected: number
  readonly promotedToForeground: number
  readonly promotionRejected: number
  readonly admittedQueueWaitMs: number
  readonly cancelledQueueWaitMs: number
  readonly maxAdmittedQueueWaitMs: number
  readonly maxCancelledQueueWaitMs: number
  readonly peakActive: number
  readonly peakQueued: number
}

export interface EnsembleHostAdmissionChatSnapshot {
  readonly chatId: string
  readonly active: number
  readonly queued: number
}

export interface EnsembleHostAdmissionProviderSnapshot {
  readonly provider: ProviderId
  readonly active: number
  readonly queued: number
}

export interface EnsembleHostAdmissionSnapshot {
  readonly occupancy: EnsembleHostAdmissionOccupancy
  readonly metrics: EnsembleHostAdmissionMetrics
  readonly byChat: readonly EnsembleHostAdmissionChatSnapshot[]
  readonly byProvider: readonly EnsembleHostAdmissionProviderSnapshot[]
}

export interface EnsembleHostAdmissionSchedulerOptions {
  readonly maxActive?: number
  readonly maxForeground?: number
  readonly maxQueued?: number
  readonly now?: () => number
  /**
   * Releases drain at most one waiter per scheduled turn. New fan-out requests
   * can immediately fill free host slots. Production defaults to setImmediate;
   * tests may inject a deterministic task queue.
   */
  readonly schedule?: (task: () => void) => void
  /**
   * Optional M1 measurement seam (Amendment A1.1): one `admission_wait`
   * span per settled waiter — reason `admitted`, `cancelled`, `shutdown`
   * or `rejected` — on resource `ensemble_pool`, attributed by
   * chat/run/participant (and laneId for lane-kind runs). Absent recorder
   * means the seam does not exist: no span is built and no sink is
   * consulted. A throwing recorder is swallowed; instrumentation must
   * never break admission. Aggregate metrics are unchanged either way.
   */
  readonly spans?: { record(span: WorkSpanRecordInput): void }
}

interface QueuedWaiter {
  readonly identity: EnsembleHostAdmissionIdentity
  readonly sequence: number
  readonly admission: Promise<EnsembleHostAdmissionOutcome>
  readonly resolve: (outcome: EnsembleHostAdmissionOutcome) => void
  token?: symbol
  state: 'queued' | 'admitted' | 'cancelled' | 'rejected'
}

interface ProviderQueue {
  readonly foreground: QueuedWaiter[]
  readonly lanes: QueuedWaiter[]
}

interface ChatQueue {
  readonly providers: Map<ProviderId, ProviderQueue>
  readonly providerOrder: ProviderId[]
  size: number
}

interface ActiveAdmission {
  readonly identity: EnsembleHostAdmissionIdentity
  readonly token: symbol
  readonly admittedAt: number
  readonly waiter: QueuedWaiter
  kind: EnsembleHostAdmissionKind
  claimed: boolean
}

interface MutableMetrics {
  requests: number
  reservations: number
  initiallyQueued: number
  admitted: number
  released: number
  cancelledQueued: number
  cancelledUnclaimed: number
  shutdownCancelledQueued: number
  duplicateRejected: number
  overflowRejected: number
  shutdownRejected: number
  promotedToForeground: number
  promotionRejected: number
  admittedQueueWaitMs: number
  cancelledQueueWaitMs: number
  maxAdmittedQueueWaitMs: number
  maxCancelledQueueWaitMs: number
  peakActive: number
  peakQueued: number
}

function defaultSchedule(task: () => void): void {
  setImmediate(task)
}

function requireBoundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_CHARS ||
    value.trim() !== value ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`${label} must be a canonical non-empty identifier.`)
  }
  return value
}

function optionalBoundedIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireBoundedIdentifier(value, label)
}

function boundedReason(value: string | undefined, fallback: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) return fallback
  return normalized.length <= MAX_REASON_CHARS ? normalized : normalized.slice(0, MAX_REASON_CHARS)
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer.`)
  }
  return value
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`)
  }
  return value
}

function incrementCount(
  map: Map<string, { active: number; queued: number }>,
  key: string
): {
  active: number
  queued: number
} {
  const existing = map.get(key)
  if (existing) return existing
  const created = { active: 0, queued: 0 }
  map.set(key, created)
  return created
}

function rotateToBack<T>(order: T[], value: T): void {
  const index = order.indexOf(value)
  if (index < 0) return
  order.splice(index, 1)
  order.push(value)
}

function removeFromOrder<T>(order: T[], value: T): void {
  const index = order.indexOf(value)
  if (index >= 0) order.splice(index, 1)
}

/**
 * Fair, cancellation-safe admission for all Ensemble runs in one Electron main
 * process. Chats rotate first, providers rotate within a selected chat, and
 * each provider/kind queue remains FIFO. Foreground work cannot consume the
 * reserved lane slots, preventing foreground fan-out owners from occupying
 * every slot while waiting for children that can never start. Callers must
 * atomically promote a claimed lane before it reserves or waits on descendants;
 * ordinary auxiliary runs remain leaves and keep the reserved capacity usable.
 */
export class EnsembleHostAdmissionScheduler {
  private readonly maxActive: number
  private readonly maxForeground: number
  private readonly maxQueued: number
  private readonly now: () => number
  private readonly scheduleTask: (task: () => void) => void
  private readonly spans?: { record(span: WorkSpanRecordInput): void }
  private readonly activeByRunId = new Map<string, ActiveAdmission>()
  private readonly queuedByRunId = new Map<string, QueuedWaiter>()
  private readonly chats = new Map<string, ChatQueue>()
  private readonly chatOrder: string[] = []
  private readonly idleWaiters = new Set<() => void>()
  private readonly metricsState: MutableMetrics = {
    requests: 0,
    reservations: 0,
    initiallyQueued: 0,
    admitted: 0,
    released: 0,
    cancelledQueued: 0,
    cancelledUnclaimed: 0,
    shutdownCancelledQueued: 0,
    duplicateRejected: 0,
    overflowRejected: 0,
    shutdownRejected: 0,
    promotedToForeground: 0,
    promotionRejected: 0,
    admittedQueueWaitMs: 0,
    cancelledQueueWaitMs: 0,
    maxAdmittedQueueWaitMs: 0,
    maxCancelledQueueWaitMs: 0,
    peakActive: 0,
    peakQueued: 0
  }
  private activeForeground = 0
  private sequence = 0
  private shuttingDown = false
  private drainScheduled = false

  constructor(options: EnsembleHostAdmissionSchedulerOptions = {}) {
    this.maxActive = requirePositiveInteger(
      options.maxActive ?? DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_RUNS,
      'Ensemble host active-run capacity'
    )
    this.maxForeground = requirePositiveInteger(
      options.maxForeground ??
        Math.min(DEFAULT_ENSEMBLE_HOST_MAX_ACTIVE_FOREGROUND_RUNS, this.maxActive),
      'Ensemble host foreground-run capacity'
    )
    if (this.maxForeground > this.maxActive) {
      throw new Error('Ensemble host foreground-run capacity cannot exceed total capacity.')
    }
    this.maxQueued = requireNonNegativeInteger(
      options.maxQueued ?? DEFAULT_ENSEMBLE_HOST_MAX_QUEUED_RUNS,
      'Ensemble host queued-run capacity'
    )
    this.now = options.now ?? Date.now
    this.scheduleTask = options.schedule ?? defaultSchedule
    this.spans = options.spans
  }

  /** Optional M1 span sink already attached in production schedulerOptions. */
  get workSpans(): EnsembleHostAdmissionSchedulerOptions['spans'] {
    return this.spans
  }

  /**
   * One span per settled waiter, at the moment its queue wait ends. An
   * admitted-then-cancelled-unclaimed run emits no second span: its wait
   * already ended (and was measured) at admission. Never throws — a broken
   * recorder loses the measurement, never the admission.
   */
  private emitAdmissionSpan(
    identity: EnsembleHostAdmissionIdentity,
    queuedForMs: number,
    reason: 'admitted' | 'cancelled' | 'shutdown' | 'rejected'
  ): void {
    const spans = this.spans
    if (!spans) return
    try {
      spans.record({
        chatId: identity.chatId,
        runId: identity.runId,
        ...(identity.participantId === undefined ? {} : { participantId: identity.participantId }),
        // A lane-kind run IS the lane; foreground runs carry no laneId.
        ...(identity.kind === 'lane' ? { laneId: identity.runId } : {}),
        kind: 'admission_wait',
        resource: 'ensemble_pool',
        reason,
        startedAt: identity.queuedAt,
        durationMs: queuedForMs
      })
    } catch {
      // Instrumentation must never break admission.
    }
  }

  reserve(request: EnsembleHostAdmissionRequest): EnsembleHostAdmissionReservationResult {
    const identity = this.normalizeIdentity(request)
    this.metricsState.requests += 1

    if (this.shuttingDown) {
      this.metricsState.shutdownRejected += 1
      return this.rejection(
        'shutting_down',
        'The Ensemble host is shutting down; this run was not queued or started.'
      )
    }
    if (this.activeByRunId.has(identity.runId) || this.queuedByRunId.has(identity.runId)) {
      this.metricsState.duplicateRejected += 1
      return this.rejection(
        'duplicate_run',
        `Ensemble run ${identity.runId} already has an active or queued host reservation.`
      )
    }

    let resolveAdmission!: (outcome: EnsembleHostAdmissionOutcome) => void
    const admission = new Promise<EnsembleHostAdmissionOutcome>((resolve) => {
      resolveAdmission = resolve
    })
    const waiter: QueuedWaiter = {
      identity,
      sequence: ++this.sequence,
      admission,
      resolve: resolveAdmission,
      state: 'queued'
    }
    this.enqueue(waiter)

    // Fan-out lanes reserve every free host slot, including while a release
    // drain is pending. This is lightweight bookkeeping: the runtime still
    // builds only one heavyweight prompt per event-loop turn.
    if (!this.drainScheduled || identity.kind === 'lane') this.drainAvailable()

    if (waiter.state === 'queued' && this.queuedByRunId.size > this.maxQueued) {
      this.removeQueuedWaiter(waiter)
      waiter.state = 'rejected'
      this.metricsState.overflowRejected += 1
      const cancelledAt = this.now()
      const queuedForMs = Math.max(0, cancelledAt - identity.queuedAt)
      this.emitAdmissionSpan(identity, queuedForMs, 'rejected')
      waiter.resolve({
        kind: 'cancelled',
        identity,
        cancelledAt,
        queuedForMs,
        reason: 'Ensemble host queue capacity was exceeded.'
      })
      return this.rejection(
        'queue_full',
        `Ensemble host queue is full (${this.maxQueued} waiting). This run was not accepted; providers and seats remain available. Retry after capacity frees.`
      )
    }

    this.metricsState.reservations += 1
    if (waiter.state === 'queued') this.metricsState.initiallyQueued += 1
    this.recordHighWaterMarks()
    this.scheduleDrain()
    return {
      kind: 'reserved',
      initialState: waiter.state === 'admitted' ? 'admitted' : 'queued',
      identity,
      admission,
      occupancy: this.occupancy(),
      cancel: (reason) =>
        this.cancelReservation(
          waiter,
          boundedReason(reason, 'Cancelled before provider work started.')
        )
    }
  }

  stateForRun(runId: string): EnsembleHostAdmissionRunState | undefined {
    if (this.activeByRunId.has(runId)) return 'active'
    return this.queuedByRunId.has(runId) ? 'queued' : undefined
  }

  isForeground(runId: string): boolean {
    return this.activeByRunId.get(runId)?.kind === 'foreground'
  }

  /**
   * Sticky on-demand promotion for a claimed lane that is about to own/wait on
   * descendants. Promotion never evicts work and remains until lease release.
   */
  promoteToForeground(runId: string): EnsembleHostAdmissionPromotionResult {
    const active = this.activeByRunId.get(runId)
    if (!active) {
      this.metricsState.promotionRejected += 1
      return {
        ok: false,
        code: 'run_not_active',
        retryable: false,
        message: 'The run no longer owns an active host-admission slot.',
        occupancy: this.occupancy()
      }
    }
    if (!active.claimed) {
      this.metricsState.promotionRejected += 1
      return {
        ok: false,
        code: 'run_not_claimed',
        retryable: true,
        message: 'The run has not claimed its host-admission slot yet.',
        occupancy: this.occupancy()
      }
    }
    if (this.maxForeground >= this.maxActive) {
      this.metricsState.promotionRejected += 1
      return {
        ok: false,
        code: 'foreground_capacity',
        retryable: true,
        message:
          'Host admission has no reserved leaf capacity for descendant work. Finish this turn and retry after the capacity limits reserve at least one host slot for leaf work; no descendant work was reserved.',
        occupancy: this.occupancy()
      }
    }
    if (active.kind === 'foreground') {
      return { ok: true, promoted: false, occupancy: this.occupancy() }
    }
    if (this.activeForeground >= this.maxForeground) {
      this.metricsState.promotionRejected += 1
      return {
        ok: false,
        code: 'foreground_capacity',
        retryable: true,
        message: `Host foreground-owner capacity is full (${this.activeForeground}/${this.maxForeground}). Finish this lane and retry from a later foreground turn; no descendant work was reserved.`,
        occupancy: this.occupancy()
      }
    }
    active.kind = 'foreground'
    this.activeForeground += 1
    this.metricsState.promotedToForeground += 1
    return { ok: true, promoted: true, occupancy: this.occupancy() }
  }

  cancelQueued(runId: string, reason?: string): boolean {
    const waiter = this.queuedByRunId.get(runId)
    if (!waiter || waiter.state !== 'queued') return false
    this.cancelWaiter(waiter, boundedReason(reason, 'Cancelled before host admission.'), false)
    return true
  }

  /** Current queue delay for a queued or admitted run; zero once forgotten. */
  queuedForMs(runId: string): number {
    const queued = this.queuedByRunId.get(runId)
    if (queued) return Math.max(0, this.now() - queued.identity.queuedAt)
    const active = this.activeByRunId.get(runId)
    return active ? Math.max(0, active.admittedAt - active.identity.queuedAt) : 0
  }

  /** Extend a working deadline by the worst queue delay among its owned runs. */
  effectiveDeadline(baseDeadlineMs: number, runIds: Iterable<string>): number {
    let worstQueueMs = 0
    for (const runId of runIds) {
      worstQueueMs = Math.max(worstQueueMs, this.queuedForMs(runId))
    }
    return baseDeadlineMs + worstQueueMs
  }

  /**
   * Reject future reservations and settle every queued or granted-but-unclaimed
   * waiter. Claimed leases remain occupied until their exact dispatch owners
   * release them.
   */
  shutdown(): {
    readonly cancelledQueued: number
    readonly cancelledUnclaimed: number
    readonly occupancy: EnsembleHostAdmissionOccupancy
  } {
    if (this.shuttingDown) {
      return { cancelledQueued: 0, cancelledUnclaimed: 0, occupancy: this.occupancy() }
    }
    this.shuttingDown = true
    const pending = [...this.queuedByRunId.values()].sort(
      (left, right) => left.sequence - right.sequence
    )
    for (const waiter of pending) {
      this.cancelWaiter(waiter, 'Ensemble host shut down before admission.', true)
    }
    const unclaimed = [...this.activeByRunId.values()].filter((active) => !active.claimed)
    for (const active of unclaimed) this.cancelUnclaimed(active)
    this.notifyIdle()
    return {
      cancelledQueued: pending.length,
      cancelledUnclaimed: unclaimed.length,
      occupancy: this.occupancy()
    }
  }

  whenIdle(): Promise<void> {
    if (this.activeByRunId.size === 0 && this.queuedByRunId.size === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.add(resolve)
    })
  }

  snapshot(): EnsembleHostAdmissionSnapshot {
    const byChat = new Map<string, { active: number; queued: number }>()
    const byProvider = new Map<string, { active: number; queued: number }>()
    for (const active of this.activeByRunId.values()) {
      incrementCount(byChat, active.identity.chatId).active += 1
      incrementCount(byProvider, active.identity.provider).active += 1
    }
    for (const queued of this.queuedByRunId.values()) {
      incrementCount(byChat, queued.identity.chatId).queued += 1
      incrementCount(byProvider, queued.identity.provider).queued += 1
    }
    return {
      occupancy: this.occupancy(),
      metrics: { ...this.metricsState },
      byChat: [...byChat.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([chatId, counts]) => ({ chatId, ...counts })),
      byProvider: [...byProvider.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, counts]) => ({ provider: provider as ProviderId, ...counts }))
    }
  }

  private normalizeIdentity(request: EnsembleHostAdmissionRequest): EnsembleHostAdmissionIdentity {
    if (request.kind !== 'foreground' && request.kind !== 'lane') {
      throw new Error('Ensemble host admission kind must be foreground or lane.')
    }
    return Object.freeze({
      runId: requireBoundedIdentifier(request.runId, 'Ensemble run id'),
      chatId: requireBoundedIdentifier(request.chatId, 'Ensemble chat id'),
      ...(request.roundId === undefined
        ? {}
        : { roundId: optionalBoundedIdentifier(request.roundId, 'Ensemble round id') }),
      ...(request.participantId === undefined
        ? {}
        : {
            participantId: optionalBoundedIdentifier(
              request.participantId,
              'Ensemble participant id'
            )
          }),
      provider: requireBoundedIdentifier(request.provider, 'Ensemble provider') as ProviderId,
      kind: request.kind,
      queuedAt: this.now()
    })
  }

  private enqueue(waiter: QueuedWaiter): void {
    let chat = this.chats.get(waiter.identity.chatId)
    if (!chat) {
      chat = { providers: new Map(), providerOrder: [], size: 0 }
      this.chats.set(waiter.identity.chatId, chat)
      this.chatOrder.push(waiter.identity.chatId)
    }
    let provider = chat.providers.get(waiter.identity.provider)
    if (!provider) {
      provider = { foreground: [], lanes: [] }
      chat.providers.set(waiter.identity.provider, provider)
      chat.providerOrder.push(waiter.identity.provider)
    }
    const queue = waiter.identity.kind === 'foreground' ? provider.foreground : provider.lanes
    queue.push(waiter)
    chat.size += 1
    this.queuedByRunId.set(waiter.identity.runId, waiter)
  }

  private removeQueuedWaiter(waiter: QueuedWaiter): boolean {
    if (this.queuedByRunId.get(waiter.identity.runId) !== waiter) return false
    const chat = this.chats.get(waiter.identity.chatId)
    const provider = chat?.providers.get(waiter.identity.provider)
    const queue = waiter.identity.kind === 'foreground' ? provider?.foreground : provider?.lanes
    const index = queue?.indexOf(waiter) ?? -1
    if (!chat || !provider || !queue || index < 0) return false

    queue.splice(index, 1)
    chat.size -= 1
    this.queuedByRunId.delete(waiter.identity.runId)
    if (provider.foreground.length === 0 && provider.lanes.length === 0) {
      chat.providers.delete(waiter.identity.provider)
      removeFromOrder(chat.providerOrder, waiter.identity.provider)
    }
    if (chat.size === 0) {
      this.chats.delete(waiter.identity.chatId)
      removeFromOrder(this.chatOrder, waiter.identity.chatId)
    }
    return true
  }

  private cancelWaiter(waiter: QueuedWaiter, reason: string, shutdown: boolean): void {
    if (!this.removeQueuedWaiter(waiter)) return
    waiter.state = 'cancelled'
    const cancelledAt = this.now()
    const queuedForMs = Math.max(0, cancelledAt - waiter.identity.queuedAt)
    this.metricsState.cancelledQueued += 1
    this.metricsState.cancelledQueueWaitMs += queuedForMs
    this.metricsState.maxCancelledQueueWaitMs = Math.max(
      this.metricsState.maxCancelledQueueWaitMs,
      queuedForMs
    )
    if (shutdown) this.metricsState.shutdownCancelledQueued += 1
    this.emitAdmissionSpan(waiter.identity, queuedForMs, shutdown ? 'shutdown' : 'cancelled')
    waiter.resolve({
      kind: 'cancelled',
      identity: waiter.identity,
      cancelledAt,
      queuedForMs,
      reason
    })
    this.notifyIdle()
  }

  private cancelReservation(waiter: QueuedWaiter, reason: string): boolean {
    if (waiter.state === 'queued') {
      this.cancelWaiter(waiter, reason, false)
      return true
    }
    if (waiter.state !== 'admitted' || !waiter.token) return false
    const active = this.activeByRunId.get(waiter.identity.runId)
    if (!active || active.token !== waiter.token || active.claimed) return false
    this.cancelUnclaimed(active)
    return true
  }

  private cancelUnclaimed(active: ActiveAdmission): void {
    if (active.claimed || this.activeByRunId.get(active.identity.runId) !== active) return
    this.activeByRunId.delete(active.identity.runId)
    if (active.kind === 'foreground') this.activeForeground -= 1
    active.waiter.state = 'cancelled'
    this.metricsState.cancelledUnclaimed += 1
    this.notifyIdle()
    this.scheduleDrain()
  }

  private eligibleWaiter(provider: ProviderQueue): QueuedWaiter | undefined {
    const lane = provider.lanes[0]
    const foreground =
      this.activeForeground < this.maxForeground ? provider.foreground[0] : undefined
    if (!lane) return foreground
    if (!foreground) return lane
    return lane.sequence < foreground.sequence ? lane : foreground
  }

  private peekNextEligible(): QueuedWaiter | undefined {
    if (this.activeByRunId.size >= this.maxActive) return undefined
    for (const chatId of this.chatOrder) {
      const chat = this.chats.get(chatId)
      if (!chat) continue
      for (const providerId of chat.providerOrder) {
        const provider = chat.providers.get(providerId)
        if (!provider) continue
        const waiter = this.eligibleWaiter(provider)
        if (waiter) return waiter
      }
    }
    return undefined
  }

  private takeNextEligible(): QueuedWaiter | undefined {
    const waiter = this.peekNextEligible()
    if (!waiter || !this.removeQueuedWaiter(waiter)) return undefined
    const { chatId, provider } = waiter.identity
    const remainingChat = this.chats.get(chatId)
    if (remainingChat) {
      rotateToBack(remainingChat.providerOrder, provider)
      rotateToBack(this.chatOrder, chatId)
    }
    return waiter
  }

  private hasEligibleWaiter(): boolean {
    return this.peekNextEligible() !== undefined
  }

  private admit(waiter: QueuedWaiter): void {
    const admittedAt = this.now()
    const queuedForMs = Math.max(0, admittedAt - waiter.identity.queuedAt)
    const token = Symbol('ensemble-host-admission')
    waiter.state = 'admitted'
    waiter.token = token
    this.activeByRunId.set(waiter.identity.runId, {
      identity: waiter.identity,
      token,
      admittedAt,
      waiter,
      kind: waiter.identity.kind,
      claimed: false
    })
    if (waiter.identity.kind === 'foreground') this.activeForeground += 1
    this.metricsState.admitted += 1
    this.metricsState.admittedQueueWaitMs += queuedForMs
    this.metricsState.maxAdmittedQueueWaitMs = Math.max(
      this.metricsState.maxAdmittedQueueWaitMs,
      queuedForMs
    )
    this.recordHighWaterMarks()
    this.emitAdmissionSpan(waiter.identity, queuedForMs, 'admitted')

    const lease: EnsembleHostAdmissionLease = Object.freeze({
      identity: waiter.identity,
      admittedAt,
      queuedForMs,
      claim: () => this.claim(waiter.identity.runId, token),
      release: () => this.release(waiter.identity.runId, token)
    })
    waiter.resolve({ kind: 'admitted', lease })
  }

  private claim(runId: string, token: symbol): boolean {
    const active = this.activeByRunId.get(runId)
    if (!active || active.token !== token) return false
    active.claimed = true
    return true
  }

  private release(runId: string, token: symbol): boolean {
    const active = this.activeByRunId.get(runId)
    if (!active || active.token !== token) return false
    this.activeByRunId.delete(runId)
    if (active.kind === 'foreground') this.activeForeground -= 1
    this.metricsState.released += 1
    this.notifyIdle()
    this.scheduleDrain()
    return true
  }

  private drainAvailable(): void {
    while (!this.shuttingDown) {
      const waiter = this.takeNextEligible()
      if (!waiter) return
      this.admit(waiter)
    }
  }

  private drainOne(): void {
    if (this.shuttingDown) return
    const waiter = this.takeNextEligible()
    if (waiter) this.admit(waiter)
  }

  private scheduleDrain(): void {
    if (this.shuttingDown || this.drainScheduled || !this.hasEligibleWaiter()) return
    this.drainScheduled = true
    try {
      this.scheduleTask(() => {
        this.drainScheduled = false
        this.drainOne()
        this.scheduleDrain()
      })
    } catch {
      // An injected scheduling seam must not strand accepted work. The fallback
      // loses pacing but preserves admission and fairness.
      this.drainScheduled = false
      this.drainAvailable()
    }
  }

  private occupancy(): EnsembleHostAdmissionOccupancy {
    let queuedForeground = 0
    for (const waiter of this.queuedByRunId.values()) {
      if (waiter.identity.kind === 'foreground') queuedForeground += 1
    }
    return {
      maxActive: this.maxActive,
      maxForeground: this.maxForeground,
      reservedLaneSlots: this.maxActive - this.maxForeground,
      maxQueued: this.maxQueued,
      active: this.activeByRunId.size,
      activeForeground: this.activeForeground,
      activeLanes: this.activeByRunId.size - this.activeForeground,
      queued: this.queuedByRunId.size,
      queuedForeground,
      queuedLanes: this.queuedByRunId.size - queuedForeground,
      shuttingDown: this.shuttingDown
    }
  }

  private rejection(
    code: EnsembleHostAdmissionRejectionCode,
    message: string
  ): EnsembleHostAdmissionRejection {
    return { kind: 'rejected', code, message, occupancy: this.occupancy() }
  }

  private recordHighWaterMarks(): void {
    this.metricsState.peakActive = Math.max(this.metricsState.peakActive, this.activeByRunId.size)
    this.metricsState.peakQueued = Math.max(this.metricsState.peakQueued, this.queuedByRunId.size)
  }

  private notifyIdle(): void {
    if (this.activeByRunId.size > 0 || this.queuedByRunId.size > 0) return
    const waiters = [...this.idleWaiters]
    this.idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}
