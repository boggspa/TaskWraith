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

function emptyPayload(updatedAt = 0): ChatTranscriptPayload {
  return { messages: [], runs: [], updatedAt }
}

export class ChatTranscriptStore {
  private readonly byId = new Map<string, ChatTranscriptPayload>()

  has(chatId: string): boolean {
    return this.byId.has(chatId)
  }

  get(chatId: string): ChatTranscriptPayload | null {
    return this.byId.get(chatId) ?? null
  }

  set(
    chatId: string,
    payload: {
      messages?: ChatMessage[] | null
      runs?: ChatRun[] | null
      updatedAt?: number
    }
  ): ChatTranscriptPayload {
    const next: ChatTranscriptPayload = {
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      runs: Array.isArray(payload.runs) ? payload.runs : [],
      updatedAt: payload.updatedAt ?? Date.now()
    }
    this.byId.set(chatId, next)
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
    return this.byId.delete(chatId)
  }

  /** Demote a full chat to summary and drop its stored transcript. */
  demote(chat: ChatRecord): ChatListItemLike {
    if (chat?.appChatId) this.drop(chat.appChatId)
    return demoteChatToSummary(chat)
  }

  clear(): void {
    this.byId.clear()
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
}

type ChatListItemLike = ReturnType<typeof demoteChatToSummary>

export function createEmptyTranscriptPayload(updatedAt = 0): ChatTranscriptPayload {
  return emptyPayload(updatedAt)
}
