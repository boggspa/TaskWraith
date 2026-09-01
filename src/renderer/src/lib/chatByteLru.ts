import type { ChatListItem, ChatMessage, ChatRecord, ChatRun } from '../../../main/store/types'
import { estimateJsonishBytes } from '../../../shared/transcriptPage'
import { isChatSummaryRecord } from './chatRecordMerge'

// Stage 2 dedup: the jsonish byte walker lives once in `src/shared` so the
// renderer LRU, the renderer presentation windows, and main-produced
// transcript pages all agree on byte counts.
export { estimateJsonishBytes }

/**
 * T7b — byte-weighted LRU for renderer-hydrated full chats.
 *
 * Eviction demotes in-memory records to `summaryOnly` projections and drops
 * `messages`/`runs` from the heap. Durable disk/journal history is never
 * deleted as an LRU side effect (ADR §5.8).
 */

export type ChatPinReason = 'focused' | 'pane' | 'side' | 'popout' | 'approval' | 'manual'

export const DEFAULT_MAX_HYDRATED_CHAT_BYTES = 384 * 1024 * 1024

const PIN_REASONS: readonly ChatPinReason[] = [
  'focused',
  'pane',
  'side',
  'popout',
  'approval',
  'manual'
]

export function estimateChatMessageBytes(message: ChatMessage): number {
  return estimateJsonishBytes(message)
}

export function estimateChatRecordBytes(chat: ChatRecord): number {
  if (isChatSummaryRecord(chat)) {
    return estimateJsonishBytes({
      appChatId: chat.appChatId,
      title: chat.title,
      updatedAt: chat.updatedAt,
      messageCount: (chat as ChatListItem).messageCount,
      runCount: (chat as ChatListItem).runCount
    })
  }
  let total = 256
  total += (chat.title?.length ?? 0) * 2
  for (const message of chat.messages ?? []) total += estimateChatMessageBytes(message)
  for (const run of chat.runs ?? []) total += estimateJsonishBytes(run)
  return total
}

export function demoteChatToSummary(chat: ChatRecord): ChatListItem {
  if (isChatSummaryRecord(chat)) return chat
  const messageCount = Array.isArray(chat.messages) ? chat.messages.length : 0
  const runCount = Array.isArray(chat.runs) ? chat.runs.length : 0
  const lastRun = runCount > 0 ? (chat.runs as ChatRun[])[runCount - 1] : undefined
  const { messages: _messages, runs: _runs, ...chrome } = chat
  return {
    ...chrome,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount,
    runCount,
    ...(lastRun ? { lastRun } : {})
  }
}

export interface ChatByteLruStats {
  hydratedFullChatCount: number
  hydratedMessageBytes: number
  pinnedChatCount: number
  entryCount: number
}

export interface RetainChatsWithinByteBudgetInput {
  chats: readonly ChatRecord[]
  pinnedIds?: ReadonlySet<string>
  maxBytes?: number
  /** Recency order, oldest → newest. Missing ids are treated as oldest. */
  lruOrder?: readonly string[]
  estimateBytes?: (chat: ChatRecord) => number
}

export interface RetainChatsWithinByteBudgetResult {
  chats: ChatRecord[]
  evictedIds: string[]
  stats: ChatByteLruStats
}

interface ChatByteEstimateCacheEntry {
  messages: ChatRecord['messages']
  runs: ChatRecord['runs']
  title: string
  updatedAt: number
  persistenceRevision: number | undefined
  messageCount: number
  runCount: number
  lastMessage: ChatMessage | undefined
  lastMessageContent: string | undefined
  lastRun: ChatRun | undefined
  bytes: number
}

function compareLruOrder(
  leftId: string,
  rightId: string,
  orderIndex: ReadonlyMap<string, number>
): number {
  const left = orderIndex.get(leftId)
  const right = orderIndex.get(rightId)
  if (left === undefined && right === undefined) return leftId.localeCompare(rightId)
  if (left === undefined) return -1
  if (right === undefined) return 1
  return left - right
}

