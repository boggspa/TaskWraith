import type { ChatMessage, ToolActivity } from '../../../main/store/types'

export type EnsembleFanoutTranscriptPart =
  | {
      kind: 'content'
      id: string
      messageIds: string[]
      content: string
    }
  | {
      kind: 'tools'
      id: string
      messageIds: string[]
      toolActivities: ToolActivity[]
    }

export function isEnsembleFanoutResultMessage(message: ChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.metadata?.kind === 'ensembleParticipant' &&
    typeof message.metadata?.ensembleLaneId === 'string' &&
    message.metadata.ensembleLaneId.trim().length > 0
  )
}

/**
 * The seat this fan-out card belongs to.
 *
 * Used to decide whether the card's lane is still working, by matching against
 * the SAME working-indicator presentations that drive the "working…" row — so
 * the card's shimmer and that row appear and disappear together rather than
 * each evaluating its own idea of "live". Returns null for a card whose message
 * predates the participant id, which simply reads as not-working.
 */
export function ensembleFanoutParticipantId(message: ChatMessage): string | null {
  const raw = message.metadata?.ensembleParticipantId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/**
 * True when this card's lane is one of the currently-working seats.
 *
 * Deliberately takes the already-derived presentations rather than the chat: the
 * caller owns one derivation for the whole transcript, and re-deriving per card
 * would be both wasteful and a chance to drift out of lockstep with the row.
 */
export function isEnsembleFanoutLaneWorking(
  message: ChatMessage,
  workingParticipantIds: ReadonlySet<string> | null | undefined
): boolean {
  if (!workingParticipantIds || workingParticipantIds.size === 0) return false
  const participantId = ensembleFanoutParticipantId(message)
  return participantId !== null && workingParticipantIds.has(participantId)
}

export function ensembleFanoutLaneIntent(
  message: ChatMessage
): 'read' | 'write' | 'none' | undefined {
  const intent = message.metadata?.ensembleLaneIntent
  return intent === 'read' || intent === 'write' || intent === 'none' ? intent : undefined
}

export function readEnsembleFanoutTranscriptParts(
  message: ChatMessage
): EnsembleFanoutTranscriptPart[] {
  const raw = message.metadata?.ensembleFanoutTranscriptParts
  if (!Array.isArray(raw)) return []
  const parts: EnsembleFanoutTranscriptPart[] = []
  for (const part of raw) {
    if (!part || typeof part !== 'object') continue
    const candidate = part as Record<string, unknown>
    const id = typeof candidate.id === 'string' ? candidate.id : ''
    const messageIds = Array.isArray(candidate.messageIds)
      ? candidate.messageIds.filter((item): item is string => typeof item === 'string')
      : []
    if (!id || messageIds.length === 0) continue
    if (candidate.kind === 'content' && typeof candidate.content === 'string') {
      parts.push({ kind: 'content', id, messageIds, content: candidate.content })
      continue
    }
    if (candidate.kind === 'tools' && Array.isArray(candidate.toolActivities)) {
      parts.push({
        kind: 'tools',
        id,
        messageIds,
        toolActivities: candidate.toolActivities as ToolActivity[]
      })
    }
  }
  return parts
}
