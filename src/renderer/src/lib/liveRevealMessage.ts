import type { ChatMessage } from '../../../main/store/types'
import { isGuestParticipantReplyMessage } from '../components/GuestParticipantReplyCardModel'

export interface LiveRevealMessageOptions {
  revealEnabled: boolean
  revealChatIsRunning: boolean
  revealRunId?: string | null
}

export function isLiveRevealMessageCandidate(
  message: ChatMessage | null | undefined,
  revealRunId?: string | null
): boolean {
  if (!message) return false
  const assistantLike = message.role === 'assistant' || isGuestParticipantReplyMessage(message)
  if (!assistantLike) return false
  if (revealRunId && message.runId && message.runId !== revealRunId) return false
  return true
}

export function resolveLiveRevealMessageId(
  messages: readonly ChatMessage[],
  options: LiveRevealMessageOptions
): string | null {
  if (!options.revealEnabled || !options.revealChatIsRunning) return null
  const lastMessage = messages[messages.length - 1]
  if (!isLiveRevealMessageCandidate(lastMessage, options.revealRunId)) return null
  return lastMessage.id
}
