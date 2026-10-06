/**
 * Where the Host serves a thread's history from, with the thread log
 * authority switch on.
 *
 * A thread whose authority file names a live writer is the desktop app's: its
 * log, which the app appends to, leads the Host's full copy. Its history is
 * served from the log, by a HostThreadLogHistory over a HostThreadLogFollower.
 * Every other thread is served from its full copy, as before: one with no
 * file; one whose file names a writer whose process has ended, until what it
 * left is folded into the full copy; and one whose file cannot be read, which
 * names no writer. The file is read for every request, so a thread moves
 * between the two as its file comes and goes. A log's generations are far
 * above any revision, so a client that moves with it loads again.
 *
 * A follower reads only when it is polled, and it is polled:
 * - once for each `advanced` its writer sends (a nudge); the nudges that come
 *   while it polls make one more poll after;
 * - once a second when nothing has polled it for half that;
 * - before each request is answered.
 * Each poll is bounded by the follower. After a poll that fails (a seed that
 * could not be loaded) nothing polls the thread until a wait that doubles with
 * each failure in a row, from one second up to thirty; the full copy answers
 * meanwhile.
 *
 * At most HOST_THREAD_LOG_MAX_THREADS threads are followed, and the one least
 * recently asked for is let go first: a nudge is the app writing, not anyone
 * reading. A follower is let go too when its thread's file goes or names a
 * writer that has ended, when its grant is released, and when the thread has
 * no log. The once-a-second timer also reads the followed threads' files, so a
 * follower nobody asks for is let go within a second of its file.
 *
 * The tail and `history.since` are answered from the full copy when the log
 * cannot answer them: no log, a seed that fails or is refused, or an answer
 * slower than a request may wait. An older page never is: its cursor is the
 * log's, which the full copy cannot read.
 */
import {
  ThreadAuthorityFiles,
  threadWriterLiveness,
  type ThreadAuthorityWriter,
  type ThreadWriterLiveness
} from '../host-shared/thread-log/ThreadAuthorityFile'
import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest
} from '../shared/hostHistoryProtocol'
import {
  HOST_THREAD_LOG_MAX_THREADS,
  HOST_THREAD_LOG_SEED_REASONS,
  isFollowableThreadId,
  type HostThreadLogFollowerMemory,
  type HostThreadLogFollowerStats,
  type HostThreadLogSeedPort,
  type HostThreadLogSeedReason
} from './HostThreadLogFollower'
import {
  HostThreadLogHistory,
  type HostThreadLogHistoryFreshness,
  type HostThreadLogHistoryMemory,
  type HostThreadLogHistoryOptions,
  type HostThreadLogHistorySeedCause,
  type HostThreadLogHistoryStats
} from './HostThreadLogHistory'
import { threadLogDirectory } from './HostThreadOwnerService'

/** A followed thread no nudge polls is polled this often. */
export const HOST_THREAD_HISTORY_POLL_INTERVAL_MS = 1000
/** The longest wait after polls that failed in a row. */
export const HOST_THREAD_HISTORY_MAX_RETRY_MS = 30_000
/**
 * How long a request waits for the log, a seed included, before the full
 * copy answers it. A seed decodes the whole record in the catalogue's worker,
 * about a second for the largest threads measured.
 */
export const HOST_THREAD_HISTORY_REQUEST_WAIT_MS = 5000

const SEED_CAUSES: readonly HostThreadLogHistorySeedCause[] = [
  'older-row',
  'unresolved-run',
  'record-mismatch'
]

/** The Host's full copies, which answer every thread the log does not. */
export interface HostThreadHistoryFullCopy {
  threadHistory(
    request: HostThreadHistoryRequest
  ): HostThreadHistoryPage | Promise<HostThreadHistoryPage>
  historySince(
    request: HostHistorySinceRequest
  ): HostHistorySinceResult | Promise<HostHistorySinceResult>
}

