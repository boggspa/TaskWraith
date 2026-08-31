import { randomUUID } from 'crypto'
import { resolve } from 'path'
import type {
  AgentApprovalAction,
  AgenticServiceId,
  AgenticServicePolicy,
  AppSettings,
  ApprovalLedgerRequestInput,
  ApprovalLedgerRecord,
  ProviderId
} from './store/types'
import type { RunManager } from './RunManager'
import { resolveAgenticPermission, type AgenticPermissionDecision } from './AgenticPolicy'
import { AppStore } from './store'

export interface PermissionServiceOptions {
  runManager: RunManager<any>
  sessionGrants: Set<string>
  getSettings?: () => AppSettings
  updateSettings?: (partial: Partial<AppSettings>) => void
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
  /**
   * The surface the user was actually shown when they approved (for canvas
   * tools, the canvasId). A surface-scoped grant is bound to this and to nothing
   * else. Absent for services that have no surface.
   */
  surfaceId?: string
}

/**
 * canvas_eval is RCE and re-prompts per call by default. The lead-dev-authorised
 * exception is a dedicated, per-canvas approval window: after the first human
 * accept on a given canvasId, further canvas_eval on THAT canvas is auto-approved
 * for this long before the human is asked again. It is deliberately NOT wired into
 * the generic session/workspace grant machinery (isNonGrantableService keeps
 * canvas_eval out of that), so the window is the only path that can suppress an
 * eval prompt, it binds to one exact surface, and it always expires.
 */
const CANVAS_EVAL_APPROVAL_WINDOW_MS = 12 * 60 * 60 * 1000

function isNonGrantableService(service: AgenticServiceId | undefined): boolean {
  return (
    service === 'canvasEval' ||
    service === 'mediaRecording'
  )
}

/**
 * Services whose grants must name the exact surface they were given for.
 *
 * `canvasInteraction` was grantable with a key of provider:service:workspace and
 * NO surface component, so one "allow for session" covered every canvas in the
 * run AND every canvas opened afterwards — including a renderer-created one the
 * user had logged into themselves, which an agent can enumerate with
 * canvas_list. "The user chose this window" was a property of the prompt, not of
 * the grant.
 *
 * Scoping the grant rather than making the service non-grantable is deliberate.
 * A drive session performs hundreds of actions, so a modal per click is not a
 * stronger gate, it is an unusable one — and an unusable gate gets routed around
 * or answered with something broader. "Yes, drive this window" is a legitimate
 * thing for a user to say once; it just has to mean that and only that.
 */
function isSurfaceScopedService(service: AgenticServiceId | undefined): boolean {
  return service === 'canvasInteraction' || service === 'simulatorCanvas'
}

export class PermissionService {
  // canvasId -> epoch-ms at which its canvas_eval approval window expires.
  // In-memory only: a window must not survive an app restart, and a fresh
  // surface (new canvasId) always re-prompts. Pruned lazily on read.
  private readonly canvasEvalWindowGrants = new Map<string, number>()

  constructor(private readonly options: PermissionServiceOptions) {}

  private getSettings(): AppSettings {
    return this.options.getSettings?.() ?? AppStore.getSettings()
  }

