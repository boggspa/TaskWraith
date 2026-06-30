import { ipcMain } from 'electron'
import type {
  ScheduledTask,
  WorkflowDefinition,
  WorkspaceBoardCard,
  WorkspaceBoardDefinition
} from '../store/types'
import {
  type UnattendedElevationAck,
  type UnattendedElevationLevel,
  type WorkflowForElevationAck
} from '../UnattendedPostureGate'

export type ScheduledTaskSaveInput = Omit<
  ScheduledTask,
  'id' | 'createdAt' | 'updatedAt' | 'status'
> &
  Partial<Pick<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>>

export type WorkspaceBoardSaveInput = Omit<
  WorkspaceBoardDefinition,
  'id' | 'createdAt' | 'updatedAt' | 'activity'
> &
  Partial<Pick<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>

export type WorkspaceBoardCardSaveInput = Omit<
  WorkspaceBoardCard,
  'id' | 'createdAt' | 'updatedAt' | 'activity'
> &
  Partial<Pick<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>

export interface ScheduledWorkflowHandlersDeps {
  getScheduledTasks: (workspaceId?: string) => ScheduledTask[]
  saveScheduledTask: (task: ScheduledTaskSaveInput) => ScheduledTask
  updateScheduledTask: (id: string, partial: Partial<ScheduledTask>) => ScheduledTask | null
  deleteScheduledTask: (id: string) => void
  getWorkflowDefinitions: (workspaceId?: string) => WorkflowDefinition[]
  getWorkflowDefinition: (id: string) => WorkflowDefinition | null
  saveWorkflowDefinition: (workflow: Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'> & Partial<Pick<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'>>) => WorkflowDefinition
  updateWorkflowDefinition: (
    id: string,
    partial: Partial<WorkflowDefinition>
  ) => WorkflowDefinition | null
  deleteWorkflowDefinition: (id: string) => void
  getWorkspaceBoards: (workspaceId?: string) => WorkspaceBoardDefinition[]
  getWorkspaceBoardCards: (boardId?: string) => WorkspaceBoardCard[]
  saveWorkspaceBoard: (board: WorkspaceBoardSaveInput) => WorkspaceBoardDefinition
  updateWorkspaceBoard: (
    id: string,
    partial: Partial<WorkspaceBoardDefinition>
  ) => WorkspaceBoardDefinition | null
  deleteWorkspaceBoard: (id: string) => void
  saveWorkspaceBoardCard: (card: WorkspaceBoardCardSaveInput) => WorkspaceBoardCard
  updateWorkspaceBoardCard: (
    id: string,
    partial: Partial<WorkspaceBoardCard>
  ) => WorkspaceBoardCard | null
  deleteWorkspaceBoardCard: (id: string) => void
  materializeWorkflowNow: (id: string) => ScheduledTask | null
  setWorkflowUnattendedElevation: (
    id: string,
    ack: UnattendedElevationAck | undefined
  ) => WorkflowDefinition | null
  getWorkflowRunSummaries: (workflowId?: string) => Promise<unknown[]>
  getWorkflowRunEventsFiltered: (filter: Record<string, unknown>) => Promise<unknown[]>

  emitDueScheduledTasks: () => void
  scheduleNextTaskTimer: () => void
  buildUnattendedElevationAck: (
    workflow: WorkflowForElevationAck,
    level: string,
    sign: (tuple: {
      workflowId: string
      workspacePath: string
      level: UnattendedElevationLevel
      acknowledgedApprovalMode: string
    }) => string
  ) => UnattendedElevationAck | undefined
  signWorkflowUnattendedElevation: (
    workflowId: string,
    workspacePath: string,
    level: UnattendedElevationLevel,
    acknowledgedApprovalMode: string
  ) => string
  requireNonEmptyString: (value: unknown, label: string) => string

