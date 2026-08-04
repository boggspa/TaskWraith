import { MAX_ENSEMBLE_CAPTAINS, normalizeEnsembleAuthority } from '../shared/ensembleAuthority'

type BossmanRosterEntry = {
  isBossman?: boolean
  isSecondInCommand?: boolean
}

type BossmanRosterParticipant = {
  id: string
  stageRole?: string
}

export type BossmanRosterUpdateResolution<TAutoApprovals = unknown> =
  | {
      ok: true
      bossmanParticipantId: string
      captainParticipantIds: string[]
      secondInCommandParticipantId?: string
      bossmanAutoApprovals?: TAutoApprovals
    }
  | {
      ok: false
      error: string
    }

const hasOwn = Object.prototype.hasOwnProperty

function canOwnEnsembleAuthority(participant: BossmanRosterParticipant | undefined): boolean {
  return Boolean(participant && participant.stageRole !== 'background')
}

export function resolveRosterUpdateBossmanAssignment<TAutoApprovals>(
  entries: ReadonlyArray<BossmanRosterEntry>,
  participants: ReadonlyArray<BossmanRosterParticipant>,
  previous: {
    bossmanParticipantId?: string
    captainParticipantIds?: string[]
    secondInCommandParticipantId?: string
    bossmanAutoApprovals?: TAutoApprovals
  }
): BossmanRosterUpdateResolution<TAutoApprovals> {
  const markerWasSpecified = entries.some((entry) => hasOwn.call(entry, 'isBossman'))
  const markedIndexes = entries
    .map((entry, index) => (entry.isBossman === true ? index : -1))
    .filter((index) => index >= 0)

  if (markedIndexes.length > 1) {
    return { ok: false, error: 'Only one participant may be marked as Boss.' }
  }
  if (markerWasSpecified && markedIndexes.length !== 1) {
    return { ok: false, error: 'Exactly one participant must be marked as Boss.' }
  }
  const secondMarkerWasSpecified = entries.some((entry) =>
    hasOwn.call(entry, 'isSecondInCommand')
  )
  const markedSecondIndexes = entries
    .map((entry, index) => (entry.isSecondInCommand === true ? index : -1))
    .filter((index) => index >= 0)

  if (markedSecondIndexes.length > MAX_ENSEMBLE_CAPTAINS) {
    return {
      ok: false,
      error: `Up to ${MAX_ENSEMBLE_CAPTAINS} participants may be marked as Captain.`
    }
  }
  if (
    [...markedIndexes, ...markedSecondIndexes].some(
      (index) => !canOwnEnsembleAuthority(participants[index])
    )
  ) {
    return {
      ok: false,
      error: 'Background participants cannot be assigned as Boss or Captain.'
    }
  }

  const markedBossmanParticipantId =
    markedIndexes.length === 1 ? participants[markedIndexes[0]]?.id : undefined
  const preservedBossmanParticipantId =
    !markerWasSpecified &&
    previous.bossmanParticipantId &&
    participants.some(
      (participant) =>
        participant.id === previous.bossmanParticipantId && canOwnEnsembleAuthority(participant)
    )
      ? previous.bossmanParticipantId
      : undefined
  if (
    !markerWasSpecified &&
    previous.bossmanParticipantId &&
    !preservedBossmanParticipantId
  ) {
    return {
      ok: false,
      error:
        'Removing or demoting the configured Boss requires assigning its replacement in the same roster update.'
    }
  }
  const recoveredBossmanParticipantId = participants.find(canOwnEnsembleAuthority)?.id
  const bossmanParticipantId =
    markedBossmanParticipantId ?? preservedBossmanParticipantId ?? recoveredBossmanParticipantId
  if (!bossmanParticipantId) {
    return { ok: false, error: 'An Ensemble roster requires one non-background Boss.' }
  }
  const authority = normalizeEnsembleAuthority({
    participants,
    bossmanParticipantId,
    captainParticipantIds: secondMarkerWasSpecified
      ? markedSecondIndexes
          .map((index) => participants[index]?.id)
          .filter((participantId): participantId is string => Boolean(participantId))
      : previous.captainParticipantIds,
    secondInCommandParticipantId: previous.secondInCommandParticipantId,
    recoverBoss: false
  })
  // Auto-approval consent belongs to the Ensemble, rather than to the
  // participant currently holding either leadership role. Keep it while a
  // valid Boss or Captain remains in the submitted roster; only clearing the
  // last leadership role revokes the thread-wide consent.
  const bossmanAutoApprovals = previous.bossmanAutoApprovals

  return {
    ok: true,
    bossmanParticipantId,
    captainParticipantIds: authority.captainParticipantIds,
    ...(authority.secondInCommandParticipantId
      ? { secondInCommandParticipantId: authority.secondInCommandParticipantId }
      : {}),
    ...(bossmanAutoApprovals ? { bossmanAutoApprovals } : {})
  }
}
