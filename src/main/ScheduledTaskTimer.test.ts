import { describe, expect, it } from 'vitest'
import { getNextScheduledTaskRunAtMs } from './ScheduledTaskTimer'
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
  it('returns now when any due task exists', () => {
    const nowMs = 1_000_000_000_000
    expect(
      getNextScheduledTaskRunAtMs({
        nowMs,
        tasks: [task({ status: 'due', runAt: '1999-01-01T00:00:00.000Z' }), task({ status: 'pending' })],
        nextWorkflowRunAtMs: nowMs + 60000
      })
    ).toBe(nowMs)
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
