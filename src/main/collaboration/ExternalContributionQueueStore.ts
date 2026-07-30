/**
 * Durable, bounded, TTL-reaped queue of external contributions awaiting host
 * review.
 *
 * WHY A SEPARATE STORE rather than a `pendingApproval` flag on a ChatMessage —
 * three code facts, not taste:
 *
 *  1. A pending row in `chat.messages` is published to the OTHER external
 *     immediately. `buildHumanShareProjection` filters rows on `Boolean(id)` and
 *     the retired-channel predicate and nothing else, and two collaborators are
 *     allowed per share. Unreviewed external text reaching another external
 *     before the host has seen it is the direct negation of what host review
 *     means. Model containment is already handled by three prompt filters; the
 *     human-facing surfaces have none.
 *  2. A flag buys nothing ergonomically. `preserveCollaboratorComments`
 *     substitutes the canonical stored row over whatever the renderer sent, so a
 *     flag could never be flipped from the renderer — approve and deny are
 *     main-owned verbs either way. It also RE-ADDS any collaborator row the
 *     renderer omitted, which is why deleting one from the transcript already
 *     silently fails today.
 *  3. The cost is asymmetric. A flag needs a new exclusion at every reader of
 *     `chat.messages` — previews, exports, search, the virtualiser, iOS — each
 *     failing silently as a leaked line. A separate store needs none, because
 *     nothing unapproved ever enters the transcript.
 *
 * Shaped after `HumanCollaborationAuditLog` (bounded, single choke point,
 * compact on read) rather than `HumanCollaborationStore`, which pretty-prints
 * its entire snapshot on every write.
 *
 * PURE STORAGE. It knows nothing about chats, transcripts or the wire. Callers
 * own materialisation and delivery.
 */

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export type ExternalContributionState = 'queued' | 'approved' | 'denied' | 'lapsed'

/** Why an entry left the queue without the host choosing. */
export type ExternalContributionLapseReason = 'expired' | 'revoked' | 'shareEnded' | 'chatGone'

export interface ExternalContributionEntry {
  entryId: string
  chatId: string
  shareId: string
  /**
   * Identity is frozen at enqueue from the SESSION, never re-derived. By the
   * time the host reviews, the collaborator may be long gone — the entry is the
   * only carrier, and nothing the external sent may influence it.
   */
  collaboratorId: string
  displayName: string
  clientMessageId: string
  /** Allocated at ENQUEUE, atomically with the dedupe binding. */
  sequence: number
  /**
   * The contribution itself.
   *
   * Retained while `queued` and while `denied` — a denial is editable and
   * requeueable, and the collaborator's own draft is ephemeral React state that
   * a reload destroys, so dropping it here would make a denied message
   * unrecoverable. DROPPED on `approved` (it lives in the transcript now) and on
   * `lapsed` (nobody wants it), because retaining hundreds of bodies means
   * re-serialising megabytes synchronously on a hot path.
   */
  body?: string
  /** Survives the body so an audit can still answer "how big was it". */
  bodyBytes: number
  state: ExternalContributionState
  enqueuedAt: number
  expiresAt: number
  resolvedAt?: number
  /** Host-authored denial reason. Optional and never required. */
  hostReason?: string
  lapseReason?: ExternalContributionLapseReason
  /**
   * The transcript row this WILL become. Minted at enqueue, not at approve, so
   * sequence allocation and the caller's idempotency binding stay one atomic
   * write and an approved entry materialises under the id that binding already
   * points at.
   */
  messageId?: string
  /** P2b contribution intent, carried so approve can reproduce it faithfully. */
  intent?: 'requestHostAction'
  /**
   * True once the approved entry has actually been written into the transcript.
   * The two writes cannot be made atomic — this store does not fsync and the
   * chat store does — so approve marks the entry FIRST and materialises second.
   * A crash in between leaves `approved` + `materialised: false`, which a caller
   * reconciles by re-appending. The opposite order would double-append instead,
   * and losing a message is recoverable where duplicating one is not.
   */
  materialised?: boolean
}

