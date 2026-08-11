import { describe, expect, it } from 'vitest'
import { PiLiveSteerTracker, parsePiQueueUpdate, piLiveSteerEnabled } from './PiSteerDelivery'

const STEER = 'STEER_MARKER: also mention pineapple.'

describe('parsePiQueueUpdate', () => {
  it('reads pi’s queue_update payload', () => {
    expect(parsePiQueueUpdate({ type: 'queue_update', steering: [STEER], followUp: [] })).toEqual({
      steering: [STEER],
      followUp: []
    })
  })

  it('ignores every other line shape so the raw stream can be fed in', () => {
    expect(parsePiQueueUpdate({ type: 'turn_end' })).toBeNull()
    expect(parsePiQueueUpdate({ type: 'response', command: 'steer', success: true })).toBeNull()
    expect(parsePiQueueUpdate(null)).toBeNull()
    expect(parsePiQueueUpdate(['queue_update'])).toBeNull()
  })

  it('tolerates missing or non-string queue members', () => {
    expect(parsePiQueueUpdate({ type: 'queue_update' })).toEqual({ steering: [], followUp: [] })
    expect(parsePiQueueUpdate({ type: 'queue_update', steering: [STEER, 7] })).toEqual({
      steering: [STEER],
      followUp: []
    })
  })
})

describe('PiLiveSteerTracker', () => {
  it('reports delivery only after the entry is seen queued and then gone', () => {
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', STEER)
    // Probe trace: pi acks the steer and emits the queue holding it...
    expect(tracker.observeQueueUpdate({ steering: [STEER], followUp: [] })).toEqual([])
    expect(tracker.hasPending).toBe(true)
    // ...then drains it at the boundary as it starts the carrying user message.
    expect(tracker.observeQueueUpdate({ steering: [], followUp: [] })).toEqual(['entry-1'])
    expect(tracker.hasPending).toBe(false)
  })

  it('never infers delivery from an entry that was never seen queued', () => {
    // The post-settle loss window (probe finding 3): pi acks success:true but
    // the frame is never delivered. An empty queue must not read as delivery.
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', STEER)
    expect(tracker.observeQueueUpdate({ steering: [], followUp: [] })).toEqual([])
    expect(tracker.takeUndelivered()).toEqual(['entry-1'])
  })

  it('leaves post-settle acked entries undelivered for the boundary path', () => {
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', STEER)
    // pi queued it (queue_update fires even after agent_settled) but no further
    // turn ever runs, so no drain is observed before the process exits.
    tracker.observeQueueUpdate({ steering: [STEER], followUp: [] })
    expect(tracker.takeUndelivered()).toEqual(['entry-1'])
    expect(tracker.hasPending).toBe(false)
  })

  it('drains FIFO when several entries carry identical text', () => {
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', STEER)
    tracker.registerPending('entry-2', STEER)
    tracker.observeQueueUpdate({ steering: [STEER, STEER], followUp: [] })
    // One slot left: pi drains oldest-first, so the survivor is entry-2.
    expect(tracker.observeQueueUpdate({ steering: [STEER], followUp: [] })).toEqual(['entry-1'])
    expect(tracker.pendingEntryIds()).toEqual(['entry-2'])
    expect(tracker.observeQueueUpdate({ steering: [], followUp: [] })).toEqual(['entry-2'])
  })

  it('tracks distinct texts independently', () => {
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', 'first')
    tracker.registerPending('entry-2', 'second')
    tracker.observeQueueUpdate({ steering: ['first', 'second'], followUp: [] })
    expect(tracker.observeQueueUpdate({ steering: ['second'], followUp: [] })).toEqual(['entry-1'])
    expect(tracker.pendingEntryIds()).toEqual(['entry-2'])
  })

  it('ignores duplicate registrations and empty input', () => {
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', STEER)
    tracker.registerPending('entry-1', STEER)
    tracker.registerPending('', STEER)
    tracker.registerPending('entry-2', '')
    expect(tracker.pendingEntryIds()).toEqual(['entry-1'])
  })

  it('is unaffected by the follow-up queue', () => {
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', STEER)
    tracker.observeQueueUpdate({ steering: [STEER], followUp: [] })
    expect(tracker.observeQueueUpdate({ steering: [], followUp: [STEER] })).toEqual(['entry-1'])
  })

  it('no-ops with nothing pending', () => {
    const tracker = new PiLiveSteerTracker()
    expect(tracker.observeQueueUpdate({ steering: [STEER], followUp: [] })).toEqual([])
    expect(tracker.takeUndelivered()).toEqual([])
  })
})

