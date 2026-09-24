import {
  MAX_CHAT_UPDATE_INTEREST_ENTRIES,
  normalizeChatUpdateInvalidation,
  type ChatUpdateInvalidation
} from '../../../shared/chatUpdateInterest'
import type { TranscriptPage, TranscriptPageRequest } from '../../../shared/transcriptPage'

export const MAX_LIVE_TAIL_PAGE_MESSAGES = 500
export const MAX_LIVE_TAIL_PAGE_BYTES = 8 * 1024 * 1024
export const DEFAULT_PAGED_CHAT_UPDATE_DEBOUNCE_MS = 50

/**
 * How long one tail pull may hold this chat's single flight slot.
 *
 * Not a cancellation — an `ipcRenderer.invoke` in flight cannot be recalled,
 * and a late page is still a correct page. It releases the SLOT. Before this,
 * `await this.fetchPage(...)` had no deadline at all, so a pull that never
 * settled (a wedged main thread, a lost channel) swallowed every subsequent
 * invalidation for that chat silently and permanently: the transcript simply
 * stopped, with nothing anywhere reporting why.
 */
export const DEFAULT_PAGED_CHAT_UPDATE_FETCH_DEADLINE_MS = 10_000

/**
 * Upper bound on waiting for one pull. The 10-second deadline independently
 * releases its flight slot; this 12-second bound finishes the waiter even if
 * the underlying IPC never answers. IPC is not cancelled, and its original
 * promise may still publish a valid late page through the ordering and window
 * guards. Retries remain independently bounded.
 */
export const DEFAULT_PAGED_CHAT_UPDATE_FETCH_SETTLE_TIMEOUT_MS = 12_000

/**
 * How long to wait before retrying a pull that failed with nothing newer
 * waiting. Bounded and delayed: retrying immediately would pile fetches onto
 * the very stall we are recovering from, and an unbounded retry would loop
 * forever against a permanently down Host. This exists because the refresh
 * can no longer rely on duplicate invalidations to re-arm it — the catalogue
 * mirror now drops same-content re-broadcasts — so a failed pull with no
 * newer generation must own its own recovery or the panel stays stale until
 * an unrelated save.
 */
export const DEFAULT_PAGED_CHAT_UPDATE_RETRY_DELAY_MS = 5_000
export const MAX_PAGED_CHAT_UPDATE_RETRY_ATTEMPTS = 2

export type PagedChatUpdateTailFetcher = (
  request: TranscriptPageRequest
) => Promise<TranscriptPage | null>

export interface PagedChatUpdateRefreshCommit {
  invalidation: ChatUpdateInvalidation
  page: TranscriptPage
  generation: number
}

export interface PagedChatUpdateRefreshCoordinatorOptions {
  fetchPage: PagedChatUpdateTailFetcher
  /** Publish synchronously; return false when the visible window rejected the page. */
  commit: (value: PagedChatUpdateRefreshCommit) => boolean | void
  debounceMs?: number
  /** Releases the per-chat flight slot when a pull overruns. 0 disables. */
  fetchDeadlineMs?: number
  /** Bound on waiting for one pull; the original fetch may finish later. 0 disables. */
  fetchSettleTimeoutMs?: number
  maxMessages?: number
  maxBytes?: number
  maxTrackedChats?: number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export interface PagedChatUpdateRefreshStats {
  trackedChats: number
  inFlight: number
  scheduled: number
  /** Pulls that overran the deadline and released their slot. */
  overdueFetches: number
  /** Chats whose newest invalidation is still unanswered by a commit. */
  behind: number
}

interface RefreshState {
  chatId: string
  latest: ChatUpdateInvalidation
  generation: number
  inFlight: boolean
  timer?: ReturnType<typeof setTimeout>
  retryTimer: boolean
  deadlineTimer?: ReturnType<typeof setTimeout>
  /** Fetch attempt that owns the slot; retries can share an invalidation generation. */
  deadlineOwner: number | null
  cancelled: boolean
  lastTouched: number
  /** Newest generation a commit has published. Lags `generation` while behind. */
  committedGeneration: number
  committedAttempt: number
  /** Bounded retries scheduled since the newest invalidation arrived. */
  retryCount: number
}

function boundedPositiveInteger(value: number | undefined, fallback: number, cap: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(cap, Math.max(1, Math.floor(value)))
}

function boundedDebounce(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PAGED_CHAT_UPDATE_DEBOUNCE_MS
  }
  return Math.min(5_000, Math.max(0, Math.floor(value)))
}

