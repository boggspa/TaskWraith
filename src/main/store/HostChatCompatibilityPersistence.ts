import {
  HostPersistenceDiagnostics,
  copyHostPersistenceInput,
  type HostPersistenceDiagnosticOptions,
  type HostPersistenceObservationOperation,
  type HostThreadRecordPersistInput,
  type HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import { HOST_MATERIALIZE_MIN_INTERVAL_MS } from './hostChatCompatibilityPolicy'

/**
 * Latest-wins coordination for full-record Host compatibility checkpoints.
 *
 * Incremental chat persistence owns the hot mutation path. This coordinator
 * retains only the latest immutable ChatRecord reference for each chat until a
 * caller explicitly materializes it through `thread.record.persist`. It never
 * clones, serializes, hashes, or inspects transcript/prompt bodies.
 *
 * A pending lineage keeps the FIRST expected Host revision while replacing the
 * record reference with the latest logical revision. That is load-bearing: a
 * sequence of locally durable mutations may advance 3 -> 9 while the Host's
 * compatibility record remains at 3, so the eventual checkpoint must CAS from
 * 3 and atomically publish 9.
 *
 * A successor requested while its predecessor is in flight
 * (`materializeAfterSubmitted`) is chained once the predecessor settles or is
 * acknowledged — but not before `minIntervalMs` has passed since the last
 * enqueue for that chat. Paced only by the Host round trip, that chain
 * re-published a 23 MB record every ~0.4 s on a streaming thread while the
 * journal already carried every mutation. The interval spaces ONLY the chained
 * successor: `barrier`, `prepareDelete` and `shutdown` materialize directly, so
 * an explicit durability edge never waits on it. The clock is stamped only by a
 * successful enqueue; an attempt that found a submission in flight, threw, or
 * was refused before reaching this coordinator never restarts it.
 *
 * A save whose journal append (or detail externalization) failed has the
 * checkpoint as its ONLY durability. Its caller materializes at once, but with
 * a submission in flight that attempt can only latch; the intent therefore
 * travels on the staged entry (`durabilityFallback`), survives replacement by
 * later saves, and the chained successor carrying it bypasses the interval.
 */

export type HostChatCompatibilityStageResult =
  | 'staged'
  | 'replaced'
  | 'duplicate'
  | 'stale'
  | 'blocked'

export interface HostChatCompatibilityStageOptions {
  /** Process-local debt only; never part of the persisted input. */
  readonly detailDependencies?: { awaitDurable(): Promise<void> }
  /**
   * The journal append or detail externalization failed for this save, so
   * the full-record checkpoint is its only durability: a successor carrying
   * this intent is chained without waiting for the minimum interval.
   */
  readonly durabilityFallback?: boolean
}

/**
 * Bound on shutdown drain passes. Each pass materializes every pending
 * checkpoint, drains the port, and marks the submitted ones durable, so a
 * chat needs at most two (a pending record behind an in-flight submission).
 * The loop that used to run unbounded would spin forever should a future
 * change let a pending checkpoint decline to materialize; past this bound it
 * fails loudly naming the chats instead.
 */
export const HOST_COMPATIBILITY_SHUTDOWN_MAX_PASSES = 8

export interface HostChatCompatibilityPersistenceSnapshot {
  pendingChatIds: string[]
  submittedChatIds: string[]
  deletingChatIds: string[]
  closing: boolean
  closed: boolean
}

export type HostChatCompatibilityPersistencePort = Pick<
  HostThreadRecordPersistPort,
  'enqueue' | 'drain' | 'drainAll'
>

export interface HostChatCompatibilityPersistenceOptions extends HostPersistenceDiagnosticOptions {
  /**
   * Minimum wall time between two chained full-record checkpoints for one
   * chat (see the module header). `0` disables the wait; an absent or invalid
   * value takes the policy default. Barriers, delete preparation and shutdown
   * never wait.
   */
  readonly minIntervalMs?: number
  /** Business clock for the interval, independent of the diagnostic clock. */
  readonly nowMs?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

interface CompatibilityEntry {
  detailDependencies?: { awaitDurable(): Promise<void> }
  publication?: Promise<void>
  input: HostThreadRecordPersistInput
  sequence: number
  /** See HostChatCompatibilityStageOptions; sticky until the entry is enqueued. */
  durabilityFallback: boolean
}

interface ActiveBarrier {
  targetSequence: number
  promise: Promise<void>
  observation?: HostPersistenceObservationOperation
}

interface ChatCompatibilityState {
  pending: CompatibilityEntry | null
  submitted: CompatibilityEntry | null
  durableSequence: number
  durableRevision: number | null
  settlement: Promise<void> | null
  materializeAfterSubmitted: boolean
  activeBarrier: ActiveBarrier | null
  deletePromise: Promise<void> | null
  deleting: boolean
  deleted: boolean
  /** Clock of the last successful enqueue; -Infinity until the first one. */
  lastMaterializedAtMs: number
  /** The one armed wait for a chained successor; re-checks the clock on fire. */
  intervalTimer: ReturnType<typeof setTimeout> | null
}

function persistenceRevision(input: HostThreadRecordPersistInput): number {
  const revision = input.record.persistenceRevision
  if (Number.isSafeInteger(revision) && (revision ?? -1) >= 0) return revision!
  return input.expectedRevision
}

function mergeDetailDebts(
  prior: CompatibilityEntry['detailDependencies'],
  next: CompatibilityEntry['detailDependencies']
): CompatibilityEntry['detailDependencies'] {
  if (!prior || prior === next) return next ?? prior
  if (!next) return prior
  return {
    awaitDurable: async () => {
      const results = await Promise.allSettled(
        [prior, next].map((debt) => Promise.resolve().then(() => debt.awaitDurable()))
      )
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) throw new AggregateError(failures, 'Host detail debts failed')
    }
  }
}

function validateInput(input: HostThreadRecordPersistInput): void {
  if (!input || typeof input.chatId !== 'string' || input.chatId.length === 0) {
    throw new TypeError('Host compatibility persistence requires a chat id.')
  }
  if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) {
    throw new TypeError('Host compatibility persistence requires a chat record.')
  }
  if (input.record.appChatId !== input.chatId) {
    throw new TypeError(
      'Host compatibility persistence record identity does not match its chat id.'
    )
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new TypeError('Host compatibility persistence requires a non-negative expected revision.')
  }
}

