import type { ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import { isChatSummaryRecord } from './chatRecordMerge'
import { demoteChatToSummary } from './chatByteLru'

/**
 * T7a — per-chat external transcript store.
 *
 * Keeps `messages` / `runs` off the App chrome ChatRecord identity so a
 * sidebar/composer commit can change chat metadata without invalidating the
 * transcript derivation graph. The store is the live source of transcript
 * arrays for focused/pinned chats; demotion drops the arrays from heap while
 * durable disk remains the re-hydrate source of truth (ADR §5.8).
 *
 * Versioned for `useSyncExternalStore`: each chat has a generation that bumps
 * on set/ingest/drop/clear, `getSnapshot` returns a stable payload reference
 * between mutations, and listeners can subscribe per-chat or globally.
 */

export interface ChatTranscriptPayload {
  messages: ChatMessage[]
  runs: ChatRun[]
  updatedAt: number
}

export interface ChatTranscriptStoreStats {
  chatCount: number
  messageCount: number
  runCount: number
}

export type ChatTranscriptStoreListener = () => void

const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_RUNS: ChatRun[] = []

/** Stable empty snapshot for missing / null chat ids (useSyncExternalStore). */
export const EMPTY_CHAT_TRANSCRIPT_PAYLOAD: ChatTranscriptPayload = {
  messages: EMPTY_MESSAGES,
  runs: EMPTY_RUNS,
  updatedAt: 0
}

function emptyPayload(updatedAt = 0): ChatTranscriptPayload {
  if (updatedAt === 0) return EMPTY_CHAT_TRANSCRIPT_PAYLOAD
  return { messages: [], runs: [], updatedAt }
}

function payloadsReferentiallyEqual(
  previous: ChatTranscriptPayload | undefined,
  next: ChatTranscriptPayload
): boolean {
  return (
    !!previous &&
    previous.messages === next.messages &&
    previous.runs === next.runs &&
    previous.updatedAt === next.updatedAt
  )
}

export class ChatTranscriptStore {
  private readonly byId = new Map<string, ChatTranscriptPayload>()
  private readonly generationById = new Map<string, number>()
  private readonly listenersById = new Map<string, Set<ChatTranscriptStoreListener>>()
  private readonly allListeners = new Set<ChatTranscriptStoreListener>()

  has(chatId: string): boolean {
    return this.byId.has(chatId)
  }

  get(chatId: string): ChatTranscriptPayload | null {
    return this.byId.get(chatId) ?? null
  }

  /**
   * Stable snapshot for `useSyncExternalStore`. Missing chats return the
   * shared empty payload singleton — never a fresh object per call.
   */
  getSnapshot(chatId: string | null | undefined): ChatTranscriptPayload {
    if (!chatId) return EMPTY_CHAT_TRANSCRIPT_PAYLOAD
    return this.byId.get(chatId) ?? EMPTY_CHAT_TRANSCRIPT_PAYLOAD
  }

  /** Per-chat generation; 0 when the chat has never been written. */
  generation(chatId: string): number {
    return this.generationById.get(chatId) ?? 0
  }

  /**
   * Subscribe to one chat's transcript changes. Returns unsubscribe.
   * Empty / missing chatId is a no-op subscription.
   */
  subscribe(
    chatId: string | null | undefined,
    listener: ChatTranscriptStoreListener
  ): () => void {
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

  /** Subscribe to every chat mutation (set/ingest/drop/clear). */
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
    const rawMessages = Array.isArray(payload.messages) ? payload.messages : EMPTY_MESSAGES
    const rawRuns = Array.isArray(payload.runs) ? payload.runs : EMPTY_RUNS
    // Canonical empty arrays so identical empty writes stay referentially stable.
    const next: ChatTranscriptPayload = {
      messages: rawMessages.length === 0 ? EMPTY_MESSAGES : rawMessages,
      runs: rawRuns.length === 0 ? EMPTY_RUNS : rawRuns,
      updatedAt: payload.updatedAt ?? Date.now()
    }
    const previous = this.byId.get(chatId)
    if (payloadsReferentiallyEqual(previous, next)) {
      return previous!
    }
    this.byId.set(chatId, next)
    this.bumpGeneration(chatId)
    this.notify(chatId)
    return next
  }

  /** Capture transcript arrays from a full ChatRecord into the store. */
  ingest(chat: ChatRecord): ChatTranscriptPayload | null {
    if (!chat?.appChatId || isChatSummaryRecord(chat)) return null
    return this.set(chat.appChatId, {
      messages: chat.messages,
      runs: chat.runs,
      updatedAt: chat.updatedAt ?? Date.now()
    })
  }

  /**
   * Return a ChatRecord whose messages/runs come from the store when present.
   * Summary stubs and missing store entries pass through unchanged.
   */
  applyToChat(chat: ChatRecord): ChatRecord {
    if (!chat?.appChatId || isChatSummaryRecord(chat)) return chat
    const stored = this.byId.get(chat.appChatId)
    if (!stored) return chat
    if (chat.messages === stored.messages && chat.runs === stored.runs) return chat
    return {
      ...chat,
      messages: stored.messages,
      runs: stored.runs
    }
  }

  /**
   * Chrome-only view: strip messages/runs from the record while keeping the
   * arrays in the store (so TranscriptPanel can read them by chat id).
   */
  detachChrome(chat: ChatRecord): ChatRecord {
    if (!chat?.appChatId || isChatSummaryRecord(chat)) return chat
    this.ingest(chat)
    if ((chat.messages?.length ?? 0) === 0 && (chat.runs?.length ?? 0) === 0) {
      return chat
    }
    return {
      ...chat,
      messages: [],
      runs: []
    }
  }

  /** Drop stored transcript for a chat (LRU demote / delete / clear-all). */
  drop(chatId: string): boolean {
    if (!this.byId.delete(chatId)) return false
    this.bumpGeneration(chatId)
    this.notify(chatId)
    return true
  }

  /** Demote a full chat to summary and drop its stored transcript. */
  demote(chat: ChatRecord): ChatListItemLike {
    if (chat?.appChatId) this.drop(chat.appChatId)
    return demoteChatToSummary(chat)
  }

  clear(): void {
    if (this.byId.size === 0 && this.generationById.size === 0) return
    const chatIds = Array.from(this.byId.keys())
    this.byId.clear()
    for (const chatId of chatIds) {
      this.bumpGeneration(chatId)
    }
    // Notify per-chat listeners that still remain, then everyone on subscribeAll.
    for (const chatId of chatIds) {
      this.notifyChatListeners(chatId)
    }
    this.notifyAllListeners()
  }

  stats(): ChatTranscriptStoreStats {
    let messageCount = 0
    let runCount = 0
    for (const payload of this.byId.values()) {
      messageCount += payload.messages.length
      runCount += payload.runs.length
    }
    return {
      chatCount: this.byId.size,
      messageCount,
      runCount
    }
  }

  /** Snapshot for tests / probe meters. */
  entries(): Array<[string, ChatTranscriptPayload]> {
    return Array.from(this.byId.entries())
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
