/**
 * Who may write a thread.
 *
 * A thread has exactly one writer at a time. The Host is the writer of every
 * thread nobody has claimed. A desktop app process becomes the writer by
 * claiming the thread and stays the writer until it releases the thread or
 * dies. The Host keeps its table of grants in memory only: after a Host
 * restart the table is empty and desktop writers claim again.
 *
 * Both sides use this module. The Host keeps a HostThreadOwnerTable; each app
 * process keeps a DesktopThreadClaims for the threads it has claimed. Neither
 * reads a file, opens a socket or starts a timer: the caller says what is on
 * disk, who is alive and what time it is, and carries the messages.
 */

/** How long the Host waits for a desktop writer to answer a release request. */
export const THREAD_RELEASE_REQUEST_BOUND_MS = 10_000

/** The least time between two claims for one thread from one app process. */
export const THREAD_CLAIM_RETRY_MS = 1_000

/**
 * Names one grant. A message that carries any other epoch than the thread's
 * current one is stale and changes nothing. The Host incarnation is part of
 * the epoch because grant numbers start again when the Host restarts.
 */
export interface ThreadOwnerEpoch {
  readonly host: string
  readonly grant: number
}

export function sameThreadOwnerEpoch(a: ThreadOwnerEpoch, b: ThreadOwnerEpoch): boolean {
  return a.host === b.host && a.grant === b.grant
}

/**
 * Opaque, per-thread reservation held across preparation, adoption,
 * retirement and directory sync. Re-validates the exact authority mark,
 * writer liveness, profile authority and erasure generation throughout.
 *
 * A reservation is minted by the Host thread owner registry for one thread
 * at preparation time and released by the same. Callers do not inspect its
 * fields; they pass it to adoption, retirement and any directory sync.
 */
export interface ThreadOwnershipReservation {
  readonly threadId: string
  readonly epoch: ThreadOwnerEpoch
  /** Re-validates the exact authority mark; throws ReservationInvalid if the mark moved or vanished. */
  readonly revalidate: () => void
  /** Whether the catalogue is currently erasing the thread; true => reject retirement as busy. */
  readonly erasing: () => boolean
}

export class ReservationInvalid extends Error {
  constructor(
    public readonly reason:
      | 'mark_moved'
      | 'writer_alive'
      | 'profile_authority_lost'
      | 'erasure_changed'
      | 'not_minted'
  ) {
    super(`Reservation invalid: ${reason}`)
    this.name = 'ReservationInvalid'
  }
}

/**
 * A private brand symbol that `reserveOwnership` stamps onto a reservation
 * so `retireOrphanAuthority` and other callers can refuse a foreign
 * reservation object that was never minted here. Not yet thrown by the
 * registry — callers that build a reservation via `ThreadOwnershipReservation`
 * directly (e.g. tests, or `endOrphanViaReservation`'s foreign path) still
 * pass the existing checks. The brand slot is reserved for a future
 * migration that distinguishes a minted reservation from a foreign one
 * by the registry itself, not by its caller.
 */
export const RESERVATION_BRAND: unique symbol = Symbol.for(
  'taskwraith.thread-ownership-reservation.brand'
)

/** A reservation stamped by the registry, with a brand for foreign detection. */
export interface MintedReservation extends ThreadOwnershipReservation {
  readonly [RESERVATION_BRAND]: true
}

/** Runtime check: is this reservation one the registry minted? */
export function isMintedReservation(value: ThreadOwnershipReservation): value is MintedReservation {
  return (value as Partial<MintedReservation>)[RESERVATION_BRAND] === true
}

/**
 * Why a claim was refused.
 * - `disabled`: this Host does not grant claims at all.
 * - `owned_by_other_writer`: another desktop writer holds the thread, or may
 *   still hold it from before a Host restart.
 * - `host_run_active`: the Host itself is working on the thread.
 * - `host_ahead`: the Host's full copy, or the log it can read, is ahead of
 *   the claimer. The claimer re-reads up to the revision in the reply.
 * - `host_behind`: the claimer is ahead of what the Host can read (a full copy
 *   or an append is still on its way). The claimer asks again later.
 */
export type ThreadClaimRefusalReason =
  | 'disabled'
  | 'owned_by_other_writer'
  | 'host_run_active'
  | 'host_ahead'
  | 'host_behind'

