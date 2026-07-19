import { createHash } from 'crypto'
import { join } from 'path'

/**
 * v2 is a containment boundary, not a storage-format convenience. v1 sessions
 * were born with the real workspace as process/session cwd and must never be
 * visible to a new production `session/resume` attempt.
 */
export const KIMI_ACP_SEAT_STATE_DIR = 'kimi-acp-seats-v2'
export const LEGACY_KIMI_ACP_SEAT_STATE_DIRS = ['kimi-acp-seats-v1'] as const

/** Stable, opaque path for one TaskWraith chat/participant Kimi ACP seat. */
export function kimiAcpSeatStatePath(
  userDataPath: string,
  chatId: string,
  participantId = 'solo'
): string {
  const seatKey = createHash('sha256')
    .update(`${chatId}\0${participantId}`)
    .digest('hex')
    .slice(0, 40)
  return join(userDataPath, KIMI_ACP_SEAT_STATE_DIR, seatKey)
}

export function kimiAcpSeatStateRoot(userDataPath: string): string {
  return join(userDataPath, KIMI_ACP_SEAT_STATE_DIR)
}

export function legacyKimiAcpSeatStatePaths(
  userDataPath: string,
  chatId: string,
  participantId = 'solo'
): string[] {
  const seatKey = createHash('sha256')
    .update(`${chatId}\0${participantId}`)
    .digest('hex')
    .slice(0, 40)
  return LEGACY_KIMI_ACP_SEAT_STATE_DIRS.map((dir) => join(userDataPath, dir, seatKey))
}

export function legacyKimiAcpSeatStateRoots(userDataPath: string): string[] {
  return LEGACY_KIMI_ACP_SEAT_STATE_DIRS.map((dir) => join(userDataPath, dir))
}
