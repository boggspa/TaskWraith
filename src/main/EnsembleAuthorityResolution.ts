import { normalizeEnsembleAuthority } from '../shared/ensembleAuthority'

const UNAVAILABLE_AUTHORITY_STATUSES = new Set(['failed', 'unreachable', 'cancelled', 'skipped'])

export interface EnsembleAuthorityRosterParticipant {
  id: string
  order?: number
  enabled?: boolean
  stageRole?: string
}

export interface EnsembleAuthorityRoundParticipantState {
  participantId: string
  status: string
}

export interface ResolveEnsembleAuthorityInput {
  participants: readonly EnsembleAuthorityRosterParticipant[]
  bossmanParticipantId?: string | null
  captainParticipantIds?: readonly string[] | null
  secondInCommandParticipantId?: string | null
  unavailableParticipantIds?: ReadonlySet<string> | readonly string[]
  roundParticipantStates?: readonly EnsembleAuthorityRoundParticipantState[]
  roundLive?: boolean
}

function unavailableIds(input: ResolveEnsembleAuthorityInput): ReadonlySet<string> {
  return input.unavailableParticipantIds instanceof Set
    ? input.unavailableParticipantIds
    : new Set(input.unavailableParticipantIds || [])
}

export function configuredEnsembleCaptainParticipantIds(
  input: Pick<
    ResolveEnsembleAuthorityInput,
    | 'participants'
    | 'bossmanParticipantId'
    | 'captainParticipantIds'
    | 'secondInCommandParticipantId'
  >
): string[] {
  return normalizeEnsembleAuthority({
    participants: input.participants,
    bossmanParticipantId: input.bossmanParticipantId,
    captainParticipantIds: input.captainParticipantIds,
    secondInCommandParticipantId: input.secondInCommandParticipantId,
    recoverBoss: false
  }).captainParticipantIds
}

export function isEnsembleAuthorityParticipantAvailable(
  input: ResolveEnsembleAuthorityInput,
  participantId: string | undefined
): boolean {
  if (!participantId) return false
  const participant = input.participants.find((candidate) => candidate.id === participantId)
  if (!participant || participant.enabled === false || participant.stageRole === 'background') {
    return false
  }
  if (unavailableIds(input).has(participantId)) return false
  if (!input.roundLive) return true
  const state = input.roundParticipantStates?.find(
    (candidate) => candidate.participantId === participantId
  )
  return Boolean(state && !UNAVAILABLE_AUTHORITY_STATUSES.has(state.status))
}

/** Select exactly one acting Captain in canonical roster order. */
export function resolveActingCaptainParticipantId(
  input: ResolveEnsembleAuthorityInput
): string | undefined {
  return configuredEnsembleCaptainParticipantIds(input).find((participantId) =>
    isEnsembleAuthorityParticipantAvailable(input, participantId)
  )
}
