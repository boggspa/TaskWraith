import type { ChatMessage } from './store/types'

export interface RemoteMessageFeedbackInput {
  vote: 'up' | 'down'
  reason?: string
  note?: string
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

/**
 * Apply the same toggle semantics as the desktop feedback chrome.
 *
 * This helper only changes message-local render state. Persisting the returned
 * chat through AppStore.saveChat is what invokes the existing attributed
 * feedback-ledger hook.
 */
export function applyRemoteMessageFeedback(
  message: ChatMessage,
  input: RemoteMessageFeedbackInput,
  at: number
): ChatMessage | null {
  if (message.role !== 'assistant' || message.metadata?.kind === 'channelInbound') return null

  const reason = boundedText(input.reason, 80)
  const note = boundedText(input.note, 1000)
  const hasDetails = Boolean(reason || note)
  const metadata = { ...(message.metadata || {}) }

  if (metadata.feedback?.vote === input.vote && !hasDetails) {
    delete metadata.feedback
  } else {
    metadata.feedback = {
      vote: input.vote,
      at,
      ...(reason ? { reason } : {}),
      ...(note ? { note } : {})
    }
  }

  const next: ChatMessage = { ...message }
  if (Object.keys(metadata).length > 0) next.metadata = metadata
  else delete next.metadata
  return next
}
