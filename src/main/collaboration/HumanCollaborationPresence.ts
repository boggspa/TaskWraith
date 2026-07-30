/**
 * Tri-state presence for EXTERNAL human collaborators — `live` / `grace` /
 * `expired`.
 *
 * WHY THIS MODULE EXISTS AT ALL (read this before "simplifying" it away)
 * ---------------------------------------------------------------------
 * The two notions of "present" that exist today are wrong in OPPOSITE
 * directions, so neither can be repaired in place:
 *
 *  - A GRACEFUL leave is treated as PERMANENT. `disconnect`
 *    (HumanCollaborationRuntime.ts:486) deletes the session synchronously, so a
 *    tab reload — the single most common thing a collaborator does — is
 *    indistinguishable from walking away. There is no grace anywhere.
 *  - An UNGRACEFUL drop is treated as PERMANENTLY ALIVE. The relay frees the
 *    seat without telling the host, so `connectedChatIds()` keeps a phantom
 *    live session until revoke or app restart. The runtime's own doc comment at
 *    :508-509 says exactly this.
 *
 * WHY PRESENCE MUST NOT LIVE ON THE PARTICIPANT RECORD
 * ---------------------------------------------------
 * The obvious-looking shortcut — flip `participant.enabled` (or any other field
 * on the ensemble participant record) when a collaborator drops, flip it back
 * when they return — is a LATENT PERFORMANCE BOMB, and it is the reason this
 * layer is standalone rather than folded into the ensemble config.
 *
 * `computeEnsemblePromptShellStamp` (src/main/EnsemblePrompt.ts:176-195) hashes
 * the identity of every ENABLED seat to decide whether a seat's invariant
 * prompt shell can be reused across turns. Any change to that hash invalidates
 * the briefing for EVERY seat in the panel, forcing a full re-brief instead of
 * a slim turn. Presence flaps: a wobbly hotel wifi connection produces
 * disconnect/reconnect pairs by the minute, and each pair would bust the
 * panel-wide prompt cache TWICE — destroying the slim-turn optimisation for
 * every model in the ensemble because ONE human's socket blinked. Presence is
 * also, unlike the roster, not part of the prompt's meaning: which humans are
 * currently watching does not change what the models were briefed to do.
 *
 * So presence lives here, entirely outside the participant record and entirely
 * outside the store (whose participant status is only ever
 * pending -> active -> revoked; nothing in it can mean "temporarily away").
 *
 * WHAT THIS IS
 * ------------
 * A pure, deterministic state machine. No timers of its own, no I/O, no
 * Electron, no store access. It takes an injected clock exactly the way
 * HumanCollaborationRuntime does (`now?: () => number`), exposes explicit
 * transition inputs, and exposes `sweep(now)` which returns what changed. The
 * CALLER owns the actual `setTimeout` (see `nextExpiryAt()` so it can arm ONE
 * timer instead of polling); this module owns the decisions. That split is what
 * makes every rule below testable without fake timers.
 *
 * There is deliberately NO idle timeout: a live session goes to grace only
 * because the caller observed a leave or a socket close, never because it went
 * quiet. A collaborator reading a long transcript is not absent.
 */

/**
 * How long a session that has stopped talking to us stays visible (greyed)
 * before it is declared gone.
 *
 * 90s is derived from the transport, not taste. The relay's WS heartbeat is
 * 30s (relay/src/server.ts:97), so an ungraceful drop can take up to ~2 beats
 * (~60s) merely to be NOTICED; the host transport's reconnect backoff then caps
 * at 30s per attempt (HumanCollaborationHostTransport.ts:64). A window shorter
 * than notice + one capped retry would expire people who are in the middle of
 * successfully reconnecting — which is the exact churn this module exists to
 * prevent. Longer would leave a stale greyed avatar on screen past the point a
 * human would believe it.
 */
export const HUMAN_COLLABORATION_PRESENCE_GRACE_MS = 90_000

/**
 * Expired sessions are retained as tombstones so a late/replayed frame cannot
 * resurrect a session that was revoked (see `observeActivity`). Retention is
 * BOUNDED — this map is in-memory on the main process and a long-lived host
 * with a chatty share would otherwise grow it without limit. Oldest tombstones
 * are evicted first. Eviction only weakens a defence-in-depth check: the
 * authority on "may this collaborator act?" is still
 * `HumanCollaborationRuntime.requireActiveSession` reading the store.
 */
