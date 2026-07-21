import type { ChatMessage, ChatRecord } from '../../../main/store/types'

export interface SelectRecentChatsOptions {
  limit: number
  excludeArchived?: boolean
  excludePinned?: boolean
}

/**
 * Messages that should not promote a chat in Recents.
 * `channelInbound` is retired external-gateway history that looks like a user
 * row but is not a human compose action in this app.
 */
function isUserRecencyMessage(message: ChatMessage): boolean {
  if (message.role !== 'user') return false
  if (message.metadata?.kind === 'channelInbound') return false
  return true
}

function parseMessageTimestampMs(timestamp: string | undefined): number {
  if (typeof timestamp !== 'string' || !timestamp) return 0
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * Recents rank key: last genuine user compose time, not live write recency.
 *
 * `AppStore.saveChat` stamps `updatedAt = Date.now()` on every stream/tool/
 * audit save. Sorting Recents by that made concurrent active threads leapfrog
 * for the top slot. User-message time (and `createdAt` when there is none)
 * stays stable across streaming while still promoting a chat when the user
 * actually sends.
 */
export function chatRecentsSortKeyMs(chat: ChatRecord): number {
  let lastUserMs = 0
  for (const message of chat.messages || []) {
    if (!isUserRecencyMessage(message)) continue
    const ms = parseMessageTimestampMs(message.timestamp)
    if (ms > lastUserMs) lastUserMs = ms
  }
  if (lastUserMs > 0) return lastUserMs

  // Prefer createdAt over updatedAt so empty/new chats do not reshuffle while
  // a run is streaming and thrashing updatedAt.
  if (Number.isFinite(chat.createdAt) && chat.createdAt > 0) return chat.createdAt
  return Number.isFinite(chat.updatedAt) ? chat.updatedAt : 0
}

/** Pure derivation used by the sidebar Recents section.
 *
 * Sorts by **user-facing recency** (last genuine user message, else
 * `createdAt`) descending — not by live `updatedAt` write recency. Ties are
 * broken by `appChatId` so the ordering is fully deterministic for snapshot
 * tests + stable React keys (no jitter when two chats share a timestamp,
 * which happens around bulk imports).
 *
 * `excludeArchived` and `excludePinned` default to `true` because the
 * sidebar surface always wants those filtered out — the Pinned section
 * renders pinned items separately and archived chats are hidden across
 * the whole sidebar. The flags exist so other callers can opt out. */
export function selectRecentChats(
  chats: ChatRecord[],
  options: SelectRecentChatsOptions
): ChatRecord[] {
  const { limit, excludeArchived = true, excludePinned = true } = options
  if (!Array.isArray(chats) || chats.length === 0 || limit <= 0) {
    return []
  }

  const filtered = chats.filter((chat) => {
    if (excludeArchived && chat.archived) return false
    if (excludePinned && chat.pinned) return false
    return true
  })

  const keyed = filtered.map((chat) => ({
    chat,
    key: chatRecentsSortKeyMs(chat)
  }))

  keyed.sort((a, b) => {
    if (a.key !== b.key) return b.key - a.key
    return String(a.chat.appChatId).localeCompare(String(b.chat.appChatId))
  })

  return keyed.slice(0, limit).map((entry) => entry.chat)
}
