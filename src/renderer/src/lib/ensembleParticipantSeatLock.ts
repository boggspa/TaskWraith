import type {
  ConcurrentLaneStatus,
  EnsembleParticipantStatus,
  EnsembleRoundState
} from '../../../main/store/types'
import { isEnsembleActiveRoundDispatchLive } from './chatBusyState'

const LOCKED_PARTICIPANT_STATUSES = new Set<EnsembleParticipantStatus>(['running'])
const LOCKED_LANE_STATUSES = new Set<ConcurrentLaneStatus>([
  'pending',
  'running',
  'blocked',
  'awaiting-approval'
])

export function isEnsembleParticipantSeatRuntimeLocked(
  round: EnsembleRoundState | null | undefined,
  participantId: string | null | undefined
): boolean {
  const targetParticipantId = participantId?.trim()
  if (!targetParticipantId || !isEnsembleActiveRoundDispatchLive(round)) return false
  if (round?.activeParticipantId === targetParticipantId) return true

  const participantState = round?.participants.find(
    (participant) => participant.participantId === targetParticipantId
  )
  if (
    participantState &&
    LOCKED_PARTICIPANT_STATUSES.has(participantState.status)
  ) {
    return true
  }

  return Object.values(round?.lanes || {}).some(
    (lane) =>
      lane.participantId === targetParticipantId && LOCKED_LANE_STATUSES.has(lane.status)
  )
}

export interface EnsembleParticipantSeatMutationState {
  locked: boolean
  deferUntilExecutionBoundary: boolean
  requiresRuntimeSync: boolean
  message: string | null
}

export function resolveEnsembleParticipantSeatMutationState(
  round: EnsembleRoundState | null | undefined,
  participantId: string | null | undefined
): EnsembleParticipantSeatMutationState {
  const requiresRuntimeSync = isEnsembleActiveRoundDispatchLive(round)
  const locked = isEnsembleParticipantSeatRuntimeLocked(round, participantId)
  return {
    locked,
    deferUntilExecutionBoundary: locked,
    requiresRuntimeSync,
    message: locked
      ? 'This seat is executing. Changes apply when its current execution finishes.'
      : null
  }
}
