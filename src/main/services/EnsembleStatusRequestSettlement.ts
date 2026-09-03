import type { EnsembleParticipant, EnsembleParticipantStatus } from '../store/types'

/**
 * Round statuses that mean a targeted seat has finished with a Boss status
 * request: it answered, handed control on, or its attempt ended.
 */
const SETTLED_ROUND_STATUSES: ReadonlySet<EnsembleParticipantStatus> = new Set([
  'answered',
  'yielded',
  'skipped',
  'failed',
  'cancelled',
  'unreachable'
])

/**
 * Has this target of an open `request_status` finished with it?
 *
 * The round status is the ordinary answer. The second clause is the fix for a
 * request that could never close: a seat the user switched off, or one removed
 * from the roster, has no round entry and never runs, so a request naming it
 * stayed `open` for the life of the chat — and
 * `narrowContinuationRosterToOpenWork` kept re-admitting that seat every
 * continuous pass on the strength of it.
 *
 * A target that cannot take a turn has already given every answer it is going
 * to. This deliberately does NOT treat a merely idle or background seat as
 * settled: those can still speak, and closing early would drop a check-in the
 * Boss is entitled to wait for.
 */
export function isBossmanStatusTargetSettled(
  roundStatus: EnsembleParticipantStatus | undefined,
  rosterParticipant: EnsembleParticipant | undefined
): boolean {
  if (roundStatus && SETTLED_ROUND_STATUSES.has(roundStatus)) return true
  return isBossmanStatusTargetUnanswerable(rosterParticipant)
}

/**
 * Can this seat never answer, no matter how long the request waits?
 *
 * Strictly narrower than `isBossmanStatusTargetSettled`, and the difference
 * matters: an `answered` seat IS settled but is NOT unanswerable — the
 * authority may re-summon it with `allowAnsweredParticipant`, and treating it
 * as unanswerable at creation would close the request before the re-summoned
 * turn ever ran.
 */
export function isBossmanStatusTargetUnanswerable(
  rosterParticipant: EnsembleParticipant | undefined
): boolean {
  if (!rosterParticipant) return true
  return !rosterParticipant.enabled
}
