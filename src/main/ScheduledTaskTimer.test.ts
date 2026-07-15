import { describe, expect, it } from 'vitest'
import { getNextScheduledTaskRunAtMs, SCHEDULED_DUE_RETRY_DELAY_MS } from './ScheduledTaskTimer'
import type { ScheduledTask } from './store/types'

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: overrides.id || 'task-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    chatId: 'chat-1',
    provider: 'codex',
    prompt: 'Run review',
    selectedModelType: 'cli-default',
    customModel: '',
    approvalMode: 'default',
    sessionTrust: false,
    imageAttachments: [],
    runAt: '2026-06-25T00:00:00.000Z',
    timezone: 'Europe/London',
    status: 'pending',
    createdAt: '2026-06-25T00:00:00.000Z',
    updatedAt: '2026-06-25T00:00:00.000Z',
    ...overrides
  } as ScheduledTask
}

describe('getNextScheduledTaskRunAtMs', () => {
  it('bounds retries when an overdue due task remains unclaimed', () => {
    const nowMs = 1_000_000_000_000
    expect(
      getNextScheduledTaskRunAtMs({
        nowMs,
        tasks: [
          task({ status: 'due', runAt: '1999-01-01T00:00:00.000Z' }),
          task({ status: 'pending' })
        ],
        nextWorkflowRunAtMs: nowMs + 60000
      })
    ).toBe(nowMs + SCHEDULED_DUE_RETRY_DELAY_MS)
  })

  it('bounds retries at the exact-now due boundary', () => {
    const nowMs = 1_000_000_000_000
    expect(
      getNextScheduledTaskRunAtMs({
        nowMs,
        tasks: [task({ status: 'due', runAt: new Date(nowMs).toISOString() })],
        nextWorkflowRunAtMs: null
      })
    ).toBe(nowMs + SCHEDULED_DUE_RETRY_DELAY_MS)
  })

  it('does not let a deferred due retry delay an earlier independent timer', () => {
    const nowMs = 1_000_000_000_000
    expect(
      getNextScheduledTaskRunAtMs({
        nowMs,
        tasks: [task({ status: 'due', runAt: '1999-01-01T00:00:00.000Z' })],
        nextWorkflowRunAtMs: nowMs + 250
      })
    ).toBe(nowMs + 250)
  })

  it('waits until runAt for a future due task', () => {
    const nowMs = 1_000_000_000_000
    const futureRunAtMs = nowMs + 30000

    expect(
      getNextScheduledTaskRunAtMs({
        nowMs,
        tasks: [task({ status: 'due', runAt: new Date(futureRunAtMs).toISOString() })],
        nextWorkflowRunAtMs: nowMs + 60000
      })
    ).toBe(futureRunAtMs)
  })

  it('ignores a due task with an invalid runAt', () => {
    expect(
      getNextScheduledTaskRunAtMs({
        tasks: [
          task({ status: 'due', runAt: 'not-a-date' }),
          task({ id: 'malformed-null', status: 'due', runAt: null as unknown as string }),
          task({ id: 'malformed-boolean', status: 'due', runAt: false as unknown as string })
        ],
        nextWorkflowRunAtMs: null
      })
    ).toBeNull()
  })

  it('falls back to future pending and workflow candidates when no due task exists', () => {
    const nowMs = 1_000_000_000_000
    expect(
      getNextScheduledTaskRunAtMs({
        nowMs,
        tasks: [task({ status: 'pending', runAt: new Date(nowMs + 30000).toISOString() })],
        nextWorkflowRunAtMs: nowMs + 15000
      })
    ).toBe(nowMs + 15000)
  })

  it('returns null when there is no due/pending task and no workflow candidate', () => {
    expect(
      getNextScheduledTaskRunAtMs({
        tasks: [task({ status: 'completed' })],
        nextWorkflowRunAtMs: null
      })
    ).toBe(null)
  })

  it('includes introspection schedule candidates in the next timer tick', () => {
    const nowMs = 1_000_000_000_000
    expect(
      getNextScheduledTaskRunAtMs({
        nowMs,
        tasks: [task({ status: 'completed' })],
        nextWorkflowRunAtMs: null,
        nextIntrospectionRunAtMs: nowMs + 5000
      })
    ).toBe(nowMs + 5000)
  })
})
