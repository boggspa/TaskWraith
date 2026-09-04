import { beforeEach, describe, expect, it } from 'vitest'
import {
  drainApprovalLatencyMetrics,
  getApprovalLatencySnapshot,
  recordApprovalClickToAck,
  recordApprovalClickToAckFrom,
  recordApprovalRendererReceipt,
  resetApprovalLatencyMetrics,
  takeApprovalIngressToClickMs
} from './approvalLatencyMetrics'

describe('approvalLatencyMetrics', () => {
  beforeEach(() => resetApprovalLatencyMetrics())

  it('records acked click-to-ACK samples with explicit durations', () => {
    recordApprovalClickToAck('req-1', 'approve', 123.5, 'acked')
    expect(getApprovalLatencySnapshot()).toEqual({
      acked: [{ requestId: 'req-1', action: 'approve', durationMs: 123.5, outcome: 'acked' }],
      unacked: []
    })
  })

  it('keeps not-acked and error samples in a separate bucket', () => {
    recordApprovalClickToAck('req-1', 'approve', 10, 'not-acked')
    recordApprovalClickToAck('req-2', 'decline', 20, 'error')
    const snapshot = drainApprovalLatencyMetrics()
    expect(snapshot.acked).toEqual([])
    expect(snapshot.unacked.map((sample) => sample.outcome)).toEqual(['not-acked', 'error'])
  })

  it('clamps invalid durations and ignores empty request ids', () => {
    recordApprovalClickToAck('req-neg', 'approve', -5, 'acked')
    recordApprovalClickToAck('req-nan', 'approve', Number.NaN, 'acked')
    recordApprovalClickToAck('', 'approve', 10, 'acked')
    recordApprovalRendererReceipt('')
    const snapshot = getApprovalLatencySnapshot()
    expect(snapshot.acked.map((sample) => sample.durationMs)).toEqual([0, 0])
    expect(takeApprovalIngressToClickMs('')).toBeUndefined()
  })

  it('measures renderer receipt-to-click dwell and consumes the receipt', () => {
    recordApprovalRendererReceipt('req-1', 1000)
    expect(takeApprovalIngressToClickMs('req-1', 1250)).toBe(250)
    // Consumed: a second take finds nothing.
    expect(takeApprovalIngressToClickMs('req-1', 1300)).toBeUndefined()
  })

  it('returns undefined dwell when no receipt exists', () => {
    expect(takeApprovalIngressToClickMs('never-seen', 500)).toBeUndefined()
  })

  it('attaches ingress dwell automatically in the From wrapper', () => {
    recordApprovalRendererReceipt('req-1', 1000)
    // nowMs is internal here; only assert the attached dwell is a finite
    // non-negative number and the sample landed in the acked bucket.
    recordApprovalClickToAckFrom('req-1', 'approve', 900, 'acked')
    const snapshot = getApprovalLatencySnapshot()
    expect(snapshot.acked).toHaveLength(1)
    expect(snapshot.acked[0].ingressToClickMs).toEqual(expect.any(Number))
    expect(snapshot.acked[0].ingressToClickMs).toBeGreaterThanOrEqual(0)
    // Receipt was consumed by the wrapper.
    expect(takeApprovalIngressToClickMs('req-1')).toBeUndefined()
  })

  it('omits ingress dwell when no receipt was recorded', () => {
    recordApprovalClickToAckFrom('req-1', 'approve', 900, 'acked')
    const snapshot = getApprovalLatencySnapshot()
    expect(snapshot.acked).toHaveLength(1)
    expect('ingressToClickMs' in snapshot.acked[0]).toBe(false)
  })

  it('bounds each sample bucket and drops the oldest first', () => {
    for (let i = 0; i < 105; i += 1) {
      recordApprovalClickToAck(`ack-${i}`, 'approve', i, 'acked')
      recordApprovalClickToAck(`unack-${i}`, 'approve', i, 'error')
    }
    const snapshot = getApprovalLatencySnapshot()
    expect(snapshot.acked).toHaveLength(100)
    expect(snapshot.unacked).toHaveLength(100)
    expect(snapshot.acked[0].requestId).toBe('ack-5')
    expect(snapshot.unacked[0].requestId).toBe('unack-5')
  })

  it('bounds pending receipts and evicts the oldest first', () => {
    for (let i = 0; i < 205; i += 1) {
      recordApprovalRendererReceipt(`req-${i}`, i)
    }
    // req-0..req-4 evicted; req-5 is the oldest survivor.
    expect(takeApprovalIngressToClickMs('req-0', 10000)).toBeUndefined()
    expect(takeApprovalIngressToClickMs('req-5', 10000)).toBe(10000 - 5)
  })

  it('drain returns copies, clears samples, and preserves receipts', () => {
    recordApprovalRendererReceipt('req-1', 1000)
    recordApprovalClickToAck('req-1', 'approve', 50, 'acked')
    const drained = drainApprovalLatencyMetrics()
    expect(drained.acked).toHaveLength(1)
    expect(getApprovalLatencySnapshot()).toEqual({ acked: [], unacked: [] })
    // In-flight receipt survives the drain.
    expect(takeApprovalIngressToClickMs('req-1', 1100)).toBe(100)
  })

  it('reset clears samples and receipts', () => {
    recordApprovalRendererReceipt('req-1', 1000)
    recordApprovalClickToAck('req-1', 'approve', 50, 'acked')
    resetApprovalLatencyMetrics()
    expect(getApprovalLatencySnapshot()).toEqual({ acked: [], unacked: [] })
    expect(takeApprovalIngressToClickMs('req-1', 1100)).toBeUndefined()
  })

  it('snapshot copies are detached from the buffers', () => {
    recordApprovalClickToAck('req-1', 'approve', 50, 'acked')
    const snapshot = getApprovalLatencySnapshot()
    snapshot.acked.push({ requestId: 'mut', action: 'x', durationMs: 1, outcome: 'acked' })
    expect(getApprovalLatencySnapshot().acked).toHaveLength(1)
  })
})
