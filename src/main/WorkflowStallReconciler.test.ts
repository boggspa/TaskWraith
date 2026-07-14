import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STALL_BACKSTOP_MS,
  findStalledScheduledTasks,
  stallBasisMs,
  stallReason
} from './WorkflowStallReconciler'
import type { ScheduledTask } from './store/types'

const NOW = Date.parse('2026-06-24T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const HOURS = (h: number): number => h * 60 * 60 * 1000

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: overrides.id || 'task-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    chatId: 'chat-1',
    provider: 'codex',
    prompt: 'Review the diff.',
    selectedModelType: 'cli-default',
    customModel: '',
    approvalMode: 'default',
    sessionTrust: false,
    imageAttachments: [],
    runAt: ago(HOURS(8)),
    timezone: 'Europe/London',
    status: 'running',
    createdAt: ago(HOURS(9)),
    updatedAt: ago(HOURS(0)), // deliberately FRESH — must never be used as basis
    runId: 'run-1',
    firedAt: ago(HOURS(8)),
    runningSince: ago(HOURS(8)),
    workflowId: 'wf-1',
    workflowExecutionId: 'exec-1',
    workflowOccurrenceAt: ago(HOURS(8)),
    ...overrides
  } as ScheduledTask
}

const NONE_LIVE = (): boolean => false

