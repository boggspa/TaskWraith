/**
 * Shared realistic-ack helpers for the chat-update delivery suites.
 *
 * A bare `{ deliveryId, applied: true }` ack carries no hash, so main's
 * acknowledge-time comparison never runs and accept-path tests cannot catch a
 * field-mask divergence (the drifted-baseline NACK storm was invisible to the
 * suite for exactly this reason). These helpers ack the way the renderer
 * does, mirroring its buildChatUpdateAck: phase, chat id, delivery-epoch
 * echo, document epoch, delivery revision, and the applied record and
 * transcript hashes.
 *
 * `ackAsRenderer` is the default for accept-path tests: it applies a
 * structured clone through the real applier and acknowledges the result.
 * Applying main's live delivery object instead would let later main-side
 * mutations rewrite the test's renderer baseline behind its back and mask
 * the divergence a real NACK would report. `buildRendererAck` constructs the
 * ack object for a baseline the caller already holds (multi-phase flows).
 * Reject-path tests (applied:false, wrong revision/hash/epoch) keep calling
 * acknowledge() directly.
 */
import {
  applyChatUpdateDelivery,
  type ChatUpdateAck,
  type ChatUpdateBaseline,
  type ChatUpdateDelivery
} from '../shared/chatUpdateTransport'
import type { ChatUpdateDeliveryCoordinator } from './ChatUpdateDeliveryCoordinator'

/** Document epoch realistic test acks carry. One constant because each test
 *  drives one renderer document; pass an explicit epoch for multi-document
 *  flows. */
export const TEST_RENDERER_EPOCH = 'test-renderer-document'

export function buildRendererAck(
  delivery: ChatUpdateDelivery,
  baseline: ChatUpdateBaseline,
  phase: 'accepted' | 'rendered',
  rendererEpoch: string = TEST_RENDERER_EPOCH
): ChatUpdateAck {
  return {
    deliveryId: delivery.deliveryId,
    applied: true,
    phase,
    chatId: delivery.chatId,
    revision: delivery.revision,
    rendererEpoch,
    ...(delivery.deliveryEpoch !== undefined ? { deliveryEpoch: delivery.deliveryEpoch } : {}),
    ...(baseline.recordHash ? { recordHash: baseline.recordHash } : {}),
    ...(baseline.transcriptHash ? { transcriptHash: baseline.transcriptHash } : {})
  }
}

export function ackAsRenderer(
  coordinator: ChatUpdateDeliveryCoordinator,
  sink: { id: number },
  delivery: ChatUpdateDelivery,
  baseline?: ChatUpdateBaseline,
  rendererEpoch: string = TEST_RENDERER_EPOCH
): { baseline: ChatUpdateBaseline; acknowledged: boolean } {
  const applied = applyChatUpdateDelivery(structuredClone(delivery), baseline)
  if (!applied.ok) throw new Error(applied.reason)
  const acknowledged = coordinator.acknowledge(
    sink.id,
    buildRendererAck(delivery, applied.baseline, 'accepted', rendererEpoch)
  )
  return { baseline: applied.baseline, acknowledged }
}