export interface ExternalContributionQueueSnapshot {
  version: 1
  entries: ExternalContributionEntry[]
  /**
   * Dedupe bindings whose entry has been evicted.
   *
   * Persisted, and that is the whole point: the case a tombstone exists for is a
   * LONG-DELAYED retry, which is exactly when a restart has most likely happened
   * in between. An in-memory-only set can re-derive nothing on load — anything
   * evicted in a previous session is already absent from the file — so it would
   * defeat itself precisely when it was needed.
   */
  tombstones?: string[]
}

/** 24h, matching the app's existing pending-approval TTL rather than inventing
 * a second notion of "stale enough to drop". */
export const EXTERNAL_CONTRIBUTION_TTL_MS = 24 * 60 * 60 * 1000
/** Per collaborator, so one external cannot fill the queue and starve the
 * other. The wire rate limit is in-memory and does not survive a restart, so it
 * cannot be the only bound on a DURABLE store. */
export const MAX_QUEUED_PER_COLLABORATOR = 20
/** Total retained entries, terminal ones included. */
export const MAX_QUEUE_ENTRIES = 512
/** How long a resolved entry sticks around so the external can still be told
 * what happened to it after a reconnect. */
export const RESOLVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Matches the wire-boundary bound that today lives further downstream. Enqueue
 * is the first durable write, so the size gate has to be HERE — enqueueing
 * before it would make this an unbounded attacker-controlled store. */
export const MAX_CONTRIBUTION_CHARS = 8000
/**
 * The bound that actually matters. `MAX_CONTRIBUTION_CHARS` counts UTF-16 units,
 * so 8000 CJK characters is 24 000 bytes — a char cap alone makes the durable
 * store roughly three times larger than the constant implies, and every persist
 * is a synchronous stringify of the whole thing.
 */
export const MAX_CONTRIBUTION_BYTES = 12_000
/**
 * How many DENIED entries keep their body for edit-and-requeue. Bodies are the
 * expensive part and denied ones are retained for a week; without this bound the
 * "hundreds of bodies" cost the drop-on-lapse rule avoids simply reappears here.
 * Older denials keep their record and lose their body.
 */
export const MAX_DENIED_BODIES_RETAINED = 20
/**
 * Dedupe keys of evicted terminal entries. Without these, a retry of an
 * ALREADY-APPROVED clientMessageId whose entry has aged out enqueues a fresh
 * copy, the host is asked to approve a message that is already in the
 * transcript, and approving double-posts it. Per this file's own reasoning that
 * is the unrecoverable direction, so the binding outlives the entry.
 */
export const MAX_DEDUPE_TOMBSTONES = 4096

export type ExternalContributionEnqueueDenial =
  | 'duplicate'
  | 'too_large'
  | 'quota_exceeded'
  | 'invalid'

export interface ExternalContributionEnqueueResult {
  ok: boolean
  entry?: ExternalContributionEntry
  denial?: ExternalContributionEnqueueDenial
  /** Set when `duplicate`: the entry the retry maps to, whatever its state. */
  existing?: ExternalContributionEntry
}

function clone(entry: ExternalContributionEntry): ExternalContributionEntry {
  return { ...entry }
}

function isTerminal(state: ExternalContributionState): boolean {
  return state !== 'queued'
}

/**
 * LENGTH-PREFIXED, not delimiter-joined. A separator character only works while
 * neither field can contain it, and `clientMessageId` is supplied by the
 * external and validated for nothing but non-emptiness — so any delimiter,
 * including an unprintable one, can be forged to collide with somebody else's
 * binding and get their contribution refused as a duplicate of it. Prefixing the
 * first field's length is collision-proof whatever either string contains, and
 * needs no control byte in the source (a literal NUL here makes every tool that
 * reads this file treat it as binary).
 */
function dedupeKey(chatId: string, collaboratorId: string, clientMessageId: string): string {
  return `${chatId.length}:${chatId}:${collaboratorId.length}:${collaboratorId}:${clientMessageId}`
}

/** Prefix every binding for a chat shares. Lets erasure find bindings whose
 * entry is already gone — which is ALL of them, since a binding only outlives
 * its entry. Without the chat in the key, `purgeChats` could only delete
 * bindings for entries it could still see, i.e. none of them. */
