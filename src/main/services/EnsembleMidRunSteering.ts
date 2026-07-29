import type { EnsembleParticipant, EnsembleParticipantStatus } from '../store/types'

const BOUNDARY_VERSION_SEPARATOR = '\u001f'
const UNAVAILABLE_STATUSES = new Set<EnsembleParticipantStatus>([
  'failed',
  'cancelled',
  'skipped',
  'unreachable'
])

export interface EnsembleMidRunSteeringBoundaryState {
  pendingVersion: string
  attemptedParticipantIds: Set<string>
}

export interface EnsembleMidRunSteeringBoundaryPlan {
  participant: EnsembleParticipant | null
  state: EnsembleMidRunSteeringBoundaryState | undefined
  exhausted: boolean
}

/**
 * Pure candidate planner for a final-hop steering boundary.
 *
 * One pending-entry signature may try each eligible foreground seat at most
 * once. A changed signature resets the attempts so a later user interjection
 * is independently deliverable.
 */
export function planEnsembleMidRunSteeringBoundary(input: {
  pendingEntryIds: string[]
  participants: EnsembleParticipant[]
  participantStatusById: ReadonlyMap<string, EnsembleParticipantStatus>
  preferredParticipantIds: Array<string | undefined>
  dmTargetParticipantId?: string
  unavailableParticipantIds?: ReadonlySet<string>
  previousState?: EnsembleMidRunSteeringBoundaryState
}): EnsembleMidRunSteeringBoundaryPlan {
  if (input.pendingEntryIds.length === 0) {
    return { participant: null, state: undefined, exhausted: false }
  }

  const pendingVersion = input.pendingEntryIds.join(BOUNDARY_VERSION_SEPARATOR)
  const attemptedParticipantIds =
    input.previousState?.pendingVersion === pendingVersion
      ? new Set(input.previousState.attemptedParticipantIds)
      : new Set<string>()
  const state = { pendingVersion, attemptedParticipantIds }
  const candidates = input.participants.filter((participant) => {
    if (!participant.enabled || participant.stageRole === 'background') return false
    if (input.dmTargetParticipantId && participant.id !== input.dmTargetParticipantId) {
      return false
    }
    if (input.unavailableParticipantIds?.has(participant.id)) return false
    if (attemptedParticipantIds.has(participant.id)) return false
    const status = input.participantStatusById.get(participant.id)
    return !status || !UNAVAILABLE_STATUSES.has(status)
  })
  const participant =
    input.preferredParticipantIds
      .filter((participantId): participantId is string => Boolean(participantId))
      .map((participantId) => candidates.find((candidate) => candidate.id === participantId))
      .find((candidate): candidate is EnsembleParticipant => Boolean(candidate)) ||
    candidates.slice().sort((left, right) => left.order - right.order)[0] ||
    null

  if (!participant) {
    return { participant: null, state, exhausted: true }
  }
  attemptedParticipantIds.add(participant.id)
  return { participant, state, exhausted: false }
}
