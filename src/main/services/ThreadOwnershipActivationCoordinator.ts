/**
 * Desktop ownership activation for one thread at a time.
 *
 * A grant from the Host is not permission to append. Before the first owned
 * append the coordinator freezes the admitted head, shows that exact head
 * reached the Host, takes the claim, and writes and syncs the authority mark;
 * only then does it turn owned appends on and replay what the queue still
 * holds. Any failure before that point undoes what it did and hands the queued
 * intents back, so the caller decides whether to try again. Nothing here
 * widens what a user may do: it only ever declines to activate.
 *
 * Every collaborator arrives through the constructor. The coordinator reads no
 * environment variable and opens no connection; the composition root decides
 * whether activation is on and supplies the claim on the one authenticated
 * connection the Host granted it on.
 */
import { randomUUID } from 'node:crypto'
import type {
  HostThreadPublicationBinding,
  HostThreadPublicationGuard
} from '../../host-runtime/HostThreadPublicationGuard'
import type { ThreadAuthorityFiles } from '../../host-shared/thread-log/ThreadAuthorityFile'
import type { ThreadOwnershipReservation } from '../../host-shared/thread-log/ThreadOwnership'
import {
  persistIdempotencyKeyFor,
  type ChatSaveIntent,
  type ChatSaveOwnershipPort,
  type PerChatSaveIntentQueue
} from '../../shared/chatSaveIntentQueue'
import type {
  HostOwnershipReceiptEvidenceStore,
  ThreadOwnershipReceiptEvidence
} from '../host/HostOwnershipReceiptEvidenceStore'

export type ThreadOwnershipActivationFailure =
  | 'reservation_invalid'
  | 'publication_not_confirmed'
  | 'mark_write_failed'
  | 'switch_failed'
  | 'drain_failed'

export type ThreadOwnershipActivationResult =
  | {
      readonly kind: 'activated'
      readonly drained: number
      /** Receipts that could not be recorded; the appends themselves stand. */
      readonly receiptFaults: number
    }
  | {
      readonly kind: 'failed'
      readonly reason: ThreadOwnershipActivationFailure
      /** Intents handed back, oldest first. None of them reached the owned journal. */
      readonly pending: ChatSaveIntent[]
      /** Cleanup steps that themselves failed; empty when the rollback was clean. */
      readonly faults: readonly string[]
      /**
       * True only when an owned append had already committed, so the mark and
       * switch were kept: removing them would hide unpublished owned rows.
       */
      readonly ownershipRetained: boolean
    }

export interface ThreadOwnershipActivationOptions {
  readonly queue: PerChatSaveIntentQueue
  readonly registry: {
    /** Claims on the same authenticated connection the Host granted on. */
    claim(threadId: string): Promise<ThreadOwnershipReservation>
    release?(reservation: ThreadOwnershipReservation): void | Promise<void>
  }
  readonly publicationGuard: Pick<HostThreadPublicationGuard, 'capture' | 'publish'>
  /** The exact connection and grant the confirmation is read under. */
  bindingFor(chatId: string): HostThreadPublicationBinding
  readonly authorityFile: Pick<ThreadAuthorityFiles, 'remove'>
  /** Writes and syncs the authority mark atomically. */
  markWriter(chatId: string, reservation: ThreadOwnershipReservation): Promise<void>
  readonly receiptStore: Pick<HostOwnershipReceiptEvidenceStore, 'record'>
  readonly authoritySwitch: { enable(): void; disable(): void }
  /** Evidence for an exact command handle; null when none is held. */
  readonly commandHandleStore: {
    get(commandId: string): ThreadOwnershipReceiptEvidence | null
  }
  /**
   * One owned-journal append, resolved once the owned journal's barrier has
   * confirmed it. Idempotent by the intent's command handle, so a retry after
   * an ambiguous failure cannot apply twice.
   */
  ownedAppend(
    intent: ChatSaveIntent,
    reservation: ThreadOwnershipReservation
  ): Promise<ThreadOwnershipReceiptEvidence>
  /**
   * Whether history erasure is fencing the chat. Polled between activation
   * steps and between owned appends, so an activation that started before the
   * fence stops instead of appending into an erased chat. A throw reads as
   * erasing: an unreadable fence must not let an append through.
   */
  erasing?(chatId: string): boolean
  /**
   * Whether the chat holds owned rows beyond what this process appended, such
   * as rows from before a restart. `deactivate` keeps the mark while any exist.
   */
  hasOwnedRows?(chatId: string): boolean | Promise<boolean>
  /** How long `deactivate` waits for an activation already in flight. */
  readonly erasureFenceTimeoutMs?: number
}

