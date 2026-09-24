import {
  AUTO_APPROVALS_CHANGE_KIND,
  type AutoApprovalsChangePayload
} from '../../shared/autoApprovalsChange'
import type { ChatMessage, ChatRecord } from '../store/types'

export interface AppendAutoApprovalsChangeInput extends Omit<
  AutoApprovalsChangePayload,
  'changedAt'
> {
  id: string
  changedAt: string
  changedAtMs: number
  roundId?: string
}

/**
 * Pure transcript mutation for a human-owned Auto Approvals consent change.
 * The caller remains responsible for the single durable chat save.
 */
export function appendAutoApprovalsChangeTranscriptEvent(
  chat: ChatRecord,
  input: AppendAutoApprovalsChangeInput
): ChatRecord {
  if (input.before === input.after) return chat

  const payload: AutoApprovalsChangePayload = {
    before: input.before,
    after: input.after,
    changedAt: input.changedAt
  }
  const message: ChatMessage = {
    id: input.id,
    role: 'system',
    content: `User ${input.after ? 'enabled' : 'disabled'} thread-wide Auto Approvals.`,
    timestamp: input.changedAt,
    metadata: {
      kind: AUTO_APPROVALS_CHANGE_KIND,
      ...(input.roundId ? { ensembleRoundId: input.roundId } : {}),
      autoApprovalsChange: payload
    }
  }

  return {
    ...chat,
    messages: [...chat.messages, message],
    updatedAt: input.changedAtMs
  }
}
