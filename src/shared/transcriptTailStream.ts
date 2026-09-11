import type { ChatMessage } from '../main/store/types'
import { estimateJsonishBytes } from './transcriptPage'

/**
 * Main-to-renderer push lane for transcript rows that were JUST appended.
 *
 * This exists because the paged transcript lane is a PULL: main sends a compact
 * `chat-update-invalidated` signal and the renderer answers it by invoking
 * `get-chat-transcript-page`, which is served synchronously on the main thread
 * behind orchestration and persistence. Measured 2026-09-11 on a 1,493-message
 * thread, that round trip left the transcript 32s and then 44s behind a live
 * ensemble round while the delivery coordinator itself reported zero backlog —
 * a frozen transcript with perfectly healthy transport counters.
 *
 * The fix is not a faster pull. It is to stop making the visible transcript
 * depend on a request/response with the busiest thread in the app. Main already
 * knows exactly which rows it appended, so it pushes those rows and nothing
 * else: O(new rows), unacked, fire-and-forget, on the same shape as
 * `participant-working-telemetry` — the one lane that demonstrably never
 * stalled during that incident.
 *
 * This lane is deliberately NOT authoritative. It is a visibility accelerator
 * in front of the canonical `chat-updated` / invalidation lanes, which continue
 * unchanged and remain the reconciliation path. A renderer that misses,
 * rejects, or cannot apply a frame loses nothing durable — the pull lane still
 * converges it. What the frames buy is the bound: see `sequence`.
 */
export const TRANSCRIPT_TAIL_CHANNEL = 'transcript-tail-appended'

export const TRANSCRIPT_TAIL_PROTOCOL_VERSION = 1 as const

/**
 * Renderer-to-main receipt: "these rows are in the window the user sees."
 *
 * TELEMETRY ONLY. Nothing on the producer's send path reads it, and no frame
 * waits for one. That separation is the whole difference between this lane and
 * `chat-updated`, whose ACK does gate delivery and whose gating is how a busy
 * renderer used to withhold every subsequent frame from itself.
 */
export const TRANSCRIPT_TAIL_RECEIPT_CHANNEL = 'transcript-tail-appended:receipt'

/**
 * Per-frame row cap. A frame is a latency device, not a bulk loader: beyond
 * this the pull lane is both cheaper and already correct, so the producer sends
 * a `resync` marker instead. Chosen well above a round's per-turn row count
 * (the 2026-09-11 round emitted 13 rows end to end) and well below a page.
 */
export const MAX_TRANSCRIPT_TAIL_ROWS = 32

/**
 * Per-frame byte cap, measured with the same jsonish estimator the paging
 * window uses so producer and consumer agree. A single row carrying a large
 * tool payload or an embedded image must degrade to a resync rather than put a
 * multi-megabyte structured clone on the low-latency lane.
 */
export const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024

const MAX_TRANSCRIPT_TAIL_CHAT_ID_LENGTH = 512

/**
 * Rows appended to a chat's canonical transcript, pushed as they were appended.
 *
 * `baseMessageCount` is the canonical `messages.length` BEFORE these rows, so a
 * consumer can prove contiguity against its own window without trusting ids
 * alone, and can decline to apply a frame that does not abut what it holds.
 */
export interface TranscriptTailAppend {
  protocolVersion: typeof TRANSCRIPT_TAIL_PROTOCOL_VERSION
  kind: 'tail-append'
  chatId: string
  sequence: number
  baseMessageCount: number
  messages: ChatMessage[]
  appendedAtMs: number
}

/**
 * "Something changed that this lane will not carry — the pull lane owns it."
 *
 * Emitted when rows exceeded a cap, when the producer cannot identify which
 * rows are new, or when the transcript was mutated in place rather than
 * appended to. It carries a sequence deliberately: without it, a skipped frame
 * is indistinguishable from a stalled producer, and the staleness watchdog
 * (which exists precisely so a freeze can never again be silent) would report a
 * permanent phantom lag. A resync says "you are not behind me; go pull".
 */
