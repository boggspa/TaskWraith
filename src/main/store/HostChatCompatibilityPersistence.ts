import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
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
}

interface ChatCompatibilityState {
  pending: CompatibilityEntry | null
  submitted: CompatibilityEntry | null
  durableSequence: number
  durableRevision: number | null
  settlement: Promise<void> | null
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
    activeBarrier: null,
    deletePromise: null,
    deleting: false,
    deleted: false
  }
}

export class HostChatCompatibilityPersistence {
  private readonly port: HostChatCompatibilityPersistencePort
  private readonly states = new Map<string, ChatCompatibilityState>()
  private nextSequence = 1
  private closing = false
  private closed = false
  private shutdownPromise: Promise<void> | null = null

  constructor(port: HostChatCompatibilityPersistencePort) {
    if (
      !port ||
      typeof port.enqueue !== 'function' ||
      typeof port.drain !== 'function' ||
      typeof port.drainAll !== 'function'
    ) {
      throw new TypeError('Host compatibility persistence requires enqueue and drain ports.')
    }
    this.port = port
  }

  /**
   * Retain the latest record by reference. Repeated calls do no filesystem,
   * transport, hashing, or serialization work.
   */
  stage(input: HostThreadRecordPersistInput): HostChatCompatibilityStageResult {
    validateInput(input)
    const state = this.stateFor(input.chatId)
    if (this.closing || this.closed || state.deleting || state.deleted) return 'blocked'

    const revision = persistenceRevision(input)
    const latest = state.pending ?? state.submitted
    const latestRevision = latest ? persistenceRevision(latest.input) : state.durableRevision
    if (latestRevision !== null && revision < latestRevision) return 'stale'
    if (
      latestRevision !== null &&
      revision === latestRevision &&
      (latest || state.durableSequence > 0)
    ) {
      return 'duplicate'
    }

    const sequence = this.nextSequence++
    if (state.pending) {
      // Keep the first Host CAS base while replacing only the full-record
      // reference. The body is never spread or cloned here.
      state.pending = {
        input: {
          chatId: input.chatId,
          record: input.record,
          expectedRevision: state.pending.input.expectedRevision
        },
        sequence
      }
      return 'replaced'
    }

    state.pending = { input, sequence }
    return 'staged'
  }

  /**
   * Enqueue one pending checkpoint. At most one coordinator-owned checkpoint
   * per chat is unconfirmed at once; a newer staged record remains pending.
   */
  materialize(chatId: string): boolean {
    validateChatId(chatId)
    const state = this.states.get(chatId)
    if (!state || state.deleting || state.deleted || state.submitted || !state.pending) return false

    const entry = state.pending
    state.pending = null
    state.submitted = entry
    try {
      this.port.enqueue(entry.input)
      return true
    } catch (error) {
      state.submitted = null
      this.restoreUnconfirmed(state, entry)
      throw error
    }
  }

  /**
   * Materialize and durably drain everything staged when this barrier was
   * requested. A later barrier with a newer target chains behind the first;
   * equal-target callers share the exact same promise and drain result.
   */
  barrier(chatId: string): Promise<void> {
    validateChatId(chatId)
    const state = this.stateFor(chatId)
    if (state.deleting || state.deleted) {
      return Promise.reject(new Error(`Host compatibility persistence is deleting ${chatId}.`))
    }

    const targetSequence = Math.max(
      state.durableSequence,
      state.submitted?.sequence ?? 0,
      state.pending?.sequence ?? 0
    )
    if (targetSequence <= state.durableSequence) return Promise.resolve()
    if (state.activeBarrier && state.activeBarrier.targetSequence >= targetSequence) {
      return state.activeBarrier.promise
    }

    const predecessor = state.activeBarrier?.promise.catch(() => undefined) ?? Promise.resolve()
    let active: ActiveBarrier
    const promise = predecessor
      .then(() => this.drainThrough(chatId, state, targetSequence))
      .finally(() => {
        if (state.activeBarrier === active) state.activeBarrier = null
      })
    active = { targetSequence, promise }
    state.activeBarrier = active
    return promise
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
    let operation: Promise<void>
    operation = (async () => {
      try {
        if (state.submitted) await this.settleSubmitted(chatId, state)
        else await this.port.drain(chatId)
        // The external history-mutation fence should already block producers;
        // repeat the discard so a misbehaving re-entrant caller cannot survive.
        state.pending = null
        state.deleted = true
      } catch (error) {
        state.pending = null
        if (state.deletePromise === operation) state.deletePromise = null
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
    targetSequence: number
  ): Promise<void> {
    while (state.durableSequence < targetSequence) {
      if (state.deleting || state.deleted) {
        throw new Error(`Host compatibility persistence was deleted before barrier ${chatId}.`)
      }
      if (!state.submitted && !this.materialize(chatId)) {
        throw new Error(`Host compatibility persistence lost its barrier target for ${chatId}.`)
      }
      await this.settleSubmitted(chatId, state)
    }
  }

  private settleSubmitted(chatId: string, state: ChatCompatibilityState): Promise<void> {
    if (state.settlement) return state.settlement
    const submitted = state.submitted
    if (!submitted) return Promise.resolve()

    let settlement: Promise<void>
    settlement = Promise.resolve()
      .then(() => this.port.drain(chatId))
      .then(() => {
        if (state.submitted !== submitted) return
        state.durableSequence = Math.max(state.durableSequence, submitted.sequence)
        state.durableRevision = persistenceRevision(submitted.input)
        state.submitted = null
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
        expectedRevision: entry.input.expectedRevision
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
      this.closed = true
    } catch (error) {
      for (const state of this.states.values()) {
        const submitted = state.submitted
        if (!submitted) continue
        state.submitted = null
        this.restoreUnconfirmed(state, submitted)
      }
      throw error
    }
  }
}

export function createHostChatCompatibilityPersistence(
  port: HostChatCompatibilityPersistencePort
): HostChatCompatibilityPersistence {
  return new HostChatCompatibilityPersistence(port)
}
