/**
 * Durability tickets: where the wait for a sync lives now that a save does not
 * wait for one.
 *
 * `saveChat` is synchronous and has dozens of callers, so it cannot await the
 * off-loop sync that makes a write durable. Instead a save that contains one
 * of the four moments below notes a ticket holding that sync's barrier, and
 * the few places that tell the user or another component "done" call
 * `awaitChat` first. A save with no such moment, streamed text above all,
 * notes nothing and nobody waits for it.
 *
 * A gate can wait for some of the moments only: the places the user sits in
 * wait for the user's moments, whose barriers are urgent, and never for a
 * run's final record, whose barrier is not. Coverage, failures and waits are
 * kept per moment, so such a gate covers, and is told of, only what it waited
 * for.
 *
 * Pure bookkeeping: it starts no sync and no timer, and reads the clock it is
 * given.
 *
 * Memory: one callback per ticket whose sync is still running, one small entry
 * per `awaitChat` still waiting, and one fixed-size record per chat that has
 * either of those or a settled ticket nobody has awaited yet that is younger
 * than the grace period. Nothing is kept per ticket once it has settled, and a
 * chat with none of these has no record at all.
 */

/** The moments that are reported as done only after a sync. */
export const CHAT_DURABILITY_MOMENTS = [
  /** A user message was accepted. */
  'user_message',
  /** An approval or an answer was recorded. */
  'decision',
  /** A run's final record was written. */
  'run_final',
  /** History was deleted, truncated or rewound. */
  'destructive'
] as const

export type ChatDurabilityMoment = (typeof CHAT_DURABILITY_MOMENTS)[number]

/** The moments the user sits in: their tickets wait for an urgent barrier. */
export const USER_DURABILITY_MOMENTS: readonly ChatDurabilityMoment[] = [
  'user_message',
  'decision',
  'destructive'
]

/**
 * How long a ticket may go without any `awaitChat` for its chat before it is
 * judged uncovered. The time runs from the chat's most recent ticket, and all
 * the chat's unawaited tickets are judged together when it runs out. A gate
 * calls `awaitChat` within the same piece of work as its save, so thirty
 * seconds separates a late gate from a missing one even on a stalled loop.
 */
export const CHAT_TICKET_COVERAGE_GRACE_MS = 30_000

export interface ChatDurabilityMomentCounters {
  /** Tickets noted. */
  noted: number
  /** Tickets some `awaitChat` waited for, or would have had they not already settled. */
  covered: number
  /** Tickets judged after the grace period with no `awaitChat` for their chat. */
  uncovered: number
  /** Tickets whose barrier failed. */
  failed: number
  /** Tickets whose sync is still running. */
  pending: number
  /** Settled tickets that are neither covered nor yet judged. */
  undecided: number
  /** The longest time from noting a ticket to its barrier settling. */
  longestWaitMs: number
}

export interface ChatDurabilityTicketsSnapshot {
  moments: Record<ChatDurabilityMoment, ChatDurabilityMomentCounters>
  /**
   * Uncovered tickets for a user message, a decision or a destructive change.
   * Each one is a place that reported "done" without waiting: the count must
   * be zero.
   */
  missingGates: number
  /** Uncovered final run records. A run with no follow-on work has no gate, so these are expected. */
  uncoveredRunFinals: number
  /** The most recent missing gate, to find the place that did not wait. */
  lastMissingGate: { chatId: string; revision: number; moment: ChatDurabilityMoment } | null
  /** Calls to `awaitChat`, how many of them were rejected, and how many are still waiting. */
  awaits: number
  awaitsRejected: number
  awaitsWaiting: number
  /** The longest time an `awaitChat` took to settle. */
  longestAwaitMs: number
  /** Chat records held right now. */
  chats: number
}

interface Gate {
  /** Covers the chat's tickets up to this one, of the moments it waits for. */
  through: number
  /** By moment index: whether it waits for that moment. */
  moments: readonly boolean[]
  /** How many of them are still pending. */
  remaining: number
  startedAt: number
  resolve(): void
  reject(reason: unknown): void
}