export interface ThreadClaimRequest {
  readonly action: 'claim'
  readonly threadId: string
  /** New for every app process. */
  readonly writerId: string
  /** Counts this process's claims, so a reply can be matched to its claim. */
  readonly claimId: number
  /** The Host full copy the claimer's state is built on. */
  readonly baseRevision: number
  /** The head of the log the claimer continues; the base when it has nothing unpublished. */
  readonly headRevision: number
}

export type ThreadClaimReply =
  | {
      readonly threadId: string
      readonly claimId: number
      readonly granted: true
      readonly epoch: ThreadOwnerEpoch
    }
  | {
      readonly threadId: string
      readonly claimId: number
      readonly granted: false
      readonly reason: ThreadClaimRefusalReason
      /** The thread's durable head as the Host reads it; null when it has no copy. */
      readonly revision: number | null
    }

/** The writer's log reached a revision. Lets the Host follow without re-reading. */
export interface ThreadAdvancedMessage {
  readonly action: 'advanced'
  readonly threadId: string
  readonly epoch: ThreadOwnerEpoch
  readonly revision: number
}

export interface ThreadReleaseMessage {
  readonly action: 'release'
  readonly threadId: string
  readonly epoch: ThreadOwnerEpoch
  /** The writer's head when it let go; null when it never wrote under this epoch. */
  readonly revision: number | null
}

/** The Host asks the writer to give the thread back before this deadline. */
export interface ThreadReleaseRequest {
  readonly threadId: string
  readonly epoch: ThreadOwnerEpoch
  readonly requestId: number
  readonly deadline: number
}

export interface ThreadReleaseDeclinedMessage {
  readonly action: 'declined'
  readonly threadId: string
  readonly epoch: ThreadOwnerEpoch
  readonly requestId: number
}

/** What the Host can read of a thread on disk when it decides. */
export interface ThreadDurableFacts {
  /** Revision of the Host's full copy, or null when it has none. */
  readonly fullCopyRevision: number | null
  /**
   * Head revision of the thread's log. The caller gives it only while the
   * thread has an authority file, and null otherwise or when there is no log.
   * Above the full copy it is read as work the file's writer has not
   * published. While the writer lives it publishes that work itself; once it
   * has ended, the Host folds it before writing, or a new process carries it
   * on from its head. Revisions alone cannot tell that work from saves the app
   * logged before the Host refused or overtook them; the file can, and without
   * it a log above the full copy is a mirror the table never sees.
   */
  readonly logRevision: number | null
}

export interface ThreadClaimFacts extends ThreadDurableFacts {
  /** A Host run, or any other Host write, is live on the thread. */
  readonly hostRunActive: boolean
  /**
   * A live desktop process other than the claimer has not connected to this
   * Host since it started, so it may still hold the thread from before.
   */
  readonly otherDesktopUnattached: boolean
}

/**
 * Whether a desktop app process is running, and whether it has connected to
 * this Host and re-asserted its claims since the Host started. A process whose
 * liveness cannot be decided counts as `unattached`.
 */
export type HostDesktopPresence = 'none' | 'attached' | 'unattached'

export interface HostWriteFacts extends ThreadDurableFacts {
  readonly desktop: HostDesktopPresence
}

export type ThreadWriter =
  | { readonly kind: 'host' }
  | {
      readonly kind: 'desktop'
      readonly writerId: string
      readonly epoch: ThreadOwnerEpoch
      /** The highest log revision the writer has reported. */
      readonly revision: number
      readonly releaseRequested: boolean
    }

/**
 * What the Host must do before it changes a thread itself.
 * - `write`: it is the writer and nothing is unpublished.
 * - `ask_release`: a desktop writer holds the thread. Send the request when
 *   `created` is true, then wait for a release, a decline or the deadline.
 * - `fold_first`: a dead writer left a log above the full copy. Fold it into
 *   the full copy up to `revision`, then ask again.
 * - `busy`: a live desktop holds unpublished work, or may hold the thread from
 *   before a Host restart. The command fails with the reason given.
 */
export type HostWriteDecision =
  | { readonly kind: 'write' }
  | {
      readonly kind: 'ask_release'
      readonly writerId: string
      readonly request: ThreadReleaseRequest
      readonly created: boolean
    }
  | { readonly kind: 'fold_first'; readonly revision: number }
  | { readonly kind: 'busy'; readonly reason: 'thread_busy_in_desktop' }

