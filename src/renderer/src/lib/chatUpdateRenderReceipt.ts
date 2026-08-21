import type {
  ChatUpdateAck,
  ChatUpdateBaseline,
  ChatUpdateDelivery
} from '../../../shared/chatUpdateTransport'

/**
 * Non-gating evidence that React has committed an already transport-accepted
 * update. Kept separate from the fast ACK so a throttled paint can never hold
 * a transcript delivery slot open.
 */
export interface ChatUpdateRenderReceipt {
  chatId: string
  deliveryId: string
  revision: number
  rendererEpoch: string
  deliveryEpoch?: number
  recordHash?: string
  transcriptHash?: string
}

/** One opaque identity per renderer document; a reload always receives a new one. */
export function createRendererChatUpdateEpoch(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) return randomUuid
  return `renderer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function createChatUpdateRenderReceipt(
  delivery: ChatUpdateDelivery,
  baseline: ChatUpdateBaseline,
  rendererEpoch: string
): ChatUpdateRenderReceipt {
  return {
    chatId: delivery.chatId,
    deliveryId: delivery.deliveryId,
    revision: baseline.revision,
    rendererEpoch,
    ...(delivery.deliveryEpoch !== undefined ? { deliveryEpoch: delivery.deliveryEpoch } : {}),
    ...(baseline.recordHash ? { recordHash: baseline.recordHash } : {}),
    ...(baseline.transcriptHash ? { transcriptHash: baseline.transcriptHash } : {})
  }
}

export function buildChatUpdateRenderedAck(receipt: ChatUpdateRenderReceipt): ChatUpdateAck {
  return {
    deliveryId: receipt.deliveryId,
    applied: true,
    phase: 'rendered',
    chatId: receipt.chatId,
    revision: receipt.revision,
    rendererEpoch: receipt.rendererEpoch,
    ...(receipt.deliveryEpoch !== undefined ? { deliveryEpoch: receipt.deliveryEpoch } : {}),
    ...(receipt.recordHash ? { recordHash: receipt.recordHash } : {}),
    ...(receipt.transcriptHash ? { transcriptHash: receipt.transcriptHash } : {})
  }
}