  sanitizeScheduledTaskForSave: (task: ScheduledTaskSaveInput) => ScheduledTaskSaveInput
  sanitizeScheduledTaskPatch: (id: string, partial: Partial<ScheduledTask>) => Partial<ScheduledTask> | null
  sanitizeWorkflowForSave: (
    workflow: Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'> &
      Partial<Pick<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'>>
  ) => Omit<
    WorkflowDefinition,
    'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'
  > &
    Partial<Pick<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'>>
  sanitizeWorkflowPatch: (id: string, partial: Partial<WorkflowDefinition>) => Partial<WorkflowDefinition> | null
  sanitizeWorkspaceBoardForSave: (
    board: WorkspaceBoardSaveInput
  ) => WorkspaceBoardSaveInput
  sanitizeWorkspaceBoardPatch: (
    partial: Partial<WorkspaceBoardDefinition>
  ) => Partial<WorkspaceBoardDefinition>
  sanitizeWorkspaceBoardCardForSave: (
    card: WorkspaceBoardCardSaveInput
  ) => WorkspaceBoardCardSaveInput
  sanitizeWorkspaceBoardCardPatch: (
    partial: Partial<WorkspaceBoardCard>
  ) => Partial<WorkspaceBoardCard>

  broadcastScheduledTasksChanged: () => void
  broadcastWorkflowDefinitionsChanged: () => void
  broadcastScheduledTaskDue: (task: ScheduledTask) => void
  broadcastWorkspaceBoardsChanged: () => void
  broadcastRemoteProjectionSnapshot: () => void
}