/**
 * Demote unpinned full chats (oldest first) until hydrated byte total fits.
 * Pinned and already-summary rows are never demoted. Order of `chats` is
 * preserved; only record contents change.
 */
export function retainChatsWithinByteBudget(
  input: RetainChatsWithinByteBudgetInput
): RetainChatsWithinByteBudgetResult {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_HYDRATED_CHAT_BYTES
  const pinnedIds = input.pinnedIds ?? new Set<string>()
  const estimate = input.estimateBytes ?? estimateChatRecordBytes
  // One retention pass asks for the same record more than once while computing
  // totals and subtracting evictions. Never recursively walk a transcript twice
  // inside one pass, even when the caller has no longer-lived LRU authority.
  const passEstimateCache = new Map<ChatRecord, number>()
  const estimateOnce = (chat: ChatRecord): number => {
    const cached = passEstimateCache.get(chat)
    if (cached !== undefined) return cached
    const bytes = estimate(chat)
    passEstimateCache.set(chat, bytes)
    return bytes
  }
  const orderIndex = new Map<string, number>()
  ;(input.lruOrder ?? []).forEach((id, index) => {
    if (!orderIndex.has(id)) orderIndex.set(id, index)
  })

  const next = input.chats.map((chat) => chat)
  const byId = new Map<string, number>()
  next.forEach((chat, index) => byId.set(chat.appChatId, index))

  const evictCandidates = next
    .filter((chat) => !isChatSummaryRecord(chat) && !pinnedIds.has(chat.appChatId))
    .sort((a, b) => compareLruOrder(a.appChatId, b.appChatId, orderIndex))

  const evictedIds: string[] = []

  const totals = (): { hydratedFullChatCount: number; hydratedMessageBytes: number } => {
    let hydratedFullChatCount = 0
    let hydratedMessageBytes = 0
    for (const chat of next) {
      if (isChatSummaryRecord(chat)) continue
      hydratedFullChatCount += 1
      hydratedMessageBytes += estimateOnce(chat)
    }
    return { hydratedFullChatCount, hydratedMessageBytes }
  }

  let { hydratedMessageBytes } = totals()
  for (const candidate of evictCandidates) {
    if (hydratedMessageBytes <= maxBytes) break
    const index = byId.get(candidate.appChatId)
    if (index === undefined) continue
    const current = next[index]
    if (!current || isChatSummaryRecord(current) || pinnedIds.has(current.appChatId)) continue
    const before = estimateOnce(current)
    next[index] = demoteChatToSummary(current)
    hydratedMessageBytes -= before
    evictedIds.push(current.appChatId)
  }

  const after = totals()
  return {
    chats: next,
    evictedIds,
    stats: {
      ...after,
      pinnedChatCount: pinnedIds.size,
      entryCount: next.length
    }
  }
}

export class ChatByteLru {
  private readonly maxBytes: number
  private readonly estimateBytes: (chat: ChatRecord) => number
  private readonly pins = new Map<string, Set<ChatPinReason>>()
  private readonly touchOrder: string[] = []
  private estimateCache = new WeakMap<ChatRecord, ChatByteEstimateCacheEntry>()

  constructor(options?: { maxBytes?: number; estimateBytes?: (chat: ChatRecord) => number }) {
    this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_HYDRATED_CHAT_BYTES
    this.estimateBytes = options?.estimateBytes ?? estimateChatRecordBytes
  }

  pin(chatId: string, reason: ChatPinReason): void {
    if (!chatId) return
    const reasons = this.pins.get(chatId) ?? new Set<ChatPinReason>()
    reasons.add(reason)
    this.pins.set(chatId, reasons)
    this.touch(chatId)
  }

