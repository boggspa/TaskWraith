import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerScheduledWorkflowHandlers } from './scheduledWorkflowHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  const defaultSanitizedTask = {
    id: 'task-1',
    workspaceId: 'ws-1',
    workflowId: 'wf-1'
  } as any
  const defaultWorkflow = {
    id: 'wf-1',
    name: 'wf',
    template: { workspacePath: '/tmp/test', approvalMode: 'auto' },
    workspacePath: '/tmp/test'
  } as any

  return {
    getScheduledTasks: vi.fn(() => [defaultSanitizedTask]),
    saveScheduledTask: vi.fn((task) => ({ ...defaultSanitizedTask, ...task })),
    updateScheduledTask: vi.fn((id, partial) => ({ ...defaultSanitizedTask, id, ...partial })),
    deleteScheduledTask: vi.fn(),
    getWorkflowDefinitions: vi.fn(() => [defaultWorkflow]),
    getWorkflowDefinition: vi.fn(() => defaultWorkflow),
    saveWorkflowDefinition: vi.fn((workflow) => ({ ...workflow })),
    updateWorkflowDefinition: vi.fn((id, partial) => ({ ...defaultWorkflow, id, ...partial })),
    deleteWorkflowDefinition: vi.fn(),
    getWorkspaceBoards: vi.fn(() => [{ id: 'board-1' } as any]),
    getWorkspaceBoardCards: vi.fn(() => [{ id: 'card-1' } as any]),
    saveWorkspaceBoard: vi.fn((board) => ({ ...board, id: board.id || 'board-1' })),
    updateWorkspaceBoard: vi.fn((id, partial) => ({ id, ...partial })),
    deleteWorkspaceBoard: vi.fn(),
    saveWorkspaceBoardCard: vi.fn((card) => ({ ...card, id: card.id || 'card-1' })),
    updateWorkspaceBoardCard: vi.fn((id, partial) => ({ id, ...partial })),
    deleteWorkspaceBoardCard: vi.fn(),
    materializeWorkflowNow: vi.fn(() => defaultSanitizedTask),
    setWorkflowUnattendedElevation: vi.fn((_, ack) => ({ ...defaultWorkflow, unattendedElevation: ack })),
    getWorkflowRunSummaries: vi.fn(async () => [{ id: 'summary-1' }]),
    getWorkflowRunEventsFiltered: vi.fn(async () => [{ id: 'event-1' }]),

    emitDueScheduledTasks: vi.fn(),
    scheduleNextTaskTimer: vi.fn(),
    buildUnattendedElevationAck: vi.fn((_workflow, _level, sign) => {
      sign({
        workflowId: 'wf-1',
        workspacePath: '/tmp/test',
        level: 'default',
        acknowledgedApprovalMode: 'auto'
      })
      return { acknowledgedApprovalMode: 'auto' } as any
    }),
    signWorkflowUnattendedElevation: vi.fn(() => 'signed-token'),
    requireNonEmptyString: vi.fn((value) => `${value}`),
    sanitizeScheduledTaskForSave: vi.fn((task) => task),
    sanitizeScheduledTaskPatch: vi.fn((_, partial) => partial),
    sanitizeWorkflowForSave: vi.fn((workflow) => workflow),
    sanitizeWorkflowPatch: vi.fn((_, partial) => partial),
    sanitizeWorkspaceBoardForSave: vi.fn((board) => board),
    sanitizeWorkspaceBoardPatch: vi.fn((partial) => partial),
    sanitizeWorkspaceBoardCardForSave: vi.fn((card) => card),
    sanitizeWorkspaceBoardCardPatch: vi.fn((partial) => partial),
    broadcastScheduledTasksChanged: vi.fn(),
    broadcastWorkflowDefinitionsChanged: vi.fn(),
    broadcastScheduledTaskDue: vi.fn(),
    broadcastWorkspaceBoardsChanged: vi.fn(),
    broadcastRemoteProjectionSnapshot: vi.fn()
  }
}

