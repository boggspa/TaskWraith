import { describe, expect, it, vi } from 'vitest'
import type { ScheduledTask, WorkflowDefinition } from '../store/types'
import {
  isRemoteWorkflowRunnableChat,
  RemoteWorkflowActions,
  remoteWorkflowApprovalMode,
  type RemoteWorkflowActionsDependencies
} from './RemoteWorkflowActions'

const authorization = {
  workspaceId: 'ws-1',
  provider: 'codex',
  approvalMode: 'plan'
}

const context = {
  requestingDeviceKey: null,
  ...authorization
}

function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'wf-1',
    name: 'Remote workflow',
    workspaceId: 'ws-1',
    workspacePath: '/workspace',
    enabled: false,
    template: { provider: 'codex' },
    history: [],
    ...overrides
  } as unknown as WorkflowDefinition
}

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    workflowId: 'wf-1',
    workflowExecutionId: 'execution-1',
    ...overrides
  } as unknown as ScheduledTask
}

function harness(options: {
  current?: WorkflowDefinition | null
  now?: () => number
  task?: ScheduledTask | null
  runNowCooldownMs?: number
} = {}) {
  let current = options.current === undefined ? workflow() : options.current
  const deps: RemoteWorkflowActionsDependencies = {
    getWorkflowDefinition: vi.fn(() => current),
    resolveAuthorization: vi.fn(() => ({ allowed: true as const, authorization })),
    updateWorkflowDefinition: vi.fn((_id, partial) => {
      if (!current) return null
      current = { ...current, ...partial }
      return current
    }),
    materializeWorkflowNow: vi.fn(() =>
      options.task === undefined ? scheduledTask() : options.task
    ),
    ensureScheduledTaskSignedPosture: vi.fn((task) => ({
      ...task,
      permissionPosture: { signaturePresent: true }
    }) as ScheduledTask),
    broadcastWorkflowDefinitionsChanged: vi.fn(),
    broadcastScheduledTasksChanged: vi.fn(),
    broadcastRemoteProjectionSnapshot: vi.fn(),
    emitDueScheduledTasks: vi.fn(),
    scheduleNextTaskTimer: vi.fn(),
    now: options.now,
    runNowCooldownMs: options.runNowCooldownMs
  }
  return { actions: new RemoteWorkflowActions(deps), deps }
}