function chatKeyPrefix(chatId: string): string {
  return `${chatId.length}:${chatId}:`
}

export class ExternalContributionQueueStore {
  private entries: ExternalContributionEntry[] = []
  /** Dedupe bindings that outlived their entry. Insertion-ordered and bounded. */
  private tombstones = new Set<string>()

  constructor(
    private readonly storagePath?: string,
    private readonly log?: (line: string) => void,
    /** Injected like the rest of this directory, so load-time retention can be
     * exercised deterministically instead of against the wall clock. */
    private readonly now: () => number = Date.now
  ) {
    this.load()
  }

  private load(): void {
    if (!this.storagePath || !existsSync(this.storagePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, 'utf8')) as unknown
      this.entries = normalizeEntries(parsed)
      let trimmedTombstones = false
      const persistedTombstones = (parsed as ExternalContributionQueueSnapshot | null)?.tombstones
      if (Array.isArray(persistedTombstones)) {
        for (const key of persistedTombstones.slice(-MAX_DEDUPE_TOMBSTONES)) {
          if (typeof key === 'string' && key) this.tombstones.add(key)
        }
        // A LOCAL, not the field: `compact()` resets `compactChanged` as its
        // first statement, so anything set here would be wiped before it ran.
        if (persistedTombstones.length !== this.tombstones.size) trimmedTombstones = true
      }
      // The read path is the OTHER door into this array, and it was ungated: a
      // hand-edited or corrupted file could load far past every cap the store
      // advertises. Enforce them here too, or "bounded" is only true of writes.
      this.compact(this.now())
      // Write the trim back. Otherwise a read-only session leaves an oversized
      // file on disk and the in-memory and persisted states diverge until some
      // unrelated verb happens to fire. Driven by a flag, not a count: the
      // denied-body trim and the tombstone tail-cap both change bytes without
      // changing how many entries there are.
      if (this.compactChanged || trimmedTombstones) this.persist()
    } catch (err) {
      // Degrade to an empty queue rather than throwing. Losing the queue costs
      // pending contributions; throwing here would take the whole collaboration
      // subsystem down with it, which is strictly worse.
      this.entries = []
      this.log?.(
        `[external-queue] unreadable queue file, starting empty: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  private persist(): void {
    if (!this.storagePath) return
    try {
      mkdirSync(dirname(this.storagePath), { recursive: true })
      const tmp = join(dirname(this.storagePath), `.${randomUUID()}.tmp`)
      const snapshot: ExternalContributionQueueSnapshot = {
        version: 1,
        entries: this.entries,
        tombstones: Array.from(this.tombstones)
      }
      writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 })
      renameSync(tmp, this.storagePath)
    } catch (err) {
      this.log?.(
        `[external-queue] persist failed: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Trim to the caps. Terminal entries go first, oldest-resolved first, because
   * a queued contribution is work someone is waiting on and a resolved one is
   * only a receipt. A queued entry is never evicted to make room — the
   * per-collaborator quota is what stops the queue growing, and silently
   * dropping somebody's pending message to admit somebody else's would be the
   * worst possible bound.
   */
  private retire(entries: readonly ExternalContributionEntry[]): void {
    for (const entry of entries) {
      this.tombstones.add(dedupeKey(entry.chatId, entry.collaboratorId, entry.clientMessageId))
    }
    if (this.tombstones.size <= MAX_DEDUPE_TOMBSTONES) return
    // Sets iterate in insertion order, so this drops the oldest bindings.
    const overflow = this.tombstones.size - MAX_DEDUPE_TOMBSTONES
    let dropped = 0
    for (const key of this.tombstones) {
      this.tombstones.delete(key)
      if (++dropped >= overflow) break
    }
  }

  /**
   * An approved entry that was never written to the transcript is UNFINISHED
   * WORK, not a receipt. Compaction must never reap it: `approve` marks first
   * and materialises second precisely so a crash is recoverable, and that
   * reasoning only holds if the reconciler still finds the entry when the app
   * comes back. Reaping it loses the message AND leaves its dedupe binding
   * behind, so the retry is refused too — unrecoverable from both ends.
   */
  private isReapable(entry: ExternalContributionEntry): boolean {
    if (!isTerminal(entry.state)) return false
    return !(entry.state === 'approved' && entry.materialised !== true)
  }

  /** True when the last `compact` changed anything at all. Counts alone are not
   * enough: the denied-body trim removes bodies without removing entries, so a
   * count comparison reports "nothing happened" and the trim never reaches disk. */
  private compactChanged = false

  private compact(now: number): void {
    this.compactChanged = false
    const expired = this.entries.filter(
      (entry) =>
        this.isReapable(entry) &&
        now - (entry.resolvedAt ?? entry.enqueuedAt) > RESOLVED_RETENTION_MS
    )
    if (expired.length) {
      this.compactChanged = true
      this.retire(expired)
      const doomedIds = new Set(expired.map((entry) => entry.entryId))
      this.entries = this.entries.filter((entry) => !doomedIds.has(entry.entryId))
    }
    // Denied entries keep their body so a denial can be edited and requeued —
    // but only the most recent few. Older denials keep the RECORD (so the person
    // can still be told what happened) and lose the expensive part.
    const deniedWithBody = this.entries
      .filter((entry) => entry.state === 'denied' && typeof entry.body === 'string')
      .sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))
    for (const entry of deniedWithBody.slice(MAX_DENIED_BODIES_RETAINED)) {
      delete entry.body
      this.compactChanged = true
    }
    if (this.entries.length <= MAX_QUEUE_ENTRIES) return
    const terminal = this.entries
      .filter((entry) => this.isReapable(entry))
      .sort((a, b) => (a.resolvedAt ?? a.enqueuedAt) - (b.resolvedAt ?? b.enqueuedAt))
    const overflow = this.entries.length - MAX_QUEUE_ENTRIES
    const evicted = terminal.slice(0, overflow)
    if (evicted.length) this.compactChanged = true
    this.retire(evicted)
    const doomed = new Set(evicted.map((entry) => entry.entryId))
    this.entries = this.entries.filter((entry) => !doomed.has(entry.entryId))
  }

