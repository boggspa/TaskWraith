export const MAX_ENSEMBLE_CAPTAINS = 3

export interface EnsembleAuthorityParticipant {
  id: string
  order?: number
  stageRole?: string
}

export interface NormalizeEnsembleAuthorityInput {
  participants: readonly EnsembleAuthorityParticipant[]
  bossmanParticipantId?: unknown
  captainParticipantIds?: unknown
  secondInCommandParticipantId?: unknown
  recoverBoss?: boolean
}

export interface NormalizedEnsembleAuthority {
  bossmanParticipantId?: string
  captainParticipantIds: string[]
  /** Compatibility mirror of `captainParticipantIds[0]`. */
  secondInCommandParticipantId?: string
}

function orderedAuthorityParticipants(
  participants: readonly EnsembleAuthorityParticipant[]
): EnsembleAuthorityParticipant[] {
  return participants
    .map((participant, index) => ({ participant, index }))
    .filter(
      ({ participant }) =>
        typeof participant.id === 'string' &&
        participant.id.length > 0 &&
        participant.stageRole !== 'background'
    )
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.participant.order)
        ? Number(left.participant.order)
        : left.index + 1
      const rightOrder = Number.isFinite(right.participant.order)
        ? Number(right.participant.order)
        : right.index + 1
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return left.index - right.index
    })
    .map(({ participant }) => participant)
    .filter(
      (participant, index, ordered) =>
        ordered.findIndex((candidate) => candidate.id === participant.id) === index
    )
}

/**
 * Canonicalize persisted Ensemble authority without treating availability as
 * configuration. Disabled foreground seats remain configured; background and
 * missing seats cannot own authority.
 *
 * A present plural array is authoritative, including an explicitly empty
 * array. Legacy scalar records are promoted to a singleton only when the
 * plural field is absent or malformed.
 */
export function normalizeEnsembleAuthority(
  input: NormalizeEnsembleAuthorityInput
): NormalizedEnsembleAuthority {
  const ordered = orderedAuthorityParticipants(input.participants)
  const eligibleIds = new Set(ordered.map((participant) => participant.id))
  const configuredBoss =
    typeof input.bossmanParticipantId === 'string' && eligibleIds.has(input.bossmanParticipantId)
      ? input.bossmanParticipantId
      : undefined
  const bossmanParticipantId =
    configuredBoss ?? (input.recoverBoss === false ? undefined : ordered[0]?.id)

  const rawCaptains = Array.isArray(input.captainParticipantIds)
    ? input.captainParticipantIds
    : typeof input.secondInCommandParticipantId === 'string'
      ? [input.secondInCommandParticipantId]
      : []
  const requestedCaptainIds = new Set(
    rawCaptains.filter((participantId): participantId is string =>
      Boolean(typeof participantId === 'string' && participantId)
    )
  )
  const captainParticipantIds = ordered
    .map((participant) => participant.id)
    .filter(
      (participantId) =>
        participantId !== bossmanParticipantId && requestedCaptainIds.has(participantId)
    )
    .slice(0, MAX_ENSEMBLE_CAPTAINS)

  return {
    ...(bossmanParticipantId ? { bossmanParticipantId } : {}),
    captainParticipantIds,
    ...(captainParticipantIds[0] ? { secondInCommandParticipantId: captainParticipantIds[0] } : {})
  }
}
