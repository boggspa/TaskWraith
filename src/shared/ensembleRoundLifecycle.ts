import type {
  ConcurrentLaneStatus,
  EnsembleParticipantStatus,
  EnsembleRoundState,
  EnsembleRoundTurnTransition
} from '../main/store/types'

const LIVE_ENSEMBLE_PARTICIPANT_STATUSES = new Set<EnsembleParticipantStatus>([
  'idle',
  'running',
  'sleeping'
])

/**
 * Lane states that mean "this seat has not finished".
 *
 * `blocked` and `awaiting-approval` count: the seat is waiting on something,
 * not done, and is very likely the one holding the round up — so any "who is
 * still working" surface that dropped them would leave the straggler as the one
 * lane NOT marked.
 *
 * Exported because three surfaces need this exact predicate — round-liveness
 * here, the renderer's working-indicator presentations, and the remote
 * projection that tells the phone which lane cards to shimmer. They must agree;
 * a copy that drifts leaves a card marked busy after its seat has finished.
 */
export const LIVE_ENSEMBLE_LANE_STATUSES: ReadonlySet<ConcurrentLaneStatus> =
  new Set<ConcurrentLaneStatus>(['pending', 'running', 'blocked', 'awaiting-approval'])

export function isEnsembleRoundDispatchLive(
  round: EnsembleRoundState | null | undefined
): boolean {
  if (round?.status !== 'running') return false
  const participants = Array.isArray(round.participants) ? round.participants : []
  if (round.activeParticipantId) {
    const activeParticipant = participants.find(
      (participant) => participant.participantId === round.activeParticipantId
    )
    if (activeParticipant && LIVE_ENSEMBLE_PARTICIPANT_STATUSES.has(activeParticipant.status)) {
      return true
    }
  }

  const lanes = Object.values(round.lanes || {})
  if (lanes.some((lane) => LIVE_ENSEMBLE_LANE_STATUSES.has(lane.status))) return true
  if ((round.pendingWakeupIds?.length || 0) > 0) return true
  if ((round.sleepingParticipantIds?.length || 0) > 0) return true

  if (participants.length === 0) return false
  return participants.some((participant) =>
    LIVE_ENSEMBLE_PARTICIPANT_STATUSES.has(participant.status)
  )
}

/**
 * Renderer/interaction liveness includes the main-owned interval between two
 * foreground seats. Keep this separate from dispatch-evidence liveness: restart
 * recovery must still be able to identify a persisted running snapshot whose
 * in-memory orchestrator no longer exists.
 */
export function isEnsembleRoundPresentationLive(
  round: EnsembleRoundState | null | undefined
): boolean {
  if (round?.status !== 'running') return false
  if (round.turnTransition) return true
  return isEnsembleRoundDispatchLive(round)
}

/**
 * What to SAY during the interval between two foreground seats, when no
 * participant owns the moment and painting one as "Working" would be a lie.
 *
 * Shared rather than renderer-local because the phone shows this too, and the
 * wording is the whole point: two copies of the same three strings drift, and a
 * transcript that says something different on each surface about the same
 * instant is worse than one that says nothing. `targetRoleLabel` is resolved by
 * the caller (each side already holds its own participant list); an
 * unrecognised or blank role degrades to the generic phrasing rather than
 * naming an empty seat.
 */
export function ensembleTurnTransitionLabel(
  transition: EnsembleRoundTurnTransition | null | undefined,
  targetRoleLabel?: string | null
): string | undefined {
  if (!transition) return undefined
  if (transition.phase !== 'handoff') return 'Finalizing turn'
  const target = (targetRoleLabel || '').trim()
  return target ? `Handing off to ${target}` : 'Preparing next turn'
}