export interface HostOwnedThreadSnapshot {
  readonly threadId: string
  readonly writerId: string
  readonly epoch: ThreadOwnerEpoch
  readonly revision: number
  readonly request: { readonly requestId: number; readonly deadline: number } | null
}

export interface HostThreadOwnerTableSnapshot {
  readonly incarnation: string
  readonly enabled: boolean
  readonly releaseBoundMs: number
  readonly grants: number
  readonly requests: number
  readonly threads: readonly HostOwnedThreadSnapshot[]
}

export type DesktopClaimState = 'unclaimed' | 'claiming' | 'owned' | 'releasing'

export type DesktopClaimSnapshot =
  | {
      readonly threadId: string
      readonly state: 'claiming'
      readonly claimId: number
      readonly retryAt: number
    }
  | { readonly threadId: string; readonly state: 'owned'; readonly epoch: ThreadOwnerEpoch }
  | {
      readonly threadId: string
      readonly state: 'releasing'
      readonly epoch: ThreadOwnerEpoch
      readonly requestId: number
    }

export interface DesktopThreadClaimsSnapshot {
  readonly writerId: string
  readonly claimRetryMs: number
  readonly host: string | null
  readonly claimSeq: number
  readonly claimsDisabled: boolean
  readonly threads: readonly DesktopClaimSnapshot[]
  /** Threads whose last claim was refused, with the time they may claim again. */
  readonly refused: readonly (readonly [threadId: string, retryAt: number])[]
  /** The highest grant this process gave back for a thread it does not hold now. */
  readonly released: readonly (readonly [threadId: string, grant: number])[]
}

export type DesktopClaimReplyOutcome =
  | { readonly kind: 'granted'; readonly epoch: ThreadOwnerEpoch }
  | {
      readonly kind: 'refused'
      readonly reason: ThreadClaimRefusalReason
      readonly revision: number | null
    }
  | { readonly kind: 'ignored' }

/**
 * What the app does with a release request.
 * - `declined`: the thread is busy. Send the message; the app stays the writer.
 * - `release_started`: park saves for the thread, wait until what was written
 *   is durable, publish a full copy if the log is ahead of the last one, then
 *   call `release` and send its message, all before the deadline.
 * - `handed_back`: this process does not hold that grant. Send the message so
 *   the Host stops waiting for it.
 * - `ignored`: the request came from another Host incarnation.
 */
export type DesktopReleaseRequestOutcome =
  | { readonly kind: 'declined'; readonly declined: ThreadReleaseDeclinedMessage }
  | { readonly kind: 'release_started'; readonly deadline: number }
  | { readonly kind: 'handed_back'; readonly release: ThreadReleaseMessage }
  | { readonly kind: 'ignored' }

