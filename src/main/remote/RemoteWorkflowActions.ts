import type {
  BridgeWorkflowRunNowAction,
  BridgeWorkflowSetEnabledAction
} from '../BridgeActionPayload'
import type { BridgeActionDispatchContext } from '../BridgeActionExecutor'
import type { ChatRecord, ScheduledTask, WorkflowDefinition } from '../store/types'
import {
  resolveUnattendedApprovalMode,
  type UnattendedElevationAck
} from '../UnattendedPostureGate'
import { isTerminalWorkflowExecutionStatus } from '../workflows/WorkflowScheduler'

export interface RemoteWorkflowAuthorization {
  workspaceId: string
  provider: string
  approvalMode: string
}

export type RemoteWorkflowAuthorizationResult =
  | { allowed: true; authorization: RemoteWorkflowAuthorization }
  | { allowed: false; reason: string }

export interface RemoteWorkflowActionsDependencies {
  getWorkflowDefinition: (id: string) => WorkflowDefinition | null
  resolveAuthorization: (
    action: BridgeWorkflowSetEnabledAction | BridgeWorkflowRunNowAction
  ) => RemoteWorkflowAuthorizationResult
  updateWorkflowDefinition: (
    id: string,
    partial: Partial<WorkflowDefinition>
  ) => WorkflowDefinition | null
  materializeWorkflowNow: (id: string, nowMs: number) => ScheduledTask | null
  ensureScheduledTaskSignedPosture: (task: ScheduledTask) => ScheduledTask
  broadcastWorkflowDefinitionsChanged: () => void
  broadcastScheduledTasksChanged: () => void
  broadcastRemoteProjectionSnapshot: () => void
  emitDueScheduledTasks: () => void
  scheduleNextTaskTimer: () => void
  now?: () => number
  runNowCooldownMs?: number
}

export interface RemoteWorkflowSetEnabledResult {
  ok: boolean
  enabled?: boolean
  reason?: string
}

export interface RemoteWorkflowRunNowResult {
  ok: boolean
  scheduledTaskId?: string
  workflowExecutionId?: string
  reason?: string
}

const DEFAULT_RUN_NOW_COOLDOWN_MS = 3_000

export function isRemoteWorkflowRunnableChat(options: {
  chat: Pick<ChatRecord, 'archived' | 'scope' | 'workspaceId' | 'workspacePath'> | null
  workspaceId: string
  workspacePath: string
  canonicalWorkspaceId: (workspaceId: string | null | undefined) => string | null
  canonicalPath: (workspacePath: string) => string
}): boolean {
  const { chat } = options
  return Boolean(
    chat &&
      !chat.archived &&
      chat.scope === 'workspace' &&
      options.canonicalWorkspaceId(chat.workspaceId) === options.workspaceId &&
      chat.workspacePath &&
      options.canonicalPath(chat.workspacePath) === options.canonicalPath(options.workspacePath)
  )
}

export function remoteWorkflowApprovalMode(
  action: BridgeWorkflowSetEnabledAction | BridgeWorkflowRunNowAction,
  templateApprovalMode: string,
  verifiedElevation?: UnattendedElevationAck
): string {
  const canStartWork =
    action.kind === 'workflowRunNow' ||
    (action.kind === 'workflowSetEnabled' && action.enabled)
  return canStartWork
    ? resolveUnattendedApprovalMode(verifiedElevation, templateApprovalMode)
    : 'plan'
}

export class RemoteWorkflowActions {
  private readonly now: () => number
  private readonly runNowCooldownMs: number
  private readonly lastRunNowAcceptedAt = new Map<string, number>()

  constructor(private readonly deps: RemoteWorkflowActionsDependencies) {
    this.now = deps.now ?? (() => Date.now())
    this.runNowCooldownMs = Math.max(0, deps.runNowCooldownMs ?? DEFAULT_RUN_NOW_COOLDOWN_MS)
  }