export const DEFAULT_ERASURE_FENCE_TIMEOUT_MS = 5_000

export class ThreadOwnershipActivationCoordinator {
  /** Active chats and the reservation each activated under. */
  private readonly active = new Map<string, ThreadOwnershipReservation>()
  /** Chats that hold the shared authority switch: in flight or active. */
  private readonly holders = new Set<string>()
  private readonly inFlight = new Map<string, Promise<ThreadOwnershipActivationResult>>()
  /** Erasure invalidates an attempt before joining it, including a timed-out join. */
  private readonly erased = new Set<string>()
  /** Chats this process committed an owned append for; their mark must outlive a deactivate. */
  private readonly ownedCommitted = new Set<string>()
  /** Chats whose mark a failed `deactivate` could not remove, so a retry finishes the job. */
  private readonly markRemovalOwed = new Set<string>()

  constructor(private readonly options: ThreadOwnershipActivationOptions) {}

  /**
   * Active only while the reservation still holds: a grant the Host revoked
   * (socket lost, Host restarted) or a lineage that ended is not ownership. A
   * lapsed chat is taken out of `active` at once, so its saves go back to
   * waiting for Host storage; the mark stays (owned rows may sit above the
   * Host's copy) until a fresh activation confirms a newer head and claims.
   */
  isActive(chatId: string): boolean {
    const reservation = this.active.get(chatId)
    if (!reservation) return false
    try {
      reservation.revalidate()
      return true
    } catch {
      this.lapse(chatId, reservation)
      return false
    }
  }

  /**
   * An owned save the owned journal confirmed outside replay (in `saveChat`).
   * It sits above the Host's copy, so the mark must survive a later rollback
   * or deactivation until a Host publication covers it again.
   */
  noteOwnedCommit(chatId: string): void {
    if (this.active.has(chatId)) this.ownedCommitted.add(chatId)
  }

  private lapse(chatId: string, reservation: ThreadOwnershipReservation): void {
    if (this.active.get(chatId) !== reservation) return
    this.active.delete(chatId)
    this.holders.delete(chatId)
    // The mark stays for now; erasure (`deactivate`) still owes its removal,
    // judged then against the owned rows it covers.
    this.markRemovalOwed.add(chatId)
    if (this.holders.size === 0) {
      try {
        this.options.authoritySwitch.disable()
      } catch {
        // The switch is advisory here; the lapse itself is what stops owned appends.
      }
    }
    const release = this.options.registry.release
    if (release) void Promise.resolve(release(reservation)).catch(() => undefined)
  }

  /**
   * Activate ownership for one chat, or, when it is already active, replay the
   * intents queued since. Concurrent calls for a chat share one attempt.
   */
  activate(chatId: string): Promise<ThreadOwnershipActivationResult> {
    const running = this.inFlight.get(chatId)
    if (running) return running
    const attempt = this.run(chatId).finally(() => this.inFlight.delete(chatId))
    this.inFlight.set(chatId, attempt)
    return attempt
  }