export const MAX_RETAINED_EXPIRED_PRESENCE_SESSIONS = 256

export type HumanCollaborationPresenceState = 'live' | 'grace' | 'expired'

/** `unknown` = this module has never seen the session/collaborator/chat. */
export type HumanCollaborationPresenceStateOrUnknown = HumanCollaborationPresenceState | 'unknown'

/**
 * What the THREAD is allowed to see. `grace` is deliberately `present`: the
 * whole point of the grace window is that a reload produces no leave message
 * and no join message, just a greyed avatar. Only crossing this boundary is
 * worth an event in the transcript.
 */
export type HumanCollaborationPresenceMembership = 'present' | 'absent'

/**
 * Reasons that expire a session IMMEDIATELY, with no grace window.
 *
 * Withdrawn trust must never enjoy a reconnect window. If a kicked or revoked
 * collaborator sat in `grace` for 90s they would keep a presence-visible seat
 * — and any caller that gates on presence would keep honouring it — for a
 * minute and a half after the host removed them. Every member of this union
 * bypasses grace by construction (`expireSession` has no grace path at all).
 */
export type HumanCollaborationPresenceExpiryReason = 'revoked' | 'kicked' | 'shareDisabled'

export type HumanCollaborationPresenceReason =
  /** Admission, a subscribe, an append — any observed inbound traffic. */
  | 'activity'
  /** Activity that closed an open grace window (same session, or a fresh
   *  session for a collaborator who was in grace). Never thread-visible. */
  | 'reconnected'
  /** The peer sent a sealed disconnect. Grace, NOT removal. */
  | 'gracefulLeave'
  /** The socket/room closed and the peer said nothing. Grace. */
  | 'transportClose'
  /** `sweep()` found a grace window that had run out. */
  | 'graceExpired'
  | HumanCollaborationPresenceExpiryReason

/**
 * Everything needed to place a session. Maps 1:1 onto a row of
 * `HumanCollaborationRuntime.sessionSummaries()` plus its `sessionId`, so the
 * wiring is a spread, not a translation layer.
 */
export interface HumanCollaborationPresenceSessionRef {
  sessionId: string
  chatId: string
  shareId: string
  collaboratorId: string
  displayName: string
}

export interface HumanCollaborationPresenceTransition {
  sessionId: string
  chatId: string
  shareId: string
  collaboratorId: string
  displayName: string
  at: number
  reason: HumanCollaborationPresenceReason
  /** Session-level state change. */
  from: HumanCollaborationPresenceStateOrUnknown
  to: HumanCollaborationPresenceState
  /** Collaborator-level resolution (ANY-live) around this change — drives the
   *  greyed/ungreyed avatar without involving the transcript. */
  collaboratorFrom: HumanCollaborationPresenceStateOrUnknown
  collaboratorTo: HumanCollaborationPresenceState
  membershipFrom: HumanCollaborationPresenceMembership
  membershipTo: HumanCollaborationPresenceMembership
  /**
   * The collaborator's thread-visible membership did NOT change, so the caller
   * must emit NOTHING to the transcript. True for: a graceful leave, a
   * reconnect inside the window, a second concurrent session, and the expiry of
   * a stale session belonging to someone who is still here on another socket.
   * `silent === false` is the caller's cue to emit exactly one join or leave.
   */
  silent: boolean
  /** Absolute deadline, present only when `to === 'grace'`. */
  graceUntil?: number
}

export interface HumanCollaborationPresenceEntry {
  sessionId: string
  chatId: string
  shareId: string
  collaboratorId: string
  displayName: string
  state: HumanCollaborationPresenceState
  /** When the session entered its current state. */
  since: number
  /** Latest observed activity (monotone: a late/stale stamp cannot rewind it). */
  lastSeenAt: number
  graceUntil?: number
}

export interface HumanCollaborationCollaboratorPresence {
  collaboratorId: string
  displayName: string
  chatId: string
  shareId: string
  state: HumanCollaborationPresenceState
  membership: HumanCollaborationPresenceMembership
  /** Every session this collaborator currently holds, newest activity first. */
  sessionIds: string[]
  lastSeenAt: number
  /** Latest deadline across their grace sessions, if the collaborator is greyed. */
  graceUntil?: number
}