function validateChatId(chatId: string): void {
  if (typeof chatId !== 'string' || chatId.length === 0) {
    throw new TypeError('Host compatibility persistence requires a chat id.')
  }
}

function createState(): ChatCompatibilityState {
  return {
    pending: null,
    submitted: null,
    durableSequence: 0,
    durableRevision: null,
    settlement: null,
    materializeAfterSubmitted: false,
    activeBarrier: null,
    deletePromise: null,
    deleting: false,
    deleted: false,
    lastMaterializedAtMs: Number.NEGATIVE_INFINITY,
    intervalTimer: null
  }
}

export class HostChatCompatibilityPersistence {
  private readonly port: HostChatCompatibilityPersistencePort
  private readonly diagnostics?: HostPersistenceDiagnostics
  private readonly states = new Map<string, ChatCompatibilityState>()
  private readonly minIntervalMs: number
  private readonly nowMs: () => number
  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private nextSequence = 1
  private closing = false
  private closed = false
  private shutdownPromise: Promise<void> | null = null

  constructor(
    port: HostChatCompatibilityPersistencePort,
    options: HostChatCompatibilityPersistenceOptions = {}
  ) {
    if (
      !port ||
      typeof port.enqueue !== 'function' ||
      typeof port.drain !== 'function' ||
      typeof port.drainAll !== 'function'
    ) {
      throw new TypeError('Host compatibility persistence requires enqueue and drain ports.')
    }
    this.port = port
    this.diagnostics =
      typeof options.observer === 'function'
        ? new HostPersistenceDiagnostics('compatibility', options)
        : undefined
    this.minIntervalMs =
      Number.isFinite(options.minIntervalMs) && (options.minIntervalMs ?? -1) >= 0
        ? Math.floor(options.minIntervalMs!)
        : HOST_MATERIALIZE_MIN_INTERVAL_MS
    this.nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now()
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /**
   * Retain the latest record by reference. Repeated calls do no filesystem,
   * transport, hashing, or serialization work.
   */
  stage(
    input: HostThreadRecordPersistInput,
    options: HostChatCompatibilityStageOptions = {}
  ): HostChatCompatibilityStageResult {
    validateInput(input)
    const state = this.stateFor(input.chatId)
    if (this.closing || this.closed || state.deleting || state.deleted) {
      this.observeStage(input, 'blocked')
      return 'blocked'
    }
    const durabilityFallback = options.durabilityFallback === true

    const revision = persistenceRevision(input)
    const latest = state.pending ?? state.submitted
    const latestRevision = latest ? persistenceRevision(latest.input) : state.durableRevision
    if (latestRevision !== null && revision < latestRevision) {
      this.observeStage(input, 'stale')
      return 'stale'
    }
    if (
      latestRevision !== null &&
      revision === latestRevision &&
      (latest || state.durableSequence > 0)
    ) {
      // The same revision is already pending: that entry publishes this
      // save's state, so it inherits the fallback intent.
      if (latest && durabilityFallback) latest.durabilityFallback = true
      if (latest && options.detailDependencies)
        latest.detailDependencies = mergeDetailDebts(
          latest.detailDependencies,
          options.detailDependencies
        )
      this.observeStage(input, 'duplicate')
      return 'duplicate'
    }

    const sequence = this.nextSequence++
    if (state.pending) {
      const previousSequence = state.pending.sequence
      // Keep the first Host CAS base while replacing only the full-record
      // reference. The body is never spread or cloned here. The replacing
      // record contains the earlier save's state, so the intent is sticky.
      state.pending = {
        input: copyHostPersistenceInput(input, {
          expectedRevision: state.pending.input.expectedRevision,
          diagnostics: this.diagnostics
        }),
        sequence,
        detailDependencies: mergeDetailDebts(
          state.pending.detailDependencies,
          options.detailDependencies
        ),
        durabilityFallback: state.pending.durabilityFallback || durabilityFallback
      }
      this.observeStage(state.pending.input, 'replaced', sequence, previousSequence)
      return 'replaced'
    }

    state.pending = {
      input,
      sequence,
      durabilityFallback,
      detailDependencies: options.detailDependencies
    }
    this.observeStage(input, 'staged', sequence)
    return 'staged'
  }

  /**
   * Enqueue one pending checkpoint. At most one coordinator-owned checkpoint
   * per chat is unconfirmed at once; a newer staged record remains pending.
   */
  materialize(chatId: string, barrierOperationId?: string | null): boolean {
    validateChatId(chatId)
    const state = this.states.get(chatId)
    if (!state || state.deleting || state.deleted || !state.pending) return false
    if (state.submitted) {
      state.materializeAfterSubmitted = true
      return false
    }

    const entry = state.pending
    // Read the interval clock before any custody change so a throwing clock
    // leaves the lineage untouched; it is only stamped once enqueue succeeds.
    const now = this.nowMs()
    // Snapshot optional metadata before changing custody. A failed diagnostic
    // read cannot create a submitted checkpoint that never crossed enqueue.
    const prepared = this.diagnostics
      ? copyHostPersistenceInput(entry.input, { diagnostics: this.diagnostics })
      : entry.input
    const observation = this.diagnostics?.begin('materialize', {
      chatId,
      parentOperationId: barrierOperationId,
      context: this.diagnostics.contextFrom(prepared),
      sequence: entry.sequence,
      expectedRevision: entry.input.expectedRevision
    })
    const submission =
      observation && this.diagnostics
        ? copyHostPersistenceInput(prepared, {
            diagnostics: this.diagnostics,
            lineageId: observation.operationId
          })
        : prepared
    state.pending = null
    state.submitted = entry
    state.materializeAfterSubmitted = false
    if (entry.detailDependencies) {
      entry.publication = Promise.resolve()
        .then(() => entry.detailDependencies!.awaitDurable())
        .then(() => {
          if (state.submitted !== entry || state.deleting || state.deleted) {
            throw new Error('Host detail publication lineage changed before submission')
          }
          this.port.enqueue(submission)
          state.lastMaterializedAtMs = now
          this.clearIntervalTimer(state)
          observation?.finish('succeeded')
        })
        .catch((error) => {
          if (state.submitted === entry) {
            state.submitted = null
            this.restoreUnconfirmed(state, entry)
          }
          observation?.finish('failed')
          throw error
        })
      void entry.publication.catch(() => {})
      return true
    }
    try {
      this.port.enqueue(submission)
      // The successful enqueue is the only event that restarts the interval;
      // an armed successor wait is moot because the pending slot it guarded
      // has just been consumed.
      state.lastMaterializedAtMs = now
      this.clearIntervalTimer(state)
      observation?.finish('succeeded')
      return true
    } catch (error) {
      state.submitted = null
      this.restoreUnconfirmed(state, entry)
      state.materializeAfterSubmitted = true
      observation?.finish('failed')
      throw error
    }
  }

  /**
   * Replace a coordinator-owned unconfirmed lineage after Host CAS recovery.
   * The recovery record already contains every staged Desktop intent, so any
   * newer pending slot is subsumed and must not survive to overwrite it later.
   * Returns false when the Host operation was not owned by this coordinator.
   */
  rebase(input: HostThreadRecordPersistInput): boolean {
    validateInput(input)
    const state = this.states.get(input.chatId)
    if (!state) return false
    input = copyHostPersistenceInput(input, {
      diagnostics: this.diagnostics,
      fallback: (state.pending ?? state.submitted)?.input,
      preserveInput: true
    })

    if (state.submitted) {
      const latestSequence = Math.max(
        state.submitted.sequence,
        state.pending?.sequence ?? state.submitted.sequence
      )
      this.diagnostics?.event('rebase', 'succeeded', {
        chatId: input.chatId,
        context: this.diagnostics.contextFrom(input),
        sequence: latestSequence,
        relatedSequence: state.submitted.sequence,
        expectedRevision: input.expectedRevision
      })
      // Mutate the existing entry rather than replacing it: settleSubmitted
      // captured this identity before the injected drain entered Host recovery.
      state.submitted.input = input
      state.submitted.sequence = latestSequence
      state.submitted.durabilityFallback ||= state.pending?.durabilityFallback === true
      state.submitted.detailDependencies = mergeDetailDebts(
        state.submitted.detailDependencies,
        state.pending?.detailDependencies
      )
      state.pending = null
      state.materializeAfterSubmitted = false
      this.clearIntervalTimer(state)
      return true
    }

    if (!state.pending) return false
    state.pending = {
      input,
      sequence: state.pending.sequence,
      detailDependencies: state.pending.detailDependencies,
      durabilityFallback: state.pending.durabilityFallback
    }
    this.diagnostics?.event('rebase', 'succeeded', {
      chatId: input.chatId,
      context: this.diagnostics.contextFrom(input),
      sequence: state.pending.sequence,
      expectedRevision: input.expectedRevision
    })
    return true
  }

  /**
   * Drop only work that has not crossed the injected enqueue boundary. An
   * already-submitted record must be drained or superseded by the Host delete
   * port; reporting it discarded here would create a resurrection race.
   */
  discard(chatId: string): boolean {
    validateChatId(chatId)
    const state = this.states.get(chatId)
    if (!state || state.submitted || !state.pending) return false
    state.pending = null
    state.materializeAfterSubmitted = false
    this.clearIntervalTimer(state)
    return true
  }

  hasUnconfirmed(chatId: string): boolean {
    validateChatId(chatId)
    const state = this.states.get(chatId)
    return Boolean(state?.pending || state?.submitted)
  }

  /** A save without a durable journal copy still needs its Host acknowledgement. */
  hasDurabilityFallback(chatId: string): boolean {
    validateChatId(chatId)
    const state = this.states.get(chatId)
    return Boolean(state?.pending?.durabilityFallback || state?.submitted?.durabilityFallback)
  }

  hasSubmitted(chatId: string): boolean {
    validateChatId(chatId)
    return Boolean(this.states.get(chatId)?.submitted)
  }

  latestSequence(chatId: string): number {
    validateChatId(chatId)
    const state = this.states.get(chatId)
    return Math.max(
      state?.durableSequence ?? 0,
      state?.submitted?.sequence ?? 0,
      state?.pending?.sequence ?? 0
    )
  }

  /**
   * Observe an exact Host success (or a newer Host record read) without waiting
   * for a later explicit drain. This releases the submitted slot so a terminal
   * save can materialize its successor even when no barrier occurred between
   * the two saves.
   */
  acknowledgeRevision(chatId: string, revision: number): boolean {
    validateChatId(chatId)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError('Host compatibility acknowledgement requires a valid revision.')
    }
    const state = this.states.get(chatId)
    if (!state) return false
    const submitted = state.submitted
    if (!submitted) {
      if (!state.pending) state.durableRevision = revision
      return false
    }
    if (revision < persistenceRevision(submitted.input)) return false
    state.durableSequence = Math.max(state.durableSequence, submitted.sequence)
    state.durableRevision = revision
    state.submitted = null
    if (state.materializeAfterSubmitted && state.pending && !state.deleting && !state.deleted) {
      this.materializeSuccessor(chatId, state)
    }
    return true
  }

