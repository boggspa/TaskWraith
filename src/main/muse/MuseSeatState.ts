import { createHash } from 'node:crypto'
import { join } from 'node:path'

/**
 * Durable per-chat Muse seat homes.
 *
 * The exec lane mints a disposable `mkdtemp` home per run and destroys it at
 * teardown, which is why Muse has never been able to resume: the session log
 * lives inside `XDG_DATA_HOME/muse/sessions` and dies with the lease. MSP's
 * `session/resume` needs that log to survive a turn boundary, so the MSP lane
 * keeps ONE home per chat seat instead.
 *
 * v1 is a containment boundary, not a storage-format convenience — mirroring
 * `KIMI_ACP_SEAT_STATE_DIR`. Any future change to what a seat home may retain
 * across turns must bump the directory rather than reinterpret existing seats,
 * because a live `session/resume` would otherwise be handed material that was
 * written under the older, weaker retention rule.
 */
export const MUSE_SEAT_STATE_DIR = 'muse-seats-v1'
export const LEGACY_MUSE_SEAT_STATE_DIRS: readonly string[] = []

function museSeatKey(chatId: string, participantId: string): string {
  return createHash('sha256').update(`${chatId}\0${participantId}`).digest('hex').slice(0, 40)
}

/**
 * Stable, opaque path for one TaskWraith chat/participant Muse seat.
 *
 * Hashed so chat ids never become filesystem names and the leaf length is
 * bounded. Keyed by participant as well as chat because ensemble lanes must
 * not share one provider session: two seats resuming the same Muse session
 * would interleave their turns into a single transcript.
 */
export function museSeatStatePath(
  userDataPath: string,
  chatId: string,
  participantId = 'solo'
): string {
  return join(userDataPath, MUSE_SEAT_STATE_DIR, museSeatKey(chatId, participantId))
}

export function museSeatStateRoot(userDataPath: string): string {
  return join(userDataPath, MUSE_SEAT_STATE_DIR)
}

export function legacyMuseSeatStatePaths(
  userDataPath: string,
  chatId: string,
  participantId = 'solo'
): string[] {
  const seatKey = museSeatKey(chatId, participantId)
  return LEGACY_MUSE_SEAT_STATE_DIRS.map((dir) => join(userDataPath, dir, seatKey))
}

export function legacyMuseSeatStateRoots(userDataPath: string): string[] {
  return LEGACY_MUSE_SEAT_STATE_DIRS.map((dir) => join(userDataPath, dir))
}