export interface HostThreadHistoryRouterTimers {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** Why a request was answered from the full copy rather than a log. */
export type HostThreadHistoryFullCopyReason =
  | 'no-file'
  | 'damaged'
  | 'writer-ended'
  /** An id the journal names no files for. */
  | 'not-a-log'
  /** An erasure fence holds the thread: the full copy answers until it lifts. */
  | 'erased'
  | 'closed'

/** Why a request for a thread the log serves was answered from the full copy instead. */
export type HostThreadHistoryFallbackReason =
  | 'absent'
  | 'unfollowable'
  | 'failed'
  /** Waiting after polls that failed. */
  | 'backoff'
  | 'slow'
  /** The follower was polled, and the history could not answer. */
  | 'history'
  /** The follower was let go while the request waited. */
  | 'let-go'

/** Why a follower was let go. */
export type HostThreadHistoryDropReason =
  | 'no-file'
  | 'damaged'
  | 'writer-ended'
  | 'released'
  | 'evicted'
  | 'absent'
  | 'erased'
  | 'closed'

/** What the follower's last poll said; `new` before the first. */
export type HostThreadHistoryFollowStatus =
  | 'new'
  | 'following'
  | 'absent'
  | 'unfollowable'
  | 'failed'

export interface HostThreadHistoryRouterOptions {
  readonly profilePath: string
  readonly fullCopy: HostThreadHistoryFullCopy
  /** Loads a whole record off the Host loop, for a follower's seed. */
  readonly seedPort: HostThreadLogSeedPort
  /** Defaults to the profile's authority files. */
  readonly files?: Pick<ThreadAuthorityFiles, 'read'>
  /** Defaults to signal 0 to the writer's process id. */
  liveness?(writer: ThreadAuthorityWriter): ThreadWriterLiveness
  /** Defaults to HOST_THREAD_LOG_MAX_THREADS. */
  readonly maxThreads?: number
  /** Defaults to HOST_THREAD_HISTORY_POLL_INTERVAL_MS. */
  readonly pollIntervalMs?: number
  /** Defaults to HOST_THREAD_HISTORY_MAX_RETRY_MS. */
  readonly maxRetryMs?: number
  /** Defaults to HOST_THREAD_HISTORY_REQUEST_WAIT_MS. */
  readonly requestWaitMs?: number
  /** For each thread's history and follower; their own defaults otherwise. */
  readonly history?: Omit<HostThreadLogHistoryOptions, 'chatId' | 'directory' | 'seedPort'>
  readonly now?: () => number
  readonly timers?: HostThreadHistoryRouterTimers
}

export interface HostThreadHistoryRouterThreadSnapshot {
  readonly threadId: string
  readonly status: HostThreadHistoryFollowStatus
  readonly unfollowable: 'seed-behind-checkpoint' | 'over-budget' | null
  readonly polling: boolean
  /** Polls that failed in a row. */
  readonly failures: number
  /** How long until the thread is polled again after them; zero when it is not waiting. */
  readonly retryInMs: number
  readonly freshness: HostThreadLogHistoryFreshness
  readonly follower: HostThreadLogFollowerStats
  readonly history: HostThreadLogHistoryStats
  readonly memory: {
    readonly follower: HostThreadLogFollowerMemory
    readonly history: HostThreadLogHistoryMemory
  }
}

export interface HostThreadHistoryRouterSnapshot {
  readonly followed: number
  readonly maxThreads: number
  readonly pollIntervalMs: number
  /** Requests answered, by where from. */
  readonly served: {
    readonly log: number
    readonly fullCopy: Readonly<Record<HostThreadHistoryFullCopyReason, number>>
  }
  readonly fallbacks: Readonly<Record<HostThreadHistoryFallbackReason, number>>
  readonly nudges: { readonly followed: number; readonly ignored: number }
  readonly polls: {
    readonly request: number
    readonly nudge: number
    readonly timer: number
    readonly failed: number
  }
  readonly dropped: Readonly<Record<HostThreadHistoryDropReason, number>>
  /** Views built from a seed, by reason, by every follower made: those let go too. */
  readonly seeds: Readonly<Record<HostThreadLogSeedReason, number>>
  readonly seedsRefused: number
  /** Seeds a history asked its follower for, by cause, by every follower made. */
  readonly seedsAsked: Readonly<Record<HostThreadLogHistorySeedCause, number>>
  /** The followed threads, by id. */
  readonly threads: readonly HostThreadHistoryRouterThreadSnapshot[]
}

type Route = 'log' | HostThreadHistoryFullCopyReason
type PollOutcome = 'following' | 'absent' | 'unfollowable' | 'failed' | 'let-go'
type PollCause = 'request' | 'nudge' | 'timer'

interface Followed {
  readonly threadId: string
  readonly history: HostThreadLogHistory
  status: HostThreadHistoryFollowStatus
  unfollowable: 'seed-behind-checkpoint' | 'over-budget' | null
  polling: Promise<PollOutcome> | null
  /** A nudge came while it polled. */
  again: boolean
  lastPolledAt: number
  failures: number
  retryAt: number
}

function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>
}

