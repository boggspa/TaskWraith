import type { ChatListItem } from '../main/store/types'

/** Renderer-to-main replacement snapshot for chat live-update interest. */
export const CHAT_UPDATE_INTEREST_CHANNEL = 'chat-update-interest'
/** Main-to-renderer signal used when a paged chat must pull a fresh tail page. */
export const CHAT_UPDATE_INVALIDATION_CHANNEL = 'chat-update-invalidated'

export const CHAT_UPDATE_INTEREST_PROTOCOL_VERSION = 1 as const
export const MAX_CHAT_UPDATE_INTEREST_ENTRIES = 128
export const MAX_CHAT_UPDATE_INTEREST_CHAT_ID_LENGTH = 512

/**
 * Bounds parser work as well as retained state. A corrupt renderer payload may
 * be arbitrarily large; inspecting the whole array just to throw most of it
 * away would move that denial-of-service cost onto Electron main.
 */
const MAX_INPUT_ENTRIES_MULTIPLIER = 4

export type ChatUpdateInterestMode = 'full' | 'paged'

export interface ChatUpdateInterestEntry {
  chatId: string
  mode: ChatUpdateInterestMode
}

/**
 * A complete replacement, not a delta. Removing an entry therefore removes
 * that renderer document's interest in the chat.
 */
export interface ChatUpdateInterestSnapshot {
  protocolVersion: typeof CHAT_UPDATE_INTEREST_PROTOCOL_VERSION
  entries: ChatUpdateInterestEntry[]
}

/**
 * Paged surfaces do not receive a ChatRecord. The lean list projection keeps
 * sidebar/run chrome current while the renderer pulls one bounded tail page.
 */
export interface ChatUpdateInvalidation {
  protocolVersion: typeof CHAT_UPDATE_INTEREST_PROTOCOL_VERSION
  kind: 'invalidation'
  chatId: string
  revision: number
  summary: ChatListItem
}

function boundedEntryLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MAX_CHAT_UPDATE_INTEREST_ENTRIES
  }
  return Math.min(MAX_CHAT_UPDATE_INTEREST_ENTRIES, Math.max(0, Math.floor(value)))
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function normalizeChatUpdateInterestChatId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_CHAT_UPDATE_INTEREST_CHAT_ID_LENGTH ||
    hasAsciiControlCharacter(value)
  ) {
    return null
  }
  const chatId = value.trim()
  if (chatId.length === 0 || chatId.length > MAX_CHAT_UPDATE_INTEREST_CHAT_ID_LENGTH) {
    return null
  }
  return chatId
}

function normalizeMode(value: unknown): ChatUpdateInterestMode | null {
  return value === 'full' || value === 'paged' ? value : null
}

function snapshotEntries(value: unknown): unknown[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as { protocolVersion?: unknown; entries?: unknown }
  if (
    candidate.protocolVersion !== CHAT_UPDATE_INTEREST_PROTOCOL_VERSION ||
    !Array.isArray(candidate.entries)
  ) {
    return null
  }
  return candidate.entries
}

/**
 * Parse an untrusted renderer handshake into a bounded replacement snapshot.
 * Duplicate entries are coalesced by chat id. `full` dominates `paged`: one
 * document can host more than one surface, and a paged copy must never
 * downgrade another copy that still needs ordinary full-record delivery.
 */
export function normalizeChatUpdateInterestSnapshot(
  value: unknown,
  maxEntries?: number
): ChatUpdateInterestSnapshot | null {
  const source = snapshotEntries(value)
  if (!source) return null
  const limit = boundedEntryLimit(maxEntries)
  if (limit === 0) {
    return { protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries: [] }
  }

  const byChatId = new Map<string, ChatUpdateInterestMode>()
  const inspectionLimit = Math.min(source.length, limit * MAX_INPUT_ENTRIES_MULTIPLIER)
  for (let index = 0; index < inspectionLimit; index += 1) {
    const candidate = source[index]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as { chatId?: unknown; mode?: unknown }
    const chatId = normalizeChatUpdateInterestChatId(record.chatId)
    const mode = normalizeMode(record.mode)
    if (!chatId || !mode) continue

    const existing = byChatId.get(chatId)
    if (existing) {
      if (mode === 'full') byChatId.set(chatId, 'full')
      continue
    }
    if (byChatId.size < limit) byChatId.set(chatId, mode)
  }

  return {
    protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
    entries: [...byChatId].map(([chatId, mode]) => ({ chatId, mode }))
  }
}

export function createChatUpdateInterestSnapshot(
  entries: readonly ChatUpdateInterestEntry[],
  maxEntries?: number
): ChatUpdateInterestSnapshot {
  return (
    normalizeChatUpdateInterestSnapshot(
      { protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries },
      maxEntries
    ) ?? { protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries: [] }
  )
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Structural fence against accidentally putting a full transcript on this channel. */
export function isCompactChatListItem(value: unknown): value is ChatListItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<ChatListItem>
  return (
    item.summaryOnly === true &&
    normalizeChatUpdateInterestChatId(item.appChatId) === item.appChatId &&
    Array.isArray(item.messages) &&
    item.messages.length === 0 &&
    Array.isArray(item.runs) &&
    item.runs.length === 0
  )
}

/**
 * Build the compact signal for a paged subscriber. Returning null is
 * deliberate: a projection bug must drop one invalidation rather than clone a
 * complete transcript onto the very channel intended to avoid that clone.
 */
export function buildChatUpdateInvalidation(summary: ChatListItem): ChatUpdateInvalidation | null {
  if (!isCompactChatListItem(summary)) return null
  const revision =
    nonNegativeSafeInteger(summary.persistenceRevision) ??
    nonNegativeSafeInteger(summary.updatedAt) ??
    0
  return {
    protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
    kind: 'invalidation',
    chatId: summary.appChatId,
    revision,
    summary
  }
}

/** Lightweight renderer-side validation for the untrusted IPC payload. */
export function normalizeChatUpdateInvalidation(value: unknown): ChatUpdateInvalidation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<ChatUpdateInvalidation>
  const chatId = normalizeChatUpdateInterestChatId(candidate.chatId)
  if (
    candidate.protocolVersion !== CHAT_UPDATE_INTEREST_PROTOCOL_VERSION ||
    candidate.kind !== 'invalidation' ||
    !chatId ||
    candidate.chatId !== chatId ||
    !isCompactChatListItem(candidate.summary) ||
    candidate.summary.appChatId !== chatId ||
    nonNegativeSafeInteger(candidate.revision) === null
  ) {
    return null
  }
  return candidate as ChatUpdateInvalidation
}
