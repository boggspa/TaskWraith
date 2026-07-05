import { describe, expect, it } from 'vitest'
import {
  buildIntrospectionScheduleMetaLines,
  formatIntrospectionScheduleTimestamp,
  introspectionScheduleApiReady
} from './threadIntrospectionSchedule'

describe('threadIntrospectionSchedule', () => {
  it('formats valid ISO timestamps for display', () => {
    const formatted = formatIntrospectionScheduleTimestamp('2026-07-05T20:15:00.000Z')
    expect(formatted).toBeTruthy()
    expect(formatted).not.toBe('Invalid Date')
  })

  it('returns null for missing or invalid timestamps', () => {
    expect(formatIntrospectionScheduleTimestamp(null)).toBeNull()
    expect(formatIntrospectionScheduleTimestamp('not-a-date')).toBeNull()
  })

  it('builds enabled schedule meta with next and last run', () => {
    const lines = buildIntrospectionScheduleMetaLines({
      schedule: {
        enabled: true,
        workspaceId: 'ws-1',
        nextRunAt: '2026-07-06T08:00:00.000Z',
        lastRunAt: '2026-07-05T08:00:00.000Z'
      }
    })

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^Next run /)
    expect(lines[1]).toMatch(/^Last scheduled run /)
  })

  it('shows pending next run when enabled without nextRunAt', () => {
    const lines = buildIntrospectionScheduleMetaLines({
      schedule: { enabled: true, workspaceId: 'ws-1' }
    })

    expect(lines).toEqual(['Next run pending'])
  })

  it('shows daily run off when disabled', () => {
    const lines = buildIntrospectionScheduleMetaLines({
      schedule: {
        enabled: false,
        workspaceId: 'ws-1',
        lastRunAt: '2026-07-05T08:00:00.000Z'
      }
    })

    expect(lines[0]).toBe('Daily run off')
    expect(lines[1]).toMatch(/^Last scheduled run /)
  })

  it('prefers loading and saving status lines', () => {
    expect(
      buildIntrospectionScheduleMetaLines({
        schedule: { enabled: true },
        loading: true
      })
    ).toEqual(['Loading schedule…'])

    expect(
      buildIntrospectionScheduleMetaLines({
        schedule: { enabled: true },
        saving: true
      })
    ).toEqual(['Saving schedule…'])
  })

  it('detects schedule IPC readiness from both handlers', () => {
    expect(introspectionScheduleApiReady(undefined)).toBe(false)
    expect(introspectionScheduleApiReady({ getIntrospectionSchedule: () => undefined })).toBe(false)
    expect(
      introspectionScheduleApiReady({
        getIntrospectionSchedule: async () => ({ enabled: false }),
        updateIntrospectionSchedule: async () => ({ enabled: true })
      })
    ).toBe(true)
  })
})