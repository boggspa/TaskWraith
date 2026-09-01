import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import {
  DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES,
  DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES,
  DEFAULT_TRANSCRIPT_PAGE_MAX_RUNS,
  estimateJsonishBytes,
  selectTranscriptPageEndingAt,
  selectTranscriptPageRuns,
  selectTranscriptPageStartingAt,
  type TranscriptPage,
  type TranscriptPageRange
} from '../../../shared/transcriptPage'
import { isChatSummaryRecord } from './chatRecordMerge'
import { demoteChatToSummary } from './chatByteLru'

// Stage 2 dedup: the bounded-page selectors, their range type, and the page
// limits live once in `src/shared/transcriptPage.ts` so the renderer's
// presentation windows and main's `get-chat-transcript-page` producer share
// one byte estimator (the jsonish full walk) by construction. Re-exported
// here so the renderer's public import surface is unchanged.
export {
  DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES,
  DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES,
  DEFAULT_TRANSCRIPT_PAGE_MAX_RUNS,
  selectTranscriptPageEndingAt,
  selectTranscriptPageStartingAt,
  type TranscriptPageRange
}

/**
 * T7a/T7c — per-chat external transcript store with a bounded presentation page.
 *
 * Full arrays remain the renderer's authoritative mutation/save source whenever
 * they are present. React subscribers receive only one count-and-byte-bounded
 * page, so grouping, indexing, virtualization, and row caches cannot scale with
 * the entire historical transcript.
 *
 * Stage 1b: an entry can also be PAGED — ingested from a main-produced
 * TranscriptPage (ingestPage) while the chat record stays a summaryOnly shell.
 * Paged entries hold no full source arrays; their window-move methods are
 * no-ops and the pager (chatTranscriptPager.ts) fetches adjacent windows over
 * IPC instead. A full ingest() replaces a paged entry wholesale (escalation).
 *
 * Accumulated infinite scroll: a paged entry holds ONE CONTIGUOUS window that
 * may span several fetched pages. The three window operations are EXPLICIT and
 * never inferred:
 *
 *   - `ingestPage` / `replaceChatTranscriptWindow` — the page becomes the whole
 *     window (initial open, reveal/jump-to-id, return-to-latest).
 *   - `prependChatTranscriptPage` — the reader scrolled up; the page joins the
 *     window's older edge.
 *   - `appendChatTranscriptPage` — the reader scrolled down; the page joins the
 *     window's newer edge.
 *
 * Accumulation is a caller's stated intent rather than something guessed from
 * the incoming page's shape, because a re-open, a jump, and a scroll can all
 * produce an adjacent page — inferring from adjacency alone silently turns a
 * "show me this page" into "extend the window". Prepend/append still verify
 * adjacency and fall back to replace when the page does not actually touch the
 * loaded window, so the window can never become discontiguous. It is capped at
 * ACCUMULATED_WINDOW_PAGE_BUDGET pages of messages and bytes with far-end
 * eviction, and hasOlder/hasNewer are recomputed from the resulting absolute
 * window bounds so they stay honest after an eviction.
 */

/**
 * How many page budgets one accumulated window may span before the far edge is
 * evicted (defaults: 4 × 1,500 messages and 4 × 24 MiB). Large enough that a
 * reader scrolling back through history keeps plenty of already-loaded context
 * on both sides of the viewport, small enough that the render model still can
 * not grow with the whole transcript — which is the entire point of paging.
 */
export const ACCUMULATED_WINDOW_PAGE_BUDGET = 4

export interface ChatTranscriptPayload {
  messages: ChatMessage[]
  runs: ChatRun[]
  updatedAt: number
  totalMessageCount: number
  windowStart: number
  windowEnd: number
  windowEstimatedBytes: number
  hasOlder: boolean
  hasNewer: boolean
}

export interface ChatTranscriptStoreStats {
  chatCount: number
  messageCount: number
  runCount: number
}

