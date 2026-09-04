// Approval latency instrumentation (Wave 3, measurement only).
// Bounded, additive, behaviour-preserving: recording never alters approval
// ordering, persistence authority, dismissal, or IPC semantics. Callers must
// keep measuring on the decision path without branching on these values.
//
// Honest naming: ingress here is the renderer's IPC receipt/scheduling moment
// inside `presentLiveApprovalRequest` — NOT painted-modal timing. This module
// records receipt dwell only and never claims modal-paint timing.
export type ApprovalLatencyOutcome = 'acked' | 'not-acked' | 'error'

export interface ApprovalLatencySample {
  requestId: string
  action: string
  durationMs: number
  outcome: ApprovalLatencyOutcome
  ingressToClickMs?: number
}

export interface ApprovalLatencySnapshot {
  acked: ApprovalLatencySample[]
  unacked: ApprovalLatencySample[]
}

const MAX_LATENCY_SAMPLES_PER_BUCKET = 100
const MAX_PENDING_RECEIPTS = 200

const ackedSamples: ApprovalLatencySample[] = []
const unackedSamples: ApprovalLatencySample[] = []
// requestId -> renderer-receipt timestamp (performance.now basis). Bounded;
// oldest entry is evicted when full. Consumed on click via take* below.
const rendererReceiptByRequestId = new Map<string, number>()

export function approvalLatencyNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function saneDurationMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function pushBounded(bucket: ApprovalLatencySample[], sample: ApprovalLatencySample): void {
  bucket.push(sample)
  while (bucket.length > MAX_LATENCY_SAMPLES_PER_BUCKET) bucket.shift()
}

/**
 * Record renderer receipt/scheduling of an approval request. Call from
 * `presentLiveApprovalRequest`. This is NOT modal-paint timing: it stamps when
 * the renderer received and scheduled the request.
 */
export function recordApprovalRendererReceipt(requestId: string, receivedAtMs?: number): void {
  if (!requestId) return
  const at = receivedAtMs === undefined ? approvalLatencyNow() : receivedAtMs
  if (!Number.isFinite(at)) return
  rendererReceiptByRequestId.delete(requestId)
  rendererReceiptByRequestId.set(requestId, at)
  while (rendererReceiptByRequestId.size > MAX_PENDING_RECEIPTS) {
    const oldest = rendererReceiptByRequestId.keys().next()
    if (oldest.done) break
    rendererReceiptByRequestId.delete(oldest.value)
  }
}

/**
 * Consume the pending receipt for requestId and return the
 * receipt-to-now dwell in ms, or undefined when no receipt exists.
 * Consuming (not just reading) keeps the map bounded across drains.
 */
export function takeApprovalIngressToClickMs(
  requestId: string,
  nowMs?: number
): number | undefined {
  if (!requestId) return undefined
  const receivedAt = rendererReceiptByRequestId.get(requestId)
  if (receivedAt === undefined) return undefined
  rendererReceiptByRequestId.delete(requestId)
  const now = nowMs === undefined ? approvalLatencyNow() : nowMs
  if (!Number.isFinite(now)) return undefined
  return saneDurationMs(now - receivedAt)
}

/**
 * Record one click-to-durable-ACK round trip around
 * `await window.api.respondAgentApproval(...)`. Outcome must reflect whether
 * the durable decision ACKed ('acked'), was refused/kept-open ('not-acked'),
 * or the IPC itself threw ('error'). Never imply acceptance before the ACK:
 * call only after the await settles.
 */
export function recordApprovalClickToAck(
  requestId: string,
  action: string,
  durationMs: number,
  outcome: ApprovalLatencyOutcome,
  ingressToClickMs?: number
): void {
  if (!requestId) return
  const sample: ApprovalLatencySample = {
    requestId,
    action,
    durationMs: saneDurationMs(durationMs),
    outcome
  }
  if (ingressToClickMs !== undefined && Number.isFinite(ingressToClickMs)) {
    sample.ingressToClickMs = Math.max(0, ingressToClickMs)
  }
  pushBounded(outcome === 'acked' ? ackedSamples : unackedSamples, sample)
}

/**
 * Convenience wrapper: stamps the end time, attaches the pending
 * receipt-to-click dwell when one exists, and records. Pass the start
 * timestamp captured immediately before the `respondAgentApproval` await.
 */
export function recordApprovalClickToAckFrom(
  requestId: string,
  action: string,
  startMs: number,
  outcome: ApprovalLatencyOutcome
): void {
  if (!requestId) return
  const endMs = approvalLatencyNow()
  recordApprovalClickToAck(
    requestId,
    action,
    Number.isFinite(startMs) ? endMs - startMs : Number.NaN,
    outcome,
    takeApprovalIngressToClickMs(requestId, endMs)
  )
}

/** Non-destructive copy of both buckets. Receipts are unaffected. */
export function getApprovalLatencySnapshot(): ApprovalLatencySnapshot {
  return {
    acked: ackedSamples.map((sample) => ({ ...sample })),
    unacked: unackedSamples.map((sample) => ({ ...sample }))
  }
}

/** Return the buffered samples and clear both buckets. Receipts survive. */
export function drainApprovalLatencyMetrics(): ApprovalLatencySnapshot {
  const snapshot = getApprovalLatencySnapshot()
  ackedSamples.length = 0
  unackedSamples.length = 0
  return snapshot
}

/** Clear samples and pending receipts. */
export function resetApprovalLatencyMetrics(): void {
  ackedSamples.length = 0
  unackedSamples.length = 0
  rendererReceiptByRequestId.clear()
}
