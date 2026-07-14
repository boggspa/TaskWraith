import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  ScheduledTask,
  WorkflowDefinition,
  CapabilityLedgerSnapshot,
  EvidencePackRecord,
  RepoConventionIndexSnapshot,
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
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
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
  getEvidencePacks: (workspaceId?: string) => EvidencePackRecord[]
  saveEvidencePack: (pack: Partial<EvidencePackRecord>) => EvidencePackRecord
  deleteEvidencePack: (id: string) => void
  getCapabilityLedgerSnapshot: (workspaceId?: string) => CapabilityLedgerSnapshot
  getRepoConventionIndexes: (workspaceId?: string) => RepoConventionIndexSnapshot[]
  saveRepoConventionIndex: (
    snapshot: Partial<RepoConventionIndexSnapshot>
  ) => RepoConventionIndexSnapshot
  materializeWorkflowNow: (id: string) => ScheduledTask | null
  setWorkflowUnattendedElevation: (
    id: string,
    ack: UnattendedElevationAck | undefined
  ) => WorkflowDefinition | null
  getWorkflowRunSummaries: (workflowId?: string) => Promise<unknown[]>
  getWorkflowRunEventsFiltered: (filter: Record<string, unknown>) => Promise<unknown[]>
  getAgentStatsSummaries: (agentIds: string[]) => Promise<unknown[]>

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
  broadcastEvidencePacksChanged: () => void
  broadcastRemoteProjectionSnapshot: () => void
}

function requestThrottledRemoteProjectionAfterIpcMutation(
  deps: ScheduledWorkflowHandlersDeps
): void {
  deps.broadcastRemoteProjectionSnapshot()
}

