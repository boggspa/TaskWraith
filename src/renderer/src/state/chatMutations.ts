import type { ChatRecord } from '../../../main/store/types'
import { mergeChatRecord, reconcileChatRecords } from '../lib/chatRecordMerge'

/**
 * chatMutations — pure functions over ChatRecord[].
 *
 * No React imports, no Electron imports, no mutable app stores.
 * These are the verbs that absorb the ~47 direct setChats sites in App.tsx.
 *
 * VERBS (measured census from App.tsx):
 *   updateChat(id, updater)     — 20 single-chat functional map-updates
 *   mergeChat(record)           — 18 mergeChatRecord upserts
 *   reconcileAll(records)       — 5 full replace/reconcile
 *   replaceAll(records)         — 5 full replace (used in solo/ensemble lanes)
 *   removeChat(id)              — 2 delete/filter
 *   promoteToFront(record)      — 1 prepend-dedup
 *
 * The rAF coalescer/flush stays INTERNAL to the binding hook (useChatMutations)
 * — never a public verb here.
 */

export interface UpdateChatOptions {
  /** If true, silently skip when the chat id is not present. */
  coalesce?: boolean
}

/** Map-update one chat by id. Returns prev unchanged when id is missing and coalesce=true. */
export function updateChat(
  chats: ChatRecord[],
  id: string,
  updater: (chat: ChatRecord) => ChatRecord,
  opts?: UpdateChatOptions
): ChatRecord[] {
  const idx = chats.findIndex((c) => c.appChatId === id)
  if (idx === -1) {
    if (opts?.coalesce) return chats
    return chats
  }
  const next = [...chats]
  next[idx] = updater(next[idx])
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Upsert a single chat via mergeChatRecord (preserves existing messages/runs on summary collision). */
export function mergeChat(chats: ChatRecord[], record: ChatRecord): ChatRecord[] {
  return mergeChatRecord(chats, record)
}

/** Reconcile an incoming batch against existing records (merge per-id, then sort). */
export function reconcileAll(chats: ChatRecord[], incoming: ChatRecord[]): ChatRecord[] {
  return reconcileChatRecords(chats, incoming)
}

/** Full replace — used when the renderer becomes authoritative (solo lane init). */
export function replaceAll(_chats: ChatRecord[], incoming: ChatRecord[]): ChatRecord[] {
  return incoming.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Remove a chat by id. Returns prev unchanged when id is missing. */
export function removeChat(chats: ChatRecord[], id: string): ChatRecord[] {
  const filtered = chats.filter((c) => c.appChatId !== id)
  return filtered.length === chats.length ? chats : filtered
}

/**
 * Prepend a chat to the front, deduplicating by id.
 * Used for the "new chat created" flow where the chat should appear first.
 */
export function promoteToFront(chats: ChatRecord[], record: ChatRecord): ChatRecord[] {
  const without = chats.filter((c) => c.appChatId !== record.appChatId)
  return [record, ...without].sort((a, b) => b.updatedAt - a.updatedAt)
}
