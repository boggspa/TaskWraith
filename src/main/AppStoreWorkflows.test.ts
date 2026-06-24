import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import type { WorkflowDefinition, WorkflowRunTemplate } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-workflows-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const plannedFor = '2026-06-07T20:00:00.000Z'
const intervalMs = 15 * 60_000
type WorkflowInput = Parameters<typeof AppStore.saveWorkflowDefinition>[0]

function workflowInput(
  overrides: Partial<Omit<WorkflowInput, 'template'>> & { template?: Partial<WorkflowRunTemplate> } &
    Partial<Pick<WorkflowDefinition, 'history' | 'failureStreak'>> = {}
): WorkflowInput {
  const {
    template: templateOverridesRaw,
    workspaceId: overrideWorkspaceId,
    workspacePath: overrideWorkspacePath,
    ...restOverrides
  } = overrides
  const workspaceId = overrideWorkspaceId || 'ws-1'
  const workspacePath = overrideWorkspacePath || '/repo'
  const templateOverrides = templateOverridesRaw || {}
  const chatId = templateOverrides.chatId || AppStore.createChat(workspaceId, workspacePath).appChatId
  return {
    name: 'Audit loop',
    workspaceId,
    workspacePath,
    enabled: true,
    trigger: {
      kind: 'interval' as const,
      intervalMs,
      startAt: plannedFor,
      timezone: 'Europe/London'
    },
    template: {
      workspaceId,
      workspacePath,
      chatId,
      provider: 'codex' as const,
      prompt: 'Review the current diff.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      ...templateOverrides
    },
    missedRunPolicy: 'coalesce' as const,
    concurrencyPolicy: 'skip' as const,
    limits: {
      maxRunsPerDay: 24,
      maxConsecutiveFailures: 3
    },
    nextRunAt: plannedFor,
    ...restOverrides
  }
}