  /**
   * Take a chat out of ownership because its history is being erased. Waits
   * for an activation already in flight (bounded by `erasureFenceTimeoutMs`),
   * drops the queue's pending intents, removes the mark, releases the
   * reservation and gives the shared switch back. The mark goes before the
   * release message: a mark still on disk names a live writer and keeps the
   * thread for it. It is removed only when no owned rows exist; rows the Host
   * has not seen must stay discoverable. Idempotent: a chat that is not
   * active, and owes no mark removal, is a no-op. Throws once cleanup has run
   * if any part of it failed, so the caller's erasure step is retried.
   */
  async deactivate(chatId: string): Promise<void> {
    this.erased.add(chatId)
    const running = this.inFlight.get(chatId)
    if (running) await this.settleWithin(running)
    const reservation = this.active.get(chatId)
    const wasHolder = this.holders.has(chatId)
    if (!reservation && !wasHolder && !this.markRemovalOwed.has(chatId)) return

    const { queue, authorityFile, authoritySwitch, registry } = this.options
    const faults: string[] = []
    this.active.delete(chatId)
    this.holders.delete(chatId)
    queue.reset(chatId)
    let ownedRows = this.ownedCommitted.has(chatId)
    if (!ownedRows && this.options.hasOwnedRows) {
      try {
        ownedRows = await this.options.hasOwnedRows(chatId)
      } catch {
        // Unknown is not empty: keep the mark rather than hide rows.
        ownedRows = true
        faults.push('owned_rows_unknown')
      }
    }
    if (!ownedRows) {
      try {
        await authorityFile.remove(chatId)
        this.markRemovalOwed.delete(chatId)
      } catch {
        this.markRemovalOwed.add(chatId)
        faults.push('mark_remove_failed')
      }
    }
    if (reservation && registry.release) {
      try {
        await registry.release(reservation)
      } catch {
        faults.push('reservation_release_failed')
      }
    }
    if (wasHolder && this.holders.size === 0) {
      try {
        authoritySwitch.disable()
      } catch {
        faults.push('switch_disable_failed')
      }
    }
    if (faults.length > 0) {
      throw new Error(`Ownership deactivation incomplete: ${faults.join(', ')}`)
    }
  }

