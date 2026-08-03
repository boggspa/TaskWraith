import { describe, expect, it } from 'vitest'
import { computeCumulativeRunBaseMs } from './cumulativeRunTimecode'
import type { ChatRun } from '../../../main/store/types'

/*
 * 1.0.4-AR10 — cumulative session timecode coverage.
 *
 * The cumulative timecode in the composer telemetry readout shows the
 * total wall time spent running this chat: the union of completed-run
 * intervals, plus the live delta from the currently in-flight run or
 * Ensemble round. The base helper caps completed intervals at that live
 * boundary, so parallel seats and completed work in the active round cannot
 * be counted again. The live delta is added inside the React component itself
 * so the timecode ticks once per second without forcing a redraw of the whole
 * App tree on every interval fire.
 *
 * Pinning the base computation in isolation makes the rest of the
 * component behaviour trivially derivable.
 */

function run(overrides: Partial<ChatRun>): ChatRun {
  return {
    runId: 'r',
    startedAt: '2026-05-27T00:00:00.000Z',
    ...overrides
  } as ChatRun
}

describe('computeCumulativeRunBaseMs', () => {
  it('returns 0 for undefined or empty input', () => {
    expect(computeCumulativeRunBaseMs(undefined)).toBe(0)
    expect(computeCumulativeRunBaseMs([])).toBe(0)
  })

  it('measures the combined length of disjoint completed run intervals', () => {
    const runs: ChatRun[] = [
      run({
        runId: 'r1',
        startedAt: '2026-05-27T00:00:00.000Z',
        endedAt: '2026-05-27T00:00:10.000Z'
      }),
      run({
        runId: 'r2',
        startedAt: '2026-05-27T00:01:00.000Z',
        endedAt: '2026-05-27T00:02:30.000Z'
      })
    ]
    // 10s + 90s = 100,000ms
    expect(computeCumulativeRunBaseMs(runs)).toBe(100_000)
  })

  it('merges overlapping completed participant runs', () => {
    const runs: ChatRun[] = [
      run({
        runId: 'r1',
        startedAt: '2026-05-27T00:00:00.000Z',
        endedAt: '2026-05-27T00:00:10.000Z'
      }),
      run({
        runId: 'r2',
        startedAt: '2026-05-27T00:00:05.000Z',
        endedAt: '2026-05-27T00:00:15.000Z'
      })
    ]

    // Two concurrent seats cover 15 seconds of thread wall time, not 20.
    expect(computeCumulativeRunBaseMs(runs)).toBe(15_000)
  })

  it('caps completed intervals at the active round before its live delta is added', () => {
    const runs: ChatRun[] = [
      run({
        runId: 'r1',
        startedAt: '2026-05-27T00:00:00.000Z',
        endedAt: '2026-05-27T00:00:10.000Z'
      }),
      run({
        runId: 'r2',
        startedAt: '2026-05-27T00:00:20.000Z',
        endedAt: '2026-05-27T00:00:40.000Z'
      }),
      run({
        runId: 'r3',
        startedAt: '2026-05-27T00:00:50.000Z',
        endedAt: '2026-05-27T00:01:00.000Z'
      })
    ]

    // Before 00:00:30 there are 10 seconds from r1 and 10 from r2. The
    // live active-round span starts at 00:00:30 and is added once by the UI.
    expect(computeCumulativeRunBaseMs(runs, '2026-05-27T00:00:30.000Z')).toBe(20_000)
  })

  it('skips in-flight runs (no endedAt) so they only contribute via live delta', () => {
    const runs: ChatRun[] = [
      run({
        runId: 'r1',
        startedAt: '2026-05-27T00:00:00.000Z',
        endedAt: '2026-05-27T00:00:10.000Z'
      }),
      run({
        runId: 'r2',
        startedAt: '2026-05-27T00:01:00.000Z'
        // endedAt missing — still running
      })
    ]
    // Only r1's 10s contributes to the base.
    expect(computeCumulativeRunBaseMs(runs)).toBe(10_000)
  })

  it('ignores runs with un-parseable or missing startedAt', () => {
    const runs: ChatRun[] = [
      run({ runId: 'r1', startedAt: 'not a date', endedAt: '2026-05-27T00:00:10.000Z' }),
      run({ runId: 'r2', startedAt: '', endedAt: '2026-05-27T00:00:10.000Z' } as ChatRun),
      run({
        runId: 'r3',
        startedAt: '2026-05-27T00:00:00.000Z',
        endedAt: '2026-05-27T00:00:05.000Z'
      })
    ]
    // Only r3 contributes; bad-date / missing-start rows are dropped.
    expect(computeCumulativeRunBaseMs(runs)).toBe(5_000)
  })

  it('clamps negative durations (endedAt < startedAt) to zero', () => {
    // Real clocks can briefly drift backwards (NTP step, system sleep
    // resume, etc.). A negative delta shouldn't subtract from the
    // accumulator.
    const runs: ChatRun[] = [
      run({
        runId: 'r1',
        startedAt: '2026-05-27T00:00:10.000Z',
        endedAt: '2026-05-27T00:00:00.000Z'
      })
    ]
    expect(computeCumulativeRunBaseMs(runs)).toBe(0)
  })
})