/**
 * Converts compact paged-chat invalidations into bounded tail pulls.
 *
 * There is one active refresh slot per chat. Invalidations replace each other while
 * waiting or in flight. The first invalidation starts a fixed coalescing
 * window, so a continuous stream cannot postpone the fetch forever. Completed
 * pages publish ordered progress even when a newer invalidation is waiting;
 * one immediate follow-up then reconciles it. Waiting for a completely quiet
 * fetch interval starves large transcripts whose reads span several updates.
 */
export class PagedChatUpdateRefreshCoordinator {
  private readonly states = new Map<string, RefreshState>()
  private readonly fetchPage: PagedChatUpdateTailFetcher
  private readonly commit: PagedChatUpdateRefreshCoordinatorOptions['commit']
  private readonly debounceMs: number
  private readonly fetchDeadlineMs: number
  private readonly fetchSettleTimeoutMs: number
  private readonly retryDelayMs: number
  private readonly maxRetryAttempts: number
  private readonly maxMessages: number
  private readonly maxBytes: number
  private readonly maxTrackedChats: number
  private readonly setTimer: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private disposed = false
  private overdueFetches = 0
  private touchSequence = 0
  private fetchSequence = 0

  constructor(options: PagedChatUpdateRefreshCoordinatorOptions) {
    this.fetchPage = options.fetchPage
    this.commit = options.commit
    this.debounceMs = boundedDebounce(options.debounceMs)
    this.fetchDeadlineMs =
      typeof options.fetchDeadlineMs === 'number' && Number.isFinite(options.fetchDeadlineMs)
        ? Math.max(0, Math.floor(options.fetchDeadlineMs))
        : DEFAULT_PAGED_CHAT_UPDATE_FETCH_DEADLINE_MS
    this.fetchSettleTimeoutMs =
      typeof options.fetchSettleTimeoutMs === 'number' &&
      Number.isFinite(options.fetchSettleTimeoutMs)
        ? Math.max(0, Math.floor(options.fetchSettleTimeoutMs))
        : DEFAULT_PAGED_CHAT_UPDATE_FETCH_SETTLE_TIMEOUT_MS
    this.retryDelayMs = DEFAULT_PAGED_CHAT_UPDATE_RETRY_DELAY_MS
    this.maxRetryAttempts = MAX_PAGED_CHAT_UPDATE_RETRY_ATTEMPTS
    this.maxMessages = boundedPositiveInteger(
      options.maxMessages,
      MAX_LIVE_TAIL_PAGE_MESSAGES,
      MAX_LIVE_TAIL_PAGE_MESSAGES
    )
    this.maxBytes = boundedPositiveInteger(
      options.maxBytes,
      MAX_LIVE_TAIL_PAGE_BYTES,
      MAX_LIVE_TAIL_PAGE_BYTES
    )
    this.maxTrackedChats = boundedPositiveInteger(
      options.maxTrackedChats,
      MAX_CHAT_UPDATE_INTEREST_ENTRIES,
      MAX_CHAT_UPDATE_INTEREST_ENTRIES
    )
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /** Queue a replacement invalidation. Returns its local generation, or null if rejected. */
  invalidate(value: unknown): number | null {
    if (this.disposed) return null
    const invalidation = normalizeChatUpdateInvalidation(value)
    if (!invalidation) return null

    let state = this.states.get(invalidation.chatId)
    if (!state) {
      if (!this.makeRoomFor(invalidation.chatId)) return null
      state = {
        chatId: invalidation.chatId,
        latest: invalidation,
        generation: 0,
        inFlight: false,
        retryTimer: false,
        cancelled: false,
        lastTouched: 0,
        committedGeneration: 0,
        committedAttempt: 0,
        deadlineOwner: null,
        retryCount: 0
      }
      this.states.set(invalidation.chatId, state)
    }

    state.latest = invalidation
    state.generation += 1
    state.retryCount = 0
    state.lastTouched = ++this.touchSequence
    if (!state.inFlight) this.arm(state)
    return state.generation
  }

  cancel(chatId: string): boolean {
    const state = this.states.get(chatId)
    if (!state) return false
    this.cancelState(state)
    this.states.delete(chatId)
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const state of this.states.values()) this.cancelState(state)
    this.states.clear()
  }

