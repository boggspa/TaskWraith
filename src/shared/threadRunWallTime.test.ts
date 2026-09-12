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

  it('counts complete round envelopes while excluding the idle gap between rounds', () => {
    const runs = [
      {
        ensembleRoundId: 'round-1',
        startedAt: '2026-09-11T00:00:00.000Z',
        endedAt: '2026-09-11T00:00:10.000Z'
      },
      {
        ensembleRoundId: 'round-1',
        startedAt: '2026-09-11T00:00:15.000Z',
        endedAt: '2026-09-11T00:00:25.000Z'
      },
      {
        ensembleRoundId: 'round-2',
        startedAt: '2026-09-11T00:01:02.000Z',
        endedAt: '2026-09-11T00:01:10.000Z'
      }
    ]
    const ensemble = {
      roundWallMsById: { 'round-1': 30_000 },
      activeRound: {
        roundId: 'round-2',
        status: 'completed',
        startedAt: '2026-09-11T00:01:00.000Z',
        endedAt: '2026-09-11T00:01:20.000Z'
      }
    }

    // Round 1 contributes its whole 30-second envelope, including the 5s
    // handoff. The latest terminal round contributes its exact 20s. The 30s
    // idle interval between rounds contributes nothing.
    expect(projectThreadRunWallMs(runs, ensemble)).toBe(50_000)
  })

  it('excludes every completed seat run from the current live round', () => {
    const runs = [
      {
        ensembleRoundId: 'round-1',
        startedAt: '2026-09-11T00:00:00.000Z',
        endedAt: '2026-09-11T00:00:10.000Z'
      },
      {
        ensembleRoundId: 'round-live',
        startedAt: '2026-09-11T00:01:00.000Z',
        endedAt: '2026-09-11T00:01:10.000Z'
      },
      {
        ensembleRoundId: 'round-live',
        startedAt: '2026-09-11T00:01:15.000Z'
      }
    ]
    const ensemble = {
      roundWallMsById: { 'round-1': 30_000 },
      activeRound: {
        roundId: 'round-live',
        status: 'running',
        startedAt: '2026-09-11T00:01:00.000Z'
      }
    }

    // The live UI adds now - round.startedAt once. Keeping round-live's first
    // finished seat in this scalar would double its first ten seconds.
    expect(projectThreadRunWallMs(runs, ensemble)).toBe(30_000)
  })

  it('does not double-count a terminal active round already present in the ledger', () => {
    const runs = [
      {
        ensembleRoundId: 'round-1',
        startedAt: '2026-09-11T00:00:02.000Z',
        endedAt: '2026-09-11T00:00:20.000Z'
      }
    ]
    const ensemble = {
      roundWallMsById: { 'round-1': 30_000 },
      activeRound: {
        roundId: 'round-1',
        status: 'completed',
        startedAt: '2026-09-11T00:00:00.000Z',
        endedAt: '2026-09-11T00:00:30.000Z'
      }
    }

    expect(projectThreadRunWallMs(runs, ensemble)).toBe(30_000)
  })

  it('ignores malformed ledger values and falls back to their completed runs', () => {
    const runs = [
      {
        ensembleRoundId: 'negative',
        startedAt: '2026-09-11T00:00:00.000Z',
        endedAt: '2026-09-11T00:00:10.000Z'
      },
      {
        ensembleRoundId: 'nan',
        startedAt: '2026-09-11T00:00:20.000Z',
        endedAt: '2026-09-11T00:00:25.000Z'
      }
    ]
    const ensemble = {
      roundWallMsById: { negative: -1, nan: Number.NaN }
    }

    expect(projectThreadRunWallMs(runs, ensemble)).toBe(15_000)
  })

  it('treats malformed round ids and array-shaped ledgers as legacy input', () => {
    const runs = [
      {
        ensembleRoundId: 42 as unknown as string,
        startedAt: '2026-09-11T00:00:00.000Z',
        endedAt: '2026-09-11T00:00:10.000Z'
      }
    ]
    const malformed = {
      roundWallMsById: [30_000],
      activeRound: {
        roundId: 42 as unknown as string,
        status: 'completed',
        startedAt: '2026-09-11T00:00:00.000Z',
        endedAt: '2026-09-11T00:00:30.000Z'
      }
    }

    expect(() => projectThreadRunWallMs(runs, malformed)).not.toThrow()
    expect(projectThreadRunWallMs(runs, malformed)).toBe(10_000)
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