  async setEnabled(
    action: BridgeWorkflowSetEnabledAction,
    ctx: BridgeActionDispatchContext
  ): Promise<RemoteWorkflowSetEnabledResult> {
    const authorizationError = this.revalidate(action, ctx)
    if (authorizationError) return { ok: false, reason: authorizationError }
    const current = this.deps.getWorkflowDefinition(action.workflowId)
    if (!current) return { ok: false, reason: 'Workflow not found' }

    if (current.enabled === action.enabled) {
      return { ok: true, enabled: current.enabled }
    }

    const finalAuthorizationError = this.revalidate(action, ctx)
    if (finalAuthorizationError) return { ok: false, reason: finalAuthorizationError }
    const updated = this.deps.updateWorkflowDefinition(action.workflowId, {
      enabled: action.enabled
    })
    if (!updated) return { ok: false, reason: 'Workflow no longer exists' }

    this.deps.broadcastWorkflowDefinitionsChanged()
    this.deps.broadcastRemoteProjectionSnapshot()
    this.deps.scheduleNextTaskTimer()
    return { ok: true, enabled: updated.enabled }
  }

  async runNow(
    action: BridgeWorkflowRunNowAction,
    ctx: BridgeActionDispatchContext
  ): Promise<RemoteWorkflowRunNowResult> {
    const authorizationError = this.revalidate(action, ctx)
    if (authorizationError) return { ok: false, reason: authorizationError }
    const current = this.deps.getWorkflowDefinition(action.workflowId)
    if (!current) return { ok: false, reason: 'Workflow not found' }

    const active = current.activeExecutionId
      ? current.history.find((entry) => entry.id === current.activeExecutionId)
      : undefined
    if (active && !isTerminalWorkflowExecutionStatus(active.status)) {
      return { ok: false, reason: 'Workflow already has an active execution' }
    }

    const now = this.now()
    const lastAccepted = this.lastRunNowAcceptedAt.get(action.workflowId)
    if (lastAccepted !== undefined && now - lastAccepted < this.runNowCooldownMs) {
      return { ok: false, reason: 'Workflow run-now is temporarily rate limited' }
    }
    const finalAuthorizationError = this.revalidate(action, ctx)
    if (finalAuthorizationError) return { ok: false, reason: finalAuthorizationError }
    // Consume the cooldown before materialization so malformed or budget-blocked
    // workflows cannot be hammered with fresh action ids.
    this.lastRunNowAcceptedAt.set(action.workflowId, now)

    const task = this.deps.materializeWorkflowNow(action.workflowId, now)
    if (!task) {
      const refreshed = this.deps.getWorkflowDefinition(action.workflowId)
      // Materialization failures can update workflow history/error/nextRunAt;
      // project those changes even though no due task was created.
      this.deps.broadcastWorkflowDefinitionsChanged()
      this.deps.broadcastRemoteProjectionSnapshot()
      this.deps.scheduleNextTaskTimer()
      return {
        ok: false,
        reason: refreshed?.lastError || 'Workflow could not be materialized'
      }
    }
    const signedTask = this.deps.ensureScheduledTaskSignedPosture(task)

    this.deps.broadcastWorkflowDefinitionsChanged()
    this.deps.broadcastScheduledTasksChanged()
    this.deps.broadcastRemoteProjectionSnapshot()
    // This is the headless-safe dispatch path: it broadcasts to a live renderer
    // or claims the due task in main when no renderer is available.
    this.deps.emitDueScheduledTasks()
    this.deps.scheduleNextTaskTimer()
    return {
      ok: true,
      scheduledTaskId: signedTask.id,
      workflowExecutionId: signedTask.workflowExecutionId
    }
  }

  private revalidate(
    action: BridgeWorkflowSetEnabledAction | BridgeWorkflowRunNowAction,
    ctx: BridgeActionDispatchContext
  ): string | null {
    const result = this.deps.resolveAuthorization(action)
    if (!result.allowed) return result.reason
    const expected = result.authorization
    if (
      ctx.workspaceId !== expected.workspaceId ||
      ctx.provider !== expected.provider ||
      ctx.approvalMode !== expected.approvalMode
    ) {
      return 'Workflow authorization changed underneath this action; refresh and retry'
    }
    return null
  }
}
