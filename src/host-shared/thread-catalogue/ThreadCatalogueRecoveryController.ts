import { randomUUID } from 'node:crypto'
import {
  THREAD_CATALOGUE_REQUEST_TIMEOUT_MS,
  type ThreadCatalogueClient
} from './ThreadCatalogueClient'
import type { ThreadCatalogueSourcePublisher } from './ThreadCatalogueSourcePublisher'
import type { ThreadCatalogueReaderOptions } from './ThreadCatalogueWitness'
import type { FoldedLogOutcome, PreparedThreadMutation } from '../../shared/threadCatalogueTypes'
import {
  adoptFoldedThreadRecord,
  adoptPreparedThreadRecord,
  type FoldedAdoptionGuard
} from './ThreadCatalogueAdoption'
import type { ThreadCatalogueRecoveryHold, ThreadCatalogueProjection } from './ThreadCatalogue'
import { ThreadCatalogueWriteGate } from './ThreadCatalogueWriteGate'
import { ORPHAN_RETIREMENT_TOKEN } from '../thread-log/ThreadAuthorityRetirement'
import { ReservationInvalid, type ThreadOwnershipReservation } from '../thread-log/ThreadOwnership'

/**
 * How long a recovery hold survives with no token-bearing request naming it.
 *
 * Durable state is committed on the begin-recovery REQUEST -- the admission
 * hold, the fsynced hold file and the `pending` entry all land before the
 * reply is sent. A lost reply therefore leaves the caller holding no token it
 * could ever cancel with, while `ThreadCatalogueWriteGate.admit` waits on that
 * admission with no timeout and no rejection: every command for the chat hangs
 * until the Host restarts. This expiry is the only thing that ends such a
 * strand, so it is sized to be unreachable by any recovery that is still
 * making progress.
 *
 * Sizing: the Desktop recovery and `ThreadCatalogueHostRecovery` both await
 * `ThreadCatalogueClient`. The longest gap between two token-bearing requests
 * on a path that succeeds today is the Desktop's begin-recovery -> open ->
 * release -> prepare, and each of those two intervening queries can burn a
 * full request budget before returning -- so two budgets is the floor, and
 * this is double that. Sizing against a shorter budget (HostProjectionClient's
 * 30s, say) would cancel live holders on paths that work today.
 */
export const THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS = 4 * THREAD_CATALOGUE_REQUEST_TIMEOUT_MS

/**
 * Whether a held recovery belongs to exactly the writer now asking to begin.
 *
 * Matched on the axis the request names and nowhere else: a Desktop request
 * never reclaims a Host-owned hold and vice versa, and an absent id on either
 * side matches nothing, so an unidentified caller can never adopt a strand.
 */
export function recoveryHoldHasOwner(
  hold: Pick<ThreadCatalogueRecoveryHold, 'desktopWriterId' | 'hostWriterId'>,
  identity: Pick<ThreadCatalogueRecoveryHold, 'desktopWriterId' | 'hostWriterId'>
): boolean {
  if (identity.desktopWriterId)
    return hold.desktopWriterId === identity.desktopWriterId && !hold.hostWriterId
  if (identity.hostWriterId)
    return hold.hostWriterId === identity.hostWriterId && !hold.desktopWriterId
  return false
}

/** What an orphan keep-custody end (`endOrphan`, `endOrphanViaReservation`) did. */
export type ThreadCatalogueOrphanEndOutcome =
  | { readonly kind: 'released' }
  | { readonly kind: 'uncertain'; readonly reason: 'sync_failed' | 'release_refused' }
  | {
      readonly kind: 'busy'
      readonly reason:
        | 'wrong_token'
        | 'token_mismatch'
        | 'not_host_writer'
        | 'live_desktop'
        | 'live_work'
        | 'damaged'
    }

/** What `adoptViaFold` did. A fold that was refused changed nothing on disk. */
export type ThreadCatalogueFoldAdoptOutcome =
  | { readonly kind: 'adopted'; readonly projection: ThreadCatalogueProjection }
  | {
      readonly kind: 'busy'
      readonly reason:
        | Extract<ThreadCatalogueOrphanEndOutcome, { kind: 'busy' }>['reason']
        | 'fold_unavailable'
    }

