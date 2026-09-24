import type { EnsembleParticipant } from '../store/types'

/**
 * A Boss/Captain control target that is still on the roster but has been
 * switched off by the user, so no routing can reach it.
 *
 * Availability is deliberately kept separate from existence. A disabled seat
 * stays in `ensemble.participants` — that is what the toggle means — so an
 * id lookup finds it and every `invalid_target` guard in the orchestrator
 * passes. The action is then recorded, announced in the round, and dropped by
 * `routeBossmanTargets`, which skips disabled seats. The authority is left
 * holding an `ok: true` receipt for work that can never run.
 *
 * `summon_participant` has always refused this (`summon_target_disabled`);
 * these helpers exist so the branches that never got that check can make the
 * same refusal without each re-deriving it.
 */
export interface EnsembleDisabledBossmanTarget {
  participantId: string
  /** Seat label. `role` is required in practice; provider id is the floor. */
  role: string
}

/**
 * The subset of `targetParticipantIds` that name a real but switched-off seat,
 * in the order the caller supplied them and deduped.
 *
 * Ids that match no seat at all are NOT reported: "no such participant" is a
 * different failure with its own `invalid_target` result, and folding the two
 * together would tell an authority a seat is disabled when it never existed.
 */
export function findDisabledBossmanTargets(
  participants: readonly EnsembleParticipant[],
  targetParticipantIds: readonly string[]
): EnsembleDisabledBossmanTarget[] {
  const seen = new Set<string>()
  const disabled: EnsembleDisabledBossmanTarget[] = []
  for (const participantId of targetParticipantIds) {
    if (!participantId || seen.has(participantId)) continue
    seen.add(participantId)
    const participant = participants.find((entry) => entry.id === participantId)
    // Same sense as `routeBossmanTargets`, deliberately. If the two ever
    // disagree the guard passes a seat routing then drops — the exact bug.
    if (!participant || participant.enabled) continue
    disabled.push({
      participantId: participant.id,
      role: participant.role || participant.provider
    })
  }
  return disabled
}

/**
 * Rejection text for the calling agent. It names the seats, states that the
 * cause is the user's roster toggle rather than a failure, and gives the two
 * ways forward — otherwise an authority that reads only "rejected" retries the
 * same target, which is the loop this whole guard exists to stop.
 */
export function formatDisabledBossmanTargetMessage(
  authorityLabel: string,
  action: string,
  disabled: readonly EnsembleDisabledBossmanTarget[]
): string {
  const names = disabled.map((entry) => entry.role).join(', ')
  const verb = disabled.length === 1 ? 'is' : 'are'
  return (
    `${authorityLabel} ${action} rejected: ${names} ${verb} disabled. ` +
    'Routing cannot reach a switched-off seat, so nothing was recorded. ' +
    'Target an enabled participant, or ask the user to re-enable the seat.'
  )
}