describe('AppStore workflows', () => {
  beforeEach(() => {
    vi.useRealTimers()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('materializes a due workflow into a scheduled task and advances the next run', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const tasks = AppStore.materializeDueWorkflows(Date.parse(plannedFor))

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      workspaceId: 'ws-1',
      provider: 'codex',
      status: 'due',
      workflowId: saved.id,
      workflowOccurrenceAt: plannedFor
    })

    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.lastStatus).toBe('queued')
    expect(workflow?.activeExecutionId).toBe(tasks[0].workflowExecutionId)
    expect(workflow?.history[0]?.scheduledTaskId).toBe(tasks[0].id)
    expect(workflow?.nextRunAt).toBe(new Date(Date.parse(plannedFor) + intervalMs).toISOString())
  })

  it('advances a skipped due occurrence when an execution is already active', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({
        missedRunPolicy: 'skip',
        activeExecutionId: 'execution-active',
        history: [
          {
            id: 'execution-active',
            workflowId: 'workflow-pending',
            plannedFor: '2026-06-07T19:45:00.000Z',
            status: 'running',
            createdAt: '2026-06-07T19:45:00.000Z',
            updatedAt: '2026-06-07T19:46:00.000Z'
          }
        ]
      })
    )

    const tasks = AppStore.materializeDueWorkflows(Date.parse(plannedFor))

    expect(tasks).toHaveLength(0)
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.lastStatus).toBe('skipped')
    expect(workflow?.lastError).toMatch(/previous workflow execution is still active/)
    expect(workflow?.history).toHaveLength(2)
    expect(workflow?.nextRunAt).toBe(new Date(Date.parse(plannedFor) + intervalMs).toISOString())
  })

  it('syncs scheduled task completion back into workflow history', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))

    const running = AppStore.updateScheduledTask(task.id, {
      status: 'running',
      runId: 'run-1',
      firedAt: '2026-06-07T20:00:01.000Z'
    })
    expect(running?.status).toBe('running')
    expect(AppStore.getWorkflowDefinition(saved.id)?.lastStatus).toBe('running')

    AppStore.updateScheduledTask(task.id, {
      status: 'completed',
      completedAt: '2026-06-07T20:01:00.000Z'
    })

    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.lastStatus).toBe('completed')
    expect(workflow?.activeExecutionId).toBeUndefined()
    expect(workflow?.history[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      completedAt: '2026-06-07T20:01:00.000Z'
    })
    expect(workflow?.nextRunAt).toBe(new Date(Date.parse(plannedFor) + intervalMs).toISOString())
  })

  it('does not resurrect completed scheduled tasks from stale status updates', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))

    AppStore.updateScheduledTask(task.id, {
      status: 'running',
      runId: 'run-1',
      firedAt: '2026-06-07T20:00:01.000Z'
    })
    AppStore.updateScheduledTask(task.id, {
      status: 'completed',
      completedAt: '2026-06-07T20:01:00.000Z'
    })

    const stale = AppStore.updateScheduledTask(task.id, {
      status: 'running',
      runId: 'run-stale',
      firedAt: '2026-06-07T20:02:00.000Z'
    })

    expect(stale?.status).toBe('completed')
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.lastStatus).toBe('completed')
    expect(workflow?.history[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed'
    })
  })

  it('does not increment failure streak twice for duplicate failed task syncs', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))

    AppStore.updateScheduledTask(task.id, {
      status: 'running',
      runId: 'run-1',
      firedAt: '2026-06-07T20:00:01.000Z'
    })
    AppStore.updateScheduledTask(task.id, {
      status: 'failed',
      completedAt: '2026-06-07T20:01:00.000Z',
      lastError: 'failed once'
    })
    AppStore.updateScheduledTask(task.id, {
      status: 'failed',
      completedAt: '2026-06-07T20:01:30.000Z',
      lastError: 'duplicate failed event'
    })

    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.failureStreak).toBe(1)
    expect(workflow?.enabled).toBe(true)
    expect(workflow?.lastStatus).toBe('failed')
  })

  it('recovers interrupted running scheduled workflow tasks on startup', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.updateScheduledTask(task.id, {
      status: 'running',
      runId: 'run-1',
      firedAt: '2026-06-07T20:00:01.000Z'
    })

    const recovered = AppStore.recoverInterruptedScheduledTasksAfterStartup(
      Date.parse('2026-06-07T20:02:00.000Z')
    )

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      id: task.id,
      status: 'failed',
      runId: 'run-1',
      completedAt: '2026-06-07T20:02:00.000Z',
      lastError: 'TaskWraith restarted before this scheduled run completed.'
    })
    const scheduledTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    expect(scheduledTask?.status).toBe('failed')
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.activeExecutionId).toBeUndefined()
    expect(workflow?.lastStatus).toBe('failed')
    expect(workflow?.failureStreak).toBe(1)
    expect(workflow?.nextRunAt).toBe(new Date(Date.parse(plannedFor) + intervalMs).toISOString())
    expect(workflow?.history[0]).toMatchObject({
      runId: 'run-1',
      status: 'failed',
      completedAt: '2026-06-07T20:02:00.000Z'
    })
  })

  it('leaves non-running scheduled tasks unchanged during startup recovery', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.updateScheduledTask(task.id, {
      status: 'cancelled',
      completedAt: '2026-06-07T20:01:00.000Z',
      lastError: 'Cancelled by user.'
    })

    const recovered = AppStore.recoverInterruptedScheduledTasksAfterStartup(
      Date.parse('2026-06-07T20:02:00.000Z')
    )

    expect(recovered).toHaveLength(0)
    const scheduledTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    expect(scheduledTask?.status).toBe('cancelled')
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.lastStatus).toBe('cancelled')
  })

  it('keeps manual workflows unscheduled after the daily run limit is reached', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({
        trigger: { kind: 'manual' },
        nextRunAt: undefined,
        limits: {
          maxRunsPerDay: 1,
          maxConsecutiveFailures: 3
        },
        history: [
          {
            id: 'execution-completed',
            workflowId: 'workflow-manual',
            plannedFor: '2026-06-07T10:00:00.000Z',
            status: 'completed',
            createdAt: '2026-06-07T10:00:00.000Z',
            updatedAt: '2026-06-07T10:01:00.000Z',
            completedAt: '2026-06-07T10:01:00.000Z'
          }
        ]
      })
    )

    const task = AppStore.materializeWorkflowNow(saved.id, Date.parse(plannedFor))

    expect(task).toBeNull()
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.lastStatus).toBe('skipped')
    expect(workflow?.lastError).toMatch(/Daily workflow run limit/)
    expect(workflow?.nextRunAt).toBeUndefined()
    expect(AppStore.materializeDueWorkflows(Date.parse('2026-06-08T00:01:00.000Z'))).toHaveLength(
      0
    )
  })

  it('materializes a workflow immediately for Run now', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({
        trigger: { kind: 'manual' },
        nextRunAt: undefined
      })
    )

    const task = AppStore.materializeWorkflowNow(saved.id, Date.parse(plannedFor))

    expect(task).toMatchObject({
      workspaceId: 'ws-1',
      provider: 'codex',
      status: 'due',
      workflowId: saved.id,
      workflowOccurrenceAt: plannedFor
    })
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.activeExecutionId).toBe(task?.workflowExecutionId)
    expect(workflow?.lastStatus).toBe('queued')
    expect(workflow?.history[0]?.scheduledTaskId).toBe(task?.id)
  })

  it('rejects workflows whose target chat belongs to another workspace', () => {
    const otherChat = AppStore.createChat('ws-2', '/other')
    const input = workflowInput()
    input.template = {
      ...input.template,
      chatId: otherChat.appChatId
    }

    expect(() => AppStore.saveWorkflowDefinition(input)).toThrow('selected workspace')
  })

  it('rejects non-workspace external path grants in workflow templates', () => {
    const input = workflowInput()
    input.template = {
      ...input.template,
      externalPathGrants: [
        {
          id: 'grant-1',
          provider: 'codex',
          workspaceId: 'ws-1',
          chatId: input.template.chatId,
          path: '/tmp/secret.txt',
          kind: 'file',
          access: 'read',
          duration: 'thisThread',
          createdAt: '2026-06-07T19:00:00.000Z'
        }
      ]
    }

    expect(() => AppStore.saveWorkflowDefinition(input)).toThrow('workspace-scoped')
  })

  it('persists + clamps a workflow loop config; a workflow with no loop stays single-occurrence', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({
        loop: {
          acceptance: { maxIterations: 0, verifier: { provider: 'codex' } },
          limits: { maxRuns: 0 }
        }
      })
    )
    // normalizeWorkflowLoopConfig clamps the fail-safe backstops (0 → defaults).
    expect(saved.loop).toEqual({
      acceptance: { maxIterations: 3, verifier: { provider: 'codex' } },
      limits: { maxRuns: 6 }
    })
    expect(AppStore.saveWorkflowDefinition(workflowInput()).loop).toBeUndefined()
  })

  it('stamps runningSince on the transition into running and does not reset it on a benign re-patch', () => {
    AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const running = AppStore.updateScheduledTask(task.id, { status: 'running', runId: 'run-1' })
    expect(running?.runningSince).toBeTruthy()
    const firstStamp = running?.runningSince
    const repatched = AppStore.updateScheduledTask(task.id, { runId: 'run-1' })
    expect(repatched?.status).toBe('running')
    expect(repatched?.runningSince).toBe(firstStamp)
    expect(task.runningSince).toBeUndefined()
  })

  it('settleStalledScheduledTasks settles a due-wedge and unblocks the next occurrence', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const materializeMs = Date.parse(plannedFor)
    const [task] = AppStore.materializeDueWorkflows(materializeMs)
    expect(task.status).toBe('due')
    AppStore.updateScheduledTask(task.id, {
      status: 'due',
      firedAt: new Date(materializeMs).toISOString()
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.activeExecutionId).toBe(
      task.workflowExecutionId
    )
    const settled = AppStore.settleStalledScheduledTasks(() => false, materializeMs + 7 * 60 * 60 * 1000)
    expect(settled.map((t) => t.id)).toEqual([task.id])
    expect(settled[0].status).toBe('failed')
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.activeExecutionId).toBeUndefined()
    expect(workflow?.failureStreak).toBe(1)
    expect(workflow?.lastStatus).toBe('failed')
  })

  it('settleStalledScheduledTasks settles a running-wedge with a dead job but SKIPS a live one', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const materializeMs = Date.parse(plannedFor)
    const [task] = AppStore.materializeDueWorkflows(materializeMs)
    // Explicit runningSince so the backstop is measured against mock time (the
    // auto-stamp uses real wall-clock, which a mocked nowMs can't reach).
    AppStore.updateScheduledTask(task.id, {
      status: 'running',
      runId: 'run-1',
      runningSince: new Date(materializeMs).toISOString()
    })
    const later = materializeMs + 7 * 60 * 60 * 1000

    // LIVE job -> not settled (false-positive guard).
    expect(AppStore.settleStalledScheduledTasks((id) => id === 'run-1', later)).toHaveLength(0)
    expect(AppStore.getScheduledTasks().find((t) => t.id === task.id)?.status).toBe('running')
    expect(AppStore.getWorkflowDefinition(saved.id)?.activeExecutionId).toBe(
      task.workflowExecutionId
    )

    // DEAD job -> settled.
    const settled = AppStore.settleStalledScheduledTasks(() => false, later)
    expect(settled.map((t) => t.id)).toEqual([task.id])
    expect(AppStore.getWorkflowDefinition(saved.id)?.activeExecutionId).toBeUndefined()
    // Idempotent: a second sweep settles nothing (transition guard).
    expect(AppStore.settleStalledScheduledTasks(() => false, later)).toHaveLength(0)
  })

  it('settleStalledScheduledTasks engages maxConsecutiveFailures after N wedged occurrences', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 24, maxConsecutiveFailures: 2 } })
    )
    const backstop = 7 * 60 * 60 * 1000
    for (let i = 0; i < 2; i++) {
      const nextRunAt = AppStore.getWorkflowDefinition(saved.id)?.nextRunAt
      if (!nextRunAt) break
      const occMs = Date.parse(nextRunAt)
      const [task] = AppStore.materializeDueWorkflows(occMs)
      expect(task).toBeTruthy()
      AppStore.updateScheduledTask(task.id, {
        status: 'running',
        runId: `run-${i}`,
        runningSince: new Date(occMs).toISOString()
      })
      AppStore.settleStalledScheduledTasks(() => false, occMs + backstop)
    }
    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.failureStreak).toBeGreaterThanOrEqual(2)
    expect(workflow?.enabled).toBe(false)
    expect(workflow?.nextRunAt).toBeUndefined()
  })
})