  /**
   * Materialize and durably drain everything staged when this barrier was
   * requested. A later barrier with a newer target chains behind the first;
   * equal-target callers share the exact same promise and drain result.
   * Diagnostics measure this shared lower barrier (including predecessor wait),
   * not each joining caller or the outer AppStore recovery/materialization path.
   */
  barrier(chatId: string): Promise<void> {
    validateChatId(chatId)
    const state = this.stateFor(chatId)
    if (state.deleting || state.deleted) {
      this.diagnostics?.event('barrier_rejected', 'failed', { chatId, reason: 'deleting' })
      return Promise.reject(new Error(`Host compatibility persistence is deleting ${chatId}.`))
    }

    const targetSequence = Math.max(
      state.durableSequence,
      state.submitted?.sequence ?? 0,
      state.pending?.sequence ?? 0
    )
    if (targetSequence <= state.durableSequence) {
      this.diagnostics?.event('barrier_quiet', 'skipped', { chatId, sequence: targetSequence })
      return Promise.resolve()
    }
    if (state.activeBarrier && state.activeBarrier.targetSequence >= targetSequence) {
      this.diagnostics?.event('barrier_join', 'joined', {
        chatId,
        sequence: targetSequence,
        relatedOperationId: state.activeBarrier.observation?.operationId
      })
      return state.activeBarrier.promise
    }

    const observation = this.diagnostics?.begin('barrier', {
      chatId,
      sequence: targetSequence,
      context: this.diagnostics.contextFrom((state.pending ?? state.submitted)?.input),
      relatedOperationId: state.activeBarrier?.observation?.operationId
    })
    const predecessor = state.activeBarrier?.promise.catch(() => undefined) ?? Promise.resolve()
    const active: ActiveBarrier = {
      targetSequence,
      ...(observation ? { observation } : {}),
      promise: predecessor
        .then(() => this.drainThrough(chatId, state, targetSequence, observation))
        .finally(() => {
          if (state.activeBarrier === active) state.activeBarrier = null
        })
    }
    state.activeBarrier = active
    return active.promise
  }

