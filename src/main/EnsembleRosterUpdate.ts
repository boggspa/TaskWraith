type BossmanRosterEntry = {
  isBossman?: boolean
}

type BossmanRosterParticipant = {
  id: string
}

export type BossmanRosterUpdateResolution<TAutoApprovals = unknown> =
  | {
      ok: true
      bossmanParticipantId?: string
      bossmanAutoApprovals?: TAutoApprovals
    }
  | {
      ok: false
      error: string
    }

const hasOwn = Object.prototype.hasOwnProperty

export function resolveRosterUpdateBossmanAssignment<TAutoApprovals>(
  entries: ReadonlyArray<BossmanRosterEntry>,
  participants: ReadonlyArray<BossmanRosterParticipant>,
  previous: {
    bossmanParticipantId?: string
    bossmanAutoApprovals?: TAutoApprovals
  }
): BossmanRosterUpdateResolution<TAutoApprovals> {
  const markerWasSpecified = entries.some((entry) => hasOwn.call(entry, 'isBossman'))
  const markedIndexes = entries
    .map((entry, index) => (entry.isBossman === true ? index : -1))
    .filter((index) => index >= 0)

  if (markedIndexes.length > 1) {
    return { ok: false, error: 'Only one participant may be marked as Bossman.' }
  }

  const markedBossmanParticipantId =
    markedIndexes.length === 1 ? participants[markedIndexes[0]]?.id : undefined
  const preservedBossmanParticipantId =
    !markerWasSpecified &&
    previous.bossmanParticipantId &&
    participants.some((participant) => participant.id === previous.bossmanParticipantId)
      ? previous.bossmanParticipantId
      : undefined
  const bossmanParticipantId = markedBossmanParticipantId ?? preservedBossmanParticipantId
  const bossmanAutoApprovals =
    bossmanParticipantId && bossmanParticipantId === previous.bossmanParticipantId
      ? previous.bossmanAutoApprovals
      : undefined

  return bossmanParticipantId
    ? { ok: true, bossmanParticipantId, bossmanAutoApprovals }
    : { ok: true }
}
