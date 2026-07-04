import type { ChatMessage } from '../../../main/store/types'

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
