import { describe, expect, it } from 'vitest'
import { formatScheduleCountdown, formatScheduledTaskCountdown } from './scheduledCountdown'

describe('scheduledCountdown', () => {
  const now = Date.UTC(2026, 5, 28, 12, 0, 0)

  it('formats pending countdowns across common ranges', () => {
    expect(formatScheduleCountdown(new Date(now + 45_000).toISOString(), now)).toBe('45s')
    expect(formatScheduleCountdown(new Date(now + 5 * 60_000 + 3_000).toISOString(), now)).toBe(
      '5m 3s'
    )
    expect(
      formatScheduleCountdown(new Date(now + 2 * 60 * 60_000 + 7 * 60_000).toISOString(), now)
    ).toBe('2h 7m')
    expect(
      formatScheduleCountdown(
        new Date(now + 3 * 24 * 60 * 60_000 + 2 * 60 * 60_000).toISOString(),
        now
      )
    ).toBe('3d 2h')
  })

  it('labels due, invalid, and running states explicitly', () => {
    expect(formatScheduleCountdown(new Date(now - 1).toISOString(), now)).toBe('due now')
    expect(formatScheduleCountdown('not-a-date', now)).toBe('unscheduled')
    expect(
      formatScheduledTaskCountdown(
        { runAt: new Date(now - 1).toISOString(), status: 'pending' },
        now
      )
    ).toBe('due / waiting')
    expect(
      formatScheduledTaskCountdown(
        { runAt: new Date(now + 60_000).toISOString(), status: 'running' },
        now
      )
    ).toBe('running')
  })
})