export interface ChatTranscriptStoreOptions {
  maxMessagesPerPage?: number
  maxBytesPerPage?: number
  maxRunsPerPage?: number
  now?: () => number
}

interface ChatTranscriptEntry {
  sourceMessages: ChatMessage[]
  sourceRuns: ChatRun[]
  sourceUpdatedAt: number
  followsLatest: boolean
  /** Stage 1b: entry holds a main-produced page, not full source arrays. */
  paged?: boolean
  payload: ChatTranscriptPayload
}

/** Which edge of the loaded window an incoming page joins. */
type AccumulateDirection = 'older' | 'newer'

export type ChatTranscriptStoreListener = () => void

const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_RUNS: ChatRun[] = []

/** Stable empty snapshot for missing / null chat ids (useSyncExternalStore). */
export const EMPTY_CHAT_TRANSCRIPT_PAYLOAD: ChatTranscriptPayload = {
  messages: EMPTY_MESSAGES,
  runs: EMPTY_RUNS,
  updatedAt: 0,
  totalMessageCount: 0,
  windowStart: 0,
  windowEnd: 0,
  windowEstimatedBytes: 0,
  hasOlder: false,
  hasNewer: false
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.max(1, Math.floor(value))
}

function emptyPayload(updatedAt = 0): ChatTranscriptPayload {
  if (updatedAt === 0) return EMPTY_CHAT_TRANSCRIPT_PAYLOAD
  return { ...EMPTY_CHAT_TRANSCRIPT_PAYLOAD, messages: [], runs: [], updatedAt }
}

/**
 * Union of the runs already on screen and the runs the incoming page carries,
 * keyed by run id. The PAGE's copy wins: a run that is still streaming gets a
 * fresher row on every fetch, and keeping the stale one would freeze its status
 * in the accumulated window.
 */
function mergeRunsById(existingRuns: ChatRun[], pageRuns: ChatRun[]): ChatRun[] {
  if (existingRuns.length === 0) return pageRuns
  if (pageRuns.length === 0) return existingRuns
  const byId = new Map<string, ChatRun>()
  for (const run of existingRuns) if (run?.runId) byId.set(run.runId, run)
  for (const run of pageRuns) if (run?.runId) byId.set(run.runId, run)
  return Array.from(byId.values())
}

function payloadsReferentiallyEqual(
  previous: ChatTranscriptPayload | undefined,
  next: ChatTranscriptPayload
): boolean {
  return (
    !!previous &&
    previous.messages === next.messages &&
    previous.runs === next.runs &&
    previous.updatedAt === next.updatedAt &&
    previous.totalMessageCount === next.totalMessageCount &&
    previous.windowStart === next.windowStart &&
    previous.windowEnd === next.windowEnd &&
    previous.windowEstimatedBytes === next.windowEstimatedBytes &&
    previous.hasOlder === next.hasOlder &&
    previous.hasNewer === next.hasNewer
  )
}

export class ChatTranscriptStore {
  private readonly byId = new Map<string, ChatTranscriptEntry>()
  private readonly generationById = new Map<string, number>()
  private readonly listenersById = new Map<string, Set<ChatTranscriptStoreListener>>()
  private readonly allListeners = new Set<ChatTranscriptStoreListener>()
  private readonly maxMessagesPerPage: number
  private readonly maxBytesPerPage: number
  private readonly maxRunsPerPage: number
  private readonly now: () => number

  constructor(options: ChatTranscriptStoreOptions = {}) {
    this.maxMessagesPerPage = positiveInteger(
      options.maxMessagesPerPage,
      DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES
    )
    this.maxBytesPerPage = positiveInteger(
      options.maxBytesPerPage,
      DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES
    )
    this.maxRunsPerPage = positiveInteger(options.maxRunsPerPage, DEFAULT_TRANSCRIPT_PAGE_MAX_RUNS)
    this.now = options.now ?? Date.now
  }

