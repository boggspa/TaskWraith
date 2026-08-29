import {
  CONTINUATION_HOPS_CHANGE_KIND,
  type ContinuationHopsAdvancePayload,
  type ContinuationHopsLimitChangePayload
} from '../../shared/continuationHopsChange'
import type { ChatMessage, ChatRecord } from '../store/types'

export interface AppendContinuationHopsChangeInput extends Omit<
  ContinuationHopsLimitChangePayload,
  'event' | 'changedAt'
> {
  id: string
  changedAt: string
  changedAtMs: number
  roundId?: string
}

export interface BuildContinuationHopsAdvanceInput extends Omit<
  ContinuationHopsAdvancePayload,
  'event'
> {
  statusMessage: string
  roundId?: string
}

export interface BuiltContinuationHopsAdvanceTranscriptEvent {
  content: string
  metadata: NonNullable<ChatMessage['metadata']>
}

function actorLabel(actor: ContinuationHopsLimitChangePayload['actor']): string {
  if (actor === 'boss') return 'Boss'
  if (actor === 'captain') return 'Captain'
  return 'User'
}

function optionalLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

/**
 * Builds the structured promotion and its plaintext fallback for a consumed
 * Continuous handoff. The caller can pass both directly to appendRoundStatus,
 * keeping persistence and checkpoint ownership in the orchestrator.
 */
export function buildContinuationHopsAdvanceTranscriptEvent(
  input: BuildContinuationHopsAdvanceInput
): BuiltContinuationHopsAdvanceTranscriptEvent {
  const statusMessage = input.statusMessage.trim()
  const targetLabel = optionalLabel(input.targetLabel)
  const sourceLabel = optionalLabel(input.sourceLabel)
  const payload: ContinuationHopsAdvancePayload = {
    event: 'advance',
    before: input.before,
    after: input.after,
    maxHops: input.maxHops,
    changedAt: input.changedAt,
    ...(targetLabel ? { targetLabel } : {}),
    ...(sourceLabel ? { sourceLabel } : {})
  }

  return {
    content: `${statusMessage ? `${statusMessage} ` : ''}Continuous handoff ${input.after}/${input.maxHops}.`,
    metadata: {
      kind: CONTINUATION_HOPS_CHANGE_KIND,
      ...(input.roundId ? { ensembleRoundId: input.roundId } : {}),
      continuationHopsChange: payload
    }
  }
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
  const payload: ContinuationHopsLimitChangePayload = {
    event: 'limit',
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