/** What an authenticated explicit per-thread recovery takeover did. */
export type ThreadCatalogueTakeoverOutcome =
  | { readonly kind: 'taken' }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'busy'
      readonly reason:
        | 'identity_changed'
        | 'live_work'
        | 'orphan_custody'
        | 'unreadable'
        /** The hold could not be released on disk; it still keeps the thread. */
        | 'release_refused'
    }

/** Runs on the source-authoritative parent, never inside its decoder. */
export class ThreadCatalogueRecoveryController {
  private desktop: { writerId: string; pid?: number } | null = null

  registerDesktop(owner: { writerId: string; pid?: number }): void {
    this.options.assertAuthority()
    this.desktop = owner
  }

  private readonly admission = new ThreadCatalogueWriteGate()
  private readonly pending = new Map<
    string,
    {
      hold: ThreadCatalogueRecoveryHold
      /** The hold began through `beginOrphanViaReservation`: orphan fold custody, never cancelable by takeover. */
      orphanCustody: boolean
      release(): void
      promise: Promise<void>
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  private readonly completed = new Map<
    string,
    { projection: ThreadCatalogueProjection; epoch: PreparedThreadMutation['epoch']; token: string }
  >()
  constructor(
    private readonly options: {
      client: Pick<ThreadCatalogueClient, 'query'>
      publisher: Pick<
        ThreadCatalogueSourcePublisher,
        'catalogue' | 'begin' | 'finishProjection' | 'fail' | 'canRecover'
      >
      reader: ThreadCatalogueReaderOptions
      incarnation: string
      assertAuthority(): void
      hasLiveWork(chatId: string): boolean
      /**
       * Whether a reservation is exact custody the Host owner registry minted
       * and still holds. The orphan route refuses without it: a structurally
       * valid object that the registry did not mint is never custody.
       */
      ownsReservation?(reservation: ThreadOwnershipReservation): boolean
      /**
       * Called after an adoption renamed the prepared record into place, so
       * the Host's public window index can follow it (M4 slice 13c1). A
       * throwing callback never fails the adoption.
       */
      onAdopted?(chatId: string): void
    }
  ) {
    options.assertAuthority()
    // The exact new profile lease excludes the former source parent. An old
    // controller cannot still commit after this incarnation begins serving.
    for (const hold of options.publisher.catalogue.recoveryHolds()) {
      if (hold.hostIncarnation !== options.incarnation)
        options.publisher.catalogue.releaseRecoveryHold(hold.chatId, hold.token)
    }
    // A hold no token can name belongs to no live recovery in any incarnation,
    // and no other code path can ever clear it. Sweeping it here is the only
    // escape from a permanent, restart-surviving block on that chat. Failure
    // to unlink must never take the process down with it.
    for (const chatId of options.publisher.catalogue.unreadableRecoveryHoldChatIds()) {
      try {
        options.publisher.catalogue.releaseUnreadableRecoveryHold(chatId)
      } catch {
        // Left for the next incarnation rather than failing start-up.
      }
    }
  }

  forgetErased(chatId?: string): void {
    for (const [id, pending] of this.pending)
      if (!chatId || id === chatId) this.end(id, pending.hold.token)
    for (const [id, completed] of this.completed)
      if (!chatId || completed.projection.summary.chatId === chatId) this.completed.delete(id)
  }

  async wait(chatId: string): Promise<void> {
    while (this.pending.has(chatId)) await this.pending.get(chatId)!.promise
  }

  admit<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    return this.admission.admit(chatId, work)
  }

  begin(chatId: string, desktopWriterId: string): ThreadCatalogueRecoveryHold {
    this.options.assertAuthority()
    if (
      (this.desktop?.writerId ??
        this.options.publisher.catalogue.currentRegisteredWriter('desktop')?.writerId) !==
      desktopWriterId
    )
      throw new Error('History recovery Desktop identity changed')
    return this.beginFor(chatId, { desktopWriterId })
  }

