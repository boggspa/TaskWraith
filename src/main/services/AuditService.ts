import type { AgentRunRoute } from '../run/AgentRunTypes'
import type { RunManager } from '../RunManager'
import type {
  AgentApprovalAction,
  AgenticServiceId,
  ApprovalLedgerRequestInput,
  ProviderId,
  RunPermissionPostureSnapshot
} from '../store/types'

export interface ApprovalRouteContext {
  session?: {
    providerSessionId?: string
    providerRunId?: string
    workspacePath?: string
  }
  runId?: string
  chatId?: string
  workspaceId?: string
  workspacePath?: string
  permissionPosture?: RunPermissionPostureSnapshot
}

export interface AutomaticApprovalRequest {
  method: string
  title: string
  body: string
  preview?: unknown
}

export type AutomaticApprovalDecision = 'autoAllow' | 'autoDeny'
export type AutomaticApprovalDecisionSource =
  | 'policy'
  | 'workspace_grant'
  | 'session_grant'
  | 'session_yolo'
  | 'bossman_auto'
  | 'plan_artifact'
export type AutomaticApprovalGrantedScope = 'request' | 'session' | 'workspace'

export interface AuditServiceDeps {
  runManager: RunManager<unknown>
  resolveApprovalResponse: (
    approvalId: string,
    action: AgentApprovalAction,
    decisionSource: 'user' | 'system',
    extraMetadata: Record<string, unknown>
  ) => void
  recordApprovalLedgerDecision: (input: ApprovalLedgerRequestInput) => void
  approvalRouteContext: (provider: ProviderId, route?: AgentRunRoute | null) => ApprovalRouteContext
  now?: () => Date
  idSuffix?: () => string
  logError?: (message: string, error: unknown) => void
}

/**
 * AuditService — Phase B follow-up extraction.
 *
 * Owns approval-ledger response and automatic-decision writes. The
 * service intentionally never throws: ledger/audit failures should not
 * break provider protocol flow or permission dispatch.
 */
export class AuditService {
  constructor(private deps: AuditServiceDeps) {}

  resolveApprovalLedgerResponse(
    approvalId: string,
    action: AgentApprovalAction,
    decisionSource: 'user' | 'system' = 'user',
    extraMetadata: Record<string, unknown> = {}
  ): void {
    try {
      this.deps.resolveApprovalResponse(approvalId, action, decisionSource, extraMetadata)
    } catch (error) {
      this.logError('Failed to resolve approval ledger request', error)
    }
  }

  recordAutomaticApprovalDecision(
    provider: ProviderId,
    route: AgentRunRoute | null | undefined,
    service: AgenticServiceId,
    workspacePath: string | undefined,
    request: AutomaticApprovalRequest,
    decision: AutomaticApprovalDecision,
    decisionSource: AutomaticApprovalDecisionSource,
    grantedScope: AutomaticApprovalGrantedScope,
    metadata: Record<string, unknown> = {}
  ): void {
    try {
      const now = this.nowIso()
      const context = this.deps.approvalRouteContext(provider, route)
      const metadataWithPosture = mergePermissionPostureMetadata(
        metadata,
        context.permissionPosture
      )
      this.deps.recordApprovalLedgerDecision({
        approvalId: `${decision}-${service}-${this.nowMs()}-${this.idSuffix()}`,
        provider,
        service,
        method: request.method,
        title: request.title,
        body: request.body,
        preview: request.preview,
        actions: [],
        status: decision === 'autoAllow' ? 'approved' : 'denied',
        requestedAt: now,
        respondedAt: now,
        decision,
        decisionSource,
        grantedScope,
        expiration: expirationForDecision(decision, grantedScope, now),
        runId: context.runId,
        chatId: context.chatId,
        workspaceId: context.workspaceId,
        workspacePath: workspacePath || context.workspacePath,
        providerSessionId: context.session?.providerSessionId,
        providerRunId: context.session?.providerRunId,
        metadata: metadataWithPosture
      })
    } catch (error) {
      this.logError('Failed to record automatic approval ledger decision', error)
    }
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime()
  }

  private idSuffix(): string {
    return this.deps.idSuffix?.() ?? Math.random().toString(36).slice(2)
  }

  private logError(message: string, error: unknown): void {
    if (this.deps.logError) {
      this.deps.logError(message, error)
      return
    }
    console.error(message, error)
  }
}

function mergePermissionPostureMetadata(
  metadata: Record<string, unknown>,
  permissionPosture: RunPermissionPostureSnapshot | undefined
): Record<string, unknown> {
  if (!permissionPosture) return metadata
  return {
    ...metadata,
    permissionPosture
  }
}

function expirationForDecision(
  decision: AutomaticApprovalDecision,
  grantedScope: AutomaticApprovalGrantedScope,
  now: string
): ApprovalLedgerRequestInput['expiration'] {
  if (decision === 'autoDeny') {
    return {
      mode: 'on_decision',
      description: 'Denied automatically by the current TaskWraith policy.',
      expiresAt: now,
      expiredAt: now,
      expiredReason: 'policy_denied'
    }
  }
  if (grantedScope === 'workspace') {
    return {
      mode: 'workspace_revocation',
      description: 'Workspace approval remains active until the workspace grant is revoked.'
    }
  }
  if (grantedScope === 'session') {
    return {
      mode: 'session_end',
      description: 'Session approval expires when the active provider runtime session ends.'
    }
  }
  return {
    mode: 'none',
    description: 'Allowed automatically by the current TaskWraith policy for this request.'
  }
}
