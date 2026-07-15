import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  ScheduledTask,
  ScheduledTaskCreateInput,
  ScheduledTaskLifecycleUpdate,
  WorkflowDefinitionCreateInput,
  WorkflowDefinitionRendererUpdate,
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

export type ScheduledTaskSaveInput = ScheduledTaskCreateInput
type SanitizedRendererWorkflowUpdate = WorkflowDefinitionRendererUpdate & {
  unattendedElevation?: undefined
}

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
  assertRendererChatScope: (event: IpcMainInvokeEvent, chatId: string) => void
  getScheduledTasks: (workspaceId?: string) => ScheduledTask[]
  saveScheduledTask: (task: ScheduledTaskSaveInput) => ScheduledTask
  updateScheduledTask: (id: string, partial: Partial<ScheduledTask>) => ScheduledTask | null
  cancelScheduledTask: (id: string, reason?: string) => Promise<ScheduledTask | null>
  deleteScheduledTask: (id: string) => void
  getWorkflowDefinitions: (workspaceId?: string) => WorkflowDefinition[]
  getWorkflowDefinition: (id: string) => WorkflowDefinition | null
  saveWorkflowDefinition: (workflow: WorkflowDefinitionCreateInput) => WorkflowDefinition
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
  workflowAuthorityDigest: (workflow: WorkflowDefinition) => string
  currentWorkflowUnattendedElevationCapability: (
    workflow: WorkflowDefinition
  ) => {
    key: string
    level: Exclude<UnattendedElevationLevel, 'safe'>
  } | null
  workflowTargetIsCurrent: (workflow: WorkflowDefinition) => boolean
  confirmWorkflowUnattendedElevation: (
    event: IpcMainInvokeEvent,
    workflow: WorkflowDefinition,
    level: Exclude<UnattendedElevationLevel, 'safe'>
  ) => Promise<boolean>
  confirmElevatedWorkflowRunNow: (
    event: IpcMainInvokeEvent,
    workflow: WorkflowDefinition,
    level: Exclude<UnattendedElevationLevel, 'safe'>
  ) => Promise<boolean>
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
    authorityDigest: string,
    sign: (tuple: {
      workflowId: string
      workspacePath: string
      level: UnattendedElevationLevel
      acknowledgedApprovalMode: string
      authorityDigest: string
    }) => string
  ) => UnattendedElevationAck | undefined
  signWorkflowUnattendedElevation: (
    workflowId: string,
    workspacePath: string,
    level: UnattendedElevationLevel,
    acknowledgedApprovalMode: string,
    authorityDigest: string
  ) => string
  requireNonEmptyString: (value: unknown, label: string) => string

  sanitizeScheduledTaskForSave: (task: ScheduledTaskSaveInput) => ScheduledTaskSaveInput
  sanitizeScheduledTaskPatch: (
    id: string,
    partial: ScheduledTaskLifecycleUpdate
  ) => ScheduledTaskLifecycleUpdate | null
  sanitizeWorkflowForSave: (
    workflow: WorkflowDefinitionCreateInput
  ) => WorkflowDefinitionCreateInput
  sanitizeWorkflowPatch: (
    id: string,
    partial: WorkflowDefinitionRendererUpdate
  ) => SanitizedRendererWorkflowUpdate | null
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

  ipcMain.handle('update-scheduled-task', (event, id: string, partial: ScheduledTaskLifecycleUpdate) => {
    deps.assertMainRendererSender(event)
    const sanitized = deps.sanitizeScheduledTaskPatch(id, partial)
    if (!sanitized) return null
    const updated = deps.updateScheduledTask(id, sanitized)
    deps.broadcastScheduledTasksChanged()
    deps.broadcastWorkflowDefinitionsChanged()
    deps.scheduleNextTaskTimer()
    return updated
  })

  ipcMain.handle('cancel-scheduled-task', async (event, id: string, reason?: string) => {
    const taskId = deps.requireNonEmptyString(id, 'Scheduled task id')
    const task = deps.getScheduledTasks().find((candidate) => candidate.id === taskId)
    if (!task) {
      // Do not let a secondary renderer use missing ids as a global task oracle.
      deps.assertMainRendererSender(event)
      return null
    }
    deps.assertRendererChatScope(event, task.chatId)
    return deps.cancelScheduledTask(taskId, reason?.trim() || undefined)
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

  ipcMain.handle('save-workflow-definition', (event, workflow: WorkflowDefinitionCreateInput) => {
    deps.assertMainRendererSender(event)
    const saved = deps.saveWorkflowDefinition(deps.sanitizeWorkflowForSave(workflow))
    deps.broadcastWorkflowDefinitionsChanged()
    requestThrottledRemoteProjectionAfterIpcMutation(deps)
    deps.emitDueScheduledTasks()
    return saved
  })

  ipcMain.handle('update-workflow-definition', (event, id: string, partial: WorkflowDefinitionRendererUpdate) => {
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

  ipcMain.handle('run-workflow-now', async (event, id: string) => {
    deps.assertMainRendererSender(event)
    const workflowId = deps.requireNonEmptyString(id, 'Workflow id')
    const workflow = deps.getWorkflowDefinition(workflowId)
    if (!workflow) return null
    const capability = deps.currentWorkflowUnattendedElevationCapability(workflow)
    if (capability) {
      if (!deps.workflowTargetIsCurrent(workflow)) return null
      const authorityDigest = deps.workflowAuthorityDigest(workflow)
      const confirmed = await deps.confirmElevatedWorkflowRunNow(
        event,
        workflow,
        capability.level
      )
      if (!confirmed) return null
      const current = deps.getWorkflowDefinition(workflowId)
      const currentCapability = current
        ? deps.currentWorkflowUnattendedElevationCapability(current)
        : null
      if (
        !current ||
        deps.workflowAuthorityDigest(current) !== authorityDigest ||
        !deps.workflowTargetIsCurrent(current) ||
        currentCapability?.key !== capability.key
      ) {
        return null
      }
    }
    const task = deps.materializeWorkflowNow(workflowId)
    if (task) {
      deps.broadcastWorkflowDefinitionsChanged()
      deps.broadcastScheduledTasksChanged()
      requestThrottledRemoteProjectionAfterIpcMutation(deps)
      deps.emitDueScheduledTasks()
    } else {
      deps.scheduleNextTaskTimer()
    }
    return task
  })

  ipcMain.handle('set-workflow-unattended-elevation', async (event, id: string, level: string) => {
    deps.assertMainRendererSender(event)
    const workflowId = deps.requireNonEmptyString(id, 'Workflow id')
    const wf = deps.getWorkflowDefinition(workflowId)
    if (!wf) return null
    if (level === 'safe') {
      const updated = deps.setWorkflowUnattendedElevation(workflowId, undefined)
      deps.broadcastWorkflowDefinitionsChanged()
      requestThrottledRemoteProjectionAfterIpcMutation(deps)
      return updated
    }
    if (level !== 'default' && level !== 'full_access') {
      throw new Error('Workflow unattended elevation level is invalid.')
    }
    if (!deps.workflowTargetIsCurrent(wf)) return wf
    const authorityDigest = deps.workflowAuthorityDigest(wf)
    const priorCapabilityKey =
      deps.currentWorkflowUnattendedElevationCapability(wf)?.key ?? null
    const confirmed = await deps.confirmWorkflowUnattendedElevation(event, wf, level)
    if (!confirmed) return wf
    const current = deps.getWorkflowDefinition(workflowId)
    if (
      !current ||
      deps.workflowAuthorityDigest(current) !== authorityDigest ||
      !deps.workflowTargetIsCurrent(current) ||
      (deps.currentWorkflowUnattendedElevationCapability(current)?.key ?? null) !==
        priorCapabilityKey
    ) {
      return current
    }
    const ack = deps.buildUnattendedElevationAck(
      current as WorkflowForElevationAck,
      level,
      authorityDigest,
      (tuple) =>
        deps.signWorkflowUnattendedElevation(
          current.id,
          current.workspacePath,
          tuple.level,
          tuple.acknowledgedApprovalMode,
          tuple.authorityDigest
        )
    )
    if (!ack) return current
    const updated = deps.setWorkflowUnattendedElevation(workflowId, ack)
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
