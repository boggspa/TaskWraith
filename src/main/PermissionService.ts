import { randomUUID } from 'crypto'
import { resolve } from 'path'
import type {
  AgentApprovalAction,
  AgenticServiceId,
  AgenticServicePolicy,
  AppSettings,
  ApprovalLedgerRequestInput,
  ProviderId
} from './store/types'
import type { RunManager } from './RunManager'
import { resolveAgenticPermission, type AgenticPermissionDecision } from './AgenticPolicy'
import { AppStore } from './store'

export interface PermissionServiceOptions {
  runManager: RunManager<any>
  sessionGrants: Set<string>
}

export interface AgenticPermissionResolution {
  decision: AgenticPermissionDecision
  policy: AgenticServicePolicy
  workspaceGrantAllowed: boolean
  sessionGrantAllowed: boolean
}

export interface ApprovalDecisionInput {
  provider: ProviderId
  workspacePath?: string
  service?: AgenticServiceId
  runId?: string
  action: AgentApprovalAction
}

export class PermissionService {
  constructor(private readonly options: PermissionServiceOptions) {}

  getServicePolicy(
    service: AgenticServiceId,
    settings: AppSettings = AppStore.getSettings()
  ): AgenticServicePolicy {
    return settings.agenticServices?.[service] || 'ask'
  }

  hasWorkspaceGrant(
    settings: AppSettings,
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId
  ): boolean {
    if (!workspacePath) return false
    const normalizedWorkspace = resolve(workspacePath)
    return (settings.agenticWorkspaceGrants || []).some((grant) => {
      if (
        !grant ||
        grant.provider !== provider ||
        grant.service !== service ||
        !grant.workspacePath
      )
        return false
      return resolve(grant.workspacePath) === normalizedWorkspace
    })
  }

  upsertWorkspaceGrant(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId
  ): void {
    if (!workspacePath) return
    const settings = AppStore.getSettings()
    const normalizedWorkspace = resolve(workspacePath)
    const now = new Date().toISOString()
    const grants = (settings.agenticWorkspaceGrants || []).filter((grant) => {
      if (
        !grant ||
        grant.provider !== provider ||
        grant.service !== service ||
        !grant.workspacePath
      )
        return true
      return resolve(grant.workspacePath) !== normalizedWorkspace
    })
    grants.push({
      id: randomUUID(),
      provider,
      service,
      workspacePath: normalizedWorkspace,
      createdAt: now,
      updatedAt: now,
      expiresOn: 'workspace_revocation'
    })
    AppStore.updateSettings({ agenticWorkspaceGrants: grants })
  }

  removeWorkspaceGrant(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId
  ): void {
    if (!workspacePath) return
    const settings = AppStore.getSettings()
    const normalizedWorkspace = resolve(workspacePath)
    const grants = (settings.agenticWorkspaceGrants || []).filter((grant) => {
      if (
        !grant ||
        grant.provider !== provider ||
        grant.service !== service ||
        !grant.workspacePath
      )
        return true
      return resolve(grant.workspacePath) !== normalizedWorkspace
    })
    AppStore.updateSettings({ agenticWorkspaceGrants: grants })
  }

  hasSessionGrant(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId,
    runId?: string
  ): boolean {
    if (runId && this.options.runManager.hasSessionGrant(runId, service)) return true
    return this.options.sessionGrants.has(this.sessionGrantKey(provider, workspacePath, service))
  }

  addSessionGrant(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId,
    runId?: string
  ): void {
    if (runId && this.options.runManager.get(runId)) {
      this.options.runManager.addSessionGrant(runId, service)
      return
    }
    this.options.sessionGrants.add(this.sessionGrantKey(provider, workspacePath, service))
  }

  resolvePermission(
    provider: ProviderId,
    service: AgenticServiceId,
    workspacePath: string | undefined,
    runId?: string,
    settings: AppSettings = AppStore.getSettings()
  ): AgenticPermissionResolution {
    const policy = this.getServicePolicy(service, settings)
    // canvasEval (arbitrary eval = RCE) is SIGNED-ELEVATED: non-grantable, so no
    // session/workspace grant can ever promote it to an automatic allow — every
    // eval re-prompts. This is the central half of that guarantee (both the
    // Gemini/Claude gate and the Codex native gate route through here); the YOLO
    // bypasses are blocked separately, and read-only denies it via the preset.
    // mediaRecording (future mic/camera capture) is non-grantable for the same
    // reason: a session/workspace grant must never promote capture above its
    // default-deny. (EffectiveRunPermissions.workspaceGrantServiceIdsFor drops its
    // workspace grants; this is the session/resolve half.)
    const grantable = service !== 'canvasEval' && service !== 'mediaRecording'
    const workspaceGrantAllowed =
      grantable &&
      policy !== 'deny' &&
      this.hasWorkspaceGrant(settings, provider, workspacePath, service)
    const sessionGrantAllowed =
      grantable && this.hasSessionGrant(provider, workspacePath, service, runId)
    const decision =
      policy === 'deny'
        ? 'deny'
        : workspaceGrantAllowed || sessionGrantAllowed
          ? 'allow'
          : resolveAgenticPermission(policy, false, false)
    return {
      policy,
      workspaceGrantAllowed,
      sessionGrantAllowed,
      decision
    }
  }

  recordApprovalRequest(input: ApprovalLedgerRequestInput): void {
    AppStore.recordApprovalRequest(input)
  }

  resolveApprovalResponse(
    approvalId: string,
    action: AgentApprovalAction,
    decisionSource: 'user' | 'system' = 'user',
    extraMetadata: Record<string, unknown> = {}
  ): void {
    AppStore.resolveApprovalRequest(approvalId, action, decisionSource, extraMetadata)
  }

  applyApprovalDecision(input: ApprovalDecisionInput): boolean {
    if (input.action === 'acceptForWorkspace' && input.service) {
      this.upsertWorkspaceGrant(input.provider, input.workspacePath, input.service)
    }
    if (input.action === 'acceptForSession' && input.service) {
      this.addSessionGrant(input.provider, input.workspacePath, input.service, input.runId)
    }
    return this.isApprovedAction(input.action)
  }

  isApprovedAction(action: AgentApprovalAction): boolean {
    return (
      action === 'accept' ||
      action === 'acceptForSession' ||
      action === 'acceptForWorkspace' ||
      // Slice 4 of the external-path-redesign arc. The two external-
      // path grant actions resolve the underlying agent tool call as
      // an approval (the agent gets to proceed); the *side effect* of
      // persisting the grant is layered on top by the resolver in
      // ApprovalService. `declineExternalPath` resolves as a denial.
      action === 'grantExternalPathRead' ||
      action === 'grantExternalPathEdit'
    )
  }

  expireRunScopedApprovals(session: {
    runId: string
    provider: ProviderId
    workspacePath?: string
    status?: string
  }): void {
    if (
      session.status !== 'completed' &&
      session.status !== 'failed' &&
      session.status !== 'cancelled'
    )
      return
    AppStore.expireApprovalLedgerScope({
      runId: session.runId,
      provider: session.provider,
      workspacePath: session.workspacePath,
      scopes: ['run', 'session'],
      reason: `run_${session.status}`
    })
  }

  private sessionGrantKey(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId
  ): string {
    return `${provider}:${service}:${workspacePath ? resolve(workspacePath) : 'global'}`
  }
}