interface ChatTickets {
  /** Tickets noted for the chat while this record has existed. */
  noted: number
  /** Per moment: every ticket of it up to this one has been awaited. */
  coveredThrough: number[]
  /** Tickets whose sync is still running, and per moment. */
  pending: number
  pendingByMoment: number[]
  /** Per moment: pending tickets no `awaitChat` has covered yet. */
  pendingUncovered: number[]
  /** Per moment: settled tickets no `awaitChat` has covered yet, and the newest one's revision. */
  undecided: number[]
  undecidedRevision: number[]
  /** Per moment: the first failure no awaiter has been told of, and its ticket. */
  failures: Array<{ reason: unknown; ticket: number } | null>
  gates: Gate[]
}

const RUN_FINAL = CHAT_DURABILITY_MOMENTS.indexOf('run_final')

/** By moment index, whether `moments` names it; every moment when it is omitted. */
function selection(moments: readonly ChatDurabilityMoment[] | undefined): boolean[] {
  if (moments === undefined) return CHAT_DURABILITY_MOMENTS.map(() => true)
  const selected = CHAT_DURABILITY_MOMENTS.map(() => false)
  for (const moment of moments) {
    const index = CHAT_DURABILITY_MOMENTS.indexOf(moment)
    if (index < 0) throw new Error('Invalid durability moment')
    selected[index] = true
  }
  return selected
}

function emptyCounters(): ChatDurabilityMomentCounters {
  return {
    noted: 0,
    covered: 0,
    uncovered: 0,
    failed: 0,
    pending: 0,
    undecided: 0,
    longestWaitMs: 0
  }
}

export class ChatDurabilityTickets {
  private readonly now: () => number
  private readonly graceMs: number
  private readonly counters = CHAT_DURABILITY_MOMENTS.map(emptyCounters)
  private readonly chats = new Map<string, ChatTickets>()
  /**
   * When each chat's unawaited tickets fall due for judgement. A chat moves to
   * the end whenever a ticket is noted for it, so the map stays in due order
   * and a sweep stops at the first chat that is not due.
   */
  private readonly due = new Map<string, number>()
  private lastMissingGate: ChatDurabilityTicketsSnapshot['lastMissingGate'] = null
  private awaits = 0
  private awaitsRejected = 0
  private awaitsWaiting = 0
  private longestAwaitMs = 0

  constructor(options: { now: () => number; graceMs?: number }) {
    const grace = options.graceMs ?? CHAT_TICKET_COVERAGE_GRACE_MS
    if (!Number.isFinite(grace) || grace <= 0) throw new Error('Invalid coverage grace period')
    this.now = options.now
    this.graceMs = grace
  }

  /**
   * Records that the save which produced `revision` contained `moment`, and
   * that `barrier` settles when it is durable. A barrier that fails is held
   * for the chat's next awaiter; it is never left as an unhandled rejection.
   */
  note(
    chatId: string,
    revision: number,
    moment: ChatDurabilityMoment,
    barrier: Promise<void>
  ): void {
    if (typeof chatId !== 'string' || chatId.length === 0) throw new Error('Invalid chat id')
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid revision')
    const index = CHAT_DURABILITY_MOMENTS.indexOf(moment)
    if (index < 0) throw new Error('Invalid durability moment')
    const notedAt = this.now()
    this.collect(notedAt)
    let chat = this.chats.get(chatId)
    if (!chat) {
      chat = {
        noted: 0,
        coveredThrough: CHAT_DURABILITY_MOMENTS.map(() => 0),
        pending: 0,
        pendingByMoment: CHAT_DURABILITY_MOMENTS.map(() => 0),
        pendingUncovered: CHAT_DURABILITY_MOMENTS.map(() => 0),
        undecided: CHAT_DURABILITY_MOMENTS.map(() => 0),
        undecidedRevision: CHAT_DURABILITY_MOMENTS.map(() => 0),
        failures: CHAT_DURABILITY_MOMENTS.map(() => null),
        gates: []
      }
      this.chats.set(chatId, chat)
    }
    const ticket = ++chat.noted
    chat.pending++
    chat.pendingByMoment[index]++
    chat.pendingUncovered[index]++
    this.counters[index].noted++
    this.counters[index].pending++
    this.due.delete(chatId)
    this.due.set(chatId, notedAt + this.graceMs)
    const record = chat
    const settle = (failure: { reason: unknown } | null): void =>
      this.settle(chatId, record, ticket, index, revision, notedAt, failure)
    // Both outcomes are handled here, so a failed barrier is never unhandled.
    Promise.resolve(barrier).then(
      () => settle(null),
      (reason: unknown) => settle({ reason })
    )
  }