  enqueue(args: {
    chatId: string
    shareId: string
    collaboratorId: string
    displayName: string
    clientMessageId: string
    sequence: number
    body: string
    messageId?: string
    intent?: 'requestHostAction'
    now?: number
    ttlMs?: number
  }): ExternalContributionEnqueueResult {
    const now = args.now ?? this.now()
    if (
      !args.chatId ||
      !args.shareId ||
      !args.collaboratorId ||
      !args.clientMessageId ||
      typeof args.body !== 'string' ||
      !args.body.trim()
    ) {
      return { ok: false, denial: 'invalid' }
    }
    // Dedupe on the SENDER's id, scoped to the collaborator. This is the queue's
    // own binding and deliberately does not lean on the share store's
    // idempotency map: that map is capped at 512 and evicts oldest-first, so a
    // pending entry could lose its dedupe key while still waiting and a retry
    // would enqueue a second copy.
    // Chat-scoped, matching the tombstone key and `findByClientMessageId`. All
    // three must agree: two different chats can legitimately carry the same
    // clientMessageId from the same person, and treating that as a duplicate
    // silently refuses a real contribution.
    const existing = this.entries.find(
      (entry) =>
        entry.chatId === args.chatId &&
        entry.collaboratorId === args.collaboratorId &&
        entry.clientMessageId === args.clientMessageId
    )
    if (existing) return { ok: false, denial: 'duplicate', existing: clone(existing) }
    // The entry may have aged out while its binding must not: re-enqueueing an
    // already-approved clientMessageId would ask the host to approve something
    // already in the transcript, and approving would double-post it.
    if (this.tombstones.has(dedupeKey(args.chatId, args.collaboratorId, args.clientMessageId))) {
      return { ok: false, denial: 'duplicate' }
    }
    const body = args.body.trim()
    if (
      body.length > MAX_CONTRIBUTION_CHARS ||
      Buffer.byteLength(body, 'utf8') > MAX_CONTRIBUTION_BYTES
    ) {
      return { ok: false, denial: 'too_large' }
    }
    // Chat-scoped, matching `queuedCountForCollaborator` and the dedupe scan
    // above. If this counted across chats while the caller's pre-check did not,
    // the pre-check would pass and this would refuse — AFTER the caller had
    // already allocated a sequence number, which is precisely the defect the
    // pre-check exists to remove.
    const queuedForCollaborator = this.entries.filter(
      (entry) =>
        entry.chatId === args.chatId &&
        entry.collaboratorId === args.collaboratorId &&
        entry.state === 'queued'
    ).length
    if (queuedForCollaborator >= MAX_QUEUED_PER_COLLABORATOR) {
      return { ok: false, denial: 'quota_exceeded' }
    }
    const entry: ExternalContributionEntry = {
      entryId: randomUUID(),
      chatId: args.chatId,
      shareId: args.shareId,
      collaboratorId: args.collaboratorId,
      displayName: args.displayName,
      clientMessageId: args.clientMessageId,
      sequence: clampSequence(args.sequence),
      body,
      bodyBytes: Buffer.byteLength(body, 'utf8'),
      state: 'queued',
      enqueuedAt: now,
      expiresAt: now + (args.ttlMs ?? EXTERNAL_CONTRIBUTION_TTL_MS),
      ...(args.messageId ? { messageId: args.messageId } : {}),
      ...(args.intent === 'requestHostAction' ? { intent: 'requestHostAction' as const } : {})
    }
    this.entries.push(entry)
    this.compact(now)
    this.persist()
    return { ok: true, entry: clone(entry) }
  }

