import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import {
  shouldAutoCollapseActivityStack,
  shouldAutoCollapseActivityStackForView
} from '../lib/collapsedActivityStack'
import type { TranscriptView } from '../../../main/store/types'
// The lane-result predicate, part type, and parts reader live in shared/ so
// the remote projection folds fan-out lanes exactly the way this card renders
// them. Re-exported to keep this model the card's single import surface.
export {
  isEnsembleFanoutResultMessage,
  readEnsembleFanoutTranscriptParts
} from '../../../shared/fanoutLaneGrouping'
export type { EnsembleFanoutTranscriptPart } from '../../../shared/fanoutLaneGrouping'

const FANOUT_ACTIVITY_PART_EXPANSION_PREFIX = 'fanout-activity-part:'

/** Stable synthetic id stored alongside ordinary expanded activity ids. */
export function fanoutActivityPartExpansionId(partId: string): string {
  return `${FANOUT_ACTIVITY_PART_EXPANSION_PREFIX}${partId}`
}

/**
 * Earlier settled tool groups fold while a lane is still working; once the
 * lane itself settles, its final settled group folds too. Running/pending
 * activity always wins and remains visible.
 *
 * `view` and `viewHidesAllContent` exist for the CURRENT LIVE part, and only
 * for it. Every other part is already folded by the strict rule above, so the
 * view cannot change their answer.
 *
 * Without them a live lane rendered NOTHING under a filtering view: the strict
 * predicate refuses to fold running work, so the part fell through to the full
 * `ActivityStack`, whose empty-guard returns null once the view has filtered
 * every segment away — no body, no one-liner, no fold. Measured on a
 * thinking-only live lane: minimal and tools both emitted no tool area at all
 * while standard emitted the viewport.
 *
 * This is the same defect the transcript's row renderer fixed (D3, ac32daa78).
 * It survived here because b561f9a3e deliberately kept the strict form at "the
 * fan-out lane model", reasoning that stricter-than-the-renderer is the safe
 * direction. That is true of SUPER-GROUP MEMBERSHIP, where folding less leaves
 * a row as its own card — but not here, where folding less means rendering a
 * stack the view has already emptied. Two call sites, one label, opposite
 * consequences.
 */
export function shouldCollapseFanoutActivityPart(
  input: {
    activities: readonly ToolActivity[]
    isLatestPart: boolean
    laneWorking: boolean
  },
  view?: TranscriptView,
  viewHidesAllContent = false
): boolean {
  const isCurrentLivePart = input.laneWorking && input.isLatestPart
  const stackInput = {
    activities: input.activities,
    isLiveRow: isCurrentLivePart,
    isLastRow: isCurrentLivePart
  }
  // Optional so the predicate keeps its old meaning for a caller that has no
  // view to give, and so the two existing unit tests still read as written.
  if (!view) return shouldAutoCollapseActivityStack(stackInput)
  return shouldAutoCollapseActivityStackForView(stackInput, view, viewHidesAllContent)
}

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