  /**
   * Fence new staging, discard the not-yet-enqueued record, and settle any
   * already-enqueued checkpoint before the caller issues its Host delete.
   * Concurrent callers share one operation. A failed drain remains retryable.
   */
  prepareDelete(chatId: string): Promise<void> {
    validateChatId(chatId)
    const state = this.stateFor(chatId)
    if (state.deleted) return Promise.resolve()
    if (state.deletePromise) return state.deletePromise

    state.deleting = true
    state.pending = null
    state.materializeAfterSubmitted = false
    this.clearIntervalTimer(state)
    const operation = (async () => {
      try {
        if (state.submitted) await this.settleSubmitted(chatId, state)
        else await this.port.drain(chatId)
        // The external history-mutation fence should already block producers;
        // repeat the discard so a misbehaving re-entrant caller cannot survive.
        state.pending = null
        state.materializeAfterSubmitted = false
        state.deleted = true
      } catch (error) {
        state.pending = null
        // No competing delete can replace this promise: prepareDelete returns
        // the existing one above. Clearing unconditionally keeps the failure
        // retryable and avoids a self-reference during initialization.
        state.deletePromise = null
        throw error
      }
    })()
    state.deletePromise = operation
    return operation
  }

  /**
   * Materialize every pending chat once, then drain the injected Host port.
   * New staging is refused from the instant shutdown begins. Repeated callers
   * receive the same promise, so shutdown can never enqueue the same record
   * twice.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    this.shutdownPromise = this.runShutdown()
    return this.shutdownPromise
  }

  snapshot(): HostChatCompatibilityPersistenceSnapshot {
    const pendingChatIds: string[] = []
    const submittedChatIds: string[] = []
    const deletingChatIds: string[] = []
    for (const [chatId, state] of this.states) {
      if (state.pending) pendingChatIds.push(chatId)
      if (state.submitted) submittedChatIds.push(chatId)
      if (state.deleting || state.deleted) deletingChatIds.push(chatId)
    }
    return {
      pendingChatIds: pendingChatIds.sort(),
      submittedChatIds: submittedChatIds.sort(),
      deletingChatIds: deletingChatIds.sort(),
      closing: this.closing,
      closed: this.closed
    }
  }

  private observeStage(
    input: HostThreadRecordPersistInput,
    reason: HostChatCompatibilityStageResult,
    sequence?: number,
    relatedSequence?: number
  ): void {
    this.diagnostics?.event(
      'stage',
      reason === 'staged' || reason === 'replaced' ? 'pending' : 'skipped',
      {
        chatId: input.chatId,
        context: this.diagnostics.contextFrom(input),
        expectedRevision: input.expectedRevision,
        sequence,
        relatedSequence,
        reason
      }
    )
  }

  private stateFor(chatId: string): ChatCompatibilityState {
    const existing = this.states.get(chatId)
    if (existing) return existing
    const state = createState()
    this.states.set(chatId, state)
    return state
  }

  private async drainThrough(
    chatId: string,
    state: ChatCompatibilityState,
    targetSequence: number,
    observation?: HostPersistenceObservationOperation
  ): Promise<void> {
    try {
      while (state.durableSequence < targetSequence) {
        if (state.deleting || state.deleted) {
          throw new Error(`Host compatibility persistence was deleted before barrier ${chatId}.`)
        }
        if (!state.submitted && !this.materialize(chatId, observation?.operationId)) {
          throw new Error(`Host compatibility persistence lost its barrier target for ${chatId}.`)
        }
        await this.settleSubmitted(chatId, state)
      }
      observation?.finish('succeeded')
    } catch (error) {
      observation?.finish('failed')
      throw error
    }
  }

  private settleSubmitted(chatId: string, state: ChatCompatibilityState): Promise<void> {
    if (state.settlement) return state.settlement
    const submitted = state.submitted
    if (!submitted) return Promise.resolve()

    const settlement = (submitted.publication ?? Promise.resolve())
      .then(() => this.port.drain(chatId))
      .then(() => {
        if (state.submitted !== submitted) return
        state.durableSequence = Math.max(state.durableSequence, submitted.sequence)
        state.durableRevision = persistenceRevision(submitted.input)
        state.submitted = null
        if (state.materializeAfterSubmitted && state.pending && !state.deleting && !state.deleted) {
          this.materializeSuccessor(chatId, state)
        }
      })
      .catch((error) => {
        if (state.submitted === submitted) {
          state.submitted = null
          this.restoreUnconfirmed(state, submitted)
        }
        throw error
      })
      .finally(() => {
        if (state.settlement === settlement) state.settlement = null
      })
    state.settlement = settlement
    return settlement
  }

  /**
   * Chain the successor a settled or acknowledged predecessor left pending,
   * waiting out the remainder of the minimum interval since the last enqueue.
   * One armed wait per chat; it re-reads the clock when it fires, so a barrier
   * enqueue in between (which re-stamps the clock) is honoured, and a delete,
   * discard, rebase or shutdown in between cancels it. The direct
   * `materialize` callers — barrier, delete, shutdown — never come through here.
   *
   * Two successors never wait: one carrying a durability-fallback intent (the
   * journal failed, so the checkpoint is that save's only durability), and any
   * successor once shutdown has begun. The latter is the ONE shutdown guard:
   * the drain loop consumes (and thereby clears the wait of) every pending
   * checkpoint it can materialize, and once `closing` is set nothing can arm
   * a new wait, so a checkpoint can never park behind the drain.
   */
  private materializeSuccessor(chatId: string, state: ChatCompatibilityState): void {
    if (!state.pending || state.submitted || state.deleting || state.deleted) return
    if (
      this.minIntervalMs > 0 &&
      !state.pending.durabilityFallback &&
      !this.closing &&
      !this.closed
    ) {
      const remainingMs = this.minIntervalMs - (this.nowMs() - state.lastMaterializedAtMs)
      if (remainingMs > 0) {
        this.armIntervalTimer(chatId, state, remainingMs)
        return
      }
    }
    try {
      this.materialize(chatId)
    } catch {
      // materialize restored the pending reference; a barrier/shutdown retries.
    }
  }