  private updateSettings(partial: Partial<AppSettings>): void {
    if (this.options.updateSettings) {
      this.options.updateSettings(partial)
      return
    }
    AppStore.updateSettings(partial)
  }

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
    // A surface-scoped service has no workspace tier: "click anything, in any
    // chat, in this workspace, until revoked" is not a scope a user can
    // meaningfully consent to, and it would outlive every surface it was given
    // for. Refusing here (rather than only filtering at the posture layer) means
    // a grant persisted by an older build, or hand-edited into settings, still
    // cannot promote a canvas interaction.
    if (isSurfaceScopedService(service)) return false
    if (!workspacePath) return false
    const normalizedWorkspace = resolve(workspacePath)
    return (settings.agenticWorkspaceGrants || []).some((grant) => {
      if (!grant || grant.service !== service || !grant.workspacePath) return false
      // Workspace mutation grants are now scoped to 'agents' (all providers)
      // rather than the requesting provider, so mid-round seat swaps don't
      // lose permission. Legacy per-provider grants still match for the
      // provider they were issued for.
      if (grant.provider !== 'agents' && grant.provider !== provider) return false
      if (grant.expiresAt) {
        const expiresAt = Date.parse(grant.expiresAt)
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false
      }
      return resolve(grant.workspacePath) === normalizedWorkspace
    })
  }

  upsertWorkspaceGrant(
    _provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId
  ): void {
    if (!workspacePath) return
    const settings = this.getSettings()
    const normalizedWorkspace = resolve(workspacePath)
    const now = new Date().toISOString()
    // Store the grant under the 'agents' wildcard so any provider participant
    // in the workspace inherits it. The requesting provider argument is kept
    // for API/audit compatibility but is no longer part of the grant key.
    const grants = (settings.agenticWorkspaceGrants || []).filter((grant) => {
      if (!grant || grant.service !== service || !grant.workspacePath) return true
      return resolve(grant.workspacePath) !== normalizedWorkspace
    })
    grants.push({
      id: randomUUID(),
      provider: 'agents',
      service,
      workspacePath: normalizedWorkspace,
      createdAt: now,
      updatedAt: now,
      expiresOn: 'workspace_revocation'
    })
    this.updateSettings({ agenticWorkspaceGrants: grants })
  }

  removeWorkspaceGrant(
    provider: ProviderId | 'agents',
    workspacePath: string | undefined,
    service: AgenticServiceId
  ): void {
    if (!workspacePath) return
    const settings = this.getSettings()
    const normalizedWorkspace = resolve(workspacePath)
    const grants = (settings.agenticWorkspaceGrants || []).filter((grant) => {
      if (!grant || grant.service !== service || !grant.workspacePath) return true
      // Revoke the 'agents' grant for this workspace/service, and also clean
      // up any legacy per-provider grant that happens to match (so the UI
      // toggle stays coherent even if an older grant is present).
      if (grant.provider !== 'agents' && grant.provider !== provider) return true
      return resolve(grant.workspacePath) !== normalizedWorkspace
    })
    this.updateSettings({ agenticWorkspaceGrants: grants })
  }

  hasSessionGrant(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId,
    runId?: string,
    surfaceId?: string
  ): boolean {
    // Fail closed: a surface-scoped service with no surface in hand cannot match
    // any grant. Without this, a call that simply failed to carry its canvasId
    // would fall back to the unscoped key and be auto-allowed — the exact hole
    // this change exists to close, reachable by omission rather than intent.
    if (isSurfaceScopedService(service) && !surfaceId) return false
    if (runId && this.options.runManager.hasSessionGrant(runId, service, surfaceId)) return true
    return this.options.sessionGrants.has(
      this.sessionGrantKey(provider, workspacePath, service, surfaceId)
    )
  }

  addSessionGrant(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId,
    runId?: string,
    surfaceId?: string
  ): void {
    // Refuse to mint an unscoped grant for a surface-scoped service rather than
    // storing one that can never match: a stored grant that silently does
    // nothing is worse than none, because the UI would report it as given.
    if (isSurfaceScopedService(service) && !surfaceId) return
    if (runId && this.options.runManager.get(runId)) {
      this.options.runManager.addSessionGrant(runId, service, surfaceId)
      return
    }
    this.options.sessionGrants.add(
      this.sessionGrantKey(provider, workspacePath, service, surfaceId)
    )
  }

  removeSessionGrant(
    provider: ProviderId,
    workspacePath: string | undefined,
    service: AgenticServiceId,
    runId?: string,
    surfaceId?: string
  ): boolean {
    if (runId && this.options.runManager.get(runId)) {
      return this.options.runManager.removeSessionGrant(runId, service, surfaceId)
    }
    return this.options.sessionGrants.delete(
      this.sessionGrantKey(provider, workspacePath, service, surfaceId)
    )
  }

  resolvePermission(
    provider: ProviderId,
    service: AgenticServiceId,
    workspacePath: string | undefined,
    runId?: string,
    settings: AppSettings = AppStore.getSettings(),
    /**
     * The exact surface this request targets (for canvas tools, the canvasId).
     * Required for a surface-scoped service to match any grant; absent, no grant
     * applies and the call falls through to the policy.
     */
    surfaceId?: string
  ): AgenticPermissionResolution {
    const policy = this.getServicePolicy(service, settings)
    // canvasEval (arbitrary eval = RCE) is SIGNED-ELEVATED: non-grantable, so no
    // session/workspace grant can ever promote it to an automatic allow — every
    // eval re-prompts. This is the central half of that guarantee (both the
    // Gemini/Claude gate and the Codex native gate route through here); the YOLO
    // bypasses are blocked separately, and read-only denies it via the preset.
    // mediaRecording (future mic/camera capture) is non-grantable for the same
    // reason. externalPublish is grantable, but the run-posture gates clamp it
    // back to per-action approval under read_only / plan.
    const grantable = !isNonGrantableService(service)
    const workspaceGrantAllowed =
      grantable &&
      policy !== 'deny' &&
      this.hasWorkspaceGrant(settings, provider, workspacePath, service)
    const sessionGrantAllowed =
      grantable && this.hasSessionGrant(provider, workspacePath, service, runId, surfaceId)
    const decision =
      policy === 'deny'
        ? 'deny'
        : isSurfaceScopedService(service)
          ? sessionGrantAllowed
            ? 'allow'
            : 'ask'
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
  ): ApprovalLedgerRecord | null {
    return AppStore.resolveApprovalRequest(approvalId, action, decisionSource, extraMetadata)
  }

  applyApprovalDecision(input: ApprovalDecisionInput): boolean {
    const grantable = !isNonGrantableService(input.service)
    if (grantable && input.action === 'acceptForWorkspace' && input.service) {
      this.upsertWorkspaceGrant(input.provider, input.workspacePath, input.service)
    }
    if (grantable && input.action === 'acceptForSession' && input.service) {
      this.addSessionGrant(
        input.provider,
        input.workspacePath,
        input.service,
        input.runId,
        input.surfaceId
      )
    }
    // canvas_eval is non-grantable to the generic machinery above; its ONLY
    // suppression path is the dedicated per-canvas window, opened here on the
    // first human accept for the exact surface the user reviewed.
    if (input.service === 'canvasEval' && this.isApprovedAction(input.action)) {
      this.recordCanvasEvalWindowGrant(input.surfaceId, Date.now())
    }
    return this.isApprovedAction(input.action)
  }

  /**
   * Open (or leave unchanged) the per-canvas canvas_eval approval window. Anchored
   * to the FIRST accept: an auto-approved eval later in the window must not slide
   * the expiry forward, so a live window is never overwritten. A blank surface is
   * a no-op — a window can only ever bind to an exact canvasId.
   */
  recordCanvasEvalWindowGrant(canvasId: string | undefined, nowMs: number): void {
    const id = canvasId?.trim()
    if (!id) return
    const existing = this.canvasEvalWindowGrants.get(id)
    if (existing !== undefined && nowMs < existing) return
    this.canvasEvalWindowGrants.set(id, nowMs + CANVAS_EVAL_APPROVAL_WINDOW_MS)
  }

  /**
   * True while a live per-canvas canvas_eval approval window covers this exact
   * canvasId. Expired windows are pruned on read so a later accept starts fresh.
   */
  hasLiveCanvasEvalWindowGrant(canvasId: string | undefined, nowMs: number): boolean {
    const id = canvasId?.trim()
    if (!id) return false
    const expiresAt = this.canvasEvalWindowGrants.get(id)
    if (expiresAt === undefined) return false
    if (nowMs >= expiresAt) {
      this.canvasEvalWindowGrants.delete(id)
      return false
    }
    return true
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
    service: AgenticServiceId,
    surfaceId?: string
  ): string {
    const base = `${provider}:${service}:${workspacePath ? resolve(workspacePath) : 'global'}`
    return surfaceId ? `${base}:${surfaceId}` : base
  }
}
