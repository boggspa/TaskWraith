import { describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from './store/types'
import { ScheduledOccurrenceOwnerRegistry } from './ScheduledOccurrenceOwnerRegistry'
import {
  ScheduledOccurrenceTransaction,
  type ScheduledOccurrenceTransactionStore
} from './ScheduledOccurrenceTransaction'

const NOW = Date.parse('2026-07-15T10:00:00.000Z')

function dueTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-one',
    workspaceId: 'workspace-one',
    workspacePath: '/Users/test/repo',
    chatId: 'chat-one',
    provider: 'codex',
    prompt: 'Run the workflow.',
    selectedModelType: 'default',
    customModel: '',
    approvalMode: 'plan',
    sessionTrust: false,
    imageAttachments: [],
    runAt: new Date(NOW - 1_000).toISOString(),
    timezone: 'UTC',
    status: 'due',
    createdAt: new Date(NOW - 10_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    ...overrides
  }
}

function harness(inputTask = dueTask()) {
  let task = inputTask
  const store: ScheduledOccurrenceTransactionStore = {
    claimDueScheduledTaskForRun: vi.fn((taskId, options) => {
      if (task.id !== taskId || task.status !== 'due' || task.runId) return null
      if (!exactWorkflowOptionsMatch(task, options.expectedWorkflowOccurrence)) return null
      task = {
        ...task,
        status: 'running',
        runId: options.runId,
        firedAt: new Date(options.nowMs).toISOString(),
        runningSince: new Date(options.nowMs).toISOString()
      }
      return task
    }),
    heartbeatScheduledTaskForRun: vi.fn((taskId, options) => {
      if (
        task.id !== taskId ||
        task.status !== 'running' ||
        task.runId !== options.runId ||
        !exactWorkflowOptionsMatch(task, options.expectedWorkflowOccurrence)
      ) {
        return null
      }
      task = { ...task, runningSince: options.at ?? new Date(NOW).toISOString() }
      return task
    }),
    settleScheduledTaskForRun: vi.fn((taskId, options) => {
      if (
        task.id !== taskId ||
        task.status !== 'running' ||
        task.runId !== options.runId ||
        !exactWorkflowOptionsMatch(task, options.expectedWorkflowOccurrence)
      ) {
        return null
      }
      task = {
        ...task,
        status: options.status,
        completedAt: options.completedAt ?? new Date(NOW).toISOString(),
        lastError: options.lastError
      }
      return task
    })
  }
  const owners = new ScheduledOccurrenceOwnerRegistry()
  const recordRootRunIdTombstone = vi.fn()
  const transaction = new ScheduledOccurrenceTransaction({
    store,
    owners,
    recordRootRunIdTombstone,
    resolveRootOwner: (candidate) =>
      candidate.kind === 'ensemble'
        ? 'ensemble-root'
        : candidate.workflowId === 'loop-workflow'
          ? 'loop-root'
          : 'solo',
    createRunId: () => 'owner-run-one',
    now: () => NOW
  })
  return {
    get task() {
      return task
    },
    store,
    owners,
    recordRootRunIdTombstone,
    transaction
  }
}