export interface HumanCollaborationPresenceOptions {
  now?: () => number
  /** Override the grace window (tests, and a future user preference). */
  graceMs?: number
}

/**
 * MULTI-SESSION RESOLUTION — "best wins".
 *
 * A collaborator legitimately holds two sessions mid-reconnect: a reconnect
 * mints a BRAND NEW sessionId (`confirmSas`, HumanCollaborationRuntime.ts:403)
 * and completes long before the relay heartbeat notices the old socket died, so
 * the stale session is still sitting in grace when the fresh one goes live.
 * Resolving a collaborator to their WORST session state would grey out someone
 * who is demonstrably typing, and would un-grey them again when the sweep
 * finally reaps the corpse — two spurious UI flips per reconnect. Resolving to
 * their BEST session state is both flicker-free and simply true: there IS a
 * live session.
 */
const PRESENCE_RANK: Record<HumanCollaborationPresenceState, number> = {
  live: 2,
  grace: 1,
  expired: 0
}

export function membershipForPresence(
  state: HumanCollaborationPresenceStateOrUnknown
): HumanCollaborationPresenceMembership {
  return state === 'live' || state === 'grace' ? 'present' : 'absent'
}

interface PresenceRecord {
  sessionId: string
  chatId: string
  shareId: string
  collaboratorId: string
  displayName: string
  state: HumanCollaborationPresenceState
  since: number
  lastSeenAt: number
  graceEnteredAt?: number
}

export class HumanCollaborationPresence {
  private readonly now: () => number
  private readonly graceMs: number
  private readonly sessions = new Map<string, PresenceRecord>()
  /** Insertion-ordered expiry log backing MAX_RETAINED_EXPIRED_PRESENCE_SESSIONS. */
  private readonly expiredOrder: string[] = []

  constructor(options: HumanCollaborationPresenceOptions = {}) {
    this.now = options.now ?? Date.now
    // A negative or non-finite window would make every rule below meaningless;
    // fall back rather than let a bad caller disable grace silently.
    this.graceMs =
      typeof options.graceMs === 'number' &&
      Number.isFinite(options.graceMs) &&
      options.graceMs >= 0
        ? options.graceMs
        : HUMAN_COLLABORATION_PRESENCE_GRACE_MS
  }

  /** The configured grace window, so callers can render a countdown. */
  graceWindowMs(): number {
    return this.graceMs
  }

  /**
   * Any observed traffic from a collaborator: admission, projection subscribe,
   * append, or an opened frame. Idempotent while already live — a reconnect
   * storm produces at most the ONE transition that actually changed something.
   */
  observeActivity(
    ref: HumanCollaborationPresenceSessionRef,
    at: number = this.now()
  ): HumanCollaborationPresenceTransition | null {
    const existing = this.sessions.get(ref.sessionId)

    if (existing) {
      // Fail closed on an identity swap. sessionId -> (chat, share, collaborator)
      // is minted once at admission and is immutable; a ref that disagrees is
      // either a bug or an attempt to re-point a live session at another chat,
      // and neither should be allowed to rewrite our record.
      if (
        existing.chatId !== ref.chatId ||
        existing.shareId !== ref.shareId ||
        existing.collaboratorId !== ref.collaboratorId
      ) {
        return null
      }
      // A rename is legitimate and carries no authority.
      existing.displayName = ref.displayName

      if (existing.state === 'expired') {
        // TERMINAL. Expiry is reached by revoke/kick/share-disable or by an
        // exhausted grace window; in every one of those cases a late frame
        // arriving on the dead sessionId must not buy back a live seat. A real
        // returning collaborator arrives with a NEW sessionId (see the
        // multi-session note above), which takes the fresh-session path below.
        return null
      }
      // Monotone: a stale stamp must not rewind liveness.
      existing.lastSeenAt = Math.max(existing.lastSeenAt, at)
      if (existing.state === 'live') return null

      const collaboratorFrom = this.collaboratorState(existing.collaboratorId)
      existing.state = 'live'
      existing.since = at
      existing.graceEnteredAt = undefined
      return this.transition(existing, 'grace', 'reconnected', at, collaboratorFrom)
    }

    const collaboratorFrom = this.collaboratorState(ref.collaboratorId)
    const record: PresenceRecord = {
      sessionId: ref.sessionId,
      chatId: ref.chatId,
      shareId: ref.shareId,
      collaboratorId: ref.collaboratorId,
      displayName: ref.displayName,
      state: 'live',
      since: at,
      lastSeenAt: at
    }
    this.sessions.set(record.sessionId, record)
    // A fresh session for a collaborator who was in grace IS the reconnect: the
    // sessionId changed but the human did not.
    const reason: HumanCollaborationPresenceReason =
      collaboratorFrom === 'grace' ? 'reconnected' : 'activity'
    return this.transition(record, 'unknown', reason, at, collaboratorFrom)
  }

