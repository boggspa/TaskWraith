/**
 * fanoutLaneJumpTargets — from a working seat back to its lane's viewport card.
 *
 * A fan-out lane can still be working long after the round moved on: an
 * authoritative seat calls out further fan-outs, the transcript grows, and the
 * early lane's card ends up far off screen while its "working…" row stays
 * pinned at the bottom with everyone else's. The row is the only durable clue
 * that the seat is still alive, so it is also the natural place to click to get
 * back to what it is producing.
 *
 * The pairing itself already exists in the other direction: `workingLaneParticipantIds`
 * feeds `isEnsembleFanoutLaneWorking`, which lights each busy lane card's rim.
 * This is that same seat↔lane correspondence read the other way, deliberately
 * off the SAME `metadata.ensembleParticipantId` so a seat whose rim is lit can
 * always be jumped to, and one whose rim is dark never offers a dead target.
 *
 * LAST lane row wins. A seat that has worked several rounds has a card per
 * round, and the one it is filling right now is the most recent — jumping to
 * an older round's card would land the reader on finished output and read as a
 * broken link.
 */
import type { ChatMessage, ConcurrentLane } from '../../../main/store/types'
import { isEnsembleFanoutResultMessage } from '../../../shared/fanoutLaneGrouping'
import { LIVE_ENSEMBLE_LANE_STATUSES } from '../../../shared/ensembleRoundLifecycle'
import { ensembleFanoutParticipantId } from '../components/EnsembleFanoutResultCardModel'

export type FanoutLaneJumpTarget = {
  /** Message id of the lane's result card. */
  messageId: string
  /** Collision-proof row key (`${id}#${index}`) for the transcript's row maps.
   * Historical/imported data can repeat message ids, so the jump carries the
   * row key too rather than trusting the id to be unique. */
  rowKey: string
}

/**
 * Map each seat that owns a fan-out lane card to the card it should jump to.
 *
 * Keyed by `metadata.ensembleParticipantId` — the same key the working row
 * carries as `WorkingIndicatorPresentation.participantId`. Seats with no lane
 * card are absent, which is what gates the affordance: no entry, no jump. When
 * the caller supplies current lanes, a card must match the exact live lane/run;
 * a historical card from the same participant can never become a false target
 * while a replacement lane is still waiting for its first output.
 */
export function buildFanoutLaneJumpTargets(
  messages: readonly ChatMessage[],
  currentLanes?: readonly ConcurrentLane[]
): ReadonlyMap<string, FanoutLaneJumpTarget> {
  const targets = new Map<string, FanoutLaneJumpTarget>()
  if (!Array.isArray(messages)) return targets
  const currentLaneByParticipant = currentLanes
    ? currentLanes.reduce<Map<string, ConcurrentLane>>((byParticipant, lane) => {
        if (!LIVE_ENSEMBLE_LANE_STATUSES.has(lane.status)) return byParticipant
        const previous = byParticipant.get(lane.participantId)
        const previousStartedAt = Date.parse(previous?.startedAt || '')
        const laneStartedAt = Date.parse(lane.startedAt || '')
        if (
          !previous ||
          (Number.isFinite(laneStartedAt) &&
            (!Number.isFinite(previousStartedAt) || laneStartedAt > previousStartedAt))
        ) {
          byParticipant.set(lane.participantId, lane)
        }
        return byParticipant
      }, new Map())
    : null
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || !isEnsembleFanoutResultMessage(message)) continue
    const participantId = ensembleFanoutParticipantId(message)
    if (!participantId) continue
    if (currentLaneByParticipant) {
      const currentLane = currentLaneByParticipant.get(participantId)
      const matchesCurrentLane = Boolean(
        currentLane &&
        message.metadata?.ensembleLaneId === currentLane.laneId &&
        (!currentLane.runId || !message.runId || message.runId === currentLane.runId)
      )
      if (!matchesCurrentLane) continue
    }
    // Plain overwrite, walking forward: the last card for a seat is the live one.
    targets.set(participantId, {
      messageId: message.id,
      rowKey: `${message.id}#${index}`
    })
  }
  return targets
}
