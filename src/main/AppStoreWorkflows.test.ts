import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import type {
  PersistedAttachmentRef,
  ScheduledTaskAttachmentRef,
  WorkflowDefinition,
  WorkflowRunTemplate
} from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-workflows-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const plannedFor = '2026-06-07T20:00:00.000Z'
const intervalMs = 15 * 60_000
type WorkflowInput = Parameters<typeof AppStore.saveWorkflowDefinition>[0]

function durableAttachment(
  overrides: Partial<ScheduledTaskAttachmentRef & PersistedAttachmentRef> = {}
): ScheduledTaskAttachmentRef & PersistedAttachmentRef {
  return {
    persistenceVersion: 1,
    id: 'image-1',
    path: '/tmp/taskwraith-assets/image-1.png',
    name: 'proof.png',
    sha256: 'd'.repeat(43),
    mimeType: 'image/png',
    byteLength: 12,
    ...overrides
  }
}

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
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ template: { workflowMode: 'plan' } })
    )
    const tasks = AppStore.materializeDueWorkflows(Date.parse(plannedFor))

    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      workspaceId: 'ws-1',
      provider: 'codex',
      status: 'due',
      workflowMode: 'plan',
      workflowId: saved.id,
      workflowOccurrenceAt: plannedFor
    })
    expect(tasks[0].dispatchReceipt).toMatchObject({
      schemaVersion: 1,
      runId: tasks[0].id,
      provider: 'codex',
      source: 'scheduled',
      workspaceId: 'ws-1',
      chatId: tasks[0].chatId,
      approvalMode: 'default',
      workflowMode: 'plan',
      permissionPostureSignaturePresent: false
    })
    expect(tasks[0].dispatchReceipt?.receiptHash).toMatch(/^[a-f0-9]{64}$/)

    const workflow = AppStore.getWorkflowDefinition(saved.id)
    expect(workflow?.lastStatus).toBe('queued')
    expect(workflow?.activeExecutionId).toBe(tasks[0].workflowExecutionId)
    expect(workflow?.history[0]?.scheduledTaskId).toBe(tasks[0].id)
    expect(workflow?.nextRunAt).toBe(new Date(Date.parse(plannedFor) + intervalMs).toISOString())
  })

  it('resolves durable workflow attachments before materialization and preserves their identity', () => {
    const attachment = durableAttachment()
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ template: { imageAttachments: [attachment] } })
    )
    const resolveAttachments = vi.fn(({ attachments }) => ({
      ok: true as const,
      attachments: attachments.map(() => ({
        ...attachment,
        id: undefined,
        name: undefined,
        path: '/tmp/taskwraith-assets/canonical-image.png'
      }))
    }))

    const tasks = AppStore.materializeDueWorkflows(Date.parse(plannedFor), resolveAttachments)

    expect(resolveAttachments).toHaveBeenCalledWith({
      source: 'workflow-template',
      recordId: saved.id,
      appChatId: saved.template.chatId,
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      externalPathGrants: [],
      attachments: [attachment]
    })
    expect(tasks[0]?.imageAttachments).toEqual([
      {
        ...attachment,
        path: '/tmp/taskwraith-assets/canonical-image.png'
      }
    ])
  })

  it('disables a legacy workflow attachment without passing its path to the resolver', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const workflowsPath = `${userDataPath}/workflows.json`
    const rows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    rows[0].template.imageAttachments = [
      { id: 'legacy-1', name: 'legacy.png', path: '/repo/legacy.png' }
    ]
    fs.writeFileSync(workflowsPath, JSON.stringify(rows))
    const resolveAttachments = vi.fn(() => ({ ok: true as const, attachments: [] }))

    expect(
      AppStore.materializeDueWorkflows(Date.parse(plannedFor), resolveAttachments)
    ).toEqual([])
    expect(resolveAttachments).not.toHaveBeenCalled()
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      enabled: false,
      lastStatus: 'failed',
      lastError: expect.stringContaining('Re-select the attachments')
    })
  })

  it('disables a workflow when its durable attachment no longer resolves', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ template: { imageAttachments: [durableAttachment()] } })
    )
    const resolveAttachments = vi.fn(() => ({ ok: false as const, reason: 'missing' }))

    expect(
      AppStore.materializeDueWorkflows(Date.parse(plannedFor), resolveAttachments)
    ).toEqual([])
    expect(resolveAttachments).toHaveBeenCalledOnce()
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      enabled: false,
      lastStatus: 'failed',
      lastError: expect.stringContaining('Re-select the attachments')
    })
  })

  it('rebuilds a scheduled task dispatch receipt when trusted posture is attached', () => {
    const chatId = AppStore.createChat('ws-1', '/repo').appChatId
    const task = AppStore.saveScheduledTask({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Run later.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      workflowMode: 'normal',
      sessionTrust: false,
      imageAttachments: [],
      runAt: plannedFor,
      timezone: 'Europe/London'
    })
    const updated = AppStore.updateScheduledTask(task.id, {
      permissionPosture: {
        schemaVersion: 1,
        approvalMode: 'plan',
        workflowMode: 'normal',
        presetId: 'read_only',
        readOnly: true,
        externalPathGrantCount: 0,
        postureHash: 'a'.repeat(64),
        signature: 'b'.repeat(64),
        signaturePresent: true
      }
    })

    expect(updated?.dispatchReceipt).toMatchObject({
      runId: task.id,
      provider: 'codex',
      source: 'scheduled',
      approvalMode: 'plan',
      workflowMode: 'normal',
      permissionPresetId: 'read_only',
      readOnly: true,
      permissionPostureHash: 'a'.repeat(64),
      permissionPostureSignaturePresent: true
    })
  })

  it('resolves durable scheduled-task attachments before returning due work', () => {
    const chatId = AppStore.createChat('ws-1', '/repo').appChatId
    const attachment = durableAttachment()
    const task = AppStore.saveScheduledTask({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Run later.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      workflowMode: 'normal',
      sessionTrust: false,
      imageAttachments: [attachment],
      runAt: plannedFor,
      timezone: 'Europe/London',
      status: 'due'
    })
    const resolveAttachments = vi.fn(({ attachments }) => ({
      ok: true as const,
      attachments: attachments.map(() => ({
        ...attachment,
        id: undefined,
        name: undefined,
        path: '/tmp/taskwraith-assets/canonical-task.png'
      }))
    }))

    const due = AppStore.getDueScheduledTasks(Date.parse(plannedFor), resolveAttachments)

    expect(resolveAttachments).toHaveBeenCalledWith({
      source: 'scheduled-task',
      recordId: task.id,
      appChatId: chatId,
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      externalPathGrants: [],
      attachments: [attachment]
    })
    expect(due[0]?.imageAttachments).toEqual([
      { ...attachment, path: '/tmp/taskwraith-assets/canonical-task.png' }
    ])
    expect(AppStore.getScheduledTasks()[0]?.imageAttachments).toEqual(due[0]?.imageAttachments)
  })

  it('fails a due legacy scheduled attachment without passing its path to the resolver', () => {
    const chatId = AppStore.createChat('ws-1', '/repo').appChatId
    const task = AppStore.saveScheduledTask({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Run later.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      workflowMode: 'normal',
      sessionTrust: false,
      imageAttachments: [],
      runAt: plannedFor,
      timezone: 'Europe/London',
      status: 'due'
    })
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const rows = JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
    rows[0].imageAttachments = [
      { id: 'legacy-1', name: 'legacy.png', path: '/repo/legacy.png' }
    ]
    fs.writeFileSync(tasksPath, JSON.stringify(rows))
    const resolveAttachments = vi.fn(() => ({ ok: true as const, attachments: [] }))

    expect(AppStore.getDueScheduledTasks(Date.parse(plannedFor), resolveAttachments)).toEqual([])
    expect(resolveAttachments).not.toHaveBeenCalled()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('Re-select the attachments'),
      imageAttachments: [
        { id: 'legacy-1', name: 'legacy.png', path: '/repo/legacy.png' }
      ]
    })
  })

  it('rejects new raw scheduled attachments before persistence', () => {
    const chatId = AppStore.createChat('ws-1', '/repo').appChatId
    expect(() =>
      AppStore.saveScheduledTask({
        workspaceId: 'ws-1',
        workspacePath: '/repo',
        chatId,
        provider: 'codex',
        prompt: 'Run later.',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        workflowMode: 'normal',
        sessionTrust: false,
        imageAttachments: [
          { id: 'legacy-1', name: 'legacy.png', path: '/repo/legacy.png' }
        ],
        runAt: plannedFor,
        timezone: 'Europe/London'
      })
    ).toThrow('Re-select the attachments')
  })

  it('keeps the signed scheduled posture authoritative when mutable approval mode changes before dispatch', () => {
    const chatId = AppStore.createChat('ws-1', '/repo').appChatId
    const task = AppStore.saveScheduledTask({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Run later.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      workflowMode: 'normal',
      sessionTrust: false,
      imageAttachments: [],
      runAt: plannedFor,
      timezone: 'Europe/London',
      permissionPosture: {
        schemaVersion: 1,
        approvalMode: 'plan',
        workflowMode: 'normal',
        presetId: 'read_only',
        readOnly: true,
        externalPathGrantCount: 0,
        postureHash: 'c'.repeat(64),
        signature: 'd'.repeat(64),
        signaturePresent: true
      }
    })

    const edited = AppStore.updateScheduledTask(task.id, { approvalMode: 'auto_edit' })
    expect(edited?.approvalMode).toBe('auto_edit')
    expect(edited?.permissionPosture?.approvalMode).toBe('plan')

    const running = AppStore.updateScheduledTask(task.id, {
      status: 'running',
      runId: 'run-after-policy-edit',
      firedAt: '2026-06-07T20:00:01.000Z'
    })

    expect(running?.dispatchReceipt).toMatchObject({
      runId: 'run-after-policy-edit',
      provider: 'codex',
      source: 'scheduled',
      approvalMode: 'plan',
      workflowMode: 'normal',
      permissionPresetId: 'read_only',
      readOnly: true,
      permissionPostureHash: 'c'.repeat(64),
      permissionPostureSignaturePresent: true
    })
  })

  it('slice 7b — persists the cached loop summary through normalize (for the iOS projection)', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const updated = AppStore.updateWorkflowDefinition(saved.id, {
      lastRunIterationCount: 3,
      lastRunStopReason: 'accepted',
      lastRunTokens: 1234
    })
    expect(updated).toMatchObject({
      lastRunIterationCount: 3,
      lastRunStopReason: 'accepted',
      lastRunTokens: 1234
    })
    // Must survive a fresh read — the normalizer whitelists fields, so these have to
    // be explicitly preserved or the projection would never see them after a reload.
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      lastRunIterationCount: 3,
      lastRunStopReason: 'accepted',
      lastRunTokens: 1234
    })
  })

  it('slice 7b — drops a malformed cached loop summary at normalize', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const updated = AppStore.updateWorkflowDefinition(saved.id, {
      lastRunIterationCount: Number.NaN as unknown as number,
      lastRunStopReason: 42 as unknown as string,
      lastRunTokens: -5
    })
    expect(updated?.lastRunIterationCount).toBeUndefined() // NaN → undefined
    expect(updated?.lastRunStopReason).toBeUndefined() // non-string → undefined
    expect(updated?.lastRunTokens).toBe(0) // negative clamped to ≥0
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

  it('preserves workspace-scoped external path grants through save and materialization', () => {
    const input = workflowInput({ trigger: { kind: 'manual' }, nextRunAt: undefined })
    const grant = {
      id: 'grant-workspace-1',
      provider: 'codex' as const,
      bindingVersion: 2 as const,
      workspaceId: 'ws-1',
      chatId: input.template.chatId,
      path: '/tmp/approved-external-workspace',
      kind: 'directory' as const,
      access: 'write' as const,
      duration: 'workspace' as const,
      issuedBy: 'main' as const,
      signature: 'a'.repeat(64),
      createdAt: '2026-06-07T19:00:00.000Z'
    }
    input.template = { ...input.template, externalPathGrants: [grant] }

    const saved = AppStore.saveWorkflowDefinition(input)
    expect(saved.template.externalPathGrants).toEqual([grant])

    const task = AppStore.materializeWorkflowNow(saved.id, Date.parse(plannedFor))
    expect(task?.externalPathGrants).toEqual([grant])
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

describe('AppStore audit reconciler (slice 6)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  const auditInput = (status: 'running' | 'planning' | 'awaitingConfirm' | 'completed') => ({
    mode: 'quick' as const,
    chatId: 'c1',
    workspacePath: '/repo',
    status,
    dimensions: [],
    budget: { maxAgents: 8, spentAgents: 0, spentTokens: 0, truncated: false }
  })

  it('settles an orphaned (non-terminal) audit run to failed with a restart note', () => {
    const run = AppStore.createAuditRun(auditInput('running'))
    const stale = AppStore.reconcileStaleAuditRuns()
    expect(stale).toEqual([{ id: run.id, previousStatus: 'running' }])
    const reread = AppStore.getAuditRun(run.id)
    expect(reread?.status).toBe('failed')
    expect(reread?.error).toContain('restart')
    expect(reread?.endedAt).toBeTruthy()
  })

  it('leaves a terminal run untouched and is idempotent on re-boot', () => {
    const done = AppStore.createAuditRun(auditInput('completed'))
    expect(AppStore.reconcileStaleAuditRuns()).toEqual([])
    expect(AppStore.getAuditRun(done.id)?.status).toBe('completed')
    // A second pass over an already-settled (now-failed) run is a no-op.
    AppStore.createAuditRun(auditInput('running'))
    expect(AppStore.reconcileStaleAuditRuns()).toHaveLength(1)
    expect(AppStore.reconcileStaleAuditRuns()).toHaveLength(0)
  })
})