  private armIntervalTimer(chatId: string, state: ChatCompatibilityState, delayMs: number): void {
    if (state.intervalTimer !== null) return
    const timer = this.setTimer(() => {
      state.intervalTimer = null
      this.materializeSuccessor(chatId, state)
    }, delayMs)
    ;(timer as { unref?: () => void }).unref?.()
    state.intervalTimer = timer
  }

  private clearIntervalTimer(state: ChatCompatibilityState): void {
    if (state.intervalTimer === null) return
    const timer = state.intervalTimer
    state.intervalTimer = null
    this.clearTimer(timer)
  }

  /** Restore one failed enqueue/drain without replacing a newer record body. */
  private restoreUnconfirmed(state: ChatCompatibilityState, entry: CompatibilityEntry): void {
    if (!state.pending) {
      state.pending = entry
      return
    }
    if (state.pending.sequence <= entry.sequence) {
      state.pending = entry
      return
    }
    state.pending = {
      input: copyHostPersistenceInput(state.pending.input, {
        expectedRevision: entry.input.expectedRevision,
        diagnostics: this.diagnostics
      }),
      sequence: state.pending.sequence,
      durabilityFallback: state.pending.durabilityFallback || entry.durabilityFallback,
      detailDependencies: mergeDetailDebts(
        entry.detailDependencies,
        state.pending.detailDependencies
      )
    }
  }