function wholeNumber(value: number | undefined, fallback: number, least: number, name: string) {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < least) {
    throw new RangeError(
      `Thread history router: ${name} must be a whole number of at least ${least}`
    )
  }
  return chosen
}

export class HostThreadHistoryRouter {
  private readonly directory: string
  private readonly fullCopy: HostThreadHistoryFullCopy
  private readonly seedPort: HostThreadLogSeedPort
  private readonly files: Pick<ThreadAuthorityFiles, 'read'>
  private readonly liveness: (writer: ThreadAuthorityWriter) => ThreadWriterLiveness
  private readonly maxThreads: number
  private readonly pollIntervalMs: number
  private readonly maxRetryMs: number
  private readonly requestWaitMs: number
  private readonly historyOptions: HostThreadHistoryRouterOptions['history']
  private readonly now: () => number
  private readonly timers: HostThreadHistoryRouterTimers

  /** The least recently asked for first. */
  private readonly followed = new Map<string, Followed>()
  /** Threads an erasure fence holds: followed again only when it lifts. */
  private readonly erasureFenced = new Set<string>()
  /** A fence without a thread id covers every thread. */
  private globalErasureFence = false
  private timer: unknown = null
  private checkingFiles = false
  private closed = false

  private servedFromLog = 0
  private readonly servedFromFullCopy = zeros<HostThreadHistoryFullCopyReason>([
    'no-file',
    'damaged',
    'writer-ended',
    'not-a-log',
    'erased',
    'closed'
  ])
  private readonly fallbacks = zeros<HostThreadHistoryFallbackReason>([
    'absent',
    'unfollowable',
    'failed',
    'backoff',
    'slow',
    'history',
    'let-go'
  ])
  private readonly dropped = zeros<HostThreadHistoryDropReason>([
    'no-file',
    'damaged',
    'writer-ended',
    'released',
    'evicted',
    'absent',
    'erased',
    'closed'
  ])
  private nudgesFollowed = 0
  private nudgesIgnored = 0
  private readonly polls = { request: 0, nudge: 0, timer: 0, failed: 0 }
  /** What the followers let go had counted. */
  private readonly retiredSeeds = zeros<HostThreadLogSeedReason>(HOST_THREAD_LOG_SEED_REASONS)
  private retiredSeedsRefused = 0
  private readonly retiredSeedsAsked = zeros<HostThreadLogHistorySeedCause>(SEED_CAUSES)

