import type { ChatUpdateAck, ChatUpdateDelivery } from '../../../shared/chatUpdateTransport'
import { computeChatSubRevisions } from '../../../shared/chatUpdateTransport'
import type { ChatRecord } from '../../../main/store/types'

export interface BuildChatUpdateAckInput {
  delivery: Pick<ChatUpdateDelivery, 'deliveryId' | 'revision'> & {
    recordHash?: string
    chat?: ChatRecord
  }
  applied: boolean
  /** Preferred hash source after a successful apply; falls back to delivery. */
  appliedChat?: ChatRecord
  appliedRecordHash?: string
}

/**
 * Builds the renderer → main chat-update ACK. Always includes deliveryId +
 * applied; on success also carries revision + recordHash so main can keep a
 * compact hash+generation baseline without retaining a third full ChatRecord.
 */
export function buildChatUpdateAck(input: BuildChatUpdateAckInput): ChatUpdateAck {
  const { delivery, applied } = input
  const ack: ChatUpdateAck = {
    deliveryId: delivery.deliveryId,
    applied
  }
  if (!applied) return ack

  ack.revision = delivery.revision
  if (typeof input.appliedRecordHash === 'string' && input.appliedRecordHash.length > 0) {
    ack.recordHash = input.appliedRecordHash
    return ack
  }
  if (typeof delivery.recordHash === 'string' && delivery.recordHash.length > 0) {
    ack.recordHash = delivery.recordHash
    return ack
  }
  const chat = input.appliedChat ?? delivery.chat
  if (chat) {
    ack.recordHash = computeChatSubRevisions(chat).recordHash
  }
  return ack
}