  private async runShutdown(): Promise<void> {
    const active = [...this.states.values()].flatMap((state) =>
      [state.activeBarrier?.promise, state.deletePromise].filter(
        (promise): promise is Promise<void> => Boolean(promise)
      )
    )
    if (active.length > 0) await Promise.all(active)

    for (let pass = 1; ; pass += 1) {
      if (pass > HOST_COMPATIBILITY_SHUTDOWN_MAX_PASSES) {
        const stuck = [...this.states]
          .filter(
            ([, state]) => !state.deleting && !state.deleted && (state.pending || state.submitted)
          )
          .map(([chatId]) => chatId)
          .sort()
        throw new Error(
          `Host compatibility shutdown made no progress after ${HOST_COMPATIBILITY_SHUTDOWN_MAX_PASSES} ` +
            `drain passes; unconfirmed chats: ${stuck.join(', ')}`
        )
      }
      for (const [chatId, state] of this.states) {
        if (!state.deleting && !state.deleted) this.materialize(chatId)
      }
      try {
        await Promise.all(
          [...this.states.values()].flatMap((state) =>
            state.submitted?.publication ? [state.submitted.publication] : []
          )
        )
        await this.port.drainAll()
        for (const state of this.states.values()) {
          const submitted = state.submitted
          if (!submitted) continue
          state.durableSequence = Math.max(state.durableSequence, submitted.sequence)
          state.durableRevision = persistenceRevision(submitted.input)
          state.submitted = null
        }
      } catch (error) {
        for (const state of this.states.values()) {
          const submitted = state.submitted
          if (!submitted) continue
          state.submitted = null
          this.restoreUnconfirmed(state, submitted)
        }
        throw error
      }
      const remaining = [...this.states.values()].some(
        (state) => !state.deleting && !state.deleted && (state.pending || state.submitted)
      )
      if (!remaining) break
    }
    this.closed = true
  }
}

export function createHostChatCompatibilityPersistence(
  port: HostChatCompatibilityPersistencePort,
  options?: HostChatCompatibilityPersistenceOptions
): HostChatCompatibilityPersistence {
  return new HostChatCompatibilityPersistence(port, options)
}
