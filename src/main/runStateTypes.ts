import type Electron from 'electron'
import type { CliProviderThinkingSegmentsState } from './providers/CliProviderThinking'
import type { CodexMultiAgentTelemetry } from '../shared/codexMultiAgent'
import type {
  ChatScope,
  ChatWorkflowMode,
  EffectiveRunPermissions,
  EnsembleRunIdentity,
  ExternalPathGrant,
  ProviderId,
  TaskWraithMcpProfileId
} from './store/types'
import type { TaskWraithMcpProfileFenceState } from './run/AgentRunTypes'
import type { ProviderTerminalProjectionOperation } from './run/ProviderOperationRegistry'
import type {
  CodexThreadAdmissionKind,
  CodexThreadAdmissionReservation
} from './codex/CodexThreadAdmission'
export interface CodexRunState {
  sender: Electron.WebContents
  threadId: string
  startedAt: number
  scope?: ChatScope
  cwd: string
  workspacePath?: string
  turnId?: string
  /** Host admission kind + reservation used to bind this run to one exact
   * app-server operation. The reservation serializes same-thread host starts
   * through identity assignment; terminal projection additionally requires
   * the exact bound id. */
  admissionKind?: CodexThreadAdmissionKind
  admissionReservation?: CodexThreadAdmissionReservation
  /** When this run IS a native `/review` sub-run, the id of the synthesized
   * `codex_review` anchor activity the review card attaches its telemetry to
   * (Codex emits no natural anchor tool-call for a review). Set only for reviews;
   * its presence is how `review/completed` knows to emit terminal review status. */
  reviewActivityId?: string
  reviewTarget?: string
  reviewModel?: string
  /** When a native Codex Multi-agent episode is detected in the current turn
   * (from explicit `subAgentActivity`/`collabAgentToolCall` items — never
   * inferred from model/effort), the id of the synthesized `codex_multi_agent`
   * anchor activity the orchestration card attaches its telemetry to. Cleared
   * when the parent turn settles (episodes are per-turn). When
   * `reviewActivityId` is set the review card outranks — no separate
   * multi-agent anchor is synthesized for the same episode. */
  multiAgentActivityId?: string
  /** Accumulated telemetry for the in-flight Multi-agent episode. */
  multiAgentTelemetry?: CodexMultiAgentTelemetry
  model: string
  /** Concrete app-server wire effort selected for this run. */
  reasoningEffort?: string
  approvalMode?: string
  workflowMode?: ChatWorkflowMode
  sessionTrust?: boolean
  externalPathGrants?: ExternalPathGrant[]
  runtimeProfileId?: string
  /** Main-resolved gateway generation used to fence hidden capability discovery. */
  taskWraithMcpProfileId?: TaskWraithMcpProfileId
  effectivePermissions?: EffectiveRunPermissions
  effectivePermissionsSignature?: string
  ensembleRun?: EnsembleRunIdentity
  appRunId?: string
  appChatId?: string
  /** Display-safe prompt selected by the dispatch producer for optional usage history. */
  usagePromptText?: string
  tokenUsage?: any
  /** Context tokens (`tokenUsage.last.totalTokens`) snapshotted when a
   * `contextCompaction` item STARTS, so the completion card can report an
   * honest pre→post shrink (post comes from the compaction turn's own
   * `thread/tokenUsage/updated`). */
  contextCompactionPreTokens?: number
  /** Wall-clock ms when the in-flight `contextCompaction` item started
   * (drives the completed card's duration). */
  contextCompactionStartedAtMs?: number
  /** `contextCompaction` item ids already announced for this run — dedupes the
   * item lane against the deprecated `thread/compacted` notification (and
   * defensive re-delivery) so each compaction is announced at most once. */
  contextCompactionAnnouncedIds?: Set<string>
  assistantTextByItemId: Map<string, string>
  timelineStartedItemIds: Set<string>
  reasoningTextByItemId: Map<string, string>
  /** GPT-5.6-only presentation grouping for adjacent reasoning summary items. */
  activeReasoningSummaryGroupId?: string
  reasoningSummaryGroupIdByItemId: Map<string, string>
  reasoningSummaryItemIdsByGroupId: Map<string, string[]>
  /** Visible non-reasoning output landed since the last reasoning item. */
  thinkingChronoBreak?: boolean
  commandOutputByItemId: Map<string, string>
  filePatchByItemId: Map<string, any>
  hostRerunRequestedItemIds: Set<string>
  providerMediaRefKeys?: Set<string>
  /** Exact per-turn settlement for the shared app-server transport. History
   * deletion joins this until the terminal notification's main projection has
   * completed; the daemon process lifetime is deliberately not used. */
  terminalProjectionOperation?: ProviderTerminalProjectionOperation
  completed: boolean
}

export interface GeminiToolContext {
  sender: Electron.WebContents
  scope: ChatScope
  cwd: string
  workspacePath?: string
  appRunId?: string
  appChatId?: string
  providerSessionId?: string | null
  /** Main-resolved model selected for this exact run. */
  model?: string
  approvalMode?: string
  workflowMode?: ChatWorkflowMode
  sessionTrust?: boolean
  externalPathGrants?: ExternalPathGrant[]
  runtimeProfileId?: string
  /** Main-resolved gateway generation used to fence hidden capability discovery. */
  taskWraithMcpProfileId?: TaskWraithMcpProfileId
  effectivePermissions?: EffectiveRunPermissions
  effectivePermissionsSignature?: string
  ensembleRun?: EnsembleRunIdentity
}

