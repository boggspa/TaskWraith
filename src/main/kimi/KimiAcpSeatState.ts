import { createHash } from 'crypto'
import { join } from 'path'

export const KIMI_ACP_SEAT_STATE_DIR = 'kimi-acp-seats-v1'

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
