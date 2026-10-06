/**
 * The Host's orphan fold: carries a dead writer's log onto the thread's full
 * copy and then durably retires the dead writer's authority mark. The
 * sequence is the approved I7 stage-2 order — reserve, prepare outside
 * command admission, validate, durably adopt, conditionally retire authority,
 * sync, release custody — and it is driven per thread from the owner
 * service's rebuild list.
 *
 * Custody binds every step: the reservation minted first is revalidated by
 * the hold begin, the fold's guarded adoption and the retirement. It is
 * released on every exit path except one: a retirement whose directory sync
 * failed keeps exact custody (the registry refuses the release), and this
 * orchestrator keeps the handle so the next attempt pays that sync debt with
 * it rather than minting a fresh reservation over a bare absence.
 *
 * A log longer than one request is folded in rounds: each round folds the
 * oldest whole prefix and adopts it, which moves the full copy, and the next
 * round reads from there. Retirement is conditional: a log the reader cannot
 * hand over (corrupt, gapped, a single batch over the wire budget, no full
 * copy) leaves the mark in place and the thread unresolved — a dead writer's
 * work is never truncated, and missing canonical sources are never
 * resurrected to make the fold fit.
 */
import type { ThreadCatalogueClient } from '../host-shared/thread-catalogue/ThreadCatalogueClient'
import type { ThreadCatalogueRecoveryController } from '../host-shared/thread-catalogue/ThreadCatalogueRecoveryController'
import { readThreadFoldLog } from '../host-shared/thread-catalogue/ThreadFoldLogSource'
import type { ThreadAuthorityRetirementOutcome } from '../host-shared/thread-log/ThreadAuthorityRetirement'
import type { ThreadOwnershipReservation } from '../host-shared/thread-log/ThreadOwnership'
import type { FoldedLogOutcome, ThreadCatalogueOpenResult } from '../shared/threadCatalogueTypes'
import { THREAD_FOLD_MAX_BATCHES } from '../shared/threadCatalogueProtocol'

/** How long a thread whose fold was refused waits before the Host asks again. */
const REFUSED_RETRY_MS = 30_000
/**
 * Batch bytes one fold request may carry. The wire ceiling is 2 MiB plus a
 * 64 KiB envelope allowance; the batches get the 2 MiB and the request's
 * other fields the allowance.
 */
export const THREAD_FOLD_MAX_BATCH_BYTES = 2 * 1024 * 1024
/** A log that needs more rounds than this is left for the next attempt. */
const MAX_FOLD_ROUNDS = 64

export type ThreadOrphanFoldOutcome =
  | { kind: 'folded' }
  /** Nothing to do: no orphan mark, the writer revived, erasure fenced, or custody held elsewhere. */
  | { kind: 'deferred' }
  /** The log could not be handed over whole; the mark stays and the thread is retried. */
  | { kind: 'unresolved'; reason: string }

export interface ThreadOrphanFoldRecoveryOptions {
  client: Pick<ThreadCatalogueClient, 'query'>
  recovery: Pick<
    ThreadCatalogueRecoveryController,
    'beginOrphanViaReservation' | 'adoptViaFold' | 'assertHeld' | 'end'
  >
  owners: {
    reserveOrphanOwnership(threadId: string): Promise<ThreadOwnershipReservation | null>
    retireOrphanAuthority(
      threadId: string,
      reservation: ThreadOwnershipReservation
    ): Promise<ThreadAuthorityRetirementOutcome>
    releaseOrphanOwnership(reservation: ThreadOwnershipReservation): boolean
  }
  /** The journal's directory (`<profile>/chat-journal-v2`). */
  logDirectory: string
  /** Revision of the Host's full copy of the thread, or null when it has none. */
  fullCopyRevision(threadId: string): number | null
  /** Profile authority binding recorded on the fold; asserted by the source parent, never compared. */
  profileAuthority: string
  /** Test seam for the per-request batch budget. */
  maxBatchBytes?: number
  maxBatches?: number
  onError?: (error: unknown) => void
}

export class ThreadOrphanFoldRecovery {
  private readonly queued = new Set<string>()
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>()
  /** Folds that are running right now, by thread; a second caller joins the same promise. */
  private readonly inflight = new Map<string, Promise<ThreadOrphanFoldOutcome>>()
  /** Chats an erasure fence has fenced: no enqueue, pump or retry touches them until lifted. */
  private readonly erasureFenced = new Set<string>()
  /** A fence without a chat id covers every thread. */
  private globalErasureFence = false
  /** Custody a failed directory sync kept; only this exact handle may pay the debt. */
  private readonly syncOwed = new Map<string, ThreadOwnershipReservation>()
  /** Custody whose hold could not be ended; kept until that hold is gone. */
  private readonly stranded = new Map<
    string,
    { reservation: ThreadOwnershipReservation; token: string }
  >()
  private running = false
  private stopped = false