  /**
   * How many contributions this person already has awaiting review.
   *
   * Exists so a caller can refuse BEFORE allocating a sequence number and
   * binding an idempotency key. Discovering the quota only at enqueue means
   * every refused retry burns a sequence and leaves a binding naming a row that
   * will never exist.
   */
  queuedCountForCollaborator(chatId: string, collaboratorId: string): number {
    return this.entries.filter(
      (entry) =>
        entry.state === 'queued' &&
        entry.chatId === chatId &&
        entry.collaboratorId === collaboratorId
    ).length
  }

  /** Queued entries, oldest first — review order is arrival order. */
  listQueued(chatId?: string): ExternalContributionEntry[] {
    return (
      this.entries
        .filter((entry) => entry.state === 'queued' && (!chatId || entry.chatId === chatId))
        // Totally ordered, not merely stable: a backward-clock re-anchor sets
        // every affected `enqueuedAt` to the same instant, which would otherwise
        // collapse "review order is arrival order" into one tie broken only by
        // array position.
        .sort(
          (a, b) =>
            a.enqueuedAt - b.enqueuedAt ||
            a.sequence - b.sequence ||
            (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0)
        )
        .map(clone)
    )
  }

  /**
   * What may cross to the collaborator. A WHITELIST, and the mirror of this
   * file's thesis: nothing unapproved reaches the transcript, and nothing
   * host-private reaches the external. `hostReason` IS included — a denial may
   * carry a reason and the person is meant to see it — but it is listed
   * deliberately rather than arriving via a spread, so a field added later is
   * private by default.
   */
  static toCollaboratorView(entry: ExternalContributionEntry): {
    entryId: string
    clientMessageId: string
    state: ExternalContributionState
    enqueuedAt: number
    expiresAt: number
    resolvedAt?: number
    hostReason?: string
    lapseReason?: ExternalContributionLapseReason
  } {
    return {
      entryId: entry.entryId,
      clientMessageId: entry.clientMessageId,
      state: entry.state,
      enqueuedAt: entry.enqueuedAt,
      expiresAt: entry.expiresAt,
      ...(typeof entry.resolvedAt === 'number' ? { resolvedAt: entry.resolvedAt } : {}),
      ...(entry.hostReason ? { hostReason: entry.hostReason } : {}),
      ...(entry.lapseReason ? { lapseReason: entry.lapseReason } : {})
    }
  }