export function registerScheduledWorkflowHandlers(deps: ScheduledWorkflowHandlersDeps): void {
  ipcMain.handle('get-scheduled-tasks', (_, workspaceId?: string) =>
    deps.getScheduledTasks(workspaceId)
  )

  ipcMain.handle('save-scheduled-task', (_, task: ScheduledTaskSaveInput) => {
    const saved = deps.saveScheduledTask(deps.sanitizeScheduledTaskForSave(task))
    deps.broadcastScheduledTasksChanged()
    deps.broadcastWorkflowDefinitionsChanged()
    deps.emitDueScheduledTasks()
    return saved
  })

  ipcMain.handle('update-scheduled-task', (_, id: string, partial: Partial<ScheduledTask>) => {
    const sanitized = deps.sanitizeScheduledTaskPatch(id, partial)
    if (!sanitized) return null
    const updated = deps.updateScheduledTask(id, sanitized)
    deps.broadcastScheduledTasksChanged()
    deps.broadcastWorkflowDefinitionsChanged()
    deps.scheduleNextTaskTimer()
    return updated
  })

  ipcMain.handle('delete-scheduled-task', (_, id: string) => {
    deps.deleteScheduledTask(id)
    deps.broadcastScheduledTasksChanged()
    deps.broadcastWorkflowDefinitionsChanged()
    deps.scheduleNextTaskTimer()
  })

  ipcMain.handle('get-workflow-definitions', (_, workspaceId?: string) =>
    deps.getWorkflowDefinitions(workspaceId)
  )

  ipcMain.handle('save-workflow-definition', (_, workflow: Parameters<ScheduledWorkflowHandlersDeps['saveWorkflowDefinition']>[0]) => {
    const saved = deps.saveWorkflowDefinition(deps.sanitizeWorkflowForSave(workflow))
    deps.broadcastWorkflowDefinitionsChanged()
    deps.broadcastRemoteProjectionSnapshot()
    deps.emitDueScheduledTasks()
    return saved
  })

  ipcMain.handle('update-workflow-definition', (_, id: string, partial: Partial<WorkflowDefinition>) => {
    const sanitized = deps.sanitizeWorkflowPatch(id, partial)
    if (!sanitized) return null
    const updated = deps.updateWorkflowDefinition(id, sanitized)
    deps.broadcastWorkflowDefinitionsChanged()
    deps.broadcastRemoteProjectionSnapshot()
    deps.scheduleNextTaskTimer()
    return updated
  })

  ipcMain.handle('delete-workflow-definition', (_, id: string) => {
    deps.deleteWorkflowDefinition(id)
    deps.broadcastWorkflowDefinitionsChanged()
    deps.broadcastScheduledTasksChanged()
    deps.broadcastRemoteProjectionSnapshot()
    deps.scheduleNextTaskTimer()
  })

  ipcMain.handle('get-workspace-boards', (_, workspaceId?: string) =>
    deps.getWorkspaceBoards(workspaceId)
  )

  ipcMain.handle('save-workspace-board', (_, board: WorkspaceBoardSaveInput) => {
    const saved = deps.saveWorkspaceBoard(deps.sanitizeWorkspaceBoardForSave(board))
    deps.broadcastWorkspaceBoardsChanged()
    return saved
  })

  ipcMain.handle('update-workspace-board', (_, id: string, partial: Partial<WorkspaceBoardDefinition>) => {
    const updated = deps.updateWorkspaceBoard(id, deps.sanitizeWorkspaceBoardPatch(partial))
    deps.broadcastWorkspaceBoardsChanged()
    return updated
  })

  ipcMain.handle('delete-workspace-board', (_, id: string) => {
    deps.deleteWorkspaceBoard(id)
    deps.broadcastWorkspaceBoardsChanged()
  })

  ipcMain.handle('get-workspace-board-cards', (_, boardId?: string) =>
    deps.getWorkspaceBoardCards(boardId)
  )

  ipcMain.handle('save-workspace-board-card', (_, card: WorkspaceBoardCardSaveInput) => {
    const saved = deps.saveWorkspaceBoardCard(deps.sanitizeWorkspaceBoardCardForSave(card))
    deps.broadcastWorkspaceBoardsChanged()
    return saved
  })

  ipcMain.handle('update-workspace-board-card', (_, id: string, partial: Partial<WorkspaceBoardCard>) => {
    const updated = deps.updateWorkspaceBoardCard(id, deps.sanitizeWorkspaceBoardCardPatch(partial))
    deps.broadcastWorkspaceBoardsChanged()
    return updated
  })

  ipcMain.handle('delete-workspace-board-card', (_, id: string) => {
    deps.deleteWorkspaceBoardCard(id)
    deps.broadcastWorkspaceBoardsChanged()
  })

  ipcMain.handle('run-workflow-now', (_, id: string) => {
    const task = deps.materializeWorkflowNow(id)
    if (task) {
      deps.broadcastWorkflowDefinitionsChanged()
      deps.broadcastScheduledTasksChanged()
      deps.broadcastScheduledTaskDue(task)
      deps.broadcastRemoteProjectionSnapshot()
    }
    deps.scheduleNextTaskTimer()
    return task
  })

  ipcMain.handle('set-workflow-unattended-elevation', (_, id: string, level: string) => {
    const wf = deps.getWorkflowDefinition(deps.requireNonEmptyString(id, 'Workflow id'))
    if (!wf) return null
    const ack = deps.buildUnattendedElevationAck(wf as WorkflowForElevationAck, level, (tuple) =>
      deps.signWorkflowUnattendedElevation(
        wf.id,
        wf.workspacePath,
        tuple.level,
        tuple.acknowledgedApprovalMode
      )
    )
    const updated = deps.setWorkflowUnattendedElevation(id, ack)
    deps.broadcastWorkflowDefinitionsChanged()
    deps.broadcastRemoteProjectionSnapshot()
    return updated
  })

  ipcMain.handle('get-workflow-run-summaries', (_, workflowId?: string) =>
    deps.getWorkflowRunSummaries(typeof workflowId === 'string' ? workflowId : undefined)
  )

  ipcMain.handle('get-workflow-run-events', (_, filter: Record<string, unknown> = {}) =>
    deps.getWorkflowRunEventsFiltered(filter)
  )
}