describe('findStalledScheduledTasks', () => {
  it('settles a due-wedge that has aged past the backstop (no runId, no live job)', () => {
    const t = task({
      id: 'due-wedge',
      status: 'due',
      runId: undefined,
      runningSince: undefined,
      firedAt: ago(HOURS(7))
    })
    const result = findStalledScheduledTasks([t], NONE_LIVE, NOW, DEFAULT_STALL_BACKSTOP_MS)
    expect(result.map((r) => r.task.id)).toEqual(['due-wedge'])
    expect(result[0].basis).toBe('firedAt')
    expect(result[0].ageMs).toBe(HOURS(7))
  })

  it('requires a finite arrived runAt without consuming stall age before arrival', () => {
    const oldFiredAt = ago(HOURS(7))
    const exact = task({
      id: 'due-exact',
      status: 'due',
      runId: undefined,
      runningSince: undefined,
      firedAt: oldFiredAt,
      runAt: new Date(NOW).toISOString()
    })
    const future = task({
      id: 'due-future',
      status: 'due',
      runId: undefined,
      runningSince: undefined,
      firedAt: oldFiredAt,
      runAt: new Date(NOW + 1).toISOString()
    })
    const invalid = task({
      id: 'due-invalid',
      status: 'due',
      runId: undefined,
      runningSince: undefined,
      firedAt: oldFiredAt,
      runAt: 'not-a-date'
    })
    const malformed = task({
      id: 'due-malformed',
      status: 'due',
      runId: undefined,
      runningSince: undefined,
      firedAt: oldFiredAt,
      runAt: null as unknown as string
    })
    const malformedBoolean = task({
      id: 'due-malformed-boolean',
      status: 'due',
      runId: undefined,
      runningSince: undefined,
      firedAt: oldFiredAt,
      runAt: false as unknown as string
    })

    expect(
      findStalledScheduledTasks(
        [exact, future, invalid, malformed, malformedBoolean],
        NONE_LIVE,
        NOW,
        DEFAULT_STALL_BACKSTOP_MS
      ).map((entry) => entry.task.id)
    ).toEqual([])
  })

  it('starts a due task stall budget at runAt when firedAt was forged early', () => {
    const arrivedAt = ago(DEFAULT_STALL_BACKSTOP_MS)
    const due = task({
      id: 'due-arrived',
      status: 'due',
      runId: undefined,
      runningSince: undefined,
      firedAt: ago(HOURS(7)),
      runAt: arrivedAt
    })

    const result = findStalledScheduledTasks(
      [due],
      NONE_LIVE,
      NOW,
      DEFAULT_STALL_BACKSTOP_MS
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      basis: 'runAt',
      basisMs: Date.parse(arrivedAt),
      ageMs: DEFAULT_STALL_BACKSTOP_MS
    })
  })

  it('settles a running-wedge whose run-queue job is DEAD', () => {
    const t = task({ id: 'running-dead', runningSince: ago(HOURS(7)) })
    const result = findStalledScheduledTasks([t], NONE_LIVE, NOW, DEFAULT_STALL_BACKSTOP_MS)
    expect(result.map((r) => r.task.id)).toEqual(['running-dead'])
    expect(result[0].basis).toBe('runningSince')
  })

  it('does NOT settle a running task whose run-queue job is still LIVE (false-positive guard)', () => {
    const t = task({ id: 'running-live', runningSince: ago(HOURS(7)) })
    const probed: string[] = []
    const isLive = (runId: string): boolean => {
      probed.push(runId)
      return true
    }
    const result = findStalledScheduledTasks([t], isLive, NOW, DEFAULT_STALL_BACKSTOP_MS)
    expect(result).toHaveLength(0)
    expect(probed).toEqual(['run-1'])
  })

  it('does NOT settle a task still within the backstop window', () => {
    const t = task({ id: 'fresh', runningSince: ago(HOURS(2)) })
    expect(findStalledScheduledTasks([t], NONE_LIVE, NOW, DEFAULT_STALL_BACKSTOP_MS)).toHaveLength(0)
  })

  it('excludes terminal and non-occupying statuses', () => {
    const statuses: ScheduledTask['status'][] = ['completed', 'failed', 'cancelled']
    const tasks = statuses.map((status, i) =>
      task({ id: `term-${i}`, status, runningSince: ago(HOURS(7)) })
    )
    expect(findStalledScheduledTasks(tasks, NONE_LIVE, NOW, DEFAULT_STALL_BACKSTOP_MS)).toHaveLength(
      0
    )
  })

  it('excludes a task with no usable basis (NaN — every timestamp absent)', () => {
    const t = task({
      id: 'no-basis',
      status: 'running',
      runningSince: undefined,
      firedAt: undefined
    })
    expect(findStalledScheduledTasks([t], NONE_LIVE, NOW, DEFAULT_STALL_BACKSTOP_MS)).toHaveLength(0)
  })

  it('settles an OVERDUE pending occurrence (runAt in the past) but not a future one', () => {
    const overdue = task({
      id: 'pending-overdue',
      status: 'pending',
      runId: undefined,
      runningSince: undefined,
      firedAt: undefined,
      runAt: ago(HOURS(7))
    })
    const future = task({
      id: 'pending-future',
      status: 'pending',
      runId: undefined,
      runningSince: undefined,
      firedAt: undefined,
      runAt: new Date(NOW + HOURS(1)).toISOString()
    })
    const result = findStalledScheduledTasks(
      [overdue, future],
      NONE_LIVE,
      NOW,
      DEFAULT_STALL_BACKSTOP_MS
    )
    expect(result.map((r) => r.task.id)).toEqual(['pending-overdue'])
    expect(result[0].basis).toBe('runAt')
  })

  it('excludes non-workflow scheduled tasks (no activeExecutionId to wedge)', () => {
    const t = task({
      id: 'plain',
      workflowId: undefined,
      workflowExecutionId: undefined,
      runningSince: ago(HOURS(7))
    })
    expect(findStalledScheduledTasks([t], NONE_LIVE, NOW, DEFAULT_STALL_BACKSTOP_MS)).toHaveLength(0)
  })

  it('falls back to firedAt for a legacy running task with no runningSince', () => {
    const t = task({ id: 'legacy', runningSince: undefined, firedAt: ago(HOURS(7)) })
    const result = findStalledScheduledTasks([t], NONE_LIVE, NOW, DEFAULT_STALL_BACKSTOP_MS)
    expect(result.map((r) => r.task.id)).toEqual(['legacy'])
    expect(result[0].basis).toBe('firedAt')
  })

  it('does not probe liveness for due tasks (no runId)', () => {
    const due = task({ id: 'due', status: 'due', runId: undefined, firedAt: ago(HOURS(7)) })
    const probed: string[] = []
    const result = findStalledScheduledTasks(
      [due],
      (id) => {
        probed.push(id)
        return true
      },
      NOW,
      DEFAULT_STALL_BACKSTOP_MS
    )
    expect(result).toHaveLength(1)
    expect(probed).toEqual([])
  })
})

describe('stallBasisMs', () => {
  it('prefers runningSince over firedAt for a running task', () => {
    const t = task({ runningSince: ago(HOURS(5)), firedAt: ago(HOURS(8)) })
    expect(stallBasisMs(t)).toEqual({ basis: 'runningSince', ms: NOW - HOURS(5) })
  })

  it('never uses updatedAt', () => {
    const t = task({ runningSince: undefined, firedAt: undefined, updatedAt: ago(HOURS(0)) })
    expect(Number.isNaN(stallBasisMs(t).ms)).toBe(true)
  })
})

describe('stallReason', () => {
  it('builds a settle string naming the basis and the backstop', () => {
    const reason = stallReason(task({ status: 'due' }), 'firedAt', HOURS(7), DEFAULT_STALL_BACKSTOP_MS)
    expect(reason).toContain('became due')
    expect(reason).toContain('basis: firedAt')
    expect(reason).toContain('6h')
    expect(reason).toContain('Settled to failed')
  })

  it('describes a running wedge', () => {
    expect(stallReason(task({ status: 'running' }), 'runningSince', HOURS(7))).toContain(
      'started running'
    )
  })
})
