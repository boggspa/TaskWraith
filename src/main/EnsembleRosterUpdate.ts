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
      bossmanParticipantId?: string
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
  const secondMarkerWasSpecified = entries.some((entry) =>
    hasOwn.call(entry, 'isSecondInCommand')
  )
  const markedSecondIndexes = entries
    .map((entry, index) => (entry.isSecondInCommand === true ? index : -1))
    .filter((index) => index >= 0)

  if (markedSecondIndexes.length > 1) {
    return { ok: false, error: 'Only one participant may be marked as Captain.' }
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
  const bossmanParticipantId = markedBossmanParticipantId ?? preservedBossmanParticipantId
  const markedSecondInCommandParticipantId =
    markedSecondIndexes.length === 1 ? participants[markedSecondIndexes[0]]?.id : undefined
  const preservedSecondInCommandParticipantId =
    !secondMarkerWasSpecified &&
    previous.secondInCommandParticipantId &&
    previous.secondInCommandParticipantId !== bossmanParticipantId &&
    participants.some(
      (participant) =>
        participant.id === previous.secondInCommandParticipantId &&
        canOwnEnsembleAuthority(participant)
    )
      ? previous.secondInCommandParticipantId
      : undefined
  const secondInCommandParticipantId =
    secondMarkerWasSpecified
      ? markedSecondInCommandParticipantId !== bossmanParticipantId
        ? markedSecondInCommandParticipantId
        : undefined
      : preservedSecondInCommandParticipantId
  // Auto-approval consent belongs to the Ensemble, rather than to the
  // participant currently holding either leadership role. Keep it while a
  // valid Boss or Captain remains in the submitted roster; only clearing the
  // last leadership role revokes the thread-wide consent.
  const hasLeadership = Boolean(bossmanParticipantId || secondInCommandParticipantId)
  const bossmanAutoApprovals =
    hasLeadership ? previous.bossmanAutoApprovals : undefined

  return {
    ok: true,
    ...(bossmanParticipantId ? { bossmanParticipantId } : {}),
    ...(secondInCommandParticipantId ? { secondInCommandParticipantId } : {}),
    ...(hasLeadership ? { bossmanAutoApprovals } : {})
  }
}