  unpin(chatId: string, reason?: ChatPinReason): void {
    const reasons = this.pins.get(chatId)
    if (!reasons) return
    if (!reason) {
      this.pins.delete(chatId)
      return
    }
    reasons.delete(reason)
    if (reasons.size === 0) this.pins.delete(chatId)
  }

  isPinned(chatId: string): boolean {
    return (this.pins.get(chatId)?.size ?? 0) > 0
  }

  pinnedIds(): Set<string> {
    return new Set(this.pins.keys())
  }

  touch(chatId: string): void {
    if (!chatId) return
    const existing = this.touchOrder.indexOf(chatId)
    if (existing >= 0) this.touchOrder.splice(existing, 1)
    this.touchOrder.push(chatId)
  }

  /** Release all renderer-residency metadata for an explicitly removed chat. */
  forget(chatId: string): void {
    if (!chatId) return
    this.pins.delete(chatId)
    const existing = this.touchOrder.indexOf(chatId)
    if (existing >= 0) this.touchOrder.splice(existing, 1)
  }

  private estimateRecord(chat: ChatRecord): number {
    const messages = chat.messages ?? []
    const runs = chat.runs ?? []
    const lastMessage = messages[messages.length - 1]
    const lastRun = runs[runs.length - 1]
    const cached = this.estimateCache.get(chat)
    if (
      cached &&
      cached.messages === chat.messages &&
      cached.runs === chat.runs &&
      cached.title === chat.title &&
      cached.updatedAt === chat.updatedAt &&
      cached.persistenceRevision === chat.persistenceRevision &&
      cached.messageCount === messages.length &&
      cached.runCount === runs.length &&
      cached.lastMessage === lastMessage &&
      cached.lastMessageContent === lastMessage?.content &&
      cached.lastRun === lastRun
    ) {
      return cached.bytes
    }

    const bytes = this.estimateBytes(chat)
    this.estimateCache.set(chat, {
      messages: chat.messages,
      runs: chat.runs,
      title: chat.title,
      updatedAt: chat.updatedAt,
      persistenceRevision: chat.persistenceRevision,
      messageCount: messages.length,
      runCount: runs.length,
      lastMessage,
      lastMessageContent: lastMessage?.content,
      lastRun,
      bytes
    })
    return bytes
  }

  retain(
    chats: readonly ChatRecord[],
    additionalPinnedIds?: ReadonlySet<string>
  ): RetainChatsWithinByteBudgetResult {
    const pinnedIds = this.pinnedIds()
    for (const chatId of additionalPinnedIds ?? []) pinnedIds.add(chatId)
    return retainChatsWithinByteBudget({
      chats,
      pinnedIds,
      maxBytes: this.maxBytes,
      lruOrder: this.touchOrder,
      estimateBytes: (chat) => this.estimateRecord(chat)
    })
  }

  /** Apply retention to a Map in place; returns evicted ids. */
  retainMap(chats: Map<string, ChatRecord>): string[] {
    const ordered = Array.from(chats.values())
    const result = this.retain(ordered)
    for (const chat of result.chats) {
      chats.set(chat.appChatId, chat)
    }
    return result.evictedIds
  }

  statsFor(chats: readonly ChatRecord[]): ChatByteLruStats {
    let hydratedFullChatCount = 0
    let hydratedMessageBytes = 0
    for (const chat of chats) {
      if (isChatSummaryRecord(chat)) continue
      hydratedFullChatCount += 1
      hydratedMessageBytes += this.estimateRecord(chat)
    }
    return {
      hydratedFullChatCount,
      hydratedMessageBytes,
      pinnedChatCount: this.pins.size,
      entryCount: chats.length
    }
  }

  clear(): void {
    this.pins.clear()
    this.touchOrder.length = 0
    this.estimateCache = new WeakMap<ChatRecord, ChatByteEstimateCacheEntry>()
  }

  /** Test/debug helper — pin reason vocabulary is closed. */
  static get pinReasons(): readonly ChatPinReason[] {
    return PIN_REASONS
  }
}