  /** Waits for an attempt to settle either way; its own failure is its caller's to handle. */
  private async settleWithin(running: Promise<ThreadOwnershipActivationResult>): Promise<void> {
    const limit = this.options.erasureFenceTimeoutMs ?? DEFAULT_ERASURE_FENCE_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limit)
    })
    const settled = running.then(
      () => 'settled' as const,
      () => 'settled' as const
    )
    const outcome = await Promise.race([settled, timedOut]).finally(() => clearTimeout(timer))
    if (outcome === 'timeout') {
      throw new Error('Ownership activation did not settle before the erasure fence')
    }
  }

  /** Non-blocking: reads the reservation's own flag and the injected fence, and fails closed. */
  private erasingNow(chatId: string, reservation: ThreadOwnershipReservation | null): boolean {
    try {
      if (this.erased.has(chatId)) return true
      reservation?.revalidate()
      return reservation?.erasing() === true || this.options.erasing?.(chatId) === true
    } catch {
      return true
    }
  }

  private async run(chatId: string): Promise<ThreadOwnershipActivationResult> {
    const { queue } = this.options
    // A lapsed reservation is dropped here, and the chat activates afresh.
    if (this.isActive(chatId)) return this.replay(chatId, this.active.get(chatId)!, null)

    const state: Rollback = { reservation: null, markAttempted: false, switchEnabled: false }
    const fail = (reason: ThreadOwnershipActivationFailure, drained: ChatSaveIntent[] = []) =>
      this.rollback(chatId, reason, state, drained)

    if (this.erasingNow(chatId, null)) return fail('reservation_invalid')

    // 1. Freeze the admitted head. With none there is nothing to confirm.
    const head = queue.admittedHead(chatId)
    if (!head) return fail('publication_not_confirmed')
    try {
      queue.freezeHead(chatId, head.revision)
    } catch {
      return fail('publication_not_confirmed')
    }

    // 2. The exact head must already be in the Host's storage.
    if (!(await this.publicationConfirmed(chatId, head.commandId, head.revision))) {
      return fail('publication_not_confirmed')
    }
    // Host storage now holds the head, and every owned save before it: no
    // earlier owned row is above the Host's copy any more.
    this.ownedCommitted.delete(chatId)

    // 3. Claim, then check the reservation still means what it said.
    try {
      const reservation = await this.options.registry.claim(chatId)
      state.reservation = reservation
      if (reservation.threadId !== chatId || reservation.erasing()) {
        return fail('reservation_invalid')
      }
      reservation.revalidate()
    } catch {
      return fail('reservation_invalid')
    }

    // 4. The mark. A write that rejects may still have left a file behind.
    if (this.erasingNow(chatId, state.reservation)) return fail('reservation_invalid')
    try {
      state.markAttempted = true
      await this.options.markWriter(chatId, state.reservation)
    } catch {
      return fail('mark_write_failed')
    }

    // 5. Owned appends on.
    if (this.erasingNow(chatId, state.reservation)) return fail('reservation_invalid')
    try {
      this.holders.add(chatId)
      state.switchEnabled = true
      this.options.authoritySwitch.enable()
    } catch {
      return fail('switch_failed')
    }

    // 6 and 7. Resume flushing, replay, record.
    if (this.erasingNow(chatId, state.reservation)) return fail('reservation_invalid')
    queue.unfreeze(chatId)
    this.active.set(chatId, state.reservation)
    return this.replay(chatId, state.reservation, state)
  }

  /** Append what the queue holds. `state` is null when the chat was already active. */
  private async replay(
    chatId: string,
    reservation: ThreadOwnershipReservation,
    state: Rollback | null
  ): Promise<ThreadOwnershipActivationResult> {
    const { queue, ownedAppend, receiptStore } = this.options
    if (this.erasingNow(chatId, reservation)) {
      return this.finishFailed(chatId, 'reservation_invalid', state, [], 0)
    }
    let drained: ChatSaveIntent[]
    try {
      drained = queue.drain(chatId)
    } catch {
      return this.finishFailed(chatId, 'drain_failed', state, [], 0)
    }
    let committed = 0
    let receiptFaults = 0
    for (let index = 0; index < drained.length; index += 1) {
      const intent = drained[index]
      // Between appends, so an erasure that begins mid-replay stops it with the
      // rest handed back rather than appended into a chat being deleted.
      if (this.erasingNow(chatId, reservation)) {
        return this.finishFailed(
          chatId,
          'reservation_invalid',
          state,
          drained.slice(index),
          committed
        )
      }
      try {
        const evidence = await ownedAppend(intent, reservation)
        if (
          evidence.kind === 'unavailable' ||
          evidence.threadId !== chatId ||
          evidence.commandId !== intent.commandId
        ) {
          throw new Error('Owned append returned evidence for another command')
        }
        committed += 1
        this.ownedCommitted.add(chatId)
        try {
          await receiptStore.record(evidence, { chatId, commandId: intent.commandId })
        } catch {
          receiptFaults += 1
        }
      } catch {
        return this.finishFailed(chatId, 'drain_failed', state, drained.slice(index), committed)
      }
    }
    return { kind: 'activated', drained: committed, receiptFaults }
  }

  private finishFailed(
    chatId: string,
    reason: ThreadOwnershipActivationFailure,
    state: Rollback | null,
    uncommitted: ChatSaveIntent[],
    committed: number
  ): Promise<ThreadOwnershipActivationResult> {
    if (committed > 0 || state === null || this.ownedCommitted.has(chatId)) {
      // Owned rows exist the Host has not seen, or the chat was active before
      // this call (or saved owned since activating): keep the mark and the
      // switch, and put the rest back so a later activate() resumes. Dropping
      // the mark would hide those rows.
      for (const intent of uncommitted.slice().reverse()) this.options.queue.requeue(intent)
      return Promise.resolve({
        kind: 'failed',
        reason,
        pending: [...uncommitted],
        faults: [],
        ownershipRetained: true
      })
    }
    return this.rollback(chatId, reason, state, uncommitted)
  }

  private async rollback(
    chatId: string,
    reason: ThreadOwnershipActivationFailure,
    state: Rollback,
    drained: ChatSaveIntent[]
  ): Promise<ThreadOwnershipActivationResult> {
    const { queue, authorityFile, authoritySwitch, registry } = this.options
    const faults: string[] = []
    const pending = [...drained, ...queue.peek(chatId)]
    queue.reset(chatId)
    if (state.markAttempted) {
      try {
        await authorityFile.remove(chatId)
      } catch {
        faults.push('mark_remove_failed')
      }
    }
    this.active.delete(chatId)
    this.holders.delete(chatId)
    if (state.switchEnabled && this.holders.size === 0) {
      try {
        authoritySwitch.disable()
      } catch {
        faults.push('switch_disable_failed')
      }
    }
    if (state.reservation && registry.release) {
      try {
        await registry.release(state.reservation)
      } catch {
        faults.push('reservation_release_failed')
      }
    }
    return { kind: 'failed', reason, pending, faults, ownershipRetained: false }
  }

  /**
   * Reads the evidence for the head's handle under the guard, so the read and
   * the binding's currency are one step. Only an exact receipt for this thread
   * and this revision counts: a re-anchored copy is not the head.
   */
  private async publicationConfirmed(
    chatId: string,
    commandId: string,
    revision: number
  ): Promise<boolean> {
    try {
      const { publicationGuard, bindingFor, commandHandleStore } = this.options
      const permit = publicationGuard.capture(chatId, bindingFor(chatId))
      const result = await publicationGuard.publish(permit, () => commandHandleStore.get(commandId))
      if (result.kind !== 'published') return false
      const evidence = result.value
      return (
        evidence !== null &&
        evidence.kind === 'exact' &&
        evidence.threadId === chatId &&
        evidence.revision === revision
      )
    } catch {
      return false
    }
  }
}

