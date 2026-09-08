import {
  HostPersistenceDiagnostics,
  type HostPersistenceDiagnosticOptions,
  type HostPersistenceObservationOperation,
  type HostThreadRecordPersistInput,
  type HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'

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
 */

export type HostChatCompatibilityStageResult =
  | 'staged'
  | 'replaced'
  | 'duplicate'
  | 'stale'
  | 'blocked'

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

interface CompatibilityEntry {
  input: HostThreadRecordPersistInput
  sequence: number
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
}

function persistenceRevision(input: HostThreadRecordPersistInput): number {
  const revision = input.record.persistenceRevision
  if (Number.isSafeInteger(revision) && (revision ?? -1) >= 0) return revision!
  return input.expectedRevision
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
    deleted: false
  }
}

export class HostChatCompatibilityPersistence {
  private readonly port: HostChatCompatibilityPersistencePort
  private readonly diagnostics?: HostPersistenceDiagnostics
  private readonly states = new Map<string, ChatCompatibilityState>()
  private nextSequence = 1
  private closing = false
  private closed = false
  private shutdownPromise: Promise<void> | null = null

  constructor(
    port: HostChatCompatibilityPersistencePort,
    options: HostPersistenceDiagnosticOptions = {}
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
  }

  /**
   * Retain the latest record by reference. Repeated calls do no filesystem,
   * transport, hashing, or serialization work.
   */
  stage(input: HostThreadRecordPersistInput): HostChatCompatibilityStageResult {
    validateInput(input)
    const state = this.stateFor(input.chatId)
    if (this.closing || this.closed || state.deleting || state.deleted) {
      this.observeStage(input, 'blocked')
      return 'blocked'
    }

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
      this.observeStage(input, 'duplicate')
      return 'duplicate'
    }

    const sequence = this.nextSequence++
    if (state.pending) {
      const previousSequence = state.pending.sequence
      // Keep the first Host CAS base while replacing only the full-record
      // reference. The body is never spread or cloned here.
      state.pending = {
        input: {
          chatId: input.chatId,
          record: input.record,
          expectedRevision: state.pending.input.expectedRevision,
          ...(input.diagnosticContext ? { diagnosticContext: input.diagnosticContext } : {})
        },
        sequence
      }
      this.observeStage(state.pending.input, 'replaced', sequence, previousSequence)
      return 'replaced'
    }

    state.pending = { input, sequence }
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
    state.pending = null
    state.submitted = entry
    state.materializeAfterSubmitted = false
    const observation = this.diagnostics?.begin('materialize', {
      chatId,
      parentOperationId: barrierOperationId,
      context: entry.input.diagnosticContext,
      sequence: entry.sequence,
      expectedRevision: entry.input.expectedRevision
    })
    try {
      this.port.enqueue(
        observation && this.diagnostics
          ? {
              ...entry.input,
              diagnosticContext: this.diagnostics.context(
                entry.input.diagnosticContext,
                observation.operationId
              )
            }
          : entry.input
      )
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
    const priorContext = (state.pending ?? state.submitted)?.input.diagnosticContext
    if (!input.diagnosticContext && priorContext)
      input = { ...input, diagnosticContext: priorContext }

    if (state.submitted) {
      const latestSequence = Math.max(
        state.submitted.sequence,
        state.pending?.sequence ?? state.submitted.sequence
      )
      this.diagnostics?.event('rebase', 'succeeded', {
        chatId: input.chatId,
        context: input.diagnosticContext,
        sequence: latestSequence,
        relatedSequence: state.submitted.sequence,
        expectedRevision: input.expectedRevision
      })
      // Mutate the existing entry rather than replacing it: settleSubmitted
      // captured this identity before the injected drain entered Host recovery.
      state.submitted.input = input
      state.submitted.sequence = latestSequence
      state.pending = null
      state.materializeAfterSubmitted = false
      return true
    }

    if (!state.pending) return false
    state.pending = { input, sequence: state.pending.sequence }
    this.diagnostics?.event('rebase', 'succeeded', {
      chatId: input.chatId,
      context: input.diagnosticContext,
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
    return true
  }

  hasUnconfirmed(chatId: string): boolean {
    validateChatId(chatId)
    const state = this.states.get(chatId)
    return Boolean(state?.pending || state?.submitted)
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
      try {
        this.materialize(chatId)
      } catch {
        // materialize restored the pending reference; a barrier/shutdown retries.
      }
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
      context: (state.pending ?? state.submitted)?.input.diagnosticContext,
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
        context: input.diagnosticContext,
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

    const settlement = Promise.resolve()
      .then(() => this.port.drain(chatId))
      .then(() => {
        if (state.submitted !== submitted) return
        state.durableSequence = Math.max(state.durableSequence, submitted.sequence)
        state.durableRevision = persistenceRevision(submitted.input)
        state.submitted = null
        if (state.materializeAfterSubmitted && state.pending && !state.deleting && !state.deleted) {
          try {
            this.materialize(chatId)
          } catch {
            // The pending reference was restored; a later barrier retries it.
          }
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
      input: {
        chatId: state.pending.input.chatId,
        record: state.pending.input.record,
        expectedRevision: entry.input.expectedRevision,
        ...(state.pending.input.diagnosticContext
          ? { diagnosticContext: state.pending.input.diagnosticContext }
          : {})
      },
      sequence: state.pending.sequence
    }
  }

  private async runShutdown(): Promise<void> {
    const active = [...this.states.values()].flatMap((state) =>
      [state.activeBarrier?.promise, state.deletePromise].filter(
        (promise): promise is Promise<void> => Boolean(promise)
      )
    )
    if (active.length > 0) await Promise.all(active)

    for (;;) {
      for (const [chatId, state] of this.states) {
        if (!state.deleting && !state.deleted) this.materialize(chatId)
      }
      try {
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
  options?: HostPersistenceDiagnosticOptions
): HostChatCompatibilityPersistence {
  return new HostChatCompatibilityPersistence(port, options)
}
