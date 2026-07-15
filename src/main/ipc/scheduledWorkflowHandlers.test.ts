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
  const authorityDigest = 'a'.repeat(64)
  const defaultSanitizedTask = {
    id: 'task-1',
    chatId: 'chat-1',
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
    assertMainRendererSender: vi.fn(),
    assertRendererChatScope: vi.fn(),
    getScheduledTasks: vi.fn(() => [defaultSanitizedTask]),
    saveScheduledTask: vi.fn((task) => ({ ...defaultSanitizedTask, ...task })),
    updateScheduledTask: vi.fn((id, partial) => ({ ...defaultSanitizedTask, id, ...partial })),
    cancelScheduledTask: vi.fn(async (id, reason) => ({
      ...defaultSanitizedTask,
      id,
      status: 'cancelled',
      lastError: reason
    })),
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
    getEvidencePacks: vi.fn(() => [{ id: 'pack-1' } as any]),
    saveEvidencePack: vi.fn((pack) => ({ ...pack, id: pack.id || 'pack-1' })),
    deleteEvidencePack: vi.fn(),
    getCapabilityLedgerSnapshot: vi.fn(() => ({ workspaceId: 'ws-1', cells: [] } as any)),
    getRepoConventionIndexes: vi.fn(() => [{ workspaceId: 'ws-1' } as any]),
    saveRepoConventionIndex: vi.fn((snapshot) => ({ ...snapshot, workspaceId: snapshot.workspaceId || 'ws-1' })),
    materializeWorkflowNow: vi.fn(() => defaultSanitizedTask),
    workflowAuthorityDigest: vi.fn(() => authorityDigest),
    currentWorkflowUnattendedElevationCapability: vi.fn(
      () => null as { key: string; level: 'default' | 'full_access' } | null
    ),
    workflowTargetIsCurrent: vi.fn(() => true),
    confirmWorkflowUnattendedElevation: vi.fn(async () => true),
    confirmElevatedWorkflowRunNow: vi.fn(async () => true),
    setWorkflowUnattendedElevation: vi.fn((_, ack) => ({ ...defaultWorkflow, unattendedElevation: ack })),
    getWorkflowRunSummaries: vi.fn(async () => [{ id: 'summary-1' }]),
    getWorkflowRunEventsFiltered: vi.fn(async () => [{ id: 'event-1' }]),
    getAgentStatsSummaries: vi.fn(async () => [{ agentId: 'pooled-agent-1' }]),

    emitDueScheduledTasks: vi.fn(),
    scheduleNextTaskTimer: vi.fn(),
    buildUnattendedElevationAck: vi.fn((_workflow, _level, digest, sign) => {
      sign({
        workflowId: 'wf-1',
        workspacePath: '/tmp/test',
        level: 'default',
        acknowledgedApprovalMode: 'auto',
        authorityDigest: digest
      })
      return { acknowledgedApprovalMode: 'auto', authorityDigest: digest } as any
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
    broadcastEvidencePacksChanged: vi.fn(),
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
    expect(handlerFor('cancel-scheduled-task')).toBeTypeOf('function')
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
    expect(handlerFor('get-evidence-packs')).toBeTypeOf('function')
    expect(handlerFor('save-evidence-pack')).toBeTypeOf('function')
    expect(handlerFor('delete-evidence-pack')).toBeTypeOf('function')
    expect(handlerFor('get-capability-ledger-snapshot')).toBeTypeOf('function')
    expect(handlerFor('get-repo-convention-indexes')).toBeTypeOf('function')
    expect(handlerFor('save-repo-convention-index')).toBeTypeOf('function')
    expect(handlerFor('run-workflow-now')).toBeTypeOf('function')
    expect(handlerFor('set-workflow-unattended-elevation')).toBeTypeOf('function')
    expect(handlerFor('get-workflow-run-summaries')).toBeTypeOf('function')
    expect(handlerFor('get-workflow-run-events')).toBeTypeOf('function')
    expect(handlerFor('get-agent-stats-summaries')).toBeTypeOf('function')
  })

  it('rejects every scheduled-workflow surface before reading or mutating global state', async () => {
    const deps = createDeps()
    const rejection = new Error('Only the main renderer can manage workspace authority.')
    deps.assertMainRendererSender.mockImplementation(() => {
      throw rejection
    })
    registerScheduledWorkflowHandlers(deps)

    const channels = [
      'get-scheduled-tasks',
      'save-scheduled-task',
      'update-scheduled-task',
      'delete-scheduled-task',
      'get-workflow-definitions',
      'save-workflow-definition',
      'update-workflow-definition',
      'delete-workflow-definition',
      'get-workspace-boards',
      'save-workspace-board',
      'update-workspace-board',
      'delete-workspace-board',
      'get-workspace-board-cards',
      'save-workspace-board-card',
      'update-workspace-board-card',
      'delete-workspace-board-card',
      'get-evidence-packs',
      'save-evidence-pack',
      'delete-evidence-pack',
      'get-capability-ledger-snapshot',
      'get-repo-convention-indexes',
      'save-repo-convention-index',
      'run-workflow-now',
      'set-workflow-unattended-elevation',
      'get-workflow-run-summaries',
      'get-workflow-run-events',
      'get-agent-stats-summaries'
    ]
    const event = { sender: { id: 42 } }
    const asyncChannels = new Set([
      'run-workflow-now',
      'set-workflow-unattended-elevation'
    ])

    for (const channel of channels) {
      if (asyncChannels.has(channel)) {
        await expect(handlerFor(channel)(event)).rejects.toThrow(rejection)
      } else {
        expect(() => handlerFor(channel)(event)).toThrow(rejection)
      }
    }
    expect(deps.assertMainRendererSender).toHaveBeenCalledTimes(channels.length)
    expect(deps.getScheduledTasks).not.toHaveBeenCalled()
    expect(deps.materializeWorkflowNow).not.toHaveBeenCalled()
    expect(deps.cancelScheduledTask).not.toHaveBeenCalled()
    expect(deps.setWorkflowUnattendedElevation).not.toHaveBeenCalled()
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

  it('delegates scheduled cancellation after exact chat-scope and id validation', async () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    await expect(
      handlerFor('cancel-scheduled-task')({}, 'task-1', '  Cancelled from test.  ')
    ).resolves.toMatchObject({ id: 'task-1', status: 'cancelled' })
    expect(deps.assertRendererChatScope).toHaveBeenCalledWith({}, 'chat-1')
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('task-1', 'Scheduled task id')
    expect(deps.cancelScheduledTask).toHaveBeenCalledWith(
      'task-1',
      'Cancelled from test.'
    )
  })

  it('rejects scheduled cancellation before mutation when the renderer lacks chat scope', async () => {
    const deps = createDeps()
    deps.assertRendererChatScope.mockImplementation(() => {
      throw new Error('Renderer does not own this chat.')
    })
    registerScheduledWorkflowHandlers(deps)

    await expect(
      handlerFor('cancel-scheduled-task')({}, 'task-1', 'Denied cancel.')
    ).rejects.toThrow('Renderer does not own this chat.')
    expect(deps.cancelScheduledTask).not.toHaveBeenCalled()
  })

  it('does not reach workflow persistence when create-only sanitization rejects a victim id', () => {
    const deps = createDeps()
    deps.sanitizeWorkflowForSave.mockImplementation(() => {
      throw new Error('Workflow creation cannot replace an existing workflow.')
    })
    registerScheduledWorkflowHandlers(deps)

    expect(() =>
      handlerFor('save-workflow-definition')({}, { id: 'wf-1', name: 'Hijack' })
    ).toThrow('Workflow creation cannot replace an existing workflow.')
    expect(deps.saveWorkflowDefinition).not.toHaveBeenCalled()
    expect(deps.getWorkflowDefinition()).toMatchObject({ id: 'wf-1', name: 'wf' })
  })

  it('saves evidence packs and broadcasts ledger changes', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const payload = {
      workspaceId: 'ws-1',
      capabilityCells: []
    }

    const saved = handlerFor('save-evidence-pack')({}, payload)

    expect(deps.saveEvidencePack).toHaveBeenCalledWith(payload)
    expect(deps.broadcastEvidencePacksChanged).toHaveBeenCalledTimes(1)
    expect(saved).toMatchObject({
      id: 'pack-1',
      workspaceId: 'ws-1'
    })
  })

  it('routes workspace board mutations through sanitizers, store calls, and board broadcasts', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const boardPayload = { name: 'Board', workspaceId: 'ws-1' }
    expect(handlerFor('save-workspace-board')({}, boardPayload)).toMatchObject({ id: 'board-1', name: 'Board' })
    expect(deps.sanitizeWorkspaceBoardForSave).toHaveBeenCalledWith(boardPayload)
    expect(deps.saveWorkspaceBoard).toHaveBeenCalledWith(boardPayload)

    expect(handlerFor('update-workspace-board')({}, 'board-1', { archived: false })).toMatchObject({
      id: 'board-1',
      archived: false
    })
    expect(deps.sanitizeWorkspaceBoardPatch).toHaveBeenCalledWith({ archived: false })
    expect(deps.updateWorkspaceBoard).toHaveBeenCalledWith('board-1', { archived: false })

    const cardPayload = { boardId: 'board-1', title: 'Card' }
    expect(handlerFor('save-workspace-board-card')({}, cardPayload)).toMatchObject({ id: 'card-1', title: 'Card' })
    expect(deps.sanitizeWorkspaceBoardCardForSave).toHaveBeenCalledWith(cardPayload)
    expect(deps.saveWorkspaceBoardCard).toHaveBeenCalledWith(cardPayload)

    expect(handlerFor('update-workspace-board-card')({}, 'card-1', { columnId: 'done' })).toMatchObject({
      id: 'card-1',
      columnId: 'done'
    })
    expect(deps.sanitizeWorkspaceBoardCardPatch).toHaveBeenCalledWith({ columnId: 'done' })
    expect(deps.updateWorkspaceBoardCard).toHaveBeenCalledWith('card-1', { columnId: 'done' })

    handlerFor('delete-workspace-board-card')({}, 'card-1')
    expect(deps.deleteWorkspaceBoardCard).toHaveBeenCalledWith('card-1')

    handlerFor('delete-workspace-board')({}, 'board-1')
    expect(deps.deleteWorkspaceBoard).toHaveBeenCalledWith('board-1')
    expect(deps.broadcastWorkspaceBoardsChanged).toHaveBeenCalledTimes(6)
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledTimes(6)
  })

  it('broadcasts schedule changes after workflow updates and schedules timer', () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const updated = handlerFor('update-workflow-definition')({}, 'wf-1', { enabled: false })

    expect(deps.sanitizeWorkflowPatch).toHaveBeenCalledWith('wf-1', { enabled: false })
    expect(deps.updateWorkflowDefinition).toHaveBeenCalledWith('wf-1', { enabled: false })
    expect(deps.broadcastWorkflowDefinitionsChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.scheduleNextTaskTimer).toHaveBeenCalledTimes(1)
    expect(updated).toMatchObject({ id: 'wf-1', enabled: false })
  })

  it('routes safe Run Now execution through the main-owned due-task emitter', async () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const dueTask = await handlerFor('run-workflow-now')({}, 'wf-1')

    expect(deps.materializeWorkflowNow).toHaveBeenCalledWith('wf-1')
    expect(deps.broadcastWorkflowDefinitionsChanged).toHaveBeenCalledTimes(1)
    expect(deps.broadcastScheduledTasksChanged).toHaveBeenCalledTimes(1)
    expect(deps.emitDueScheduledTasks).toHaveBeenCalledTimes(1)
    expect(deps.broadcastScheduledTaskDue).not.toHaveBeenCalled()
    expect(deps.broadcastRemoteProjectionSnapshot).toHaveBeenCalledTimes(1)
    expect(deps.scheduleNextTaskTimer).not.toHaveBeenCalled()
    expect(dueTask).toMatchObject({ id: 'task-1' })
  })

  it('rearms the schedule when Run Now cannot materialize a due task', async () => {
    const deps = createDeps()
    deps.materializeWorkflowNow.mockReturnValue(null)
    registerScheduledWorkflowHandlers(deps)

    await expect(handlerFor('run-workflow-now')({}, 'wf-1')).resolves.toBeNull()

    expect(deps.emitDueScheduledTasks).not.toHaveBeenCalled()
    expect(deps.broadcastScheduledTaskDue).not.toHaveBeenCalled()
    expect(deps.scheduleNextTaskTimer).toHaveBeenCalledTimes(1)
  })

  it('saves unattended elevation only after native confirmation', async () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    const wf = await handlerFor('set-workflow-unattended-elevation')(
      {},
      'wf-1',
      'default'
    )

    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('wf-1', 'Workflow id')
    expect(deps.getWorkflowDefinition).toHaveBeenCalledWith('wf-1')
    expect(deps.confirmWorkflowUnattendedElevation).toHaveBeenCalled()
    expect(deps.buildUnattendedElevationAck).toHaveBeenCalled()
    expect(deps.signWorkflowUnattendedElevation).toHaveBeenCalled()
    expect(deps.setWorkflowUnattendedElevation).toHaveBeenCalledWith(
      'wf-1',
      expect.any(Object)
    )
    expect(wf).toMatchObject({ id: 'wf-1', unattendedElevation: { acknowledgedApprovalMode: 'auto' } })
  })

  it('does not sign or persist elevation when native confirmation is declined or stale', async () => {
    const deps = createDeps()
    deps.confirmWorkflowUnattendedElevation.mockResolvedValue(false)
    registerScheduledWorkflowHandlers(deps)

    await expect(
      handlerFor('set-workflow-unattended-elevation')({}, 'wf-1', 'full_access')
    ).resolves.toMatchObject({ id: 'wf-1' })
    expect(deps.buildUnattendedElevationAck).not.toHaveBeenCalled()
    expect(deps.signWorkflowUnattendedElevation).not.toHaveBeenCalled()
    expect(deps.setWorkflowUnattendedElevation).not.toHaveBeenCalled()

    deps.confirmWorkflowUnattendedElevation.mockResolvedValue(true)
    deps.workflowAuthorityDigest
      .mockReturnValueOnce('a'.repeat(64))
      .mockReturnValueOnce('b'.repeat(64))
    await expect(
      handlerFor('set-workflow-unattended-elevation')({}, 'wf-1', 'default')
    ).resolves.toMatchObject({ id: 'wf-1' })
    expect(deps.buildUnattendedElevationAck).not.toHaveBeenCalled()
    expect(deps.setWorkflowUnattendedElevation).not.toHaveBeenCalled()
  })

  it('does not mint when the target chat or prior elevation capability changes during confirmation', async () => {
    const deps = createDeps()
    deps.workflowTargetIsCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false)
    registerScheduledWorkflowHandlers(deps)

    await expect(
      handlerFor('set-workflow-unattended-elevation')({}, 'wf-1', 'default')
    ).resolves.toMatchObject({ id: 'wf-1' })
    expect(deps.setWorkflowUnattendedElevation).not.toHaveBeenCalled()

    deps.workflowTargetIsCurrent.mockReturnValue(true)
    deps.currentWorkflowUnattendedElevationCapability
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        key: `default:${'a'.repeat(64)}:new-signature`,
        level: 'default'
      })
    await expect(
      handlerFor('set-workflow-unattended-elevation')({}, 'wf-1', 'default')
    ).resolves.toMatchObject({ id: 'wf-1' })
    expect(deps.setWorkflowUnattendedElevation).not.toHaveBeenCalled()
  })

  it('revokes safely without confirmation and rejects unknown elevation levels', async () => {
    const deps = createDeps()
    registerScheduledWorkflowHandlers(deps)

    await handlerFor('set-workflow-unattended-elevation')({}, 'wf-1', 'safe')
    expect(deps.confirmWorkflowUnattendedElevation).not.toHaveBeenCalled()
    expect(deps.setWorkflowUnattendedElevation).toHaveBeenCalledWith('wf-1', undefined)

    await expect(
      handlerFor('set-workflow-unattended-elevation')({}, 'wf-1', 'bogus')
    ).rejects.toThrow('Workflow unattended elevation level is invalid.')
    expect(deps.confirmWorkflowUnattendedElevation).not.toHaveBeenCalled()
  })

  it('requires fresh native intent before Run Now uses a current elevated ack', async () => {
    const deps = createDeps()
    deps.currentWorkflowUnattendedElevationCapability.mockReturnValue({
      key: `default:${'a'.repeat(64)}:signature`,
      level: 'default'
    })
    deps.confirmElevatedWorkflowRunNow.mockResolvedValue(false)
    registerScheduledWorkflowHandlers(deps)

    await expect(handlerFor('run-workflow-now')({}, 'wf-1')).resolves.toBeNull()
    expect(deps.confirmElevatedWorkflowRunNow).toHaveBeenCalled()
    expect(deps.materializeWorkflowNow).not.toHaveBeenCalled()

    deps.confirmElevatedWorkflowRunNow.mockResolvedValue(true)
    deps.workflowAuthorityDigest
      .mockReturnValueOnce('a'.repeat(64))
      .mockReturnValueOnce('b'.repeat(64))
    await expect(handlerFor('run-workflow-now')({}, 'wf-1')).resolves.toBeNull()
    expect(deps.materializeWorkflowNow).not.toHaveBeenCalled()

    deps.workflowAuthorityDigest.mockReturnValue('a'.repeat(64))
    deps.currentWorkflowUnattendedElevationCapability
      .mockReturnValueOnce({
        key: `default:${'a'.repeat(64)}:old-signature`,
        level: 'default'
      })
      .mockReturnValueOnce({
        key: `full_access:${'a'.repeat(64)}:new-signature`,
        level: 'full_access'
      })
    await expect(handlerFor('run-workflow-now')({}, 'wf-1')).resolves.toBeNull()
    expect(deps.materializeWorkflowNow).not.toHaveBeenCalled()
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
