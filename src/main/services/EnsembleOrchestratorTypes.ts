import type { EnsembleRosterPreset } from '../../shared/EnsembleRosterPresetContract'
import type { ContextCompactionProgressEvent } from '../../shared/contextCompaction'
import type { ExternalSeatInput } from '../../shared/effectiveEnsembleRoster'
import type { ResolvedInstructionContext } from '../../shared/instructions/InstructionTypes'
import type { ParticipantWorkingTelemetryEvent } from '../../shared/participantWorkingTelemetry'
import type { Project, ProjectReference } from '../../shared/projects'
import type { ExternalContributionQueueStore } from '../collaboration/ExternalContributionQueueStore'
import type { SessionCheckpointReason } from '../checkpoints/SessionCheckpoint'
import type { BuildEnsembleRosterPresetApplyResult } from '../EnsembleRosterPresetApply'
import type {
  RosterEditAction,
  RosterEditError,
  RosterEditParticipantInput,
  RosterEditRequest
} from '../EnsembleRosterMutation'
import type { EnsembleUserRosterMutationError } from '../EnsembleUserRosterMutation'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import type { ProviderUsageSummary } from '../ProviderUsageStatus'
import type { AgentRunPayload, RunDispatchObserver } from '../run/AgentRunTypes'
import type { RunPermissionPostureContext } from '../RunPermissionPosture'
import type {
  ActiveGoal,
  ActiveGoalStatus,
  AppSettings,
  ChatRecord,
  EffectiveRunPermissions,
  EnsembleBossmanAssignmentDue,
  EnsembleBossmanAssignmentStatus,
  EnsembleBossmanControlScope,
  EnsembleBossmanQuarantineCategory,
  EnsembleBossmanReviewGateStatus,
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  EnsembleParticipant,
  EnsembleRoundState,
  EnsembleWakeupRecord,
  ExternalPathGrant,
  ProviderId,
  RunQueueJobStatus,
  SessionActivityLedgerEntry,
  UsageRecord
} from '../store/types'
import type {
  EnsembleSideMessageSteeringInput,
  EnsembleSideMessageSteeringResult
} from '../steering/EnsembleSideMessageSteering'
import type { SubThreadMailbox, SubThreadMailboxOutcome } from '../SubThreadMailbox'
import type { TrustedSessionScope } from '../TrustedSessionGrants'
import type { WorkspaceChurnSample } from '../WorkspaceChurn'
import type { CursorTransportLiveness } from './EnsembleCursorCompletionWatchdog'
import type { HostSeatCompactionProvider } from './EnsembleSeatRuntimePosture'
import type { ProjectReferenceExtractLoader } from './ProjectReferenceContextService'

export type EnsembleRunMode = 'normal' | 'queue' | 'steer'

/**
 * Rewind-from-message ("Edit & resend from here") restart hints for a
 * replacement round started after the previous round was cancelled.
 *
 * The rewind flow is renderer-orchestrated (cancel → quiesce → truncate →
 * re-dispatch), and cancel destroys every piece of rotation state
 * (`activeParticipantId`, `remainingParticipants`, the runtime itself), so
 * whatever the replacement round needs must be captured BEFORE the cancel and
 * threaded through here.
 */
export interface EnsembleRewindRoundOptions {
  /**
   * Seat that was active when the round was cancelled. The replacement round
   * resumes the rotation AT this seat and runs only the seats that were still
   * waiting after it — seats earlier in the order already spoke this round,
   * and re-running them would duplicate turns whose rows survived the
   * truncation. Unknown/removed ids fail soft to the full roster order.
   */
  resumeFromParticipantId?: string
  /**
   * The edited anchor row was already rewritten in place by the transcript
   * mutation, so the replacement round must NOT append a fresh
   * `ensemble-user-*` prompt row — that would duplicate the message the user
   * just edited.
   */
  suppressPromptEcho?: boolean
}

export type EnsembleQueuedSteerResult = {
  status: 'steered' | 'ignored'
  roundId?: string
  error?: string
}

export interface MidRunSteeringAppendReceipt {
  messageId: string
  entryId: string
}

export type EnsembleQueuedPromptMutationResult = {
  ok: boolean
  prompt?: string
  queuedPrompts?: string[]
  /** Attachment snapshots from the removed entry so Edit can restore them. */
  imageAttachments?: Array<{
    id?: string
    path: string
    name?: string
    kind?: 'file' | 'directory'
  }>
  dmTargetParticipantId?: string
  error?: string
}

