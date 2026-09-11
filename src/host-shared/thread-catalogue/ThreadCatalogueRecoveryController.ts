import { randomUUID } from 'node:crypto'
import {
  THREAD_CATALOGUE_REQUEST_TIMEOUT_MS,
  type ThreadCatalogueClient
} from './ThreadCatalogueClient'
import type { ThreadCatalogueSourcePublisher } from './ThreadCatalogueSourcePublisher'
import type { ThreadCatalogueReaderOptions } from './ThreadCatalogueWitness'
import type { PreparedThreadMutation } from '../../shared/threadCatalogueTypes'
import { adoptPreparedThreadRecord } from './ThreadCatalogueAdoption'
import type { ThreadCatalogueRecoveryHold, ThreadCatalogueProjection } from './ThreadCatalogue'
import { ThreadCatalogueWriteGate } from './ThreadCatalogueWriteGate'

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

/** Runs on the source-authoritative parent, never inside its decoder. */
export class ThreadCatalogueRecoveryController {
  private desktop: { writerId: string; pid?: number } | null = null

  registerDesktop(owner: { writerId: string; pid?: number }): void {
    this.options.assertAuthority()
    this.cancelForReplacedDesktop(owner.writerId)
    this.desktop = owner
  }
  private readonly admission = new ThreadCatalogueWriteGate()
  private readonly pending = new Map<
    string,
    {
      hold: ThreadCatalogueRecoveryHold
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

  private beginFor(
    chatId: string,
    identity: Pick<ThreadCatalogueRecoveryHold, 'desktopWriterId' | 'hostWriterId'>
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

  cancelForReplacedDesktop(writerId: string): void {
    for (const { hold } of this.pending.values())
      if (hold.hostWriterId || hold.desktopWriterId !== writerId) this.end(hold.chatId, hold.token)
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
    void this.options.client
      .query({ method: 'discard-prepared', preparedId })
      .catch(() => undefined)
    return prepared.projection
  }

  dispose(): void {
    // Disarm first: a throwing `end()` below must not leave an expiry armed on
    // a controller that is going away.
    for (const pending of this.pending.values()) if (pending.timer) clearTimeout(pending.timer)
    for (const { hold } of this.pending.values()) this.end(hold.chatId, hold.token)
  }
}