  stats(): PagedChatUpdateRefreshStats {
    let inFlight = 0
    let scheduled = 0
    for (const state of this.states.values()) {
      if (state.inFlight) inFlight += 1
      if (state.timer) scheduled += 1
    }
    let behind = 0
    for (const state of this.states.values()) {
      if (state.committedGeneration < state.generation) behind += 1
    }
    return {
      trackedChats: this.states.size,
      inFlight,
      scheduled,
      overdueFetches: this.overdueFetches,
      behind
    }
  }

  private makeRoomFor(chatId: string): boolean {
    if (this.states.has(chatId) || this.states.size < this.maxTrackedChats) return true

    let oldestIdle: RefreshState | undefined
    for (const state of this.states.values()) {
      if (state.inFlight) continue
      if (!oldestIdle || state.lastTouched < oldestIdle.lastTouched) oldestIdle = state
    }
    // Do not accumulate detached promises by evicting an in-flight state. A
    // new id can retry after one of the bounded active slots settles.
    if (!oldestIdle) return false
    this.cancelState(oldestIdle)
    this.states.delete(oldestIdle.chatId)
    return true
  }

  private cancelState(state: RefreshState): void {
    state.cancelled = true
    if (state.timer) {
      this.clearTimer(state.timer)
      state.timer = undefined
    }
    if (state.deadlineTimer) {
      this.clearTimer(state.deadlineTimer)
      state.deadlineTimer = undefined
    }
    state.deadlineOwner = null
  }

  private isLive(state: RefreshState): boolean {
    return !this.disposed && !state.cancelled && this.states.get(state.chatId) === state
  }

  private arm(state: RefreshState): void {
    // Keep the first update's deadline. A trailing debounce can be reset
    // forever by a busy run, without ever starting a read.
    if (state.timer && !state.retryTimer) return
    this.armWithDelay(state, this.debounceMs)
  }

  /**
   * Bounded, delayed retry for a pull that failed while nothing newer was
   * waiting. Counted per generation: two misses mean the surface waits for
   * the next invalidation rather than polling a down Host forever.
   */
  private armRetry(state: RefreshState): void {
    if (!this.isLive(state) || state.inFlight) return
    if (state.retryCount >= this.maxRetryAttempts) return
    state.retryCount += 1
    this.armWithDelay(state, this.retryDelayMs, true)
  }

  private armWithDelay(state: RefreshState, delayMs: number, retry = false): void {
    if (!this.isLive(state) || state.inFlight) return
    if (state.timer) this.clearTimer(state.timer)
    state.retryTimer = retry
    state.timer = this.setTimer(() => {
      state.timer = undefined
      state.retryTimer = false
      this.startFetch(state, false)
    }, delayMs)
  }

  private startFetch(state: RefreshState, isImmediateRetry: boolean): void {
    if (!this.isLive(state) || state.inFlight) return
    const generation = state.generation
    const attempt = ++this.fetchSequence
    const invalidation = state.latest
    state.inFlight = true
    state.deadlineOwner = attempt
    // Release the slot if this pull overruns. The fetch keeps running and its
    // page is still accepted if it lands — a late page is correct, it is the
    // WEDGED SLOT that costs the user their transcript.
    if (this.fetchDeadlineMs > 0) {
      state.deadlineTimer = this.setTimer(() => {
        state.deadlineTimer = undefined
        if (!this.isLive(state) || !state.inFlight) return
        if (state.deadlineOwner !== attempt) return
        state.deadlineOwner = null
        state.inFlight = false
        this.overdueFetches += 1
        // Re-arm when something newer is actually waiting. Otherwise schedule
        // our own bounded retry: with same-content mirror re-broadcasts gone,
        // nothing else is coming to re-arm this chat, and "wait forever"
        // converts one wedge into a permanently stale panel.
        if (state.generation > generation) this.arm(state)
        else this.armRetry(state)
      }, this.fetchDeadlineMs)
    }

    void this.runFetch(state, invalidation, generation, attempt, isImmediateRetry)
  }