  /**
   * Resolves once every ticket noted so far for the chat has settled; a chat
   * with none resolves at once. Rejects, with the barrier's own reason, as
   * soon as one of those tickets fails, including one that failed before this
   * call and that no earlier awaiter was told of. A failure is delivered to
   * the awaiters that cover it and to nobody after them.
   *
   * Every ticket noted so far counts as covered from this call on, whether or
   * not it has already settled.
   *
   * With `moments`, all of this holds for the tickets of those moments only:
   * the others are neither waited for, covered nor reported.
   */
  awaitChat(chatId: string, moments?: readonly ChatDurabilityMoment[]): Promise<void> {
    const selected = selection(moments)
    const startedAt = this.now()
    this.collect(startedAt)
    this.awaits++
    const chat = this.chats.get(chatId)
    if (!chat) return Promise.resolve()
    let failure: { reason: unknown; ticket: number } | null = null
    let remaining = 0
    for (let index = 0; index < CHAT_DURABILITY_MOMENTS.length; index++) {
      if (!selected[index]) continue
      const counters = this.counters[index]
      counters.covered += chat.pendingUncovered[index] + chat.undecided[index]
      counters.undecided -= chat.undecided[index]
      chat.pendingUncovered[index] = 0
      chat.undecided[index] = 0
      chat.coveredThrough[index] = chat.noted
      // The first to fail, whichever moment it was for.
      const failed = chat.failures[index]
      if (failed && (!failure || failed.ticket < failure.ticket)) failure = failed
      chat.failures[index] = null
      remaining += chat.pendingByMoment[index]
    }
    if (failure) {
      this.awaitsRejected++
      this.dropIfIdle(chatId, chat)
      return Promise.reject(failure.reason)
    }
    if (remaining === 0) {
      this.dropIfIdle(chatId, chat)
      return Promise.resolve()
    }
    this.awaitsWaiting++
    return new Promise<void>((resolve, reject) => {
      chat.gates.push({
        through: chat.noted,
        moments: selected,
        remaining,
        startedAt,
        resolve,
        reject
      })
    })
  }

  /**
   * Whether the chat has a ticket of `moments` (every moment when omitted)
   * that `awaitChat` would wait for, cover or report: one whose sync is still
   * running, one settled that nobody has awaited, or a failure nobody was
   * told of. Without one, `awaitChat` would resolve at once and change no count.
   */
  holds(chatId: string, moments?: readonly ChatDurabilityMoment[]): boolean {
    const chat = this.chats.get(chatId)
    if (!chat) return false
    const selected = selection(moments)
    return CHAT_DURABILITY_MOMENTS.some(
      (_, index) =>
        selected[index] &&
        (chat.pendingByMoment[index] > 0 ||
          chat.undecided[index] > 0 ||
          chat.failures[index] !== null)
    )
  }

  /** The chats that hold anything: a ticket pending, one to judge, or a gate open. */
  chatIds(): string[] {
    return [...this.chats.keys()]
  }