describe('AppStore workflow unattended elevation (P2)', () => {
  const wellFormedAck = {
    level: 'full_access' as const,
    acknowledgedAt: '2026-06-24T00:00:00.000Z',
    acknowledgedApprovalMode: 'auto_edit',
    signature: 'a'.repeat(64)
  }

  it('persists + normalizes a well-formed ack through setWorkflowUnattendedElevation', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    AppStore.setWorkflowUnattendedElevation(saved.id, wellFormedAck)
    expect(AppStore.getWorkflowDefinition(saved.id)?.unattendedElevation).toEqual(wellFormedAck)
  })

  it('DROPS a malformed ack at normalize (missing signature / bad level / non-string)', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    for (const bad of [
      { ...wellFormedAck, signature: '' },
      { ...wellFormedAck, signature: undefined as unknown as string },
      { ...wellFormedAck, level: 'root' as unknown as 'safe' },
      { ...wellFormedAck, acknowledgedAt: '' },
      { ...wellFormedAck, acknowledgedApprovalMode: 123 as unknown as string }
    ]) {
      AppStore.setWorkflowUnattendedElevation(saved.id, bad as never)
      expect(AppStore.getWorkflowDefinition(saved.id)?.unattendedElevation).toBeUndefined()
    }
  })

  it('updateWorkflowDefinition NULLS the ack when template.approvalMode changes', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ template: { approvalMode: 'auto_edit' } })
    )
    AppStore.setWorkflowUnattendedElevation(saved.id, wellFormedAck)
    const updated = AppStore.updateWorkflowDefinition(saved.id, {
      template: { ...saved.template, approvalMode: 'default' }
    })
    expect(updated?.unattendedElevation).toBeUndefined()
    expect(AppStore.getWorkflowDefinition(saved.id)?.unattendedElevation).toBeUndefined()
  })

  it('updateWorkflowDefinition (unrelated field) PRESERVES the ack', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ template: { approvalMode: 'auto_edit' } })
    )
    AppStore.setWorkflowUnattendedElevation(saved.id, wellFormedAck)
    const updated = AppStore.updateWorkflowDefinition(saved.id, { name: 'Renamed loop' })
    expect(updated?.name).toBe('Renamed loop')
    expect(updated?.unattendedElevation).toEqual(wellFormedAck)
  })

  it('setWorkflowUnattendedElevation(undefined) revokes', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    AppStore.setWorkflowUnattendedElevation(saved.id, wellFormedAck)
    AppStore.setWorkflowUnattendedElevation(saved.id, undefined)
    expect(AppStore.getWorkflowDefinition(saved.id)?.unattendedElevation).toBeUndefined()
  })
})

