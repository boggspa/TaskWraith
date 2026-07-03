import type { ChatMessage } from '../../../main/store/types'

export type MessageFeedbackVote = 'up' | 'down'

export const MESSAGE_FEEDBACK_REASON_OPTIONS = [
  { code: 'wrong-approach', label: 'Wrong approach' },
  { code: 'hallucinated-or-wrong', label: 'Hallucinated / wrong' },
  { code: 'broke-something', label: 'Broke something' },
  { code: 'over-verbose', label: 'Over-verbose' },
  { code: 'wrong-model-for-role', label: 'Wrong model for role' },
  { code: 'incomplete', label: 'Incomplete' }
] as const

export type MessageFeedbackReasonCode = (typeof MESSAGE_FEEDBACK_REASON_OPTIONS)[number]['code']

export interface MessageFeedbackDetails {
  reason?: MessageFeedbackReasonCode | string
  note?: string
}

const MAX_FEEDBACK_REASON_CHARS = 80
const MAX_FEEDBACK_NOTE_CHARS = 1000

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

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
  extra?: MessageFeedbackDetails
): ChatMessage {
  const metadata = { ...(message.metadata || {}) }
  const current = metadata.feedback?.vote
  if (current === vote && !extra) {
    // Same vote clicked again with no new detail → clear it.
    delete metadata.feedback
  } else {
    const reason = boundedText(extra?.reason, MAX_FEEDBACK_REASON_CHARS)
    const note = boundedText(extra?.note, MAX_FEEDBACK_NOTE_CHARS)
    metadata.feedback = {
      vote,
      at,
      ...(reason ? { reason } : {}),
      ...(note ? { note } : {})
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