  /** Everything for one collaborator, so they can be told what happened. */
  listForCollaborator(collaboratorId: string): ExternalContributionEntry[] {
    return this.entries
      .filter((entry) => entry.collaboratorId === collaboratorId)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)
      .map(clone)
  }

  /** The pending-or-resolved entry a retry maps to. Lets a caller's idempotency
   * check answer the third state — mapped, but not yet in the transcript. */
  findByClientMessageId(
    chatId: string,
    collaboratorId: string,
    clientMessageId: string
  ): ExternalContributionEntry | null {
    const found = this.entries.find(
      (entry) =>
        entry.chatId === chatId &&
        entry.collaboratorId === collaboratorId &&
        entry.clientMessageId === clientMessageId
    )
    return found ? clone(found) : null
  }

  get(entryId: string): ExternalContributionEntry | null {
    const found = this.entries.find((entry) => entry.entryId === entryId)
    return found ? clone(found) : null
  }

  /**
   * Mark approved and hand back the body for materialisation. Deliberately does
   * NOT drop the body yet — the caller still has to write the transcript row,
   * and `markMaterialised` is what closes the loop. See `materialised`.
   */
  approve(entryId: string, messageId?: string, now = this.now()): ExternalContributionEntry | null {
    const entry = this.entries.find(
      (candidate) => candidate.entryId === entryId && candidate.state === 'queued'
    )
    if (!entry) return null
    // The id minted at enqueue is the default; an explicit one still wins so a
    // caller that owns row identity can supply it. Neither ⇒ refuse: an approved
    // entry with no target row could never be materialised.
    const targetMessageId = messageId || entry.messageId
    if (!targetMessageId) return null
    entry.state = 'approved'
    entry.resolvedAt = now
    entry.messageId = targetMessageId
    entry.materialised = false
    this.persist()
    return clone(entry)
  }

  /** The transcript row now exists; the body is redundant and is dropped. */
  markMaterialised(entryId: string): ExternalContributionEntry | null {
    const entry = this.entries.find(
      (candidate) => candidate.entryId === entryId && candidate.state === 'approved'
    )
    if (!entry) return null
    entry.materialised = true
    delete entry.body
    this.persist()
    return clone(entry)
  }

  /** Approved but never written — a crash landed between the two writes. */
  listAwaitingMaterialisation(): ExternalContributionEntry[] {
    return this.entries
      .filter((entry) => entry.state === 'approved' && entry.materialised !== true)
      .sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0))
      .map(clone)
  }

  /** Host declined it. The body is KEPT so it can be edited and requeued. */
  deny(entryId: string, reason?: string, now = this.now()): ExternalContributionEntry | null {
    const entry = this.entries.find(
      (candidate) => candidate.entryId === entryId && candidate.state === 'queued'
    )
    if (!entry) return null
    entry.state = 'denied'
    entry.resolvedAt = now
    if (reason && reason.trim()) entry.hostReason = reason.trim().slice(0, 500)
    this.persist()
    return clone(entry)
  }

  /**
   * Force-resolve everything queued for a collaborator or a whole share.
   *
   * Used by revoke: once a pubkey is revoked it can never reconnect to that
   * share, so a queued message left behind would stay approvable after trust was
   * withdrawn. The caller attempts delivery BEFORE completing the revoke, which
   * is the only window in which the person can still be told.
   */
  lapseAll(
    filter: { shareId?: string; collaboratorId?: string; chatIds?: readonly string[] },
    reason: ExternalContributionLapseReason,
    now = this.now()
  ): ExternalContributionEntry[] {
    // REFUSE a filter with no effective predicate. Every field is optional, so
    // `lapseAll({ shareId: share?.id }, 'shareEnded')` with an undefined share
    // would otherwise wipe the entire queue across every chat and collaborator —
    // and that is the most natural way anyone will call this. `purgeAll` exists
    // for the deliberate case.
    const hasPredicate =
      Boolean(filter.shareId) ||
      Boolean(filter.collaboratorId) ||
      (Array.isArray(filter.chatIds) && filter.chatIds.length > 0)
    if (!hasPredicate) {
      this.log?.('[external-queue] lapseAll refused: no filter predicate')
      return []
    }
    const chatIds = filter.chatIds?.length ? new Set(filter.chatIds) : null
    const affected: ExternalContributionEntry[] = []
    for (const entry of this.entries) {
      if (entry.state !== 'queued') continue
      if (filter.shareId && entry.shareId !== filter.shareId) continue
      if (filter.collaboratorId && entry.collaboratorId !== filter.collaboratorId) continue
      if (chatIds && !chatIds.has(entry.chatId)) continue
      entry.state = 'lapsed'
      entry.resolvedAt = now
      entry.lapseReason = reason
      delete entry.body
      affected.push(clone(entry))
    }
    if (affected.length) this.persist()
    return affected
  }

  /**
   * Expire everything past its deadline. Iterates the QUEUE, never the live
   * share list — a revoked share is only flagged disabled and is never removed,
   * so entries under one would otherwise never be swept.
   *
   * A clock that moved BACKWARD (sleep/wake, NTP correction) re-anchors instead
   * of expiring: a negative elapsed time is never evidence that a deadline
   * passed, and treating it as such would lapse the entire queue at once.
   */
  sweep(now = this.now()): ExternalContributionEntry[] {
    const lapsed: ExternalContributionEntry[] = []
    let reanchored = false
    for (const entry of this.entries) {
      if (entry.state !== 'queued') continue
      if (now < entry.enqueuedAt) {
        const ttl = entry.expiresAt - entry.enqueuedAt
        entry.enqueuedAt = now
        entry.expiresAt = now + ttl
        reanchored = true
        continue
      }
      if (now < entry.expiresAt) continue
      entry.state = 'lapsed'
      entry.resolvedAt = now
      entry.lapseReason = 'expired'
      delete entry.body
      lapsed.push(clone(entry))
    }
    this.compact(now)
    // Persist a re-anchor too. Without this the correction lives only in memory
    // and reaches disk by accident, whenever some unrelated verb next writes —
    // so whether a clock correction survived a restart depended on whether
    // somebody happened to approve something afterwards.
    if (lapsed.length || reanchored) this.persist()
    return lapsed
  }

  /** Chat-scoped erasure. Must run for `truncate` too: that kind keeps the
   * share alive, so the queue would otherwise outlive the rows it belongs to. */
  purgeChats(chatIds: readonly string[]): number {
    const doomed = new Set(chatIds)
    const before = this.entries.length
    const tombstonesBefore = this.tombstones.size
    // Erasure REMOVES the dedupe binding rather than retiring it. A tombstone
    // carries a collaboratorId and a clientMessageId — identifiers tied to that
    // person's contributions — so keeping one for erased content would leave a
    // trace of the very thing being erased, and the anti-duplication reason for
    // tombstones is moot once the message is gone.
    // Walk the TOMBSTONES, not the entries. A binding only ever exists for an
    // entry that is already gone — `enqueue` refuses a tombstoned id, so a live
    // entry is never tombstoned — which made the obvious entry-walk dead code
    // and left exactly the trace erasure exists to remove.
    for (const chatId of doomed) {
      const prefix = chatKeyPrefix(chatId)
      for (const key of this.tombstones) {
        if (key.startsWith(prefix)) this.tombstones.delete(key)
      }
    }
    this.entries = this.entries.filter((entry) => !doomed.has(entry.chatId))
    const removed = before - this.entries.length
    // Guarding on the ENTRY count alone loses exactly the case this method
    // exists for: a binding outlives its entry, so "this chat has bindings and
    // no live entries" is the erasure that must reach disk. Erasure that looks
    // like it worked and silently reverts on restart is worse than none.
    if (removed || this.tombstones.size !== tombstonesBefore) this.persist()
    return removed
  }

  purgeAll(): void {
    if (!this.entries.length && !this.tombstones.size) return
    this.entries = []
    this.tombstones.clear()
    this.persist()
  }

  /** Chats with at least one queued contribution — the guard that stops the
   * abandoned-chat reaper deleting a shared chat whose only content is waiting
   * for review. */
  chatIdsWithQueued(): string[] {
    return Array.from(
      new Set(this.entries.filter((entry) => entry.state === 'queued').map((entry) => entry.chatId))
    )
  }
}

