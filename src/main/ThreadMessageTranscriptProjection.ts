/**
 * Durable, presentation-only transcript rows for peer thread messages.
 *
 * The thread-message ledger remains the authority for pending/exactly-once
 * provider delivery. These rows exist only so the user can see the exchange in
 * ordinary transcript history. They deliberately ride on `role: 'tool'` and
 * carry `providerContextVisibility: 'projection-only'`: peer output is
 * untrusted content, never a system/user instruction and never a second path
 * into provider context.
 */

import { THREAD_MESSAGE_TRANSCRIPT_KIND, type ThreadMessageEvent } from '../shared/threadMessage'
import type { ChatMessage, ChatRecord } from './store/types'

const THREAD_MESSAGE_TRANSCRIPT_ID_PREFIX = 'thread-message-'

function projectionEventId(message: ChatMessage): string {
  if (!isThreadMessageTranscriptProjection(message)) return ''
  const value = message.metadata?.threadMessageId
  return typeof value === 'string' ? value.trim() : ''
}

function eventTimestamp(event: ThreadMessageEvent): string {
  const createdAt = Number.isFinite(event.createdAt) && event.createdAt >= 0 ? event.createdAt : 0
  return new Date(createdAt).toISOString()
}

export function isThreadMessageTranscriptProjection(message: ChatMessage): boolean {
  return (
    message.role === 'tool' &&
    message.metadata?.kind === THREAD_MESSAGE_TRANSCRIPT_KIND &&
    message.metadata?.providerContextVisibility === 'projection-only'
  )
}

export function buildThreadMessageTranscriptProjection(event: ThreadMessageEvent): ChatMessage {
  return {
    id: `${THREAD_MESSAGE_TRANSCRIPT_ID_PREFIX}${event.id}`,
    role: 'tool',
    content: event.body,
    timestamp: eventTimestamp(event),
    metadata: {
      kind: THREAD_MESSAGE_TRANSCRIPT_KIND,
      providerContextVisibility: 'projection-only',
      threadMessageId: event.id,
      threadMessageFromChatId: event.fromChatId,
      threadMessageFromChatTitle: event.fromChatTitle,
      threadMessageOrigin: event.origin,
      threadMessageRequestedDelivery: event.requestedDelivery,
      threadMessageTrust: event.trust,
      threadMessageCreatedAt: event.createdAt,
      threadMessageTruncated: event.truncated === true
    }
  }
}

export function appendThreadMessageTranscriptProjection(
  chat: ChatRecord,
  event: ThreadMessageEvent
): { chat: ChatRecord; inserted: boolean } {
  const projection = buildThreadMessageTranscriptProjection(event)
  const exists = (chat.messages || []).some(
    (message) =>
      projectionEventId(message) === event.id ||
      (isThreadMessageTranscriptProjection(message) && message.id === projection.id)
  )
  if (exists) return { chat, inserted: false }
  return {
    chat: { ...chat, messages: [...(chat.messages || []), projection] },
    inserted: true
  }
}

function messageTime(message: ChatMessage): number {
  const parsed = Date.parse(message.timestamp)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

/**
 * Preserve only main-appended peer projections when a renderer submits an older
 * whole-chat revision. Current saves remain authoritative, including deletion.
 */
export function mergeMissingThreadMessageTranscriptProjections(
  incomingMessages: readonly ChatMessage[],
  durableMessages: readonly ChatMessage[]
): ChatMessage[] {
  const merged = [...incomingMessages]
  const eventIds = new Set(merged.map(projectionEventId).filter(Boolean))
  const projectionIds = new Set(
    merged.filter(isThreadMessageTranscriptProjection).map((message) => message.id)
  )

  for (const projection of durableMessages) {
    if (!isThreadMessageTranscriptProjection(projection)) continue
    const eventId = projectionEventId(projection)
    if ((eventId && eventIds.has(eventId)) || projectionIds.has(projection.id)) continue

    const projectionTime = messageTime(projection)
    const insertAt = merged.findIndex((message) => messageTime(message) > projectionTime)
    if (insertAt === -1) merged.push(projection)
    else merged.splice(insertAt, 0, projection)
    if (eventId) eventIds.add(eventId)
    projectionIds.add(projection.id)
  }

  return merged
}