export function registerScheduledWorkflowHandlers(deps: ScheduledWorkflowHandlersDeps): void {
  ipcMain.handle('get-scheduled-tasks', (event, workspaceId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getScheduledTasks(workspaceId)
  })

  ipcMain.handle('save-scheduled-task', (event, task: ScheduledTaskSaveInput) => {
    deps.assertMainRendererSender(event)
    const saved = deps.saveScheduledTask(deps.sanitizeScheduledTaskForSave(task))
    deps.broadcastScheduledTasksChanged()
    deps.broadcastWorkflowDefinitionsChanged()
    deps.emitDueScheduledTasks()
    return saved
  })

  ipcMain.handle('update-scheduled-task', (event, id: string, partial: Partial<ScheduledTask>) => {
    deps.assertMainRendererSender(event)
    const sanitized = deps.sanitizeScheduledTaskPatch(id, partial)
    if (!sanitized) return null
    const updated = deps.updateScheduledTask(id, sanitized)
    deps.broadcastScheduledTasksChanged()
    deps.broadcastWorkflowDefinitionsChanged()
    deps.scheduleNextTaskTimer()
    return updated
  })

  ipcMain.handle('delete-scheduled-task', (event, id: string) => {
    deps.assertMainRendererSender(event)
    deps.deleteScheduledTask(id)
    deps.broadcastScheduledTasksChanged()
    deps.broadcastWorkflowDefinitionsChanged()
    deps.scheduleNextTaskTimer()
  })

  ipcMain.handle('get-workflow-definitions', (event, workspaceId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getWorkflowDefinitions(workspaceId)
  })

  ipcMain.handle('save-workflow-definition', (event, workflow: Parameters<ScheduledWorkflowHandlersDeps['saveWorkflowDefinition']>[0]) => {
    deps.assertMainRendererSender(event)
    const saved = deps.saveWorkflowDefinition(deps.sanitizeWorkflowForSave(workflow))
    deps.broadcastWorkflowDefinitionsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    deps.emitDueScheduledTasks()
    return saved
  })

  ipcMain.handle('update-workflow-definition', (event, id: string, partial: Partial<WorkflowDefinition>) => {
    deps.assertMainRendererSender(event)
    const sanitized = deps.sanitizeWorkflowPatch(id, partial)
    if (!sanitized) return null
    const updated = deps.updateWorkflowDefinition(id, sanitized)
    deps.broadcastWorkflowDefinitionsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    deps.scheduleNextTaskTimer()
    return updated
  })

  ipcMain.handle('delete-workflow-definition', (event, id: string) => {
    deps.assertMainRendererSender(event)
    deps.deleteWorkflowDefinition(id)
    deps.broadcastWorkflowDefinitionsChanged()
    deps.broadcastScheduledTasksChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    deps.scheduleNextTaskTimer()
  })

  ipcMain.handle('get-workspace-boards', (event, workspaceId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getWorkspaceBoards(workspaceId)
  })

  ipcMain.handle('save-workspace-board', (event, board: WorkspaceBoardSaveInput) => {
    deps.assertMainRendererSender(event)
    const saved = deps.saveWorkspaceBoard(deps.sanitizeWorkspaceBoardForSave(board))
    deps.broadcastWorkspaceBoardsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    return saved
  })

  ipcMain.handle('update-workspace-board', (event, id: string, partial: Partial<WorkspaceBoardDefinition>) => {
    deps.assertMainRendererSender(event)
    const updated = deps.updateWorkspaceBoard(id, deps.sanitizeWorkspaceBoardPatch(partial))
    deps.broadcastWorkspaceBoardsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    return updated
  })

  ipcMain.handle('delete-workspace-board', (event, id: string) => {
    deps.assertMainRendererSender(event)
    deps.deleteWorkspaceBoard(id)
    deps.broadcastWorkspaceBoardsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
  })

  ipcMain.handle('get-workspace-board-cards', (event, boardId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getWorkspaceBoardCards(boardId)
  })

  ipcMain.handle('save-workspace-board-card', (event, card: WorkspaceBoardCardSaveInput) => {
    deps.assertMainRendererSender(event)
    const saved = deps.saveWorkspaceBoardCard(deps.sanitizeWorkspaceBoardCardForSave(card))
    deps.broadcastWorkspaceBoardsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    return saved
  })

  ipcMain.handle('update-workspace-board-card', (event, id: string, partial: Partial<WorkspaceBoardCard>) => {
    deps.assertMainRendererSender(event)
    const updated = deps.updateWorkspaceBoardCard(id, deps.sanitizeWorkspaceBoardCardPatch(partial))
    deps.broadcastWorkspaceBoardsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    return updated
  })

  ipcMain.handle('delete-workspace-board-card', (event, id: string) => {
    deps.assertMainRendererSender(event)
    deps.deleteWorkspaceBoardCard(id)
    deps.broadcastWorkspaceBoardsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
  })

  ipcMain.handle('get-evidence-packs', (event, workspaceId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getEvidencePacks(workspaceId)
  })

  ipcMain.handle('save-evidence-pack', (event, pack: Partial<EvidencePackRecord>) => {
    deps.assertMainRendererSender(event)
    const saved = deps.saveEvidencePack(pack)
    deps.broadcastEvidencePacksChanged()
    return saved
  })

  ipcMain.handle('delete-evidence-pack', (event, id: string) => {
    deps.assertMainRendererSender(event)
    deps.deleteEvidencePack(id)
    deps.broadcastEvidencePacksChanged()
  })

  ipcMain.handle('get-capability-ledger-snapshot', (event, workspaceId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getCapabilityLedgerSnapshot(workspaceId)
  })

  ipcMain.handle('get-repo-convention-indexes', (event, workspaceId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getRepoConventionIndexes(workspaceId)
  })

  ipcMain.handle('save-repo-convention-index', (event, snapshot: Partial<RepoConventionIndexSnapshot>) => {
    deps.assertMainRendererSender(event)
    const saved = deps.saveRepoConventionIndex(snapshot)
    deps.broadcastEvidencePacksChanged()
    return saved
  })

  ipcMain.handle('run-workflow-now', (event, id: string) => {
    deps.assertMainRendererSender(event)
    const task = deps.materializeWorkflowNow(id)
    if (task) {
      deps.broadcastWorkflowDefinitionsChanged()
      deps.broadcastScheduledTasksChanged()
      deps.broadcastScheduledTaskDue(task)
      requestThrottledRemoteProjectionAfterIpcMutation(deps)
    }
    deps.scheduleNextTaskTimer()
    return task
  })

  ipcMain.handle('set-workflow-unattended-elevation', (event, id: string, level: string) => {
    deps.assertMainRendererSender(event)
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
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    return updated
  })

  ipcMain.handle('get-workflow-run-summaries', (event, workflowId?: string) => {
    deps.assertMainRendererSender(event)
    return deps.getWorkflowRunSummaries(typeof workflowId === 'string' ? workflowId : undefined)
  })

  ipcMain.handle('get-workflow-run-events', (event, filter: Record<string, unknown> = {}) => {
    deps.assertMainRendererSender(event)
    return deps.getWorkflowRunEventsFiltered(filter)
  })

  ipcMain.handle('get-agent-stats-summaries', (event, agentIds: unknown) => {
    deps.assertMainRendererSender(event)
    return deps.getAgentStatsSummaries(
      Array.isArray(agentIds) ? agentIds.filter((id): id is string => typeof id === 'string') : []
    )
  })
}