/**
 * Main-authoritative configuration mutation requested from the composer while
 * an Ensemble round may still be running. These controls affect only future
 * admissions/continuations; an already-dispatched provider run is never
 * cancelled or reconfigured underneath itself.
 */
export interface EnsembleLiveRoundConfigUpdateInput {
  chatId: string
  orchestrationMode?: EnsembleOrchestrationMode
  fanoutPolicy?: EnsembleFanoutPolicy
  maxContinuationHops?: number
  /** Renderer-observed value before its optimistic write. Main uses this only
   * when the canonical chat already contains the requested value, closing the
   * save-vs-IPC race without letting the hint override a real durable before. */
  previousMaxContinuationHops?: number
}

export type EnsembleLiveRoundConfigUpdateResult =
  | {
      ok: true
      orchestrationMode: EnsembleOrchestrationMode
      fanoutPolicy: EnsembleFanoutPolicy
      maxContinuationHops: number
      /** True when the durable active-round snapshot was updated too. */
      activeRoundUpdated: boolean
    }
  | {
      ok: false
      error: 'not_ensemble' | 'invalid_config'
      message: string
    }

export type EnsembleUserRosterPresetApplyResult =
  | { ok: true; deferred: boolean }
  | {
      ok: false
      error: 'not_ensemble' | 'invalid_config'
      message: string
    }

export interface EnsembleDispatchEvent {
  sender: Electron.WebContents
}

/**
 * Main-owned evidence about the exact durable rows serialized into this
 * provider prompt. It travels beside the payload rather than inside it so a
 * renderer-authored AgentRunPayload cannot forge a steering delivery receipt.
 */
export interface EnsembleDispatchPromptEvidence {
  suppliedMessageIds: readonly string[]
}

export interface EnsembleImageAttachment {
  id?: string
  path: string
  name?: string
  kind?: 'file' | 'directory'
}

export interface EnsembleImageThumbnail {
  dataBase64: string
  mimeType: string
  width?: number
  height?: number
}

/**
 * 1.0.4-AD — pre-flight participant health check result. Returned by
 * the optional `probeParticipant` dep so the orchestrator can mark a
 * participant `'unreachable'` BEFORE dispatch when its provider's
 * runtime / socket / binary can't be verified.
 *
 *   - `reachable: true` — proceed to dispatch as normal.
 *   - `reachable: false` — skip dispatch, mark participant unreachable,
 *     route past via the existing self-heal path. The `reason` text
 *     populates the participant state's `lastFailureReason` (surfaced
 *     in the chip tooltip) and the transcript note via
 *     `formatProbeFailureNote`. `underlyingCode` is an optional posix-
 *     like code (`ENOENT`, `ECONNREFUSED`, `ETIMEDOUT`) for the
 *     parenthetical in the transcript line.
 */
export interface ParticipantProbeResult {
  reachable: boolean
  reason?: string
  underlyingCode?: string
}