export interface TranscriptTailResync {
  protocolVersion: typeof TRANSCRIPT_TAIL_PROTOCOL_VERSION
  kind: 'tail-resync'
  chatId: string
  sequence: number
  messageCount: number
  appendedAtMs: number
}

export type TranscriptTailFrame = TranscriptTailAppend | TranscriptTailResync

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function normalizeTranscriptTailChatId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TRANSCRIPT_TAIL_CHAT_ID_LENGTH ||
    hasAsciiControlCharacter(value)
  ) {
    return null
  }
  const chatId = value.trim()
  if (chatId.length === 0 || chatId.length > MAX_TRANSCRIPT_TAIL_CHAT_ID_LENGTH) return null
  return chatId
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Rows carried on this lane must be identifiable, because the consumer dedupes
 * against the reconcile lane by message id. A blank or duplicate id inside one
 * frame would let the same row land twice, so such a frame is refused at the
 * boundary and degraded to a resync by the producer.
 */
export function transcriptTailRowsAreAddressable(messages: readonly ChatMessage[]): boolean {
  const seen = new Set<string>()
  for (const message of messages) {
    const id = message?.id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return false
    seen.add(id)
  }
  return true
}

/**
 * Whether these rows exceed a byte budget, WITHOUT costing a full walk to say
 * so.
 *
 * This replaced a plain `estimateJsonishBytes(messages)`: the exact total was
 * never wanted, only the comparison.
 *
 * `estimateJsonishBytes` has no running-total exit: it walks the entire object
 * graph to produce a number only ever compared against a ceiling. Measured, a
 * node-heavy tool payload costs 7.5 ms at 10k nodes, 62 ms at 100k and 181 ms
 * at 400k — paid on the main thread, before persistence, purely to conclude
 * "too big, send a resync". The ADR's whole-loop gate is p95 < 25 ms.
 *
 * It also sees rows at their LARGEST: the emit happens before
 * `prepareChatForPersistence` externalises tool detail and thumbnails inline
 * images, so the fat shapes are exactly the ones that reach here.
 *
 * Per-row so one oversized row stops the walk immediately rather than after
 * its siblings have been measured.
 */
export function transcriptTailBytesExceed(
  messages: readonly ChatMessage[],
  limitBytes: number
): boolean {
  let total = 0
  for (const message of messages) {
    total += estimateJsonishBytes(message)
    if (total > limitBytes) return true
  }
  return false
}

export interface BuildTranscriptTailAppendInput {
  chatId: string
  sequence: number
  baseMessageCount: number
  messages: readonly ChatMessage[]
  appendedAtMs: number
  maxRows?: number
  maxBytes?: number
}

/**
 * Returns null when the append is not eligible for the low-latency lane, which
 * is the producer's signal to emit a resync. Null is never an error path: the
 * canonical lanes carry the same rows regardless.
 */
export function buildTranscriptTailAppend(
  input: BuildTranscriptTailAppendInput
): TranscriptTailAppend | null {
  const chatId = normalizeTranscriptTailChatId(input.chatId)
  const sequence = positiveSafeInteger(input.sequence)
  const baseMessageCount = nonNegativeSafeInteger(input.baseMessageCount)
  const appendedAtMs = nonNegativeSafeInteger(input.appendedAtMs)
  if (chatId === null || sequence === null || baseMessageCount === null || appendedAtMs === null) {
    return null
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) return null

  const maxRows = Math.min(
    MAX_TRANSCRIPT_TAIL_ROWS,
    Math.max(1, input.maxRows ?? Number.MAX_SAFE_INTEGER)
  )
  const maxBytes = Math.min(
    MAX_TRANSCRIPT_TAIL_BYTES,
    Math.max(1, input.maxBytes ?? Number.MAX_SAFE_INTEGER)
  )
  if (input.messages.length > maxRows) return null
  if (!transcriptTailRowsAreAddressable(input.messages)) return null
  if (transcriptTailBytesExceed(input.messages, maxBytes)) return null

  return {
    protocolVersion: TRANSCRIPT_TAIL_PROTOCOL_VERSION,
    kind: 'tail-append',
    chatId,
    sequence,
    baseMessageCount,
    messages: [...input.messages],
    appendedAtMs
  }
}

