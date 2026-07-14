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
type ScheduledTaskInput = Parameters<typeof AppStore.saveScheduledTask>[0]

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

function standaloneScheduledTaskInput(
  overrides: Partial<ScheduledTaskInput> = {}
): ScheduledTaskInput {
  const workspaceId = overrides.workspaceId || 'ws-1'
  const workspacePath = overrides.workspacePath || '/repo'
  const chatId =
    overrides.chatId || AppStore.createChat(workspaceId, workspacePath).appChatId
  return {
    workspaceId,
    workspacePath,
    chatId,
    provider: 'codex',
    prompt: 'Run the standalone task.',
    selectedModelType: 'cli-default',
    customModel: '',
    approvalMode: 'default',
    workflowMode: 'normal',
    sessionTrust: false,
    imageAttachments: [],
    runAt: plannedFor,
    timezone: 'Europe/London',
    ...overrides
  }
}

function claimScheduledTask(
  task: ReturnType<typeof AppStore.saveScheduledTask>,
  runId: string,
  nowMs: number = Date.parse(task.runAt)
) {
  const expectedWorkflowOccurrence =
    task.workflowId && task.workflowExecutionId && task.workflowOccurrenceAt
      ? {
          workflowId: task.workflowId,
          executionId: task.workflowExecutionId,
          plannedFor: task.workflowOccurrenceAt,
          taskId: task.id
        }
      : undefined
  return AppStore.claimDueScheduledTaskForRun(task.id, {
    nowMs,
    runId,
    expectedWorkflowOccurrence
  })
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

  it('drops persisted task lifecycle fields before workflow materialization', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({
        trigger: { kind: 'manual' },
        nextRunAt: undefined,
        template: {
          permissionPresetId: 'read_only',
          workflowMode: 'plan',
          claudeReasoningEffort: 'high'
        }
      })
    )
    const victim = AppStore.saveScheduledTask({
      id: 'victim-task',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId: saved.template.chatId,
      provider: 'codex',
      prompt: 'Existing task must remain unchanged.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      runAt: '2026-06-08T20:00:00.000Z',
      timezone: 'Europe/London'
    })
    const workflowsPath = `${userDataPath}/workflows.json`
    const rows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const row = rows.find((workflow) => workflow.id === saved.id)
    expect(row).toBeTruthy()
    Object.assign(row!.template as unknown as Record<string, unknown>, {
      id: victim.id,
      runAt: '1999-01-01T00:00:00.000Z',
      timezone: 'forged-zone',
      status: 'completed',
      createdAt: '1999-01-01T00:00:00.000Z',
      updatedAt: '1999-01-01T00:00:00.000Z',
      runId: 'victim-run',
      permissionPosture: { signaturePresent: true },
      dispatchReceipt: { runId: 'victim-run' },
      firedAt: '1999-01-01T00:00:00.000Z',
      runningSince: '1999-01-01T00:00:00.000Z',
      completedAt: '1999-01-01T00:00:00.000Z',
      lastError: 'forged failure',
      workflowId: 'forged-workflow',
      workflowExecutionId: 'forged-execution',
      workflowOccurrenceAt: '1999-01-01T00:00:00.000Z',
      futureAuthorityField: 'must not survive'
    })
    fs.writeFileSync(workflowsPath, JSON.stringify(rows))

    const normalized = AppStore.getWorkflowDefinition(saved.id)
    expect(normalized?.template).toMatchObject({
      permissionPresetId: 'read_only',
      workflowMode: 'plan',
      claudeReasoningEffort: 'high'
    })
    for (const field of [
      'id',
      'runAt',
      'timezone',
      'status',
      'createdAt',
      'updatedAt',
      'runId',
      'permissionPosture',
      'dispatchReceipt',
      'firedAt',
      'runningSince',
      'completedAt',
      'lastError',
      'workflowId',
      'workflowExecutionId',
      'workflowOccurrenceAt',
      'futureAuthorityField'
    ]) {
      expect(normalized?.template).not.toHaveProperty(field)
    }

    const task = AppStore.materializeWorkflowNow(saved.id, Date.parse(plannedFor))
    expect(task).toMatchObject({
      runAt: plannedFor,
      timezone: 'Europe/London',
      status: 'due',
      workflowId: saved.id,
      workflowOccurrenceAt: plannedFor,
      permissionPresetId: 'read_only',
      workflowMode: 'plan',
      claudeReasoningEffort: 'high'
    })
    expect(task?.id).not.toBe(victim.id)
    expect(task?.createdAt).not.toBe('1999-01-01T00:00:00.000Z')
    expect(task?.updatedAt).not.toBe('1999-01-01T00:00:00.000Z')
    expect(task?.workflowExecutionId).not.toBe('forged-execution')
    expect(task).not.toHaveProperty('runId')
    expect(task).not.toHaveProperty('permissionPosture')
    expect(task).not.toHaveProperty('firedAt')
    expect(task).not.toHaveProperty('runningSince')
    expect(task).not.toHaveProperty('completedAt')
    expect(task).not.toHaveProperty('lastError')
    expect(task?.dispatchReceipt).toMatchObject({ runId: task?.id })
    expect(AppStore.getScheduledTasks().find((item) => item.id === victim.id)).toEqual(victim)
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

  it('returns due tasks only once their valid run time has arrived', () => {
    const chatId = AppStore.createChat('ws-1', '/repo').appChatId
    const nowMs = Date.parse(plannedFor)
    const overdue = AppStore.saveScheduledTask({
      id: 'overdue-due',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Retry now.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      runAt: new Date(nowMs - 1000).toISOString(),
      timezone: 'Europe/London',
      status: 'due'
    })
    const exact = AppStore.saveScheduledTask({
      id: 'exact-due',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Run exactly now.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      runAt: new Date(nowMs).toISOString(),
      timezone: 'Europe/London',
      status: 'due'
    })
    AppStore.saveScheduledTask({
      id: 'future-due',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Do not run early.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      runAt: new Date(nowMs + 1000).toISOString(),
      timezone: 'Europe/London',
      status: 'due'
    })
    AppStore.saveScheduledTask({
      id: 'invalid-due',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Never dispatch invalid time.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      runAt: 'not-a-date',
      timezone: 'Europe/London',
      status: 'due'
    })
    AppStore.saveScheduledTask({
      id: 'non-string-due',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      chatId,
      provider: 'codex',
      prompt: 'Never coerce a malformed time.',
      selectedModelType: 'cli-default',
      customModel: '',
      approvalMode: 'default',
      sessionTrust: false,
      imageAttachments: [],
      runAt: null as unknown as string,
      timezone: 'Europe/London',
      status: 'due'
    })

    expect(AppStore.getDueScheduledTasks(nowMs).map((task) => task.id)).toEqual([
      overdue.id,
      exact.id
    ])
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
      status: 'due',
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

    const running = claimScheduledTask(
      task,
      'run-after-policy-edit',
      Date.parse('2026-06-07T20:00:01.000Z')
    )

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

  it('can disable an orphaned workflow but cannot re-enable it until its chat is runnable', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const chat = AppStore.getChat(saved.template.chatId)
    expect(chat).toBeTruthy()
    AppStore.saveChat({ ...chat!, archived: true })

    const disabled = AppStore.updateWorkflowDefinition(saved.id, { enabled: false })
    expect(disabled).toMatchObject({ enabled: false, nextRunAt: undefined })
    expect(() => AppStore.updateWorkflowDefinition(saved.id, { enabled: true })).toThrow(
      'Workflow chat is archived.'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)?.enabled).toBe(false)
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

    const running = claimScheduledTask(
      task,
      'run-1',
      Date.parse('2026-06-07T20:00:01.000Z')
    )
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

  it('synchronously claims one arrived standalone task and mints its run identity', () => {
    const task = AppStore.saveScheduledTask(
      standaloneScheduledTaskInput({ status: 'due', runAt: plannedFor })
    )

    const claimed = AppStore.claimDueScheduledTaskForRun(task.id, {
      nowMs: Date.parse(plannedFor)
    })

    expect(claimed).toMatchObject({
      id: task.id,
      status: 'running',
      firedAt: plannedFor,
      runningSince: plannedFor
    })
    expect(claimed?.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(claimed?.dispatchReceipt?.runId).toBe(claimed?.runId)
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(claimed)
  })

  it('rejects pending, future, and invalid-time tasks without mutating them', () => {
    const pending = AppStore.saveScheduledTask(
      standaloneScheduledTaskInput({ status: 'pending', runAt: plannedFor })
    )
    const future = AppStore.saveScheduledTask(
      standaloneScheduledTaskInput({
        status: 'due',
        runAt: '2026-06-07T20:00:01.000Z'
      })
    )
    const invalid = AppStore.saveScheduledTask(
      standaloneScheduledTaskInput({ status: 'due', runAt: null as unknown as string })
    )
    const before = AppStore.getScheduledTasks()

    expect(
      AppStore.claimDueScheduledTaskForRun(pending.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'run-pending'
      })
    ).toBeNull()
    expect(
      AppStore.claimDueScheduledTaskForRun(future.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'run-future'
      })
    ).toBeNull()
    expect(
      AppStore.claimDueScheduledTaskForRun(invalid.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'run-invalid'
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks()).toEqual(before)
  })

  it('allows exactly one due-task claimant and rejects a run identity collision', () => {
    const first = AppStore.saveScheduledTask(
      standaloneScheduledTaskInput({ status: 'due', runAt: plannedFor })
    )
    const second = AppStore.saveScheduledTask(
      standaloneScheduledTaskInput({ status: 'due', runAt: plannedFor })
    )

    const firstClaim = AppStore.claimDueScheduledTaskForRun(first.id, {
      nowMs: Date.parse(plannedFor),
      runId: 'one-owner'
    })
    expect(firstClaim).toMatchObject({ status: 'running', runId: 'one-owner' })
    expect(() =>
      AppStore.saveScheduledTask(
        standaloneScheduledTaskInput({
          id: first.id,
          status: 'due',
          runId: 'replacement-owner'
        })
      )
    ).toThrow('Scheduled task already exists')
    expect(AppStore.getScheduledTasks().find((item) => item.id === first.id)).toEqual(firstClaim)
    expect(
      AppStore.updateScheduledTask(first.id, {
        status: 'running',
        runId: 'stolen-owner'
      })
    ).toMatchObject({ status: 'running', runId: 'one-owner' })
    expect(
      AppStore.claimDueScheduledTaskForRun(first.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'stale-second-owner'
      })
    ).toBeNull()
    const genericBypass = AppStore.updateScheduledTask(second.id, {
      status: 'running',
      runId: 'generic-bypass'
    })
    expect(genericBypass?.status).toBe('due')
    expect(genericBypass?.runId).toBeUndefined()
    expect(
      AppStore.claimDueScheduledTaskForRun(second.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'one-owner'
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === second.id)?.status).toBe('due')
  })

  it('claims a workflow task only for its exact pre-existing queued occurrence', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const expectedWorkflowOccurrence = {
      workflowId: saved.id,
      executionId: task.workflowExecutionId as string,
      plannedFor,
      taskId: task.id
    }

    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'workflow-run',
        expectedWorkflowOccurrence
      })
    ).toMatchObject({ status: 'running', runId: 'workflow-run' })
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      activeExecutionId: task.workflowExecutionId,
      lastStatus: 'running'
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
      id: task.workflowExecutionId,
      status: 'running',
      runId: 'workflow-run'
    })
  })

  it('rejects a missing or mismatched workflow occurrence tuple without mutation', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const beforeTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'missing-tuple'
      })
    ).toBeNull()
    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'mismatched-tuple',
        expectedWorkflowOccurrence: {
          workflowId: saved.id,
          executionId: task.workflowExecutionId as string,
          plannedFor: '2026-06-07T19:59:59.000Z',
          taskId: task.id
        }
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(beforeTask)
    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
  })

  it('rejects a task whose persisted workflow execution linkage does not match', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflow = AppStore.getWorkflowDefinition(saved.id)!
    AppStore.updateWorkflowDefinition(saved.id, {
      history: workflow.history.map((execution) => ({
        ...execution,
        scheduledTaskId: 'different-task'
      }))
    })
    const beforeTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'mismatched-persisted-link',
        expectedWorkflowOccurrence: {
          workflowId: saved.id,
          executionId: task.workflowExecutionId as string,
          plannedFor,
          taskId: task.id
        }
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(beforeTask)
    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
  })

  it('rejects a workflow claim when its history entry is missing and never manufactures it', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.updateWorkflowDefinition(saved.id, { history: [] })
    const beforeTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'forged-history',
        expectedWorkflowOccurrence: {
          workflowId: saved.id,
          executionId: task.workflowExecutionId as string,
          plannedFor,
          taskId: task.id
        }
      })
    ).toBeNull()
    AppStore.syncWorkflowFromScheduledTask({
      ...task,
      status: 'running',
      runId: 'forged-history'
    })

    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(beforeTask)
    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toEqual([])
  })

  it('rejects a terminal execution replay and cannot resurrect it to running', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflow = AppStore.getWorkflowDefinition(saved.id)!
    AppStore.updateWorkflowDefinition(saved.id, {
      activeExecutionId: undefined,
      lastStatus: 'completed',
      history: workflow.history.map((execution) => ({
        ...execution,
        status: 'completed' as const,
        completedAt: '2026-06-07T20:01:00.000Z'
      }))
    })
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'replayed-claim',
        expectedWorkflowOccurrence: {
          workflowId: saved.id,
          executionId: task.workflowExecutionId as string,
          plannedFor,
          taskId: task.id
        }
      })
    ).toBeNull()
    AppStore.syncWorkflowFromScheduledTask({
      ...task,
      status: 'running',
      runId: 'replayed-claim'
    })

    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
      status: 'completed',
      completedAt: '2026-06-07T20:01:00.000Z'
    })
  })

  it('rejects a terminal sync whose run identity does not match the established owner', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const claimed = claimScheduledTask(task, 'established-owner')
    expect(claimed).toBeTruthy()
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    AppStore.syncWorkflowFromScheduledTask({
      ...claimed!,
      status: 'completed',
      runId: 'replacement-owner',
      completedAt: '2026-06-07T20:01:00.000Z'
    })

    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
      status: 'running',
      runId: 'established-owner'
    })

    AppStore.updateScheduledTask(task.id, {
      status: 'completed',
      completedAt: '2026-06-07T20:01:00.000Z'
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
      status: 'completed',
      runId: 'established-owner'
    })
  })

  it('settles an older execution without clobbering a newer active execution projection', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const claimed = AppStore.claimDueScheduledTaskForRun(task.id, {
      nowMs: Date.parse(plannedFor),
      runId: 'older-run',
      expectedWorkflowOccurrence: {
        workflowId: saved.id,
        executionId: task.workflowExecutionId as string,
        plannedFor,
        taskId: task.id
      }
    })
    expect(claimed).toBeTruthy()

    const workflow = AppStore.getWorkflowDefinition(saved.id)!
    AppStore.updateWorkflowDefinition(saved.id, {
      activeExecutionId: 'newer-execution',
      lastStatus: 'running',
      history: [
        ...workflow.history,
        {
          id: 'newer-execution',
          workflowId: saved.id,
          scheduledTaskId: 'newer-task',
          runId: 'newer-run',
          plannedFor: '2026-06-07T20:15:00.000Z',
          status: 'running',
          createdAt: '2026-06-07T20:15:00.000Z',
          updatedAt: '2026-06-07T20:15:01.000Z',
          startedAt: '2026-06-07T20:15:01.000Z'
        }
      ]
    })

    AppStore.updateScheduledTask(task.id, {
      status: 'failed',
      completedAt: '2026-06-07T20:16:00.000Z',
      lastError: 'older execution failed late'
    })

    const after = AppStore.getWorkflowDefinition(saved.id)
    expect(after).toMatchObject({
      activeExecutionId: 'newer-execution',
      lastStatus: 'running',
      failureStreak: 0
    })
    expect(after?.lastError).toBeUndefined()
    expect(after?.history.find((item) => item.id === task.workflowExecutionId)).toMatchObject({
      status: 'failed',
      error: 'older execution failed late'
    })
    expect(after?.history.find((item) => item.id === 'newer-execution')).toMatchObject({
      status: 'running',
      runId: 'newer-run'
    })
  })

  it('does not resurrect completed scheduled tasks from stale status updates', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))

    claimScheduledTask(task, 'run-1', Date.parse('2026-06-07T20:00:01.000Z'))
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

    claimScheduledTask(task, 'run-1', Date.parse('2026-06-07T20:00:01.000Z'))
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
    claimScheduledTask(task, 'run-1', Date.parse('2026-06-07T20:00:01.000Z'))

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

  it('recovers a legacy running workflow occurrence when both records have no run owner', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflow = AppStore.getWorkflowDefinition(saved.id)!
    AppStore.updateWorkflowDefinition(saved.id, {
      lastStatus: 'running',
      history: workflow.history.map((execution) => ({
        ...execution,
        status: 'running' as const,
        startedAt: plannedFor,
        runId: undefined
      }))
    })
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const rows = JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
    const legacyTask = rows.find((item: { id?: string }) => item.id === task.id)
    expect(legacyTask).toBeTruthy()
    Object.assign(legacyTask, {
      status: 'running',
      firedAt: plannedFor,
      runningSince: plannedFor
    })
    delete legacyTask.runId
    fs.writeFileSync(tasksPath, JSON.stringify(rows))

    const recovered = AppStore.recoverInterruptedScheduledTasksAfterStartup(
      Date.parse('2026-06-07T20:02:00.000Z')
    )

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: task.id, status: 'failed' })
    expect(recovered[0].runId).toBeUndefined()
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      activeExecutionId: undefined,
      lastStatus: 'failed',
      failureStreak: 1
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('failed')
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.runId).toBeUndefined()
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
    const running = claimScheduledTask(task, 'run-1')
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
    claimScheduledTask(task, 'run-1', materializeMs)
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
      claimScheduledTask(task, `run-${i}`, occMs)
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
    authorityDigest: 'b'.repeat(64),
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
      { ...wellFormedAck, acknowledgedApprovalMode: 123 as unknown as string },
      { ...wellFormedAck, authorityDigest: '' }
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

  it('revokes the ack for every authority-bearing workflow update class', () => {
    const mutations = [
      (saved: WorkflowDefinition) => ({
        template: { ...saved.template, prompt: 'Retargeted prompt.' }
      }),
      (saved: WorkflowDefinition) => ({
        template: { ...saved.template, selectedModelType: 'gpt-5.6-terra' }
      }),
      (saved: WorkflowDefinition) => ({
        template: { ...saved.template, workflowMode: 'plan' as const }
      }),
      (saved: WorkflowDefinition) => ({
        template: {
          ...saved.template,
          externalPathGrants: [
            {
              id: 'grant-1',
              provider: 'codex' as const,
              path: '/external',
              kind: 'directory' as const,
              access: 'write' as const,
              duration: 'workspace' as const,
              createdAt: plannedFor
            }
          ]
        }
      }),
      (saved: WorkflowDefinition) => ({
        template: { ...saved.template, imageAttachments: [durableAttachment()] }
      }),
      () => ({ trigger: { kind: 'manual' as const } }),
      () => ({ missedRunPolicy: 'skip' as const }),
      (saved: WorkflowDefinition) => ({
        limits: { ...saved.limits, maxRunsPerDay: 2 }
      }),
      () => ({
        loop: {
          acceptance: { maxIterations: 2, verifier: { provider: 'claude' as const } },
          limits: { maxRuns: 4 }
        }
      })
    ]

    for (const mutate of mutations) {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      AppStore.setWorkflowUnattendedElevation(saved.id, wellFormedAck)
      const updated = AppStore.updateWorkflowDefinition(saved.id, mutate(saved))
      expect(updated?.unattendedElevation).toBeUndefined()
      expect(AppStore.getWorkflowDefinition(saved.id)?.unattendedElevation).toBeUndefined()
    }
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

  it('saveWorkflowDefinition permanently revokes an ack across A → B → A authority edits', () => {
    const authorityA = AppStore.saveWorkflowDefinition(
      workflowInput({ template: { prompt: 'Authority A prompt.' } })
    )
    AppStore.setWorkflowUnattendedElevation(authorityA.id, wellFormedAck)

    const authorityB = AppStore.saveWorkflowDefinition({
      ...authorityA,
      template: { ...authorityA.template, prompt: 'Authority B prompt.' }
    })
    expect(authorityB.unattendedElevation).toBeUndefined()
    expect(AppStore.getWorkflowDefinition(authorityA.id)?.unattendedElevation).toBeUndefined()

    const authorityARestored = AppStore.saveWorkflowDefinition({
      ...authorityB,
      template: { ...authorityB.template, prompt: 'Authority A prompt.' }
    })
    expect(authorityARestored.unattendedElevation).toBeUndefined()
    expect(AppStore.getWorkflowDefinition(authorityA.id)?.unattendedElevation).toBeUndefined()
  })

  it('setWorkflowUnattendedElevation(undefined) revokes', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    AppStore.setWorkflowUnattendedElevation(saved.id, wellFormedAck)
    AppStore.setWorkflowUnattendedElevation(saved.id, undefined)
    expect(AppStore.getWorkflowDefinition(saved.id)?.unattendedElevation).toBeUndefined()
  })
})

describe('AppStore workflow run ledger (Stage 1)', () => {
  beforeEach(() => {
    vi.useRealTimers()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('records the running → completed lifecycle in the durable per-execution ledger', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const executionId = task.workflowExecutionId as string

    claimScheduledTask(task, 'run-1', Date.parse(plannedFor))
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

    claimScheduledTask(task, 'run-1')
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
    claimScheduledTask(task, 'run-1', Date.parse(plannedFor))

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