  /** The peer sent a sealed disconnect. Grace, NOT removal. */
  noteGracefulLeave(
    sessionId: string,
    at: number = this.now()
  ): HumanCollaborationPresenceTransition | null {
    return this.enterGrace(sessionId, 'gracefulLeave', at)
  }

  /** The socket/room closed with no word from the peer. Also grace. */
  noteTransportClose(
    sessionId: string,
    at: number = this.now()
  ): HumanCollaborationPresenceTransition | null {
    return this.enterGrace(sessionId, 'transportClose', at)
  }

  /** Immediate expiry for one session. Never passes through grace. */
  expireSession(
    sessionId: string,
    reason: HumanCollaborationPresenceExpiryReason,
    at: number = this.now()
  ): HumanCollaborationPresenceTransition | null {
    const record = this.sessions.get(sessionId)
    if (!record || record.state === 'expired') return null
    return this.markExpired(record, reason, at)
  }

  /**
   * Immediate expiry for every session a collaborator holds — the revoke/kick
   * door. Returns one transition per session; at most one of them is
   * non-silent (the one that flips the collaborator to `absent`), so the caller
   * still emits exactly one leave.
   */
  expireCollaborator(
    collaboratorId: string,
    reason: HumanCollaborationPresenceExpiryReason,
    at: number = this.now()
  ): HumanCollaborationPresenceTransition[] {
    return this.expireMatching((record) => record.collaboratorId === collaboratorId, reason, at)
  }

  /** Immediate expiry for a whole share (share revoked / disabled). */
  expireShare(
    shareId: string,
    reason: HumanCollaborationPresenceExpiryReason,
    at: number = this.now()
  ): HumanCollaborationPresenceTransition[] {
    return this.expireMatching((record) => record.shareId === shareId, reason, at)
  }

  /**
   * Promote every grace window that has run out. The caller owns the timer and
   * calls this from it; each returned transition is worth exactly one event.
   * Idempotent — a second sweep at the same instant returns nothing.
   */
  sweep(at: number = this.now()): HumanCollaborationPresenceTransition[] {
    const out: HumanCollaborationPresenceTransition[] = []
    for (const record of this.sessions.values()) {
      if (record.state !== 'grace' || record.graceEnteredAt === undefined) continue
      const elapsed = at - record.graceEnteredAt
      if (elapsed < 0) {
        // The clock went backwards (NTP correction, wake-from-sleep, a caller
        // passing a stale stamp). Do NOT expire — an apparent negative age is
        // never evidence that someone left. Re-anchor instead, so the window
        // stays bounded from the new "now" rather than hanging until wall-clock
        // catches up.
        record.graceEnteredAt = at
        record.since = at
        continue
      }
      // `>=` so a window whose deadline is exactly `at` expires on this sweep;
      // with a frozen clock nothing ever ages, which is correct, not a stall.
      if (elapsed >= this.graceMs) out.push(this.markExpired(record, 'graceExpired', at))
    }
    return out
  }

  /**
   * Earliest grace deadline, or null when nothing is pending. Lets the caller
   * arm ONE timer instead of polling — the whole reason `sweep` is explicit.
   */
  nextExpiryAt(): number | null {
    let soonest: number | null = null
    for (const record of this.sessions.values()) {
      if (record.state !== 'grace' || record.graceEnteredAt === undefined) continue
      const deadline = record.graceEnteredAt + this.graceMs
      if (soonest === null || deadline < soonest) soonest = deadline
    }
    return soonest
  }