describe('registerScheduledWorkflowHandlers', () => {
  it('registers scheduled task, workflow, and board handlers', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    expect(handlerFor('get-scheduled-tasks')).toBeTypeOf('function')
    expect(handlerFor('save-scheduled-task')).toBeTypeOf('function')
    expect(handlerFor('update-scheduled-task')).toBeTypeOf('function')
    expect(handlerFor('delete-scheduled-task')).toBeTypeOf('function')
    expect(handlerFor('get-workflow-definitions')).toBeTypeOf('function')
    expect(handlerFor('save-workflow-definition')).toBeTypeOf('function')
    expect(handlerFor('update-workflow-definition')).toBeTypeOf('function')
    expect(handlerFor('delete-workflow-definition')).toBeTypeOf('function')
    expect(handlerFor('get-workspace-boards')).toBeTypeOf('function')
    expect(handlerFor('save-workspace-board')).toBeTypeOf('function')
    expect(handlerFor('update-workspace-board')).toBeTypeOf('function')
    expect(handlerFor('delete-workspace-board')).toBeTypeOf('function')
    expect(handlerFor('get-workspace-board-cards')).toBeTypeOf('function')
    expect(handlerFor('save-workspace-board-card')).toBeTypeOf('function')
    expect(handlerFor('update-workspace-board-card')).toBeTypeOf('function')
    expect(handlerFor('delete-workspace-board-card')).toBeTypeOf('function')
    expect(handlerFor('run-workflow-now')).toBeTypeOf('function')
    expect(handlerFor('set-workflow-unattended-elevation')).toBeTypeOf('function')
    expect(handlerFor('get-workflow-run-summaries')).toBeTypeOf('function')
    expect(handlerFor('get-workflow-run-events')).toBeTypeOf('function')
  })

  it('saves scheduled tasks through sanitization and broadcasts changed schedules', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const payload = {
      workspaceId: 'ws-1',
      workflowId: 'wf-1',
      nextRunAt: '2026-01-01T00:00:00.000Z'
    }

    const saved = handlerFor('save-scheduled-task')({}, payload)

    expect(deps.sanitizeScheduledTaskForSave).toHaveBeenCalledWith(payload)
    expect(deps.saveScheduledTask).toHaveBeenCalledWith(payload)
    expect(deps.broadcastScheduledTasksChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastWorkflowDefinitionsChanged).toHaveBeenCalledTimes(1)
    expect(deps.emitDueScheduledTasks).toHaveBeenCalledTimes(1)
    expect(saved).toMatchObject({
      id: 'task-1',
      workspaceId: 'ws-1',
      workflowId: 'wf-1'
    })
  })

  it('broadcasts schedule changes after workflow updates and schedules timer', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const updated = handlerFor('update-workflow-definition')({}, 'wf-1', { name: 'new' })

    expect(deps.sanitizeWorkflowPatch).toHaveBeenCalledWith('wf-1', { name: 'new' })
    expect(deps.updateWorkflowDefinition).toHaveBeenCalledWith('wf-1', { name: 'new' })
    expect(deps.broadcastWorkflowDefinitionsChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.scheduleNextTaskTimer).toHaveBeenCalledTimes(1)
    expect(updated).toMatchObject({ id: 'wf-1', name: 'new' })
  })

  it('proxies run-now execution to workflow materialization and emits due-task signal', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const dueTask = handlerFor('run-workflow-now')({}, 'wf-1')

    expect(deps.materializeWorkflowNow).toHaveBeenCalledWith('wf-1')
    expect(deps.broadcastWorkflowDefinitionsChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastScheduledTasksChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastScheduledTaskDue).toHaveBeenCalledWith(dueTask)
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.scheduleNextTaskTimer).toHaveBeenCalledTimes(1)
  })

  it('saves unattended elevation via workflow template mode callback', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const wf = handlerFor('set-workflow-unattended-elevation')({}, 'wf-1', 'default')

    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('wf-1', 'Workflow id')
    expect(deps.getWorkflowDefinition).toHaveBeenCalledWith('wf-1')
    expect(deps.buildUnattendedElevationAck).toHaveBeenCalled()
    expect(deps.signWorkflowUnattendedElevation).toHaveBeenCalled()
    expect(deps.setWorkflowUnattendedElevation).toHaveBeenCalledWith(
      'wf-1',
      expect.any(Object)
    )
    expect(wf).toMatchObject({ id: 'wf-1', unattendedElevation: { acknowledgedApprovalMode: 'auto' } })
  })

  it('reads workflow run summaries and events through injected store queries', async () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    expect(await handlerFor('get-workflow-run-summaries')({}, 'wf-1')).toEqual([{ id: 'summary-1' }])
    expect(deps.getWorkflowRunSummaries).toHaveBeenCalledWith('wf-1')

    const events = await handlerFor('get-workflow-run-events')({}, { workflowExecutionId: 'run-1' })
    expect(events).toEqual([{ id: 'event-1' }])
    expect(deps.getWorkflowRunEventsFiltered).toHaveBeenCalledWith({ workflowExecutionId: 'run-1' })
  })
})