function requireId(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${what}`)
}

function requireRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid revision')
}

function requireFacts(facts: ThreadDurableFacts): void {
  if (facts.fullCopyRevision !== null) requireRevision(facts.fullCopyRevision)
  if (facts.logRevision !== null) requireRevision(facts.logRevision)
}

/**
 * A log whose revision is above the full copy's holds work by a desktop writer
 * that no full copy has yet. A log at or below the full copy adds nothing.
 */
function logLeads(facts: ThreadDurableFacts): boolean {
  return (
    facts.logRevision !== null &&
    (facts.fullCopyRevision === null || facts.logRevision > facts.fullCopyRevision)
  )
}

/** The newest revision of the thread the Host can read: the log where it leads, else the full copy. */
function durableHead(facts: ThreadDurableFacts): number | null {
  return logLeads(facts) ? facts.logRevision : facts.fullCopyRevision
}

interface OwnedThread {
  writerId: string
  epoch: ThreadOwnerEpoch
  revision: number
  request: { requestId: number; deadline: number } | null
}

const BUSY_IN_DESKTOP: HostWriteDecision = { kind: 'busy', reason: 'thread_busy_in_desktop' }

/**
 * The Host's table of desktop writers. A thread with no entry is the Host's.
 *
 * The table is never written to disk. A restarted Host builds a new one with a
 * new incarnation, and every desktop writer claims again; the claim is judged
 * against what is on disk exactly like a first claim, so a writer that missed
 * a Host change, or whose thread another writer took, is refused.
 */
export class HostThreadOwnerTable {
  private readonly incarnation: string
  private readonly enabled: boolean
  private readonly releaseBoundMs: number
  private grants = 0
  private requests = 0
  private readonly threads = new Map<string, OwnedThread>()
  /** Threads with a release request outstanding, so a deadline sweep never walks the table. */
  private readonly asked = new Set<string>()

  constructor(options: { incarnation: string; enabled?: boolean; releaseBoundMs?: number }) {
    requireId(options.incarnation, 'Host incarnation')
    const bound = options.releaseBoundMs ?? THREAD_RELEASE_REQUEST_BOUND_MS
    if (!Number.isFinite(bound) || bound <= 0) throw new Error('Invalid release bound')
    this.incarnation = options.incarnation
    this.enabled = options.enabled ?? true
    this.releaseBoundMs = bound
  }

  static restore(snapshot: HostThreadOwnerTableSnapshot): HostThreadOwnerTable {
    const table = new HostThreadOwnerTable(snapshot)
    table.grants = snapshot.grants
    table.requests = snapshot.requests
    for (const { threadId, request, ...owner } of snapshot.threads) {
      table.threads.set(threadId, { ...owner, request: request ? { ...request } : null })
      if (request) table.asked.add(threadId)
    }
    return table
  }

  /**
   * Grants only when nobody else can be writing: no other desktop writer, no
   * live Host work, and a claimer that stands exactly on the Host's full copy
   * and on the head of the log. A refusal changes nothing.
   */
  claim(request: ThreadClaimRequest, facts: ThreadClaimFacts): ThreadClaimReply {
    requireId(request.threadId, 'thread id')
    requireId(request.writerId, 'writer id')
    requireRevision(request.baseRevision)
    requireRevision(request.headRevision)
    if (request.headRevision < request.baseRevision) throw new Error('Invalid claim revisions')
    requireFacts(facts)
    const { threadId, claimId } = request
    const head = durableHead(facts)
    const refuse = (reason: ThreadClaimRefusalReason): ThreadClaimReply => ({
      threadId,
      claimId,
      granted: false,
      reason,
      revision: head
    })
    if (!this.enabled) return refuse('disabled')
    const owner = this.threads.get(threadId)
    if (owner) {
      if (owner.writerId !== request.writerId) return refuse('owned_by_other_writer')
      // The owner asking again lost its grant on the way, or its claim arrived
      // twice. It gets the grant it holds, whatever has happened on disk since.
      return { threadId, claimId, granted: true, epoch: owner.epoch }
    }
    if (facts.otherDesktopUnattached) return refuse('owned_by_other_writer')
    if (facts.hostRunActive) return refuse('host_run_active')
    if (facts.fullCopyRevision === null || head === null) return refuse('host_behind')
    if (request.baseRevision < facts.fullCopyRevision || request.headRevision < head) {
      return refuse('host_ahead')
    }
    if (request.baseRevision > facts.fullCopyRevision || request.headRevision > head) {
      return refuse('host_behind')
    }
    const epoch: ThreadOwnerEpoch = { host: this.incarnation, grant: ++this.grants }
    this.threads.set(threadId, {
      writerId: request.writerId,
      epoch,
      revision: request.headRevision,
      request: null
    })
    return { threadId, claimId, granted: true, epoch }
  }

  /** Idempotent, and ignored unless it carries the thread's current epoch. */
  advanced(message: ThreadAdvancedMessage): boolean {
    const owner = this.current(message.threadId, message.epoch)
    if (!owner) return false
    requireRevision(message.revision)
    if (message.revision > owner.revision) owner.revision = message.revision
    return true
  }

  /**
   * Returns the thread to the Host. Idempotent, and ignored unless it carries
   * the thread's current epoch. Whether the Host may then write is a separate
   * question: `requestHostWrite` still refuses while the log leads.
   */
  release(message: ThreadReleaseMessage): boolean {
    if (!this.current(message.threadId, message.epoch)) return false
    this.forget(message.threadId)
    return true
  }

  /**
   * Called before the Host changes a thread itself. It never answers `write`
   * for a thread a desktop writer holds, for one a live desktop may still hold
   * from before a restart, or for one with unpublished desktop work.
   */
  requestHostWrite(threadId: string, facts: HostWriteFacts, now: number): HostWriteDecision {
    requireId(threadId, 'thread id')
    requireFacts(facts)
    let owner = this.threads.get(threadId)
    if (owner && facts.desktop === 'none') {
      // No app process is running, so the writer is dead and cannot answer.
      this.forget(threadId)
      owner = undefined
    }
    if (owner) {
      const created = !owner.request || owner.request.deadline <= now
      if (created) {
        owner.request = { requestId: ++this.requests, deadline: now + this.releaseBoundMs }
        this.asked.add(threadId)
      }
      return {
        kind: 'ask_release',
        writerId: owner.writerId,
        created,
        request: { threadId, epoch: owner.epoch, ...owner.request! }
      }
    }
    if (facts.desktop === 'unattached') return BUSY_IN_DESKTOP
    if (logLeads(facts)) {
      // Only a dead writer's work may be folded by the Host. A live desktop
      // publishes its own, or claims the thread and carries on.
      return facts.desktop === 'none'
        ? { kind: 'fold_first', revision: facts.logRevision! }
        : BUSY_IN_DESKTOP
    }
    return { kind: 'write' }
  }

  /** The writer is busy and keeps the thread. Answers only the request it names. */
  releaseDeclined(message: ThreadReleaseDeclinedMessage): boolean {
    const owner = this.current(message.threadId, message.epoch)
    if (!owner?.request || owner.request.requestId !== message.requestId) return false
    owner.request = null
    this.asked.delete(message.threadId)
    return true
  }

  /**
   * Ends every release request whose deadline has passed and returns their
   * threads. The writers keep them: an unanswered request is a busy desktop.
   */
  expireReleaseRequests(now: number): string[] {
    const lapsed: string[] = []
    for (const threadId of this.asked) {
      const owner = this.threads.get(threadId)!
      if (owner.request!.deadline > now) continue
      owner.request = null
      lapsed.push(threadId)
    }
    for (const threadId of lapsed) this.asked.delete(threadId)
    return lapsed
  }

  /** When the caller should next call `expireReleaseRequests`, so it needs one timer at most. */
  nextDeadline(): number | null {
    let next: number | null = null
    for (const threadId of this.asked) {
      const deadline = this.threads.get(threadId)!.request!.deadline
      if (next === null || deadline < next) next = deadline
    }
    return next
  }

  /**
   * The caller found this writer's process dead, for example because a new app
   * process took its place. Its threads return to the Host, which must still
   * fold whatever the writer left unpublished before it writes them: see
   * `requestHostWrite`.
   */
  writerGone(writerId: string): string[] {
    const freed: string[] = []
    for (const [threadId, owner] of this.threads) {
      if (owner.writerId === writerId) freed.push(threadId)
    }
    for (const threadId of freed) this.forget(threadId)
    return freed
  }

  /**
   * Whether the Host may store a full copy sent by this desktop writer: the
   * thread's writer always, and anyone while the Host is the writer, which is
   * today's compare-and-swap path.
   */
  mayReplaceFullCopy(
    threadId: string,
    writerId: string,
    facts: Pick<ThreadClaimFacts, 'otherDesktopUnattached'>
  ): boolean {
    const owner = this.threads.get(threadId)
    return owner ? owner.writerId === writerId : !facts.otherDesktopUnattached
  }

  writerOf(threadId: string): ThreadWriter {
    const owner = this.threads.get(threadId)
    if (!owner) return { kind: 'host' }
    return {
      kind: 'desktop',
      writerId: owner.writerId,
      epoch: owner.epoch,
      revision: owner.revision,
      releaseRequested: owner.request !== null
    }
  }

  snapshot(): HostThreadOwnerTableSnapshot {
    return {
      incarnation: this.incarnation,
      enabled: this.enabled,
      releaseBoundMs: this.releaseBoundMs,
      grants: this.grants,
      requests: this.requests,
      threads: [...this.threads].map(([threadId, owner]) => ({
        threadId,
        writerId: owner.writerId,
        epoch: owner.epoch,
        revision: owner.revision,
        request: owner.request ? { ...owner.request } : null
      }))
    }
  }

  private current(threadId: string, epoch: ThreadOwnerEpoch): OwnedThread | undefined {
    const owner = this.threads.get(threadId)
    return owner && sameThreadOwnerEpoch(owner.epoch, epoch) ? owner : undefined
  }

  private forget(threadId: string): void {
    this.threads.delete(threadId)
    this.asked.delete(threadId)
  }
}

type ClaimEntry =
  | { state: 'claiming'; claimId: number; retryAt: number }
  | { state: 'owned'; epoch: ThreadOwnerEpoch }
  | { state: 'releasing'; epoch: ThreadOwnerEpoch; requestId: number }

/**
 * One app process's view of the threads it has claimed.
 *
 * A claim is optimistic. Until the grant arrives the thread is not owned and
 * the app saves it as it does for any thread it does not own, so a claim that
 * is refused or lost takes nothing away. The app is the only writer of a
 * thread only while `owns` is true.
 */
export class DesktopThreadClaims {
  private readonly writerId: string
  private readonly claimRetryMs: number
  private host: string | null = null
  private claimSeq = 0
  private claimsDisabled = false
  private readonly threads = new Map<string, ClaimEntry>()
  /** Threads whose last claim was refused, with the time they may claim again. */
  private readonly refused = new Map<string, number>()
  /**
   * The highest grant given back for a thread, under the current Host. Grant
   * numbers only rise, so an answer that carries this grant or an older one
   * names a grant the Host has taken back or is about to.
   */
  private readonly released = new Map<string, number>()

  constructor(options: { writerId: string; claimRetryMs?: number }) {
    requireId(options.writerId, 'writer id')
    const retry = options.claimRetryMs ?? THREAD_CLAIM_RETRY_MS
    if (!Number.isFinite(retry) || retry <= 0) throw new Error('Invalid claim retry interval')
    this.writerId = options.writerId
    this.claimRetryMs = retry
  }

  static restore(snapshot: DesktopThreadClaimsSnapshot): DesktopThreadClaims {
    const claims = new DesktopThreadClaims(snapshot)
    claims.host = snapshot.host
    claims.claimSeq = snapshot.claimSeq
    claims.claimsDisabled = snapshot.claimsDisabled
    for (const { threadId, ...entry } of snapshot.threads) claims.threads.set(threadId, entry)
    for (const [threadId, retryAt] of snapshot.refused) claims.refused.set(threadId, retryAt)
    for (const [threadId, grant] of snapshot.released) claims.released.set(threadId, grant)
    return claims
  }

  /**
   * The app connected to a Host, or lost it (null). A grant only means
   * something to the Host that issued it, so on any change every claim is
   * dropped. Returns the threads this process held, for the caller to claim
   * again with its current revisions.
   */
  hostChanged(incarnation: string | null): string[] {
    if (incarnation === this.host) return []
    const held: string[] = []
    for (const [threadId, entry] of this.threads) {
      if (entry.state !== 'claiming') held.push(threadId)
    }
    this.host = incarnation
    this.claimsDisabled = false
    this.threads.clear()
    this.refused.clear()
    this.released.clear()
    return held
  }

  /**
   * The claim to send, or null when there is nothing to send: the thread is
   * held, a claim for it is still in flight, the last one was refused less
   * than a retry interval ago, or this Host grants no claims.
   */
  claim(
    threadId: string,
    revisions: { baseRevision: number; headRevision: number },
    now: number
  ): ThreadClaimRequest | null {
    requireId(threadId, 'thread id')
    if (this.host === null || this.claimsDisabled) return null
    // Refusals are kept in the order they arrived, which is close to the order
    // they expire in: sweeping stops at the first live one, so the map stays
    // small, and each thread is held back by its own time below.
    for (const [refusedId, retryAt] of this.refused) {
      if (retryAt > now) break
      this.refused.delete(refusedId)
    }
    const entry = this.threads.get(threadId)
    if (entry && (entry.state !== 'claiming' || entry.retryAt > now)) return null
    if ((this.refused.get(threadId) ?? 0) > now) return null
    this.refused.delete(threadId)
    const claimId = ++this.claimSeq
    this.threads.set(threadId, { state: 'claiming', claimId, retryAt: now + this.claimRetryMs })
    return { action: 'claim', threadId, writerId: this.writerId, claimId, ...revisions }
  }

  /** Acts only on the answer to the latest claim for the thread; anything else is ignored. */
  claimReply(reply: ThreadClaimReply): DesktopClaimReplyOutcome {
    const entry = this.threads.get(reply.threadId)
    if (entry?.state !== 'claiming' || entry.claimId !== reply.claimId) return { kind: 'ignored' }
    if (!reply.granted) {
      this.settleRefused(reply.threadId, entry.retryAt)
      if (reply.reason === 'disabled') this.claimsDisabled = true
      return { kind: 'refused', reason: reply.reason, revision: reply.revision }
    }
    if (reply.epoch.host !== this.host) return { kind: 'ignored' }
    if (reply.epoch.grant <= (this.released.get(reply.threadId) ?? 0)) {
      // The Host answered before it saw this process give that grant back, and
      // will take the thread away when it does. Accepting would leave this
      // process believing it holds a thread the Host has reclaimed.
      this.settleRefused(reply.threadId, entry.retryAt)
      return { kind: 'ignored' }
    }
    this.released.delete(reply.threadId)
    this.threads.set(reply.threadId, { state: 'owned', epoch: reply.epoch })
    return { kind: 'granted', epoch: reply.epoch }
  }

  /** The Host wants to change a thread. `busy` is the caller's judgement of the thread right now. */
  releaseRequested(request: ThreadReleaseRequest, busy: boolean): DesktopReleaseRequestOutcome {
    const { threadId, epoch, requestId } = request
    const entry = this.threads.get(threadId)
    if (entry && entry.state !== 'claiming' && sameThreadOwnerEpoch(entry.epoch, epoch)) {
      if (entry.state === 'owned') {
        if (busy)
          return { kind: 'declined', declined: { action: 'declined', threadId, epoch, requestId } }
        this.threads.set(threadId, { state: 'releasing', epoch, requestId })
      } else if (requestId > entry.requestId) {
        // The Host asked again after its first request lapsed: answer the newer one.
        entry.requestId = requestId
      }
      return { kind: 'release_started', deadline: request.deadline }
    }
    if (epoch.host !== this.host) return { kind: 'ignored' }
    // The Host believes this process holds a grant it never received, or one it
    // has already given back. Hand it back so the Host stops waiting. A claim in
    // flight stays in flight: if its answer carries this same grant it is void.
    if (!entry || entry.state === 'claiming') this.giveBack(threadId, epoch)
    return { kind: 'handed_back', release: { action: 'release', threadId, epoch, revision: null } }
  }

  /**
   * Gives the thread back: at quit, at a hand-off, or to finish a release the
   * Host asked for. The caller publishes first when its log is ahead of the
   * last full copy. Null when this process does not hold the thread.
   */
  release(threadId: string, revision: number): ThreadReleaseMessage | null {
    const entry = this.threads.get(threadId)
    if (!entry || entry.state === 'claiming') return null
    requireRevision(revision)
    this.threads.delete(threadId)
    this.giveBack(threadId, entry.epoch)
    return { action: 'release', threadId, epoch: entry.epoch, revision }
  }

  /** New work arrived while releasing: keep the thread and tell the Host it is busy. */
  releaseAbandoned(threadId: string): ThreadReleaseDeclinedMessage | null {
    const entry = this.threads.get(threadId)
    if (entry?.state !== 'releasing') return null
    this.threads.set(threadId, { state: 'owned', epoch: entry.epoch })
    return { action: 'declined', threadId, epoch: entry.epoch, requestId: entry.requestId }
  }

  /** The message that tells the Host how far the log has got; null unless the thread is held. */
  advanced(threadId: string, revision: number): ThreadAdvancedMessage | null {
    const entry = this.threads.get(threadId)
    if (!entry || entry.state === 'claiming') return null
    requireRevision(revision)
    return { action: 'advanced', threadId, epoch: entry.epoch, revision }
  }

  stateOf(threadId: string): DesktopClaimState {
    return this.threads.get(threadId)?.state ?? 'unclaimed'
  }

  /** True while this process is the thread's only writer, including while it is releasing. */
  owns(threadId: string): boolean {
    const state = this.stateOf(threadId)
    return state === 'owned' || state === 'releasing'
  }

  snapshot(): DesktopThreadClaimsSnapshot {
    return {
      writerId: this.writerId,
      claimRetryMs: this.claimRetryMs,
      host: this.host,
      claimSeq: this.claimSeq,
      claimsDisabled: this.claimsDisabled,
      threads: [...this.threads].map(([threadId, entry]) => ({ threadId, ...entry })),
      refused: [...this.refused],
      released: [...this.released]
    }
  }

  private giveBack(threadId: string, epoch: ThreadOwnerEpoch): void {
    this.released.set(threadId, Math.max(epoch.grant, this.released.get(threadId) ?? 0))
  }

  /** The claim is over without a grant. The thread may be claimed again once its interval is up. */
  private settleRefused(threadId: string, retryAt: number): void {
    this.threads.delete(threadId)
    this.refused.delete(threadId)
    this.refused.set(threadId, retryAt)
  }
}
