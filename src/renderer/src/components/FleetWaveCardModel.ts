import type { ChatMessage } from '../../../main/store/types'

export function isFleetWaveMessage(message: ChatMessage | null | undefined): boolean {
  return message?.metadata?.kind === 'fleetWave'
}
