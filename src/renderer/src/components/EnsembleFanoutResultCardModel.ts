import type { ChatMessage } from '../../../main/store/types'
// The lane-result predicate, part type, and parts reader live in shared/ so
// the remote projection folds fan-out lanes exactly the way this card renders
// them. Re-exported to keep this model the card's single import surface.
export {
  isEnsembleFanoutResultMessage,
  readEnsembleFanoutTranscriptParts
} from '../../../shared/fanoutLaneGrouping'
export type { EnsembleFanoutTranscriptPart } from '../../../shared/fanoutLaneGrouping'

/**
 * The seat this fan-out card belongs to.
 *
 * Used to decide whether the card's lane is still working, by matching against
 * the SAME working-indicator presentations that drive the "working…" row — so
 * the card's shimmer and that row appear and disappear together rather than
 * each evaluating its own idea of "live". Returns null for a card whose message
 * predates the participant id, which simply reads as not-working.
 */
export function ensembleFanoutParticipantId(message: ChatMessage): string | null {
  const raw = message.metadata?.ensembleParticipantId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null
}

/**
 * True when this card's lane is one of the currently-working seats.
 *
 * Deliberately takes the already-derived presentations rather than the chat: the
 * caller owns one derivation for the whole transcript, and re-deriving per card
 * would be both wasteful and a chance to drift out of lockstep with the row.
 */
export function isEnsembleFanoutLaneWorking(
  message: ChatMessage,
  workingParticipantIds: ReadonlySet<string> | null | undefined
): boolean {
  if (!workingParticipantIds || workingParticipantIds.size === 0) return false
  const participantId = ensembleFanoutParticipantId(message)
  return participantId !== null && workingParticipantIds.has(participantId)
}

export function ensembleFanoutLaneIntent(
  message: ChatMessage
): 'read' | 'write' | 'none' | undefined {
  const intent = message.metadata?.ensembleLaneIntent
  return intent === 'read' || intent === 'write' || intent === 'none' ? intent : undefined
}