  constructor(private readonly options: ThreadOrphanFoldRecoveryOptions) {}

  /** Work the owner service's rebuild named: threads a dead writer's mark left behind. */
  seed(candidates: readonly string[]): void {
    for (const chatId of candidates) this.enqueue(chatId)
  }

  enqueue(chatId: string): void {
    if (this.stopped || this.retries.has(chatId) || this.fenced(chatId)) return
    this.queued.add(chatId)
    void this.pump()
  }

  async foldOrphan(chatId: string): Promise<ThreadOrphanFoldOutcome> {
    if (this.fenced(chatId)) return { kind: 'deferred' }
    const running = this.inflight.get(chatId)
    if (running) return running
    const outcome = this.foldOrphanOnce(chatId)
    this.inflight.set(chatId, outcome)
    try {
      return await outcome
    } finally {
      if (this.inflight.get(chatId) === outcome) this.inflight.delete(chatId)
    }
  }

  /**
   * An erasure is about to purge the chat (or everything): synchronously drop
   * its queued and retrying work, fence it so nothing restarts the fold while
   * the purge runs, and await any fold already in flight. Custody a running
   * fold holds is not released here — the fold finishes through its own exit
   * paths (finally/settle/stranded/syncOwed), which is what the join waits for.
   */
  async quiesceForErasure(chatId?: string): Promise<void> {
    if (chatId === undefined) {
      this.globalErasureFence = true
      this.queued.clear()
    } else {
      this.erasureFenced.add(chatId)
      this.queued.delete(chatId)
    }
    for (const [queued, timer] of [...this.retries]) {
      if (chatId === undefined || queued === chatId) {
        clearTimeout(timer)
        this.retries.delete(queued)
      }
    }
    const running =
      chatId === undefined
        ? [...this.inflight.values()]
        : [this.inflight.get(chatId)].filter(
            (promise): promise is Promise<ThreadOrphanFoldOutcome> => promise !== undefined
          )
    await Promise.allSettled(running)
  }

  /**
   * The erasure finished: the chat (or everything, when no chat id is given)
   * may be enqueued and folded again. A chat id that was erased is gone, but
   * a global erasure lifts every fence at once.
   */
  liftErasure(chatId?: string): void {
    if (chatId === undefined) {
      this.globalErasureFence = false
      this.erasureFenced.clear()
    } else {
      this.erasureFenced.delete(chatId)
    }
  }

  private fenced(chatId: string): boolean {
    return this.globalErasureFence || this.erasureFenced.has(chatId)
  }

  private async foldOrphanOnce(chatId: string): Promise<ThreadOrphanFoldOutcome> {
    // A hold whose `end` failed keeps its custody: the thread stays reserved
    // until that hold is gone, never released underneath it.
    const stranded = this.stranded.get(chatId)
    if (stranded) {
      if (!this.endHold(chatId, stranded.token)) return { kind: 'deferred' }
      this.stranded.delete(chatId)
      this.settle(chatId, stranded.reservation)
    }
    // A retirement whose directory sync failed is paid with a directory sync
    // alone: no hold, no unlink, nothing the debt could destroy.
    const owed = this.syncOwed.get(chatId)
    if (owed) {
      const paid = await this.retire(chatId, owed)
      this.settle(chatId, owed)
      return paid
    }
    const reservation = await this.options.owners.reserveOrphanOwnership(chatId)
    if (!reservation) return { kind: 'deferred' }
    let hold: { token: string } | null = null
    try {
      const begun = this.options.recovery.beginOrphanViaReservation(chatId, reservation)
      if (begun.kind !== 'held') return { kind: 'deferred' }
      hold = begun.hold
      return await this.foldHeld(chatId, begun.hold.token, reservation)
    } finally {
      if (hold && !this.endHold(chatId, hold.token)) {
        this.stranded.set(chatId, { reservation, token: hold.token })
      } else {
        this.settle(chatId, reservation)
      }
    }
  }

  private endHold(chatId: string, token: string): boolean {
    try {
      this.options.recovery.end(chatId, token)
      return true
    } catch (error) {
      this.options.onError?.(error)
      return false
    }
  }

  /** Releases custody, or keeps the exact handle when the registry says a sync is still owed. */
  private settle(chatId: string, reservation: ThreadOwnershipReservation): void {
    if (this.options.owners.releaseOrphanOwnership(reservation)) this.syncOwed.delete(chatId)
    else this.syncOwed.set(chatId, reservation)
  }

