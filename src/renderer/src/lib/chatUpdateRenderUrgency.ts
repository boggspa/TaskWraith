import type { ChatRecord } from '../../../main/store/types'

/** Upper bound for an accepted chat update to wait solely on animation-frame delivery. */
export const CHAT_UPDATE_MAX_RENDER_LATENCY_MS = 100

/** Terminal Ensemble state must reach React effects immediately after transport ACK. */
export function shouldFlushChatUpdateImmediately(chat: ChatRecord): boolean {
  if (chat.chatKind !== 'ensemble') return false
  const status = chat.ensemble?.activeRound?.status
  return status === 'completed' || status === 'cancelled' || status === 'failed'
}