// Phase B3: AgenticApprovalWaiter moved into
// `src/main/services/ApprovalService.ts` as `PendingGeminiToolApproval`.
// HostCommandApproval is still referenced by `HostCommandResult` callers
// in `continueCodexAfterHostRerun`, so the interface stays here.

export interface HostCommandApproval {
  sender: Electron.WebContents
  provider: 'codex'
  command: unknown
  commandText: string
  cwd: string
  workspacePath?: string
  threadId: string
  model: string
  reasoningEffort?: string
  appRunId?: string
  appChatId?: string
  reason: string
  output: string
}

export interface HostCommandResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
  timedOut: boolean
  durationMs: number
}

export interface CliProviderStreamState extends CliProviderThinkingSegmentsState {
  provider: ProviderId
  sender: Electron.WebContents
  startedAt: number
  model: string
  fallback: boolean
  completed: boolean
  /**
   * A provider-native terminal result declared failure even if its wrapper
   * process later exits 0 (currently observed from Cursor `is_error:true`).
   * Close-out must preserve the protocol outcome as authoritative.
   */
  terminalResultFailed?: boolean
  /** Normalized provider-native terminal evidence when the stream reports it. */
  terminalResultStatus?: 'completed' | 'failed' | 'cancelled'
  /** Wire transports may report a provisional result before process close. */
  deferTerminalResult?: boolean
  /** Typed provisional status retained until the Wire process actually closes. */
  deferredTerminalStatus?: 'completed' | 'failed' | 'cancelled'
  /** Sticky marker for conflicting provisional result/response statuses. */
  deferredTerminalConflict?: boolean
  assistantText: string
  /** Per-run Pi RPC reducer (usage summing, settle detection). */
  piReducer?: import('./pi/PiRpc').PiRpcTurnReducer
  /** Token-sized Kimi ACP thinking deltas awaiting their next UI/ledger batch. */
  kimiThinkingPendingText?: string
  kimiThinkingFlushTimer?: NodeJS.Timeout
  /** Visible ACP text used for the explicitly-estimated Kimi usage fallback. */
  kimiUsageInputChars?: number
  kimiUsageOutputChars?: number
  /** Live chars÷4 estimate lanes for providers with no mid-stream usage
   * envelope (Grok, Cursor). Output side accumulates thinking + tool-call
   * payload chars BEYOND `assistantText` (which is counted separately to
   * avoid double-counting cumulative content snapshots); input side
   * accumulates tool-result payload chars the provider re-reads. */
  estimateOutputExtraChars?: number
  estimateInputChars?: number
  providerSessionId?: string | null
  approvalMode?: string
  workflowMode?: ChatWorkflowMode
  sessionTrust?: boolean
  externalPathGrants?: ExternalPathGrant[]
  runtimeProfileId?: string
  taskWraithMcpProfileId?: TaskWraithMcpProfileId
  taskWraithMcpAdvertised?: boolean
  taskWraithMcpProfileFence?: TaskWraithMcpProfileFenceState
  /** Session ids already accepted from this run; rejects late A→B replay after A→B→C. */
  taskWraithMcpSeenProviderSessionIds?: Set<string>
  effectivePermissions?: EffectiveRunPermissions
  effectivePermissionsSignature?: string
  ensembleRun?: EnsembleRunIdentity
  runId?: string | null
  appRunId?: string
  appChatId?: string
  tokenUsage?: any
  /** Published rate-table row used for projected cost when the provider's
   * selected service tier is not encoded in its display model id. */
  costRateModel?: string
  /**
   * 1.0.6-G5e — Grok's terminal stopReason when it is NOT a normal end (e.g.
   * 'Cancelled', 'MaxTokens'). Grok exits 0 even when it self-cancels a turn
   * mid-reasoning before answering/writing, so we remember the real reason here
   * to report an honest result status instead of a misleading 'success'.
   */
  grokStopReason?: string
  /**
   * ACP tool failures can make Grok end the turn with a successful prompt
   * completion but no assistant text. Track that shape so close-out can fail
   * visibly instead of rendering a blank successful run.
   */
  grokToolErrorCount?: number
  grokLastToolError?: string
  providerMediaRefKeys?: Set<string>
  /**
   * Background-task ids the claude provider has confirmed are LOCAL WORKFLOWS
   * (task_type === 'local_workflow' on task_started). Later task_progress /
   * task_updated / task_notification frames carry no task_type, so we gate
   * workflow-card telemetry emission on membership here — this keeps plain
   * background `Task` subagents (which share the same lifecycle frames) from
   * being mistaken for workflows.
   */
  claudeWorkflowTaskIds?: Set<string>
  /**
   * Dedupe keys (src/shared/contextCompaction.ts contextCompactionDedupeKey)
   * for compaction signals already emitted this run. Claude re-emits the same
   * compaction-failed status frame more than once per attempt (probe-observed),
   * so emission gates on membership here.
   */
  contextCompactionSeen?: Set<string>
}
