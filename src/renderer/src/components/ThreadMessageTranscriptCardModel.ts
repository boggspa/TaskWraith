import type { ChatMessage } from '../../../main/store/types'
import { THREAD_MESSAGE_TRANSCRIPT_KIND } from '../../../shared/threadMessage'
import type { ThreadMessageCardInput } from './ThreadMessageInboxModel'

function stringMetadata(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function transcriptCreatedAt(message: ChatMessage): number {
  const stored = message.metadata?.threadMessageCreatedAt
  if (typeof stored === 'number' && Number.isFinite(stored) && stored >= 0) return stored
  const parsed = Date.parse(message.timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

export function isThreadMessageTranscriptMessage(message: ChatMessage): boolean {
  return (
    message.role === 'tool' &&
    message.metadata?.kind === THREAD_MESSAGE_TRANSCRIPT_KIND &&
    message.metadata?.providerContextVisibility === 'projection-only'
  )
}

export function threadMessageCardInputFromTranscriptMessage(
  message: ChatMessage
): ThreadMessageCardInput {
  const metadata = message.metadata || {}
  return {
    id: stringMetadata(metadata.threadMessageId) || message.id,
    fromChatId: stringMetadata(metadata.threadMessageFromChatId) || 'unknown-peer-thread',
    fromChatTitle: stringMetadata(metadata.threadMessageFromChatTitle),
    origin: metadata.threadMessageOrigin === 'user' ? 'user' : 'agent',
    body: message.content,
    requestedDelivery: metadata.threadMessageRequestedDelivery === 'wake' ? 'wake' : 'queue',
    createdAt: transcriptCreatedAt(message),
    ...(metadata.threadMessageTruncated === true ? { truncated: true } : {})
  }
}