  /**
   * Finish waiting independently of the transport's timeout. The bounded
   * waiter releases its bookkeeping; the original fetch retains its guarded
   * completion handler and cannot release a newer attempt's flight slot.
   */
  private withFetchSettleTimeout<T>(fetch: Promise<T>): Promise<T> {
    if (this.fetchSettleTimeoutMs <= 0) return fetch
    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimer(() => {
        reject(new Error('Paged chat refresh fetch did not settle.'))
      }, this.fetchSettleTimeoutMs)
      fetch.then(
        (value) => {
          this.clearTimer(timer)
          resolve(value)
        },
        (error) => {
          this.clearTimer(timer)
          reject(error)
        }
      )
    })
  }

  private acceptPage(
    state: RefreshState,
    invalidation: ChatUpdateInvalidation,
    generation: number,
    attempt: number,
    page: TranscriptPage | null
  ): void {
    if (
      this.isLive(state) &&
      attempt > state.committedAttempt &&
      page?.chatId === invalidation.chatId
    ) {
      try {
        if (this.commit({ invalidation, page, generation }) !== false) {
          state.committedAttempt = attempt
          // This page covers the invalidation that started its read, not any
          // newer notification that arrived while the read was in flight.
          state.committedGeneration = Math.max(state.committedGeneration, generation)
          // A late success can arrive after its waiter timed out but before
          // the delayed retry starts. Cancel only that now-redundant retry,
          // never a newer invalidation's timer or another attempt's deadline.
          if (
            state.committedGeneration === state.generation &&
            !state.inFlight &&
            state.retryTimer &&
            state.timer
          ) {
            this.clearTimer(state.timer)
            state.timer = undefined
            state.retryTimer = false
          }
        }
      } catch {
        // A renderer state transition may have made the surface disappear.
      }
    }
  }

  private async runFetch(
    state: RefreshState,
    invalidation: ChatUpdateInvalidation,
    generation: number,
    attempt: number,
    isImmediateRetry: boolean
  ): Promise<void> {
    try {
      const fetch = this.fetchPage({
        chatId: invalidation.chatId,
        maxMessages: this.maxMessages,
        maxBytes: this.maxBytes
      })
      // Keep publication attached to the original read. Full-history indexing
      // can legitimately outlast the waiting bound; discarding every such
      // page would keep a busy transcript blank despite successful reads.
      void fetch.then(
        (page) => this.acceptPage(state, invalidation, generation, attempt, page),
        () => undefined
      )
      await this.withFetchSettleTimeout(fetch)
    } catch {
      // Keep the current window; bounded retries also cover a quiet stream.
    }

    if (!this.isLive(state)) return
    // OWNERSHIP FIRST. A deadline may already have released this slot to a newer
    // fetch, and that fetch owns both the slot AND its own deadline timer.
    // Clearing the timer before checking would strip the newer fetch of its
    // deadline and then release its slot, starting a third pull alongside it —
    // one overrun compounding into concurrent invokes against the very main
    // thread that just missed a deadline.
    if (state.deadlineOwner !== attempt) return
    if (state.deadlineTimer) {
      this.clearTimer(state.deadlineTimer)
      state.deadlineTimer = undefined
    }
    state.deadlineOwner = null
    if (!state.inFlight) return
    state.inFlight = false
    if (state.generation === generation) {
      // The pull settled (or failed) with nothing newer waiting. A failed pull
      // gets the bounded retry — without it this chat would sit stale until an
      // unrelated invalidation arrives, which the mirror's equality gate no
      // longer manufactures.
      if (state.committedGeneration < generation) this.armRetry(state)
      return
    }

    if (!isImmediateRetry) {
      this.startFetch(state, true)
    } else {
      this.arm(state)
    }
  }
}