describe('AppStore workflow run ledger (Stage 1)', () => {
  it('records the running → completed lifecycle in the durable per-execution ledger', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const executionId = task.workflowExecutionId as string

    AppStore.updateScheduledTask(task.id, { status: 'running', runId: 'run-1', firedAt: plannedFor })
    AppStore.updateScheduledTask(task.id, {
      status: 'completed',
      completedAt: '2026-06-07T20:05:00.000Z'
    })

    const events = AppStore.getWorkflowRunEvents(executionId)
    expect(events.map((e) => e.kind)).toEqual(['running', 'completed'])
    expect(events.every((e) => e.workflowExecutionId === executionId)).toBe(true)
    expect(events.every((e) => e.workflowId === saved.id)).toBe(true)
    expect(events[0].runId).toBe('run-1')
    expect(events.map((e) => e.sequence)).toEqual([1, 2]) // append-only, monotonic
  })

  it('records a failed terminal with its error and does not duplicate on a no-op re-patch', () => {
    AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const executionId = task.workflowExecutionId as string

    AppStore.updateScheduledTask(task.id, { status: 'running', runId: 'run-1' })
    AppStore.updateScheduledTask(task.id, { status: 'failed', lastError: 'boom' })
    // A re-patch that does not change status must not append a duplicate event.
    AppStore.updateScheduledTask(task.id, { status: 'failed', lastError: 'boom' })

    const events = AppStore.getWorkflowRunEvents(executionId)
    expect(events.map((e) => e.kind)).toEqual(['running', 'failed'])
    expect(events[1].error).toBe('boom')
  })

  it('returns an empty ledger for an unknown execution', () => {
    expect(AppStore.getWorkflowRunEvents('nope')).toEqual([])
  })

  it('reconcileStaleWorkflowRunLedgers settles a crash-orphaned (non-terminal) ledger, idempotently', () => {
    AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const executionId = task.workflowExecutionId as string
    // Left mid-run by a crash: a 'running' ledger event, no terminal lifecycle event.
    AppStore.updateScheduledTask(task.id, { status: 'running', runId: 'run-1', firedAt: plannedFor })

    const settled = AppStore.reconcileStaleWorkflowRunLedgers()
    expect(settled.some((e) => e.workflowExecutionId === executionId)).toBe(true)
    expect(AppStore.getWorkflowRunEvents(executionId).map((e) => e.kind)).toEqual([
      'running',
      'stall_settled'
    ])

    // Idempotent across boots: stall_settled is terminal, so a second pass is a no-op
    // for this execution (no unbounded re-settling / file growth).
    const settledAgain = AppStore.reconcileStaleWorkflowRunLedgers()
    expect(settledAgain.some((e) => e.workflowExecutionId === executionId)).toBe(false)
    expect(AppStore.getWorkflowRunEvents(executionId).map((e) => e.kind)).toEqual([
      'running',
      'stall_settled'
    ])
  })
})
