import type { ChatMessage, ChatRecord } from '../main/store/types'

/**
 * Stage 1a — explicit transcript page contract shared by main and renderer.
 *
 * `ChatRecord.messages` remains the complete canonical transcript. A
 * `TranscriptPage` is a read-only projection: a count-and-byte-bounded window
 * over that canonical array with stable message/sequence cursors. Pages are
 * produced by main (`get-chat-transcript-page`) and by the renderer's
 * presentation store, and both must agree on the byte estimator so windows
 * match. That estimator is the jsonish full walk below — NOT the cheap
 * `64 + content.length` transport estimator in `chatUpdateTransport.ts`,
 * which exists for streaming-envelope budgets and would pack tool-heavy
 * Ensemble rows differently.
 *
 * A page is not a `ChatRecord` and must never reach `saveChat`; the main-side
 * runtime guard (`assertAuthoritativeChatForSave`) is the structural fence on
 * both persistence paths because type branding does not survive IPC.
 */

export const DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES = 1_500
export const DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES = 24 * 1024 * 1024

/** Full-walk byte estimate shared by renderer windows and main-produced pages. */
export function estimateJsonishBytes(value: unknown): number {
  if (value == null) return 0
  if (typeof value === 'string') return value.length * 2
  if (typeof value === 'number' || typeof value === 'boolean') return 8
  if (Array.isArray(value)) {
    let total = 16
    for (const entry of value) total += estimateJsonishBytes(entry)
    return total
  }
  if (typeof value === 'object') {
    let total = 16
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      total += key.length * 2 + estimateJsonishBytes(entry)
    }
    return total
  }
  return 0
}

export interface TranscriptPageRange {
  start: number
  end: number
  estimatedBytes: number
}

export interface TranscriptPageLimits {
  maxMessagesPerPage?: number
  maxBytesPerPage?: number
}

/**
 * Page request for `get-chat-transcript-page`. With no cursor the tail page
 * is returned. `aroundMessageId` anchors a page that includes the target,
 * biased older first, then extended newer with whatever budget remains.
 */
export interface TranscriptPageRequest {
  chatId: string
  beforeMessageId?: string
  afterMessageId?: string
  aroundMessageId?: string
  maxMessages?: number
  maxBytes?: number
}

/**
 * One bounded window over the canonical transcript. `windowStart`/`windowEnd`
 * are sequence indices into the complete message array ([start, end)); the
 * message-id cursors are the durable cross-session form of the same boundary.
 */
export interface TranscriptPage {
  chatId: string
  messages: ChatMessage[]
  totalMessageCount: number
  windowStart: number
  windowEnd: number
  estimatedBytes: number
  hasOlder: boolean
  hasNewer: boolean
  oldestMessageId: string | null
  newestMessageId: string | null
  updatedAt: number
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.max(1, Math.floor(value))
}

function resolveLimits(limits: TranscriptPageLimits | undefined): {
  maxMessages: number
  maxBytes: number
} {
  return {
    maxMessages: positiveInteger(limits?.maxMessagesPerPage, DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES),
    maxBytes: positiveInteger(limits?.maxBytesPerPage, DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES)
  }
}

export function selectTranscriptPageEndingAt(
  messages: readonly ChatMessage[],
  endExclusive: number,
  options?: TranscriptPageLimits
): TranscriptPageRange {
  const { maxMessages, maxBytes } = resolveLimits(options)
  const end = Math.max(0, Math.min(messages.length, Math.floor(endExclusive)))
  let start = end
  let estimatedBytes = 0
  while (start > 0 && end - start < maxMessages) {
    const nextBytes = Math.max(0, estimateJsonishBytes(messages[start - 1]))
    if (start < end && estimatedBytes + nextBytes > maxBytes) break
    start -= 1
    estimatedBytes += nextBytes
  }
  return { start, end, estimatedBytes }
}

export function selectTranscriptPageStartingAt(
  messages: readonly ChatMessage[],
  startInclusive: number,
  options?: TranscriptPageLimits
): TranscriptPageRange {
  const { maxMessages, maxBytes } = resolveLimits(options)
  const start = Math.max(0, Math.min(messages.length, Math.floor(startInclusive)))
  let end = start
  let estimatedBytes = 0
  while (end < messages.length && end - start < maxMessages) {
    const nextBytes = Math.max(0, estimateJsonishBytes(messages[end]))
    if (end > start && estimatedBytes + nextBytes > maxBytes) break
    end += 1
    estimatedBytes += nextBytes
  }
  return { start, end, estimatedBytes }
}

function messageIndexById(messages: readonly ChatMessage[], messageId: string): number {
  return messages.findIndex((message) => message?.id === messageId)
}

/**
 * Build one bounded page over the canonical message array. Returns null when
 * a requested anchor message id is absent (the renderer then falls back to
 * the tail). The input array is never mutated and never sliced unless the
 * page is a proper window.
 */
export function buildTranscriptPage(
  chat: Pick<ChatRecord, 'appChatId' | 'messages' | 'updatedAt'>,
  request: TranscriptPageRequest
): TranscriptPage | null {
  const messages = Array.isArray(chat.messages) ? chat.messages : []
  const maxMessages = positiveInteger(request.maxMessages, DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES)
  const maxBytes = positiveInteger(request.maxBytes, DEFAULT_TRANSCRIPT_PAGE_MAX_BYTES)
  const limits: TranscriptPageLimits = {
    maxMessagesPerPage: maxMessages,
    maxBytesPerPage: maxBytes
  }

  let range: TranscriptPageRange
  if (typeof request.aroundMessageId === 'string' && request.aroundMessageId.length > 0) {
    const index = messageIndexById(messages, request.aroundMessageId)
    if (index < 0) return null
    // Anchor the target at the page bottom within budget, then spend any
    // remaining count/byte budget on newer context.
    const older = selectTranscriptPageEndingAt(messages, index + 1, limits)
    range = older
    const remainingMessages = maxMessages - (older.end - older.start)
    const remainingBytes = maxBytes - older.estimatedBytes
    if (older.end < messages.length && remainingMessages >= 1 && remainingBytes > 0) {
      const newer = selectTranscriptPageStartingAt(messages, older.end, {
        maxMessagesPerPage: remainingMessages,
        maxBytesPerPage: remainingBytes
      })
      range = {
        start: older.start,
        end: newer.end,
        estimatedBytes: older.estimatedBytes + newer.estimatedBytes
      }
    }
  } else if (typeof request.beforeMessageId === 'string' && request.beforeMessageId.length > 0) {
    const index = messageIndexById(messages, request.beforeMessageId)
    if (index < 0) return null
    range = selectTranscriptPageEndingAt(messages, index, limits)
  } else if (typeof request.afterMessageId === 'string' && request.afterMessageId.length > 0) {
    const index = messageIndexById(messages, request.afterMessageId)
    if (index < 0) return null
    range = selectTranscriptPageStartingAt(messages, index + 1, limits)
  } else {
    range = selectTranscriptPageEndingAt(messages, messages.length, limits)
  }

  const pageMessages =
    range.start === 0 && range.end === messages.length
      ? messages
      : messages.slice(range.start, range.end)
  return {
    chatId: chat.appChatId,
    messages: pageMessages,
    totalMessageCount: messages.length,
    windowStart: range.start,
    windowEnd: range.end,
    estimatedBytes: range.estimatedBytes,
    hasOlder: range.start > 0,
    hasNewer: range.end < messages.length,
    oldestMessageId: pageMessages[0]?.id ?? null,
    newestMessageId: pageMessages[pageMessages.length - 1]?.id ?? null,
    updatedAt: chat.updatedAt ?? 0
  }
}