export interface EnsembleOrchestratorDeps {
  getChat: (chatId: string) => ChatRecord | null
  saveChat: (chat: ChatRecord) => void
  getSettings: () => AppSettings
  /**
   * Resolved user instruction layers (global custom-instructions document +
   * workspace TASKWRAITH.md) for participant briefings. The digest also
   * feeds `computeEnsemblePromptShellStamp`, so an instructions edit
   * re-briefs every slim-resumed seat. Optional so the unit-test harness
   * can omit it (seats then brief without the block).
   */
  resolveInstructionContext?: (workspacePath: string | null) => ResolvedInstructionContext | null
  /**
   * Stamp a participant run's permission posture so the
   * `normalizeAgentRunPayload` clamp trusts this main-built (and
   * legitimately permissive) payload instead of downgrading it to
   * read-only. Optional so the unit-test harness can omit it.
   * See src/main/RunPermissionPosture.ts.
   */
  signRunPermissionPosture?: (
    approvalMode: string | null | undefined,
    effectivePermissions: EffectiveRunPermissions | null | undefined,
    context?: RunPermissionPostureContext | null
  ) => string
  isTrustedSessionGranted?: (scope: TrustedSessionScope) => boolean
  /**
   * Mint host-authorized attachment grants only after the participant run id
   * exists. A `thisRun` grant is a capability for one exact provider run, so
   * round-level pre-minting cannot bind it safely (serial seats and fan-out
   * lanes each receive a different appRunId).
   */
  issueRunScopedExternalGrants?: (input: {
    chat: ChatRecord
    participant: EnsembleParticipant
    appRunId: string
    attachments: EnsembleImageAttachment[]
  }) => ExternalPathGrant[]
  /** Structural subset of RunCoordinator's `DispatchResult`. `failureMessage`
   *  is why a preflight refusal happened, when there is a reason worth
   *  telling a human; absent for a lifecycle cancellation, which is not a
   *  failure. Without it a skipped seat can only say "dispatch failed". */
  dispatch: (
    payload: AgentRunPayload,
    event: EnsembleDispatchEvent,
    observer?: RunDispatchObserver,
    promptEvidence?: EnsembleDispatchPromptEvidence
  ) => Promise<{ dispatched: boolean; appRunId: string; failureMessage?: string }>
  /** Injectable only to hold the real async prompt-preparation seam in tests. */
  sampleWorkspaceChurn?: (workspacePath: string) => Promise<WorkspaceChurnSample | null>
  /**
   * Fan-out worktree isolation (fanoutIsolation === 'worktree'). Allocates
   * (or re-adopts) a per-LANE linked git worktree branched from the
   * workspace's last commit and records the durable candidate. Optional so
   * the unit-test harness can omit it — isolation then silently stays off,
   * matching every other optional dep.
   */
  allocateFanoutLaneWorktree?: (input: {
    chatId: string
    roundId: string
    laneId: string
    runId: string
    participantId: string
    participantLabel?: string
    provider: ProviderId
    model?: string
    baseWorkspacePath: string
  }) => Promise<{ baseWorkspacePath: string; effectiveWorkspacePath: string; branch: string }>
  /**
   * Fire-and-forget candidate settlement when an isolated lane's run reaches
   * a terminal state. Implementations must swallow their own failures —
   * terminal run bookkeeping cannot depend on candidate persistence.
   */
  settleFanoutLaneWorktree?: (input: {
    chatId: string
    laneId: string
    runStatus: 'completed' | 'failed' | 'cancelled'
  }) => void
  /** False for an ephemeral cross-provider reroute with no target session lane. */
  shouldPersistProviderSessionForRun?: (runId: string) => boolean
  releaseProviderSessionPersistenceDecision?: (runId: string) => void
  cancelRun: (provider: ProviderId, runId?: string) => Promise<boolean>
  /** Test override for the superseded-transport reap grace window. */
  supersededTransportReapGraceMs?: number
  /**
   * Cursor Path-B can terminate its child without delivering the canonical
   * provider `result` event. The orchestrator uses this exact transport
   * liveness probe to bound that missing-terminal gap without timing out a
   * known-live model or approval wait.
   */
  getProviderRunTransportLiveness?: (runId: string) => CursorTransportLiveness
  hasPendingProviderRunApprovals?: (runId: string) => boolean
  /**
   * Destructive-history stop receipt. Unlike ordinary UI cancellation, this
   * must join the exact adapter/transport cleanup before resolving true.
   */
  terminateRunForHistory?: (provider: ProviderId, runId: string) => Promise<boolean>
  createRunId: (provider: ProviderId) => string
  now: () => number
  nowIso: () => string
  /**
   * 1.0.7 — Optional override for the maximum time a foreground turn waits
   * for its owned fan-out lanes to settle. Primarily for tests; omitted uses
   * DEFAULT_OWNED_FANOUT_SETTLEMENT_TIMEOUT_MS.
   */
  ownedFanoutSettlementTimeoutMs?: number
  /**
   * S16 — external seat turns. Both optional: an orchestrator with neither
   * behaves exactly as it did before, which is what every existing test
   * harness and every unshared chat relies on.
   *
   * The orchestrator PULLS from the queue. It is never pushed to, and
   * ChatService must never gain a dispatcher — the source-region tripwire in
   * ExternalContributionDispatchBoundary.test.ts pins that, because a
   * contribution that can START work is a different security question from one
   * that rides a round the host already started.
   */
  resolveExternalSeats?: (chatId: string) => readonly ExternalSeatInput[]
  externalContributionQueue?: Pick<
    ExternalContributionQueueStore,
    'listAwaitingMaterialisation' | 'markMaterialised'
  >
  /**
   * 1.0.4-AD — optional pre-flight reachability probe. Called BEFORE
   * each participant's dispatch in `runRound`. When omitted (e.g.
   * unit-test harness without provider plumbing) the orchestrator
   * treats every participant as reachable and goes straight to
   * dispatch — preserving the pre-1.0.4-AD behaviour for callers that
   * haven't wired the probe yet.
   */
  probeParticipant?: (participant: EnsembleParticipant) => Promise<ParticipantProbeResult>
  /**
   * Remint secondary-workspace grants that still carry prior consent but are
   * bound to a stale primary workspace id. Returns true when at least one
   * path was reminted for the full active provider set.
   */
  repairStaleExternalPathGrants?: (chatId: string) => Promise<boolean>
  /** Ask the renderer to open the grant prompt; user dismiss is the only deny. */
  notifyExternalPathGrantRepairNeeded?: (input: {
    chatId: string
    roundId: string
    message: string
  }) => void
  /**
   * Wave 3 seat compaction — host maintenance-lane compaction for Kimi/Grok
   * seats. `awaitPendingSeatCompaction` returns the in-flight compaction
   * promise for a seat (if any); every participant dispatch awaits it so a
   * round started mid-compaction can't race the seat's session reset.
   * `compactSeatContext` powers the post-round auto-trigger. Both optional so
   * the unit-test harness can omit them (no-ops).
   */
  awaitPendingSeatCompaction?: (
    chatId: string,
    participantId: string
  ) => Promise<unknown> | undefined
  compactSeatContext?: (input: {
    chatId: string
    participantId: string
    provider: HostSeatCompactionProvider
    trigger: 'auto'
  }) => Promise<{ ok: boolean; error?: string }>
  onContextCompactionProgress?: (event: ContextCompactionProgressEvent) => void
  /**
   * High-frequency, in-memory participant usage snapshots for the renderer's
   * working indicator. Deliberately not persisted or folded into ChatRecord.
   */
  onParticipantWorkingTelemetry?: (event: ParticipantWorkingTelemetryEvent) => void
  getProviderUsageSnapshot?: (
    provider: ProviderId
  ) => NormalizedProviderUsageSnapshot | null | undefined
  scheduleWakeupTimer?: (wakeup: EnsembleWakeupRecord) => void
  cancelWakeupTimer?: (wakeupId: string) => void
  /**
   * 1.0.7 — record a finished participant run's usage into the shared usage
   * store. Ensemble runs complete inside the orchestrator (not via the
   * renderer's handleProviderExit), so without this hook they never reach
   * usage.json — and go missing from the welcome wall-clock, the activity
   * heatmaps, and the Providers-tab token totals. Optional so the unit-test
   * harness can omit it (recording is then a no-op).
   */
  recordUsage?: (entry: Omit<UsageRecord, 'id' | 'timestamp'>) => void
  persistSessionCheckpoint?: (chat: ChatRecord, reason: SessionCheckpointReason) => void
  /**
   * Host-routed chat-persistence durability barrier (AppStore.saveChat's
   * Host-owned-gate branch enqueues; this drains). runRound awaits it before
   * the first participant dispatch so a persistence failure fails the round
   * loudly instead of dispatching on unpersisted state. Optional so the
   * unit-test harness can omit it (no barrier then — the legacy gate path
   * persists synchronously and needs none).
   */
  persistChatBarrier?: (chatId: string) => Promise<void>
  completeSessionCheckpoint?: (
    chatId: string,
    roundId: string,
    status: Extract<EnsembleRoundState['status'], 'completed' | 'cancelled' | 'failed'>
  ) => void
  /**
   * Main-owned transcript append + delivery-registry seam for an interjection
   * absorbed into this still-live round (text and optional attachment metadata).
   */
  appendMidRunSteering?: (input: {
    chatId: string
    roundId: string
    text: string
    imageAttachments?: EnsembleImageAttachment[]
    imageThumbnails?: EnsembleImageThumbnail[]
  }) => MidRunSteeringAppendReceipt
  /**
   * Registry ids that no participant prompt has carried yet. The orchestrator
   * uses the set only at the serial drain boundary; provider-specific live
   * delivery (currently Pi) can clear it before an extra boundary turn is
   * needed.
   */
  getPendingMidRunSteeringEntryIds?: (chatId: string) => string[]
  /**
   * Best-effort live transport for a side message that is already durable in
   * the transcript. Exact target run ids are resolved by this orchestrator;
   * the main composition root owns RunManager/provider transport access.
   */
  deliverSideMessageSteering?: (
    input: EnsembleSideMessageSteeringInput
  ) => EnsembleSideMessageSteeringResult
  transitionRunQueueJob?: (
    runIdOrId: string,
    status: RunQueueJobStatus,
    partial?: { statusReason?: string; lastError?: string }
  ) => unknown
  releaseWriteIntentsForLane?: (laneId: string) => unknown
  /**
   * Record a non-Boss attempt to drive `ensemble_bossman_control` into the
   * durable approval/audit ledger (the orchestrator has no direct AuditService
   * handle). Optional so the unit-test harness can omit it (auditing is then a
   * no-op). The transcript status line is appended regardless.
   */
  recordBossmanControlRejection?: (rejection: {
    provider: ProviderId
    workspacePath: string | undefined
    chatId: string
    runId: string | undefined
    metadata: Record<string, unknown>
  }) => void
  recordFanoutAuthorizationRejection?: (rejection: {
    provider: ProviderId
    workspacePath: string | undefined
    chatId: string
    runId: string | undefined
    metadata: Record<string, unknown>
  }) => void
  /** Authoritative Project registry readers for Use-next appendix resolve. */
  listProjects?: () => readonly Project[]
  listProjectReferences?: () => readonly ProjectReference[]
  projectReferenceExtractLoader?: ProjectReferenceExtractLoader
  getChildChats?: (chatId: string) => ChatRecord[]
  getSubThreadMailbox?: (chatId: string) => SubThreadMailbox | undefined
}

