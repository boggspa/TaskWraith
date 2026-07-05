import { describe, expect, it, vi } from 'vitest'
import {
  buildRolling24hWindow,
  computeNextIntrospectionRunAt,
  dispatchDueIntrospectionSchedules,
  getNextIntrospectionScheduleRunAtMs,
  hasScheduledIntrospectionForDay,
  isIntrospectionScheduleDue,
  mergeIntrospectionScheduleUpdate,
  INTROSPECTION_SCHEDULE_INTERVAL_MS
} from './IntrospectionScheduler'
import type { IntrospectionRunRecord, IntrospectionScheduleRecord } from '../store/types'

const NOW_MS = Date.parse('2026-07-05T12:00:00.000Z')
const NOW_ISO = '2026-07-05T12:00:00.000Z'

function scheduleRecord(
  overrides: Partial<IntrospectionScheduleRecord> = {}
): IntrospectionScheduleRecord {
  return {
    schemaVersion: 1,
    workspaceId: 'ws-1',
    enabled: true,
    nextRunAt: NOW_ISO,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides
  }
}

function scheduledRun(createdAt = NOW_ISO): IntrospectionRunRecord {
  return {
    schemaVersion: 1,
    id: 'run-scheduled',
    status: 'review_pending',
    trigger: 'scheduled',
    workspaceId: 'ws-1',
    windowStart: '2026-07-04T12:00:00.000Z',
    windowEnd: NOW_ISO,
    evidenceItems: [],
    createdAt,
    updatedAt: createdAt
  }
}

describe('IntrospectionScheduler', () => {
  it('computes the first next run immediately when enabled without history', () => {
    expect(computeNextIntrospectionRunAt(true, null, NOW_MS)).toBe(NOW_ISO)
  })

  it('computes the next run 24h after the last run', () => {
    const lastRunAt = '2026-07-04T12:00:00.000Z'
    expect(computeNextIntrospectionRunAt(true, lastRunAt, NOW_MS)).toBe(
      new Date(Date.parse(lastRunAt) + INTROSPECTION_SCHEDULE_INTERVAL_MS).toISOString()
    )
  })

  it('detects due schedules and builds a rolling 24h window', () => {
    expect(
      isIntrospectionScheduleDue({ enabled: true, nextRunAt: '2026-07-05T11:59:00.000Z' }, NOW_MS)
    ).toBe(true)
    expect(
      isIntrospectionScheduleDue({ enabled: true, nextRunAt: '2026-07-05T12:01:00.000Z' }, NOW_MS)
    ).toBe(false)

    const window = buildRolling24hWindow(NOW_ISO)
    expect(window.windowEnd).toBe(NOW_ISO)
    expect(Date.parse(window.windowStart)).toBe(
      Date.parse(NOW_ISO) - INTROSPECTION_SCHEDULE_INTERVAL_MS
    )
  })

  it('returns the earliest enabled nextRunAt for timer scheduling', () => {
    expect(
      getNextIntrospectionScheduleRunAtMs(
        [
          scheduleRecord({ nextRunAt: '2026-07-05T14:00:00.000Z' }),
          scheduleRecord({ workspaceId: 'ws-2', nextRunAt: '2026-07-05T13:00:00.000Z' })
        ],
        NOW_MS
      )
    ).toBe(Date.parse('2026-07-05T13:00:00.000Z'))
  })

  it('detects an existing scheduled run for the same workspace/day', () => {
    expect(hasScheduledIntrospectionForDay([scheduledRun()], 'ws-1', '2026-07-05')).toBe(true)
    expect(hasScheduledIntrospectionForDay([scheduledRun()], 'ws-2', '2026-07-05')).toBe(false)
    expect(
      hasScheduledIntrospectionForDay([scheduledRun('2026-07-04T12:00:00.000Z')], 'ws-1', '2026-07-05')
    ).toBe(false)
  })

  it('dispatches a scheduled introspection run when due', () => {
    const runManualIntrospection = vi.fn(() => ({
      run: scheduledRun(),
      pack: {
        schemaVersion: 1 as const,
        id: 'pack-1',
        introspectionRunId: 'run-scheduled',
        workspaceId: 'ws-1',
        windowStart: '2026-07-04T12:00:00.000Z',
        windowEnd: NOW_ISO,
        proposals: [],
        evidenceItemCount: 2,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO
      },
      evidenceCount: 2,
      proposalCount: 1
    }))
    const updateIntrospectionScheduleRecord = vi.fn(() => ({
      enabled: true,
      workspaceId: 'ws-1',
      lastRunAt: NOW_ISO,
      nextRunAt: new Date(NOW_MS + INTROSPECTION_SCHEDULE_INTERVAL_MS).toISOString()
    }))

    const results = dispatchDueIntrospectionSchedules(
      {
        getIntrospectionScheduleRecords: () => [scheduleRecord()],
        updateIntrospectionScheduleRecord,
        getIntrospectionRuns: () => [],
        getWorkspacePath: () => '/repo',
        runManualIntrospection
      },
      NOW_MS
    )

    expect(results).toEqual([
      {
        workspaceId: 'ws-1',
        skipped: false,
        packId: 'pack-1',
        evidenceCount: 2,
        proposalCount: 1
      }
    ])
    expect(runManualIntrospection).toHaveBeenCalledWith({
      windowStart: '2026-07-04T12:00:00.000Z',
      windowEnd: NOW_ISO,
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      trigger: 'scheduled'
    })
    expect(updateIntrospectionScheduleRecord).toHaveBeenCalled()
  })

  it('skips duplicate scheduled runs for the same workspace/day', () => {
    const runManualIntrospection = vi.fn()
    const updateIntrospectionScheduleRecord = vi.fn(() => ({
      enabled: true,
      workspaceId: 'ws-1',
      lastRunAt: NOW_ISO,
      nextRunAt: new Date(NOW_MS + INTROSPECTION_SCHEDULE_INTERVAL_MS).toISOString()
    }))

    const results = dispatchDueIntrospectionSchedules(
      {
        getIntrospectionScheduleRecords: () => [scheduleRecord()],
        updateIntrospectionScheduleRecord,
        getIntrospectionRuns: () => [scheduledRun()],
        getWorkspacePath: () => '/repo',
        runManualIntrospection
      },
      NOW_MS
    )

    expect(results).toEqual([
      {
        workspaceId: 'ws-1',
        skipped: true,
        reason: 'already_ran_today'
      }
    ])
    expect(runManualIntrospection).not.toHaveBeenCalled()
    expect(updateIntrospectionScheduleRecord).toHaveBeenCalled()
  })

  it('merges enablement into a persisted schedule row with nextRunAt', () => {
    const merged = mergeIntrospectionScheduleUpdate(null, { enabled: true, workspaceId: 'ws-1' }, NOW_ISO, NOW_MS)
    expect(merged.enabled).toBe(true)
    expect(merged.workspaceId).toBe('ws-1')
    expect(merged.nextRunAt).toBe(NOW_ISO)
  })
})