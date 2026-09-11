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
  /** Must synchronously publish the accepted generation into renderer state. */
  commit: (value: PagedChatUpdateRefreshCommit) => void
  debounceMs?: number
  /** Releases the per-chat flight slot when a pull overruns. 0 disables. */
  fetchDeadlineMs?: number
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
  deadlineTimer?: ReturnType<typeof setTimeout>
  /** Generation that currently owns the slot and its deadline. */
  deadlineOwner: number | null
  cancelled: boolean
  lastTouched: number
  /** Newest generation a commit has published. Lags `generation` while behind. */
  committedGeneration: number
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
 * There is at most one fetch per chat. Invalidations replace each other while
 * debounced or in flight. A fetch invalidated while awaiting IPC is discarded
 * and retried once immediately with the newest generation; if streaming also
 * outruns that retry, the next cycle returns to the debounce rather than
 * creating an unbounded fetch loop.
 */
export class PagedChatUpdateRefreshCoordinator {
  private readonly states = new Map<string, RefreshState>()
  private readonly fetchPage: PagedChatUpdateTailFetcher
  private readonly commit: (value: PagedChatUpdateRefreshCommit) => void
  private readonly debounceMs: number
  private readonly fetchDeadlineMs: number
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

  constructor(options: PagedChatUpdateRefreshCoordinatorOptions) {
    this.fetchPage = options.fetchPage
    this.commit = options.commit
    this.debounceMs = boundedDebounce(options.debounceMs)
    this.fetchDeadlineMs =
      typeof options.fetchDeadlineMs === 'number' && Number.isFinite(options.fetchDeadlineMs)
        ? Math.max(0, Math.floor(options.fetchDeadlineMs))
        : DEFAULT_PAGED_CHAT_UPDATE_FETCH_DEADLINE_MS
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
        cancelled: false,
        lastTouched: 0,
        committedGeneration: 0,
        deadlineOwner: null
      }
      this.states.set(invalidation.chatId, state)
    }

    state.latest = invalidation
    state.generation += 1
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
    if (!this.isLive(state) || state.inFlight) return
    if (state.timer) this.clearTimer(state.timer)
    state.timer = this.setTimer(() => {
      state.timer = undefined
      this.startFetch(state, false)
    }, this.debounceMs)
  }

  private startFetch(state: RefreshState, isImmediateRetry: boolean): void {
    if (!this.isLive(state) || state.inFlight) return
    const generation = state.generation
    const invalidation = state.latest
    state.inFlight = true
    state.deadlineOwner = generation
    // Release the slot if this pull overruns. The fetch keeps running and its
    // page is still accepted if it lands — a late page is correct, it is the
    // WEDGED SLOT that costs the user their transcript.
    if (this.fetchDeadlineMs > 0) {
      state.deadlineTimer = this.setTimer(() => {
        state.deadlineTimer = undefined
        if (!this.isLive(state) || !state.inFlight) return
        if (state.deadlineOwner !== generation) return
        state.deadlineOwner = null
        state.inFlight = false
        this.overdueFetches += 1
        // Re-arm only when something newer is actually waiting. Retrying into a
        // main thread that just missed a 10s deadline would pile fetches onto
        // the very stall we are recovering from.
        if (state.generation > generation) this.arm(state)
      }, this.fetchDeadlineMs)
    }

    void this.runFetch(state, invalidation, generation, isImmediateRetry)
  }

  private async runFetch(
    state: RefreshState,
    invalidation: ChatUpdateInvalidation,
    generation: number,
    isImmediateRetry: boolean
  ): Promise<void> {
    let page: TranscriptPage | null = null
    try {
      page = await this.fetchPage({
        chatId: invalidation.chatId,
        maxMessages: this.maxMessages,
        maxBytes: this.maxBytes
      })
    } catch {
      // The next invalidation is the retry signal; keep the current window.
    }

    if (
      this.isLive(state) &&
      state.generation === generation &&
      page?.chatId === invalidation.chatId
    ) {
      try {
        this.commit({ invalidation, page, generation })
        // Only a real commit closes the gap. Recorded here rather than on
        // fetch completion so `behind` stays true when a page arrives for a
        // surface that has gone away and nothing was published.
        if (generation > state.committedGeneration) state.committedGeneration = generation
      } catch {
        // A renderer state transition may have made the surface disappear.
      }
    }

    if (!this.isLive(state)) return
    // OWNERSHIP FIRST. A deadline may already have released this slot to a newer
    // fetch, and that fetch owns both the slot AND its own deadline timer.
    // Clearing the timer before checking would strip the newer fetch of its
    // deadline and then release its slot, starting a third pull alongside it —
    // one overrun compounding into concurrent invokes against the very main
    // thread that just missed a deadline.
    if (state.deadlineOwner !== generation) return
    if (state.deadlineTimer) {
      this.clearTimer(state.deadlineTimer)
      state.deadlineTimer = undefined
    }
    state.deadlineOwner = null
    if (!state.inFlight) return
    state.inFlight = false
    if (state.generation === generation) return

    if (!isImmediateRetry) {
      this.startFetch(state, true)
    } else {
      this.arm(state)
    }
  }
}