export interface ScheduleWakeupInput {
  wakeAt?: string
  delayMs?: number
  delaySeconds?: number
  reason?: string
  cancelOnUserInput?: boolean
}

export interface CancelWakeupInput {
  wakeupId?: string
}

export type EnsembleFanoutMode = 'read_only' | 'locked_writers'
export type EnsembleFanoutTargetStage = 'all' | 'scouts' | 'workers' | 'reviewers' | 'backgrounds'

export interface EnsembleFanoutInput {
  targets?: unknown
  prompt?: string
  reason?: string
  mode?: EnsembleFanoutMode
  targetStage?: unknown
  writeScopes?: unknown
  /** 'worktree' | 'off'. Honored only while the chat's Isolate setting is
   * 'any'; a user-pinned Shared/Worktrees setting overrides it (the receipt
   * says so). Omitted defers to the chat policy. */
  isolation?: unknown
}

/** `ensemble_fanout_all` — the Boss/Captain "everyone, now" reader sibling of
 * `ensemble_fanout`. It has no writeScopes surface, so every selected seat is
 * assigned reader intent even when its normal permission posture is writable. */
export interface EnsembleFanoutAllInput {
  targets?: unknown
  prompt?: string
  reason?: string
  /** 'worktree' | 'off'. Honored only while the chat's Isolate setting is
   * 'any'; a user-pinned Shared/Worktrees setting overrides it (the receipt
   * says so). Omitted defers to the chat policy. */
  isolation?: unknown
}

