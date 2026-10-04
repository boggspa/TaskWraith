/**
 * When a thread this app owns still gets a whole-thread copy, and when its log
 * is compacted.
 *
 * While the app is a thread's only writer, the log is the thread and a save is
 * an append. A full copy is still written for the Host and for older builds,
 * but only at the moments listed under `OwnedThreadCopyReason`, never because
 * a save happened. The log is compacted on appended bytes alone.
 *
 * The policy only decides. It is told what happened and when, and answers with
 * what the caller should now carry out off the main thread and with the next
 * time it wants to be asked, so the caller needs one timer at most. It never
 * asks for a synchronous checkpoint, and it reads no clock and no file.
 *
 * The caller reports the events of the threads it owns, and answers every
 * publish decision with `published` or `publishFailed`: until it does, no
 * second copy of that revision is asked for.
 *
 * Memory: one small record per followed thread, dropped by `released`, and
 * the ids of the runs live on each thread.
 */

/**
 * A thread with no live run and no append for this long is idle. Its copy is
 * published then, if the log is ahead.
 */
export const OWNED_THREAD_IDLE_PUBLISH_MS = 15_000

/**
 * The longest the log may stay ahead of the newest full copy without a break.
 * A thread that streams without ever going idle is published at this point, so
 * a build that can only read the full copy is never further behind than this.
 */
export const OWNED_THREAD_STREAM_CAP_MS = 30 * 60_000

/** Bytes appended to the log since its last checkpoint before it is compacted. */
export const OWNED_THREAD_COMPACT_BYTES = 16 * 1024 * 1024

/** How long to leave a thread alone after a publish failed before asking again. */
export const OWNED_THREAD_PUBLISH_RETRY_MS = 15_000

/**
 * Why a full copy is published.
 * - `creation`: the thread was just created.
 * - `idle`: no run is live, nothing was appended for the idle period, and the
 *   log is ahead of the last copy.
 * - `stream_cap`: the log has been ahead of the last copy for the cap period.
 * - `quit`: the app is quitting and the log is ahead.
 * - `handoff`: the Host asked for the thread and the log is ahead.
 * - `journal_failure`: the log could not take a save, so the copy is all that
 *   records it.
 */
export type OwnedThreadCopyReason =
  | 'creation'
  | 'idle'
  | 'stream_cap'
  | 'quit'
  | 'handoff'
  | 'journal_failure'

export type OwnedThreadCopyDecision =
  | {
      /** Publish a full copy that holds at least `revision`. */
      readonly kind: 'publish'
      readonly threadId: string
      readonly reason: OwnedThreadCopyReason
      readonly revision: number
    }
  | {
      /** Write a checkpoint that covers the log up to at least `revision`. */
      readonly kind: 'compact'
      readonly threadId: string
      readonly reason: 'log_bytes'
      readonly revision: number
      /** Bytes appended since the last checkpoint when this was decided. */
      readonly appendedBytes: number
    }

export interface OwnedThreadCopyStep {
  /** What to carry out now, off the main thread. At quit they are in the order to start them. */
  readonly decisions: OwnedThreadCopyDecision[]
  /**
   * When to call `poll` next, or null when nothing is waiting on time. It is
   * never later than the next thing due. It can be earlier, because a save
   * moves a thread's idle time without moving this: the poll then decides
   * nothing and gives the exact time.
   */
  readonly nextAt: number | null
}

/** What is on disk for a thread when this app becomes its writer. */
export interface OwnedThreadLogState {
  /** Revision of the newest full copy. */
  readonly publishedRevision: number
  /** Head of the log the app continues; the published revision when nothing is unpublished. */
  readonly headRevision: number
  /** Bytes already in the log since its last checkpoint. */
  readonly logBytes: number
}

export interface OwnedThreadCopySnapshot {
  /** Decisions made, by reason. `log_bytes` counts compactions. */
  decided: Record<OwnedThreadCopyReason | 'log_bytes', number>
  /** Copies and checkpoints of followed threads reported done, and those reported failed. */
  published: number
  publishFailures: number
  checkpointed: number
  compactionFailures: number
  /** Threads whose log was still ahead when the quit budget ran out: the Host folds these. */
  leftAtQuit: string[]
  /** Threads followed right now, and threads with a run live on them. */
  threads: number
  runningThreads: number
}

