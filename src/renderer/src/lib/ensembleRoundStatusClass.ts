import type { ChatMessage } from '../../../main/store/types'

/**
 * Class suffix for the transcript bubble of an ensemble round-status /
 * handback chrome line — round opened/closed, @-mention routing, "control
 * returned to you". The orchestrator emits these as `role: 'system'` with
 * `metadata.kind === 'ensembleRoundStatus'`. They are orchestration STATE
 * CHANGES, so the renderer retains a semantic hook for context-specific
 * presentation while leaving the message itself as uncontained satellite text.
 *
 * Returns the space-prefixed class to append to the bubble, or '' otherwise.
 */
export function ensembleRoundStatusClass(msg: Pick<ChatMessage, 'role' | 'metadata'>): string {
  return msg.role === 'system' && msg.metadata?.kind === 'ensembleRoundStatus'
    ? ' system-round-status'
    : ''
}
