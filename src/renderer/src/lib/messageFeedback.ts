import type { ChatMessage } from '../../../main/store/types'

export type MessageFeedbackVote = 'up' | 'down'

/**
 * Thumbs feedback lives on `message.metadata.feedback` (mirrors the
 * `pinnedAt` render-state pattern). This module is the pure toggle/read
 * layer; the durable, attributed audit signal is written separately to the
 * thumbs receipt ledger. Only assistant messages are votable — the caller
 * gates the UI; these helpers stay role-agnostic.
 */
export function readMessageFeedbackVote(
  message: ChatMessage | null | undefined
): MessageFeedbackVote | null {
  const vote = message?.metadata?.feedback?.vote
  return vote === 'up' || vote === 'down' ? vote : null
}

/**
 * Toggle-apply a vote: clicking the currently-set vote clears it; clicking the
 * other vote flips to it. Returns a new message (never mutates). `at` is passed
 * in (not read from the clock) so callers/tests stay deterministic — same
 * contract as `toggleChatMessagePin`.
 */
export function applyChatMessageFeedback(
  message: ChatMessage,
  vote: MessageFeedbackVote,
  at: number,
  extra?: { reason?: string; note?: string }
): ChatMessage {
  const metadata = { ...(message.metadata || {}) }
  const current = metadata.feedback?.vote
  if (current === vote && !extra) {
    // Same vote clicked again with no new detail → clear it.
    delete metadata.feedback
  } else {
    metadata.feedback = {
      vote,
      at,
      ...(extra?.reason ? { reason: extra.reason } : {}),
      ...(extra?.note ? { note: extra.note } : {})
    }
  }
  const nextMessage: ChatMessage = { ...message }
  if (Object.keys(metadata).length > 0) {
    nextMessage.metadata = metadata
  } else {
    delete nextMessage.metadata
  }
  return nextMessage
}