describe('RemoteWorkflowActions', () => {
  it('accepts only a live workspace-scoped chat in the canonical workflow workspace', () => {
    const canonicalWorkspaceId = (value: string | null | undefined) => value ?? null
    const canonicalPath = (value: string) => value.replace(/\/$/, '')
    const matches = (
      overrides: Partial<Pick<WorkflowDefinition, 'workspaceId' | 'workspacePath'>> & {
        scope?: 'workspace' | 'global'
        archived?: boolean
      } = {}
    ) =>
      isRemoteWorkflowRunnableChat({
        chat: {
          scope: overrides.scope ?? 'workspace',
          archived: overrides.archived ?? false,
          workspaceId: overrides.workspaceId ?? 'ws-1',
          workspacePath: overrides.workspacePath ?? '/workspace/'
        },
        workspaceId: 'ws-1',
        workspacePath: '/workspace',
        canonicalWorkspaceId,
        canonicalPath
      })

    expect(matches()).toBe(true)
    expect(matches({ scope: 'global' })).toBe(false)
    expect(matches({ archived: true })).toBe(false)
    expect(matches({ workspaceId: 'ws-2' })).toBe(false)
    expect(matches({ workspacePath: '/other' })).toBe(false)
  })

  it('uses explicit plan without a verified elevation and honors only a verified ceiling', () => {
    const runNow = { kind: 'workflowRunNow' as const, workflowId: 'wf-1' }
    expect(remoteWorkflowApprovalMode(runNow, 'auto_edit')).toBe('plan')
    expect(
      remoteWorkflowApprovalMode(runNow, 'default', {
        level: 'default',
        acknowledgedAt: '2026-07-14T00:00:00.000Z',
        acknowledgedApprovalMode: 'default',
        authorityDigest: 'a'.repeat(64),
        signature: 'already-verified-by-main'
      })
    ).toBe('default')
    expect(
      remoteWorkflowApprovalMode(
        { kind: 'workflowSetEnabled', workflowId: 'wf-1', enabled: false },
        'auto_edit',
        {
          level: 'full_access',
          acknowledgedAt: '2026-07-14T00:00:00.000Z',
          acknowledgedApprovalMode: 'auto_edit',
          authorityDigest: 'a'.repeat(64),
          signature: 'already-verified-by-main'
        }
      )
    ).toBe('plan')
  })

  it('keeps same-state enable idempotent without rescheduling or broadcasting', async () => {
    const { actions, deps } = harness({ current: workflow({ enabled: true }) })
    const result = await actions.setEnabled(
      { kind: 'workflowSetEnabled', workflowId: 'wf-1', enabled: true },
      context
    )

    expect(result).toEqual({ ok: true, enabled: true })
    expect(deps.updateWorkflowDefinition).not.toHaveBeenCalled()
    expect(deps.broadcastWorkflowDefinitionsChanged).not.toHaveBeenCalled()
    expect(deps.scheduleNextTaskTimer).not.toHaveBeenCalled()
  })

  it('revalidates authorization before changing enabled state', async () => {
    const { actions, deps } = harness()
    const staleContext = { ...context, workspaceId: 'stale-workspace' }
    const denied = await actions.setEnabled(
      { kind: 'workflowSetEnabled', workflowId: 'wf-1', enabled: true },
      staleContext
    )
    expect(denied).toMatchObject({ ok: false, reason: expect.stringMatching(/changed underneath/) })
    expect(deps.updateWorkflowDefinition).not.toHaveBeenCalled()

    const accepted = await actions.setEnabled(
      { kind: 'workflowSetEnabled', workflowId: 'wf-1', enabled: true },
      context
    )
    expect(accepted).toEqual({ ok: true, enabled: true })
    expect(deps.updateWorkflowDefinition).toHaveBeenCalledWith('wf-1', { enabled: true })
    expect(deps.broadcastWorkflowDefinitionsChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.scheduleNextTaskTimer).toHaveBeenCalledTimes(1)
  })

  it('materializes once, signs posture, and uses the headless-safe due path', async () => {
    const { actions, deps } = harness({ now: () => 10_000 })
    const result = await actions.runNow(
      { kind: 'workflowRunNow', workflowId: 'wf-1' },
      context
    )

    expect(result).toEqual({
      ok: true,
      scheduledTaskId: 'task-1',
      workflowExecutionId: 'execution-1'
    })
    expect(deps.materializeWorkflowNow).toHaveBeenCalledWith('wf-1', 10_000)
    expect(deps.ensureScheduledTaskSignedPosture).toHaveBeenCalledTimes(1)
    expect(deps.broadcastWorkflowDefinitionsChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastScheduledTasksChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.emitDueScheduledTasks).toHaveBeenCalledTimes(1)
    expect(deps.scheduleNextTaskTimer).toHaveBeenCalledTimes(1)
  })

  it('rate-limits fresh action ids at the workflow boundary', async () => {
    let now = 1_000
    const { actions, deps } = harness({ now: () => now, runNowCooldownMs: 3_000 })
    const action = { kind: 'workflowRunNow' as const, workflowId: 'wf-1' }

    expect(await actions.runNow(action, context)).toMatchObject({ ok: true })
    expect(await actions.runNow(action, context)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/rate limited/)
    })
    now += 3_000
    expect(await actions.runNow(action, context)).toMatchObject({ ok: true })
    expect(deps.materializeWorkflowNow).toHaveBeenCalledTimes(2)
  })

  it('refuses to duplicate an active occurrence before consuming cooldown', async () => {
    const active = workflow({
      activeExecutionId: 'active-1',
      history: [
        {
          id: 'active-1',
          workflowId: 'wf-1',
          plannedFor: '2026-07-14T00:00:00.000Z',
          status: 'running',
          createdAt: '2026-07-14T00:00:00.000Z',
          updatedAt: '2026-07-14T00:00:00.000Z'
        }
      ]
    })
    const { actions, deps } = harness({ current: active })
    const result = await actions.runNow(
      { kind: 'workflowRunNow', workflowId: 'wf-1' },
      context
    )

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/active execution/) })
    expect(deps.materializeWorkflowNow).not.toHaveBeenCalled()
  })

  it('surfaces materialization failure without emitting a due event', async () => {
    const failed = workflow({ lastError: 'Daily workflow run limit reached (1).' })
    const { actions, deps } = harness({ current: failed, task: null })
    const result = await actions.runNow(
      { kind: 'workflowRunNow', workflowId: 'wf-1' },
      context
    )

    expect(result).toEqual({ ok: false, reason: 'Daily workflow run limit reached (1).' })
    expect(deps.emitDueScheduledTasks).not.toHaveBeenCalled()
  })
})
