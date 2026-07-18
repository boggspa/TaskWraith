import type { ChatMessage, ChatRecord } from '../main/store/types'

export const CHAT_UPDATE_CHANNEL = 'chat-updated'
export const CHAT_UPDATE_ACK_CHANNEL = 'chat-updated:ack'
export const CHAT_UPDATE_PROTOCOL_VERSION = 1 as const

export type ChatUpdateRecord = Omit<ChatRecord, 'messages'>

export interface ChatUpdateMessageSplice {
  start: number
  deleteCount: number
  items: ChatMessage[]
}

export interface ChatUpdateSnapshotDelivery {
  protocolVersion: typeof CHAT_UPDATE_PROTOCOL_VERSION
  kind: 'snapshot'
  deliveryId: string
  chatId: string
  revision: number
  chat: ChatRecord
}

export interface ChatUpdatePatchDelivery {
  protocolVersion: typeof CHAT_UPDATE_PROTOCOL_VERSION
  kind: 'patch'
  deliveryId: string
  chatId: string
  baseRevision: number
  revision: number
  record: ChatUpdateRecord
  messages: ChatUpdateMessageSplice
}

export type ChatUpdateDelivery = ChatUpdateSnapshotDelivery | ChatUpdatePatchDelivery

export interface ChatUpdateAck {
  deliveryId: string
  applied: boolean
}

export interface ChatUpdateBaseline {
  revision: number
  chat: ChatRecord
}

export type ApplyChatUpdateResult =
  | { ok: true; baseline: ChatUpdateBaseline }
  | { ok: false; reason: string }

/**
 * Strict structural equality for the persisted plain-data message shape.
 * False negatives only make a patch larger; false positives would corrupt the
 * reconstructed chat, so every structural difference returns false.
 */
function plainDataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    return false
  }
  const aArray = Array.isArray(a)
  const bArray = Array.isArray(b)
  if (aArray || bArray) {
    if (!aArray || !bArray || a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!plainDataEqual(a[index], b[index])) return false
    }
    return true
  }
  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false
    if (!plainDataEqual(aRecord[key], bRecord[key])) return false
  }
  return true
}

export function buildChatUpdateMessageSplice(
  previous: readonly ChatMessage[],
  next: readonly ChatMessage[]
): ChatUpdateMessageSplice {
  const sharedLimit = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < sharedLimit && plainDataEqual(previous[prefix], next[prefix])) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < sharedLimit - prefix &&
    plainDataEqual(previous[previous.length - 1 - suffix], next[next.length - 1 - suffix])
  ) {
    suffix += 1
  }

  return {
    start: prefix,
    deleteCount: previous.length - prefix - suffix,
    items: next.slice(prefix, next.length - suffix)
  }
}

function chatRecordWithoutMessages(chat: ChatRecord): ChatUpdateRecord {
  const { messages: _messages, ...record } = chat
  return record
}

export function buildChatUpdateDelivery(input: {
  deliveryId: string
  revision: number
  chat: ChatRecord
  baseline?: ChatUpdateBaseline
  /** Fall back to a snapshot when a splice replaces this fraction of the list. */
  snapshotReplacementRatio?: number
}): ChatUpdateDelivery {
  const { baseline, chat, deliveryId, revision } = input
  if (!baseline || baseline.chat.appChatId !== chat.appChatId) {
    return {
      protocolVersion: CHAT_UPDATE_PROTOCOL_VERSION,
      kind: 'snapshot',
      deliveryId,
      chatId: chat.appChatId,
      revision,
      chat
    }
  }

  const messages = buildChatUpdateMessageSplice(baseline.chat.messages, chat.messages)
  const replacedRows = messages.deleteCount + messages.items.length
  const ratio = Math.min(1, Math.max(0.1, input.snapshotReplacementRatio ?? 0.72))
  const replacementLimit = Math.max(48, Math.ceil(chat.messages.length * ratio))
  if (replacedRows > replacementLimit) {
    return {
      protocolVersion: CHAT_UPDATE_PROTOCOL_VERSION,
      kind: 'snapshot',
      deliveryId,
      chatId: chat.appChatId,
      revision,
      chat
    }
  }

  return {
    protocolVersion: CHAT_UPDATE_PROTOCOL_VERSION,
    kind: 'patch',
    deliveryId,
    chatId: chat.appChatId,
    baseRevision: baseline.revision,
    revision,
    record: chatRecordWithoutMessages(chat),
    messages
  }
}

export function applyChatUpdateDelivery(
  delivery: ChatUpdateDelivery,
  baseline?: ChatUpdateBaseline
): ApplyChatUpdateResult {
  if (delivery.kind === 'snapshot') {
    if (delivery.chat.appChatId !== delivery.chatId) {
      return { ok: false, reason: 'Snapshot chat id does not match its envelope.' }
    }
    return {
      ok: true,
      baseline: { revision: delivery.revision, chat: delivery.chat }
    }
  }

  if (!baseline) return { ok: false, reason: 'Patch has no renderer baseline.' }
  if (baseline.revision !== delivery.baseRevision) {
    return { ok: false, reason: 'Patch base revision is stale.' }
  }
  if (
    baseline.chat.appChatId !== delivery.chatId ||
    delivery.record.appChatId !== delivery.chatId
  ) {
    return { ok: false, reason: 'Patch chat id does not match its baseline.' }
  }

  const { start, deleteCount, items } = delivery.messages
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(deleteCount) ||
    start < 0 ||
    deleteCount < 0 ||
    start > baseline.chat.messages.length ||
    start + deleteCount > baseline.chat.messages.length ||
    !Array.isArray(items)
  ) {
    return { ok: false, reason: 'Patch message splice is invalid.' }
  }

  const messages = [
    ...baseline.chat.messages.slice(0, start),
    ...items,
    ...baseline.chat.messages.slice(start + deleteCount)
  ]
  return {
    ok: true,
    baseline: {
      revision: delivery.revision,
      chat: { ...delivery.record, messages }
    }
  }
}

export function isChatUpdateDelivery(value: unknown): value is ChatUpdateDelivery {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ChatUpdateDelivery>
  return (
    candidate.protocolVersion === CHAT_UPDATE_PROTOCOL_VERSION &&
    (candidate.kind === 'snapshot' || candidate.kind === 'patch') &&
    typeof candidate.deliveryId === 'string' &&
    candidate.deliveryId.length > 0 &&
    typeof candidate.chatId === 'string' &&
    candidate.chatId.length > 0 &&
    Number.isSafeInteger(candidate.revision)
  )
}

export function normalizeChatUpdateAck(value: unknown): ChatUpdateAck | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ChatUpdateAck>
  if (
    typeof candidate.deliveryId !== 'string' ||
    candidate.deliveryId.length === 0 ||
    candidate.deliveryId.length > 160 ||
    typeof candidate.applied !== 'boolean'
  ) {
    return null
  }
  return { deliveryId: candidate.deliveryId, applied: candidate.applied }
}
