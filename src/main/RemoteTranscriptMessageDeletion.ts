import type { ChatRecord } from './store/types'

export interface DeleteTranscriptMessageOptions {
  pendingQuestionIds?: ReadonlySet<string>
  now?: () => number
}

export type DeleteTranscriptMessageResult =
  | { ok: true; chat: ChatRecord }
  | { ok: false; reason: 'message-not-found' | 'open-prompt-anchor' }

/**
 * Remove one transcript message after re-validating the desktop orphan-prompt
 * guard against canonical Mac state.
 *
 * Persistence is intentionally outside this helper: the bridge handler saves
 * the returned chat through AppStore.saveChat so the existing feedback-ledger
 * hook also purges receipts for a deleted rated message.
 */
export function deleteTranscriptMessage(
  chat: ChatRecord,
  messageId: string,
  options: DeleteTranscriptMessageOptions = {}
): DeleteTranscriptMessageResult {
  const index = chat.messages.findIndex((message) => message.id === messageId)
  if (index < 0) return { ok: false, reason: 'message-not-found' }

  const message = chat.messages[index]
  const metadata = message.metadata
  const proposedPlan = metadata?.proposedPlan
  if (proposedPlan?.status === 'pending') {
    return { ok: false, reason: 'open-prompt-anchor' }
  }

  if (metadata?.kind === 'agentQuestion') {
    const question = metadata.agentQuestion as Record<string, unknown> | undefined
    const questionId =
      typeof question?.questionId === 'string'
        ? question.questionId
        : typeof question?.promptId === 'string'
          ? question.promptId
          : undefined
    if (questionId && options.pendingQuestionIds?.has(questionId)) {
      return { ok: false, reason: 'open-prompt-anchor' }
    }
  }

  const messages = [...chat.messages]
  messages.splice(index, 1)
  return {
    ok: true,
    chat: {
      ...chat,
      messages,
      updatedAt: (options.now ?? Date.now)()
    }
  }
}