  /**
   * Judges every chat whose grace period has passed: its settled tickets that
   * nobody awaited become uncovered, a failure nobody came for is forgotten,
   * and the chat's record is dropped unless a sync or a gate is still open.
   * `note`, `awaitChat` and `snapshot` call this themselves; a caller that
   * wants the counts exact while nothing else happens can call it when
   * `nextDeadline` says so.
   */
  collect(now: number = this.now()): void {
    for (const [chatId, dueAt] of this.due) {
      if (dueAt > now) break
      this.due.delete(chatId)
      const chat = this.chats.get(chatId)
      if (!chat) continue
      CHAT_DURABILITY_MOMENTS.forEach((moment, index) => {
        const count = chat.undecided[index]
        if (count === 0) return
        this.counters[index].uncovered += count
        this.counters[index].undecided -= count
        chat.undecided[index] = 0
        if (index !== RUN_FINAL) {
          this.lastMissingGate = { chatId, revision: chat.undecidedRevision[index], moment }
        }
      })
      chat.failures.fill(null)
      // A sync or a gate still open keeps the record: look again a grace period from now.
      if (!this.dropIfIdle(chatId, chat)) this.due.set(chatId, now + this.graceMs)
    }
  }

  /** The time of the next judgement `collect` has to make, or null when nothing is waiting for one. */
  nextDeadline(): number | null {
    for (const dueAt of this.due.values()) return dueAt
    return null
  }

  snapshot(): ChatDurabilityTicketsSnapshot {
    this.collect()
    const moments = {} as Record<ChatDurabilityMoment, ChatDurabilityMomentCounters>
    let missingGates = 0
    CHAT_DURABILITY_MOMENTS.forEach((moment, index) => {
      moments[moment] = { ...this.counters[index] }
      if (index !== RUN_FINAL) missingGates += this.counters[index].uncovered
    })
    return {
      moments,
      missingGates,
      uncoveredRunFinals: this.counters[RUN_FINAL].uncovered,
      lastMissingGate: this.lastMissingGate ? { ...this.lastMissingGate } : null,
      awaits: this.awaits,
      awaitsRejected: this.awaitsRejected,
      awaitsWaiting: this.awaitsWaiting,
      longestAwaitMs: this.longestAwaitMs,
      chats: this.chats.size
    }
  }

  private settle(
    chatId: string,
    chat: ChatTickets,
    ticket: number,
    index: number,
    revision: number,
    notedAt: number,
    failure: { reason: unknown } | null
  ): void {
    const settledAt = this.now()
    const counters = this.counters[index]
    counters.pending--
    counters.longestWaitMs = Math.max(counters.longestWaitMs, settledAt - notedAt)
    if (failure) counters.failed++
    chat.pending--
    chat.pendingByMoment[index]--
    if (ticket > chat.coveredThrough[index]) {
      // Nobody has awaited this ticket yet. Keep its count, and its failure,
      // for an awaiter that arrives within the grace period.
      chat.pendingUncovered[index]--
      chat.undecided[index]++
      chat.undecidedRevision[index] = Math.max(chat.undecidedRevision[index], revision)
      counters.undecided++
      if (failure) chat.failures[index] ??= { reason: failure.reason, ticket }
    }
    chat.gates = chat.gates.filter((gate) => {
      if (!gate.moments[index] || gate.through < ticket) return true
      if (!failure && --gate.remaining > 0) return true
      this.awaitsWaiting--
      this.longestAwaitMs = Math.max(this.longestAwaitMs, settledAt - gate.startedAt)
      if (failure) {
        this.awaitsRejected++
        gate.reject(failure.reason)
      } else {
        gate.resolve()
      }
      return false
    })
    this.dropIfIdle(chatId, chat)
  }

  /** Drops a chat's record once it has nothing pending, nobody waiting and nothing left to judge. */
  private dropIfIdle(chatId: string, chat: ChatTickets): boolean {
    if (chat.pending > 0 || chat.gates.length > 0) return false
    // A failure nobody has been told of belongs to a ticket still counted here.
    if (chat.undecided.some((count) => count > 0)) return false
    this.chats.delete(chatId)
    this.due.delete(chatId)
    return true
  }
}
