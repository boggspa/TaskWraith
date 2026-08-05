export const MAX_ENSEMBLE_CAPTAINS = 3

export interface EnsembleAuthorityParticipant {
  id: string
  order?: number
  stageRole?: string
  /**
   * Availability, not configuration — consulted ONLY when recovering a Boss.
   * Callers that project a narrower shape (round participant states) simply
   * omit it and keep the roster-order recovery they always had.
   */
  enabled?: boolean
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
 * Recovery is the one place availability does speak. Honouring a disabled Boss
 * the user pinned is respecting a choice; RECOVERING onto a seat they switched
 * off is inventing one — and downstream that invented Boss picks the solo
 * provider on Ensemble→Solo. So recovery walks to the first ENABLED foreground
 * seat, falling back to the first foreground seat when every seat is off (an
 * Ensemble still has to retain a Boss).
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
  const recoveredBoss =
    ordered.find((participant) => participant.enabled !== false)?.id ?? ordered[0]?.id
  const bossmanParticipantId =
    configuredBoss ?? (input.recoverBoss === false ? undefined : recoveredBoss)

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