  private assertNoLiveDesktop(): void {
    const desktop =
      this.desktop ?? this.options.publisher.catalogue.currentRegisteredWriter('desktop')
    if (!desktop) return
    if (!desktop.pid) throw new Error('Desktop recovery identity is unresolved')
    try {
      process.kill(desktop.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    throw new Error('Desktop owns recovery while it is running')
  }

  /**
   * Orphan pathway guard: only the writer that holds THIS thread's recovery
   * hold can block its orphan recovery. An unrelated live desktop — one
   * whose writerId does not hold this hold — does not block, and a hold the
   * Host owns is not blocked by any desktop. Ordinary recovery keeps
   * `assertNoLiveDesktop`, which blocks on ANY live desktop.
   */
  private assertNoLiveDeadWriter(held: ThreadCatalogueRecoveryHold): void {
    // For the orphan pathway, only the dead writer holding this thread
    // matters. An unrelated live desktop does not block recovery of this
    // thread. If the desktop currently owns the thread (writerId matches
    // the hold's desktop writer), block.
    const desktop =
      this.desktop ?? this.options.publisher.catalogue.currentRegisteredWriter('desktop')
    if (!desktop) return
    if (held.desktopWriterId !== desktop.writerId) return
    if (!desktop.pid) throw new Error('Desktop recovery identity is unresolved')
    try {
      process.kill(desktop.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    throw new Error('Desktop owns recovery for this thread while it is running')
  }

  beginHost(chatId: string): ThreadCatalogueRecoveryHold {
    this.options.assertAuthority()
    this.assertNoLiveDesktop()
    if (
      this.options.publisher.catalogue.currentRegisteredWriter('host')?.writerId !==
      this.options.incarnation
    )
      throw new Error('Host history writer identity changed')
    return this.beginFor(chatId, { hostWriterId: this.options.incarnation })
  }

  /**
   * Orphan fold begin under an explicit ownership reservation. The
   * reservation's per-thread probes — exact mark, dead writer, profile
   * authority, erasure generation — replace `beginHost`'s system-wide live
   * desktop scan, so an unrelated live desktop cannot block recovery of a
   * dead writer's thread. The thread's own restrictions are preserved:
   * live work, another pending hold, a closed catalogue and command
   * admission still refuse the hold.
   */
  beginOrphanViaReservation(
    chatId: string,
    reservation: ThreadOwnershipReservation
  ):
    | { kind: 'held'; hold: ThreadCatalogueRecoveryHold }
    | { kind: 'busy'; reason: 'damaged' | 'live_work' | 'admission_busy' } {
    this.options.assertAuthority()
    if (reservation.threadId !== chatId) return { kind: 'busy', reason: 'damaged' }
    if (!this.options.ownsReservation?.(reservation)) return { kind: 'busy', reason: 'damaged' }
    try {
      reservation.revalidate()
    } catch {
      return { kind: 'busy', reason: 'damaged' }
    }
    if (
      this.options.publisher.catalogue.currentRegisteredWriter('host')?.writerId !==
      this.options.incarnation
    )
      return { kind: 'busy', reason: 'damaged' }
    if (this.options.hasLiveWork(chatId)) return { kind: 'busy', reason: 'live_work' }
    // Never through `beginFor`'s same-owner reclaim: an ordinary Host hold
    // pending on this thread belongs to another recovery, and an orphan begin
    // must not cancel it (nor be cancelled by it).
    if (this.pending.has(chatId)) return { kind: 'busy', reason: 'admission_busy' }
    try {
      return {
        kind: 'held',
        hold: this.beginFor(chatId, { hostWriterId: this.options.incarnation }, true)
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('live work')) {
        return { kind: 'busy', reason: 'live_work' }
      }
      return { kind: 'busy', reason: 'admission_busy' }
    }
  }

  private beginFor(
    chatId: string,
    identity: Pick<ThreadCatalogueRecoveryHold, 'desktopWriterId' | 'hostWriterId'>,
    orphanCustody = false
  ): ThreadCatalogueRecoveryHold {
    // A caller asking to BEGIN is not using an earlier hold of its own: a writer
    // runs one recovery per chat at a time and only reaches here once the
    // previous one has ended. So a pending hold with the same owner is the
    // strand this controller's expiry exists for -- the begin-recovery REPLY was
    // lost, leaving the caller holding no token it could ever cancel with -- and
    // the caller's own retry, seconds later, is the earliest and cheapest moment
    // to reclaim it.
    //
    // Reclaiming here is what keeps the expiry a backstop instead of the only
    // escape. Until it, a lost reply wedged the thread for a full
    // THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS: `admit()` queues every command for
    // that thread behind the admission with no timeout, so a picker selection,
    // a transcript write and a record persist all waited ten minutes on a hold
    // whose owner was sitting there asking for a new one. Cancelling excludes
    // every later commit for the old token (`adopt` re-asserts it), so the
    // strand cannot come back to life behind the replacement.
    const stranded = this.pending.get(chatId)
    if (stranded && recoveryHoldHasOwner(stranded.hold, identity))
      this.end(chatId, stranded.hold.token)
    if (
      !this.options.publisher.canRecover(chatId) ||
      this.pending.has(chatId) ||
      this.options.hasLiveWork(chatId)
    )
      throw new Error('Chat has live work; recovery is deferred')
    const releaseAdmission = this.admission.hold(chatId)
    if (!releaseAdmission) throw new Error('Chat has an admitted command; recovery is deferred')
    const hold: ThreadCatalogueRecoveryHold = {
      chatId,
      ...identity,
      hostIncarnation: this.options.incarnation,
      token: randomUUID()
    }
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      this.options.publisher.catalogue.holdRecovery(hold)
    } catch (error) {
      releaseAdmission()
      throw error
    }
    this.pending.set(chatId, {
      hold,
      orphanCustody,
      promise,
      release: () => {
        releaseAdmission()
        release()
      }
    })
    this.renew(chatId, hold.token)
    return hold
  }

  /**
   * Arm, or restart, this hold's expiry. Every token-bearing request proves a
   * live holder, so each one renews; a token that does not name the current
   * pending hold renews nothing.
   *
   * Deliberately NOT one-shot. The entry stays in `pending` across the attempt
   * and is re-armed afterwards, so an `end()` that throws -- authority in flux,
   * an unlink that fails -- costs one more TTL instead of disarming the expiry
   * and restoring the immortal hold this exists to prevent. A successful
   * `end()` has already removed the entry, which makes the re-arm a no-op.
   */
  private renew(chatId: string, token: string): void {
    const pending = this.pending.get(chatId)
    if (!pending || pending.hold.token !== token) return
    if (pending.timer) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      const current = this.pending.get(chatId)
      if (!current || current.hold.token !== token) return
      current.timer = undefined
      try {
        this.end(chatId, token)
      } catch {
        // Left for the next expiry rather than taking the source parent down.
      }
      this.renew(chatId, token)
    }, THREAD_CATALOGUE_RECOVERY_HOLD_TTL_MS)
    timer.unref?.()
    pending.timer = timer
  }

  assertHeld(chatId: string, token: string): void {
    this.options.assertAuthority()
    const held = this.options.publisher.catalogue.recoveryHold(chatId)
    if (
      !held ||
      held === 'unreadable' ||
      held.token !== token ||
      this.pending.get(chatId)?.hold.token !== token
    )
      throw new Error('History recovery admission changed')
    this.renew(chatId, token)
  }

  end(chatId: string, token: string): boolean {
    this.options.assertAuthority()
    const pending = this.pending.get(chatId)
    const held = pending?.hold ?? this.options.publisher.catalogue.recoveryHold(chatId)
    if (!held || held === 'unreadable' || held.token !== token) return false
    // This method and the final adoption below execute without an await.
    // A cancellation ACK therefore excludes every later commit for this token.
    this.options.publisher.catalogue.releaseRecoveryHold(chatId, token)
    this.pending.delete(chatId)
    if (pending?.timer) clearTimeout(pending.timer)
    pending?.release()
    return true
  }

  /**
   * Authenticated explicit per-thread takeover, for the maintenance query of
   * the same name. Ends exactly the hold pending on `chatId` — in memory, or
   * a durable-only hold a previous incarnation left on disk — and never
   * touches another chat's hold. A desktop that just registered is NOT
   * preemptive: unrelated threads keep their existing holds until each is
   * taken over explicitly, or its holder ends it.
   *
   * The caller is the registered desktop, checked exactly like `begin`:
   * anyone else is `busy/identity_changed` and the hold stays. Live work,
   * an orphan fold's custody hold, and an unreadable durable hold each
   * refuse with their own reason, failing closed.
   */
  takeoverThread(chatId: string, desktopWriterId: string): ThreadCatalogueTakeoverOutcome {
    this.options.assertAuthority()
    if (
      (this.desktop?.writerId ??
        this.options.publisher.catalogue.currentRegisteredWriter('desktop')?.writerId) !==
      desktopWriterId
    )
      return { kind: 'busy', reason: 'identity_changed' }
    if (this.options.hasLiveWork(chatId)) return { kind: 'busy', reason: 'live_work' }
    const pending = this.pending.get(chatId)
    if (pending?.orphanCustody) return { kind: 'busy', reason: 'orphan_custody' }
    const held = pending ? pending.hold : this.options.publisher.catalogue.recoveryHold(chatId)
    if (held === 'unreadable') return { kind: 'busy', reason: 'unreadable' }
    if (!held) return { kind: 'none' }
    this.end(chatId, held.token)
    // `end` clears the in-memory admission even when the catalogue declined
    // the file: a hold still on disk still refuses claims, so say so.
    if (this.options.publisher.catalogue.recoveryHold(chatId) !== null)
      return { kind: 'busy', reason: 'release_refused' }
    return { kind: 'taken' }
  }

  /**
   * Whether `chatId` is under a recovery hold this controller would refuse a
   * thread-owner claim for: an in-memory pending hold or a durable hold file.
   * An unreadable hold file counts as held — fail closed — so a claim is
   * refused until the thread is explicitly taken over or the Host sweeps the
   * unreadable file on its next start.
   */
  hasPendingHold(chatId: string): boolean {
    this.options.assertAuthority()
    if (this.pending.has(chatId)) return true
    return this.options.publisher.catalogue.recoveryHold(chatId) !== null
  }

  /**
   * Orphan keep-custody end: release a recovery hold whose holder is no
   * longer live, while keeping the in-memory admission open across the
   * catalogue's directory sync. A failure to release or sync returns
   * `uncertain` and leaves the pending entry in place, so a later retry or
   * restart can finish the retirement without an immortal strand.
   *
   * The orphan pathway is the only one allowed to release without a live
   * desktop or active work in progress. `ORPHAN_RETIREMENT_TOKEN` is the
   * marker that distinguishes it; ordinary routes do not carry the token and
   * cannot use this method to skip the live-desktop exemption. The type
   * signature does the enforcement: callers that fail to pass the constant
   * from `ThreadAuthorityRetirement` see a `busy/wrong_token` result and
   * the hold is not touched.
   */
  async endOrphan(
    chatId: string,
    token: string,
    orphanToken: symbol
  ): Promise<ThreadCatalogueOrphanEndOutcome> {
    this.options.assertAuthority()
    if (orphanToken !== ORPHAN_RETIREMENT_TOKEN) return { kind: 'busy', reason: 'wrong_token' }
    const held = this.resolveOrphanHold(chatId, token)
    if ('kind' in held) return held
    return this.endOrphanHeld(chatId, token, held)
  }

  /**
   * Orphan keep-custody end under an explicit ownership reservation: the
   * same pathway as `endOrphan`, but the reservation's `revalidate()` runs
   * first and its liveness probe — not a system-wide desktop scan — is what
   * proves the dead writer is still dead. A reservation that fails to
   * revalidate is `busy/damaged` and the hold is not touched.
   */
  async endOrphanViaReservation(
    chatId: string,
    token: string,
    orphanToken: symbol,
    reservation: ThreadOwnershipReservation
  ): Promise<ThreadCatalogueOrphanEndOutcome> {
    this.options.assertAuthority()
    if (orphanToken !== ORPHAN_RETIREMENT_TOKEN) return { kind: 'busy', reason: 'wrong_token' }
    try {
      reservation.revalidate()
    } catch {
      return { kind: 'busy', reason: 'damaged' }
    }
    const held = this.resolveOrphanHold(chatId, token)
    if ('kind' in held) return held
    return this.endOrphanHeld(chatId, token, held)
  }

  private resolveOrphanHold(
    chatId: string,
    token: string
  ): ThreadCatalogueRecoveryHold | Extract<ThreadCatalogueOrphanEndOutcome, { kind: 'busy' }> {
    const pending = this.pending.get(chatId)
    const held = pending?.hold ?? this.options.publisher.catalogue.recoveryHold(chatId)
    if (!held || held === 'unreadable' || held.token !== token)
      return { kind: 'busy', reason: 'token_mismatch' }
    if (!held.hostWriterId) return { kind: 'busy', reason: 'not_host_writer' }
    return held
  }

  private endOrphanHeld(
    chatId: string,
    token: string,
    held: ThreadCatalogueRecoveryHold
  ): ThreadCatalogueOrphanEndOutcome {
    try {
      this.assertNoLiveDeadWriter(held)
    } catch {
      // A desktop whose pid is unresolved, or one that is alive, is the
      // same outcome from the orphan pathway's point of view: the hold
      // cannot be released while a live recovery identity holds this
      // thread. An unrelated live desktop does not reach this branch.
      return { kind: 'busy', reason: 'live_desktop' }
    }
    if (this.options.hasLiveWork(chatId)) return { kind: 'busy', reason: 'live_work' }
    // The release is synchronous on the catalogue side (unlink + sync). The
    // call throws if the directory sync fails; we treat that as uncertain
    // retirement and leave the pending entry in place.
    let released = false
    try {
      released = this.options.publisher.catalogue.releaseRecoveryHold(chatId, token)
    } catch {
      return { kind: 'uncertain', reason: 'sync_failed' }
    }
    if (!released) return { kind: 'uncertain', reason: 'release_refused' }
    // Capture the pending entry before deleting it: the timer and release
    // closure belong to the entry, not the hold.
    const pending = this.pending.get(chatId)
    this.pending.delete(chatId)
    if (pending?.timer) clearTimeout(pending.timer)
    pending?.release()
    return { kind: 'released' }
  }

  async adopt(
    chatId: string,
    token: string,
    preparedId: string
  ): Promise<ThreadCatalogueProjection> {
    // The request itself proves a live holder, and the `prepared` query below
    // can burn a whole request budget before `assert` renews again.
    this.renew(chatId, token)
    const prior = this.completed.get(preparedId)
    if (
      prior &&
      prior.token === token &&
      this.pending.get(chatId)?.hold.token === token &&
      JSON.stringify(prior.epoch) === JSON.stringify(this.options.publisher.catalogue.epoch(chatId))
    )
      return prior.projection
    const prepared = await this.options.client.query<PreparedThreadMutation | null>({
      method: 'prepared',
      preparedId
    })
    if (!prepared || prepared.chatId !== chatId)
      throw new Error('Prepared history mutation is unavailable')
    const assert = (): void => {
      this.options.assertAuthority()
      const held = this.options.publisher.catalogue.recoveryHold(chatId)
      if (held && held !== 'unreadable' && held.hostWriterId) this.assertNoLiveDesktop()
      if (
        !held ||
        held === 'unreadable' ||
        held.token !== token ||
        held.hostIncarnation !== this.options.incarnation ||
        this.pending.get(chatId)?.hold.token !== token ||
        this.options.hasLiveWork(chatId)
      )
        throw new Error('History recovery admission changed')
      this.renew(chatId, token)
    }
    assert()
    const ticket = this.options.publisher.begin(chatId, token)
    try {
      adoptPreparedThreadRecord(this.options.reader, prepared, {
        assert,
        epoch: () => this.options.publisher.catalogue.epoch(chatId)
      })
      this.options.publisher.finishProjection(ticket, prepared.projection)
      this.completed.set(preparedId, {
        projection: prepared.projection,
        epoch: prepared.epoch,
        token
      })
      if (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!)
    } catch (error) {
      this.options.publisher.fail(ticket)
      throw error
    }
    try {
      this.options.onAdopted?.(chatId)
    } catch {
      // The index follows on the thread's next write; the adoption stands.
    }
    void this.options.client
      .query({ method: 'discard-prepared', preparedId })
      .catch(() => undefined)
    return prepared.projection
  }

  /**
   * Adopts a dead writer's log, folded by `fold-owned-log`, as the thread's
   * full copy. The orphan route's counterpart of `adopt`: it composes with the
   * opaque reservation, so the exact authority mark it was minted for must
   * still stand at every guard, and it blocks only on the desktop that owns
   * THIS thread (`assertNoLiveDeadWriter`), never on an unrelated live one.
   *
   * A refusal before anything is staged is returned, not thrown; a failure
   * once adoption began fails the publication ticket and throws, as `adopt` does.
   */
  async adoptViaFold(
    chatId: string,
    token: string,
    foldId: string,
    reservation: ThreadOwnershipReservation
  ): Promise<ThreadCatalogueFoldAdoptOutcome> {
    if (reservation.threadId !== chatId || !this.options.ownsReservation?.(reservation)) {
      return { kind: 'busy', reason: 'damaged' }
    }
    try {
      reservation.revalidate()
    } catch {
      return { kind: 'busy', reason: 'damaged' }
    }
    const held = this.resolveOrphanHold(chatId, token)
    if ('kind' in held) return held
    if (held.hostIncarnation !== this.options.incarnation)
      return { kind: 'busy', reason: 'token_mismatch' }
    try {
      this.assertNoLiveDeadWriter(held)
    } catch {
      return { kind: 'busy', reason: 'live_desktop' }
    }
    if (this.options.hasLiveWork(chatId)) return { kind: 'busy', reason: 'live_work' }
    // The request itself proves a live holder, and the `folded` query below
    // can burn a whole request budget before the guard renews again.
    this.renew(chatId, token)
    const prior = this.completed.get(foldId)
    if (
      prior &&
      prior.token === token &&
      JSON.stringify(prior.epoch) === JSON.stringify(this.options.publisher.catalogue.epoch(chatId))
    )
      return { kind: 'adopted', projection: prior.projection }
    const fold = await this.options.client.query<FoldedLogOutcome | null>({
      method: 'folded',
      foldId
    })
    if (!fold || fold.chatId !== chatId) return { kind: 'busy', reason: 'fold_unavailable' }
    const authority = (): void => {
      this.options.assertAuthority()
      if (!this.options.ownsReservation?.(reservation)) {
        throw new ReservationInvalid('not_minted')
      }
      reservation.revalidate()
      const current = this.options.publisher.catalogue.recoveryHold(chatId)
      if (
        !current ||
        current === 'unreadable' ||
        current.token !== token ||
        !current.hostWriterId ||
        current.hostIncarnation !== this.options.incarnation
      )
        throw new Error('History recovery admission changed')
      this.assertNoLiveDeadWriter(current)
      if (this.options.hasLiveWork(chatId)) throw new Error('History recovery admission changed')
      this.renew(chatId, token)
    }
    const guard: FoldedAdoptionGuard = {
      authority,
      epoch: (observed) => {
        if (
          JSON.stringify(observed) !==
          JSON.stringify(this.options.publisher.catalogue.epoch(chatId))
        )
          throw new Error('History was erased before recovery')
      },
      witness: (observed) => {
        if (observed !== fold.sourceWitness) throw new Error('History changed before recovery')
      },
      headRevision: (observed) => {
        if (observed !== fold.headRevision) throw new Error('Folded history moved its head')
      },
      updatedAt: (observed) => {
        if (Date.parse(observed) !== Date.parse(fold.updatedAt))
          throw new Error('Folded history moved its timestamp')
      }
    }
    try {
      authority()
    } catch (error) {
      if (error instanceof ReservationInvalid) return { kind: 'busy', reason: 'damaged' }
      throw error
    }
    const ticket = this.options.publisher.begin(chatId, token)
    try {
      adoptFoldedThreadRecord(this.options.reader, fold, guard)
      this.options.publisher.finishProjection(ticket, fold.projection)
      this.completed.set(foldId, { projection: fold.projection, epoch: fold.epoch, token })
      if (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!)
    } catch (error) {
      this.options.publisher.fail(ticket)
      if (error instanceof ReservationInvalid) return { kind: 'busy', reason: 'damaged' }
      throw error
    }
    try {
      this.options.onAdopted?.(chatId)
    } catch {
      // The index follows on the thread's next write; the adoption stands.
    }
    void this.options.client.query({ method: 'discard-folded', foldId }).catch(() => undefined)
    return { kind: 'adopted', projection: fold.projection }
  }

  dispose(): void {
    // Disarm first: a throwing `end()` below must not leave an expiry armed on
    // a controller that is going away.
    for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer)
    for (const { hold } of this.pending.values()) this.end(hold.chatId, hold.token)
  }
}
