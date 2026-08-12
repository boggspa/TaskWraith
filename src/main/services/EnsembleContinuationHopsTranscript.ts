import {
  CONTINUATION_HOPS_CHANGE_KIND,
  type ContinuationHopsChangePayload
} from '../../shared/continuationHopsChange'
import type { ChatMessage, ChatRecord } from '../store/types'

export interface AppendContinuationHopsChangeInput extends Omit<
  ContinuationHopsChangePayload,
  'changedAt'
> {
  id: string
  changedAt: string
  changedAtMs: number
  roundId?: string
}

function actorLabel(actor: ContinuationHopsChangePayload['actor']): string {
  if (actor === 'boss') return 'Boss'
  if (actor === 'captain') return 'Captain'
  return 'User'
}

/**
 * Pure transcript mutation used by both composer-owned and authority-owned hop
 * changes. The caller remains responsible for the single durable save.
 */
export function appendContinuationHopsChangeTranscriptEvent(
  chat: ChatRecord,
  input: AppendContinuationHopsChangeInput
): ChatRecord {
  if (input.before === input.after) return chat

  const reason = input.reason?.trim()
  const payload: ContinuationHopsChangePayload = {
    before: input.before,
    after: input.after,
    actor: input.actor,
    changedAt: input.changedAt,
    ...(input.actorParticipantId ? { actorParticipantId: input.actorParticipantId } : {}),
    ...(input.actorRole ? { actorRole: input.actorRole } : {}),
    ...(reason ? { reason } : {})
  }
  const message: ChatMessage = {
    id: input.id,
    role: 'system',
    content: `${actorLabel(input.actor)} changed max handoff turns from ${input.before} to ${input.after}.${reason ? ` Reason: ${reason}` : ''}`,
    timestamp: input.changedAt,
    metadata: {
      kind: CONTINUATION_HOPS_CHANGE_KIND,
      ...(input.roundId ? { ensembleRoundId: input.roundId } : {}),
      continuationHopsChange: payload
    }
  }

  return {
    ...chat,
    messages: [...chat.messages, message],
    updatedAt: input.changedAtMs
  }
}
