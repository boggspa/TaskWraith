import { describe, expect, it } from 'vitest'
import { TranscriptVisibilityLatency } from './TranscriptVisibilityLatency'

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms
    }
  }
}

describe('TranscriptVisibilityLatency', () => {
  it('measures append to visible on main’s own clock', () => {
    const time = clock(1_000)
    const latency = new TranscriptVisibilityLatency({ now: time.now })
    latency.recordSent('chat-1', 1)
    time.advance(37)
    latency.recordCommitted('chat-1', 1)
    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(1)
    expect(snapshot.p50Ms).toBe(37)
    expect(snapshot.maxMs).toBe(37)
    expect(snapshot.pending).toBe(0)
  })

  it('reports percentiles across a window', () => {
    const time = clock()
    const latency = new TranscriptVisibilityLatency({ now: time.now })
    for (let index = 1; index <= 100; index += 1) {
      latency.recordSent('chat-1', index, time.now())
      time.advance(index)
      latency.recordCommitted('chat-1', index)
    }
    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(100)
    expect(snapshot.p50Ms).toBe(50)
    expect(snapshot.p95Ms).toBe(95)
    expect(snapshot.p99Ms).toBe(99)
    expect(snapshot.maxMs).toBe(100)
  })

  it('exposes the live outstanding lag, which is what a stall actually looks like', () => {
    const time = clock(0)
    const latency = new TranscriptVisibilityLatency({ now: time.now })
    latency.recordSent('chat-1', 1)
    time.advance(2_000)
    latency.recordSent('chat-1', 2)
    time.advance(500)
    const snapshot = latency.snapshot()
    // The percentiles are silent — nothing completed — and that is exactly why
    // oldestPendingMs has to exist.
    expect(snapshot.samples).toBe(0)
    expect(snapshot.pending).toBe(2)
    expect(snapshot.oldestPendingMs).toBe(2_500)
  })

  it('keeps sequences from different chats apart', () => {
    const time = clock()
    const latency = new TranscriptVisibilityLatency({ now: time.now })
    latency.recordSent('chat-a', 1)
    latency.recordSent('chat-b', 1)
    time.advance(10)
    latency.recordCommitted('chat-b', 1)
    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(1)
    expect(snapshot.pending).toBe(1)
  })

  it('counts a receipt that matches nothing instead of inventing a sample', () => {
    const latency = new TranscriptVisibilityLatency()
    latency.recordCommitted('chat-1', 7)
    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(0)
    expect(snapshot.unmatchedReceipts).toBe(1)
  })

  it('counts a duplicate receipt as unmatched rather than double-sampling', () => {
    const time = clock()
    const latency = new TranscriptVisibilityLatency({ now: time.now })
    latency.recordSent('chat-1', 1)
    time.advance(5)
    latency.recordCommitted('chat-1', 1)
    latency.recordCommitted('chat-1', 1)
    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(1)
    expect(snapshot.unmatchedReceipts).toBe(1)
  })

  it('abandons a frame past the pending ceiling so one lost receipt is not a permanent stall reading', () => {
    const time = clock(0)
    const latency = new TranscriptVisibilityLatency({ now: time.now, pendingCeilingMs: 1_000 })
    latency.recordSent('chat-1', 1)
    time.advance(1_500)
    latency.recordSent('chat-1', 2)
    const snapshot = latency.snapshot()
    expect(snapshot.abandoned).toBe(1)
    expect(snapshot.pending).toBe(1)
    expect(snapshot.oldestPendingMs).toBe(0)
  })

  it('bounds outstanding frames, abandoning the oldest', () => {
    const time = clock()
    const latency = new TranscriptVisibilityLatency({ now: time.now, maxPending: 2 })
    latency.recordSent('chat-1', 1)
    latency.recordSent('chat-1', 2)
    latency.recordSent('chat-1', 3)
    const snapshot = latency.snapshot()
    expect(snapshot.pending).toBe(2)
    expect(snapshot.abandoned).toBe(1)
    // The evicted frame's late receipt must not become a sample.
    latency.recordCommitted('chat-1', 1)
    expect(latency.snapshot().samples).toBe(0)
  })

  it('bounds retained samples by dropping the OLDEST, so a stall stays visible', () => {
    const time = clock()
    const latency = new TranscriptVisibilityLatency({ now: time.now, maxSamples: 3 })
    for (const delay of [1, 1, 1, 900]) {
      latency.recordSent('chat-1', delay === 900 ? 99 : delay, time.now())
      time.advance(delay)
      latency.recordCommitted('chat-1', delay === 900 ? 99 : delay)
    }
    const snapshot = latency.snapshot()
    expect(snapshot.samples).toBe(3)
    expect(snapshot.maxMs).toBe(900)
  })

  it('forgets a chat’s outstanding frames without touching another chat’s', () => {
    const time = clock()
    const latency = new TranscriptVisibilityLatency({ now: time.now })
    latency.recordSent('chat-a', 1)
    latency.recordSent('chat-ab', 1)
    latency.recordSent('chat-b', 1)
    latency.forget('chat-a')
    const snapshot = latency.snapshot()
    // Prefix matching must not take 'chat-ab' with 'chat-a'.
    expect(snapshot.pending).toBe(2)
  })

  it('resets the completed window but keeps outstanding frames', () => {
    const time = clock()
    const latency = new TranscriptVisibilityLatency({ now: time.now })
    latency.recordSent('chat-1', 1)
    time.advance(4)
    latency.recordCommitted('chat-1', 1)
    latency.recordSent('chat-1', 2)
    expect(latency.snapshot({ reset: true }).samples).toBe(1)
    const next = latency.snapshot()
    expect(next.samples).toBe(0)
    expect(next.pending).toBe(1)
  })

  it('ignores malformed identifiers rather than polluting the histogram', () => {
    const latency = new TranscriptVisibilityLatency()
    latency.recordSent('', 1)
    latency.recordSent('chat-1', 0)
    latency.recordSent('chat-1', 1.5)
    latency.recordCommitted('', 1)
    const snapshot = latency.snapshot()
    expect(snapshot.pending).toBe(0)
    expect(snapshot.samples).toBe(0)
    expect(snapshot.unmatchedReceipts).toBe(0)
  })

  it('reports zeroes on an empty window rather than NaN', () => {
    const snapshot = new TranscriptVisibilityLatency().snapshot()
    expect(snapshot).toMatchObject({
      samples: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      oldestPendingMs: 0,
      pending: 0
    })
  })
})
