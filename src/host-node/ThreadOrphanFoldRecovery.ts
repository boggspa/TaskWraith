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
    'beginOrphanViaReservation' | 'adoptViaFold' | 'end'
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
  /** Custody a failed directory sync kept; only this exact handle may pay the debt. */
  private readonly syncOwed = new Map<string, ThreadOwnershipReservation>()
  private running = false
  private stopped = false

  constructor(private readonly options: ThreadOrphanFoldRecoveryOptions) {}

  /** Work the owner service's rebuild named: threads a dead writer's mark left behind. */
  seed(candidates: readonly string[]): void {
    for (const chatId of candidates) this.enqueue(chatId)
  }

  enqueue(chatId: string): void {
    if (this.stopped || this.retries.has(chatId)) return
    this.queued.add(chatId)
    void this.pump()
  }

  async foldOrphan(chatId: string): Promise<ThreadOrphanFoldOutcome> {
    const owed = this.syncOwed.get(chatId)
    const reservation = owed ?? (await this.options.owners.reserveOrphanOwnership(chatId))
    if (!reservation) return { kind: 'deferred' }
    let hold: { token: string } | null = null
    let outcome: ThreadOrphanFoldOutcome = { kind: 'deferred' }
    try {
      const begun = this.options.recovery.beginOrphanViaReservation(chatId, reservation)
      if (begun.kind !== 'held') return { kind: 'deferred' }
      hold = begun.hold
      outcome = owed
        ? await this.retire(chatId, reservation)
        : await this.foldHeld(chatId, begun.hold.token, reservation)
      return outcome
    } finally {
      if (hold) {
        try {
          this.options.recovery.end(chatId, hold.token)
        } catch (error) {
          this.options.onError?.(error)
        }
      }
      // The registry refuses to release custody that still owes a directory
      // sync; keep that exact handle for the next attempt.
      if (this.options.owners.releaseOrphanOwnership(reservation)) this.syncOwed.delete(chatId)
      else this.syncOwed.set(chatId, reservation)
    }
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
      try {
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
        const adopted = await this.options.recovery.adoptViaFold(
          chatId,
          token,
          folded.foldId,
          reservation
        )
        if (adopted.kind !== 'adopted') return { kind: 'deferred' }
      } finally {
        await this.options.client
          .query({ method: 'release', leaseId: opened.leaseId })
          .catch(() => undefined)
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
    if (this.stopped || this.retries.has(chatId)) return
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
  }
}