export function buildTranscriptTailResync(input: {
  chatId: string
  sequence: number
  messageCount: number
  appendedAtMs: number
}): TranscriptTailResync | null {
  const chatId = normalizeTranscriptTailChatId(input.chatId)
  const sequence = positiveSafeInteger(input.sequence)
  const messageCount = nonNegativeSafeInteger(input.messageCount)
  const appendedAtMs = nonNegativeSafeInteger(input.appendedAtMs)
  if (chatId === null || sequence === null || messageCount === null || appendedAtMs === null) {
    return null
  }
  return {
    protocolVersion: TRANSCRIPT_TAIL_PROTOCOL_VERSION,
    kind: 'tail-resync',
    chatId,
    sequence,
    messageCount,
    appendedAtMs
  }
}

/**
 * Renderer-side validation. Main authors these frames, but the renderer applies
 * them straight into the visible transcript window, so the boundary is checked
 * the same way every other IPC payload is rather than on the strength of who
 * sent it.
 */
export function normalizeTranscriptTailFrame(value: unknown): TranscriptTailFrame | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<TranscriptTailFrame>
  if (candidate.protocolVersion !== TRANSCRIPT_TAIL_PROTOCOL_VERSION) return null

  const chatId = normalizeTranscriptTailChatId(candidate.chatId)
  if (chatId === null || candidate.chatId !== chatId) return null
  if (positiveSafeInteger(candidate.sequence) === null) return null
  if (nonNegativeSafeInteger(candidate.appendedAtMs) === null) return null

  if (candidate.kind === 'tail-resync') {
    if (nonNegativeSafeInteger((candidate as TranscriptTailResync).messageCount) === null) {
      return null
    }
    return candidate as TranscriptTailResync
  }

  if (candidate.kind !== 'tail-append') return null
  const append = candidate as TranscriptTailAppend
  if (nonNegativeSafeInteger(append.baseMessageCount) === null) return null
  if (
    !Array.isArray(append.messages) ||
    append.messages.length === 0 ||
    append.messages.length > MAX_TRANSCRIPT_TAIL_ROWS ||
    !transcriptTailRowsAreAddressable(append.messages) ||
    // The producer caps bytes; without the same cap here the boundary trusted
    // the sender, which is exactly what this function exists not to do. Bounded
    // and early-exiting, so an oversized frame is rejected without being walked.
    transcriptTailBytesExceed(append.messages, MAX_TRANSCRIPT_TAIL_BYTES)
  ) {
    return null
  }
  return append
}

export interface TranscriptTailReceipt {
  protocolVersion: typeof TRANSCRIPT_TAIL_PROTOCOL_VERSION
  chatId: string
  sequence: number
}

export function buildTranscriptTailReceipt(
  chatId: string,
  sequence: number
): TranscriptTailReceipt | null {
  const id = normalizeTranscriptTailChatId(chatId)
  if (id === null || !Number.isSafeInteger(sequence) || sequence <= 0) return null
  return { protocolVersion: TRANSCRIPT_TAIL_PROTOCOL_VERSION, chatId: id, sequence }
}

/** Main-side validation of an untrusted renderer receipt. */
export function normalizeTranscriptTailReceipt(value: unknown): TranscriptTailReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<TranscriptTailReceipt>
  if (candidate.protocolVersion !== TRANSCRIPT_TAIL_PROTOCOL_VERSION) return null
  const chatId = normalizeTranscriptTailChatId(candidate.chatId)
  const sequence = positiveSafeInteger(candidate.sequence)
  if (chatId === null || candidate.chatId !== chatId || sequence === null) return null
  return { protocolVersion: TRANSCRIPT_TAIL_PROTOCOL_VERSION, chatId, sequence }
}
