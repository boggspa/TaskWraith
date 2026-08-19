import { plainDataEqual } from '../shared/chatUpdateTransport'
import type {
  ChatRun,
  EnsembleParticipantStatus,
  EnsembleRoundParticipantState,
  EnsembleRoundState
} from './store/types'

type ParticipantAttemptRun = Pick<
  ChatRun,
  | 'runId'
  | 'startedAt'
  | 'endedAt'
  | 'ensembleParticipantId'
  | 'ensembleParticipantStatus'
  | 'ensembleTerminalReason'
>

function projectParticipantAttempt(
  participant: EnsembleRoundParticipantState,
  run: ParticipantAttemptRun,
  status: EnsembleParticipantStatus,
  exposeRunId: boolean
): EnsembleRoundParticipantState {
  const next: EnsembleRoundParticipantState = {
    ...participant,
    status,
    startedAt: run.startedAt
  }
  if (exposeRunId) next.runId = run.runId
  else delete next.runId

  if (status === 'running') {
    delete next.endedAt
    delete next.reason
    delete next.lastFailureReason
    return next
  }

  if (run.endedAt) next.endedAt = run.endedAt
  else delete next.endedAt

  const reason = run.ensembleTerminalReason?.trim()
  if (reason) next.reason = reason
  else delete next.reason

  if ((status === 'failed' || status === 'unreachable') && reason) {
    next.lastFailureReason = reason
  } else {
    delete next.lastFailureReason
  }
  return next
}

/**
 * Fold one exact ChatRun attempt onto the mutable round participant view.
 *
 * ChatRun owns attempt identity and lifecycle timestamps. The participant row
 * is only a latest-attempt projection, so a new running attempt must replace
 * terminal-only fields instead of shallow-patching the previous attempt's
 * corpse. Legacy runs without an exact participant status are ignored rather
 * than guessed from the lossy generic ChatRun.status field.
 */
export function projectRoundParticipantFromChatRun(
  round: EnsembleRoundState | undefined,
  run: ParticipantAttemptRun,
  options: { setActive?: boolean; exposeRunId?: boolean } = {}
): EnsembleRoundState | undefined {
  const participantId = run.ensembleParticipantId?.trim()
  const status = run.ensembleParticipantStatus
  if (!round || !participantId || !status) return round
  if (!round.participants.some((participant) => participant.participantId === participantId)) {
    return round
  }

  const setActive = options.setActive !== false
  const exposeRunId = options.exposeRunId !== false
  const nextActiveParticipantId =
    setActive && status === 'running'
      ? participantId
      : round.activeParticipantId === participantId
        ? undefined
        : round.activeParticipantId
  const nextTurnTransition = setActive && status === 'running' ? undefined : round.turnTransition
  let participantsChanged = false
  const participants = round.participants.map((participant) => {
    if (participant.participantId !== participantId) return participant
    const projected = projectParticipantAttempt(participant, run, status, exposeRunId)
    if (plainDataEqual(projected, participant)) return participant
    participantsChanged = true
    return projected
  })
  // Streaming flushes re-project the same running attempt on every event;
  // round identity is what lets the flush save detect real transitions.
  if (
    !participantsChanged &&
    nextActiveParticipantId === round.activeParticipantId &&
    nextTurnTransition === round.turnTransition
  ) {
    return round
  }
  return {
    ...round,
    activeParticipantId: nextActiveParticipantId,
    turnTransition: nextTurnTransition,
    participants: participantsChanged ? participants : round.participants
  }
}
