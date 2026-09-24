import { describe, expect, it } from 'vitest'
import { formatGoalRuntimeDuration, formatGoalRuntimePopoverLabel } from './goalRuntimeFormat'

describe('formatGoalRuntimeDuration', () => {
  it.each([
    [-1000, '0s'],
    [0, '0s'],
    [59_999, '59s'],
    [60_000, '1m'],
    [61_000, '1m 1s'],
    [3_600_000, '1h'],
    [3_660_000, '1h 1m'],
    [86_400_000, '1d'],
    [90_000_000, '1d 1h']
  ])('formats %d milliseconds as %s', (durationMs, expected) => {
    expect(formatGoalRuntimeDuration(durationMs)).toBe(expected)
  })
})

describe('formatGoalRuntimePopoverLabel', () => {
  it('returns null without a runtime ledger', () => {
    expect(formatGoalRuntimePopoverLabel({}, Date.parse('2026-09-05T10:00:00.000Z'))).toBeNull()
    expect(formatGoalRuntimePopoverLabel(null, Date.parse('2026-09-05T10:00:00.000Z'))).toBeNull()
  })

  it('formats wall, active, blocked, and paused intervals in display order', () => {
    const goal = {
      runtimeLedger: {
        startedAt: '2026-09-05T10:00:00.000Z',
        intervals: [
          {
            status: 'active',
            startedAt: '2026-09-05T10:00:00.000Z',
            endedAt: '2026-09-05T10:01:00.000Z'
          },
          {
            status: 'paused',
            startedAt: '2026-09-05T10:01:00.000Z',
            endedAt: '2026-09-05T10:03:00.000Z'
          },
          {
            status: 'blocked',
            startedAt: '2026-09-05T10:03:00.000Z',
            endedAt: '2026-09-05T10:04:00.000Z'
          },
          {
            status: 'active',
            startedAt: '2026-09-05T10:04:00.000Z'
          }
        ]
      }
    }

    expect(
      formatGoalRuntimePopoverLabel(
        goal,
        Date.parse('2026-09-05T10:10:00.000Z'),
        '2026-09-05T10:06:00.000Z'
      )
    ).toBe('Goal runtime · wall 6m · active 3m · blocked 1m · paused 2m')
  })

  it('omits zero-valued status segments while retaining wall time', () => {
    const goal = {
      runtimeLedger: {
        startedAt: '2026-09-05T10:00:00.000Z',
        endedAt: '2026-09-05T10:02:00.000Z',
        intervals: [
          {
            status: 'active',
            startedAt: '2026-09-05T10:00:00.000Z',
            endedAt: '2026-09-05T10:02:00.000Z'
          }
        ]
      }
    }

    expect(formatGoalRuntimePopoverLabel(goal, Date.parse('2026-09-05T12:00:00.000Z'))).toBe(
      'Goal runtime · wall 2m · active 2m'
    )
  })

  it('clamps an open interval to the supplied last activity time', () => {
    const goal = {
      runtimeLedger: {
        startedAt: '2026-09-05T10:00:00.000Z',
        intervals: [{ status: 'active', startedAt: '2026-09-05T10:00:00.000Z' }]
      }
    }

    expect(
      formatGoalRuntimePopoverLabel(
        goal,
        Date.parse('2026-09-05T15:00:00.000Z'),
        Date.parse('2026-09-05T10:00:30.000Z')
      )
    ).toBe('Goal runtime · wall 30s · active 30s')
  })
})
