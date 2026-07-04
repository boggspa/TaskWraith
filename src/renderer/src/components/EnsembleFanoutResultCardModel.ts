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
