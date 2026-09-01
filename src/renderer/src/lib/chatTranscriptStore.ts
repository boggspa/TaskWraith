import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import {
  DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES,
  DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES,
  selectTranscriptPageEndingAt,
  selectTranscriptPageStartingAt,
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
  selectTranscriptPageEndingAt,
  selectTranscriptPageStartingAt,
  type TranscriptPageRange
}

/**
 * T7a/T7c — per-chat external transcript store with a bounded presentation page.
 *
 * Full arrays remain the renderer's authoritative mutation/save source. React
 * subscribers receive only one count-and-byte-bounded page, so grouping,
 * indexing, virtualization, and row caches cannot scale with the entire
 * historical transcript. Paging replaces the presentation page; it never
 * accumulates older pages in the render model.
 */

export const DEFAULT_TRANSCRIPT_PAGE_MAX_RUNS = 512

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
  payload: ChatTranscriptPayload
}

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
    if (entry.payload.windowStart <= 0) return entry.payload
    const range = this.backwardRange(entry.sourceMessages, entry.payload.windowStart)
    return this.replacePage(chatId, entry, range, false)
  }

  showNewerPage(chatId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry) return null
    if (entry.payload.windowEnd >= entry.sourceMessages.length) return entry.payload
    const range = this.forwardRange(entry.sourceMessages, entry.payload.windowEnd)
    return this.replacePage(chatId, entry, range, range.end === entry.sourceMessages.length)
  }

  showLatestPage(chatId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry) return null
    const range = this.latestRange(entry.sourceMessages)
    if (entry.followsLatest && range.start === entry.payload.windowStart) return entry.payload
    return this.replacePage(chatId, entry, range, true)
  }

  revealMessage(chatId: string, messageId: string): ChatTranscriptPayload | null {
    const entry = this.byId.get(chatId)
    if (!entry || !messageId) return entry?.payload ?? null
    const existingIndex = entry.sourceMessages.findIndex((message) => message.id === messageId)
    if (existingIndex < 0) return entry.payload
    if (existingIndex >= entry.payload.windowStart && existingIndex < entry.payload.windowEnd) {
      return entry.payload
    }
    const range = this.backwardRange(entry.sourceMessages, existingIndex + 1)
    return this.replacePage(chatId, entry, range, range.end === entry.sourceMessages.length)
  }

  /** Reapply full authoritative arrays; presentation pages must never be saved. */
  applyToChat(chat: ChatRecord): ChatRecord {
    if (!chat?.appChatId || isChatSummaryRecord(chat)) return chat
    const stored = this.byId.get(chat.appChatId)
    if (!stored) return chat
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
    if (sourceRuns.length <= this.maxRunsPerPage) return sourceRuns
    const messageIds = new Set(messages.map((message) => message.id))
    const runIds = new Set(
      messages
        .map((message) => message.runId)
        .filter((runId): runId is string => typeof runId === 'string' && runId.length > 0)
    )
    const relevant = sourceRuns.filter(
      (run) =>
        !run.endedAt ||
        runIds.has(run.runId) ||
        Boolean(run.promptMessageId && messageIds.has(run.promptMessageId))
    )
    return relevant.length <= this.maxRunsPerPage
      ? relevant
      : relevant.slice(relevant.length - this.maxRunsPerPage)
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
