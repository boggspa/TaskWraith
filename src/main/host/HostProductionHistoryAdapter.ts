/**
 * Bounded, redacted production transcript-history adapter.
 *
 * No live canonical transcript delta journal is injected in this tranche, so
 * `historySince` always requires a full resnapshot rather than fabricating
 * append/replace events from the Host projection cursor.
 */

import type {
  HostHistorySinceRequest,
  HostHistorySinceResult,
  HostThreadHistoryPage,
  HostThreadHistoryRequest,
  HostTranscriptHistoryEntry
} from '../../shared/hostHistoryProtocol'

export interface HostProductionHistoryMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system' | 'tool' | 'error'
  readonly content: string
  readonly timestamp: string
}

export interface HostProductionHistoryChat {
  readonly appChatId: string
  readonly messages?: readonly HostProductionHistoryMessage[]
}

export interface HostProductionHistoryAdapterOptions {
  readonly getChat: (threadId: string) => HostProductionHistoryChat | null | undefined
  readonly getPosition: () => { readonly generation: number; readonly cursor: number }
}

export interface HostProductionHistoryAdapter {
  threadHistory(request: HostThreadHistoryRequest): HostThreadHistoryPage
  historySince(request: HostHistorySinceRequest): HostHistorySinceResult
}

function safeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- Host metadata must not carry controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function safeText(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16_000) return false
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue
    if (code <= 0x1f || code === 0x7f) return false
  }
  return true
}

function timestamp(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function entry(message: HostProductionHistoryMessage): HostTranscriptHistoryEntry | null {
  // Tool records can contain raw provider/action payloads. Exclude rather than
  // trying to redact schemas that are intentionally not part of Host v2.
  if (message.role === 'tool' || !safeId(message.id) || !safeText(message.content)) return null
  const role = message.role === 'error' ? 'system' : message.role
  return {
    entryId: message.id,
    role,
    createdAt: timestamp(message.timestamp),
    text: message.content
  }
}

function position(options: HostProductionHistoryAdapterOptions): {
  generation: number
  cursor: number
} {
  const current = options.getPosition()
  if (
    !current ||
    !Number.isSafeInteger(current.generation) ||
    current.generation < 0 ||
    !Number.isSafeInteger(current.cursor) ||
    current.cursor < 0
  ) {
    throw new Error('Host history position is unavailable')
  }
  return { generation: current.generation, cursor: current.cursor }
}

export function createHostProductionHistoryAdapter(
  options: HostProductionHistoryAdapterOptions
): HostProductionHistoryAdapter {
  if (
    !options ||
    typeof options.getChat !== 'function' ||
    typeof options.getPosition !== 'function'
  ) {
    throw new Error('HostProductionHistoryAdapter requires getChat and getPosition ports')
  }
  const requireChat = (threadId: string): HostProductionHistoryChat => {
    const chat = options.getChat(threadId)
    if (!chat || chat.appChatId !== threadId) throw new Error('Host history chat is unavailable')
    return chat
  }

  return {
    threadHistory(request) {
      const chat = requireChat(request.threadId)
      const currentPosition = position(options)
      const projected = (chat.messages ?? [])
        .map(entry)
        .filter((candidate): candidate is HostTranscriptHistoryEntry => candidate !== null)
      const end = request.before === undefined ? projected.length : request.before.cursor
      if (
        (request.before !== undefined &&
          request.before.generation !== currentPosition.generation) ||
        end < 0 ||
        end > projected.length
      ) {
        throw new Error('Host history cursor is unavailable')
      }
      const start = Math.max(0, end - request.limit)
      return {
        threadId: request.threadId,
        generation: currentPosition.generation,
        // History paging is intentionally independent from the Host domain
        // delta cursor; it is the count of the redacted projected sequence.
        cursor: projected.length,
        entries: projected.slice(start, end),
        ...(start > 0
          ? { nextBefore: { generation: currentPosition.generation, cursor: start } }
          : {})
      }
    },
    historySince(request) {
      const chat = requireChat(request.threadId)
      const current = position(options)
      const cursor = (chat.messages ?? []).reduce(
        (count, message) => (entry(message) === null ? count : count + 1),
        0
      )
      return {
        kind: 'full_resnapshot_required',
        threadId: request.threadId,
        generation: current.generation,
        cursor,
        clientGeneration: request.since.generation,
        clientCursor: request.since.cursor,
        reason:
          request.since.generation !== current.generation
            ? 'generation_mismatch'
            : request.since.cursor !== cursor
              ? 'cursor_mismatch'
              : 'retention_gap'
      }
    }
  }
}