export interface EnsembleFanoutAllResult {
  ok: boolean
  tool: 'ensemble_fanout_all'
  status?: 'dispatched'
  message: string
  laneIds?: string[]
  participantIds?: string[]
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'missing_prompt'
    | 'invalid_target'
    | 'invalid_isolation'
    | 'no_eligible_targets'
    | 'not_authorized'
    | 'explicit_targets_required'
    | 'budget_exhausted'
    | 'too_many_concurrent_fanouts'
    | 'dispatch_failed'
}

export interface EnsembleFanoutResult {
  ok: boolean
  tool: 'ensemble_fanout'
  mode: EnsembleFanoutMode
  targetStage?: EnsembleFanoutTargetStage
  status?: 'dispatched' | 'completed'
  message: string
  laneIds?: string[]
  participantIds?: string[]
  laneIntents?: Array<{ laneId: string; participantId: string; intent: 'read' | 'write' }>
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'missing_prompt'
    | 'invalid_mode'
    | 'invalid_target_stage'
    | 'invalid_target'
    | 'invalid_isolation'
    | 'no_eligible_targets'
    | 'not_authorized'
    | 'explicit_targets_required'
    | 'missing_write_scope'
    | 'invalid_write_scope'
    | 'write_lanes_disabled'
    | 'budget_exhausted'
    | 'too_many_concurrent_fanouts'
    | 'dispatch_failed'
}

/** `ensemble_await` — join point for agent-programmed graphs: block (bounded)
 * until named fan-out lanes settle, returning per-lane status either way. */