describe('ScheduledOccurrenceTransaction', () => {
  it('lets racing entry points claim one occurrence only', () => {
    const h = harness()
    const register = vi.spyOn(h.owners, 'register')
    const timerOwner = h.transaction.claim(h.task)
    const runNowOwner = h.transaction.claim(dueTask())

    expect(timerOwner?.ownerRunId).toBe('owner-run-one')
    expect(runNowOwner).toBeNull()
    expect(h.store.claimDueScheduledTaskForRun).toHaveBeenCalledTimes(2)
    expect(h.recordRootRunIdTombstone).toHaveBeenCalledTimes(1)
    expect(
      vi.mocked(h.store.claimDueScheduledTaskForRun).mock.invocationCallOrder[0]
    ).toBeLessThan(h.recordRootRunIdTombstone.mock.invocationCallOrder[0])
    expect(h.recordRootRunIdTombstone.mock.invocationCallOrder[0]).toBeLessThan(
      register.mock.invocationCallOrder[0]
    )
    expect(h.owners.lookupByTaskId('task-one')).toBe(timerOwner)
  })

  it('carries an exact workflow occurrence through claim, heartbeat, and settle', () => {
    const h = harness(
      dueTask({
        workflowId: 'workflow-one',
        workflowExecutionId: 'execution-one',
        workflowOccurrenceAt: new Date(NOW - 1_000).toISOString()
      })
    )
    const owner = h.transaction.claim(h.task)!
    h.transaction.heartbeat(owner, new Date(NOW + 1_000).toISOString())
    const settled = h.transaction.settle(owner, 'completed')

    const expectedWorkflowOccurrence = {
      workflowId: 'workflow-one',
      executionId: 'execution-one',
      plannedFor: new Date(NOW - 1_000).toISOString(),
      taskId: 'task-one'
    }
    expect(h.store.claimDueScheduledTaskForRun).toHaveBeenCalledWith(
      'task-one',
      expect.objectContaining({ expectedWorkflowOccurrence })
    )
    expect(h.store.heartbeatScheduledTaskForRun).toHaveBeenCalledWith(
      'task-one',
      expect.objectContaining({ expectedWorkflowOccurrence })
    )
    expect(h.store.settleScheduledTaskForRun).toHaveBeenCalledWith(
      'task-one',
      expect.objectContaining({ expectedWorkflowOccurrence })
    )
    expect(settled?.status).toBe('completed')
    expect(h.owners.lookupByOwnerRunId(owner.ownerRunId)).toBeUndefined()
  })

  it('keeps ownership live when durable settlement rejects', () => {
    const h = harness()
    const owner = h.transaction.claim(h.task)!
    vi.mocked(h.store.settleScheduledTaskForRun).mockReturnValueOnce(null)

    expect(h.transaction.settle(owner, 'failed')).toBeNull()
    expect(h.owners.lookupByOwnerRunId(owner.ownerRunId)).toBe(owner)
  })

  it('keeps ownership live when a durable heartbeat rejects', () => {
    const h = harness()
    const owner = h.transaction.claim(h.task)!
    vi.mocked(h.store.heartbeatScheduledTaskForRun).mockReturnValueOnce(null)

    expect(h.transaction.heartbeat(owner)).toBeNull()
    expect(h.owners.lookupByOwnerRunId(owner.ownerRunId)).toBe(owner)
  })

  it('rejects stale owner objects after the live owner settles', () => {
    const h = harness()
    const owner = h.transaction.claim(h.task)!
    expect(h.transaction.settle(owner, 'cancelled')).not.toBeNull()
    expect(h.transaction.settle(owner, 'failed')).toBeNull()
    expect(h.transaction.heartbeat(owner)).toBeNull()
  })

  it('rolls a durable claim back when process-local registration fails', () => {
    const h = harness()
    h.owners.register({
      taskId: 'other-task',
      ownerRunId: 'owner-run-one',
      provider: 'codex',
      chatId: 'other-chat',
      workspaceId: 'workspace-one',
      workspacePath: '/Users/test/repo',
      rootOwner: 'solo'
    })

    expect(() => h.transaction.claim(h.task)).toThrow(/already has a live owner/)
    expect(h.task.status).toBe('failed')
    expect(h.task.lastError).toBe('Scheduled occurrence owner initialization failed.')
    expect(h.store.settleScheduledTaskForRun).toHaveBeenCalledWith(
      'task-one',
      expect.objectContaining({ runId: 'owner-run-one' })
    )
  })

  it('rolls back the durable claim and never registers when the root tombstone fails', () => {
    const h = harness()
    h.recordRootRunIdTombstone.mockImplementationOnce(() => {
      throw new Error('Injected tombstone fsync failure.')
    })

    expect(() => h.transaction.claim(h.task)).toThrow('Injected tombstone fsync failure.')
    expect(h.task.status).toBe('failed')
    expect(h.owners.lookupByOwnerRunId('owner-run-one')).toBeUndefined()
    expect(h.store.settleScheduledTaskForRun).toHaveBeenCalledWith(
      'task-one',
      expect.objectContaining({
        runId: 'owner-run-one',
        status: 'failed',
        lastError: 'Scheduled occurrence owner initialization failed.'
      })
    )
  })

  it('derives loop ownership from the current main-owned workflow lookup', () => {
    const h = harness(
      dueTask({
        workflowId: 'loop-workflow',
        workflowExecutionId: 'loop-execution',
        workflowOccurrenceAt: new Date(NOW - 1_000).toISOString()
      })
    )
    expect(h.transaction.claim(h.task)?.rootOwner).toBe('loop-root')
  })
})

function exactWorkflowOptionsMatch(
  task: ScheduledTask,
  expected:
    | { workflowId: string; executionId: string; plannedFor: string; taskId: string }
    | undefined
): boolean {
  const linked = Boolean(
    task.workflowId || task.workflowExecutionId || task.workflowOccurrenceAt
  )
  if (!linked) return expected === undefined
  return Boolean(
    expected &&
      expected.taskId === task.id &&
      expected.workflowId === task.workflowId &&
      expected.executionId === task.workflowExecutionId &&
      expected.plannedFor === task.workflowOccurrenceAt
  )
}