  constructor(options: HostThreadHistoryRouterOptions) {
    this.directory = threadLogDirectory(options.profilePath)
    this.fullCopy = options.fullCopy
    this.seedPort = options.seedPort
    this.files = options.files ?? new ThreadAuthorityFiles(options.profilePath)
    this.liveness = options.liveness
      ? (writer) => options.liveness!(writer)
      : (writer) => threadWriterLiveness(writer)
    this.maxThreads = wholeNumber(options.maxThreads, HOST_THREAD_LOG_MAX_THREADS, 1, 'maxThreads')
    this.pollIntervalMs = wholeNumber(
      options.pollIntervalMs,
      HOST_THREAD_HISTORY_POLL_INTERVAL_MS,
      1,
      'pollIntervalMs'
    )
    this.maxRetryMs = wholeNumber(
      options.maxRetryMs,
      HOST_THREAD_HISTORY_MAX_RETRY_MS,
      1,
      'maxRetryMs'
    )
    this.requestWaitMs = wholeNumber(
      options.requestWaitMs,
      HOST_THREAD_HISTORY_REQUEST_WAIT_MS,
      0,
      'requestWaitMs'
    )
    this.historyOptions = options.history
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
    }
  }

  async threadHistory(request: HostThreadHistoryRequest): Promise<HostThreadHistoryPage> {
    const route = await this.route(request.threadId)
    const fromFullCopy = () => this.fullCopy.threadHistory(request)
    if (route !== 'log') return this.fromFullCopy(request.threadId, route, fromFullCopy)
    return this.fromLog(
      request.threadId,
      request.before ? 'older' : 'current',
      (history) => history.threadHistory(request),
      fromFullCopy
    )
  }

  async historySince(request: HostHistorySinceRequest): Promise<HostHistorySinceResult> {
    const route = await this.route(request.threadId)
    const fromFullCopy = () => this.fullCopy.historySince(request)
    if (route !== 'log') return this.fromFullCopy(request.threadId, route, fromFullCopy)
    return this.fromLog(
      request.threadId,
      'current',
      (history) => history.historySince(request),
      fromFullCopy
    )
  }

  /** The thread's writer says its log has grown: poll it, if it is followed. */
  nudge(threadId: string): void {
    const followed = this.followed.get(threadId)
    if (!followed) {
      this.nudgesIgnored += 1
      return
    }
    this.nudgesFollowed += 1
    if (followed.polling) {
      followed.again = true
      return
    }
    if (this.waiting(followed)) return
    void this.poll(followed, 'nudge')
  }

  /** The thread's grant was released: its writer has removed the thread's file. */
  released(threadId: string): void {
    this.letGo(threadId, 'released')
  }

  /**
   * An erasure is about to purge the thread (or everything): synchronously
   * let its follower go, fence it so neither a request nor a nudge seeds or
   * follows it again until the fence lifts, and await any poll already in
   * flight so the purge does not run underneath one.
   */
  async erasing(threadId?: string): Promise<void> {
    const targets =
      threadId === undefined
        ? [...this.followed.values()]
        : [this.followed.get(threadId)].filter(
            (followed): followed is Followed => followed !== undefined
          )
    if (threadId === undefined) this.globalErasureFence = true
    else this.erasureFenced.add(threadId)
    for (const followed of targets) this.letGo(followed.threadId, 'erased')
    await Promise.allSettled(
      targets
        .map((followed) => followed.polling)
        .filter((polling): polling is Promise<PollOutcome> => polling !== null)
    )
  }

  /**
   * The erasure finished: the thread (or everything, when no thread id is
   * given) may be followed and seeded again.
   */
  forgetErased(threadId?: string): void {
    if (threadId === undefined) {
      this.globalErasureFence = false
      this.erasureFenced.clear()
    } else {
      this.erasureFenced.delete(threadId)
    }
  }

  snapshot(): HostThreadHistoryRouterSnapshot {
    const now = this.now()
    const seeds = { ...this.retiredSeeds }
    let seedsRefused = this.retiredSeedsRefused
    const seedsAsked = { ...this.retiredSeedsAsked }
    const threads = [...this.followed.values()]
      .sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0))
      .map((followed): HostThreadHistoryRouterThreadSnapshot => {
        const follower = followed.history.follower.stats()
        const history = followed.history.stats()
        for (const reason of HOST_THREAD_LOG_SEED_REASONS) seeds[reason] += follower.seeds[reason]
        seedsRefused += follower.seedsRefused
        for (const cause of SEED_CAUSES) seedsAsked[cause] += history.seedsAsked[cause]
        return {
          threadId: followed.threadId,
          status: followed.status,
          unfollowable: followed.unfollowable,
          polling: followed.polling !== null,
          failures: followed.failures,
          retryInMs: Math.max(0, followed.retryAt - now),
          freshness: followed.history.freshness(),
          follower,
          history,
          memory: {
            follower: followed.history.follower.memory(),
            history: followed.history.memory()
          }
        }
      })
    return {
      followed: this.followed.size,
      maxThreads: this.maxThreads,
      pollIntervalMs: this.pollIntervalMs,
      served: { log: this.servedFromLog, fullCopy: { ...this.servedFromFullCopy } },
      fallbacks: { ...this.fallbacks },
      nudges: { followed: this.nudgesFollowed, ignored: this.nudgesIgnored },
      polls: { ...this.polls },
      dropped: { ...this.dropped },
      seeds,
      seedsRefused,
      seedsAsked,
      threads
    }
  }

  /** Lets every follower go and stops the timer. Later requests are the full copy's. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const threadId of [...this.followed.keys()]) this.letGo(threadId, 'closed')
    this.stopTimer()
  }

  // ---------------------------------------------------------------------------

  private async route(threadId: string): Promise<Route> {
    if (this.closed) return 'closed'
    if (this.fenced(threadId)) return 'erased'
    if (!isFollowableThreadId(threadId)) return 'not-a-log'
    let read: Awaited<ReturnType<ThreadAuthorityFiles['read']>>
    try {
      read = await this.files.read(threadId)
    } catch {
      read = { kind: 'damaged', reason: 'unreadable' }
    }
    if (this.closed) return 'closed'
    if (read.kind === 'none') return 'no-file'
    if (read.kind === 'damaged') return 'damaged'
    return this.liveness(read.record.writer) === 'dead' ? 'writer-ended' : 'log'
  }

  private fenced(threadId: string): boolean {
    return this.globalErasureFence || this.erasureFenced.has(threadId)
  }

  private fromFullCopy<T>(
    threadId: string,
    reason: HostThreadHistoryFullCopyReason,
    answer: () => T | Promise<T>
  ): T | Promise<T> {
    this.servedFromFullCopy[reason] += 1
    if (reason === 'no-file' || reason === 'damaged' || reason === 'writer-ended') {
      this.letGo(threadId, reason)
    }
    return answer()
  }

  private async fromLog<T>(
    threadId: string,
    kind: 'current' | 'older',
    fromLog: (history: HostThreadLogHistory) => Promise<T>,
    fromFullCopy: () => T | Promise<T>
  ): Promise<T> {
    const fallBack = (reason: HostThreadHistoryFallbackReason): T | Promise<T> => {
      if (kind === 'older') {
        throw new Error(`Thread history is not available from the log: ${reason}`)
      }
      this.fallbacks[reason] += 1
      return fromFullCopy()
    }
    const followed = this.follow(threadId)
    // The route read the file before the fence landed; never seed or follow
    // a fenced thread from here either.
    if (this.fenced(threadId)) {
      this.letGo(threadId, 'erased')
      return fallBack('let-go')
    }
    if (this.waiting(followed)) return fallBack('backoff')
    const answer = (async (): Promise<
      { readonly value: T } | { readonly fallback: HostThreadHistoryFallbackReason }
    > => {
      const outcome = await this.poll(followed, 'request')
      if (outcome === 'absent') {
        this.letGo(threadId, 'absent')
        return { fallback: 'absent' }
      }
      if (outcome !== 'following') return { fallback: outcome }
      try {
        return { value: await fromLog(followed.history) }
      } catch (error) {
        if (kind === 'older') throw error
        return { fallback: 'history' }
      }
    })()
    const settled = await this.withinWait(answer)
    if (settled === 'slow') return fallBack('slow')
    if ('fallback' in settled) return fallBack(settled.fallback)
    this.servedFromLog += 1
    return settled.value
  }

  /** The answer, or `slow` once a request has waited as long as it may. */
  private withinWait<T>(answer: Promise<T>): Promise<T | 'slow'> {
    // An answer given up on still settles, and must not be reported as unhandled.
    answer.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), this.requestWaitMs)
      timer.unref?.()
    })
    return Promise.race([answer, slow]).finally(() => clearTimeout(timer))
  }

  /** The thread's follower, made if need be, and now the most recently asked for. */
  private follow(threadId: string): Followed {
    const known = this.followed.get(threadId)
    if (known) {
      this.followed.delete(threadId)
      this.followed.set(threadId, known)
      return known
    }
    while (this.followed.size >= this.maxThreads) {
      this.letGo(this.followed.keys().next().value!, 'evicted')
    }
    const followed: Followed = {
      threadId,
      history: new HostThreadLogHistory({
        now: this.now,
        ...this.historyOptions,
        chatId: threadId,
        directory: this.directory,
        seedPort: this.seedPort
      }),
      status: 'new',
      unfollowable: null,
      polling: null,
      again: false,
      lastPolledAt: Number.NEGATIVE_INFINITY,
      failures: 0,
      retryAt: 0
    }
    this.followed.set(threadId, followed)
    this.startTimer()
    return followed
  }

  private letGo(threadId: string, reason: HostThreadHistoryDropReason): void {
    const followed = this.followed.get(threadId)
    if (!followed) return
    this.followed.delete(threadId)
    this.dropped[reason] += 1
    const follower = followed.history.follower.stats()
    const history = followed.history.stats()
    for (const each of HOST_THREAD_LOG_SEED_REASONS) this.retiredSeeds[each] += follower.seeds[each]
    this.retiredSeedsRefused += follower.seedsRefused
    for (const cause of SEED_CAUSES) this.retiredSeedsAsked[cause] += history.seedsAsked[cause]
    followed.history.close()
    if (this.followed.size === 0) this.stopTimer()
  }

  private waiting(followed: Followed): boolean {
    return this.now() < followed.retryAt
  }

  /** One bounded poll, shared with any already running. */
  private poll(followed: Followed, cause: PollCause): Promise<PollOutcome> {
    if (followed.polling) return followed.polling
    this.polls[cause] += 1
    followed.lastPolledAt = this.now()
    const polling = this.pollOnce(followed)
    followed.polling = polling
    void polling.then(() => {
      followed.polling = null
      if (!followed.again) return
      followed.again = false
      if (this.followed.get(followed.threadId) === followed && !this.waiting(followed)) {
        void this.poll(followed, 'nudge')
      }
    })
    return polling
  }

  private async pollOnce(followed: Followed): Promise<PollOutcome> {
    try {
      const result = await followed.history.follower.poll()
      if (this.followed.get(followed.threadId) !== followed) return 'let-go'
      followed.failures = 0
      followed.retryAt = 0
      followed.status = result.status
      followed.unfollowable = result.status === 'unfollowable' ? result.why : null
      return result.status
    } catch {
      if (this.followed.get(followed.threadId) !== followed) return 'let-go'
      this.polls.failed += 1
      followed.failures += 1
      followed.status = 'failed'
      followed.retryAt =
        this.now() +
        Math.min(this.pollIntervalMs * 2 ** Math.min(followed.failures - 1, 30), this.maxRetryMs)
      return 'failed'
    }
  }

  private startTimer(): void {
    if (this.timer !== null || this.closed) return
    const handle = this.timers.setInterval(() => this.tick(), this.pollIntervalMs)
    ;(handle as { unref?: () => void } | null)?.unref?.()
    this.timer = handle
  }

  private stopTimer(): void {
    if (this.timer === null) return
    this.timers.clearInterval(this.timer)
    this.timer = null
  }

  private tick(): void {
    const now = this.now()
    for (const followed of this.followed.values()) {
      if (followed.polling || now < followed.retryAt) continue
      if (now - followed.lastPolledAt >= this.pollIntervalMs / 2) void this.poll(followed, 'timer')
    }
    if (this.checkingFiles || this.followed.size === 0) return
    this.checkingFiles = true
    void this.checkFiles().finally(() => {
      this.checkingFiles = false
    })
  }

  /** Lets go of each followed thread whose file has gone or names a writer that has ended. */
  private async checkFiles(): Promise<void> {
    for (const [threadId, followed] of [...this.followed]) {
      const route = await this.route(threadId)
      if (this.followed.get(threadId) !== followed) continue
      if (route === 'no-file' || route === 'damaged' || route === 'writer-ended') {
        this.letGo(threadId, route)
      }
    }
  }
}