const LAPSE_REASONS: ReadonlySet<string> = new Set(['expired', 'revoked', 'shareEnded', 'chatGone'])

function isLapseReason(value: unknown): value is ExternalContributionLapseReason {
  return typeof value === 'string' && LAPSE_REASONS.has(value)
}

/** Non-negative and bounded. Advisory ordering hint, never an authority. */
export const MAX_SEQUENCE = 1_000_000_000
function clampSequence(value: unknown): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.floor(Number(value)), 0), MAX_SEQUENCE)
}

/** Never further out than one TTL from enqueue, and never before it. */
function clampExpiry(enqueuedAt: number, candidate: unknown): number {
  const ceiling = enqueuedAt + EXTERNAL_CONTRIBUTION_TTL_MS
  if (!Number.isFinite(candidate)) return ceiling
  return Math.min(Math.max(Number(candidate), enqueuedAt), ceiling)
}

function normalizeEntries(value: unknown): ExternalContributionEntry[] {
  const raw = (value as ExternalContributionQueueSnapshot | null)?.entries
  if (!Array.isArray(raw)) return []
  const out: ExternalContributionEntry[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object') continue
    const entry = candidate as Partial<ExternalContributionEntry>
    if (
      typeof entry.entryId !== 'string' ||
      typeof entry.chatId !== 'string' ||
      typeof entry.shareId !== 'string' ||
      typeof entry.collaboratorId !== 'string' ||
      typeof entry.clientMessageId !== 'string' ||
      typeof entry.enqueuedAt !== 'number'
    ) {
      continue
    }
    const state: ExternalContributionState =
      entry.state === 'approved' || entry.state === 'denied' || entry.state === 'lapsed'
        ? entry.state
        : 'queued'
    out.push({
      entryId: entry.entryId,
      chatId: entry.chatId,
      shareId: entry.shareId,
      collaboratorId: entry.collaboratorId,
      displayName: typeof entry.displayName === 'string' ? entry.displayName : 'External',
      clientMessageId: entry.clientMessageId,
      // Clamped non-negative. `sequence` is a tiebreaker for the host's REVIEW
      // ORDER and is supplied by the caller from wire arrival, so an unclamped
      // negative would let a collaborator sort itself to the front of the queue.
      // Advisory and untrusted — never treat it as an authority.
      sequence: clampSequence(entry.sequence),
      // A body that is not a string is dropped, never coerced — `String(obj)`
      // on a hand-edited file would resurrect junk as content. Oversized bodies
      // are dropped too: the record survives so the person can still be told what
      // happened, but a hand-edited 50 KB body must not load at full size when
      // enqueue would have refused it.
      ...(typeof entry.body === 'string' &&
      Buffer.byteLength(entry.body, 'utf8') <= MAX_CONTRIBUTION_BYTES
        ? { body: entry.body }
        : {}),
      bodyBytes: Number.isFinite(entry.bodyBytes) ? Number(entry.bodyBytes) : 0,
      state,
      enqueuedAt: entry.enqueuedAt,
      // CLAMPED, not merely defaulted. An `expiresAt` of 1e18 in a hand-edited
      // file survives every sweep forever — and because queued entries are never
      // evicted and `chatIdsWithQueued` reports their chat, that one line would
      // also make the chat permanently un-reapable.
      expiresAt: clampExpiry(entry.enqueuedAt, entry.expiresAt),
      ...(Number.isFinite(entry.resolvedAt) ? { resolvedAt: Number(entry.resolvedAt) } : {}),
      ...(typeof entry.hostReason === 'string'
        ? { hostReason: entry.hostReason.slice(0, 500) }
        : {}),
      // Narrowed against the union like `state` above it. This value is destined
      // for a human-facing surface, so an unvalidated one from a hand-edited file
      // is arbitrary content wearing a typed field's name.
      ...(isLapseReason(entry.lapseReason) ? { lapseReason: entry.lapseReason } : {}),
      ...(typeof entry.messageId === 'string' ? { messageId: entry.messageId } : {}),
      ...(entry.intent === 'requestHostAction' ? { intent: 'requestHostAction' as const } : {}),
      ...(entry.materialised === true ? { materialised: true } : {}),
      ...(state === 'approved' && entry.materialised !== true ? { materialised: false } : {})
    })
  }
  return out
}
