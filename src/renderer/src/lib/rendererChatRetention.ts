import type { ChatRecord } from '../../../main/store/types'
import type { ChatUpdateBaseline } from '../../../shared/chatUpdateTransport'
import {
  ChatByteLru,
  type ChatPinReason,
  type RetainChatsWithinByteBudgetResult
} from './chatByteLru'
import type { RawLogEntry } from './rawLogEntry'
import { ChatTranscriptStore } from './chatTranscriptStore'

/**
 * Renderer-lifetime residency authority for every full-chat alias.
 *
 * The byte LRU decides which unpinned chats leave the heap. An eviction then
 * drops the transcript source arrays, transport reconstruction baseline and
 * raw-log buffer in the same operation. Durable chat history and run events
 * are deliberately outside this authority, so reopening can rehydrate them.
 */
export class RendererChatRetention {
  readonly byteLru: ChatByteLru
  readonly transcriptStore: ChatTranscriptStore

  private transportBaselines: Map<string, ChatUpdateBaseline> | null = null
  private rawLogs: Map<string, RawLogEntry[]> | null = null

  constructor(options: { byteLru: ChatByteLru; transcriptStore: ChatTranscriptStore }) {
    this.byteLru = options.byteLru
    this.transcriptStore = options.transcriptStore
  }

  attachTransportBaselines(baselines: Map<string, ChatUpdateBaseline>): void {
    this.transportBaselines = baselines
  }

  attachRawLogs(rawLogs: Map<string, RawLogEntry[]>): void {
    this.rawLogs = rawLogs
  }

  retain(
    chats: readonly ChatRecord[],
    additionalPinnedIds?: ReadonlySet<string>
  ): RetainChatsWithinByteBudgetResult {
    const retained = this.byteLru.retain(chats, additionalPinnedIds)
    this.dropMany(retained.evictedIds)
    return retained
  }

  pin(chatId: string, reason: ChatPinReason): void {
    this.byteLru.pin(chatId, reason)
  }

  unpin(chatId: string, reason?: ChatPinReason): void {
    this.byteLru.unpin(chatId, reason)
  }

  isPinned(chatId: string): boolean {
    return this.byteLru.isPinned(chatId)
  }

  pinnedIds(): Set<string> {
    return this.byteLru.pinnedIds()
  }

  touch(chatId: string): void {
    this.byteLru.touch(chatId)
  }

  drop(chatId: string): void {
    this.dropMany([chatId], true)
  }

  dropMany(chatIds: Iterable<string>, forgetResidency = true): void {
    for (const chatId of chatIds) {
      if (!chatId) continue
      this.transcriptStore.drop(chatId)
      this.transportBaselines?.delete(chatId)
      this.rawLogs?.delete(chatId)
      if (forgetResidency) this.byteLru.forget(chatId)
    }
  }

  dropTransportBaseline(chatId: string): void {
    this.transportBaselines?.delete(chatId)
  }

  clear(): void {
    this.transcriptStore.clear()
    this.transportBaselines?.clear()
    this.rawLogs?.clear()
    this.byteLru.clear()
  }
}