  sessionState(sessionId: string): HumanCollaborationPresenceStateOrUnknown {
    return this.sessions.get(sessionId)?.state ?? 'unknown'
  }

  /** ANY-live resolution — see the PRESENCE_RANK note. */
  collaboratorState(collaboratorId: string): HumanCollaborationPresenceStateOrUnknown {
    return this.resolve((record) => record.collaboratorId === collaboratorId)
  }

  chatState(chatId: string): HumanCollaborationPresenceStateOrUnknown {
    return this.resolve((record) => record.chatId === chatId)
  }

  shareState(shareId: string): HumanCollaborationPresenceStateOrUnknown {
    return this.resolve((record) => record.shareId === shareId)
  }

  /** Truthful replacement for `connectedChatIds()`: someone is here RIGHT NOW. */
  liveChatIds(): string[] {
    return this.chatIdsWhere('live')
  }

  /**
   * Chats with someone live OR greyed-in-grace — the right input for a
   * "someone's here" glow, which should not blink off during a reload.
   */
  presentChatIds(): string[] {
    return this.chatIdsWhere('present')
  }

  /** Per-collaborator rollup for a chat, for the host's presence strip. */
  collaboratorsForChat(chatId: string): HumanCollaborationCollaboratorPresence[] {
    const byCollaborator = new Map<string, PresenceRecord[]>()
    for (const record of this.sessions.values()) {
      if (record.chatId !== chatId) continue
      const bucket = byCollaborator.get(record.collaboratorId)
      if (bucket) bucket.push(record)
      else byCollaborator.set(record.collaboratorId, [record])
    }
    const out: HumanCollaborationCollaboratorPresence[] = []
    for (const [collaboratorId, records] of byCollaborator) {
      const ordered = [...records].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      const best = ordered.reduce((winner, candidate) =>
        PRESENCE_RANK[candidate.state] > PRESENCE_RANK[winner.state] ? candidate : winner
      )
      const graceUntil = ordered
        .filter((record) => record.state === 'grace' && record.graceEnteredAt !== undefined)
        .reduce<number | undefined>((latest, record) => {
          const deadline = (record.graceEnteredAt as number) + this.graceMs
          return latest === undefined || deadline > latest ? deadline : latest
        }, undefined)
      out.push({
        collaboratorId,
        displayName: ordered[0].displayName,
        chatId,
        shareId: ordered[0].shareId,
        state: best.state,
        membership: membershipForPresence(best.state),
        sessionIds: ordered.map((record) => record.sessionId),
        lastSeenAt: ordered[0].lastSeenAt,
        ...(best.state === 'grace' && graceUntil !== undefined ? { graceUntil } : {})
      })
    }
    return out
  }

  snapshot(): HumanCollaborationPresenceEntry[] {
    return Array.from(this.sessions.values()).map((record) => this.toEntry(record))
  }

  /** Explicit GC for a session the caller knows is gone for good. */
  forget(sessionId: string): boolean {
    const removed = this.sessions.delete(sessionId)
    if (removed) {
      const index = this.expiredOrder.indexOf(sessionId)
      if (index >= 0) this.expiredOrder.splice(index, 1)
    }
    return removed
  }

  /** Explicit GC for a deleted chat. Returns how many records were dropped. */
  forgetChat(chatId: string): number {
    let dropped = 0
    for (const record of Array.from(this.sessions.values())) {
      if (record.chatId !== chatId) continue
      if (this.forget(record.sessionId)) dropped += 1
    }
    return dropped
  }

  reset(): void {
    this.sessions.clear()
    this.expiredOrder.length = 0
  }

  private enterGrace(
    sessionId: string,
    reason: 'gracefulLeave' | 'transportClose',
    at: number
  ): HumanCollaborationPresenceTransition | null {
    const record = this.sessions.get(sessionId)
    if (!record) return null
    // Already expired: terminal, and already in grace: the deadline stays
    // anchored to the FIRST grace entry. Re-anchoring would let a storm of
    // close events (a flapping socket emits many) extend the window without
    // bound, which is exactly how a phantom session becomes immortal again.
    if (record.state !== 'live') return null
    const collaboratorFrom = this.collaboratorState(record.collaboratorId)
    record.state = 'grace'
    record.since = at
    record.graceEnteredAt = at
    return this.transition(record, 'live', reason, at, collaboratorFrom)
  }