  has(chatId: string): boolean {
    return this.byId.has(chatId)
  }

  /** Stage 1b: true when the entry holds a main-produced page, not full arrays. */
  isPaged(chatId: string): boolean {
    return this.byId.get(chatId)?.paged === true
  }

  /**
   * Stage 1b — install a main-produced TranscriptPage as the chat's entire
   * presentation state. No full source arrays are held; adjacent windows are
   * fetched over IPC by the pager.
   *
   * REPLACE semantics, including when the chat is already paged: see the
   * class doc for why accumulation is never inferred here.
   */
  ingestPage(page: TranscriptPage): ChatTranscriptPayload {
    return this.installPagedWindow(page.chatId, {
      messages: page.messages,
      runs: page.runs,
      updatedAt: page.updatedAt,
      totalMessageCount: page.totalMessageCount,
      windowStart: page.windowStart,
      windowEnd: page.windowEnd,
      windowEstimatedBytes: page.estimatedBytes,
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer
    })
  }

  /** Replace the loaded window wholesale (open, reveal/jump, return-to-latest). */
  replaceChatTranscriptWindow(page: TranscriptPage): ChatTranscriptPayload {
    return this.ingestPage(page)
  }

  /**
   * Extend the loaded window with the page immediately BEFORE it — the reader
   * scrolled up. Returns null when the chat is not paged, because a fully
   * hydrated chat rewindows from its own source arrays (showOlderPage) and
   * must never take transcript content from an IPC page.
   */
  prependChatTranscriptPage(chatId: string, page: TranscriptPage): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry?.paged) return null
    return this.accumulatePage(chatId, entry, page, 'older')
  }

  /** Extend the loaded window with the page immediately AFTER it (scrolled down). */
  appendChatTranscriptPage(chatId: string, page: TranscriptPage): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry?.paged) return null
    return this.accumulatePage(chatId, entry, page, 'newer')
  }

  /**
   * Join an adjacent page onto one edge of the loaded window.
   *
   * A page that does not actually touch the window replaces it instead: a
   * window assembled from two disjoint stretches of history would render the
   * transcript in an order that never existed, which is far worse than losing
   * the accumulated context.
   */
  private accumulatePage(
    chatId: string,
    entry: ChatTranscriptEntry,
    page: TranscriptPage,
    direction: AccumulateDirection
  ): ChatTranscriptPayload {
    const existing = entry.payload
    // Windows are half-open: [windowStart, windowEnd). A page joins this edge
    // when it REACHES the edge, which includes overlapping it — the pager
    // anchors its request on the boundary message, so a page that re-delivers
    // that message is the normal case, not a jump. Requiring the edges to meet
    // exactly (`page.windowEnd === existing.windowStart`) rejected every
    // overlapping page and silently fell through to replace, discarding the
    // tail the reader was looking at. Only a GAP may replace.
    const joinsEdge =
      direction === 'older'
        ? page.windowStart <= existing.windowStart && page.windowEnd >= existing.windowStart
        : page.windowStart <= existing.windowEnd && page.windowEnd >= existing.windowEnd
    if (!joinsEdge) return this.ingestPage(page)

    // Overlap is normal: the boundary message, and anything appended while the
    // fetch was in flight, arrive in both windows. Keep the copy already on
    // screen so its React identity survives the merge.
    const onScreen = new Set(existing.messages.map((message) => message.id))
    const added = page.messages.filter((message) => !onScreen.has(message.id))
    if (added.length === 0) return existing

    const merged =
      direction === 'older' ? [...added, ...existing.messages] : [...existing.messages, ...added]
    // Absolute index of merged[0] within the canonical transcript. For an older
    // page `added` is exactly the run of messages that sit BEFORE the current
    // head — everything from the overlap onward was filtered out above — so
    // moving the head back by that count stays consistent with the window
    // bounds derived from it below.
    const mergedStart =
      direction === 'older' ? existing.windowStart - added.length : existing.windowStart

    const kept = this.boundAccumulatedWindow(merged, direction)
    const messages = merged.slice(kept.start, kept.end)
    const windowStart = mergedStart + kept.start
    const windowEnd = mergedStart + kept.end
    // The window itself is proof of at least this many messages, so a stale
    // count from an older page can never claim the window runs past the end.
    const totalMessageCount = Math.max(page.totalMessageCount, windowEnd)

    return this.installPagedWindow(chatId, {
      messages: messages.length === 0 ? EMPTY_MESSAGES : messages,
      runs: selectTranscriptPageRuns(
        mergeRunsById(existing.runs, page.runs),
        messages,
        this.maxRunsPerPage * ACCUMULATED_WINDOW_PAGE_BUDGET
      ),
      updatedAt: Math.max(page.updatedAt, existing.updatedAt),
      totalMessageCount,
      windowStart,
      windowEnd,
      windowEstimatedBytes: kept.estimatedBytes,
      // Recomputed from absolute bounds rather than copied from the page, so an
      // eviction at the far edge immediately reports that direction as loadable
      // again instead of stranding the reader at a dead end.
      hasOlder: windowStart > 0,
      hasNewer: windowEnd < totalMessageCount
    })
  }

  /**
   * Clamp the merged window to the accumulated message and byte budgets by
   * evicting from the FAR edge — the direction the reader is moving away from —
   * so what survives is still one contiguous run.
   *
   * Every message is measured exactly once and the running total is adjusted by
   * the evicted message's own size. Re-estimating the remaining slice on each
   * eviction would be quadratic, and this walk can span a 6,000-row window.
   */
  private boundAccumulatedWindow(
    merged: ChatMessage[],
    direction: AccumulateDirection
  ): { start: number; end: number; estimatedBytes: number } {
    const maxMessages = this.maxMessagesPerPage * ACCUMULATED_WINDOW_PAGE_BUDGET
    const maxBytes = this.maxBytesPerPage * ACCUMULATED_WINDOW_PAGE_BUDGET
    const sizes = merged.map((message) => Math.max(0, estimateJsonishBytes(message)))
    let start = direction === 'older' ? 0 : Math.max(0, merged.length - maxMessages)
    let end = direction === 'older' ? Math.min(merged.length, maxMessages) : merged.length
    let estimatedBytes = 0
    for (let index = start; index < end; index += 1) estimatedBytes += sizes[index]
    // Always leave one message standing: an empty window would report both
    // edges as loadable and spin.
    while (estimatedBytes > maxBytes && end - start > 1) {
      if (direction === 'older') {
        end -= 1
        estimatedBytes -= sizes[end]
      } else {
        estimatedBytes -= sizes[start]
        start += 1
      }
    }
    return { start, end, estimatedBytes }
  }

  private installPagedWindow(
    chatId: string,
    payload: ChatTranscriptPayload
  ): ChatTranscriptPayload {
    return this.installEntry(chatId, {
      sourceMessages: EMPTY_MESSAGES,
      sourceRuns: EMPTY_RUNS,
      sourceUpdatedAt: payload.updatedAt,
      followsLatest: !payload.hasNewer,
      paged: true,
      payload
    })
  }

  get(chatId: string): ChatTranscriptPayload | null {
    return this.byId.get(chatId)?.payload ?? null
  }

  getSnapshot(chatId: string | null | undefined): ChatTranscriptPayload {
    if (!chatId) return EMPTY_CHAT_TRANSCRIPT_PAYLOAD
    return this.byId.get(chatId)?.payload ?? EMPTY_CHAT_TRANSCRIPT_PAYLOAD
  }

  generation(chatId: string): number {
    return this.generationById.get(chatId) ?? 0
  }

  subscribe(chatId: string | null | undefined, listener: ChatTranscriptStoreListener): () => void {
    if (!chatId) return () => {}
    const listeners = this.listenersById.get(chatId) ?? new Set<ChatTranscriptStoreListener>()
    listeners.add(listener)
    this.listenersById.set(chatId, listeners)
    return () => {
      const current = this.listenersById.get(chatId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listenersById.delete(chatId)
    }
  }

  subscribeAll(listener: ChatTranscriptStoreListener): () => void {
    this.allListeners.add(listener)
    return () => {
      this.allListeners.delete(listener)
    }
  }

  set(
    chatId: string,
    payload: {
      messages?: ChatMessage[] | null
      runs?: ChatRun[] | null
      updatedAt?: number
    }
  ): ChatTranscriptPayload {
    const sourceMessages = Array.isArray(payload.messages) ? payload.messages : EMPTY_MESSAGES
    const sourceRuns = Array.isArray(payload.runs) ? payload.runs : EMPTY_RUNS
    const sourceUpdatedAt = payload.updatedAt ?? this.now()
    const range = this.latestRange(sourceMessages)
    return this.installEntry(chatId, {
      sourceMessages,
      sourceRuns,
      sourceUpdatedAt,
      followsLatest: true,
      payload: this.buildPayload(sourceMessages, sourceRuns, range, sourceUpdatedAt)
    })
  }

  /** Capture full authoritative arrays while publishing one bounded page. */
  ingest(chat: ChatRecord): ChatTranscriptPayload | null {
    if (!chat?.appChatId || isChatSummaryRecord(chat)) return null
    const sourceMessages = chat.messages.length === 0 ? EMPTY_MESSAGES : chat.messages
    const sourceRuns = chat.runs.length === 0 ? EMPTY_RUNS : chat.runs
    const previous = this.byId.get(chat.appChatId)
    if (
      previous &&
      previous.sourceMessages === sourceMessages &&
      previous.sourceRuns === sourceRuns
    ) {
      return previous.payload
    }

    const followsLatest = previous?.followsLatest ?? true
    const range = followsLatest
      ? this.latestRange(sourceMessages)
      : this.forwardRange(
          sourceMessages,
          Math.min(previous?.payload.windowStart ?? 0, sourceMessages.length)
        )
    const sourceUpdatedAt = chat.updatedAt ?? this.now()
    return this.installEntry(chat.appChatId, {
      sourceMessages,
      sourceRuns,
      sourceUpdatedAt,
      followsLatest: followsLatest || range.end === sourceMessages.length,
      payload: this.buildPayload(sourceMessages, sourceRuns, range, sourceUpdatedAt)
    })
  }

  showOlderPage(chatId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry) return null
    // Paged entries rewindow via the pager (IPC), not local source arrays.
    if (entry.paged) return entry.payload
    if (entry.payload.windowStart <= 0) return entry.payload
    const range = this.backwardRange(entry.sourceMessages, entry.payload.windowStart)
    return this.replacePage(chatId, entry, range, false)
  }

  showNewerPage(chatId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry) return null
    if (entry.paged) return entry.payload
    if (entry.payload.windowEnd >= entry.sourceMessages.length) return entry.payload
    const range = this.forwardRange(entry.sourceMessages, entry.payload.windowEnd)
    return this.replacePage(chatId, entry, range, range.end === entry.sourceMessages.length)
  }

  showLatestPage(chatId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry) return null
    if (entry.paged) return entry.payload
    const range = this.latestRange(entry.sourceMessages)
    if (entry.followsLatest && range.start === entry.payload.windowStart) return entry.payload
    return this.replacePage(chatId, entry, range, true)
  }

  /**
   * Accumulated infinite scroll over LOCAL authoritative arrays — the hydrated
   * counterpart of prependChatTranscriptPage. A chat can be fully hydrated and
   * still windowed (T7a bounds the presentation page for every chat, not just
   * paged ones), and those chats reach their history through the same scroll
   * gesture, so growing the range here is what keeps the two paths behaving
   * identically instead of only paged chats feeling seamless.
   */
  extendOlderPage(chatId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry) return null
    // Paged entries hold no source arrays; the pager fetches over IPC.
    if (entry.paged) return entry.payload
    if (entry.payload.windowStart <= 0) return entry.payload
    const grown = this.backwardRange(entry.sourceMessages, entry.payload.windowStart)
    const range = this.boundAccumulatedRange(
      entry.sourceMessages,
      grown.start,
      entry.payload.windowEnd,
      'older'
    )
    return this.replacePage(chatId, entry, range, range.end === entry.sourceMessages.length)
  }

  /** Grow the local window forward (scrolled down on a hydrated chat). */
  extendNewerPage(chatId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry) return null
    if (entry.paged) return entry.payload
    if (entry.payload.windowEnd >= entry.sourceMessages.length) return entry.payload
    const grown = this.forwardRange(entry.sourceMessages, entry.payload.windowEnd)
    const range = this.boundAccumulatedRange(
      entry.sourceMessages,
      entry.payload.windowStart,
      grown.end,
      'newer'
    )
    return this.replacePage(chatId, entry, range, range.end === entry.sourceMessages.length)
  }

  /** Apply the accumulated-window budget to a local [start, end) range. */
  private boundAccumulatedRange(
    sourceMessages: ChatMessage[],
    start: number,
    end: number,
    direction: AccumulateDirection
  ): TranscriptPageRange {
    const kept = this.boundAccumulatedWindow(sourceMessages.slice(start, end), direction)
    return {
      start: start + kept.start,
      end: start + kept.end,
      estimatedBytes: kept.estimatedBytes
    }
  }

  revealMessage(chatId: string, messageId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry || !messageId) return entry?.payload ?? null
    if (entry.paged) return entry.payload
    const existingIndex = entry.sourceMessages.findIndex((message) => message.id === messageId)
    if (existingIndex < 0) return entry.payload
    if (existingIndex >= entry.payload.windowStart && existingIndex < entry.payload.windowEnd) {
      return entry.payload
    }
    const range = this.backwardRange(entry.sourceMessages, existingIndex + 1)
    return this.replacePage(chatId, entry, range, range.end === entry.sourceMessages.length)
  }

  /**
   * Reapply full authoritative arrays; presentation pages must never be saved.
   *
   * A PAGED entry holds no source arrays, so it deliberately contributes
   * nothing here: the accumulated window can never be written back onto a chat
   * record, and therefore can never reach saveChat.
   */
  applyToChat(chat: ChatRecord): ChatRecord {
    if (!chat?.appChatId || isChatSummaryRecord(chat)) return chat
    const stored = this.byId.get(chat.appChatId)
    if (!stored || stored.paged) return chat
    if (chat.messages === stored.sourceMessages && chat.runs === stored.sourceRuns) return chat
    return { ...chat, messages: stored.sourceMessages, runs: stored.sourceRuns }
  }

  detachChrome(chat: ChatRecord): ChatRecord {
    if (!chat?.appChatId || isChatSummaryRecord(chat)) return chat
    this.ingest(chat)
    if ((chat.messages?.length ?? 0) === 0 && (chat.runs?.length ?? 0) === 0) return chat
    return { ...chat, messages: [], runs: [] }
  }

  drop(chatId: string): boolean {
    if (!this.byId.delete(chatId)) return false
    this.bumpGeneration(chatId)
    this.notify(chatId)
    return true
  }

  demote(chat: ChatRecord): ChatListItemLike {
    if (chat?.appChatId) this.drop(chat.appChatId)
    return demoteChatToSummary(chat)
  }

  clear(): void {
    if (this.byId.size === 0 && this.generationById.size === 0) return
    const chatIds = Array.from(this.byId.keys())
    this.byId.clear()
    for (const chatId of chatIds) this.bumpGeneration(chatId)
    for (const chatId of chatIds) this.notifyChatListeners(chatId)
    this.notifyAllListeners()
  }

  stats(): ChatTranscriptStoreStats {
    let messageCount = 0
    let runCount = 0
    for (const entry of this.byId.values()) {
      messageCount += entry.payload.messages.length
      runCount += entry.payload.runs.length
    }
    return { chatCount: this.byId.size, messageCount, runCount }
  }

  entries(): Array<[string, ChatTranscriptPayload]> {
    return Array.from(this.byId, ([chatId, entry]) => [chatId, entry.payload])
  }

  private installEntry(chatId: string, entry: ChatTranscriptEntry): ChatTranscriptPayload {
    const previous = this.byId.get(chatId)
    if (payloadsReferentiallyEqual(previous?.payload, entry.payload)) return previous!.payload
    this.byId.set(chatId, entry)
    this.bumpGeneration(chatId)
    this.notify(chatId)
    return entry.payload
  }

  private replacePage(
    chatId: string,
    entry: ChatTranscriptEntry,
    range: TranscriptPageRange,
    followsLatest: boolean
  ): ChatTranscriptPayload {
    const payload = this.buildPayload(
      entry.sourceMessages,
      entry.sourceRuns,
      range,
      Math.max(entry.sourceUpdatedAt, this.now())
    )
    return this.installEntry(chatId, { ...entry, followsLatest, payload })
  }

  private buildPayload(
    sourceMessages: ChatMessage[],
    sourceRuns: ChatRun[],
    range: TranscriptPageRange,
    updatedAt: number
  ): ChatTranscriptPayload {
    const messages =
      range.start === 0 && range.end === sourceMessages.length
        ? sourceMessages
        : sourceMessages.slice(range.start, range.end)
    return {
      messages: messages.length === 0 ? EMPTY_MESSAGES : messages,
      runs: this.pageRuns(sourceRuns, messages),
      updatedAt,
      totalMessageCount: sourceMessages.length,
      windowStart: range.start,
      windowEnd: range.end,
      windowEstimatedBytes: range.estimatedBytes,
      hasOlder: range.start > 0,
      hasNewer: range.end < sourceMessages.length
    }
  }

  private pageRuns(sourceRuns: ChatRun[], messages: ChatMessage[]): ChatRun[] {
    if (sourceRuns.length === 0) return EMPTY_RUNS
    return selectTranscriptPageRuns(sourceRuns, messages, this.maxRunsPerPage)
  }

  private latestRange(messages: ChatMessage[]): TranscriptPageRange {
    return this.backwardRange(messages, messages.length)
  }

  private backwardRange(messages: ChatMessage[], end: number): TranscriptPageRange {
    return selectTranscriptPageEndingAt(messages, end, {
      maxMessagesPerPage: this.maxMessagesPerPage,
      maxBytesPerPage: this.maxBytesPerPage
    })
  }

  private forwardRange(messages: ChatMessage[], start: number): TranscriptPageRange {
    return selectTranscriptPageStartingAt(messages, start, {
      maxMessagesPerPage: this.maxMessagesPerPage,
      maxBytesPerPage: this.maxBytesPerPage
    })
  }

  private bumpGeneration(chatId: string): void {
    this.generationById.set(chatId, (this.generationById.get(chatId) ?? 0) + 1)
  }

  private notifyChatListeners(chatId: string): void {
    const listeners = this.listenersById.get(chatId)
    if (!listeners || listeners.size === 0) return
    for (const listener of Array.from(listeners)) listener()
  }

  private notifyAllListeners(): void {
    if (this.allListeners.size === 0) return
    for (const listener of Array.from(this.allListeners)) listener()
  }

  private notify(chatId: string): void {
    this.notifyChatListeners(chatId)
    this.notifyAllListeners()
  }
}

type ChatListItemLike = ReturnType<typeof demoteChatToSummary>

export function createEmptyTranscriptPayload(updatedAt = 0): ChatTranscriptPayload {
  return emptyPayload(updatedAt)
}
