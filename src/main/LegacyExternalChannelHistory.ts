import type { ChatMessage } from './store/types'

/**
 * Retired external chat gateways used to persist inbound rows with this
 * metadata kind. Keep recognizing it so old local history cannot be replayed
 * as ordinary user instructions after the gateway code is removed.
 */
export function isRetiredExternalChannelInboundMessage(message: ChatMessage): boolean {
  return message.metadata?.kind === 'channelInbound'
}
