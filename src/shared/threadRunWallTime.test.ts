import { describe, expect, it } from 'vitest'
import {
  computeThreadRunWallMs,
  projectThreadRunWallMs,
  readThreadRunWallMs
} from './threadRunWallTime'

/*
 * The union math itself is pinned by `cumulativeRunTimecode.test.ts`, which is
 * the older golden and still exercises this code through the renderer wrapper.
 * These cases cover the two things that are NEW here: the projection form (no
 * live boundary, because a projector does not know which run a later reader
 * treats as live) and the reader that has to survive rows written before the
 * field existed.
 */

describe('projectThreadRunWallMs', () => {
  it('measures the union of completed runs with no live cap', () => {
    const runs = [
      { startedAt: '2026-09-11T13:40:27.195Z', endedAt: '2026-09-11T13:40:30.145Z' },
      { startedAt: '2026-09-11T13:40:43.621Z', endedAt: '2026-09-11T13:40:50.946Z' }
    ]
    expect(projectThreadRunWallMs(runs)).toBe(2950 + 7325)
  })

  it('counts concurrent Ensemble seats once', () => {
    const runs = [
      { startedAt: '2026-09-11T00:00:00.000Z', endedAt: '2026-09-11T00:00:10.000Z' },
      { startedAt: '2026-09-11T00:00:05.000Z', endedAt: '2026-09-11T00:00:15.000Z' },
      { startedAt: '2026-09-11T00:00:06.000Z', endedAt: '2026-09-11T00:00:12.000Z' }
    ]
    expect(projectThreadRunWallMs(runs)).toBe(15_000)
  })

  it('omits the in-flight run, which a live surface adds itself', () => {
    const runs = [
      { startedAt: '2026-09-11T00:00:00.000Z', endedAt: '2026-09-11T00:00:10.000Z' },
      { startedAt: '2026-09-11T00:01:00.000Z' }
    ]
    expect(projectThreadRunWallMs(runs)).toBe(10_000)
  })

  it('is zero for a thread with no runs, and for a missing array', () => {
    expect(projectThreadRunWallMs([])).toBe(0)
    expect(projectThreadRunWallMs(undefined)).toBe(0)
    expect(projectThreadRunWallMs(null)).toBe(0)
  })
})

describe('computeThreadRunWallMs live cap', () => {
  it('caps completed spans at the live boundary so the delta is not doubled', () => {
    const runs = [
      { startedAt: '2026-09-11T00:00:00.000Z', endedAt: '2026-09-11T00:00:10.000Z' },
      { startedAt: '2026-09-11T00:00:20.000Z', endedAt: '2026-09-11T00:00:40.000Z' }
    ]
    expect(computeThreadRunWallMs(runs, '2026-09-11T00:00:30.000Z')).toBe(20_000)
  })

  it('ignores an unparseable boundary rather than dropping every span', () => {
    const runs = [{ startedAt: '2026-09-11T00:00:00.000Z', endedAt: '2026-09-11T00:00:10.000Z' }]
    expect(computeThreadRunWallMs(runs, 'not-a-date')).toBe(10_000)
    expect(computeThreadRunWallMs(runs, null)).toBe(10_000)
  })
})

describe('readThreadRunWallMs', () => {
  it('accepts a non-negative finite number', () => {
    expect(readThreadRunWallMs(0)).toBe(0)
    expect(readThreadRunWallMs(10_275)).toBe(10_275)
    expect(readThreadRunWallMs(10_275.9)).toBe(10_275)
  })

  it('returns null for a row that never carried the field, so a caller can fall back', () => {
    expect(readThreadRunWallMs(undefined)).toBeNull()
    expect(readThreadRunWallMs(null)).toBeNull()
    expect(readThreadRunWallMs(-1)).toBeNull()
    expect(readThreadRunWallMs(Number.NaN)).toBeNull()
    expect(readThreadRunWallMs(Number.POSITIVE_INFINITY)).toBeNull()
    expect(readThreadRunWallMs('10275')).toBeNull()
  })
})
