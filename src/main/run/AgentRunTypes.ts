import type {
  AuditRunIdentity,
  ChatScope,
  EffectiveRunPermissions,
  EnsembleRunIdentity,
  ExternalPathGrant,
  GeminiWorktreeLaunchOption,
  ProviderId,
  RuntimeProfile,
  ProviderRunReroute
} from '../store/types'

// Phase B1: AgentRunPayload + AgentRunRoute exported so extracted run services
// can type their public surface without importing from main/index.ts.
export interface AgentRunRoute {
  appRunId?: string
  appChatId?: string
}

export interface AgentRunPayload {
  provider: ProviderId
  providerReroute?: ProviderRunReroute
  scope: ChatScope
  workspace?: string
  prompt: string
  appRunId?: string
  appChatId?: string
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinking?: boolean | null
  approvalMode?: string
  imagePaths?: string[]
  providerSessionId?: string | null
  externalPathGrants?: ExternalPathGrant[]
  sessionTrust?: boolean
  geminiWorktree?: GeminiWorktreeLaunchOption
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  /**
   * Auto-failover hops this run has been through (0 = the original
   * user-initiated run). Carried so the dispatch seam can re-sign a rerouted
   * posture and the failover orchestrator can cap ping-pong. Transport-only.
   */
  failoverHopCount?: number
  runtimeProfile?: RuntimeProfile
  effectivePermissions?: EffectiveRunPermissions
  /**
   * HMAC over the run's permission posture (`approvalMode` +
   * `effectivePermissions`), stamped by the main-side producer that
   * built this payload and verified at the `normalizeAgentRunPayload`
   * trust boundary. Transport-only: it is NOT stored in session state.
   * Absent / invalid on a payload that carries `effectivePermissions`
   * triggers a downgrade to a read-only run; absent on a raised
   * `approvalMode` caps the run to prompt-on-action. See
   * src/main/RunPermissionPosture.ts.
   */
  effectivePermissionsSignature?: string
  ensembleRun?: EnsembleRunIdentity
  /** Present for audit-orchestration role-runs (parallel to ensembleRun) so
   * the adapter/MCP layer routes the run's findings/verdicts/profile back to
   * the AuditOrchestrator's per-run collector. See src/main/audit/. */
  auditRun?: AuditRunIdentity
}