  private async foldHeld(
    chatId: string,
    token: string,
    reservation: ThreadOwnershipReservation
  ): Promise<ThreadOrphanFoldOutcome> {
    for (let round = 0; ; round += 1) {
      if (round >= MAX_FOLD_ROUNDS) return { kind: 'deferred' }
      if (this.stopped) return { kind: 'deferred' }
      const full = this.options.fullCopyRevision(chatId)
      // Missing canonical storage is unresolved, never resurrected from the log.
      if (full === null) return { kind: 'unresolved', reason: 'no full copy' }
      const log = readThreadFoldLog({
        directory: this.options.logDirectory,
        chatId,
        fullCopyRevision: full,
        maxFoldBytes: this.options.maxBatchBytes ?? THREAD_FOLD_MAX_BATCH_BYTES,
        maxBatches: this.options.maxBatches ?? THREAD_FOLD_MAX_BATCHES
      })
      if (log.kind === 'none') break
      if (log.kind !== 'log') {
        return {
          kind: 'unresolved',
          reason: log.kind === 'oversize' ? 'batch over wire budget' : `log ${log.kind}`
        }
      }
      const opened = await this.options.client.query<ThreadCatalogueOpenResult | null>({
        method: 'open',
        chatId,
        mode: 'metadata'
      })
      if (!opened) return { kind: 'deferred' }
      let foldId: string | null = null
      let adopted = false
      try {
        // The wire's `fold-owned-log` asserts the hold at the parent; this
        // in-process request asserts it the same way.
        try {
          this.options.recovery.assertHeld(chatId, token)
        } catch {
          return { kind: 'deferred' }
        }
        const folded = await this.options.client.query<FoldedLogOutcome | null>({
          method: 'fold-owned-log',
          chatId,
          recoveryToken: token,
          sourceWitness: opened.entry.sourceWitness,
          headRevision: log.headRevision,
          updatedAt: log.updatedAt,
          profileAuthority: this.options.profileAuthority,
          logEntries: log.batches
        })
        if (!folded) return { kind: 'deferred' }
        foldId = folded.foldId
        const adoption = await this.options.recovery.adoptViaFold(
          chatId,
          token,
          folded.foldId,
          reservation
        )
        if (adoption.kind !== 'adopted') return { kind: 'deferred' }
        adopted = true
      } finally {
        // Adoption discards its own fold; a refused or failed one must not
        // sit in the worker's bounded pending set.
        if (foldId !== null && !adopted) {
          await this.options.client
            .query({ method: 'discard-folded', foldId })
            .catch(() => undefined)
        }
        await this.options.client
          .query({ method: 'release', leaseId: opened.leaseId })
          .catch(() => undefined)
      }
      // The adoption must have carried the full copy up to the folded head;
      // anything less is never retired over.
      const advanced = this.options.fullCopyRevision(chatId)
      if (advanced === null || advanced < log.headRevision) {
        return { kind: 'unresolved', reason: 'full copy did not reach the folded head' }
      }
      if (log.complete) break
    }
    // Caught-up (`none`) and freshly folded marks both retire under the same
    // custody; retirement re-checks the log against the full copy itself.
    return this.retire(chatId, reservation)
  }

  private async retire(
    chatId: string,
    reservation: ThreadOwnershipReservation
  ): Promise<ThreadOrphanFoldOutcome> {
    const retired = await this.options.owners.retireOrphanAuthority(chatId, reservation)
    if (retired.kind === 'retired') return { kind: 'folded' }
    if (retired.kind === 'uncertain') return { kind: 'unresolved', reason: retired.reason }
    return { kind: 'deferred' }
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    try {
      while (this.queued.size && !this.stopped) {
        const chatId = this.queued.values().next().value!
        this.queued.delete(chatId)
        if (this.fenced(chatId)) continue
        try {
          const outcome = await this.foldOrphan(chatId)
          if (outcome.kind !== 'folded') this.retry(chatId)
        } catch {
          this.retry(chatId)
        }
      }
    } finally {
      this.running = false
    }
  }

  private retry(chatId: string): void {
    if (this.stopped || this.retries.has(chatId) || this.fenced(chatId)) return
    const timer = setTimeout(() => {
      this.retries.delete(chatId)
      this.enqueue(chatId)
    }, REFUSED_RETRY_MS)
    timer.unref?.()
    this.retries.set(chatId, timer)
  }

  dispose(): void {
    this.stopped = true
    this.queued.clear()
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
    // The controller's own dispose ends every pending hold; custody that a
    // sync still owes stays with the registry, which goes away with the Host.
    for (const { reservation } of this.stranded.values()) {
      this.options.owners.releaseOrphanOwnership(reservation)
    }
    this.stranded.clear()
    for (const reservation of this.syncOwed.values()) {
      this.options.owners.releaseOrphanOwnership(reservation)
    }
    this.syncOwed.clear()
  }
}