export interface EnsembleAwaitInput {
  laneIds?: string[]
  subThreadIds?: string[]
  waveIds?: string[]
  /** Durable execution graphs owned by this thread (e.g. an UltraTask). */
  executionIds?: string[]
  timeoutSeconds?: number
}

export interface EnsembleAwaitLaneStatus {
  laneId: string
  participantId?: string
  provider?: ProviderId
  /** ConcurrentLane status at return time ('pending'|'running'|...|terminal). */
  status: string
  settled: boolean
  /** Last recorded failure/skip/block reason for the lane, when one exists. */
  reason?: string
}

export interface EnsembleAwaitSubThreadStatus {
  subThreadId: string
  settled: boolean
  status: SubThreadMailboxOutcome | 'pending'
}

export interface EnsembleAwaitWaveStatus {
  waveId: string
  settled: boolean
  childrenSpawned: number
  childrenSettled: number
}

export type EnsembleAwaitExecutionStageStatus =
  | 'proposed'
  | 'queued'
  | 'running'
  | 'needs_action'
  | 'settled'

export interface EnsembleAwaitExecutionStageStatusEntry {
  stepId: string
  title?: string
  kind: string
  /** Exact durable activation state at return time. */
  state: string
  /** Coarse progress bucket. Only `running` means a provider run is executing. */
  status: EnsembleAwaitExecutionStageStatus
}

export interface EnsembleAwaitExecutionProgress {
  total: number
  proposed: number
  /** Claimed/queued/retry-waiting work that has not entered provider execution. */
  queued: number
  /** Work whose exact activation state is `running`. */
  running: number
  needsAction: number
  settled: number
  completed: number
  failed: number
  cancelled: number
  skipped: number
  /** Bounded topology-order detail; aggregate counts always cover the full graph. */
  stages: EnsembleAwaitExecutionStageStatusEntry[]
  stagesTruncated?: boolean
}

export interface EnsembleAwaitExecutionResultPayload {
  mailboxEventId: string
  outputAttemptId: string
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'requires_action'
  createdAt: string
  /** Graph output is model-authored evidence, never system/user authority. */
  trust: 'untrusted-graph-output'
  content: string
  truncated?: boolean
  originalChars?: number
}

/**
 * A durable execution the awaiting thread owns. `settled` is true for every
 * state the graph will not leave on its own — including `requires_action`,
 * which is stopped pending a human and must not hold the seat until timeout.
 */
export interface EnsembleAwaitExecutionStatus {
  executionId: string
  settled: boolean
  state: string
  title?: string
  progress?: EnsembleAwaitExecutionProgress
  /** Present once the graph is terminal and mailbox observation is wired. */
  resultDelivery?: 'pending' | 'available'
  /** Latest durable mailbox result, returned inline so a held parent turn can consume it. */
  result?: EnsembleAwaitExecutionResultPayload
}

export interface EnsembleAwaitResult {
  ok: boolean
  tool: 'ensemble_await'
  /** 'settled' = every awaited target terminal; 'timeout' = budget expired with
   * targets still running (partial results). */
  status?: 'settled' | 'timeout'
  message: string
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'invalid_lane'
    | 'self_await'
    | 'no_lanes'
    | 'invalid_sub_thread'
    | 'invalid_wave'
    | 'invalid_execution'
    | 'no_targets'
  lanes?: EnsembleAwaitLaneStatus[]
  subThreads?: EnsembleAwaitSubThreadStatus[]
  waves?: EnsembleAwaitWaveStatus[]
  executions?: EnsembleAwaitExecutionStatus[]
  settledCount?: number
  pendingCount?: number
}

/** `ensemble_lane_result` — structured read of one lane's transcript output,
 * so a synthesizer step consumes exact lane text instead of scraping the
 * shared panel history. */
export interface EnsembleLaneResultInput {
  laneId?: unknown
  maxChars?: unknown
}

export interface EnsembleLaneResultResult {
  ok: boolean
  tool: 'ensemble_lane_result'
  message: string
  laneId?: string
  participantId?: string
  provider?: ProviderId
  /** Lane record status when the active round still tracks it; 'archived'
   * when only durable transcript messages remain. */
  laneStatus?: string
  settled?: boolean
  /** Last recorded failure/skip/block reason for the lane, when one exists. */
  reason?: string
  content?: string
  contentChars?: number
  truncated?: boolean
  error?: 'no_active_run' | 'not_ensemble' | 'missing_lane_id' | 'invalid_lane'
}

