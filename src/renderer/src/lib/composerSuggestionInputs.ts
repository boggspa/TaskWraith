/**
 * Extraction layer between the chat record and the composer's suggestion
 * trigger table.
 *
 * `composerSuggestion.ts` deliberately takes only normalized primitives so
 * its trigger table stays trivially testable. This module owns the messy
 * half: reaching into round state, reconciling the two places seat failures
 * are recorded, and handing back a flat list.
 */

import type {
  ChatRecord,
  ConcurrentLane,
  EnsembleRoundParticipantState,
  EnsembleRoundState
} from '../../../main/store/types'
import type { ComposerSuggestionLane } from './composerSuggestion'

/**
 * Seat outcomes that mean "this didn't produce an answer, and the user may
 * want to do something about it".
 *
 * `skipped` / `cancelled` / `sleeping` are deliberately excluded: those are
 * outcomes someone chose, not faults to offer a fix for.
 */
function laneKindForStatus(status: string): ComposerSuggestionLane['kind'] | null {
  if (status === 'failed') return 'failed'
  if (status === 'unreachable') return 'unreachable'
  return null
}

/** Seat label convention shared with the run-complete summary rows. */
function seatLabel(role: string | undefined, provider: string): string {
  return role?.trim() || provider
}

/**
 * Failed seats in the most recent round, or an empty list when there's
 * nothing to offer.
 *
 * Two sources, one authority rule (see `EnsembleRoundState.lanes` in
 * store/types.ts): concurrent dispatch populates `lanes`, serial dispatch
 * leaves it undefined and `participants[].status` is authoritative instead.
 * Reading only one of them would silently skip every ensemble run in the
 * other mode — and since concurrent lanes sit behind an env flag, the mode
 * that actually needs covering is the one most installs never hit.
 *
 * A still-running round returns nothing: seats fail and recover mid-round,
 * and offering a rerun against a live round would race the orchestrator.
 */
export function failedLanesFromChat(chat: ChatRecord | null | undefined): ComposerSuggestionLane[] {
  const round = chat?.ensemble?.activeRound
  if (!round || round.status === 'running') return []
  const fromLanes = failedConcurrentLanes(round)
  return fromLanes.length > 0 ? fromLanes : failedSerialParticipants(round)
}

function failedConcurrentLanes(round: EnsembleRoundState): ComposerSuggestionLane[] {
  const lanes = round.lanes
  if (!lanes) return []
  const seats = new Map<string, EnsembleRoundParticipantState>(
    (round.participants || []).map((participant) => [participant.participantId, participant])
  )
  return Object.values(lanes)
    .map((lane: ConcurrentLane): ComposerSuggestionLane | null => {
      const kind = laneKindForStatus(lane.status)
      if (!kind) return null
      // A lane record carries no role of its own, so the display label
      // comes from the round participant it was dispatched for.
      const seat = seats.get(lane.participantId)
      return {
        id: lane.laneId,
        label: seatLabel(seat?.role, lane.provider),
        provider: lane.provider,
        kind
      }
    })
    .filter((lane): lane is ComposerSuggestionLane => lane !== null)
}

function failedSerialParticipants(round: EnsembleRoundState): ComposerSuggestionLane[] {
  return (round.participants || [])
    .map((participant): ComposerSuggestionLane | null => {
      const kind = laneKindForStatus(participant.status)
      if (!kind) return null
      return {
        id: participant.participantId,
        label: seatLabel(participant.role, participant.provider),
        provider: participant.provider,
        kind
      }
    })
    .filter((lane): lane is ComposerSuggestionLane => lane !== null)
}
