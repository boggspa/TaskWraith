import type {
  EnsembleParticipant,
  EnsembleRoundParticipantState,
  EnsembleRoundState,
  EnsembleRoundSynthesisStatus
} from './store/types'

const SYNTHESIS_ANSWER_STATUSES = new Set(['answered', 'yielded'])

export type EnsembleSynthesizerSelectionSource =
  | 'configured'
  | 'boss'
  | 'captain'
  | 'roster-fallback'

export interface EnsembleSynthesizerSelection {
  participantId: string
  source: EnsembleSynthesizerSelectionSource
}

/**
 * Choose one foreground participant already admitted to the round. Explicit
 * configuration wins; otherwise round-captured authority wins, with the last
 * foreground seat as a deterministic fallback that preserves serial ordering.
 */
export function electRoundSynthesizer(input: {
  participants: EnsembleParticipant[]
  configuredParticipantId?: string
  bossmanParticipantId?: string
  captainParticipantIds?: string[]
}): EnsembleSynthesizerSelection | undefined {
  const eligible = input.participants.filter(
    (participant) => participant.enabled && participant.stageRole !== 'background'
  )
  if (eligible.length < 2) return undefined

  const eligibleIds = new Set(eligible.map((participant) => participant.id))
  const configuredParticipantId = input.configuredParticipantId?.trim()
  if (configuredParticipantId && eligibleIds.has(configuredParticipantId)) {
    return { participantId: configuredParticipantId, source: 'configured' }
  }
  if (input.bossmanParticipantId && eligibleIds.has(input.bossmanParticipantId)) {
    return { participantId: input.bossmanParticipantId, source: 'boss' }
  }
  const captainParticipantId = (input.captainParticipantIds || []).find((participantId) =>
    eligibleIds.has(participantId)
  )
  if (captainParticipantId) {
    return { participantId: captainParticipantId, source: 'captain' }
  }
  return {
    participantId: eligible[eligible.length - 1].id,
    source: 'roster-fallback'
  }
}

export function roundRequiresSynthesis(participants: EnsembleRoundParticipantState[]): boolean {
  return (
    participants.filter((participant) => SYNTHESIS_ANSWER_STATUSES.has(participant.status))
      .length >= 2
  )
}

/** A configured owner is not proof of convergence; only a captured structured
 * summary completes synthesis when multiple participants produced answers. */
export function resolveRoundSynthesisStatus(input: {
  participants: EnsembleRoundParticipantState[]
  hasStructuredSummary: boolean
}): EnsembleRoundSynthesisStatus {
  if (!roundRequiresSynthesis(input.participants)) return 'not-required'
  return input.hasStructuredSummary ? 'completed' : 'unresolved'
}

export function shouldAttemptFinalSynthesis(input: {
  round: EnsembleRoundState | null | undefined
  hasStructuredSummary: boolean
  attemptedInRuntime: boolean
  missionWasActiveAtStart: boolean
  cancelled: boolean
  returnedControlToUser: boolean
  queuedPromptCount: number
}): boolean {
  const round = input.round
  return Boolean(
    round &&
    round.status === 'running' &&
    round.orchestrationMode === 'continuous' &&
    round.synthesizerParticipantId &&
    !round.synthesisAttemptedAt &&
    round.synthesisStatus !== 'completed' &&
    !input.hasStructuredSummary &&
    !input.attemptedInRuntime &&
    input.missionWasActiveAtStart &&
    !input.cancelled &&
    !input.returnedControlToUser &&
    input.queuedPromptCount === 0 &&
    roundRequiresSynthesis(round.participants)
  )
}

export function buildFinalSynthesisPrompt(originalPrompt: string): string {
  return `TaskWraith final synthesis pass.

Reconcile the completed participant answers for the user's original request below. This is one bounded close-out turn: do not start new implementation work, call tools, fan out, yield, schedule a wakeup, or delegate. Use evidence already present in the round transcript, preserve material disagreements, and do not invent consensus.

Original user request:
${originalPrompt.trim()}

Return exactly one compact block containing every label below:

Round summary:

Decisions:

Corrections:

Open risks:

Next action:

If disagreement remains, record it under Open risks and give the user-facing resolution under Next action.`
}
