import type {
  AuditRunIdentity,
  ActiveGoal,
  ChatScope,
  ChatWorkflowMode,
  EffectiveRunPermissions,
  EnsembleRunIdentity,
  ExternalPathGrant,
  GeminiWorktreeLaunchOption,
  OllamaRunProfileId,
  ProviderId,
  RuntimeProfile,
  TaskWraithMcpProfileId,
  ProviderRunReroute
} from '../store/types'
import type { ResolvedProjectReferenceContext } from '../../shared/projectReferenceContext'

// Phase B1: AgentRunPayload + AgentRunRoute exported so extracted run services
// can type their public surface without importing from main/index.ts.
export interface AgentRunRoute {
  appRunId?: string
  appChatId?: string
}

export interface RunAdapterInvocationReceipt {
  provider: ProviderId
  appRunId: string
  effectiveWorkspacePath?: string
}

/**
 * Observes the exact point after main preflight succeeds and the provider
 * adapter has been invoked. It is intentionally observational: callback
 * failures must never alter provider lifecycle ownership or dispatch outcome.
 */
export interface RunDispatchObserver {
  onAdapterInvoked?: (receipt: RunAdapterInvocationReceipt) => void
}

export interface RuntimeWorktreeIntent {
  requested: boolean
  /**
   * 'ensembleLane' is stamped by the EnsembleOrchestrator for isolated
   * fan-out lanes: main-built, always status 'selected' with a per-lane
   * worktree already allocated, validated by the same preflight linkage
   * check as a composer-selected worktree.
   */
  source: 'runtimeProfile' | 'composer' | 'ensembleLane'
  profileId?: string
  profileName?: string
  baseWorkspacePath?: string
  effectiveWorkspacePath?: string
  status: 'selection-required' | 'selected'
}

/**
 * Main-owned compare-and-set basis for pinning or rotating a provider session's
 * TaskWraith MCP profile receipt. AgentRunNormalizer intentionally never copies
 * this from an incoming payload; applyRuntimeProfileToPayload stamps it after
 * the trust boundary from the current AppStore record.
 */
export interface TaskWraithMcpProfileFenceState {
  expectedStoreProviderSessionId: string | null
  expectedStoreReceiptFingerprint: string | null
  runStartedProviderSessionId: string | null
  /** Immutable receipt identity observed when this run first crossed main. */
  runStartedReceiptFingerprint: string | null
  /** False for cross-provider solo reroutes whose target session has no store lane. */
  storeWritable: boolean
}

export interface AgentRunPayload {
  provider: ProviderId
  providerReroute?: ProviderRunReroute
  scope: ChatScope
  workspace?: string
  prompt: string
  /** Renderer-selected prompt text for opt-in usage history. This can differ
   * from the provider prompt when contextual material must remain redacted. */
  usagePromptText?: string
  /**
   * Separately authorized cold-session prompt used only when a provider-native
   * resume cannot be completed. Bound into effectivePermissionsSignature with
   * `prompt`; never selected by providers that do not implement this contract.
   */
  resumeFallbackPrompt?: string
  activeGoal?: ActiveGoal | null
  appRunId?: string
  appChatId?: string
  model?: string
  reasoningEffort?: string | null
  serviceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinking?: boolean | null
  approvalMode?: string
  /** Product workflow intent, separate from the low-level permission posture. */
  workflowMode?: ChatWorkflowMode
  /** Per-run Ollama runtime profile override. */
  ollamaRunProfile?: OllamaRunProfileId
  imagePaths?: string[]
  providerSessionId?: string | null
  externalPathGrants?: ExternalPathGrant[]
  /** Explicit user-selected Project catalogue context, re-resolved and signed by main. */
  projectReferenceContext?: ResolvedProjectReferenceContext
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
  /** Exact main-resolved TaskWraith MCP catalog for this run. */
  taskWraithMcpProfileId?: TaskWraithMcpProfileId
  /** Main-resolved fact that this run will attach TaskWraith MCP at all. */
  taskWraithMcpAdvertised?: boolean
  /** Main-owned CAS basis for the eventual provider-session receipt write. */
  taskWraithMcpProfileFence?: TaskWraithMcpProfileFenceState
  /**
   * Main-owned cancellation signal for provider setup before an exact
   * transport handle exists. Assigned only by the shared lifecycle owner after
   * normalization and final dispatch authorization; never accepted as incoming
   * renderer authority.
   */
  providerSetupAbortSignal?: AbortSignal
  runtimeWorktree?: RuntimeWorktreeIntent
  effectivePermissions?: EffectiveRunPermissions
  /**
   * HMAC over the run's permission posture (`approvalMode` +
   * `effectivePermissions`), stamped by the main-side producer that
   * built this payload and verified at the `normalizeAgentRunPayload`
   * trust boundary. The shared lifecycle owner retains it with the normalized
   * posture in RunManager state before provider setup begins; providers must
   * preserve that snapshot when replacing their transport-specific state.
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