  private expireMatching(
    predicate: (record: PresenceRecord) => boolean,
    reason: HumanCollaborationPresenceExpiryReason,
    at: number
  ): HumanCollaborationPresenceTransition[] {
    const out: HumanCollaborationPresenceTransition[] = []
    for (const record of this.sessions.values()) {
      if (record.state === 'expired' || !predicate(record)) continue
      out.push(this.markExpired(record, reason, at))
    }
    return out
  }

  private markExpired(
    record: PresenceRecord,
    reason: HumanCollaborationPresenceReason,
    at: number
  ): HumanCollaborationPresenceTransition {
    const from = record.state
    const collaboratorFrom = this.collaboratorState(record.collaboratorId)
    record.state = 'expired'
    record.since = at
    record.graceEnteredAt = undefined
    this.retainTombstone(record.sessionId)
    return this.transition(record, from, reason, at, collaboratorFrom)
  }

  /** Single choke point for the bounded tombstone retention. */
  private retainTombstone(sessionId: string): void {
    this.expiredOrder.push(sessionId)
    while (this.expiredOrder.length > MAX_RETAINED_EXPIRED_PRESENCE_SESSIONS) {
      const evicted = this.expiredOrder.shift()
      if (evicted !== undefined) this.sessions.delete(evicted)
    }
  }

  private transition(
    record: PresenceRecord,
    from: HumanCollaborationPresenceStateOrUnknown,
    reason: HumanCollaborationPresenceReason,
    at: number,
    collaboratorFrom: HumanCollaborationPresenceStateOrUnknown
  ): HumanCollaborationPresenceTransition {
    // Resolved AFTER the record was mutated, so it accounts for this change plus
    // every sibling session the collaborator still holds.
    const collaboratorTo = this.collaboratorState(record.collaboratorId)
    const membershipFrom = membershipForPresence(collaboratorFrom)
    const membershipTo = membershipForPresence(collaboratorTo)
    return {
      sessionId: record.sessionId,
      chatId: record.chatId,
      shareId: record.shareId,
      collaboratorId: record.collaboratorId,
      displayName: record.displayName,
      at,
      reason,
      from,
      to: record.state,
      collaboratorFrom,
      // `collaboratorTo` cannot be 'unknown': the record we just mutated is in
      // the map and matches the collaborator, so at least one state resolves.
      collaboratorTo: collaboratorTo === 'unknown' ? record.state : collaboratorTo,
      membershipFrom,
      membershipTo,
      silent: membershipFrom === membershipTo,
      ...(record.state === 'grace' && record.graceEnteredAt !== undefined
        ? { graceUntil: record.graceEnteredAt + this.graceMs }
        : {})
    }
  }

  private resolve(
    predicate: (record: PresenceRecord) => boolean
  ): HumanCollaborationPresenceStateOrUnknown {
    let best: HumanCollaborationPresenceStateOrUnknown = 'unknown'
    for (const record of this.sessions.values()) {
      if (!predicate(record)) continue
      if (best === 'unknown' || PRESENCE_RANK[record.state] > PRESENCE_RANK[best])
        best = record.state
      if (best === 'live') break
    }
    return best
  }

  private chatIdsWhere(want: 'live' | 'present'): string[] {
    const ids = new Set<string>()
    for (const record of this.sessions.values()) {
      const matches =
        want === 'live'
          ? record.state === 'live'
          : membershipForPresence(record.state) === 'present'
      if (matches) ids.add(record.chatId)
    }
    return Array.from(ids)
  }

  private toEntry(record: PresenceRecord): HumanCollaborationPresenceEntry {
    return {
      sessionId: record.sessionId,
      chatId: record.chatId,
      shareId: record.shareId,
      collaboratorId: record.collaboratorId,
      displayName: record.displayName,
      state: record.state,
      since: record.since,
      lastSeenAt: record.lastSeenAt,
      ...(record.state === 'grace' && record.graceEnteredAt !== undefined
        ? { graceUntil: record.graceEnteredAt + this.graceMs }
        : {})
    }
  }
}