interface Rollback {
  reservation: ThreadOwnershipReservation | null
  markAttempted: boolean
  switchEnabled: boolean
}

/**
 * Resolves the explicit authored-save / submitted-command association. A receipt
 * at the same revision from a different publication is never enough.
 */
export function createHeadReceiptLookup(options: {
  readonly queue: Pick<PerChatSaveIntentQueue, 'locate' | 'publicationFor'>
  readonly receiptStore: Pick<HostOwnershipReceiptEvidenceStore, 'getLoaded'>
}): { get(commandId: string): ThreadOwnershipReceiptEvidence | null } {
  return {
    get(commandId) {
      const where = options.queue.locate(commandId)
      if (!where) return null
      const publication = options.queue.publicationFor(commandId)
      if (!publication || publication.revision !== where.revision) return null
      const evidence = options.receiptStore.getLoaded(publication.hostCommandId)
      if (
        evidence?.kind === 'exact' &&
        evidence.threadId === where.chatId &&
        evidence.revision === where.revision
      )
        return evidence
      return null
    }
  }
}

/**
 * The two pieces AppStore and the persist client need from ownership: the port
 * `saveChat` consults, and the sink that turns a committed Host receipt into
 * evidence and settles the intents it covers.
 */
export function createChatSaveOwnershipWiring(options: {
  readonly queue: PerChatSaveIntentQueue
  readonly receiptStore: HostOwnershipReceiptEvidenceStore
  readonly coordinator: Pick<ThreadOwnershipActivationCoordinator, 'isActive'>
  readonly mintId?: () => string
  readonly onError?: (error: unknown) => void
  /** Told after a durably recorded exact receipt joined an authored save. */
  readonly onPublicationConfirmed?: (
    chatId: string,
    evidence: ThreadOwnershipReceiptEvidence
  ) => void
  /** Whether the owned journal durably holds a save; absent, owned saves never settle by it. */
  readonly confirmOwnedSave?: (chatId: string, revision: number) => Promise<boolean>
}): {
  readonly port: ChatSaveOwnershipPort
  /** Pass as HostThreadRecordPersistClient's `onPersistedEvidence`. */
  readonly persistedEvidenceSink: (
    input: { readonly chatId: string; readonly ownershipIntentId?: string },
    evidence: ThreadOwnershipReceiptEvidence
  ) => Promise<void>
} {
  const { queue, receiptStore, coordinator } = options
  const mintId = options.mintId ?? randomUUID
  const onError =
    options.onError ?? ((error) => console.error('[ownership-receipts] evidence failed', error))
  return {
    port: {
      mintHandle() {
        const commandId = mintId()
        return { commandId, idempotencyKey: persistIdempotencyKeyFor(commandId) }
      },
      receiptsFor: (chatId) => receiptStore.listLoaded(chatId),
      hydrateReceipts(chatId, receipts) {
        void receiptStore.hydrate(chatId, receipts).catch(onError)
      },
      isActive: (chatId) => coordinator.isActive(chatId),
      ...(options.confirmOwnedSave ? { confirmOwnedSave: options.confirmOwnedSave } : {})
    },
    async persistedEvidenceSink(input, evidence) {
      // Settle only once the evidence is durable: a pending save is released by
      // Host storage that can be shown again after a restart.
      let confirmed = false
      try {
        await receiptStore.record(evidence, { chatId: input.chatId })
        if (
          evidence.kind === 'exact' &&
          input.ownershipIntentId &&
          queue.confirmPublication(
            input.chatId,
            input.ownershipIntentId,
            evidence.commandId,
            evidence.revision
          )
        ) {
          queue.settle(input.chatId, input.ownershipIntentId)
          confirmed = true
        }
      } catch (error) {
        onError(error)
      }
      if (confirmed) {
        try {
          options.onPublicationConfirmed?.(input.chatId, evidence)
        } catch (error) {
          onError(error)
        }
      }
    }
  }
}