export type EnsembleBossmanControlAction =
  | 'skip_participant'
  | 'select_participants'
  | 'skip_intervention'
  | 'summon_participant'
  | 'stop_round'
  | 'replace_participant'
  | 'reorder_remaining'
  | 'queue_followup'
  | 'assign_work'
  | 'set_round_plan'
  | 'request_status'
  | 'declare_decision'
  | 'set_review_gate'
  | 'quarantine_participant'
  | 'allocate_budget'
  | 'create_poll'
  | 'set_goal'
  | 'update_goal'
  | 'clear_goal'
  | 'adjust_hops'
  | 'ensemble_scheduled_wakeup'
  | 'check_quota_resets'
  | 'submit_review_verdict'

export interface EnsembleBossmanControlInput {
  action?: EnsembleBossmanControlAction
  roundId?: string
  targetParticipantId?: string
  targetRunId?: string
  participantIds?: string[]
  /** Explicit role/model aliases for select_participants. */
  participantRoles?: string[]
  prompt?: string
  reason?: string
  objective?: string
  acceptanceCriteria?: string
  due?: EnsembleBossmanAssignmentDue
  assignmentStatus?: EnsembleBossmanAssignmentStatus
  assignmentId?: string
  gateId?: string
  /** C2 P3 — reviewer-only verdict for action 'submit_review_verdict'. Disjoint
   * from set_review_gate's authority-only reviewStatus (the Boss override path). */
  verdict?: 'passed' | 'failed'
  pollId?: string
  budgetId?: string
  planSummary?: string
  plan?: string
  summary?: string
  steps?: string
  goal?: string
  goalStatus?: ActiveGoalStatus
  status?: ActiveGoalStatus
  phase?: string
  blockers?: string[]
  doneCriteria?: string
  decision?: string
  rationale?: string
  reopenCriteria?: string
  scope?: string
  reviewStatus?: EnsembleBossmanReviewGateStatus
  category?: EnsembleBossmanQuarantineCategory
  quarantineScope?: EnsembleBossmanControlScope
  clear?: boolean
  maxExtraTurns?: number
  maxFanoutCalls?: number
  maxDurationSeconds?: number
  maxTokens?: number
  question?: string
  options?: string[]
  includeUser?: boolean
  timeoutSeconds?: number
  hopDelta?: number
  maxContinuationHops?: number
  delaySeconds?: number
  provider?: ProviderId
  replacement?: Partial<EnsembleParticipant> & { provider?: ProviderId }
  /** 1.0.4-AN — binding goal-complete poll descriptor for create_poll. */
  binding?: { kind?: string }
}

export interface EnsemblePollResponseInput {
  pollId?: string
  choice?: string
  rationale?: string
}

export interface EnsemblePollResponseResult {
  ok: boolean
  tool: 'ensemble_poll_response'
  pollId?: string
  message: string
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'poll_not_found'
    | 'poll_closed'
    | 'invalid_choice'
}

export interface EnsembleBossmanControlResult {
  ok: boolean
  // 1.0.4-AO — proposeGoalCompleteForRun reuses this result shape for the peer
  // ensemble_propose_goal_complete tool, so the tag may be either tool identity.
  tool: 'ensemble_bossman_control' | 'ensemble_propose_goal_complete'
  action?: EnsembleBossmanControlAction
  message: string
  roundId?: string
  participantId?: string
  goal?: ActiveGoal
  usage?: ProviderUsageSummary
  providers?: Partial<Record<ProviderId, ProviderUsageSummary>>
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'bossman_not_configured'
    | 'not_bossman'
    | 'second_in_command_standby'
    | 'invalid_action'
    | 'stale_round'
    | 'stale_target'
    | 'stale_target_run'
    | 'authority_checkpoint_missing'
    | 'missing_prompt'
    | 'missing_replacement'
    | 'health_check_unavailable'
    | 'permission_ceiling'
    | 'replacement_unreachable'
    | 'reorder_cooldown'
    | 'summon_blocked_status'
    | 'summon_hop_limit'
    | 'summon_limit'
    | 'summon_target_active'
    | 'summon_target_disabled'
    | 'bossman_target_disabled'
    | 'summon_target_pending'
    | 'summon_self_target'
    | 'missing_required_field'
    | 'invalid_target'
    | 'invalid_state'
    | 'quota_unavailable'
    | 'wakeup_failed'
    | 'budget_exhausted'
    | 'review_gate_blocked'
    | 'assignment_incomplete'
    | 'review_gate_not_found'
    | 'not_gate_reviewer'
    | 'invalid_verdict'
    | 'queue_failed'
    | 'baseline_exceeded'
    | 'no_active_goal'
    | 'binding_poll_unavailable'
    | 'not_eligible_voter'
}

