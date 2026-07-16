import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import type { WorkflowRunEvent } from './WorkflowRunStore'
import type {
  PersistedAttachmentRef,
  ScheduledTask,
  ScheduledTaskAttachmentRef,
  WorkflowDefinition,
  WorkflowRunTemplate
} from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-workflows-test-${process.pid}`)
const fsMockState = vi.hoisted(() => ({
  directoryFsyncCount: 0,
  failDirectoryFsyncAt: null as number | null
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const fsyncSync = vi.fn((fd: number) => {
    if (actual.fstatSync(fd).isDirectory()) {
      fsMockState.directoryFsyncCount += 1
      if (fsMockState.directoryFsyncCount === fsMockState.failDirectoryFsyncAt) {
        throw new Error('Injected directory fsync failure.')
      }
    }
    actual.fsyncSync(fd)
  })
  return {
    ...actual,
    fsyncSync,
    default: { ...actual, fsyncSync }
  }
})

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

function saveStandaloneScheduledTaskForTest(input: ScheduledTaskInput): ScheduledTask {
  const { status, ...createInput } = input
  const saved = AppStore.saveScheduledTask(createInput)
  if (!status || status === 'pending') return saved
  const updated = AppStore.updateScheduledTask(saved.id, { status })
  if (!updated) throw new Error(`Could not transition scheduled task ${saved.id} for test setup.`)
  return updated
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

function expectedWorkflowOccurrence(task: ReturnType<typeof AppStore.saveScheduledTask>) {
  return {
    workflowId: task.workflowId as string,
    executionId: task.workflowExecutionId as string,
    plannedFor: task.workflowOccurrenceAt as string,
    taskId: task.id
  }
}

function settleClaimedScheduledTask(
  task: ReturnType<typeof AppStore.saveScheduledTask>,
  runId: string,
  options: Omit<
    Parameters<typeof AppStore.settleScheduledTaskForRun>[1],
    'runId' | 'expectedWorkflowOccurrence'
  >
) {
  return AppStore.settleScheduledTaskForRun(task.id, {
    runId,
    ...options,
    expectedWorkflowOccurrence:
      task.workflowId && task.workflowExecutionId && task.workflowOccurrenceAt
        ? expectedWorkflowOccurrence(task)
        : undefined
  })
}

function materializeCompletedWorkflowOccurrences(
  workflowId: string,
  count: number = 51
): ScheduledTask[] {
  if (count <= 50) throw new Error('Pruned-history fixture requires more than 50 occurrences.')
  vi.useFakeTimers()
  const baseMs = Date.parse(plannedFor)
  vi.setSystemTime(baseMs)
  const firstTask = AppStore.materializeWorkflowNow(workflowId, baseMs)
  if (!firstTask) throw new Error('Could not materialize the ledger-backed fixture occurrence.')
  const firstRunId = 'history-owner-1'
  if (!claimScheduledTask(firstTask, firstRunId, baseMs)) {
    throw new Error('Could not claim the ledger-backed fixture occurrence.')
  }
  vi.setSystemTime(baseMs + 1_000)
  const firstCompleted = AppStore.settleScheduledTaskForRun(firstTask.id, {
    runId: firstRunId,
    status: 'completed',
    completedAt: new Date(baseMs + 1_000).toISOString(),
    expectedWorkflowOccurrence: expectedWorkflowOccurrence(firstTask)
  })
  if (!firstCompleted) throw new Error('Could not settle the ledger-backed fixture occurrence.')

  // Keep one occurrence fully production-materialized so the pruned row has an
  // exact durable WAL ledger. Synthesize the later terminal projections to make
  // the >50 regression cheap: exercising 102 real fsync transitions here adds
  // roughly 10 seconds to every test without changing the deletion condition.
  const workflow = AppStore.getWorkflowDefinition(workflowId)
  if (!workflow) throw new Error('Could not load the workflow fixture.')
  const completedTasks: ScheduledTask[] = [firstCompleted]
  const retainedHistory: WorkflowDefinition['history'] = []
  for (let index = 1; index < count; index += 1) {
    const createdAt = new Date(baseMs + index * 60_000).toISOString()
    const completedAt = new Date(baseMs + index * 60_000 + 1_000).toISOString()
    const taskId = `history-task-${index + 1}`
    const executionId = `history-execution-${index + 1}`
    const runId = `history-owner-${index + 1}`
    const task: ScheduledTask = {
      ...firstCompleted,
      id: taskId,
      runAt: createdAt,
      status: 'completed',
      createdAt,
      updatedAt: completedAt,
      runId,
      firedAt: createdAt,
      runningSince: createdAt,
      completedAt,
      workflowExecutionId: executionId,
      workflowOccurrenceAt: createdAt,
      dispatchReceipt: undefined,
      occurrenceSeal: undefined,
      lastError: undefined
    }
    completedTasks.push(task)
    retainedHistory.push({
      id: executionId,
      workflowId,
      scheduledTaskId: taskId,
      runId,
      plannedFor: createdAt,
      status: 'completed',
      createdAt,
      updatedAt: completedAt,
      startedAt: createdAt,
      completedAt
    })
  }
  workflow.history = retainedHistory.slice(-50)
  workflow.activeExecutionId = undefined
  workflow.lastStatus = 'completed'
  workflow.lastError = undefined
  workflow.lastCompletedAt = retainedHistory.at(-1)?.completedAt
  workflow.updatedAt = retainedHistory.at(-1)?.updatedAt || workflow.updatedAt
  const unrelatedTasks = AppStore.getScheduledTasks().filter(
    (task) => task.workflowId !== workflowId
  )
  fs.writeFileSync(
    `${userDataPath}/scheduled-tasks.json`,
    JSON.stringify([...unrelatedTasks, ...completedTasks])
  )
  const workflows = AppStore.getWorkflowDefinitions().map((candidate) =>
    candidate.id === workflowId ? workflow : candidate
  )
  fs.writeFileSync(`${userDataPath}/workflows.json`, JSON.stringify(workflows))
  return completedTasks
}

function mutatePersistedWorkflow(
  id: string,
  mutate: (workflow: WorkflowDefinition) => void
): void {
  const workflowsPath = `${userDataPath}/workflows.json`
  const rows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
  const workflow = rows.find((item) => item.id === id)
  if (!workflow) throw new Error(`Missing workflow ${id}`)
  mutate(workflow)
  fs.writeFileSync(workflowsPath, JSON.stringify(rows))
}

beforeEach(() => {
  vi.useRealTimers()
  AppStore.setScheduledOccurrenceMutationCrashPointForTests(null)
  fsMockState.directoryFsyncCount = 0
  fsMockState.failDirectoryFsyncAt = null
  fs.rmSync(userDataPath, { recursive: true, force: true })
  fs.mkdirSync(userDataPath, { recursive: true })
})

describe('AppStore workflows', () => {
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

  it('canonicalizes an omitted workflow mode before persistence and materialization', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())

    expect(saved.template.workflowMode).toBe('normal')
    const rows = JSON.parse(
      fs.readFileSync(`${userDataPath}/workflows.json`, 'utf8')
    ) as WorkflowDefinition[]
    expect(rows.find((workflow) => workflow.id === saved.id)?.template.workflowMode).toBe('normal')

    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(task.workflowMode).toBe('normal')
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
    // A manual trigger has no timezone, so materialization falls back to the
    // host zone — resolve it dynamically so the assertion holds on UTC CI
    // runners as well as local machines.
    const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(task).toMatchObject({
      runAt: plannedFor,
      timezone: hostTimezone,
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
    const task = saveStandaloneScheduledTaskForTest({
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
    const task = saveStandaloneScheduledTaskForTest({
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
    const overdue = saveStandaloneScheduledTaskForTest({
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
    const exact = saveStandaloneScheduledTaskForTest({
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
    saveStandaloneScheduledTaskForTest({
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
    saveStandaloneScheduledTaskForTest({
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
    saveStandaloneScheduledTaskForTest({
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
    const task = saveStandaloneScheduledTaskForTest({
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

  it.each([
    {
      name: 'workflow linkage',
      patch: {
        workflowId: 'forged-workflow',
        workflowExecutionId: 'forged-execution',
        workflowOccurrenceAt: plannedFor
      }
    },
    { name: 'a run owner', patch: { runId: 'pre-owned-run' } },
    { name: 'a fired lifecycle', patch: { firedAt: plannedFor } },
    { name: 'a caller timestamp', patch: { createdAt: plannedFor } },
    {
      name: 'a dispatch receipt',
      patch: { dispatchReceipt: {} as ScheduledTask['dispatchReceipt'] }
    },
    {
      name: 'an occurrence seal',
      patch: { occurrenceSeal: {} as ScheduledTask['occurrenceSeal'] }
    },
    { name: 'a due lifecycle status', patch: { status: 'due' as const } },
    { name: 'a running status', patch: { status: 'running' as const } }
  ])('rejects generic scheduled-task creation with $name', ({ patch }) => {
    expect(() =>
      AppStore.saveScheduledTask({
        ...standaloneScheduledTaskInput(),
        ...patch
      })
    ).toThrow('cannot pre-own workflow linkage, run identity, lifecycle state')
    expect(AppStore.getScheduledTasks()).toEqual([])
  })

  it('keeps scheduled authority immutable while the signed posture remains authoritative', () => {
    const chatId = AppStore.createChat('ws-1', '/repo').appChatId
    const task = saveStandaloneScheduledTaskForTest({
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
    expect(edited?.approvalMode).toBe('default')
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

    settleClaimedScheduledTask(task, 'run-1', {
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
    const task = saveStandaloneScheduledTaskForTest(
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
    const pending = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'pending', runAt: plannedFor })
    )
    const future = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({
        status: 'due',
        runAt: '2026-06-07T20:00:01.000Z'
      })
    )
    const invalid = saveStandaloneScheduledTaskForTest(
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
    const first = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'due', runAt: plannedFor })
    )
    const second = saveStandaloneScheduledTaskForTest(
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

  it('does not let a losing claimant or stale renderer terminalize an owned run by task id', () => {
    const standalone = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'due', runAt: plannedFor })
    )
    const standaloneRunning = AppStore.claimDueScheduledTaskForRun(standalone.id, {
      nowMs: Date.parse(plannedFor),
      runId: 'standalone-winner'
    })!
    expect(
      AppStore.claimDueScheduledTaskForRun(standalone.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'standalone-loser'
      })
    ).toBeNull()
    expect(
      AppStore.updateScheduledTask(standalone.id, {
        status: 'failed',
        runId: 'standalone-winner',
        completedAt: '2026-06-07T20:01:00.000Z'
      })
    ).toEqual(standaloneRunning)

    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [workflowTask] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflowRunning = claimScheduledTask(workflowTask, 'workflow-winner')!
    expect(
      AppStore.updateScheduledTask(workflowTask.id, {
        status: 'completed',
        runId: 'workflow-winner',
        completedAt: '2026-06-07T20:01:00.000Z'
      })
    ).toEqual(workflowRunning)
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      activeExecutionId: workflowTask.workflowExecutionId,
      lastStatus: 'running'
    })
    expect(
      AppStore.getWorkflowRunEvents(workflowTask.workflowExecutionId as string).map(
        (event) => event.kind
      )
    ).toEqual(['running'])
  })

  it('allows an ID-only queued failure only when no run owner exists', () => {
    const task = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'due' })
    )
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.find((candidate) => candidate.id === task.id)!.runId = 'forged-queued-owner'
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))
    const before = AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)

    expect(
      AppStore.updateScheduledTask(task.id, {
        status: 'failed',
        completedAt: '2026-06-07T20:01:00.000Z'
      })
    ).toEqual(before)
    expect(AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)).toEqual(
      before
    )
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
    mutatePersistedWorkflow(saved.id, (workflow) => {
      workflow.history = workflow.history.map((execution) => ({
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
    mutatePersistedWorkflow(saved.id, (workflow) => {
      workflow.history = []
    })
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
    mutatePersistedWorkflow(saved.id, (workflow) => {
      workflow.activeExecutionId = undefined
      workflow.lastStatus = 'completed'
      workflow.history = workflow.history.map((execution) => ({
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

    settleClaimedScheduledTask(task, 'established-owner', {
      status: 'completed',
      completedAt: '2026-06-07T20:01:00.000Z'
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
      status: 'completed',
      runId: 'established-owner'
    })
  })

  it('rejects a forged terminal sync even when it reuses the established owner', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const claimed = claimScheduledTask(task, 'forged-terminal-owner')!
    const beforeTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.syncWorkflowFromScheduledTask({
        ...claimed,
        status: 'failed',
        completedAt: '2026-06-07T20:01:00.000Z',
        lastError: 'forged terminal'
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(beforeTask)
    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
    expect(
      AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).map((event) => event.kind)
    ).toEqual(['running'])
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

    mutatePersistedWorkflow(saved.id, (workflow) => {
      workflow.activeExecutionId = 'newer-execution'
      workflow.lastStatus = 'running'
      workflow.history = [
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

    settleClaimedScheduledTask(task, 'older-run', {
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
    settleClaimedScheduledTask(task, 'run-1', {
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
    settleClaimedScheduledTask(task, 'run-1', {
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
    mutatePersistedWorkflow(saved.id, (workflow) => {
      workflow.lastStatus = 'running'
      workflow.history = workflow.history.map((execution) => ({
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

  it('recovers an isolated legacy ownerless running standalone task only at startup', () => {
    const task = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'due' })
    )
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const rows = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    const legacyTask = rows.find((candidate) => candidate.id === task.id)!
    legacyTask.status = 'running'
    legacyTask.firedAt = plannedFor
    legacyTask.runningSince = plannedFor
    delete legacyTask.runId
    fs.writeFileSync(tasksPath, JSON.stringify(rows))

    const staleIdOnly = AppStore.updateScheduledTask(task.id, {
      status: 'failed',
      completedAt: '2026-06-07T20:02:00.000Z'
    })
    expect(staleIdOnly?.status).toBe('running')

    const recovered = AppStore.recoverInterruptedScheduledTasksAfterStartup(
      Date.parse('2026-06-07T20:02:00.000Z')
    )
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({
      id: task.id,
      status: 'failed',
      completedAt: '2026-06-07T20:02:00.000Z'
    })
    expect(recovered[0].runId).toBeUndefined()
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

  it('accepts only a forward heartbeat from the uniquely owned running occurrence', () => {
    AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const running = claimScheduledTask(task, 'heartbeat-owner')!
    const nextHeartbeat = new Date(Date.parse(running.runningSince as string) + 1_000).toISOString()

    const genericPatch = AppStore.updateScheduledTask(task.id, { runningSince: nextHeartbeat })
    expect(genericPatch?.runningSince).toBe(running.runningSince)
    const refreshed = AppStore.heartbeatScheduledTaskForRun(task.id, {
      runId: 'heartbeat-owner',
      at: nextHeartbeat,
      expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
    })
    expect(refreshed?.runningSince).toBe(nextHeartbeat)

    const backwards = AppStore.heartbeatScheduledTaskForRun(task.id, {
      runId: 'heartbeat-owner',
      at: running.runningSince,
      expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
    })
    expect(backwards).toBeNull()

    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.push({ ...refreshed!, id: 'duplicate-heartbeat-owner' })
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))
    const blocked = AppStore.heartbeatScheduledTaskForRun(task.id, {
      runId: 'heartbeat-owner',
      at: new Date(Date.parse(nextHeartbeat) + 1_000).toISOString(),
      expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
    })
    expect(blocked).toBeNull()
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

  it('isolates a poisoned stalled occurrence and continues settling healthy candidates', () => {
    const poisonedWorkflow = AppStore.saveWorkflowDefinition(
      workflowInput({ name: 'Poisoned stalled workflow' })
    )
    const healthyWorkflow = AppStore.saveWorkflowDefinition(
      workflowInput({ name: 'Healthy stalled workflow' })
    )
    const materializeMs = Date.parse(plannedFor)
    const tasks = AppStore.materializeDueWorkflows(materializeMs)
    const poisonedTask = tasks.find((task) => task.workflowId === poisonedWorkflow.id)!
    const healthyTask = tasks.find((task) => task.workflowId === healthyWorkflow.id)!
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const persistedTasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    const persistedPoison = persistedTasks.find((task) => task.id === poisonedTask.id)!
    const persistedHealthy = persistedTasks.find((task) => task.id === healthyTask.id)!
    persistedPoison.runAt = '2026-06-07T19:59:00Z'
    fs.writeFileSync(tasksPath, JSON.stringify([persistedPoison, persistedHealthy]))
    expect(AppStore.getScheduledTasks().map((task) => task.id)).toEqual([
      poisonedTask.id,
      healthyTask.id
    ])

    const settled = AppStore.settleStalledScheduledTasks(
      () => false,
      materializeMs + 7 * 60 * 60 * 1000,
      6 * 60 * 60 * 1000
    )

    expect(settled.map((task) => task.id)).toEqual([healthyTask.id])
    expect(AppStore.getScheduledTasks().find((task) => task.id === poisonedTask.id)).toMatchObject({
      status: 'due',
      runAt: '2026-06-07T19:59:00Z'
    })
    expect(AppStore.getWorkflowDefinition(poisonedWorkflow.id)).toMatchObject({
      activeExecutionId: poisonedTask.workflowExecutionId,
      lastStatus: 'queued'
    })
    expect(AppStore.getScheduledTasks().find((task) => task.id === healthyTask.id)).toMatchObject({
      status: 'failed'
    })
    expect(AppStore.getWorkflowDefinition(healthyWorkflow.id)).toMatchObject({
      activeExecutionId: undefined,
      lastStatus: 'failed'
    })
  })

  it('isolates a throwing running-task liveness probe and settles a later due candidate', () => {
    const runningWorkflow = AppStore.saveWorkflowDefinition(
      workflowInput({ name: 'Throwing liveness workflow' })
    )
    const healthyWorkflow = AppStore.saveWorkflowDefinition(
      workflowInput({ name: 'Healthy due workflow' })
    )
    const materializeMs = Date.parse(plannedFor)
    const tasks = AppStore.materializeDueWorkflows(materializeMs)
    const runningTask = tasks.find((task) => task.workflowId === runningWorkflow.id)!
    const healthyTask = tasks.find((task) => task.workflowId === healthyWorkflow.id)!
    expect(claimScheduledTask(runningTask, 'throwing-liveness-run', materializeMs)).toBeTruthy()
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const persistedTasks = AppStore.getScheduledTasks()
    const persistedRunning = persistedTasks.find((task) => task.id === runningTask.id)!
    const persistedHealthy = persistedTasks.find((task) => task.id === healthyTask.id)!
    fs.writeFileSync(tasksPath, JSON.stringify([persistedRunning, persistedHealthy]))
    expect(AppStore.getScheduledTasks().map((task) => task.id)).toEqual([
      runningTask.id,
      healthyTask.id
    ])
    const isRunLive = vi.fn((runId: string) => {
      if (runId === 'throwing-liveness-run') throw new Error('Liveness probe failed.')
      return false
    })

    const settled = AppStore.settleStalledScheduledTasks(
      isRunLive,
      materializeMs + 7 * 60 * 60 * 1000
    )

    expect(isRunLive).toHaveBeenCalledTimes(1)
    expect(isRunLive).toHaveBeenCalledWith('throwing-liveness-run')
    expect(settled.map((task) => task.id)).toEqual([healthyTask.id])
    expect(AppStore.getScheduledTasks().find((task) => task.id === runningTask.id)).toMatchObject({
      status: 'running',
      runId: 'throwing-liveness-run'
    })
    expect(AppStore.getWorkflowDefinition(runningWorkflow.id)).toMatchObject({
      activeExecutionId: runningTask.workflowExecutionId,
      lastStatus: 'running'
    })
    expect(AppStore.getScheduledTasks().find((task) => task.id === healthyTask.id)).toMatchObject({
      status: 'failed'
    })
    expect(AppStore.getWorkflowDefinition(healthyWorkflow.id)).toMatchObject({
      activeExecutionId: undefined,
      lastStatus: 'failed'
    })
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

  it('rechecks run liveness immediately before an exact stall settlement', () => {
    AppStore.saveWorkflowDefinition(workflowInput())
    const materializeMs = Date.parse(plannedFor)
    const [task] = AppStore.materializeDueWorkflows(materializeMs)
    expect(claimScheduledTask(task, 'revived-owner', materializeMs)).toBeTruthy()
    let checks = 0
    const settled = AppStore.settleStalledScheduledTasks(() => {
      checks += 1
      return checks >= 3
    }, materializeMs + 7 * 60 * 60 * 1000)

    expect(checks).toBe(3)
    expect(settled).toEqual([])
    expect(AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)).toMatchObject({
      status: 'running',
      runId: 'revived-owner'
    })
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

  it.each(['after-intent', 'after-task', 'after-workflow', 'after-ledger'] as const)(
    'replays a materialization crash at %s to one paired queued occurrence',
    (crashPoint) => {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      AppStore.setScheduledOccurrenceMutationCrashPointForTests(crashPoint)

      expect(() => AppStore.materializeDueWorkflows(Date.parse(plannedFor))).toThrow(
        `Injected scheduled occurrence mutation crash ${crashPoint}.`
      )

      const tasksBeforeReplay = AppStore.getScheduledTasks()
      const workflowBeforeReplay = AppStore.getWorkflowDefinition(saved.id)
      expect(tasksBeforeReplay).toHaveLength(crashPoint === 'after-intent' ? 0 : 1)
      expect(workflowBeforeReplay?.history).toHaveLength(
        crashPoint === 'after-workflow' || crashPoint === 'after-ledger' ? 1 : 0
      )

      const replay = AppStore.replayScheduledOccurrenceMutations()
      if (replay.status === 'blocked') throw new Error(replay.reason)
      expect(replay).toMatchObject({ status: 'replayed', kind: 'materialize' })
      if (replay.status !== 'replayed') throw new Error('Expected materialization replay.')
      const task = AppStore.getScheduledTasks().find((item) => item.id === replay.taskId)
      const workflow = AppStore.getWorkflowDefinition(saved.id)
      expect(task).toMatchObject({
        status: 'due',
        workflowId: saved.id,
        workflowOccurrenceAt: plannedFor
      })
      expect(workflow).toMatchObject({
        activeExecutionId: task?.workflowExecutionId,
        lastStatus: 'queued'
      })
      expect(workflow?.history).toHaveLength(1)
      expect(workflow?.history[0]).toMatchObject({
        id: task?.workflowExecutionId,
        scheduledTaskId: task?.id,
        plannedFor,
        status: 'queued'
      })
      expect(AppStore.replayScheduledOccurrenceMutations()).toEqual({ status: 'none' })
    }
  )

  it('blocks materialization when another raw workflow hides its execution owner', () => {
    const target = AppStore.saveWorkflowDefinition(workflowInput())
    const other = AppStore.saveWorkflowDefinition(
      workflowInput({
        name: 'Hidden owner workflow',
        trigger: { kind: 'manual' },
        nextRunAt: undefined
      })
    )
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => AppStore.materializeDueWorkflows(Date.parse(plannedFor))).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journal = JSON.parse(
      fs.readFileSync(`${userDataPath}/scheduled-occurrence-mutation.json`, 'utf8')
    ) as {
      identity: { taskId: string; workflowId: string; executionId: string; plannedFor: string }
    }
    expect(journal.identity.workflowId).toBe(target.id)
    const workflowsPath = `${userDataPath}/workflows.json`
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const otherWorkflow = workflows.find((workflow) => workflow.id === other.id)!
    otherWorkflow.history = [
      {
        id: journal.identity.executionId,
        workflowId: target.id,
        scheduledTaskId: journal.identity.taskId,
        plannedFor: journal.identity.plannedFor,
        status: 'queued',
        createdAt: plannedFor,
        updatedAt: plannedFor
      },
      ...Array.from({ length: 50 }, (_, index) => {
        const timestamp = new Date(Date.parse(plannedFor) + index + 1).toISOString()
        return {
          id: `hidden-materialize-owner-${index}`,
          workflowId: other.id,
          plannedFor: timestamp,
          status: 'skipped' as const,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp
        }
      })
    ]
    fs.writeFileSync(workflowsPath, JSON.stringify(workflows))

    expect(AppStore.getWorkflowDefinition(other.id)?.history).toHaveLength(50)
    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks()).toEqual([])
    expect(AppStore.getWorkflowDefinition(target.id)?.history).toEqual([])
  })

  it.each([
    {
      name: 'a receipt whose signed body no longer matches its hash',
      mutate: (journal: {
        taskAfter: ScheduledTask
        workflowAfter: WorkflowDefinition
      }) => {
        if (!journal.taskAfter.dispatchReceipt) throw new Error('Missing dispatch receipt.')
        journal.taskAfter.dispatchReceipt.approvalMode = 'auto_edit'
      }
    },
    {
      name: 'a pre-issued occurrence seal',
      mutate: (journal: {
        taskAfter: ScheduledTask
        workflowAfter: WorkflowDefinition
      }) => {
        Object.assign(journal.taskAfter, {
          occurrenceSeal: {
            schemaVersion: 1,
            signature: 'forged-before-claim'
          }
        })
      }
    },
    {
      name: 'a legacy unresolved attachment',
      mutate: (journal: {
        taskAfter: ScheduledTask
        workflowAfter: WorkflowDefinition
      }) => {
        journal.taskAfter.imageAttachments = [
          {
            id: 'legacy-attachment',
            path: '/tmp/legacy-attachment.png',
            name: 'legacy-attachment.png'
          }
        ] as unknown as ScheduledTask['imageAttachments']
      }
    },
    {
      name: 'a queued execution that already has a started timestamp',
      mutate: (journal: {
        taskAfter: ScheduledTask
        workflowAfter: WorkflowDefinition
      }) => {
        const execution = journal.workflowAfter.history.find(
          (item) => item.id === journal.taskAfter.workflowExecutionId
        )
        if (!execution) throw new Error('Missing materialized execution.')
        execution.startedAt = execution.createdAt
      }
    }
  ])('blocks materialization replay with $name', ({ mutate }) => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => AppStore.materializeDueWorkflows(Date.parse(plannedFor))).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      taskAfter: ScheduledTask
      workflowAfter: WorkflowDefinition
    }
    mutate(journal)
    fs.writeFileSync(journalPath, JSON.stringify(journal))

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks()).toHaveLength(0)
    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toEqual([])
    expect(fs.existsSync(journalPath)).toBe(true)
  })

  it.each([
    ['a non-canonical equivalent', '2026-06-07T20:00:00Z'],
    ['a planned time after materialization', '2026-06-07T20:00:01.000Z']
  ])('blocks materialization replay with %s occurrence time', (_name, forgedPlannedFor) => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => AppStore.materializeDueWorkflows(Date.parse(plannedFor))).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      identity: { plannedFor: string }
      taskAfter: ScheduledTask
      workflowAfter: WorkflowDefinition
    }
    journal.identity.plannedFor = forgedPlannedFor
    journal.taskAfter.workflowOccurrenceAt = forgedPlannedFor
    const execution = journal.workflowAfter.history.find(
      (item) => item.id === journal.taskAfter.workflowExecutionId
    )!
    execution.plannedFor = forgedPlannedFor
    fs.writeFileSync(journalPath, JSON.stringify(journal))

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks()).toEqual([])
    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toEqual([])
  })

  // The directory-fsync barrier is POSIX-only (Windows FlushFileBuffers
  // rejects directory handles), so its instrumentation never fires there.
  it.skipIf(process.platform === 'win32')(
    'fsyncs both directory entries when creating the first workflow ledger',
    () => {
    const workflowRunsPath = `${userDataPath}/workflow-runs`
    fs.rmSync(workflowRunsPath, { recursive: true, force: true })
    fsMockState.directoryFsyncCount = 0
    AppStore.appendWorkflowRunEvent({
      workflowExecutionId: 'first-ledger-execution',
      workflowId: 'first-ledger-workflow',
      kind: 'materialized',
      timestamp: plannedFor
    })

    expect(fsMockState.directoryFsyncCount).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(`${workflowRunsPath}/first-ledger-execution.jsonl`)).toBe(true)
  })

  it.each([
    'noncontiguous sequence',
    'duplicate sequence',
    'out-of-order timestamp',
    'cross-execution row',
    'cross-workflow row',
    'unknown event kind'
  ])('fails closed before claim on a structurally corrupt ledger: %s', (corruption) => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journalBeforeClaim = fs.readFileSync(journalPath)
    fs.mkdirSync(`${userDataPath}/workflow-runs`, { recursive: true })
    const base: WorkflowRunEvent = {
      schemaVersion: 1,
      sequence: 1,
      workflowExecutionId: task.workflowExecutionId as string,
      workflowId: saved.id,
      scheduledTaskId: task.id,
      plannedFor: task.workflowOccurrenceAt,
      kind: 'materialized',
      timestamp: plannedFor
    }
    let events: WorkflowRunEvent[] = [base]
    if (corruption === 'noncontiguous sequence') events[0] = { ...base, sequence: 2 }
    if (corruption === 'duplicate sequence') {
      events.push({
        ...base,
        sequence: 1,
        kind: 'harvested',
        timestamp: '2026-06-07T20:00:00.001Z'
      })
    }
    if (corruption === 'out-of-order timestamp') {
      events = [
        { ...base, timestamp: '2026-06-07T20:00:00.002Z' },
        {
          ...base,
          sequence: 2,
          kind: 'harvested',
          timestamp: '2026-06-07T20:00:00.001Z'
        }
      ]
    }
    if (corruption === 'cross-execution row') {
      events[0] = { ...base, workflowExecutionId: 'other-execution' }
    }
    if (corruption === 'cross-workflow row') {
      events[0] = { ...base, workflowId: 'other-workflow' }
    }
    if (corruption === 'unknown event kind') {
      events[0] = { ...base, kind: 'unknown-kind' as WorkflowRunEvent['kind'] }
    }
    fs.writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)

    expect(() => claimScheduledTask(task, 'corrupt-ledger-owner')).toThrow()
    expect(AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)?.status).toBe(
      'due'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('queued')
    expect(fs.readFileSync(journalPath)).toEqual(journalBeforeClaim)
  })

  it('fails closed before settlement when an established ledger becomes noncontiguous', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const running = claimScheduledTask(task, 'corrupt-settle-owner')!
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    const event = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim()) as WorkflowRunEvent
    event.sequence = 2
    fs.writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`)

    expect(() =>
      AppStore.settleScheduledTaskForRun(task.id, {
        runId: running.runId as string,
        status: 'completed',
        expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
      })
    ).toThrow('structurally invalid event sequence')
    expect(AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)?.status).toBe(
      'running'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('running')
  })

  // POSIX-only: the injected directory-fsync failure cannot fire on Windows,
  // where the barrier is skipped by design (FlushFileBuffers rejects
  // directory handles).
  it.skipIf(process.platform === 'win32').each([
    [1, 'journal intent'],
    [2, 'task post-image'],
    [3, 'workflow post-image'],
    [4, 'journal clear']
  ])('fails closed and replays when %s directory fsync fails at %s', (failureAt) => {
    AppStore.saveWorkflowDefinition(workflowInput())
    fsMockState.directoryFsyncCount = 0
    fsMockState.failDirectoryFsyncAt = failureAt

    expect(() => AppStore.materializeDueWorkflows(Date.parse(plannedFor))).toThrow(
      'Injected directory fsync failure.'
    )
    fsMockState.failDirectoryFsyncAt = null

    expect(() => AppStore.getDueScheduledTasks(Date.parse(plannedFor))).toThrow(
      'Scheduled occurrence mutation recovery is pending.'
    )
    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
      status: 'replayed',
      kind: 'materialize'
    })
    expect(AppStore.getScheduledTasks()).toHaveLength(1)
    expect(AppStore.getWorkflowDefinitions()[0]?.history).toHaveLength(1)
    expect(AppStore.replayScheduledOccurrenceMutations()).toEqual({ status: 'none' })
  })

  it.each(['after-intent', 'after-task', 'after-workflow', 'after-ledger'] as const)(
    'replays an exact claim crash at %s without creating a second owner',
    (crashPoint) => {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
      const expected = expectedWorkflowOccurrence(task)
      AppStore.setScheduledOccurrenceMutationCrashPointForTests(crashPoint)

      expect(() =>
        AppStore.claimDueScheduledTaskForRun(task.id, {
          nowMs: Date.parse(plannedFor),
          runId: 'wal-claim-owner',
          expectedWorkflowOccurrence: expected
        })
      ).toThrow(`Injected scheduled occurrence mutation crash ${crashPoint}.`)

      const taskBeforeReplay = AppStore.getScheduledTasks().find((item) => item.id === task.id)
      const workflowBeforeReplay = AppStore.getWorkflowDefinition(saved.id)
      expect(taskBeforeReplay?.status).toBe(crashPoint === 'after-intent' ? 'due' : 'running')
      expect(workflowBeforeReplay?.history[0]?.status).toBe(
        crashPoint === 'after-workflow' || crashPoint === 'after-ledger' ? 'running' : 'queued'
      )
      expect(
        AppStore.claimDueScheduledTaskForRun(task.id, {
          nowMs: Date.parse(plannedFor),
          runId: 'second-owner',
          expectedWorkflowOccurrence: expected
        })
      ).toBeNull()

      expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
        status: 'replayed',
        kind: 'claim',
        taskId: task.id
      })
      expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toMatchObject({
        status: 'running',
        runId: 'wal-claim-owner'
      })
      expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
        status: 'running',
        runId: 'wal-claim-owner'
      })
      expect(
        AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).map((event) => event.kind)
      ).toEqual(['running'])
    }
  )

  it('blocks replay when a raw 51st-prefix execution appears after WAL intent', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    mutatePersistedWorkflow(saved.id, (workflow) => {
      workflow.history = Array.from({ length: 49 }, (_, index) => {
        const timestamp = new Date(Date.parse(plannedFor) - (49 - index) * 1_000).toISOString()
        return {
          id: `prefix-history-${index}`,
          workflowId: saved.id,
          plannedFor: timestamp,
          status: 'skipped' as const,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp
        }
      })
    })
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toHaveLength(50)
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => claimScheduledTask(task, 'hidden-prefix-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )

    const workflowsPath = `${userDataPath}/workflows.json`
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const workflow = workflows.find((candidate) => candidate.id === saved.id)!
    const execution = workflow.history.find(
      (candidate) => candidate.id === task.workflowExecutionId
    )!
    workflow.history.unshift({ ...execution })
    fs.writeFileSync(workflowsPath, JSON.stringify(workflows))

    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toHaveLength(50)
    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)?.status).toBe(
      'due'
    )
    expect(
      (JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]).find(
        (candidate) => candidate.id === saved.id
      )?.history
    ).toHaveLength(51)
  })

  it.each(['extra field', 'defaultable omission'] as const)(
    'blocks replay when the raw workflow target gains a non-history %s after WAL intent',
    (mutation) => {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
      AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
      expect(() => claimScheduledTask(task, 'raw-workflow-owner')).toThrow(
        'Injected scheduled occurrence mutation crash after-intent.'
      )

      const workflowsPath = `${userDataPath}/workflows.json`
      const rows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
      const row = rows.find((candidate) => candidate.id === saved.id)!
      if (mutation === 'extra field') {
        ;(row as unknown as Record<string, unknown>).futureAuthorityField = 'must remain visible'
      } else {
        delete (row.template as Partial<WorkflowRunTemplate>).workflowMode
      }
      fs.writeFileSync(workflowsPath, JSON.stringify(rows))
      const workflowsBeforeReplay = fs.readFileSync(workflowsPath)
      const tasksPath = `${userDataPath}/scheduled-tasks.json`
      const tasksBeforeReplay = fs.readFileSync(tasksPath)
      const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
      const journalBeforeReplay = fs.readFileSync(journalPath)

      expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
      expect(fs.readFileSync(workflowsPath)).toEqual(workflowsBeforeReplay)
      expect(fs.readFileSync(tasksPath)).toEqual(tasksBeforeReplay)
      expect(fs.readFileSync(journalPath)).toEqual(journalBeforeReplay)
    }
  )

  it.each([
    {
      name: 'workflow after before task',
      taskAfter: false,
      workflowAfter: true,
      ledgerAfter: false
    },
    {
      name: 'ledger after before both projections',
      taskAfter: false,
      workflowAfter: false,
      ledgerAfter: true
    },
    {
      name: 'ledger after before workflow',
      taskAfter: true,
      workflowAfter: false,
      ledgerAfter: true
    },
    {
      name: 'workflow and ledger after before task',
      taskAfter: false,
      workflowAfter: true,
      ledgerAfter: true
    }
  ])('blocks the impossible claim WAL prefix: $name', ({ taskAfter, workflowAfter, ledgerAfter }) => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => claimScheduledTask(task, 'impossible-prefix-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )

    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      taskAfter: ScheduledTask
      workflowAfter: WorkflowDefinition
      ledgerAfter: WorkflowRunEvent
    }
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    if (taskAfter) {
      const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
      const index = tasks.findIndex((candidate) => candidate.id === task.id)
      tasks[index] = journal.taskAfter
      fs.writeFileSync(tasksPath, JSON.stringify(tasks))
    }
    const workflowsPath = `${userDataPath}/workflows.json`
    if (workflowAfter) {
      const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
      const index = workflows.findIndex((candidate) => candidate.id === saved.id)
      workflows[index] = journal.workflowAfter
      fs.writeFileSync(workflowsPath, JSON.stringify(workflows))
    }
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    if (ledgerAfter) {
      fs.mkdirSync(`${userDataPath}/workflow-runs`, { recursive: true })
      fs.writeFileSync(ledgerPath, `${JSON.stringify(journal.ledgerAfter)}\n{"torn":`)
    }

    const tasksBeforeReplay = fs.readFileSync(tasksPath)
    const workflowsBeforeReplay = fs.readFileSync(workflowsPath)
    const journalBeforeReplay = fs.readFileSync(journalPath)
    const ledgerBeforeReplay = ledgerAfter ? fs.readFileSync(ledgerPath) : null
    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(fs.readFileSync(tasksPath)).toEqual(tasksBeforeReplay)
    expect(fs.readFileSync(workflowsPath)).toEqual(workflowsBeforeReplay)
    expect(fs.readFileSync(journalPath)).toEqual(journalBeforeReplay)
    if (ledgerBeforeReplay) expect(fs.readFileSync(ledgerPath)).toEqual(ledgerBeforeReplay)
    else expect(fs.existsSync(ledgerPath)).toBe(false)
  })

  it('blocks a materialization whose workflow projection advanced before its task', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => AppStore.materializeDueWorkflows(Date.parse(plannedFor))).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      workflowAfter: WorkflowDefinition
    }
    const workflowsPath = `${userDataPath}/workflows.json`
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const index = workflows.findIndex((candidate) => candidate.id === saved.id)
    workflows[index] = journal.workflowAfter
    fs.writeFileSync(workflowsPath, JSON.stringify(workflows))
    const workflowsBeforeReplay = fs.readFileSync(workflowsPath)
    const journalBeforeReplay = fs.readFileSync(journalPath)

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks()).toEqual([])
    expect(fs.readFileSync(workflowsPath)).toEqual(workflowsBeforeReplay)
    expect(fs.readFileSync(journalPath)).toEqual(journalBeforeReplay)
  })

  it('replays the fixed canonical ledger post-image after a delayed restart', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-workflow')
    expect(() => claimScheduledTask(task, 'delayed-ledger-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-workflow.'
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      ledgerAfter: WorkflowRunEvent
    }
    const exactPostImage = structuredClone(journal.ledgerAfter)

    vi.useFakeTimers()
    vi.setSystemTime('2026-12-31T23:59:59.000Z')
    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
      status: 'replayed',
      kind: 'claim',
      taskId: task.id
    })

    expect(AppStore.getWorkflowRunEvents(task.workflowExecutionId as string)).toEqual([
      exactPostImage
    ])
    expect(exactPostImage).toMatchObject({
      workflowId: saved.id,
      timestamp: plannedFor,
      kind: 'running',
      runId: 'delayed-ledger-owner'
    })
  })

  it('accepts one exact preseeded WAL event without appending a duplicate', () => {
    AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-workflow')
    expect(() => claimScheduledTask(task, 'exact-preseed-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-workflow.'
    )
    const journal = JSON.parse(
      fs.readFileSync(`${userDataPath}/scheduled-occurrence-mutation.json`, 'utf8')
    ) as { ledgerAfter: WorkflowRunEvent }
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    fs.mkdirSync(`${userDataPath}/workflow-runs`, { recursive: true })
    fs.writeFileSync(ledgerPath, `${JSON.stringify(journal.ledgerAfter)}\n`)

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
      status: 'replayed',
      kind: 'claim',
      taskId: task.id
    })
    expect(AppStore.getWorkflowRunEvents(task.workflowExecutionId as string)).toEqual([
      journal.ledgerAfter
    ])
  })

  it('blocks a conflicting preseed instead of accepting a similar lifecycle event', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => claimScheduledTask(task, 'conflicting-preseed-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      ledgerAfter: WorkflowRunEvent
    }
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    fs.mkdirSync(`${userDataPath}/workflow-runs`, { recursive: true })
    fs.writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        ...journal.ledgerAfter,
        timestamp: '2026-06-07T20:00:01.000Z'
      })}\n`
    )

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('due')
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('queued')
    expect(fs.existsSync(journalPath)).toBe(true)
  })

  it('blocks an exact preseed when a later event makes it no longer the WAL tail', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => claimScheduledTask(task, 'non-tail-preseed-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journal = JSON.parse(
      fs.readFileSync(`${userDataPath}/scheduled-occurrence-mutation.json`, 'utf8')
    ) as { ledgerAfter: WorkflowRunEvent }
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    fs.mkdirSync(`${userDataPath}/workflow-runs`, { recursive: true })
    fs.writeFileSync(
      ledgerPath,
      `${JSON.stringify(journal.ledgerAfter)}\n${JSON.stringify({
        ...journal.ledgerAfter,
        kind: 'harvested',
        sequence: journal.ledgerAfter.sequence + 1,
        timestamp: '2026-06-07T20:00:01.000Z'
      })}\n`
    )

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('due')
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('queued')
  })

  it('blocks a malformed ledger post-image in the journal before mutating either projection', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => claimScheduledTask(task, 'malformed-ledger-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      ledgerAfter: WorkflowRunEvent
    }
    journal.ledgerAfter.timestamp = 'not-an-iso-timestamp'
    fs.writeFileSync(journalPath, JSON.stringify(journal))

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('due')
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('queued')
    expect(fs.existsSync(journalPath)).toBe(true)
  })

  it('blocks a claim journal whose otherwise-equal lifecycle uses non-canonical timestamps', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => claimScheduledTask(task, 'noncanonical-claim-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
      createdAt: string
      taskAfter: ScheduledTask
      workflowAfter: WorkflowDefinition
      ledgerAfter: WorkflowRunEvent
    }
    const noncanonical = '2026-06-07T20:00:00Z'
    journal.createdAt = noncanonical
    journal.taskAfter.updatedAt = noncanonical
    journal.taskAfter.firedAt = noncanonical
    journal.taskAfter.runningSince = noncanonical
    journal.workflowAfter.updatedAt = noncanonical
    const execution = journal.workflowAfter.history.find(
      (item) => item.id === task.workflowExecutionId
    )!
    execution.updatedAt = noncanonical
    execution.startedAt = noncanonical
    journal.ledgerAfter.timestamp = noncanonical
    fs.writeFileSync(journalPath, JSON.stringify(journal))

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('due')
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('queued')
  })

  it('rejects settlement before the established occurrence start time', () => {
    AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(claimScheduledTask(task, 'ordered-settle-owner')).toBeTruthy()

    expect(() =>
      settleClaimedScheduledTask(task, 'ordered-settle-owner', {
        status: 'completed',
        completedAt: '2026-06-07T19:59:59.000Z'
      })
    ).toThrow('settlement timestamps are not logically ordered')
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe(
      'running'
    )
  })

  it.each(['run owner', 'event kind'] as const)(
    'blocks settlement replay when its exact ledger predecessor changes %s',
    (mutation) => {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
      expect(claimScheduledTask(task, 'ledger-predecessor-owner')).toBeTruthy()
      AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
      expect(() =>
        settleClaimedScheduledTask(task, 'ledger-predecessor-owner', {
          status: 'failed',
          completedAt: '2026-06-07T20:05:00.000Z',
          lastError: 'expected terminal'
        })
      ).toThrow('Injected scheduled occurrence mutation crash after-intent.')

      const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
      const event = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').trim()) as WorkflowRunEvent
      if (mutation === 'run owner') event.runId = 'different-ledger-owner'
      else event.kind = 'harvested'
      fs.writeFileSync(ledgerPath, `${JSON.stringify(event)}\n`)
      const ledgerBeforeReplay = fs.readFileSync(ledgerPath)
      const tasksPath = `${userDataPath}/scheduled-tasks.json`
      const workflowsPath = `${userDataPath}/workflows.json`
      const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
      const tasksBeforeReplay = fs.readFileSync(tasksPath)
      const workflowsBeforeReplay = fs.readFileSync(workflowsPath)
      const journalBeforeReplay = fs.readFileSync(journalPath)

      expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
      expect(fs.readFileSync(ledgerPath)).toEqual(ledgerBeforeReplay)
      expect(fs.readFileSync(tasksPath)).toEqual(tasksBeforeReplay)
      expect(fs.readFileSync(workflowsPath)).toEqual(workflowsBeforeReplay)
      expect(fs.readFileSync(journalPath)).toEqual(journalBeforeReplay)
      expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('running')
    }
  )

  it('refuses to journal a settlement after a prior execution terminal', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(claimScheduledTask(task, 'prior-terminal-owner')).toBeTruthy()
    AppStore.appendWorkflowRunEvent({
      workflowExecutionId: task.workflowExecutionId as string,
      workflowId: saved.id,
      scheduledTaskId: task.id,
      plannedFor: task.workflowOccurrenceAt,
      runId: 'prior-terminal-owner',
      kind: 'completed',
      timestamp: '2026-06-07T20:04:00.000Z'
    })
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    const ledgerBeforeSettlement = fs.readFileSync(ledgerPath)

    expect(() =>
      settleClaimedScheduledTask(task, 'prior-terminal-owner', {
        status: 'failed',
        completedAt: '2026-06-07T20:05:00.000Z',
        lastError: 'must not append after terminal'
      })
    ).toThrow('already contains a terminal transition')
    expect(fs.readFileSync(ledgerPath)).toEqual(ledgerBeforeSettlement)
    expect(AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)?.status).toBe(
      'running'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('running')
    expect(
      JSON.parse(fs.readFileSync(`${userDataPath}/scheduled-occurrence-mutation.json`, 'utf8'))
    ).toBeNull()
  })

  it.each(['after-intent', 'after-task', 'after-workflow', 'after-ledger'] as const)(
    'replays an owner-CAS terminal settle crash at %s',
    (crashPoint) => {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
      expect(claimScheduledTask(task, 'wal-settle-owner')).toBeTruthy()
      AppStore.setScheduledOccurrenceMutationCrashPointForTests(crashPoint)
      const completedAt = '2026-06-07T20:05:00.000Z'

      expect(() =>
        settleClaimedScheduledTask(task, 'wal-settle-owner', {
          status: 'completed',
          completedAt
        })
      ).toThrow(`Injected scheduled occurrence mutation crash ${crashPoint}.`)

      const taskBeforeReplay = AppStore.getScheduledTasks().find((item) => item.id === task.id)
      const workflowBeforeReplay = AppStore.getWorkflowDefinition(saved.id)
      expect(taskBeforeReplay?.status).toBe(
        crashPoint === 'after-intent' ? 'running' : 'completed'
      )
      expect(workflowBeforeReplay?.history[0]?.status).toBe(
        crashPoint === 'after-workflow' || crashPoint === 'after-ledger'
          ? 'completed'
          : 'running'
      )

      expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
        status: 'replayed',
        kind: 'settle',
        taskId: task.id
      })
      expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toMatchObject({
        status: 'completed',
        runId: 'wal-settle-owner',
        completedAt
      })
      expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
        activeExecutionId: undefined,
        lastStatus: 'completed'
      })
      expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
        status: 'completed',
        runId: 'wal-settle-owner',
        completedAt
      })
      expect(
        AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).map((event) => event.kind)
      ).toEqual(['running', 'completed'])
    }
  )

  it('replays a queued terminal split without leaving activeExecutionId wedged', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-task')

    expect(() =>
      AppStore.updateScheduledTask(task.id, {
        status: 'failed',
        completedAt: '2026-06-07T20:00:30.000Z',
        lastError: 'Pre-dispatch authority rejected.'
      })
    ).toThrow('Injected scheduled occurrence mutation crash after-task.')
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('failed')
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      activeExecutionId: task.workflowExecutionId,
      lastStatus: 'queued'
    })

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
      status: 'replayed',
      kind: 'settle',
      taskId: task.id
    })
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      activeExecutionId: undefined,
      lastStatus: 'failed',
      failureStreak: 1,
      lastError: 'Pre-dispatch authority rejected.'
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
      status: 'failed',
      error: 'Pre-dispatch authority rejected.'
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.runId).toBeUndefined()
  })

  it('rejects terminal settlement from the wrong run or workflow occurrence tuple', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const expected = expectedWorkflowOccurrence(task)
    expect(claimScheduledTask(task, 'terminal-owner')).toBeTruthy()
    const beforeTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.settleScheduledTaskForRun(task.id, {
        runId: 'wrong-owner',
        status: 'completed',
        expectedWorkflowOccurrence: expected
      })
    ).toBeNull()
    expect(
      AppStore.settleScheduledTaskForRun(task.id, {
        runId: 'terminal-owner',
        status: 'completed',
        expectedWorkflowOccurrence: { ...expected, plannedFor: '2026-06-07T19:59:00.000Z' }
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(beforeTask)
    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
  })

  it('fails closed when a run owner is duplicated outside its exact occurrence', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const unrelated = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'due', runAt: plannedFor })
    )
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(claimScheduledTask(task, 'ambiguous-owner')).toBeTruthy()
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const rows = JSON.parse(fs.readFileSync(tasksPath, 'utf8'))
    const unrelatedRow = rows.find((item: { id?: string }) => item.id === unrelated.id)
    Object.assign(unrelatedRow, { status: 'running', runId: 'ambiguous-owner' })
    fs.writeFileSync(tasksPath, JSON.stringify(rows))

    expect(
      AppStore.settleScheduledTaskForRun(task.id, {
        runId: 'ambiguous-owner',
        status: 'failed',
        lastError: 'must not settle',
        expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('running')
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('running')
    expect(AppStore.replayScheduledOccurrenceMutations()).toEqual({ status: 'none' })
  })

  it('rejects a claim when its execution id is duplicated in workflow history', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflowsPath = `${userDataPath}/workflows.json`
    const rows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const workflow = rows.find((item) => item.id === saved.id)!
    workflow.history.push({ ...workflow.history[0] })
    fs.writeFileSync(workflowsPath, JSON.stringify(rows))

    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'ambiguous-execution',
        expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
      })
    ).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('due')
  })

  it('rejects a queued execution that already carries a run owner', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflowsPath = `${userDataPath}/workflows.json`
    const rows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const workflow = rows.find((item) => item.id === saved.id)!
    workflow.history[0].runId = 'preowned-queue'
    fs.writeFileSync(workflowsPath, JSON.stringify(rows))

    expect(claimScheduledTask(task, 'new-owner')).toBeNull()
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('due')
    expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
      status: 'queued',
      runId: 'preowned-queue'
    })
  })

  it('fails closed on unsupported workflow-linked lifecycle updates', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const beforeTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.updateScheduledTask(task.id, {
        status: 'completed',
        completedAt: '2026-06-07T20:01:00.000Z'
      })
    ).toEqual(beforeTask)
    expect(
      AppStore.updateScheduledTask(task.id, {
        status: 'failed',
        completedAt: '2026-06-07T20:01:00.000Z',
        prompt: 'must not rewrite authority'
      })
    ).toEqual(beforeTask)
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(beforeTask)
    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
  })

  it('rejects status-less occurrence identity and authority rewrites', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const beforeTask = AppStore.getScheduledTasks().find((item) => item.id === task.id)
    const beforeWorkflow = AppStore.getWorkflowDefinition(saved.id)

    expect(
      AppStore.updateScheduledTask(task.id, {
        workflowId: 'forged-workflow',
        workflowExecutionId: 'forged-execution',
        workflowOccurrenceAt: '2026-06-07T21:00:00.000Z',
        workspaceId: 'forged-workspace',
        workspacePath: '/forged',
        prompt: 'forged prompt',
        approvalMode: 'auto_edit',
        provider: 'claude'
      })
    ).toEqual(beforeTask)
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(beforeTask)
    expect(AppStore.getWorkflowDefinition(saved.id)).toEqual(beforeWorkflow)
  })

  it('locks active occurrence projections while allowing workflow config and summary updates', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const active = AppStore.getWorkflowDefinition(saved.id)!

    expect(() => AppStore.updateWorkflowDefinition(saved.id, { history: [] })).toThrow(
      'Workflow occurrence lifecycle projections are immutable while an execution is active.'
    )
    expect(() =>
      AppStore.updateWorkflowDefinition(saved.id, {
        lastStatus: 'failed',
        failureStreak: 99
      })
    ).toThrow(
      'Workflow occurrence lifecycle projections are immutable while an execution is active.'
    )
    expect(() =>
      AppStore.saveWorkflowDefinition(
        workflowInput({
          id: saved.id,
          history: []
        })
      )
    ).toThrow(
      'Workflow occurrence lifecycle projections are immutable while an execution is active.'
    )

    const updated = AppStore.updateWorkflowDefinition(saved.id, {
      name: 'Active workflow config edit',
      lastRunIterationCount: 2,
      lastRunStopReason: 'waiting_for_review',
      lastRunTokens: 321
    })
    expect(updated).toMatchObject({
      name: 'Active workflow config edit',
      activeExecutionId: task.workflowExecutionId,
      lastStatus: 'queued',
      lastRunIterationCount: 2,
      lastRunStopReason: 'waiting_for_review',
      lastRunTokens: 321
    })
    expect(updated?.history).toEqual(active.history)

    const resaved = AppStore.saveWorkflowDefinition(
      workflowInput({
        id: saved.id,
        name: 'Active workflow resave'
      })
    )
    expect(resaved).toMatchObject({
      name: 'Active workflow resave',
      activeExecutionId: task.workflowExecutionId,
      lastStatus: 'queued'
    })
    expect(resaved.history).toEqual(active.history)
  })

  it.each(['due', 'running'] as const)(
    'deletes only an unowned workflow-linked %s task',
    (status) => {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
      if (status === 'running') expect(claimScheduledTask(task, 'delete-owner')).toBeTruthy()

      if (status === 'running') {
        expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
          'exact run owner must settle it first'
        )
        expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
          'exact run owner must settle it first'
        )
        expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toMatchObject({
          status: 'running',
          runId: 'delete-owner'
        })
        expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
          activeExecutionId: task.workflowExecutionId,
          lastStatus: 'running'
        })
        expect(
          AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).map(
            (event) => event.kind
          )
        ).toEqual(['running'])
        return
      }

      AppStore.deleteScheduledTask(task.id)

      expect(AppStore.getScheduledTasks().some((item) => item.id === task.id)).toBe(false)
      expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
        activeExecutionId: undefined,
        lastStatus: 'cancelled'
      })
      expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]).toMatchObject({
        status: 'cancelled',
        error: 'Scheduled task deleted.'
      })
      expect(
        AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).map(
          (event) => event.kind
        )
      ).toEqual(['cancelled'])
    }
  )

  it('rejects deletion of a live standalone occurrence without removing its owner', () => {
    const task = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'due' })
    )
    const running = AppStore.claimDueScheduledTaskForRun(task.id, {
      nowMs: Date.parse(plannedFor),
      runId: 'standalone-delete-owner'
    })!

    expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
      'exact run owner must settle it first'
    )
    expect(AppStore.getScheduledTasks().find((candidate) => candidate.id === task.id)).toEqual(
      running
    )
  })

  it('fails closed when task or workflow deletion cannot settle a linked occurrence', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    const taskRow = tasks.find((item) => item.id === task.id)!
    taskRow.workflowExecutionId = 'missing-execution'
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
      'could not be terminalized before deletion'
    )
    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
    expect(AppStore.getScheduledTasks().some((item) => item.id === task.id)).toBe(true)
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      activeExecutionId: task.workflowExecutionId,
      lastStatus: 'queued'
    })
  })

  it.each([
    {
      name: 'missing workflow',
      mutate: (task: ScheduledTask) => {
        task.workflowId = 'missing-workflow'
      }
    },
    {
      name: 'divergent planned-for identity',
      mutate: (task: ScheduledTask) => {
        task.workflowOccurrenceAt = '2026-06-07T20:00:01.000Z'
      }
    },
    {
      name: 'terminal task with a nonterminal execution',
      mutate: (task: ScheduledTask) => {
        task.status = 'cancelled'
        task.completedAt = '2026-06-07T20:00:01.000Z'
        task.lastError = 'forged one-sided terminal state'
      }
    }
  ])('refuses task and workflow deletion for a $name', ({ mutate }) => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    mutate(tasks.find((item) => item.id === task.id)!)
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
      'could not be terminalized before deletion'
    )
    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
    expect(AppStore.getScheduledTasks().some((item) => item.id === task.id)).toBe(true)
    expect(AppStore.getWorkflowDefinition(saved.id)).not.toBeNull()
  })

  it('refuses workflow deletion when its active execution task is missing', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    fs.writeFileSync(`${userDataPath}/scheduled-tasks.json`, '[]')

    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'scheduled task is missing or duplicated'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)).not.toBeNull()
  })

  it('refuses task and workflow deletion when an existing execution is divergent or duplicated', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflowsPath = `${userDataPath}/workflows.json`
    const baseline = fs.readFileSync(workflowsPath, 'utf8')
    const mutations: Array<(workflow: WorkflowDefinition) => void> = [
      (workflow) => {
        workflow.history[0].plannedFor = '2026-06-07T20:00:01.000Z'
      },
      (workflow) => {
        workflow.history.push({ ...workflow.history[0] })
      }
    ]

    for (const mutate of mutations) {
      fs.writeFileSync(workflowsPath, baseline)
      mutatePersistedWorkflow(saved.id, mutate)
      expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
        'could not be terminalized before deletion'
      )
      expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow()
      expect(AppStore.getScheduledTasks().some((item) => item.id === task.id)).toBe(true)
    }
  })

  it('refuses an exact pair hidden behind a raw 51st-prefix duplicate', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const workflowsPath = `${userDataPath}/workflows.json`
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const workflow = workflows.find((candidate) => candidate.id === saved.id)!
    const exact = workflow.history[0]
    const filler = Array.from({ length: 49 }, (_, index) => ({
      id: `hidden-prefix-filler-${index}`,
      workflowId: saved.id,
      plannedFor: new Date(Date.parse(plannedFor) + index + 1).toISOString(),
      status: 'skipped' as const,
      createdAt: new Date(Date.parse(plannedFor) + index + 1).toISOString(),
      updatedAt: new Date(Date.parse(plannedFor) + index + 1).toISOString(),
      completedAt: new Date(Date.parse(plannedFor) + index + 1).toISOString()
    }))
    workflow.history = [{ ...exact }, ...filler, exact]
    fs.writeFileSync(workflowsPath, JSON.stringify(workflows))

    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toHaveLength(50)
    expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
      'could not be terminalized before deletion'
    )
    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
  })

  it.each(['', ' '])('refuses destructive validation for an empty task owner %j', (taskId) => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const workflowsPath = `${userDataPath}/workflows.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    tasks.find((candidate) => candidate.id === task.id)!.id = taskId
    workflows
      .find((workflow) => workflow.id === saved.id)!
      .history.find((execution) => execution.id === task.workflowExecutionId)!.scheduledTaskId =
      taskId
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))
    fs.writeFileSync(workflowsPath, JSON.stringify(workflows))

    expect(() => AppStore.deleteScheduledTask(taskId)).toThrow('invalid task owner')
    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow('linked occurrence did not settle')
  })

  it('refuses deletion when another raw workflow hides a 51st-prefix owner', () => {
    const target = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const other = AppStore.saveWorkflowDefinition(workflowInput({ name: 'Other workflow' }))
    const workflowsPath = `${userDataPath}/workflows.json`
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const targetExecution = workflows
      .find((workflow) => workflow.id === target.id)!
      .history.find((execution) => execution.id === task.workflowExecutionId)!
    const otherWorkflow = workflows.find((workflow) => workflow.id === other.id)!
    otherWorkflow.history = [
      { ...targetExecution },
      ...Array.from({ length: 50 }, (_, index) => {
        const timestamp = new Date(Date.parse(plannedFor) + index + 1).toISOString()
        return {
          id: `other-history-${index}`,
          workflowId: other.id,
          plannedFor: timestamp,
          status: 'skipped' as const,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp
        }
      })
    ]
    fs.writeFileSync(workflowsPath, JSON.stringify(workflows))

    expect(AppStore.getWorkflowDefinition(other.id)?.history).toHaveLength(50)
    expect(() => AppStore.deleteScheduledTask(task.id)).toThrow('canonical persisted projection')
    expect(() => AppStore.deleteWorkflowDefinition(target.id)).toThrow('linked occurrence did not settle')
  })

  it('refuses an exact terminal pair with a defined empty run owner', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const running = claimScheduledTask(task, 'nonempty-owner')!
    const terminal = AppStore.settleScheduledTaskForRun(task.id, {
      runId: running.runId as string,
      status: 'completed',
      expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
    })!
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.find((candidate) => candidate.id === task.id)!.runId = ''
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))
    mutatePersistedWorkflow(saved.id, (workflow) => {
      workflow.history.find((execution) => execution.id === terminal.workflowExecutionId)!.runId = ''
    })

    expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
      'could not be terminalized before deletion'
    )
    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
  })

  it('includes a retained-history terminal task with a tampered workflow id in deletion checks', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const terminal = AppStore.updateScheduledTask(task.id, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
      lastError: 'terminal fixture'
    })
    expect(terminal?.status).toBe('cancelled')
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.find((candidate) => candidate.id === task.id)!.workflowId = 'tampered-workflow'
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)).not.toBeNull()
    expect(AppStore.getScheduledTasks().some((candidate) => candidate.id === task.id)).toBe(true)
  })

  it('discovers an alternate task id claiming a retained execution and run owner', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const running = claimScheduledTask(task, 'retained-alias-owner')!
    const terminal = AppStore.settleScheduledTaskForRun(task.id, {
      runId: running.runId as string,
      status: 'completed',
      expectedWorkflowOccurrence: expectedWorkflowOccurrence(task)
    })!
    AppStore.deleteScheduledTask(task.id)
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = AppStore.getScheduledTasks()
    tasks.push({
      ...terminal,
      id: 'alternate-retained-owner',
      workflowId: 'tampered-workflow'
    })
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)).not.toBeNull()
    expect(
      AppStore.getScheduledTasks().some((candidate) => candidate.id === 'alternate-retained-owner')
    ).toBe(true)
  })

  it('refuses deletion when an exact live pair has a duplicate task and run owner', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const running = claimScheduledTask(task, 'duplicate-live-owner')
    expect(running?.status).toBe('running')
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.push({ ...running!, id: 'duplicate-live-task' })
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    expect(() => AppStore.deleteScheduledTask(task.id)).toThrow(
      'exact run owner must settle it first'
    )
    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)).not.toBeNull()
  })

  it('deletes a terminal scheduled task after its execution ages out of bounded history', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const occurrences = materializeCompletedWorkflowOccurrences(saved.id)
    const oldest = occurrences[0]
    const workflow = AppStore.getWorkflowDefinition(saved.id)!

    expect(workflow.history).toHaveLength(50)
    expect(workflow.history.some((execution) => execution.id === oldest.workflowExecutionId)).toBe(
      false
    )
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.find((task) => task.id === oldest.id)!.runningSince = new Date(
      Date.parse(oldest.firedAt as string) + 500
    ).toISOString()
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    AppStore.deleteScheduledTask(oldest.id)

    expect(AppStore.getScheduledTasks().some((task) => task.id === oldest.id)).toBe(false)
    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toHaveLength(50)
  })

  it('allows pruned loop forensics to retain child run ids without changing terminal ownership', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const [oldest] = materializeCompletedWorkflowOccurrences(saved.id)
    const ledgerPath = `${userDataPath}/workflow-runs/${oldest.workflowExecutionId}.jsonl`
    const events = fs
      .readFileSync(ledgerPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as WorkflowRunEvent)
    events[1].sequence = 3
    events.splice(1, 0, {
      schemaVersion: 1,
      sequence: 2,
      workflowExecutionId: oldest.workflowExecutionId as string,
      workflowId: saved.id,
      scheduledTaskId: oldest.id,
      plannedFor: oldest.workflowOccurrenceAt,
      runId: 'loop-child-run',
      kind: 'harvested',
      timestamp: new Date(Date.parse(oldest.firedAt as string) + 500).toISOString(),
      iteration: 1,
      tokens: 123
    })
    fs.writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)

    AppStore.deleteScheduledTask(oldest.id)

    expect(AppStore.getScheduledTasks().some((task) => task.id === oldest.id)).toBe(false)
  })

  it('requires one exact execution-level claim before deleting a run-owned pruned terminal', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const [oldest] = materializeCompletedWorkflowOccurrences(saved.id)
    const ledgerPath = `${userDataPath}/workflow-runs/${oldest.workflowExecutionId}.jsonl`
    const baseline = fs.readFileSync(ledgerPath, 'utf8')
    const mutations: Array<(events: WorkflowRunEvent[]) => void> = [
      (events) => {
        events[0].runId = 'forged-execution-owner'
      },
      (events) => {
        events.shift()
        events[0].sequence = 1
      }
    ]

    for (const mutate of mutations) {
      const events = baseline
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as WorkflowRunEvent)
      mutate(events)
      fs.writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)

      expect(() => AppStore.deleteScheduledTask(oldest.id)).toThrow()
      expect(AppStore.getScheduledTasks().some((task) => task.id === oldest.id)).toBe(true)
    }
  })

  it('keeps an unverifiable pre-WAL pruned clock shape fail-closed pending migration', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const [oldest] = materializeCompletedWorkflowOccurrences(saved.id)
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.find((task) => task.id === oldest.id)!.createdAt = new Date(
      Date.parse(oldest.runAt) + 1
    ).toISOString()
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    expect(() => AppStore.deleteScheduledTask(oldest.id)).toThrow(
      'could not be terminalized before deletion'
    )
    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
  })

  it('deletes a workflow and every linked task after terminal history pruning', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const standalone = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ prompt: 'Preserve this unrelated task.' })
    )
    const occurrences = materializeCompletedWorkflowOccurrences(saved.id)

    expect(occurrences).toHaveLength(51)
    expect(AppStore.getWorkflowDefinition(saved.id)?.history).toHaveLength(50)

    AppStore.deleteWorkflowDefinition(saved.id)

    expect(AppStore.getWorkflowDefinition(saved.id)).toBeNull()
    expect(AppStore.getScheduledTasks().some((task) => task.workflowId === saved.id)).toBe(false)
    expect(AppStore.getScheduledTasks().find((task) => task.id === standalone.id)).toMatchObject({
      prompt: 'Preserve this unrelated task.'
    })
  })

  it('discovers a persisted pruned task whose workflow id was forged away', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const [oldest] = materializeCompletedWorkflowOccurrences(saved.id)
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    tasks.find((task) => task.id === oldest.id)!.workflowId = 'forged-away-workflow'
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))

    expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow(
      'linked occurrence did not settle'
    )
    expect(AppStore.getWorkflowDefinition(saved.id)).not.toBeNull()
    expect(AppStore.getScheduledTasks().some((task) => task.id === oldest.id)).toBe(true)
  })

  it('refuses a pruned terminal linkage with a duplicate task or run owner', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const occurrences = materializeCompletedWorkflowOccurrences(saved.id)
    const oldest = occurrences[0]
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const baseline = fs.readFileSync(tasksPath, 'utf8')

    for (const duplicateKind of ['execution-task', 'run'] as const) {
      fs.writeFileSync(tasksPath, baseline)
      const tasks = JSON.parse(baseline) as ScheduledTask[]
      const duplicate: ScheduledTask = {
        ...oldest,
        id: `duplicate-${duplicateKind}`
      }
      if (duplicateKind === 'run') {
        delete duplicate.workflowId
        delete duplicate.workflowExecutionId
        delete duplicate.workflowOccurrenceAt
      }
      tasks.push(duplicate)
      fs.writeFileSync(tasksPath, JSON.stringify(tasks))

      expect(() => AppStore.deleteScheduledTask(oldest.id)).toThrow(
        'could not be terminalized before deletion'
      )
      expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow()
      expect(AppStore.getScheduledTasks().some((task) => task.id === oldest.id)).toBe(true)
    }
  })

  it('refuses pruned-terminal deletion when raw history or the durable ledger is forged', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 100, maxConsecutiveFailures: 3 } })
    )
    const occurrences = materializeCompletedWorkflowOccurrences(saved.id)
    const oldest = occurrences[0]
    const workflowsPath = `${userDataPath}/workflows.json`
    const ledgerPath = `${userDataPath}/workflow-runs/${oldest.workflowExecutionId}.jsonl`
    const workflowBaseline = fs.readFileSync(workflowsPath, 'utf8')
    const ledgerBaseline = fs.readFileSync(ledgerPath, 'utf8')
    const mutations = [
      () => {
        const workflows = JSON.parse(workflowBaseline) as WorkflowDefinition[]
        delete (workflows.find((workflow) => workflow.id === saved.id)!.history[0] as {
          createdAt?: string
        }).createdAt
        fs.writeFileSync(workflowsPath, JSON.stringify(workflows))
      },
      () => {
        const events = ledgerBaseline
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line) as WorkflowRunEvent)
        events.at(-1)!.scheduledTaskId = 'forged-ledger-task'
        fs.writeFileSync(ledgerPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
      }
    ]

    for (const mutate of mutations) {
      fs.writeFileSync(workflowsPath, workflowBaseline)
      fs.writeFileSync(ledgerPath, ledgerBaseline)
      mutate()
      expect(() => AppStore.deleteScheduledTask(oldest.id)).toThrow(
        'could not be terminalized before deletion'
      )
      expect(() => AppStore.deleteWorkflowDefinition(saved.id)).toThrow()
    }
  })

  it('settles every linked occurrence before deleting its workflow definition', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const standalone = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ prompt: 'Unrelated cleanup survivor.' })
    )

    AppStore.deleteWorkflowDefinition(saved.id)

    expect(AppStore.getWorkflowDefinition(saved.id)).toBeNull()
    expect(AppStore.getScheduledTasks().some((item) => item.id === task.id)).toBe(false)
    expect(AppStore.getScheduledTasks().find((item) => item.id === standalone.id)).toMatchObject({
      prompt: 'Unrelated cleanup survivor.'
    })
    expect(
      AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).map((event) => event.kind)
    ).toEqual(['cancelled'])
  })

  it('journals a legacy ownerless running occurrence to one paired terminal state', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const workflowsPath = `${userDataPath}/workflows.json`
    const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8')) as ScheduledTask[]
    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as WorkflowDefinition[]
    const taskRow = tasks.find((item) => item.id === task.id)!
    const workflowRow = workflows.find((item) => item.id === saved.id)!
    taskRow.status = 'running'
    taskRow.firedAt = '2026-06-07T20:00:10.000Z'
    taskRow.runningSince = taskRow.firedAt
    workflowRow.history[0].status = 'running'
    workflowRow.history[0].startedAt = taskRow.firedAt
    workflowRow.lastStatus = 'running'
    fs.writeFileSync(tasksPath, JSON.stringify(tasks))
    fs.writeFileSync(workflowsPath, JSON.stringify(workflows))

    const staleIdOnly = AppStore.updateScheduledTask(task.id, {
      status: 'failed',
      completedAt: '2026-06-07T20:02:00.000Z',
      lastError: 'legacy process disappeared'
    })
    expect(staleIdOnly?.status).toBe('running')
    const [settled] = AppStore.recoverInterruptedScheduledTasksAfterStartup(
      Date.parse('2026-06-07T20:02:00.000Z')
    )
    expect(settled?.status).toBe('failed')
    expect(settled?.runId).toBeUndefined()
    expect(AppStore.getWorkflowDefinition(saved.id)).toMatchObject({
      activeExecutionId: undefined,
      lastStatus: 'failed',
      failureStreak: 1
    })
    const settledExecution = AppStore.getWorkflowDefinition(saved.id)?.history[0]
    expect(settledExecution).toMatchObject({
      status: 'failed',
      error: 'TaskWraith restarted before this scheduled run completed.'
    })
    expect(settledExecution?.runId).toBeUndefined()
    expect(
      AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).map((event) => event.kind)
    ).toEqual(['failed'])
  })

  it('blocks every task/workflow mutation API while an occurrence journal is pending', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const replacementWorkflow = workflowInput({ name: 'Must remain blocked' })
    const replacementTask = standaloneScheduledTaskInput({ prompt: 'Must remain blocked' })
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    const taskBeforeCrash = AppStore.getScheduledTasks().find((item) => item.id === task.id)!
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
    expect(() => claimScheduledTask(task, 'pending-owner')).toThrow(
      'Injected scheduled occurrence mutation crash after-intent.'
    )
    const tasksPath = `${userDataPath}/scheduled-tasks.json`
    const workflowsPath = `${userDataPath}/workflows.json`
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    const tasksBefore = fs.readFileSync(tasksPath, 'utf8')
    const workflowsBefore = fs.readFileSync(workflowsPath, 'utf8')
    const journalBefore = fs.readFileSync(journalPath, 'utf8')
    const resolveAttachments = vi.fn(() => ({ ok: true as const, attachments: [] }))
    const mutations: Array<() => unknown> = [
      () => AppStore.saveScheduledTask(replacementTask),
      () => AppStore.updateScheduledTask(task.id, { prompt: 'blocked' }),
      () => AppStore.deleteScheduledTask(task.id),
      () => AppStore.saveWorkflowDefinition(replacementWorkflow),
      () => AppStore.updateWorkflowDefinition(saved.id, { name: 'blocked' }),
      () => AppStore.deleteWorkflowDefinition(saved.id),
      () => AppStore.setWorkflowUnattendedElevation(saved.id, undefined),
      () => AppStore.materializeWorkflowNow(saved.id),
      () => AppStore.syncWorkflowFromScheduledTask(taskBeforeCrash),
      () => AppStore.getDueScheduledTasks(Date.parse(plannedFor), resolveAttachments),
      () =>
        AppStore.appendWorkflowRunEvent({
          workflowExecutionId: task.workflowExecutionId as string,
          workflowId: saved.id,
          scheduledTaskId: task.id,
          kind: 'running'
        }),
      () => AppStore.reconcileStaleWorkflowRunLedgers()
    ]
    for (const mutate of mutations) {
      expect(mutate).toThrow('Scheduled occurrence mutation recovery is pending.')
    }
    expect(fs.readFileSync(tasksPath, 'utf8')).toBe(tasksBefore)
    expect(fs.readFileSync(workflowsPath, 'utf8')).toBe(workflowsBefore)
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(journalBefore)
    expect(fs.existsSync(ledgerPath)).toBe(false)
    expect(resolveAttachments).not.toHaveBeenCalled()

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
      status: 'replayed',
      kind: 'claim',
      taskId: task.id
    })
    expect(AppStore.getWorkflowRunEvents(task.workflowExecutionId as string)).toHaveLength(1)
  })

  it.each(['task', 'workflow'] as const)(
    'blocks replay when a persisted %s post-image changes unrelated authority',
    (target) => {
      const saved = AppStore.saveWorkflowDefinition(workflowInput())
      const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
      AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-intent')
      expect(() => claimScheduledTask(task, 'authority-owner')).toThrow(
        'Injected scheduled occurrence mutation crash after-intent.'
      )
      const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
        taskAfter: Record<string, unknown>
        workflowAfter: WorkflowDefinition
      }
      if (target === 'task') journal.taskAfter.approvalMode = 'auto_edit'
      else journal.workflowAfter.template.prompt = 'mutated authority'
      fs.writeFileSync(journalPath, JSON.stringify(journal))

      expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
      expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)?.status).toBe('due')
      expect(AppStore.getWorkflowDefinition(saved.id)?.history[0]?.status).toBe('queued')
      expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).not.toBeNull()
    }
  )

  it('repairs a torn workflow ledger tail before replaying one terminal audit event', () => {
    const saved = AppStore.saveWorkflowDefinition(
      workflowInput({ limits: { maxRunsPerDay: 24, maxConsecutiveFailures: 3 } })
    )
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(claimScheduledTask(task, 'torn-tail-owner')).toBeTruthy()
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-workflow')
    expect(() =>
      settleClaimedScheduledTask(task, 'torn-tail-owner', {
        status: 'failed',
        completedAt: '2026-06-07T20:03:00.000Z',
        lastError: 'terminal failure'
      })
    ).toThrow('Injected scheduled occurrence mutation crash after-workflow.')
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    fs.appendFileSync(ledgerPath, '{"schemaVersion":')

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
      status: 'replayed',
      kind: 'settle',
      taskId: task.id
    })
    const events = AppStore.getWorkflowRunEvents(task.workflowExecutionId as string)
    expect(events.map((event) => event.kind)).toEqual(['running', 'failed'])
    expect(events.filter((event) => event.kind === 'failed')).toHaveLength(1)
    expect(AppStore.getWorkflowDefinition(saved.id)?.failureStreak).toBe(1)
    const lines = fs
      .readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines.every((line) => Boolean(JSON.parse(line)))).toBe(true)
    expect(AppStore.replayScheduledOccurrenceMutations()).toEqual({ status: 'none' })
  })

  it('keeps the journal when a durable ledger append cannot be verified', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(claimScheduledTask(task, 'corrupt-ledger-owner')).toBeTruthy()
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-workflow')
    expect(() =>
      settleClaimedScheduledTask(task, 'corrupt-ledger-owner', {
        status: 'failed',
        completedAt: '2026-06-07T20:04:00.000Z',
        lastError: 'must remain recoverable'
      })
    ).toThrow('Injected scheduled occurrence mutation crash after-workflow.')
    const ledgerPath = `${userDataPath}/workflow-runs/${task.workflowExecutionId}.jsonl`
    fs.appendFileSync(ledgerPath, '{not-json}\n')

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(JSON.parse(fs.readFileSync(`${userDataPath}/scheduled-occurrence-mutation.json`, 'utf8')))
      .not.toBeNull()
    expect(AppStore.getWorkflowDefinition(saved.id)?.failureStreak).toBe(1)
  })

  it('replays after a durable-ledger crash without duplicating failure or audit state', () => {
    const saved = AppStore.saveWorkflowDefinition(workflowInput())
    const [task] = AppStore.materializeDueWorkflows(Date.parse(plannedFor))
    expect(claimScheduledTask(task, 'ledger-crash-owner')).toBeTruthy()
    AppStore.setScheduledOccurrenceMutationCrashPointForTests('after-ledger')
    expect(() =>
      settleClaimedScheduledTask(task, 'ledger-crash-owner', {
        status: 'failed',
        completedAt: '2026-06-07T20:05:00.000Z',
        lastError: 'one failure only'
      })
    ).toThrow('Injected scheduled occurrence mutation crash after-ledger.')
    expect(AppStore.getWorkflowDefinition(saved.id)?.failureStreak).toBe(1)
    expect(
      AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).filter(
        (event) => event.kind === 'failed'
      )
    ).toHaveLength(1)

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({
      status: 'replayed',
      kind: 'settle',
      taskId: task.id
    })
    expect(AppStore.getWorkflowDefinition(saved.id)?.failureStreak).toBe(1)
    expect(
      AppStore.getWorkflowRunEvents(task.workflowExecutionId as string).filter(
        (event) => event.kind === 'failed'
      )
    ).toHaveLength(1)
    expect(AppStore.replayScheduledOccurrenceMutations()).toEqual({ status: 'none' })
  })

  it('preserves and blocks on a malformed occurrence journal instead of dispatching', () => {
    const task = saveStandaloneScheduledTaskForTest(
      standaloneScheduledTaskInput({ status: 'due', runAt: plannedFor })
    )
    const journalPath = `${userDataPath}/scheduled-occurrence-mutation.json`
    fs.writeFileSync(journalPath, JSON.stringify({ schemaVersion: 1, identity: {} }))

    expect(AppStore.replayScheduledOccurrenceMutations()).toMatchObject({ status: 'blocked' })
    expect(
      AppStore.claimDueScheduledTaskForRun(task.id, {
        nowMs: Date.parse(plannedFor),
        runId: 'must-not-dispatch'
      })
    ).toBeNull()
    expect(() => AppStore.updateScheduledTask(task.id, { prompt: 'must not mutate' })).toThrow(
      'Scheduled occurrence mutation journal is invalid.'
    )
    expect(AppStore.getScheduledTasks().find((item) => item.id === task.id)).toEqual(task)
    expect(fs.existsSync(journalPath)).toBe(true)
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
    settleClaimedScheduledTask(task, 'run-1', {
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
    settleClaimedScheduledTask(task, 'run-1', { status: 'failed', lastError: 'boom' })
    // A re-patch that does not change status must not append a duplicate event.
    AppStore.updateScheduledTask(task.id, { status: 'failed', lastError: 'boom' })

    const events = AppStore.getWorkflowRunEvents(executionId)
    expect(events.map((e) => e.kind)).toEqual(['running', 'failed'])
    expect(events[1].error).toBe('boom')
  })

  it('returns an empty ledger for an unknown execution', () => {
    expect(AppStore.getWorkflowRunEvents('nope')).toEqual([])
  })

  it('rejects structurally invalid append input before changing ledger bytes', () => {
    const executionId = 'append-input-execution'
    const workflowId = 'append-input-workflow'
    AppStore.appendWorkflowRunEvent({
      workflowExecutionId: executionId,
      workflowId,
      kind: 'materialized',
      timestamp: plannedFor
    })
    const ledgerPath = `${userDataPath}/workflow-runs/${executionId}.jsonl`
    const baseline = fs.readFileSync(ledgerPath)
    const common = {
      workflowExecutionId: executionId,
      workflowId,
      kind: 'harvested' as const,
      timestamp: '2026-06-07T20:00:01.000Z'
    }
    const invalidInputs: Array<Parameters<typeof AppStore.appendWorkflowRunEvent>[0]> = [
      { ...common, kind: 'unknown-kind' as WorkflowRunEvent['kind'] },
      { ...common, timestamp: 'not-an-iso-timestamp' },
      { ...common, scheduledTaskId: ' ' },
      { ...common, runId: ' ' },
      { ...common, plannedFor: 'not-an-iso-timestamp' },
      { ...common, iteration: 0 }
    ]

    for (const input of invalidInputs) {
      expect(() => AppStore.appendWorkflowRunEvent(input)).toThrow(
        'Workflow run ledger event input is structurally invalid.'
      )
      expect(fs.readFileSync(ledgerPath)).toEqual(baseline)
    }
  })

  it('rejects a sanitized execution-id filename collision without touching its victim ledger', () => {
    const canonicalExecutionId = 'collision_execution'
    AppStore.appendWorkflowRunEvent({
      workflowExecutionId: canonicalExecutionId,
      workflowId: 'collision-workflow',
      kind: 'materialized',
      timestamp: plannedFor
    })
    const ledgerPath = `${userDataPath}/workflow-runs/${canonicalExecutionId}.jsonl`
    const baseline = fs.readFileSync(ledgerPath)

    expect(() =>
      AppStore.appendWorkflowRunEvent({
        workflowExecutionId: 'collision/execution',
        workflowId: 'attacker-workflow',
        kind: 'materialized',
        timestamp: plannedFor
      })
    ).toThrow('Workflow run ledger event input is structurally invalid.')
    expect(fs.readFileSync(ledgerPath)).toEqual(baseline)
    expect(fs.readdirSync(`${userDataPath}/workflow-runs`)).toEqual([
      `${canonicalExecutionId}.jsonl`
    ])
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
