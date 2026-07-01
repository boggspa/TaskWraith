import type {
  ConcurrentLaneStatus,
  EnsembleParticipantStatus,
  EnsembleRoundState
} from '../main/store/types'

const LIVE_ENSEMBLE_PARTICIPANT_STATUSES = new Set<EnsembleParticipantStatus>([
  'idle',
  'running',
  'sleeping'
])

const LIVE_ENSEMBLE_LANE_STATUSES = new Set<ConcurrentLaneStatus>([
  'pending',
  'running',
  'blocked',
  'awaiting-approval'
])

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