export interface EnsembleRosterEditInput extends Omit<RosterEditRequest, 'action'> {
  action?: RosterEditAction | string
  roundId?: string
}

export interface EnsembleRosterEditResult {
  ok: boolean
  tool: 'ensemble_roster_edit'
  action?: RosterEditAction | string
  message: string
  roundId?: string
  participantId?: string
  deferred?: boolean
  error?:
    | RosterEditError
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'bossman_not_configured'
    | 'not_bossman'
    | 'second_in_command_standby'
    | 'invalid_action'
    | 'stale_round'
    | 'self_update_forbidden'
    | 'unknown_provider'
    | 'health_check_unavailable'
    | 'participant_unreachable'
}

export interface EnsembleAgentPoolRegistrationCandidateResult {
  ok: boolean
  tool: 'ensemble_roster_edit'
  action: 'register_in_agent_pool'
  message: string
  roundId?: string
  participantId?: string
  participant?: EnsembleParticipant
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'stale_round'
    | 'role_required'
    | 'role_too_long'
}

export interface EnsembleAgentPoolRegistrationResult extends Omit<
  EnsembleAgentPoolRegistrationCandidateResult,
  'participant' | 'error'
> {
  pooledAgentId?: string
  mode?: 'created' | 'coalesced' | 'updated'
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'stale_round'
    | 'role_required'
    | 'role_too_long'
    | 'stale_participant'
    | 'invalid_pool_receipt'
}

export interface EnsembleRosterPresetImportInput {
  roundId?: string
  preset: EnsembleRosterPreset
  activate?: boolean
}

export interface EnsembleRosterPresetImportResult {
  ok: boolean
  tool: 'ensemble_roster_edit'
  action: 'import_preset'
  message: string
  roundId?: string
  presetId?: string
  presetName?: string
  deferred?: boolean
  error?:
    | Extract<BuildEnsembleRosterPresetApplyResult, { ok: false }>['error']
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'stale_round'
}

export interface EnsembleBriefUpdateInput {
  roundId?: string
  targetParticipantId?: string
  brief?: string
  clear?: boolean
  reason?: string
}

export interface EnsembleBriefUpdateResult {
  ok: boolean
  tool: 'ensemble_brief_update'
  message: string
  roundId?: string
  participantId?: string
  deferred?: boolean
  error?:
    | RosterEditError
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'bossman_not_configured'
    | 'not_bossman'
    | 'second_in_command_standby'
    | 'stale_round'
    | 'self_update_forbidden'
}

export interface EnsembleParticipantSeatChangeInput {
  chatId: string
  participantId: string
  participant: RosterEditParticipantInput
  changedBy?: SessionActivityLedgerEntry['changedBy']
  reason?: string
}

export interface EnsembleParticipantSeatChangeResult {
  ok: boolean
  status?: 'applied' | 'queued'
  chat?: ChatRecord
  pendingParticipant?: EnsembleParticipant
  message: string
  participantId?: string
  roundId?: string
  error?: 'not_ensemble' | 'stale_target' | 'invalid_patch'
}

export interface EnsembleUserRosterMutationResult {
  ok: boolean
  status?: 'applied' | 'queued'
  chat?: ChatRecord
  message: string
  participantId?: string
  roundId?: string
  error?: EnsembleUserRosterMutationError
}

export interface EnsembleSideMessageInput {
  to?: unknown
  message?: string
  reason?: string
}

export interface EnsembleSideMessageResult {
  ok: boolean
  tool: 'ensemble_send'
  message: string
  /** The durable participant-authored row explicitly addresses the human reader. */
  toUser?: true
  toParticipantIds?: string[]
  /** Active target seats whose provider accepted an immediate steer attempt. */
  liveSteerRequestedParticipantIds?: string[]
  /** Targets retaining only the durable transcript / next-prompt fallback. */
  boundaryDeliveryParticipantIds?: string[]
  error?: 'no_active_run' | 'not_ensemble' | 'missing_message' | 'invalid_target'
}