interface OwnedThread {
  readonly id: string
  /** The newest saved revision, and the revision of the newest full copy. */
  head: number
  published: number
  lastAppendAt: number
  /** Since when the log has been ahead of the newest full copy without a break. */
  aheadSince: number | null
  /** The copy the caller was asked for and has not reported on. */
  asked: { revision: number } | null
  /**
   * After a failed publish, no copy is asked for on time alone before this.
   * Never cleared, only outlived.
   */
  retryAt: number | null
  /** The head when the log last refused a save; a copy that holds it is owed. */
  unlogged: number | null
  /** Bytes appended since the last checkpoint. */
  bytes: number
  /** The compaction the caller was asked for, and the bytes appended since it was. */
  compacting: { revision: number; bytesSince: number } | null
  /** The head a copy was asked for at quit, so listing the thread again does not count it again. */
  quitRevision: number | null
}

function requireId(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid ${what}`)
}

function requireRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid revision')
}

function requireBytes(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('Invalid byte count')
}

/** Whether the log refused a save that no full copy holds yet. */
function owesFallbackCopy(thread: OwnedThread): boolean {
  return thread.unlogged !== null && thread.unlogged > thread.published
}

export class OwnedThreadCopyPolicy {
  private readonly threads = new Map<string, OwnedThread>()
  /** Runs live on each thread, followed or not: a thread can change hands while one is. */
  private readonly runs = new Map<string, Set<string>>()
  private readonly decided: OwnedThreadCopySnapshot['decided'] = {
    creation: 0,
    idle: 0,
    stream_cap: 0,
    quit: 0,
    handoff: 0,
    journal_failure: 0,
    log_bytes: 0
  }
  private readonly reported = {
    published: 0,
    publishFailures: 0,
    checkpointed: 0,
    compactionFailures: 0
  }
  /** Set once the app is quitting: the time after which no new copy is worth starting. */
  private quitDeadline: number | null = null
  private leftAtQuit: string[] = []
  /** A time no later than the next thing due. Exact after a `poll`. */
  private wakeAt: number | null = null

  /** A new thread: its first full copy is published at once, as it is today. */
  created(threadId: string, revision: number, now: number): OwnedThreadCopyStep {
    requireId(threadId, 'thread id')
    requireRevision(revision)
    const thread = this.follow(threadId, revision - 1, revision, 0, now)
    return this.step([this.ask(thread, 'creation')], thread)
  }

  /**
   * The app became the writer of an existing thread. A log that is already
   * ahead is published once the thread is idle, like any other.
   */
  adopted(threadId: string, log: OwnedThreadLogState, now: number): OwnedThreadCopyStep {
    requireId(threadId, 'thread id')
    requireRevision(log.publishedRevision)
    requireRevision(log.headRevision)
    requireBytes(log.logBytes)
    if (log.headRevision < log.publishedRevision) throw new Error('Invalid revisions')
    const thread = this.follow(threadId, log.publishedRevision, log.headRevision, log.logBytes, now)
    return this.step(this.compaction(thread), thread)
  }

  /** A save was appended to the log. It can make a compaction due, never a copy. */
  saved(
    threadId: string,
    save: { revision: number; appendedBytes: number },
    now: number
  ): OwnedThreadCopyStep {
    requireId(threadId, 'thread id')
    requireRevision(save.revision)
    requireBytes(save.appendedBytes)
    const thread = this.threads.get(threadId) ?? this.followFromSave(threadId, save.revision, now)
    this.appended(thread, save.revision, now)
    thread.bytes += save.appendedBytes
    if (thread.compacting) thread.compacting.bytesSince += save.appendedBytes
    return this.step(this.compaction(thread), thread)
  }

  /** A run went live on a thread, whether or not this app is its writer yet. */
  runStarted(threadId: string, runId: string): OwnedThreadCopyStep {
    requireId(threadId, 'thread id')
    requireId(runId, 'run id')
    const runs = this.runs.get(threadId) ?? new Set<string>()
    runs.add(runId)
    this.runs.set(threadId, runs)
    return this.step([], this.threads.get(threadId))
  }

  /** The last run ending can make the idle copy due at once, if the thread has long been quiet. */
  runEnded(threadId: string, runId: string, now: number): OwnedThreadCopyStep {
    const runs = this.runs.get(threadId)
    if (runs?.delete(runId) && runs.size === 0) this.runs.delete(threadId)
    const thread = this.threads.get(threadId)
    return this.step(thread ? this.due(thread, now) : [], thread)
  }

  /** A full copy holding `revision` was published, whether or not the policy asked for it. */
  published(threadId: string, revision: number, now: number): OwnedThreadCopyStep {
    requireRevision(revision)
    const thread = this.threads.get(threadId)
    if (!thread) return this.step([])
    this.reported.published++
    if (thread.asked && thread.asked.revision <= revision) thread.asked = null
    if (revision > thread.published) {
      thread.published = revision
      // Saves that landed while the copy was written leave the log ahead of it, from now.
      thread.aheadSince = thread.head > revision ? now : null
    }
    return this.step(this.due(thread, now), thread)
  }

  /**
   * A copy that would have held `revision` could not be written. If a newer
   * copy has been asked for since, that one is still on its way and nothing
   * changes; otherwise the thread is left alone for the retry interval.
   */
  publishFailed(threadId: string, revision: number, now: number): OwnedThreadCopyStep {
    requireRevision(revision)
    const thread = this.threads.get(threadId)
    if (!thread) return this.step([])
    this.reported.publishFailures++
    if (thread.asked && thread.asked.revision <= revision) {
      thread.asked = null
      thread.retryAt = now + OWNED_THREAD_PUBLISH_RETRY_MS
    }
    return this.step([], thread)
  }

  /**
   * A checkpoint covering the log up to `revision` was written. One at the
   * head, written for any reason, leaves no bytes to count; one that answers
   * the compaction asked for leaves the bytes appended since it was asked.
   */
  checkpointed(threadId: string, revision: number): OwnedThreadCopyStep {
    requireRevision(revision)
    const thread = this.threads.get(threadId)
    if (!thread) return this.step([])
    this.reported.checkpointed++
    if (revision >= thread.head) {
      thread.bytes = 0
      thread.compacting = null
    } else if (thread.compacting && revision >= thread.compacting.revision) {
      thread.bytes = thread.compacting.bytesSince
      thread.compacting = null
    }
    return this.step(this.compaction(thread), thread)
  }

  /** The compaction could not be written. The next save asks again; no timer does. */
  compactionFailed(threadId: string): OwnedThreadCopyStep {
    const thread = this.threads.get(threadId)
    if (!thread) return this.step([])
    this.reported.compactionFailures++
    thread.compacting = null
    return this.step([], thread)
  }

  /**
   * The log could not take the save that produced `revision`, or the detail
   * that save refers to, so a full copy is the only record of it. Asked for
   * every time: a copy already being written was taken before this save. If
   * that copy fails it is asked for again after the retry interval, whatever
   * the thread is doing.
   */
  journalFailed(threadId: string, revision: number, now: number): OwnedThreadCopyStep {
    requireId(threadId, 'thread id')
    requireRevision(revision)
    const thread = this.threads.get(threadId) ?? this.followFromSave(threadId, revision, now)
    this.appended(thread, revision, now)
    thread.unlogged = thread.head
    return this.step([this.ask(thread, 'journal_failure')], thread)
  }

  /**
   * The Host asked for the thread. A copy is needed only if the log is ahead
   * and one that holds its head is not already being written. The caller
   * releases the thread once `isAhead` is false.
   */
  handoffRequested(threadId: string): OwnedThreadCopyStep {
    const thread = this.threads.get(threadId)
    if (!thread || thread.head <= thread.published || thread.asked?.revision === thread.head) {
      return this.step([], thread)
    }
    return this.step([this.ask(thread, 'handoff')], thread)
  }

  /**
   * The app is quitting and has `budgetMs` to publish in. Answers with every
   * thread whose log is ahead, most recently active first, leaving out those
   * whose copy is already being written. The caller writes them in that order
   * and calls `poll` before starting each next one: once the budget is spent
   * `poll` asks for nothing more, and what is still ahead is left for the Host
   * to fold after the app has gone.
   */
  quit(now: number, budgetMs: number): OwnedThreadCopyStep {
    if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error('Invalid quit budget')
    this.quitDeadline = now + budgetMs
    return this.poll(now)
  }

  /** The app no longer owns the thread: it was handed to the Host, or deleted. */
  released(threadId: string): void {
    this.threads.delete(threadId)
  }

  /** Everything that is due at `now`, and the exact time of the next thing due after it. */
  poll(now: number): OwnedThreadCopyStep {
    this.wakeAt = null
    if (this.quitDeadline !== null) return this.quitting(now, this.quitDeadline)
    const decisions: OwnedThreadCopyDecision[] = []
    for (const thread of this.threads.values()) {
      decisions.push(...this.due(thread, now))
      this.wakeBy(this.dueAt(thread))
    }
    return { decisions, nextAt: this.wakeAt }
  }

  /** Whether the thread's log holds anything its newest full copy does not. */
  isAhead(threadId: string): boolean {
    const thread = this.threads.get(threadId)
    return thread !== undefined && thread.head > thread.published
  }

  snapshot(): OwnedThreadCopySnapshot {
    return {
      decided: { ...this.decided },
      ...this.reported,
      leftAtQuit: [...this.leftAtQuit],
      threads: this.threads.size,
      runningThreads: this.runs.size
    }
  }

  private follow(
    threadId: string,
    published: number,
    head: number,
    bytes: number,
    now: number
  ): OwnedThread {
    const thread: OwnedThread = {
      id: threadId,
      head,
      published,
      lastAppendAt: now,
      aheadSince: head > published ? now : null,
      asked: null,
      retryAt: null,
      unlogged: null,
      bytes,
      compacting: null,
      quitRevision: null
    }
    this.threads.set(threadId, thread)
    return thread
  }

  /** A thread nobody announced is followed from its first save: its log leads by at least that. */
  private followFromSave(threadId: string, revision: number, now: number): OwnedThread {
    return this.follow(threadId, revision - 1, revision - 1, 0, now)
  }

  private appended(thread: OwnedThread, revision: number, now: number): void {
    thread.head = Math.max(thread.head, revision)
    thread.lastAppendAt = now
    if (thread.head > thread.published) thread.aheadSince ??= now
  }

  private ask(thread: OwnedThread, reason: OwnedThreadCopyReason): OwnedThreadCopyDecision {
    this.decided[reason]++
    thread.asked = { revision: thread.head }
    return { kind: 'publish', threadId: thread.id, reason, revision: thread.head }
  }

  /** When the thread's next copy falls due on time alone, or null while none can. */
  private dueAt(thread: OwnedThread): number | null {
    if (this.quitDeadline !== null || thread.aheadSince === null || thread.asked) return null
    const cap = thread.aheadSince + OWNED_THREAD_STREAM_CAP_MS
    const idle = thread.lastAppendAt + OWNED_THREAD_IDLE_PUBLISH_MS
    let due = this.runs.has(thread.id) ? cap : Math.min(idle, cap)
    // A save the log refused is owed its copy whatever the thread is doing.
    if (owesFallbackCopy(thread)) due = 0
    return Math.max(due, thread.retryAt ?? 0)
  }

  private due(thread: OwnedThread, now: number): OwnedThreadCopyDecision[] {
    const dueAt = this.dueAt(thread)
    if (dueAt === null || dueAt > now) return []
    if (owesFallbackCopy(thread)) return [this.ask(thread, 'journal_failure')]
    const idle =
      !this.runs.has(thread.id) && now - thread.lastAppendAt >= OWNED_THREAD_IDLE_PUBLISH_MS
    return [this.ask(thread, idle ? 'idle' : 'stream_cap')]
  }

  private compaction(thread: OwnedThread): OwnedThreadCopyDecision[] {
    if (thread.compacting || thread.bytes < OWNED_THREAD_COMPACT_BYTES) return []
    this.decided.log_bytes++
    thread.compacting = { revision: thread.head, bytesSince: 0 }
    return [
      {
        kind: 'compact',
        threadId: thread.id,
        reason: 'log_bytes',
        revision: thread.head,
        appendedBytes: thread.bytes
      }
    ]
  }

  private quitting(now: number, deadline: number): OwnedThreadCopyStep {
    const ahead = [...this.threads.values()]
      .filter((thread) => thread.head > thread.published)
      .sort((a, b) => b.lastAppendAt - a.lastAppendAt)
    if (now >= deadline) {
      this.leftAtQuit = ahead.map((thread) => thread.id)
      return { decisions: [], nextAt: null }
    }
    const decisions: OwnedThreadCopyDecision[] = []
    for (const thread of ahead) {
      if (thread.quitRevision === thread.head) {
        // Asked for at quit already and not written yet: listed again, counted once.
        thread.asked = { revision: thread.head }
        decisions.push({
          kind: 'publish',
          threadId: thread.id,
          reason: 'quit',
          revision: thread.head
        })
      } else if (thread.asked?.revision !== thread.head) {
        thread.quitRevision = thread.head
        decisions.push(this.ask(thread, 'quit'))
      }
      // Otherwise a copy that holds the head is already being written for another reason.
    }
    if (ahead.length > 0) this.wakeAt = deadline
    return { decisions, nextAt: this.wakeAt }
  }

  private wakeBy(time: number | null): void {
    if (time !== null && (this.wakeAt === null || time < this.wakeAt)) this.wakeAt = time
  }

  private step(decisions: OwnedThreadCopyDecision[], thread?: OwnedThread): OwnedThreadCopyStep {
    if (thread) this.wakeBy(this.dueAt(thread))
    return { decisions, nextAt: this.wakeAt }
  }
}
