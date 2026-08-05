import type { ChatMessage } from '../../../main/store/types'
import { THREAD_MESSAGE_TRANSCRIPT_KIND } from '../../../shared/threadMessage'
import type { SeatChangeSeatState } from '../../../shared/seatChange'
import type { ThreadMessageCardInput } from './ThreadMessageInboxModel'

function stringMetadata(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The sending seat, re-validated on the way out of persisted metadata.
 *
 * Main sanitises this before storing, but by the time the renderer reads it the
 * value is JSON on disk rather than something main just built, and it is about
 * to be rendered as the identity of whoever sent an untrusted message. Provider
 * and model are both required because the strip renders an empty span for a
 * missing model, which would read as a seat with no model rather than as the
 * absence of a seat.
 */
function seatMetadata(value: unknown): SeatChangeSeatState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const provider = stringMetadata(record.provider)
  const model = stringMetadata(record.model)
  if (!provider || !model) return null
  const role = stringMetadata(record.role)
  const reasoningEffort = stringMetadata(record.reasoningEffort)
  const permissionPresetId = stringMetadata(record.permissionPresetId)
  const stage = stringMetadata(record.stageRole)
  const stageRole =
    stage === 'scout' || stage === 'worker' || stage === 'reviewer' || stage === 'background'
      ? stage
      : undefined
  const auth = stringMetadata(record.authority)
  const authority = auth === 'boss' || auth === 'captain' ? auth : undefined
  return {
    provider,
    model,
    ...(role ? { role } : {}),
    ...(stageRole ? { stageRole } : {}),
    ...(authority ? { authority } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof record.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: record.thinkingEnabled }
      : {}),
    ...(permissionPresetId ? { permissionPresetId } : {})
  }
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
  const seat = seatMetadata(metadata.threadMessageSeat)
  return {
    id: stringMetadata(metadata.threadMessageId) || message.id,
    fromChatId: stringMetadata(metadata.threadMessageFromChatId) || 'unknown-peer-thread',
    fromChatTitle: stringMetadata(metadata.threadMessageFromChatTitle),
    origin: metadata.threadMessageOrigin === 'user' ? 'user' : 'agent',
    body: message.content,
    requestedDelivery: metadata.threadMessageRequestedDelivery === 'wake' ? 'wake' : 'queue',
    createdAt: transcriptCreatedAt(message),
    ...(seat ? { seat } : {}),
    ...(metadata.threadMessageTruncated === true ? { truncated: true } : {})
  }
}