describe('piLiveSteerEnabled', () => {
  it('is ON by default with explicit false kill-switch values', () => {
    expect(piLiveSteerEnabled({})).toBe(true)
    expect(piLiveSteerEnabled({ TASKWRAITH_PI_LIVE_STEER: '' })).toBe(true)
    for (const value of ['0', 'false', 'FALSE', ' no ', 'off']) {
      expect(piLiveSteerEnabled({ TASKWRAITH_PI_LIVE_STEER: value })).toBe(false)
    }
  })

  it('enables on recognized true values', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(piLiveSteerEnabled({ TASKWRAITH_PI_LIVE_STEER: value })).toBe(true)
    }
  })
})

/**
 * Replay of output captured from the REAL pi 0.82.1 binary during the
 * 2026-07-29 probe (`pi --mode rpc` against a local mock upstream, no spend).
 * These are the verbatim `queue_update` lines each scenario produced — the
 * regression guard for the finding that separates cases A/B/D from case C.
 */
const PROBE_STEER = 'STEER_MARKER: also mention the word pineapple in your final answer.'
const PROBE_QUEUE_UPDATES = {
  // A: steer written while a bash tool call was executing.
  midTool: [
    { type: 'queue_update', steering: [PROBE_STEER], followUp: [] },
    { type: 'queue_update', steering: [], followUp: [] }
  ],
  // B: steer written while the FINAL assistant text was streaming.
  midFinalText: [
    { type: 'queue_update', steering: [PROBE_STEER], followUp: [] },
    { type: 'queue_update', steering: [], followUp: [] }
  ],
  // C: steer written AFTER agent_settled — acked, queued, never delivered.
  postSettle: [{ type: 'queue_update', steering: [PROBE_STEER], followUp: [] }],
  // D: as A, on a session-backed run (--session-dir + --session-id).
  sessionBacked: [
    { type: 'queue_update', steering: [PROBE_STEER], followUp: [] },
    { type: 'queue_update', steering: [], followUp: [] }
  ]
} as const

describe('PiLiveSteerTracker against captured pi 0.82.1 output', () => {
  function replay(lines: readonly unknown[]): { delivered: string[]; stranded: string[] } {
    const tracker = new PiLiveSteerTracker()
    tracker.registerPending('entry-1', PROBE_STEER)
    const delivered: string[] = []
    for (const line of lines) {
      const snapshot = parsePiQueueUpdate(line)
      if (snapshot) delivered.push(...tracker.observeQueueUpdate(snapshot))
    }
    return { delivered, stranded: tracker.takeUndelivered() }
  }

  it('confirms delivery for a steer landing mid-tool-execution', () => {
    expect(replay(PROBE_QUEUE_UPDATES.midTool)).toEqual({
      delivered: ['entry-1'],
      stranded: []
    })
  })

  it('confirms delivery for a steer landing during the final assistant text', () => {
    // pi opens an EXTRA turn rather than dropping it — stronger than its docs.
    expect(replay(PROBE_QUEUE_UPDATES.midFinalText)).toEqual({
      delivered: ['entry-1'],
      stranded: []
    })
  })

  it('confirms delivery on a session-backed run', () => {
    expect(replay(PROBE_QUEUE_UPDATES.sessionBacked)).toEqual({
      delivered: ['entry-1'],
      stranded: []
    })
  })

  it('reports the post-settle steer as STRANDED despite pi acking it', () => {
    // The whole reason delivery keys on the drain and not on the ack.
    expect(replay(PROBE_QUEUE_UPDATES.postSettle)).toEqual({
      delivered: [],
      stranded: ['entry-1']
    })
  })
})
