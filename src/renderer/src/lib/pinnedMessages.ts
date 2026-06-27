import type { ChatMessage, PinnedMessageSummary } from '../../../main/store/types'

export function readMessagePinnedAt(
  metadata: ChatMessage['metadata'] | undefined
): number | null {
  const pinnedAt = metadata?.pinnedAt
  return typeof pinnedAt === 'number' && Number.isFinite(pinnedAt) ? pinnedAt : null
}

export function isPinnedChatMessage(message: ChatMessage): boolean {
  return readMessagePinnedAt(message.metadata) !== null
}

export function buildPinnedMessageSummary(
  message: ChatMessage
): PinnedMessageSummary | null {
  const pinnedAt = readMessagePinnedAt(message.metadata)
  if (pinnedAt === null) return null
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.runId ? { runId: message.runId } : {}),
    pinnedAt
  }
}

export function buildPinnedMessageSummaries(
  messages: readonly ChatMessage[] | null | undefined
): PinnedMessageSummary[] {
  return (messages || [])
    .map(buildPinnedMessageSummary)
    .filter((message): message is PinnedMessageSummary => Boolean(message))
    .sort((a, b) => b.pinnedAt - a.pinnedAt)
}

export function countMessagesWithPinnedMetadata(
  messages: readonly ChatMessage[] | null | undefined
): number {
  return (messages || []).filter((message) => typeof message.metadata?.pinnedAt === 'number').length
}

export function toggleChatMessagePin(message: ChatMessage, pinnedAt: number): ChatMessage {
  const metadata = { ...(message.metadata || {}) }
  if (typeof metadata.pinnedAt === 'number') {
    delete metadata.pinnedAt
  } else {
    metadata.pinnedAt = pinnedAt
  }
  const nextMessage: ChatMessage = { ...message }
  if (Object.keys(metadata).length > 0) {
    nextMessage.metadata = metadata
  } else {
    delete nextMessage.metadata
  }
  return nextMessage
}
