import type { ChatRecord } from '../../../main/store/types'

/**
 * Stable dependency key for evidence that changes deterministic round closeout
 * prose after the terminal card was first authored.
 */
export function roundSummaryRefreshKeyForCloseout(chat: ChatRecord | null | undefined): string {
  if (chat?.chatKind !== 'ensemble') return ''
  const round = chat.ensemble?.activeRound
  if (
    !round ||
    (round.status !== 'completed' && round.status !== 'cancelled' && round.status !== 'failed')
  ) {
    return ''
  }
  const captured = chat.ensemble?.roundSummaries?.[round.roundId]
  const summary = captured?.summary || chat.ensemble?.lastRoundSummary || ''
  return [round.roundId, captured?.capturedAt || 'legacy', summary].join('\n')
}
