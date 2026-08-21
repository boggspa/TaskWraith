import type { ChatUpdateAck, ChatUpdateDelivery } from '../../../shared/chatUpdateTransport'
import { computeChatSubRevisions } from '../../../shared/chatUpdateTransport'
import type { ChatRecord } from '../../../main/store/types'

export interface BuildChatUpdateAckInput {
  delivery: Pick<ChatUpdateDelivery, 'deliveryId' | 'revision'> & {
    chatId?: string
    recordHash?: string
    transcriptHash?: string
    deliveryEpoch?: number
    chat?: ChatRecord
  }
  applied: boolean
  /** `accepted` releases main's bounded queue; `rendered` is telemetry only. */
  phase?: ChatUpdateAck['phase']
  /** Opaque renderer-document id, stable only for the current page lifetime. */
  rendererEpoch?: string
  /** Chat the renderer actually applied. Preferred hash source. */
  appliedChat?: ChatRecord
  /** Content hash of that applied chat; must not be the delivery's producer roll. */
  appliedRecordHash?: string
  /** Operation-chain transcript digest from the actual applied baseline. */
  appliedTranscriptHash?: string
}

/**
 * Builds the renderer → main chat-update ACK. Always includes deliveryId +
 * applied; on success also carries revision + recordHash so main can keep a
 * compact hash+generation baseline without retaining a third full ChatRecord.
 *
 * Never echo `delivery.recordHash`. That value is the producer's rolling
 * op-hash; copying it made every ACK match even when apply diverged
 * (measured 2026-08-21: recv==ack while React kept a 2-message list).
 */
export function buildChatUpdateAck(input: BuildChatUpdateAckInput): ChatUpdateAck {
  const { delivery, applied } = input
  const ack: ChatUpdateAck = {
    deliveryId: delivery.deliveryId,
    applied,
    ...(input.phase ? { phase: input.phase } : {}),
    ...(delivery.chatId ? { chatId: delivery.chatId } : {}),
    ...(delivery.deliveryEpoch !== undefined ? { deliveryEpoch: delivery.deliveryEpoch } : {}),
    ...(input.rendererEpoch ? { rendererEpoch: input.rendererEpoch } : {})
  }
  if (!applied) return ack

  ack.revision = delivery.revision
  if (typeof input.appliedTranscriptHash === 'string' && input.appliedTranscriptHash.length > 0) {
    ack.transcriptHash = input.appliedTranscriptHash
  }
  if (typeof input.appliedRecordHash === 'string' && input.appliedRecordHash.length > 0) {
    ack.recordHash = input.appliedRecordHash
    return ack
  }
  const chat = input.appliedChat ?? delivery.chat
  if (chat) {
    ack.recordHash = computeChatSubRevisions(chat).recordHash
  }
  return ack
}
