import { describe, expect, it } from 'vitest'
import { computeCumulativeRunBaseMs } from './cumulativeRunTimecode'
import type { ChatRun } from '../../../main/store/types'

/*
 * 1.0.4-AR10 — cumulative session timecode coverage.
 *
 * The cumulative timecode in the composer telemetry readout shows the
 * total wall time spent running this chat: Σ (endedAt - startedAt)
 * across every completed run, plus the live delta from the currently-
 * in-flight run. The base helper here only sums completed runs; the
 * live delta is added inside the React component itself so the
 * timecode ticks once per second without forcing a redraw of the whole
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

  it('sums (endedAt - startedAt) across every completed run', () => {
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
