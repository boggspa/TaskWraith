import type {
  ConcurrentLane,
  EnsembleParticipantStatus,
  EnsembleRoundParticipantState,
  EnsembleRoundState
} from '../../../main/store/types'
import { isLaneFailureSupersededBySeatChange } from '../../../shared/ensembleSeatFailureClear'

export type EnsembleParticipantChipStatusLabel = EnsembleParticipantStatus | 'speaking'

export interface EnsembleParticipantChipStatusProjection {
  active: boolean
  lane: ConcurrentLane | undefined
  laneFailureSuperseded: boolean
  participantState: EnsembleRoundParticipantState | undefined
  statusLabel: EnsembleParticipantChipStatusLabel
}

function laneStatusToParticipantLabel(
  status: ConcurrentLane['status']
): EnsembleParticipantChipStatusLabel {
  switch (status) {
    case 'pending':
      return 'idle'
    case 'running':
      return 'speaking'
    case 'completed':
      return 'answered'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'blocked':
      return 'failed'
    case 'awaiting-approval':
      return 'running'
    default:
      return 'idle'
  }
}

function isExecutingLane(lane: ConcurrentLane | undefined): boolean {
  return lane?.status === 'running' || lane?.status === 'awaiting-approval'
}

function isLiveLane(lane: ConcurrentLane): boolean {
  return (
    lane.status === 'pending' ||
    lane.status === 'running' ||
    lane.status === 'blocked' ||
    lane.status === 'awaiting-approval'
  )
}

function latestLaneForParticipant(
  lanes: Record<string, ConcurrentLane> | undefined,
  participantId: string
): ConcurrentLane | undefined {
  const matches = Object.values(lanes || {}).filter((lane) => lane.participantId === participantId)
  const liveMatches = matches.filter(isLiveLane)
  return liveMatches[liveMatches.length - 1] || matches[matches.length - 1]
}

/**
 * Resolves the status vocabulary for one composer roster chip.
 *
 * Serial ownership (`activeParticipantId`) is authoritative for that seat.
 * Completed fan-out lanes intentionally remain in a Continuous round as
 * attempt history, so allowing one to override the serial owner paints the
 * current speaker as answered and drops both its shimmer and megaphone.
 */
export function deriveEnsembleParticipantChipStatus(
  round: EnsembleRoundState | undefined,
  participantId: string
): EnsembleParticipantChipStatusProjection {
  const participantState = round?.participants.find(
    (participant) => participant.participantId === participantId
  )
  const isSerialSpeaker = round?.status === 'running' && round.activeParticipantId === participantId

  if (isSerialSpeaker) {
    return {
      active: true,
      lane: undefined,
      laneFailureSuperseded: false,
      participantState,
      statusLabel: 'speaking'
    }
  }

  const lane = latestLaneForParticipant(round?.lanes, participantId)
  const laneFailureSuperseded = lane ? isLaneFailureSupersededBySeatChange(lane) : false
  const active = isExecutingLane(lane)
  const statusLabel =
    lane && !laneFailureSuperseded
      ? laneStatusToParticipantLabel(lane.status)
      : participantState?.status || 'idle'

  return {
    active,
    lane,
    laneFailureSuperseded,
    participantState,
    statusLabel
  }
}
