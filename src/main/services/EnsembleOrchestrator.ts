import { isAbsolute, relative, resolve, sep } from 'node:path'
import { statsAreEstimated } from '../../shared/tokenEstimate'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../../shared/ensembleLimits'
import {
  clearEnsembleRoundFailureForSeatChange,
  ensembleSeatExecutionConfigChanged
} from '../../shared/ensembleSeatFailureClear'
import type { AgentRunPayload, AgentRunRoute, RunDispatchObserver } from '../run/AgentRunTypes'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  applyUnattendedSimulatorCanvasOverride,
  unattendedElevationPresetId,
  unattendedSubThreadDelegationOverride,
  type UnattendedElevationLevel
} from '../UnattendedPostureGate'
import {
  buildRunPermissionPostureSnapshot,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import type { TrustedSessionScope } from '../TrustedSessionGrants'
import {
  buildEnsembleDynamicStateSnapshot,
  buildEnsembleParticipantPromptProjection,
  computeEnsemblePromptShellStamp,
  findUncoveredEnsemblePromptMessageIds,
  getOrderedEnsembleParticipants,
  providerLabel,
  resolveForegroundSynthesizerParticipantId
} from '../EnsemblePrompt'
import {
  resolveRunSkillHookContext,
  type RunSkillHookContext
} from '../skillsHooks/resolveRunSkillHookContext'
import { buildProviderShellRoutingPrompt } from '../ProviderShellRoutingPrompt'
import {
  ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON,
  isAntigravityHeadlessPermissionNoOutput
} from '../antigravity/AntigravityRunDiagnostics'
import { evaluateBossQuotaSoftUnavailable } from '../BossQuotaSoftUnavailable'
import {
  configuredEnsembleCaptainParticipantIds,
  resolveActingCaptainParticipantId
} from '../EnsembleAuthorityResolution'
import type {
  ActiveGoal,
  ActiveGoalStatus,
  AppSettings,
  ChatMessage,
  ChatRecord,
  ChatRun,
  ConcurrentLane,
  ConcurrentLaneWriteScope,
  EffectiveRunPermissions,
  EnsembleConfig,
  EnsembleBossmanAssignmentDue,
  EnsembleBossmanAssignmentStatus,
  EnsembleBossmanBudget,
  EnsembleBossmanControlScope,
  EnsembleBossmanPoll,
  EnsembleBossmanPollResolution,
  EnsembleBossmanPollVote,
  EnsembleBossmanQuarantine,
  EnsembleBossmanQuarantineCategory,
  EnsembleBossmanReviewGateStatus,
  EnsembleFanoutIsolation,
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  EnsembleParticipant,
  EnsembleParticipantStatus,
  EnsembleQueuedPromptState,
  EnsembleRunIdentity,
  EnsembleRoundParticipantState,
  EnsembleRoundState,
  EnsembleSeatSnapshot,
  EnsembleStageRole,
  EnsembleWakeupRecord,
  ExternalPathGrant,
  PooledAgentIdentitySnapshot,
  ProviderId,
  RunQueueJobStatus,
  SessionActivityLedgerEntry,
  ToolActivity,
  ToolActivityStatus,
  TranscriptMediaRef,
  UsageRecord
} from '../store/types'
import { resolveEnsembleFanoutIsolationPolicy } from '../store/types'
import type { SeatChangeSeatState } from '../store/types'
import {
  coalesceSeatChangeMessages,
  coalesceSeatRosterMessages,
  resolveSeatAuthority
} from '../../shared/seatChange'
import type { SeatRosterSeat } from '../../shared/seatChange'
import { yieldTargetDisplayLabel } from '../../shared/ensembleYieldTarget'
import {
  findAllMentions,
  resolvePhraseToParticipant,
  resolveYieldTargetDetail,
  type ParticipantMentionMatch
} from './EnsembleMentionAlias'
import {
  collectAuthorityOnlyContinuationCandidateIds,
  preservesInitialPassRoster,
  resolveAuthoritySelection,
  shouldAttachContinuousAuthoritySelectionCheckpoint,
  shouldResummonAuthorityForUnresolvedRouting,
  type EnsembleAuthorityRoutingCheckpoint,
  type EnsembleAuthorityRoutingDecision
} from '../EnsembleAuthorityRouting'
import type {
  EnsembleYieldOutcome,
  EnsembleYieldRoutingResult,
  StoredYieldRouting
} from '../EnsembleYieldRouting'
import {
  storedYieldRoutingFromResult,
  suggestUniqueYieldAliases,
  yieldRejectStatusLine,
  yieldRouteSuccessStatusLine
} from '../EnsembleYieldRouting'
import {
  backgroundDispatchFailureStatusLine,
  isBackgroundDispatchFailure,
  preflightBackgroundDispatchTarget,
  resolveBackgroundDispatchPosture,
  type BackgroundDispatchResult
} from './EnsembleBackgroundDispatch'
import {
  classifyDispatchError,
  isExternalPathGrantAuthorityMessage,
  formatAllUnreachableNote,
  formatDispatchFailureNote,
  formatYieldTargetUnreachableNote,
  PARTICIPANT_HEALTH_TAG,
  type DispatchFailureReason
} from '../EnsembleErrors'
import { collectExternalPathGrantsFromMetadata } from '../store/ExternalPathGrants'
import { resolveImagePathsForProvider } from '../ProviderImageAttachmentSupport'
import { resolveHealthEntryPresentation } from '../../shared/ollamaBrandTable'
import {
  CONTEXT_AUTO_COMPACT_COOLDOWN_MS,
  CONTEXT_COMPACTION_MESSAGE_KIND,
  contextCompactionMessageId,
  contextPressureSeverity,
  formatContextCompactionSummary,
  isContextOverflowErrorText,
  shouldAutoCompactHostContext,
  type ContextCompactionProgressEvent,
  type ContextCompactionSignal,
  type ContextPressureSeverity
} from '../../shared/contextCompaction'
import type { ScoutBriefRecord } from '../ScoutBrief'
import { isMeasuredDiffSummary } from '../../shared/toolDiffSummaryMerge'
import { sampleWorkspaceChurn } from '../DiffService'
import {
  diffWorkspaceChurn,
  formatWorkspaceChurnStanza,
  type WorkspaceChurnSample
} from '../WorkspaceChurn'
import {
  createActiveGoal,
  normalizeActiveGoalObjective,
  shouldMintFreshGoalIdentity,
  updateActiveGoalLifecycle
} from '../GoalState'
import { gateBlocksActiveGoal } from '../ReviewGateScope'
import { findTerminalSynthesizerRoundSummary } from '../EnsembleRoundSummary'
import { mergeTranscriptMediaRefs } from './TranscriptMediaService'
import {
  planEnsembleMidRunSteeringBoundary,
  type EnsembleMidRunSteeringBoundaryState
} from './EnsembleMidRunSteering'
import { buildCursorPathBCompactionSummary } from './CursorContextPressureRecovery'
import { resolveEnsembleUserFanoutTargets } from './EnsembleUserFanout'
import { EnsembleChatFlushScheduler } from './ensembleChatFlushScheduler'
import { sanitizeRawProviderMediaRefs } from '../../shared/transcriptMediaRefSanitize'
// M4 (1.0.7) — auto-derive blackboard entries from the synthesizer's
// round summary at round end, so the panel's agreed decisions / risks /
// corrections propagate to next round's prompts as a compact digest.
import {
  deriveBlackboardFromRoundSummary,
  makeBlackboardEntry,
  markBlackboardEntriesSeen,
  selectBlackboardForRound,
  selectUnseenBlackboard,
  upsertBlackboardEntry
} from '../blackboard/Blackboard'
// M5 (1.0.7) — emit advisory complexity-escalation signals at round end
// (stuck / looping / disagreement-unresolved / tool-error-cluster). Events
// only — never auto-acted on; the renderer surfaces them as chips.
import {
  appendEscalationSignals,
  detectComplexityEscalation
} from '../escalation/ComplexityEscalation'
import type { SessionCheckpointReason } from '../checkpoints/SessionCheckpoint'
import {
  buildLaneId,
  canStartConcurrentRound,
  createLane,
  isTerminalLaneStatus,
  roundHasActiveLanes,
  transitionLane
} from '../EnsembleLanes'
import { openFanoutWaves, refuseForConcurrentFanouts } from '../EnsembleFanoutConcurrency'
import type { OpenFanoutWave } from '../EnsembleFanoutConcurrency'
import {
  concurrentLanesEnabled,
  concurrentWriteLanesEnabled,
  ensembleSlimResumeEnabled
} from '../featureGates'
// 1.0.7 — pure builder turning a finished participant run's stats into the
// recordUsage payload, so ensemble runs reach usage.json (wall-clock + heatmaps
// + provider totals). Ensemble runs complete here, not via handleProviderExit.
import { buildEnsembleUsageRecord } from '../ensembleUsageRecord'
import { bridgeResultDiffStats, bridgeToolDiffStats } from '../bridge/BridgeToolDiffStats'
import { foldBridgeRunText, isTaggedCumulativeRestatement } from '../bridge/BridgeTextFold'
import {
  formatDiscordContextPromptAppendix,
  normalizeDiscordContextSnapshots,
  redactDiscordContextReadMetadataForHistory,
  type DiscordContextReadMetadata,
  type DiscordContextSnapshot
} from '../channels/DiscordContextService'
import { formatEnsembleProjectReferenceAppendix } from '../EnsembleProjectReferenceAppendix'
import {
  formatProjectReferenceExtractsPromptAppendix,
  resolveProjectReferenceContext,
  type ProjectReferenceExtractLoader
} from './ProjectReferenceContextService'
import type { ProjectReferenceContextSelection } from '../../shared/projectReferenceContext'
import type { Project, ProjectReference } from '../../shared/projects'
import {
  contextPercent,
  isContextWindowProviderId,
  resolveContextWindow
} from '../../shared/contextWindows'
import { isEnsembleRoundDispatchLive } from '../../shared/ensembleRoundLifecycle'
import type { ParticipantWorkingTelemetryEvent } from '../../shared/participantWorkingTelemetry'
import {
  contextUsageFromStats,
  contextUsageSnapshotsEqual,
  type ContextUsageSnapshot
} from '../../shared/contextUsage'
import { isCursorGrok45ModelId, isGrok45ReasoningModelId } from '../../shared/grok45Models'
import { isKimiK3Model } from '../providers/StaticProviderModels'
import { isPreviewRiskModel } from '../../shared/previewModelCatalog'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import { summarizeProviderUsage, type ProviderUsageSummary } from '../ProviderUsageStatus'
import {
  EnsembleCursorCompletionWatchdog,
  type CursorTransportLiveness
} from './EnsembleCursorCompletionWatchdog'
import {
  resolveEffectiveRoster,
  isExternalSeat,
  type ExternalSeatInput
} from '../../shared/effectiveEnsembleRoster'
import { makeDeliveredExternalContribution } from '../collaboration/HumanCollaboratorMessages'
import type {
  ExternalContributionEntry,
  ExternalContributionQueueStore
} from '../collaboration/ExternalContributionQueueStore'
import {
  ASSIGNABLE_PERMISSION_PRESETS,
  claudeRosterSessionRelinkError,
  evaluateRosterEdit,
  type RosterEditAction,
  type RosterEditError,
  type RosterEditParticipantInput,
  type RosterEditRequest
} from '../EnsembleRosterMutation'
import { selectableProviderIds } from '../settings/MainSanitizers'
import { isEnsembleSeatProvider } from '../../shared/retiredProviders'
import { buildRunQueueDispatchReceipt } from '../RunQueueDispatchReceipt'
import { isCodexAppServerThreadId } from '../CodexSessionIdentity'
import {
  buildEnsembleParticipantProviderCatalog,
  type EnsembleParticipantProviderCatalogEntry
} from '../EnsembleParticipantCatalog'
import type { EnsembleRosterPreset } from '../EnsembleRosterPresetContract'
import {
  applyPendingEnsembleRosterPresetOnFinalize,
  buildEnsembleRosterPresetApply,
  queuePendingEnsembleRosterPresetApply,
  type BuildEnsembleRosterPresetApplyResult,
  type PendingEnsembleRosterPresetApply
} from '../EnsembleRosterPresetApply'
import {
  resolveEnsembleUserRosterMutation,
  type EnsembleUserRosterMutationError,
  type EnsembleUserRosterMutationInput,
  type ResolvedEnsembleUserRosterMutation
} from '../EnsembleUserRosterMutation'
import {
  isHostSeatCompactionProvider,
  isProductionKimiAcpSeat,
  persistedSeatRuntimeState,
  seatOverflowEvidenceKey,
  type HostSeatCompactionProvider,
  type PendingSeatOverflowEvidence
} from './EnsembleSeatRuntimePosture'

export type EnsembleRunMode = 'normal' | 'queue' | 'steer'
export type EnsembleQueuedSteerResult = {
  status: 'steered' | 'ignored'
  roundId?: string
  error?: string
}

interface MidRunSteeringAppendReceipt {
  messageId: string
  entryId: string
}

const ASSIGNABLE_PERMISSION_PRESET_SET = new Set<string>(ASSIGNABLE_PERMISSION_PRESETS)
const ENSEMBLE_SEAT_STAGE_ROLES = new Set<string>(['scout', 'worker', 'reviewer', 'background'])
const SESSION_ACTIVITY_LEDGER_LIMIT = 40
const MAX_BOSSMAN_BRIEF_CHARS = 4000
const BRIEF_SEAT_VALUE_PREVIEW_CHARS = 160
const CONTINUATION_BLOCKED_PARTICIPANT_STATUSES = new Set<EnsembleParticipantStatus>([
  'answered',
  'yielded',
  'skipped',
  'cancelled',
  'failed',
  'unreachable'
])
// Outcome of `tryAppendContinuationTurn`. When it declines, the caller needs the
// REASON so it can report accurately (e.g. a Boss priority @-mention that can't be
// re-summoned should say WHY — hop budget vs. the Boss run failed/was skipped —
// rather than always blaming the hop budget).
type ContinuationTurnResult =
  | { appended: true }
  | {
      appended: false
      reason:
        | 'not_continuous'
        | 'outside_round_scope'
        | 'unreachable'
        | 'active_fanout'
        | 'blocked_status'
        | 'hop_limit'
        | 'budget_exhausted'
      blockedStatus?: EnsembleParticipantStatus
      budgetMessage?: string
    }
export type EnsembleQueuedPromptMutationResult = {
  ok: boolean
  prompt?: string
  queuedPrompts?: string[]
  /** Attachment snapshots from the removed entry so Edit can restore them. */
  imageAttachments?: Array<{ id?: string; path: string; name?: string }>
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

/**
 * 1.0.7 — sentinel workspace id for global-chat ensemble usage records. MUST
 * stay byte-identical to the renderer's `GLOBAL_USAGE_WORKSPACE_ID`
 * (App.tsx) so global-chat ensemble usage buckets into the same workspace
 * tally the solo path uses. Hard-coded (not imported) because the renderer
 * const isn't reachable from the main process.
 */
const ENSEMBLE_GLOBAL_USAGE_WORKSPACE_ID = '__taskwraith_global_chats__'
const DEFAULT_CONTINUATION_HOP_LIMIT = 6
const MAX_BOSSMAN_SUMMONS_PER_PARTICIPANT_PER_ROUND = 3
const MAX_CONTINUATION_HOP_LIMIT = 1200
const MAX_BOSSMAN_CONTROL_ITEMS = 40
const MAX_BOSSMAN_POLL_OPTIONS = 6
// 1.0.4-AN — binding goal-complete poll. Options are FIXED so resolution is
// deterministic; a FAILED/vetoed poll sets a cooldown before another may open.
const BINDING_GOAL_COMPLETE_OPTIONS = ['complete', 'keep-working'] as const
const BINDING_POLL_DEFAULT_TIMEOUT_SECONDS = 300
const BINDING_POLL_COOLDOWN_MS = 10 * 60 * 1000
const ENSEMBLE_IMAGE_ATTACHMENT_EXT =
  /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff|tif|svg|jfif)(\?.*)?$/i
// The visual Odometer roll takes 430ms. Coalescing provider usage snapshots to
// roughly two per second lets each roll finish, while keeping the event lane
// ephemeral and far below the transcript's streaming cadence.
const PARTICIPANT_WORKING_TELEMETRY_MIN_INTERVAL_MS = 450
// 1.0.7 — hard upper bound on how long a Boss/Captain foreground turn waits
// for its owned fan-out lanes to settle. Prevents a stalled lane from pinning
// the serial queue indefinitely; the caller synthesizes with partial results
// after timeout. Measured in milliseconds.
//
// This is a LIVENESS BACKSTOP, never a lane's effective cap — the same doctrine
// the broker's long-poll kill follows for ensemble_await. At the old 75s it WAS
// the cap, 8x under the await ceiling: a lane doing nothing more exotic than one
// maximal ensemble_await outlived its owner's wait, so the owner was handed off
// with fanoutTimedOut and the late settlement reached releaseOwnedFanoutHold to
// find a closed round — latching permanentSuppress and discarding the owner's
// held synthesis for good, which reads as a Boss truncated mid-dispatch. Stop
// still releases the wait at once (waitForOwnedFanoutSettlements breaks on
// runtime.cancelled), so the longer ceiling stays user-interruptible.
//
// Lockstep with ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS (600s), spelled literally
// because that const is declared ~1250 lines below and would be in the temporal
// dead zone here. The guard in EnsembleOrchestrator.fanoutOptionB.test.ts holds
// the two together.
export const DEFAULT_OWNED_FANOUT_SETTLEMENT_TIMEOUT_MS = 600 * 1000
const TERMINAL_RUN_TOOL_TOMBSTONE_TTL_MS = 2 * 60 * 1000
const TERMINAL_RUN_TOOL_TOMBSTONE_LIMIT = 256

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
}

/**
 * Per-run chronological event log. Each entry preserves the order
 * the orchestrator observed content / tool events, so the flush
 * pass can materialise the participant's turn as a sequence of
 * interleaved messages (the natural "speak, do, speak, do" flow
 * most agents follow). Pre-1.0.3-post-ship the orchestrator
 * batched all content into one assistant message + all tool calls
 * into one tool message, which read as "wall of text, then wall
 * of operations" — not the inline experience the maintainer wanted.
 *
 *   - `{ kind: 'content', text }` — accumulated content for this
 *     chunk. Consecutive content events without an intervening tool
 *     concatenate into the SAME entry. New content after a tool
 *     event opens a fresh entry.
 *   - `{ kind: 'tool', toolId }` — references the tool activity by
 *     id (stored in `run.toolActivities`). Tool results pair back
 *     into the activity but don't add a new timeline entry — the
 *     existing tool entry's activity gets updated in place.
 */
type ParticipantTimelineEntry = { kind: 'content'; text: string } | { kind: 'tool'; toolId: string }

/**
 * Providers with a live, qualified session-resume transport across ensemble
 * turns. Marked Kimi Code ACP seats join this set because session/resume
 * restores native history; legacy Kimi is filtered at the call site. Grok's
 * default ACP transport opens a fresh session every turn and Ollama is
 * stateless, so neither is eligible.
 */
const SLIM_RESUME_PROVIDERS: ReadonlySet<ProviderId> = new Set(['claude', 'codex', 'kimi'])

type EnsemblePromptUsageTelemetry = Required<
  Pick<
    UsageRecord,
    | 'ensemblePromptKind'
    | 'ensembleDynamicStateBlockChars'
    | 'ensembleDynamicStateSent'
    | 'ensembleDynamicStateReceiptState'
  >
>

function buildEnsemblePromptUsageTelemetry(input: {
  slimTurn: boolean
  dynamicStateBlockChars: number
  dynamicStateVersion: string
  priorDynamicStateReceipt?: string
}): EnsemblePromptUsageTelemetry {
  const receiptState = input.priorDynamicStateReceipt
    ? input.priorDynamicStateReceipt === input.dynamicStateVersion
      ? 'matched'
      : 'changed'
    : 'missing'
  return {
    ensemblePromptKind: input.slimTurn ? 'slim' : 'full',
    ensembleDynamicStateBlockChars: input.dynamicStateBlockChars,
    ensembleDynamicStateSent:
      !input.slimTurn || input.priorDynamicStateReceipt !== input.dynamicStateVersion,
    ensembleDynamicStateReceiptState: receiptState
  }
}

interface ActiveParticipantRun {
  chatId: string
  roundId: string
  runId: string
  /**
   * Main-side provider admission state for this exact run id. History deletion
   * uses this after joining an in-flight dispatch receipt: a cancellation that
   * raced before adapter registration is not proof that an accepted transport
   * stopped.
   */
  transportDispatchState?: 'pending' | 'accepted' | 'rejected' | 'unknown'
  /** One silent remint+retry after a stale secondary-workspace grant refusal. */
  externalPathGrantRepairAttempted?: boolean
  /** At least one exact provider cancellation returned an affirmative receipt. */
  transportCancellationConfirmed?: boolean
  laneId?: string
  laneIntent?: ConcurrentLane['intent']
  /** Durable dispatch-wave identity for transcript grouping after reload. */
  fanoutWaveId?: string
  fanoutLabel?: string
  fanoutCategory?: 'user' | 'orchestrated'
  approvedWriteScopes?: ConcurrentLaneWriteScope[]
  /**
   * Detached reader/writer fan-out passes launched by this foreground run.
   * The MCP call returns after dispatch, but the foreground handoff waits on
   * these settlements so a yield/@mention/default rotation cannot escape its
   * caller while that caller's lane results are still in flight. Background
   * lanes are deliberately excluded and remain detached.
   */
  ownedFanoutSettlements?: Set<Promise<void>>
  /** Concrete lane runs represented by the owned settlements. */
  ownedFanoutRunIds?: Set<string>
  /**
   * Explicit fan-out calls that have entered the owner queue but have not yet
   * produced a dispatch receipt. These are ownership barriers too: a provider
   * can exit while a target seat is compacting or its dispatch is pending, and
   * foreground rotation must not escape before that call either accepts lanes
   * or fails closed.
   */
  pendingFanoutDispatches?: Set<Promise<void>>
  /**
   * User cancellation/skip landed while an explicit fan-out call was still
   * inside its dispatch window. Unlike an ordinary answered/yielded terminal
   * owner, this owner must not accept a late dispatch receipt: the target may
   * have been seeded before the provider adapter registered it, so cancellation
   * is repeated after the receipt to close that race.
   */
  fanoutDispatchCancelled?: boolean
  /** Per-owner tail that serializes explicit fan-out dispatch windows. */
  fanoutDispatchQueue?: Promise<void>
  /**
   * Set when a caller's owned fan-out lanes do not settle within the enforced
   * timeout. The caller must synthesize with partial results; routing proceeds
   * only after the synthesis hold is released.
   */
  fanoutTimedOut?: boolean
  /**
   * Set after owned fan-out lanes settle if the caller has produced no post-
   * fan-out timeline content. The turn remains force-persisted until the
   * caller emits synthesis prose or the hold is explicitly released.
   */
  fanoutSynthesisRequired?: boolean
  /**
   * Reentrancy guard so a synthesis-triggered release can call flushRun
   * without recursing back into releaseOwnedFanoutHold.
   */
  releasingOwnedFanoutHold?: boolean
  /**
   * Timeline length when the first owned fan-out was accepted. Entries before
   * this boundary (the caller's setup/tool invocation) may remain visible;
   * later synthesis/handoff output is buffered until every owned lane settles.
   */
  ownedFanoutTranscriptBoundary?: number
  /** Prevent the first post-fan-out content delta from mutating the final
   * pre-boundary content entry in place. */
  forceNextTimelineContentEntry?: boolean
  /** One-shot placement hint used when a fully-buffered source had no earlier
   * timeline row to anchor. Its released output belongs after the lane reports. */
  releaseOwnedFanoutTranscriptAtTail?: boolean
  /** Stop/cancel permanently discards post-boundary owner output. Settlement
   * callbacks must never turn this back into a normal tail release. */
  suppressOwnedFanoutTranscriptRelease?: boolean
  /** Whether the user has been told that discard happened. Deliberately NOT
   * `suppressOwnedFanoutTranscriptRelease` itself: `finalizeRun` raises that
   * flag while the lanes are still outstanding, so by the time the discard is
   * final it is always already true and could never gate a one-shot notice. */
  discardedSynthesisNoticePosted?: boolean
  /** Terminal provider state can arrive before owned lanes settle. Persist it
   * only when the buffered transcript is released. */
  terminalFinalized?: boolean
  terminalReason?: string
  /**
   * Cursor Path-B context-pressure recovery: the hung child is cancelled and
   * the same seat will be re-dispatched after a host prune. Keep the roster
   * chip in `running` and skip failed/skipped coda copy.
   */
  cursorContextPressureRecovery?: boolean
  /** Terminal bookkeeping is deferred with a held transcript and applied once. */
  terminalSideEffectsApplied?: boolean
  /** Participant token totals merge once, on the effective terminal flush. */
  terminalTokenTotalsApplied?: boolean
  /**
   * Present only for an active Boss/Captain turn that was explicitly called
   * back by a peer or that owns a later Continuous pass. The checkpoint stays
   * run-scoped: a provider restart cannot manufacture authority over a fresh
   * run, and the host remains authoritative for every resulting queue edit.
   */
  authorityRoutingCheckpoint?: EnsembleAuthorityRoutingCheckpoint
  /** Explicit host-admitted response to the attached authority checkpoint. */
  authorityRoutingDecision?: EnsembleAuthorityRoutingDecision
  participant: EnsembleParticipant
  promptMessageId: string
  /**
   * Legacy single-slot id, kept so existing code that references
   * `run.assistantMessageId` still compiles. The timeline-based
   * flush below now generates per-entry ids via `timelineMessageId`,
   * but the legacy id is still set on `seedParticipantRun` for any
   * back-compat consumers (none remain in this file).
   */
  assistantMessageId: string
  /**
   * Per-run tool-activity accumulator. The renderer-side activity
   * objects (toolName, status, params, etc.) live here; the
   * timeline references them by id.
   */
  toolActivities?: ToolActivity[]
  /**
   * Ordered list of message-materialisation entries. Content + tool
   * entries are interleaved as the orchestrator observes them, so
   * `flushRun` can emit a sequence of messages that mirrors the
   * actual turn chronology.
   */
  timeline?: ParticipantTimelineEntry[]
  /**
   * Agent-produced media (image tool results) for this run, accumulated from
   * `media_refs` provider compat lines. Stamped onto the run's last content
   * message in `flushRun` so it survives re-flushes (the renderer's
   * `assistant_media_refs` path is correctly suppressed for ensemble — it can't
   * route by runId — so the orchestrator owns ensemble media just like text).
   */
  mediaRefs?: TranscriptMediaRef[]
  startedAt: string
  /**
   * Spike 5 — the ensemble prompt-shell stamp in effect when this run was
   * dispatched. Persisted onto the participant's `promptShellVersion` in
   * flushRun so the NEXT dispatch can decide slim-vs-full.
   */
  promptShellStamp?: string
  /**
   * Candidate receipt for the dynamic ensemble-state snapshot sent with this
   * prompt. Set only after dispatch accepts the payload; persisted only on a
   * successful terminal flush.
   */
  promptDynamicStateVersion?: string
  /** Content-free prompt receipt/savings telemetry for the accepted payload. */
  ensemblePromptUsageTelemetry?: EnsemblePromptUsageTelemetry
  /**
   * A provider-native compaction replaced the seat's session context after the
   * prompt was dispatched. Never acknowledge either old receipt at final flush.
   */
  invalidatePromptShellReceipt?: boolean
  invalidatePromptDynamicStateReceipt?: boolean
  /**
   * A provider error channel carried a narrowly-classified context-window
   * overflow for this active run. This is evidence only: callbacks never
   * compact inline, and only a failed terminal outcome may promote it to the
   * per-seat maintenance queue.
   */
  classifiedContextOverflow?: boolean
  /**
   * A provider-specific diagnostic observed before the terminal result. This
   * is deliberately a fixed, narrow classification rather than raw stderr so
   * a native provider cannot inject arbitrary terminal reason text.
   */
  providerDiagnostic?: string
  /**
   * Blackboard entry ids injected into THIS run's prompt (full board on a
   * full briefing; unseen-only on a slim resumed turn). flushRun merges the
   * participant into each entry's `seenBy`, which is what lets the NEXT slim
   * turn drop them from the digest. Set alongside `promptShellStamp` — only
   * once the provider actually received the prompt.
   */
  injectedBlackboardEntryIds?: string[]
  /**
   * Aggregate text for back-compat consumers (per-run token stats,
   * "did this run produce any output" checks, etc.). Stays in sync
   * with the concatenation of every content timeline entry.
   */
  content: string
  status: EnsembleParticipantStatus
  lastContentItemId?: string
  actualModel?: string
  providerSessionId?: string
  stats?: any
  completion?: (status: EnsembleParticipantStatus) => void
  /**
   * Legacy per-run debounce handle. scheduleFlush is now chat-keyed
   * (EnsembleChatFlushScheduler); this field remains only so older
   * immediate-clear paths stay harmless if a stale timer reference lingers.
   */
  flushTimer?: ReturnType<typeof setTimeout>
}

function isDynamicStateReceiptTerminalStatus(status: EnsembleParticipantStatus): boolean {
  return status === 'answered' || status === 'yielded' || status === 'sleeping'
}

interface ConcurrentWriteScopeClaim {
  participantId: string
  participantRole: string
  provider: ProviderId
  scopes: ConcurrentLaneWriteScope[]
  operations: string[]
  rationale?: string
  canFallbackToSerial: boolean
}

interface ConcurrentWriteScopePreflight {
  claims: ConcurrentWriteScopeClaim[]
  scopesByParticipantId: Map<string, ConcurrentLaneWriteScope[]>
  matrixSummary: string
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

/** `ensemble_fanout_all` — the Boss/Captain "everyone, now" sibling of
 * `ensemble_fanout`. No mode/stage/writeScopes surface: stage filters and
 * per-seat permission ELIGIBILITY filters do not apply, and every lane runs
 * under its own normal-turn posture (see fanoutAllForRun). */
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
  laneIds?: unknown
  timeoutSeconds?: unknown
}

export interface EnsembleAwaitLaneStatus {
  laneId: string
  participantId: string
  provider: ProviderId
  /** ConcurrentLane status at return time ('pending'|'running'|...|terminal). */
  status: string
  settled: boolean
}

export interface EnsembleAwaitResult {
  ok: boolean
  tool: 'ensemble_await'
  /** 'settled' = every awaited lane terminal; 'timeout' = budget expired with
   * lanes still running (partial results in `lanes`). */
  status?: 'settled' | 'timeout'
  message: string
  lanes?: EnsembleAwaitLaneStatus[]
  settledCount?: number
  pendingCount?: number
  error?: 'no_active_run' | 'not_ensemble' | 'invalid_lane' | 'self_await' | 'no_lanes'
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
    | 'initial_pass_preserves_roster'
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
    | 'summon_not_continuous'
    | 'summon_target_active'
    | 'summon_target_disabled'
    | 'summon_target_pending'
    | 'summon_self_target'
    | 'missing_required_field'
    | 'invalid_target'
    | 'invalid_state'
    | 'quota_unavailable'
    | 'wakeup_failed'
    | 'budget_exhausted'
    | 'review_gate_blocked'
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
  toParticipantIds?: string[]
  error?: 'no_active_run' | 'not_ensemble' | 'missing_message' | 'invalid_target'
}

const ENSEMBLE_FANOUT_POLICIES: EnsembleFanoutPolicy[] = [
  'off',
  'read_only',
  'all',
  'locked_writers_with_boss',
  'locked_writers_user_preflight'
]

/** Stable per-timeline-entry message id. Includes the runId + the
 * entry's ordinal so the same entry always resolves to the same id
 * across flush passes, letting `flushRun` replace-in-place rather
 * than emit duplicates. */
function timelineMessageId(runId: string, index: number, kind: 'content' | 'tool'): string {
  return `ensemble-${kind}-${runId}-${index}`
}

function laneTranscriptMetadata(run: ActiveParticipantRun): {
  ensembleLaneId?: string
  ensembleLaneIntent?: ConcurrentLane['intent']
  ensembleFanoutWaveId?: string
  ensembleFanoutLabel?: string
  ensembleFanoutCategory?: 'user' | 'orchestrated'
} {
  return run.laneId
    ? {
        ensembleLaneId: run.laneId,
        ensembleLaneIntent: run.laneIntent || 'read',
        ...(run.fanoutWaveId ? { ensembleFanoutWaveId: run.fanoutWaveId } : {}),
        ...(run.fanoutLabel ? { ensembleFanoutLabel: run.fanoutLabel } : {}),
        ...(run.fanoutCategory ? { ensembleFanoutCategory: run.fanoutCategory } : {})
      }
    : {}
}

function messageLaneOrder(message: ChatMessage): number {
  const order = message.metadata?.ensembleOrder
  return typeof order === 'number' && Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER
}

function messageLaneParticipantId(message: ChatMessage): string {
  const participantId = message.metadata?.ensembleParticipantId
  return typeof participantId === 'string' ? participantId : ''
}

function messageLaneId(message: ChatMessage): string {
  const laneId = message.metadata?.ensembleLaneId
  return typeof laneId === 'string' ? laneId : ''
}

function compareRunLaneToMessage(run: ActiveParticipantRun, message: ChatMessage): number {
  const orderDelta = (run.participant.order ?? Number.MAX_SAFE_INTEGER) - messageLaneOrder(message)
  if (orderDelta !== 0) return orderDelta
  const participantDelta = run.participant.id.localeCompare(messageLaneParticipantId(message))
  if (participantDelta !== 0) return participantDelta
  return (run.laneId || '').localeCompare(messageLaneId(message))
}

function isComparableFanoutTimelineMessage(
  message: ChatMessage,
  run: ActiveParticipantRun
): boolean {
  if (message.metadata?.ensembleRoundId !== run.roundId) return false
  const laneId = messageLaneId(message)
  if (!laneId || laneId === run.laneId) return false
  if (message.role !== 'assistant' && message.role !== 'tool') return false
  return (
    message.metadata?.kind === 'ensembleParticipant' ||
    message.metadata?.kind === 'ensembleParticipantTools'
  )
}

function isRoundLaneTimelineMessage(message: ChatMessage, roundId: string): boolean {
  if (message.metadata?.ensembleRoundId !== roundId) return false
  if (!messageLaneId(message)) return false
  if (message.role !== 'assistant' && message.role !== 'tool') return false
  return (
    message.metadata?.kind === 'ensembleParticipant' ||
    message.metadata?.kind === 'ensembleParticipantTools'
  )
}

function isOpaqueRunTimelineMessage(message: ChatMessage): boolean {
  return (message.role === 'assistant' || message.role === 'tool') && Boolean(message.runId)
}

/** Start index of the transcript's TAIL lane cluster for this round: the
 * earliest index such that no non-lane run-timeline row (a serial
 * participant's rows, or any prior round's rows) appears at or after it.
 * System/status/prompt rows are transparent — lanes may slot around them.
 *
 * A lane's first-flush roster-order slot-in is confined to this cluster.
 * Matching a STALE lane row further up (e.g. a settled round-start recon
 * wave sitting above a still-streaming serial speaker) would hoist the
 * lane's whole report above the live speaker's message — the "fan-out
 * completion shoves the viewports above the current turn" jump. */
function tailLaneClusterStart(messages: ChatMessage[], roundId: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (isRoundLaneTimelineMessage(message, roundId)) continue
    if (isOpaqueRunTimelineMessage(message)) return i + 1
  }
  return 0
}

function isRunTimelineMessage(message: ChatMessage, run: ActiveParticipantRun): boolean {
  if (message.runId !== run.runId) return false
  if (message.role !== 'assistant' && message.role !== 'tool') return false
  const stableId = typeof message.id === 'string' ? message.id : ''
  return (
    stableId.startsWith(`ensemble-content-${run.runId}-`) ||
    stableId.startsWith(`ensemble-tool-${run.runId}`) ||
    message.id === run.assistantMessageId
  )
}

function insertRunTimelineMessages(
  messages: ChatMessage[],
  desiredMessages: ChatMessage[],
  run: ActiveParticipantRun,
  preferredInsertionIndex: number | null = null,
  runDispatchOrder?: Map<string, number>
): ChatMessage[] {
  if (desiredMessages.length === 0) return messages
  if (preferredInsertionIndex !== null) {
    const index = Math.max(0, Math.min(preferredInsertionIndex, messages.length))
    return [...messages.slice(0, index), ...desiredMessages, ...messages.slice(index)]
  }
  if (!run.laneId) {
    // First flush of a serial participant: append at the tail, EXCEPT above
    // rows of same-round lanes dispatched AFTER this run started — i.e. the
    // fan-out it sourced. A Boss that calls ensemble_fanout before producing
    // visible output must not have its whole turn pinned below its own
    // lanes; every lane flush (most visibly the completion batch) would keep
    // piling in above the Boss's live message. Lanes dispatched BEFORE this
    // run (a settled recon wave) stay above it — that IS the chronology.
    if (!runDispatchOrder) return [...messages, ...desiredMessages]
    const ownDispatchIndex = runDispatchOrder.get(run.runId)
    if (ownDispatchIndex === undefined) return [...messages, ...desiredMessages]
    const insertionIndex = messages.findIndex((message) => {
      if (!isRoundLaneTimelineMessage(message, run.roundId)) return false
      const laneDispatchIndex = message.runId ? runDispatchOrder.get(message.runId) : undefined
      return laneDispatchIndex !== undefined && laneDispatchIndex > ownDispatchIndex
    })
    if (insertionIndex < 0) return [...messages, ...desiredMessages]
    return [
      ...messages.slice(0, insertionIndex),
      ...desiredMessages,
      ...messages.slice(insertionIndex)
    ]
  }
  // First flush of a fan-out lane: keep sibling lanes in participant order,
  // but only within the round's tail lane cluster so the slot-in can never
  // leapfrog a serial participant's already-rendered rows.
  const clusterStart = tailLaneClusterStart(messages, run.roundId)
  let insertionIndex = -1
  for (let i = clusterStart; i < messages.length; i += 1) {
    const message = messages[i]
    if (
      isComparableFanoutTimelineMessage(message, run) &&
      compareRunLaneToMessage(run, message) < 0
    ) {
      insertionIndex = i
      break
    }
  }
  if (insertionIndex < 0) return [...messages, ...desiredMessages]
  return [
    ...messages.slice(0, insertionIndex),
    ...desiredMessages,
    ...messages.slice(insertionIndex)
  ]
}

/** Push a content fragment into the run's timeline, merging into
 * the last entry if it's also content. This is how the "speak,
 * tool, speak, tool" interleaving emerges — tools break the chunk;
 * consecutive content stays in one entry. */
function appendTimelineContent(run: ActiveParticipantRun, text: string): void {
  if (!run.timeline) run.timeline = []
  const last = run.timeline[run.timeline.length - 1]
  if (!run.forceNextTimelineContentEntry && last && last.kind === 'content') {
    last.text += text
    return
  }
  run.forceNextTimelineContentEntry = false
  run.timeline.push({ kind: 'content', text })
}

function appendProviderContent(
  run: ActiveParticipantRun,
  text: string,
  options: { trustedIncremental?: boolean; claudeCumulative?: boolean } = {}
): boolean {
  if (!text) return false

  if (run.content.length > 0) {
    // Every event reaching handleProviderOutput comes through the trusted
    // sendAgentCompatLine chokepoint. An untagged compat event is therefore a
    // literal delta, even when it happens to equal a prefix of the assembled
    // response (for example final chunk "C" after "Captain STEER-"). Shape
    // folding that case drops real text.
    if (options.trustedIncremental) {
      run.content += text
      appendTimelineContent(run, text)
      return true
    }
    const fold = foldBridgeRunText(run.content, text)
    if (options.claudeCumulative) {
      // Claude's tagged terminal envelope repeats deltas already streamed. A
      // clean superset may contribute a missing tail; a stale or divergent
      // restatement contributes nothing. This mirrors the solo/bridge lane.
      if (fold.kind !== 'tail') return false
      run.content = text
      appendTimelineContent(run, fold.tail)
      return true
    }
    // Explicit snapshot carriers (Cursor runItemCumulative/snapshot) use shape
    // folding because the snapshot can be their only text event. Prefer a
    // duplicate divergent snapshot over dropping content; clean supersets add
    // only their tail.
    if (fold.kind === 'skip') return false
    if (fold.kind === 'tail') {
      run.content = text
      appendTimelineContent(run, fold.tail)
      return true
    }
  }

  run.content += text
  appendTimelineContent(run, text)
  return true
}

/** Push a tool entry into the timeline. The toolActivities array
 * has been updated by the caller; this just records the position
 * where the activity falls in the chronology so the flush can
 * materialise the matching `role: 'tool'` message inline. */
function appendTimelineTool(run: ActiveParticipantRun, toolId: string): void {
  if (!run.timeline) run.timeline = []
  run.timeline.push({ kind: 'tool', toolId })
}

const PSEUDO_SYSTEM_YIELD_LINE_RE = /^\s*\[System\]\s+Yield(?:ing|ed)\b.*$/i

function stripPseudoSystemYieldLines(text: string): string {
  if (!text || !/\[System\]\s+Yield/i.test(text)) return text
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = /\r?\n$/.test(text)
  const filtered = text
    .split(/\r?\n/)
    .filter((line) => !PSEUDO_SYSTEM_YIELD_LINE_RE.test(line))
    .join(newline)
    .replace(/\n{3,}/g, '\n\n')
  return hadTrailingNewline && filtered ? `${filtered}${newline}` : filtered
}

function normalizeFanoutMode(value: unknown): EnsembleFanoutMode | null {
  if (value === undefined || value === null || value === '') return 'read_only'
  return value === 'read_only' || value === 'locked_writers' ? value : null
}

/** undefined = not specified (inherit chat config); null = invalid input. */
function normalizeFanoutIsolation(value: unknown): EnsembleFanoutIsolation | null | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return value === 'worktree' || value === 'off' ? value : null
}

const ENSEMBLE_AWAIT_POLL_INTERVAL_MS = 500
/**
 * Await budget (owner request 2026-08-05): authoritative seats may hold a
 * fan-out JOIN open for up to 10 minutes per call, defaulting to 3. The MCP
 * broker's long-poll allowance for ensemble_await is this ceiling + 30s grace
 * (MCP_BROKER_LONG_POLL_TIMEOUT_MS in mcp/McpBrokerTimeouts.ts — keep them in
 * lockstep) so the transport kill stays a liveness backstop, never the cap.
 */
const ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS = 600
const ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS = 180
const ENSEMBLE_LANE_RESULT_DEFAULT_MAX_CHARS = 20_000
const ENSEMBLE_LANE_RESULT_MAX_CHARS = 60_000

/** null = invalid input; undefined = not provided (await the whole round). */
function normalizeLaneIdList(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return null
  const laneIds = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
  if (laneIds.length === 0) return null
  return [...new Set(laneIds)]
}

export function clampAwaitTimeoutSeconds(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : NaN
  if (!Number.isFinite(requested)) return ENSEMBLE_AWAIT_DEFAULT_TIMEOUT_SECONDS
  return Math.max(5, Math.min(ENSEMBLE_AWAIT_MAX_TIMEOUT_SECONDS, Math.round(requested)))
}

function clampLaneResultMaxChars(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? value : NaN
  if (!Number.isFinite(requested)) return ENSEMBLE_LANE_RESULT_DEFAULT_MAX_CHARS
  return Math.max(1_000, Math.min(ENSEMBLE_LANE_RESULT_MAX_CHARS, Math.round(requested)))
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeFanoutTargetStage(value: unknown): EnsembleFanoutTargetStage | null | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
  if (normalized === 'all' || normalized === 'anytyped' || normalized === 'typed') return 'all'
  if (
    normalized === 'scout' ||
    normalized === 'scouts' ||
    normalized === 'reader' ||
    normalized === 'readers' ||
    normalized === 'recon'
  ) {
    return 'scouts'
  }
  if (
    normalized === 'worker' ||
    normalized === 'workers' ||
    normalized === 'writer' ||
    normalized === 'writers'
  ) {
    return 'workers'
  }
  if (normalized === 'review' || normalized === 'reviewer' || normalized === 'reviewers') {
    return 'reviewers'
  }
  if (normalized === 'bg' || normalized === 'background' || normalized === 'backgrounds') {
    return 'backgrounds'
  }
  return null
}

function fanoutTargetStageLabel(targetStage: EnsembleFanoutTargetStage | undefined): string {
  if (targetStage === 'scouts') return 'Scout fan-out'
  if (targetStage === 'workers') return 'Worker fan-out'
  if (targetStage === 'reviewers') return 'Review fan-out'
  if (targetStage === 'backgrounds') return 'Background fan-out'
  if (targetStage === 'all') return 'Ensemble fan-out'
  return 'Parallel fan-out'
}

function fanoutTargetStageMatches(
  participant: EnsembleParticipant,
  targetStage: EnsembleFanoutTargetStage | undefined
): boolean {
  if (!targetStage) return true
  if (targetStage === 'all') {
    return (
      participant.stageRole === 'scout' ||
      participant.stageRole === 'worker' ||
      participant.stageRole === 'reviewer' ||
      participant.stageRole === 'background'
    )
  }
  if (targetStage === 'scouts') return participant.stageRole === 'scout'
  if (targetStage === 'workers') return participant.stageRole === 'worker'
  if (targetStage === 'reviewers') return participant.stageRole === 'reviewer'
  return participant.stageRole === 'background'
}

function isBackgroundParticipant(participant: EnsembleParticipant): boolean {
  return participant.stageRole === 'background'
}

function resolveBackgroundMentions(
  prompt: string,
  participants: EnsembleParticipant[]
): { participantIds: Set<string>; ambiguities: ParticipantMentionMatch[] } {
  const participantIds = new Set<string>()
  const ambiguities: ParticipantMentionMatch[] = []
  for (const match of findAllMentions(prompt, participants)) {
    if (match.kind !== 'participant') continue
    const candidates = [match.participant, ...(match.ambiguousAmong || [])]
    if (!candidates.some((candidate) => isBackgroundParticipant(candidate))) continue
    if (match.ambiguousAmong && match.ambiguousAmong.length > 0) {
      ambiguities.push(match)
      continue
    }
    if (isBackgroundParticipant(match.participant) && match.participant.enabled !== false) {
      participantIds.add(match.participant.id)
    }
  }
  return { participantIds, ambiguities }
}

function fanoutPolicyAllowsRead(policy: EnsembleFanoutPolicy): boolean {
  return policy === 'read_only' || policy === 'all'
}

function fanoutPolicyAllowsWriters(policy: EnsembleFanoutPolicy): boolean {
  return (
    policy === 'all' ||
    policy === 'locked_writers_with_boss' ||
    policy === 'locked_writers_user_preflight'
  )
}

function isRosterEditAction(value: string): value is RosterEditAction {
  return (
    value === 'add_participant' || value === 'remove_participant' || value === 'edit_participant'
  )
}

function isEnsembleFanoutPolicy(value: unknown): value is EnsembleFanoutPolicy {
  return (
    typeof value === 'string' && ENSEMBLE_FANOUT_POLICIES.includes(value as EnsembleFanoutPolicy)
  )
}

function fanoutPolicyEnablesConcurrent(policy: EnsembleFanoutPolicy): boolean {
  return policy !== 'off'
}

function resolveEnsembleFanoutPolicy(
  input:
    | Pick<EnsembleConfig, 'fanoutPolicy' | 'concurrentModeEnabled'>
    | Pick<EnsembleRoundState, 'fanoutPolicy' | 'concurrentMode'>
    | {
        fanoutPolicy?: unknown
        concurrentModeEnabled?: boolean
        concurrentMode?: boolean
      }
    | null
    | undefined
): EnsembleFanoutPolicy {
  const raw = (input || {}) as {
    fanoutPolicy?: unknown
    concurrentMode?: boolean
    concurrentModeEnabled?: boolean
  }
  if (isEnsembleFanoutPolicy(raw.fanoutPolicy)) return raw.fanoutPolicy
  if (raw.concurrentMode === true) return 'read_only'
  if (raw.concurrentModeEnabled === true) {
    return 'read_only'
  }
  return 'off'
}

function resolveRequestedEnsembleFanoutPolicy(
  config: Pick<EnsembleConfig, 'fanoutPolicy' | 'concurrentModeEnabled'> | null | undefined,
  input: { fanoutPolicy?: unknown; concurrentMode?: boolean } = {}
): EnsembleFanoutPolicy {
  if (input.fanoutPolicy !== undefined) {
    return resolveEnsembleFanoutPolicy({ fanoutPolicy: input.fanoutPolicy })
  }
  if (input.concurrentMode !== undefined) {
    return resolveEnsembleFanoutPolicy({ concurrentMode: input.concurrentMode })
  }
  return resolveEnsembleFanoutPolicy(config)
}

function stripLeadingAt(value: string): string {
  return value.trim().replace(/^@+/, '').trim()
}

function isUserYieldTarget(value: string | undefined): boolean {
  const target = stripLeadingAt(value || '').toLowerCase()
  return target === 'user' || target === 'human' || target === 'you'
}

function normalizeTargetList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
      .slice(0, MAX_ENSEMBLE_PARTICIPANTS)
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function isBroadFanoutRequest(value: unknown): boolean {
  const targets = normalizeTargetList(value)
  return targets.length === 0 || targets.some((target) => /^@?all$/i.test(target))
}

function dedupeParticipants(participants: EnsembleParticipant[]): EnsembleParticipant[] {
  const seen = new Set<string>()
  const out: EnsembleParticipant[] = []
  for (const participant of participants) {
    if (!participant?.id || seen.has(participant.id)) continue
    seen.add(participant.id)
    out.push(participant)
  }
  return out
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function pickRawWriteScopesForParticipant(
  rawScopes: unknown,
  participant: EnsembleParticipant
): unknown {
  if (Array.isArray(rawScopes) || typeof rawScopes === 'string') return rawScopes
  if (!isPlainRecord(rawScopes)) return undefined
  const keys = [
    participant.id,
    participant.role,
    participant.provider,
    providerLabel(participant.provider),
    '*',
    'all'
  ]
    .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
    .map((key) => key.toLowerCase())
  for (const [key, value] of Object.entries(rawScopes)) {
    if (keys.includes(stripLeadingAt(key).toLowerCase())) return value
  }
  return undefined
}

function normalizeConcurrentWriteScopes(
  rawScopes: unknown,
  approvedBy: ConcurrentLaneWriteScope['approvedBy'],
  approvedAt: string
): ConcurrentLaneWriteScope[] {
  const rawList = Array.isArray(rawScopes) ? rawScopes : [rawScopes]
  const scopes: ConcurrentLaneWriteScope[] = []
  for (const raw of rawList.slice(0, 24)) {
    const scope = normalizeConcurrentWriteScope(raw, approvedBy, approvedAt)
    if (scope) scopes.push(scope)
  }
  return scopes
}

function normalizeConcurrentWriteScope(
  raw: unknown,
  approvedBy: ConcurrentLaneWriteScope['approvedBy'],
  approvedAt: string
): ConcurrentLaneWriteScope | null {
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (!value || value.includes('\0')) return null
    if (/^workspace$/i.test(value)) return { kind: 'workspace', approvedBy, approvedAt }
    return {
      kind: value.includes('*') ? 'glob' : 'path',
      path: value,
      approvedBy,
      approvedAt
    }
  }
  if (!isPlainRecord(raw)) return null
  const kindRaw = String(raw.kind || raw.type || '')
    .trim()
    .toLowerCase()
  const path = typeof raw.path === 'string' ? raw.path.trim() : ''
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : undefined
  if (kindRaw === 'workspace') {
    return { kind: 'workspace', approvedBy, approvedAt, ...(reason ? { reason } : {}) }
  }
  if ((kindRaw === 'path' || kindRaw === 'glob') && path && !path.includes('\0')) {
    return {
      kind: kindRaw,
      path,
      approvedBy,
      approvedAt,
      ...(reason ? { reason } : {})
    }
  }
  if (!kindRaw && path && !path.includes('\0')) {
    return {
      kind: path.includes('*') ? 'glob' : 'path',
      path,
      approvedBy,
      approvedAt,
      ...(reason ? { reason } : {})
    }
  }
  return null
}

function pathIsInsideOrSame(rootPath: string, targetPath: string): boolean {
  const root = resolve(rootPath)
  const target = resolve(targetPath)
  if (root === target) return true
  const rel = relative(root, target)
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function resolveScopePath(workspacePath: string, scopePath: string): string {
  return isAbsolute(scopePath) ? resolve(scopePath) : resolve(workspacePath, scopePath)
}

function writeScopeAllowsResource(
  scope: ConcurrentLaneWriteScope,
  workspacePath: string,
  resourcePath: string
): boolean {
  if (scope.kind === 'workspace') return true
  if (!scope.path) return false
  if (scope.kind === 'path') {
    const target = resolveScopePath(workspacePath, scope.path)
    return pathIsInsideOrSame(target, resourcePath)
  }
  const wildcardIndex = scope.path.indexOf('*')
  const staticPrefix = wildcardIndex === -1 ? scope.path : scope.path.slice(0, wildcardIndex)
  const normalizedPrefix = staticPrefix.replace(/[\\/]+$/, '')
  const target = resolveScopePath(workspacePath, normalizedPrefix || '.')
  return pathIsInsideOrSame(target, resourcePath)
}

function toWorkspaceRelative(workspacePath: string, resourcePath: string): string {
  const rel = relative(resolve(workspacePath), resolve(resourcePath))
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : resolve(resourcePath)
}

function extractJsonFromContent(content: string, marker: string): unknown {
  const fencePattern = /```([A-Za-z0-9_-]*)\s*([\s\S]*?)```/g
  for (const match of content.matchAll(fencePattern)) {
    const language = (match[1] || '').trim().toLowerCase()
    if (language && language !== 'json' && language !== marker.toLowerCase()) continue
    try {
      return JSON.parse((match[2] || '').trim())
    } catch {
      // Try the next fenced block.
    }
  }
  const firstBrace = content.indexOf('{')
  const lastBrace = content.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1))
    } catch {
      return null
    }
  }
  return null
}

function sanitizedStringList(value: unknown, maxItems = 12, maxLength = 80): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems)
    .map((entry) => entry.slice(0, maxLength))
}

function rawClaimScopes(raw: Record<string, unknown>): unknown {
  return raw.writeScopes ?? raw.write_scopes ?? raw.scopes ?? raw.paths ?? raw.globs
}

function isVagueUserPreflightScope(scope: ConcurrentLaneWriteScope): boolean {
  if (scope.kind === 'workspace') return true
  const normalized = (scope.path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
  return (
    !normalized ||
    normalized === '.' ||
    normalized === '/' ||
    normalized === '*' ||
    normalized === '**' ||
    normalized === '**/*'
  )
}

function scopeStaticRoot(workspacePath: string, scope: ConcurrentLaneWriteScope): string | null {
  if (scope.kind === 'workspace') return resolve(workspacePath)
  if (!scope.path) return null
  if (scope.kind === 'path') return resolveScopePath(workspacePath, scope.path)
  const wildcardIndex = scope.path.indexOf('*')
  const staticPrefix = wildcardIndex === -1 ? scope.path : scope.path.slice(0, wildcardIndex)
  const normalizedPrefix = (() => {
    if (wildcardIndex < 0 || /[\\/]$/.test(staticPrefix)) return staticPrefix.replace(/[\\/]+$/, '')
    const slashIndex = Math.max(staticPrefix.lastIndexOf('/'), staticPrefix.lastIndexOf('\\'))
    return slashIndex >= 0 ? staticPrefix.slice(0, slashIndex).replace(/[\\/]+$/, '') : '.'
  })()
  return resolveScopePath(workspacePath, normalizedPrefix || '.')
}

function scopeIsInsideWorkspace(workspacePath: string, scope: ConcurrentLaneWriteScope): boolean {
  const root = scopeStaticRoot(workspacePath, scope)
  return Boolean(root && pathIsInsideOrSame(workspacePath, root))
}

function writeScopesMayOverlap(
  workspacePath: string,
  left: ConcurrentLaneWriteScope,
  right: ConcurrentLaneWriteScope
): boolean {
  if (left.kind === 'workspace' || right.kind === 'workspace') return true
  const leftRoot = scopeStaticRoot(workspacePath, left)
  const rightRoot = scopeStaticRoot(workspacePath, right)
  if (!leftRoot || !rightRoot) return true
  return pathIsInsideOrSame(leftRoot, rightRoot) || pathIsInsideOrSame(rightRoot, leftRoot)
}

function formatWriteScope(scope: ConcurrentLaneWriteScope): string {
  return scope.kind === 'workspace' ? 'workspace' : `${scope.kind}:${scope.path || ''}`
}

function parseConcurrentWriteScopeClaim(
  run: ActiveParticipantRun,
  approvedAt: string
): { ok: true; claim: ConcurrentWriteScopeClaim } | { ok: false; reason: string } {
  const rawJson = extractJsonFromContent(run.content || '', 'taskwraith_write_claim')
  if (!isPlainRecord(rawJson)) {
    return {
      ok: false,
      reason: `${run.participant.role || providerLabel(run.participant.provider)} did not return a valid taskwraith_write_claim JSON object.`
    }
  }
  const scopes = normalizeConcurrentWriteScopes(
    rawClaimScopes(rawJson),
    'user-preflight',
    approvedAt
  )
  if (scopes.length === 0) {
    return {
      ok: false,
      reason: `${run.participant.role || providerLabel(run.participant.provider)} did not claim any concrete write scopes.`
    }
  }
  if (scopes.some(isVagueUserPreflightScope)) {
    return {
      ok: false,
      reason: `${run.participant.role || providerLabel(run.participant.provider)} claimed a vague or workspace-wide write scope.`
    }
  }
  const ack =
    rawJson.acknowledgeExclusiveScope === true ||
    rawJson.acknowledge_scope_matrix === true ||
    rawJson.acknowledgeScopeMatrix === true ||
    rawJson.ack === true
  if (!ack) {
    return {
      ok: false,
      reason: `${run.participant.role || providerLabel(run.participant.provider)} did not acknowledge the exclusive write-scope contract.`
    }
  }
  const fallback =
    rawJson.canFallbackToSerial === true ||
    rawJson.can_fallback_to_serial === true ||
    rawJson.fallbackSerial === true
  if (!fallback) {
    return {
      ok: false,
      reason: `${run.participant.role || providerLabel(run.participant.provider)} did not confirm it can fall back to serial execution.`
    }
  }
  const rationale =
    typeof rawJson.rationale === 'string' && rawJson.rationale.trim()
      ? rawJson.rationale.trim().slice(0, 500)
      : undefined
  return {
    ok: true,
    claim: {
      participantId: run.participant.id,
      participantRole: run.participant.role || providerLabel(run.participant.provider),
      provider: run.participant.provider,
      scopes,
      operations: sanitizedStringList(
        rawJson.operations ?? rawJson.operationTypes ?? rawJson.operation_types
      ),
      canFallbackToSerial: true,
      ...(rationale ? { rationale } : {})
    }
  }
}

function parseConcurrentWriteScopeAck(run: ActiveParticipantRun): boolean {
  const rawJson = extractJsonFromContent(run.content || '', 'taskwraith_write_ack')
  if (!isPlainRecord(rawJson)) return false
  return (
    rawJson.acknowledgeMatrix === true ||
    rawJson.acknowledge_matrix === true ||
    rawJson.acknowledgeScopeMatrix === true ||
    rawJson.ack === true
  )
}

function writeScopeClaimPrompt(): string {
  return [
    'Read-only write-scope preflight. Do not edit files, run shell commands, stage, or commit.',
    'Return a single JSON object in a fenced block tagged taskwraith_write_claim.',
    'The JSON schema is:',
    '{',
    '  "writeScopes": ["workspace-relative/path/or/glob/**"],',
    '  "operations": ["edit" | "create" | "delete" | "rename"],',
    '  "rationale": "why this lane owns only these files",',
    '  "canFallbackToSerial": true,',
    '  "acknowledgeExclusiveScope": true',
    '}',
    'Scopes must be concrete, workspace-relative, and non-overlapping with other writers. Do not claim workspace, ".", "*", "**", or external paths. If you cannot name a narrow scope, return an empty writeScopes array and canFallbackToSerial true.'
  ].join('\n')
}

function writeScopeAckPrompt(matrixSummary: string): string {
  return [
    'Read-only write-scope matrix acknowledgment. Do not edit files, run shell commands, stage, or commit.',
    'The host built this non-overlap matrix:',
    matrixSummary,
    'Return a single JSON object in a fenced block tagged taskwraith_write_ack:',
    '{ "acknowledgeMatrix": true }',
    'Only acknowledge if your lane can stay within its listed scope.'
  ].join('\n')
}

function writeScopeExecutionPrompt(matrixSummary: string): string {
  return [
    'Locked writer fan-out is authorized by user preflight.',
    'Stay strictly within your approved write scope. Do not stage or commit. If you need to write outside scope, stop and report the required serial follow-up.',
    'Approved scope matrix:',
    matrixSummary
  ].join('\n')
}

function participantDisplayName(participant: EnsembleParticipant): string {
  return participant.role || providerLabel(participant.provider)
}

function normalizeBossmanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return ''
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized
}

function normalizeBossmanTextArray(
  value: unknown,
  maxItems: number,
  maxCharsPerItem: number
): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => normalizeBossmanText(entry, maxCharsPerItem))
    .filter(Boolean)
    .slice(0, maxItems)
}

function capBossmanItems<T>(items: T[]): T[] {
  return items.slice(-MAX_BOSSMAN_CONTROL_ITEMS)
}

function clampOptionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function participantProviderGroupLabel(participants: EnsembleParticipant[]): string {
  const providers = new Set(participants.map((participant) => participant.provider))
  if (providers.size === 1) {
    return `${providerLabel(participants[0].provider)} participant`
  }
  return 'participant'
}

/**
 * Minimal tool-activity builders for the orchestrator. The renderer's
 * `ToolParser.ts` has richer extraction (file-path heuristics, diff
 * summaries, display-name humanising) but lives under `src/renderer/`
 * which `tsconfig.node.json` doesn't include. For ensemble tool
 * messages the basics are enough — the renderer's display layer can
 * still humanise on read by inspecting `rawUseEvent` / `rawResultEvent`.
 */
function extractToolId(event: any): string {
  if (!event || typeof event !== 'object') {
    return `ensemble-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
  return (
    event.tool_id ||
    event.toolId ||
    event.id ||
    event.call_id ||
    event.tool_call_id ||
    `ensemble-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function extractToolName(event: any): string {
  if (!event || typeof event !== 'object') return 'unknown'
  return (
    event.tool_name ||
    event.toolName ||
    event.name ||
    event.function?.name ||
    event.tool ||
    'unknown'
  )
}

function extractToolKind(event: any): string {
  if (!event || typeof event !== 'object') return ''
  const raw = event.tool_kind || event.toolKind || event.kind
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function extractToolParameters(event: any): Record<string, unknown> {
  if (!event || typeof event !== 'object') return {}
  const raw =
    event.parameters ||
    event.params ||
    event.arguments ||
    event.input ||
    event.function?.arguments ||
    {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

function stripToolNamespace(toolName: string): string {
  const name = (toolName || '').toLowerCase().trim()
  if (!name) return 'unknown'
  if (name.startsWith('mcp__')) {
    const idx = name.indexOf('__', 5)
    return idx > 5 ? name.slice(idx + 2) : name
  }
  if (name.startsWith('mcp_') && !name.startsWith('mcp__')) {
    const knownServerPrefixes = [
      'mcp_taskwraith-broker_',
      'mcp_taskwraith-broker-',
      'mcp_taskwraith_',
      'mcp_taskwraith-'
    ]
    for (const prefix of knownServerPrefixes) {
      if (name.startsWith(prefix)) return name.slice(prefix.length)
    }
  }
  if (name.startsWith('taskwraith-broker__')) return name.slice('taskwraith-broker__'.length)
  if (name.startsWith('taskwraith_broker__')) return name.slice('taskwraith_broker__'.length)
  if (name.startsWith('taskwraith-broker_')) return name.slice('taskwraith-broker_'.length)
  if (name.startsWith('taskwraith_broker_')) return name.slice('taskwraith_broker_'.length)
  if (name.startsWith('taskwraith__')) return name.slice('taskwraith__'.length)
  if (name.startsWith('taskwraith_')) return name.slice('taskwraith_'.length)
  return name
}

function getStringParameter(parameters: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

// Segments that should render as all-caps acronyms rather than Title-cased
// (a bare `mcp` base would otherwise humanise to the odd-looking "Mcp").
const TOOL_NAME_ACRONYMS: Record<string, string> = { mcp: 'MCP' }

function titleCaseToolName(toolName: string): string {
  return toolName
    .split('_')
    .filter(Boolean)
    .map((part) => TOOL_NAME_ACRONYMS[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function participantLabel(participant?: EnsembleParticipant): string {
  if (!participant) return 'Participant'
  return participant.role || participant.provider
}

/**
 * Snapshot one side of an authoritative seat change for the transcript row.
 * The preset fallback mirrors the seat-snapshot rule (`|| 'default'`) so the
 * row shows the tier the dispatch layer would actually resolve.
 */
function seatChangeSeatState(
  participant: EnsembleParticipant,
  grantsCount?: number,
  authority?: 'boss' | 'captain'
): SeatChangeSeatState {
  return {
    provider: participant.provider,
    model: participant.model || '',
    ...(participant.role ? { role: participant.role } : {}),
    ...(participant.order ? { seatNumber: participant.order } : {}),
    // Captured per side, so a change that moves a seat between stages (or in or
    // out of authority) is visible in the row rather than silently invisible.
    ...(participant.stageRole ? { stageRole: participant.stageRole } : {}),
    ...(authority ? { authority } : {}),
    ...(participant.reasoningEffort ? { reasoningEffort: participant.reasoningEffort } : {}),
    ...(participant.thinkingEnabled === undefined
      ? {}
      : { thinkingEnabled: participant.thinkingEnabled }),
    permissionPresetId: participant.permissionPresetId || 'default',
    ...(grantsCount === undefined ? {} : { grantsCount })
  }
}

function participantSeatValue(participant: EnsembleParticipant): string {
  const provider = providerLabel(participant.provider)
  const model = participant.model ? ` / ${participant.model}` : ''
  const role = participant.role ? ` (${participant.role})` : ''
  const stage = participant.stageRole ? ` [${participant.stageRole}]` : ''
  const enabled = participant.enabled ? '' : ' [disabled]'
  return `${provider}${model}${role}${stage}${enabled}`
}

function roundParticipantDisplayFields(
  participant: EnsembleParticipant
): Pick<EnsembleRoundParticipantState, 'provider' | 'role' | 'order'> &
  Partial<
    Pick<
      EnsembleRoundParticipantState,
      | 'model'
      | 'reasoningEffort'
      | 'fastModeEnabled'
      | 'thinkingEnabled'
      | 'serviceTier'
      | 'permissionPresetId'
    >
  > {
  return {
    provider: participant.provider,
    role: participant.role,
    order: participant.order,
    model: participant.model,
    reasoningEffort: participant.reasoningEffort,
    fastModeEnabled: participant.fastModeEnabled,
    thinkingEnabled: participant.thinkingEnabled,
    serviceTier: participant.serviceTier,
    permissionPresetId: participant.permissionPresetId
  }
}

function ensembleSeatSnapshot(participant: EnsembleParticipant): EnsembleSeatSnapshot {
  return {
    schemaVersion: 1,
    provider: participant.provider,
    ...(participant.model ? { model: participant.model } : {}),
    ...(participant.reasoningEffort !== undefined
      ? { reasoningEffort: participant.reasoningEffort }
      : {}),
    ...(participant.fastModeEnabled !== undefined
      ? { fastModeEnabled: participant.fastModeEnabled }
      : {}),
    ...(participant.provider === 'kimi'
      ? { thinkingEnabled: participant.thinkingEnabled ?? true }
      : participant.thinkingEnabled !== undefined
        ? { thinkingEnabled: participant.thinkingEnabled }
        : {}),
    ...(participant.serviceTier ? { serviceTier: participant.serviceTier } : {}),
    configuredPermissionPresetId: participant.permissionPresetId || 'default'
  }
}

export function roundParticipantStateFromParticipant(
  participant: EnsembleParticipant,
  status: EnsembleParticipantStatus
): EnsembleRoundParticipantState {
  return {
    participantId: participant.id,
    ...roundParticipantDisplayFields(participant),
    initialSeatSnapshot: ensembleSeatSnapshot(participant),
    status
  }
}

function compactBriefValue(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) return '(empty)'
  return normalized.length > BRIEF_SEAT_VALUE_PREVIEW_CHARS
    ? `${normalized.slice(0, BRIEF_SEAT_VALUE_PREVIEW_CHARS - 3)}...`
    : normalized
}

function participantSeatChangeValue(
  before: EnsembleParticipant,
  after: EnsembleParticipant,
  participant: EnsembleParticipant
): string {
  if (
    participantSeatValue(before) === participantSeatValue(after) &&
    before.instructions !== after.instructions
  ) {
    return `Brief / Goal: ${compactBriefValue(participant.instructions)}`
  }
  return participantSeatValue(participant)
}

function hasSeatChangePatch(patch: RosterEditParticipantInput | undefined | null): boolean {
  if (!patch) return false
  return (
    Object.prototype.hasOwnProperty.call(patch, 'provider') ||
    Object.prototype.hasOwnProperty.call(patch, 'enabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'model') ||
    Object.prototype.hasOwnProperty.call(patch, 'runtimeProfileId') ||
    Object.prototype.hasOwnProperty.call(patch, 'geminiAuthProfileId') ||
    Object.prototype.hasOwnProperty.call(patch, 'ollamaRunProfile') ||
    Object.prototype.hasOwnProperty.call(patch, 'role') ||
    Object.prototype.hasOwnProperty.call(patch, 'instructions') ||
    Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort') ||
    Object.prototype.hasOwnProperty.call(patch, 'fastModeEnabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'thinkingEnabled') ||
    Object.prototype.hasOwnProperty.call(patch, 'serviceTier') ||
    Object.prototype.hasOwnProperty.call(patch, 'permissionPresetId') ||
    Object.prototype.hasOwnProperty.call(patch, 'permissionOverrides') ||
    Object.prototype.hasOwnProperty.call(patch, 'stageRole') ||
    Object.prototype.hasOwnProperty.call(patch, 'linkedProviderSessionId')
  )
}

/**
 * User-facing seat equality, used to suppress no-op / duplicate seat changes.
 *
 * Deliberately compares ONLY the fields a user would call "the seat" and
 * ignores the internal side effects `applySeatChangePatch` produces: it nulls
 * `linkedProviderSessionId` even when the provider value is repeated, and it
 * drops the prompt / MCP receipt fields it invalidates. A plain object compare
 * would therefore never read a re-apply of the current seat as "unchanged",
 * which is exactly the case this predicate exists to catch.
 */
function participantSeatSelectionUnchanged(
  a: EnsembleParticipant,
  b: EnsembleParticipant
): boolean {
  const text = (value: unknown): string =>
    value === undefined || value === null ? '' : String(value)
  const json = (value: unknown): string => {
    try {
      return JSON.stringify(value ?? null)
    } catch {
      return text(value)
    }
  }
  return (
    a.provider === b.provider &&
    a.enabled === b.enabled &&
    text(a.model) === text(b.model) &&
    text(a.role) === text(b.role) &&
    text(a.instructions) === text(b.instructions) &&
    text(a.stageRole) === text(b.stageRole) &&
    text(a.reasoningEffort) === text(b.reasoningEffort) &&
    text(a.serviceTier) === text(b.serviceTier) &&
    text(a.permissionPresetId) === text(b.permissionPresetId) &&
    text(a.runtimeProfileId) === text(b.runtimeProfileId) &&
    text(a.geminiAuthProfileId) === text(b.geminiAuthProfileId) &&
    Boolean(a.fastModeEnabled) === Boolean(b.fastModeEnabled) &&
    Boolean(a.thinkingEnabled) === Boolean(b.thinkingEnabled) &&
    json(a.permissionOverrides) === json(b.permissionOverrides) &&
    json(a.ollamaRunProfile) === json(b.ollamaRunProfile)
  )
}

function applySeatChangePatch(
  target: EnsembleParticipant,
  patch: RosterEditParticipantInput
): EnsembleParticipant {
  const next: EnsembleParticipant = {
    ...target,
    linkedProviderSessionId: target.linkedProviderSessionId
  }
  let promptReceiptsInvalidated = false
  let mcpProfileReceiptInvalidated = false
  if (
    Object.prototype.hasOwnProperty.call(patch, 'provider') &&
    typeof patch.provider === 'string' &&
    patch.provider
  ) {
    next.provider = patch.provider as ProviderId
    next.linkedProviderSessionId = null
    // The edit path deliberately abandons the previous native session even
    // when the provider value is repeated, so neither prompt receipt remains
    // evidence of what the next session remembers.
    promptReceiptsInvalidated = true
    mcpProfileReceiptInvalidated = true
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'enabled') &&
    typeof patch.enabled === 'boolean'
  ) {
    next.enabled = patch.enabled
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'model')) {
    const nextModel = patch.model || undefined
    if ((target.model || '') !== (nextModel || '')) {
      promptReceiptsInvalidated = true
    }
    if (patch.model) next.model = patch.model
    else delete next.model
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'runtimeProfileId')) {
    if (patch.runtimeProfileId) next.runtimeProfileId = patch.runtimeProfileId
    else delete next.runtimeProfileId
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'geminiAuthProfileId')) {
    if (typeof patch.geminiAuthProfileId === 'string' || patch.geminiAuthProfileId === null) {
      next.geminiAuthProfileId = patch.geminiAuthProfileId
    } else {
      delete next.geminiAuthProfileId
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'ollamaRunProfile')) {
    if (patch.ollamaRunProfile) next.ollamaRunProfile = patch.ollamaRunProfile
    else delete next.ollamaRunProfile
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'role') && typeof patch.role === 'string') {
    next.role = patch.role
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'instructions') &&
    typeof patch.instructions === 'string'
  ) {
    next.instructions = patch.instructions
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'reasoningEffort')) {
    if (patch.reasoningEffort) next.reasoningEffort = patch.reasoningEffort
    else delete next.reasoningEffort
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'fastModeEnabled') &&
    typeof patch.fastModeEnabled === 'boolean'
  ) {
    next.fastModeEnabled = patch.fastModeEnabled
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'thinkingEnabled') &&
    typeof patch.thinkingEnabled === 'boolean'
  ) {
    next.thinkingEnabled = patch.thinkingEnabled
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'serviceTier')) {
    if (patch.serviceTier) next.serviceTier = patch.serviceTier
    else delete next.serviceTier
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'permissionPresetId') &&
    patch.permissionPresetId
  ) {
    next.permissionPresetId = patch.permissionPresetId as EnsembleParticipant['permissionPresetId']
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'permissionOverrides')) {
    if (patch.permissionOverrides) next.permissionOverrides = patch.permissionOverrides
    else delete next.permissionOverrides
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'stageRole')) {
    if (patch.stageRole && ENSEMBLE_SEAT_STAGE_ROLES.has(String(patch.stageRole))) {
      next.stageRole = patch.stageRole as EnsembleStageRole
    } else {
      delete next.stageRole
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'linkedProviderSessionId')) {
    if (
      typeof patch.linkedProviderSessionId === 'string' ||
      patch.linkedProviderSessionId === null
    ) {
      next.linkedProviderSessionId = patch.linkedProviderSessionId
    } else {
      delete next.linkedProviderSessionId
    }
    if ((next.linkedProviderSessionId || '') !== (target.linkedProviderSessionId || '')) {
      promptReceiptsInvalidated = true
      mcpProfileReceiptInvalidated = true
    }
  }
  if (promptReceiptsInvalidated) {
    delete next.promptShellVersion
    delete next.promptDynamicStateVersion
  }
  if (mcpProfileReceiptInvalidated) {
    delete next.taskWraithMcpProfileReceipt
  }
  return next
}

const PROPOSED_PLAN_BLOCK = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/i
const PROPOSED_PLAN_BLOCK_GLOBAL = /<proposed_plan>[\s\S]*?<\/proposed_plan>/gi

function deriveProposedPlanTitle(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/)
    const text = (heading ? heading[1] : line.replace(/^[-*+]\s+/, '')).trim()
    if (text) return text.length > 80 ? `${text.slice(0, 79)}…` : text
  }
  return 'Proposed plan'
}

function parseExplicitProposedPlan(text: string): { title: string; body: string } | null {
  const match = text.match(PROPOSED_PLAN_BLOCK)
  if (!match) return null
  const body = match[1].trim()
  if (!body) return null
  return { title: deriveProposedPlanTitle(body), body }
}

function stripExplicitProposedPlanBlock(text: string): string {
  if (!PROPOSED_PLAN_BLOCK.test(text)) return text
  return text.replace(PROPOSED_PLAN_BLOCK_GLOBAL, '').trim()
}

function cleanParticipantId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function resolveEnsembleProposedPlanOwnerId(
  config: EnsembleConfig,
  roundId: string
): string | null {
  const orderedParticipants = getOrderedEnsembleParticipants(config).filter(
    (participant) => !isBackgroundParticipant(participant)
  )
  const bossmanId = cleanParticipantId(config.bossmanParticipantId)
  if (bossmanId && orderedParticipants.some((participant) => participant.id === bossmanId)) {
    return bossmanId
  }

  const activeRoundParticipants =
    config.activeRound?.roundId === roundId ? config.activeRound.participants : []
  const activeFallback = [...activeRoundParticipants].sort((a, b) => a.order - b.order).at(-1)
  return (
    cleanParticipantId(activeFallback?.participantId) ||
    cleanParticipantId(orderedParticipants.at(-1)?.id)
  )
}

function shouldStampEnsembleProposedPlan(
  chat: ChatRecord,
  roundId: string,
  participantId: string
): boolean {
  if (chat.workflowMode !== 'plan' || !chat.ensemble) return false
  return (
    cleanParticipantId(participantId) === resolveEnsembleProposedPlanOwnerId(chat.ensemble, roundId)
  )
}

function mapEnsembleToolKindToCategory(kind: string): ToolActivity['category'] | undefined {
  switch (kind) {
    case 'read':
      return 'read'
    case 'edit':
    case 'delete':
    case 'move':
      return 'write'
    case 'search':
    case 'fetch':
      return 'search'
    case 'execute':
      return 'shell'
    case 'think':
    case 'thinking':
    case 'reasoning':
      return 'task'
    default:
      return undefined
  }
}

function isEnsembleReasoningToolName(toolName: string): boolean {
  const name = stripToolNamespace(toolName)
  return (
    name === 'thinking' ||
    name === 'reasoning' ||
    name.endsWith('_thinking') ||
    name.endsWith('_reasoning')
  )
}

function getEnsembleToolCategory(toolName: string, toolKind = ''): ToolActivity['category'] {
  const kindCategory = mapEnsembleToolKindToCategory(toolKind)
  if (kindCategory) return kindCategory
  const name = stripToolNamespace(toolName)
  if (isEnsembleReasoningToolName(name)) return 'task'
  if (
    name === 'ensemble_yield' ||
    name === 'update_topic' ||
    name === 'summary' ||
    name === 'intent' ||
    name === 'progress' ||
    name === 'tool_progress'
  ) {
    return 'task'
  }
  if (name === 'read_file' || name === 'list_directory') return 'read'
  if (FILE_WRITE_TOOL_NAMES.has(name)) return 'write'
  if (name === 'grep_search' || name === 'grep' || name === 'rg' || name === 'web_search')
    return 'search'
  if (name === 'run_shell_command' || name === 'shell' || name === 'get_diagnostics') return 'shell'
  if (name === 'git_push' || name === 'git_create_pr') return 'shell'
  if (name === 'github_ci_status') return 'search'
  return 'unknown'
}

function getEnsembleToolDisplayName(
  toolName: string,
  parameters: Record<string, unknown>,
  participant?: EnsembleParticipant,
  roster?: readonly EnsembleParticipant[]
): string {
  const name = stripToolNamespace(toolName)
  if (name === 'ensemble_yield') {
    const target = getStringParameter(parameters, ['target', 'participant', 'to', 'next'])
    const actor = participantLabel(participant)
    // Models address a peer by whatever form is in front of them — including
    // the opaque roster id the held-handoff result hands back. Resolve it to
    // the seat's role so the PERSISTED name reads like the actor half does
    // ("DSeekWork yielding to Builder"); unresolvable targets keep the
    // model's own words.
    const label = yieldTargetDisplayLabel(target, roster)
    return label ? `${actor} yielding to ${label}` : `${actor} yielding`
  }
  if (name === 'update_topic') {
    const topic = getStringParameter(parameters, ['title', 'topic', 'name'])
    return topic ? `Topic update: ${topic}` : 'Topic update'
  }
  if (name === 'read_file') {
    const path = getStringParameter(parameters, ['file_path', 'path'])
    return path ? `Read ${path}` : 'Read file'
  }
  if (name === 'list_directory') {
    const path = getStringParameter(parameters, ['file_path', 'path'])
    return path ? `Listed ${path}` : 'Listed directory'
  }
  if (FILE_WRITE_TOOL_NAMES.has(name)) {
    if (name === 'move_path') {
      const source = getStringParameter(parameters, ['from', 'source', 'sourcePath', 'path'])
      const destination = getStringParameter(parameters, [
        'to',
        'destination',
        'destinationPath',
        'target'
      ])
      return source && destination ? `Moved ${source} -> ${destination}` : 'Moved path'
    }
    if (name === 'rename_path') {
      const path = getStringParameter(parameters, ['file_path', 'path', 'from', 'source'])
      const newName = getStringParameter(parameters, ['newName', 'name'])
      return path && newName ? `Renamed ${path} -> ${newName}` : 'Renamed path'
    }
    if (name === 'create_directory') {
      const path = getStringParameter(parameters, ['file_path', 'path', 'directory'])
      return path ? `Created directory ${path}` : 'Created directory'
    }
    if (name === 'delete_path') {
      const path = getStringParameter(parameters, ['file_path', 'path', 'directory', 'file'])
      return path ? `Deleted ${path}` : 'Deleted path'
    }
    const path = getStringParameter(parameters, ['file_path', 'path'])
    return path ? `Edited ${path}` : 'Edited file'
  }
  if (name === 'get_diagnostics') return 'Checked diagnostics'
  if (name === 'git_push') return 'Git push'
  if (name === 'git_create_pr') return 'Git create PR'
  if (name === 'github_ci_status') return 'GitHub CI status'
  if (name === 'run_shell_command' || name === 'shell') return 'Shell command'
  return titleCaseToolName(name) || toolName || 'Used tool'
}

/** File-write tool names that should populate a `diffSummary` so the
 * renderer's `latestRunDiffStats` useMemo counts the file. Mirrors
 * the canonical names recognised by the renderer's solo-path
 * `ToolParser.deriveToolDiffSummary`. */
const FILE_WRITE_TOOL_NAMES = new Set([
  'edit_file',
  'write_file',
  'create_file',
  'apply_patch',
  'patch_file',
  'edit',
  'replace',
  'write',
  'patch',
  'str_replace',
  'str_replace_editor',
  'multiedit',
  'fs_write',
  'fs_edit',
  'fs_patch',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path'
])

function singleDiffFilePath(
  diffSummary: ToolActivity['diffSummary'] | undefined
): string | undefined {
  const files = diffSummary?.files
  if (!Array.isArray(files) || files.length !== 1) return undefined
  const path = files[0]?.path
  return typeof path === 'string' && path.trim() ? path : undefined
}

function normalizeToolDiffSummary(
  summary: ToolActivity['diffSummary'] | undefined,
  filePath: string | undefined
): ToolActivity['diffSummary'] | undefined {
  if (!summary) return undefined
  const files =
    Array.isArray(summary.files) && summary.files.length > 0
      ? summary.files.map((file) => ({
          ...file,
          path: file.path || filePath
        }))
      : filePath
        ? [
            {
              path: filePath,
              status: 'modified' as const,
              additions: summary.additions,
              deletions: summary.deletions
            }
          ]
        : undefined
  return {
    ...summary,
    ...(files ? { files } : {}),
    source: summary.source || ('unknown' as const),
    confidence: summary.confidence || ('estimated' as const)
  }
}

function mergeToolDiffSummaries(
  existing: ToolActivity['diffSummary'] | undefined,
  result: ToolActivity['diffSummary'] | undefined,
  filePath: string | undefined
): ToolActivity['diffSummary'] | undefined {
  const normalizedExisting = normalizeToolDiffSummary(existing, filePath)
  const normalizedResult = normalizeToolDiffSummary(result, filePath)
  if (!normalizedExisting) return normalizedResult
  if (!normalizedResult) return normalizedExisting
  // First-counts-wins below keeps a streamed ensemble activity stable, but it also
  // means a MEASURED summary arriving second is rejected — and one arriving first
  // would be safe only by luck. Assert the precedence explicitly in both directions;
  // everything after this is the pre-existing rule, unchanged.
  if (isMeasuredDiffSummary(normalizedResult) && !isMeasuredDiffSummary(normalizedExisting)) {
    return normalizedResult
  }
  if (isMeasuredDiffSummary(normalizedExisting)) return normalizedExisting
  const existingHasCounts =
    typeof normalizedExisting.additions === 'number' ||
    typeof normalizedExisting.deletions === 'number'
  const resultHasCounts =
    typeof normalizedResult.additions === 'number' || typeof normalizedResult.deletions === 'number'
  if (resultHasCounts && !existingHasCounts) {
    return normalizedResult
  }
  if (
    (!normalizedExisting.files || normalizedExisting.files.length === 0) &&
    normalizedResult.files &&
    normalizedResult.files.length > 0
  ) {
    return {
      ...normalizedExisting,
      files: normalizedResult.files
    }
  }
  return normalizedExisting
}

function buildEnsembleToolActivity(
  event: any,
  startedAt: string,
  participant?: EnsembleParticipant,
  roster?: readonly EnsembleParticipant[]
): ToolActivity {
  const toolName = extractToolName(event)
  const toolKind = extractToolKind(event)
  const canonicalToolName = stripToolNamespace(toolName)
  const parameters = extractToolParameters(event)
  const category = getEnsembleToolCategory(toolName, toolKind)
  const parameterFilePath =
    typeof parameters.file_path === 'string'
      ? (parameters.file_path as string)
      : typeof parameters.path === 'string'
        ? (parameters.path as string)
        : undefined
  // Seed a `diffSummary` for known file-write tool names so the renderer's
  // files-changed counter picks them up. When the tool input contains
  // countable evidence, carry the real +/- counts; otherwise leave counts
  // undefined instead of seeding fake +0/-0 stats that suppress richer
  // renderer-side derivation on the activity row.
  const inputDiffSummary =
    category === 'write' ? bridgeToolDiffStats(canonicalToolName, parameters) : undefined
  const filePath = parameterFilePath || singleDiffFilePath(inputDiffSummary)
  const diffSummary =
    category === 'write'
      ? normalizeToolDiffSummary(
          inputDiffSummary ||
            (filePath
              ? {
                  files: [
                    {
                      path: filePath,
                      status: 'modified' as const
                    }
                  ],
                  source: 'unknown' as const,
                  confidence: 'estimated' as const
                }
              : undefined),
          filePath
        )
      : undefined
  return {
    id: extractToolId(event),
    toolName,
    displayName: getEnsembleToolDisplayName(toolName, parameters, participant, roster),
    category,
    status: 'running',
    startedAt,
    parameters,
    filePath,
    ...(diffSummary ? { diffSummary } : {}),
    ...(participant
      ? { metadata: { provider: participant.provider, ensembleProvider: participant.provider } }
      : {}),
    rawUseEvent: event
  }
}

function upsertEnsembleToolUseActivity(
  run: ActiveParticipantRun,
  activity: ToolActivity
): 'inserted' | 'updated' {
  if (!run.toolActivities) run.toolActivities = []
  const existingIndex = run.toolActivities.findIndex((existing) => existing.id === activity.id)
  if (existingIndex < 0) {
    run.toolActivities.push(activity)
    return 'inserted'
  }

  const existing = run.toolActivities[existingIndex]
  const existingHasParameters = Object.keys(existing.parameters || {}).length > 0
  const parameters = existingHasParameters ? existing.parameters : activity.parameters
  const filePath = existing.filePath || activity.filePath
  const diffSummary = mergeToolDiffSummaries(existing.diffSummary, activity.diffSummary, filePath)
  run.toolActivities[existingIndex] = {
    ...existing,
    toolName: existing.toolName || activity.toolName,
    displayName: existingHasParameters ? existing.displayName : activity.displayName,
    category: existing.category === 'unknown' ? activity.category : existing.category,
    parameters,
    ...(filePath ? { filePath } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    metadata: {
      ...(activity.metadata || {}),
      ...(existing.metadata || {})
    },
    rawUseEvent: existing.rawUseEvent || activity.rawUseEvent
  }
  return 'updated'
}

function pairEnsembleToolResult(activity: ToolActivity, event: any, endedAt: string): ToolActivity {
  const status: ToolActivityStatus =
    event?.success === false || event?.error || event?.is_error ? 'error' : 'success'
  const durationMs = activity.startedAt
    ? new Date(endedAt).getTime() - new Date(activity.startedAt).getTime()
    : undefined
  const output =
    typeof event?.content === 'string'
      ? event.content
      : typeof event?.output === 'string'
        ? event.output
        : typeof event?.result === 'string'
          ? event.result
          : ''
  // Reasoning / thinking traces render in full in the transcript (parity with
  // the renderer's pairToolResult + the bridge-ingest carve-out), so they
  // bypass the 500-char preview cap that bounds ordinary ensemble tool output.
  const reasoningTool = /(?:^|_)(?:thinking|reasoning)$/i.test(
    stripToolNamespace(activity.toolName)
  )
  const cap = reasoningTool ? 100_000 : 500
  const truncated = output.length > cap ? `${output.substring(0, cap)}...` : output
  const displayName =
    status === 'success' && stripToolNamespace(activity.toolName) === 'ensemble_yield'
      ? activity.displayName.replace(/\byielding\b/i, 'yielded')
      : activity.displayName
  const resultRecord =
    event?.result && typeof event.result === 'object' && !Array.isArray(event.result)
      ? (event.result as Record<string, unknown>)
      : {}
  const resultDiffSummary =
    activity.category === 'write'
      ? bridgeResultDiffStats({
          toolName: stripToolNamespace(activity.toolName),
          summary: output,
          changes: event?.changes ?? resultRecord.changes,
          kind: event?.kind ?? resultRecord.kind ?? activity.parameters?.kind
        })
      : undefined
  const diffSummary = mergeToolDiffSummaries(
    activity.diffSummary,
    resultDiffSummary,
    activity.filePath || singleDiffFilePath(resultDiffSummary)
  )
  const filePath = activity.filePath || singleDiffFilePath(diffSummary)
  return {
    ...activity,
    status,
    displayName,
    endedAt,
    durationMs,
    ...(filePath ? { filePath } : {}),
    ...(diffSummary ? { diffSummary } : {}),
    resultSummary: truncated,
    outputPreview: truncated,
    rawResultEvent: event
  }
}

function discordContextToolSummary(metadata: DiscordContextReadMetadata): string {
  return `Read Discord #${metadata.channelName} · ${metadata.messageCount} messages`
}

function discordContextToolResult(metadata: DiscordContextReadMetadata): string {
  const lines = [
    metadata.guildName ? `Server: ${metadata.guildName}` : '',
    `Channel: #${metadata.channelName}`,
    `Fetched at: ${metadata.fetchedAt}`,
    `Messages: ${metadata.messageCount}`,
    metadata.firstTimestamp && metadata.lastTimestamp
      ? `Range: ${metadata.firstTimestamp} to ${metadata.lastTimestamp}`
      : '',
    '',
    'Preview omitted: Discord message text is run-only and is not persisted in chat history.',
    metadata.truncated
      ? 'Full Discord context was capped before being supplied to the model.'
      : 'Full content was supplied to the model as external untrusted context.'
  ]
  return lines.filter((line, index) => line || lines[index - 1]).join('\n')
}

function createDiscordContextToolMessage(
  reads: DiscordContextReadMetadata[],
  timestamp: string
): ChatMessage {
  return {
    id: `ensemble-discord-context-${timestamp}`,
    role: 'tool',
    content: '',
    timestamp,
    toolActivities: reads.map((metadata, index) => ({
      id: `discord-context-${metadata.channelId}-${metadata.fetchedAt}-${index}`,
      toolName: discordContextToolSummary(metadata),
      displayName: discordContextToolSummary(metadata),
      category: 'read',
      status: 'success',
      startedAt: metadata.fetchedAt,
      endedAt: metadata.fetchedAt,
      durationMs: 0,
      parameters: {
        channelId: metadata.channelId,
        channelName: metadata.channelName,
        guildId: metadata.guildId,
        guildName: metadata.guildName,
        limit: metadata.limit,
        retention: metadata.retention
      },
      resultSummary: discordContextToolResult(metadata)
    }))
  }
}

/** Runtime queue entry. Its restart-safe fields are mirrored to the round. */
interface QueuedRoundEntry {
  id: string
  prompt: string
  /** Preserve the user's single-seat @mention scope until this queued round starts. */
  dmTargetParticipantId?: string
  fanoutPolicy?: EnsembleFanoutPolicy
  imageAttachments: EnsembleImageAttachment[]
  imageThumbnails?: EnsembleImageThumbnail[]
  externalPathGrants?: ExternalPathGrant[]
  /** Set only when restart recovery cannot safely replay persisted metadata. */
  restartRecoveryBlockedReason?: string
  /** Context snapshots are runtime-only; persisted rows retain a presence
   * marker so restart recovery can quarantine rather than silently drop them. */
  discordContextSnapshots?: DiscordContextSnapshot[]
  /** P1 F6 — Use-next selection for this queued entry (re-resolved per seat). */
  projectReferenceContextSelection?: ProjectReferenceContextSelection
}

interface YieldReturnFrame {
  returnParticipantId: string
  targetParticipantId: string
}

interface PendingParticipantSeatChange {
  participantId: string
  before: EnsembleParticipant
  after: EnsembleParticipant
  /** User removal waits only for this seat's current execution to settle. */
  removeAfterExecution?: boolean
  changedBy: SessionActivityLedgerEntry['changedBy']
  reason: string
  queuedAt: string
}

interface ActiveRoundRuntime {
  chatId: string
  roundId: string
  sender: Electron.WebContents
  prompt: string
  /** Single participant selected by the user's composer @mention for this round. */
  dmTargetParticipantId?: string
  imageAttachments: EnsembleImageAttachment[]
  imageThumbnails: EnsembleImageThumbnail[]
  discordContextSnapshots?: DiscordContextSnapshot[]
  cancelled: boolean
  /** Every async round loop currently capable of projecting or dispatching. */
  roundActivities?: Set<Promise<void>>
  /** An explicit yield to user is terminal even after the provider emits late completion events. */
  returnedControlToUser?: boolean
  /**
   * FIFO queue of prompts to dispatch as fresh rounds after the
   * current round finishes. The user can stack multiple sends
   * during a running round; each lands here in order. Earlier
   * iterations used a single `queuedPrompt: string` which silently
   * overwrote when the user queued a second message — the maintainer hit
   * that limit during the 1.0.3 smoke and confirmed the
   * accidental-steer caused a parallel Codex run that broke MCP
   * routing. Accumulating instead of overwriting fixes both.
   *
   * 1.0.5-EW43a — Each entry now carries both the prompt string
   * (already enriched with `promptWithAttachmentReferences` so the
   * text references survive any persistence round-trip) AND the
   * structured attachment objects. Pre-EW43a the runtime queue
   * was `string[]`, so when the user sent a message with
   * attachments during a running round the attachment objects
   * were dropped at the enqueue point — the next-round dispatch
   * at line 2131 then fired with `imageAttachments: []` and the
   * agent received only the prompt's text references, with no
   * actual image data attached. The chat-round state now persists both the
   * prompt-only renderer mirror and a versioned structured mirror so restart
   * recovery can retain the same routing and attachment boundary.
   */
  queuedPrompts: QueuedRoundEntry[]
  /**
   * Legacy prompt-only rows found during restart recovery. They remain visible
   * and persisted, but never auto-dispatch because their original routing and
   * attachment authority cannot be reconstructed safely.
   */
  quarantinedLegacyQueuedPrompts?: string[]
  startAfterCancellation?: Promise<unknown>
  remainingParticipants?: EnsembleParticipant[]
  /** Most recent foreground seat admitted by the serial loop. */
  lastForegroundParticipantId?: string
  midRunSteeringBoundaryState?: EnsembleMidRunSteeringBoundaryState
  /** Same-seat Path-B retry after discreet Cursor context-pressure recovery. */
  pendingCursorContextRecoveryParticipantId?: string
  /** At most one host recovery attempt per seat per round. */
  cursorContextRecoveryAttemptedParticipantIds?: Set<string>
  bossmanParticipantId?: string
  captainParticipantIds?: string[]
  secondInCommandParticipantId?: string
  bossmanBaselineParticipantIds?: string[]
  bossmanBaselineParticipantCount?: number
  activeRunId?: string
  /**
   * 1.0.4-AK5 — set of run ids currently in flight for a parallel
   * fan-out pass. Distinct from `activeRunId` (the serial writer's
   * single in-flight run) so the existing reads of `activeRunId`
   * keep their single-run semantics unchanged; the fan-out set only
   * has entries during the brief Promise.all window when the
   * pre-writer fan-out pass is running.
   */
  activeScoutRunIds?: Set<string>
  laneAttemptByParticipantId?: Map<string, number>
  /**
   * Participant ids that already completed an explicit `ensemble_fanout`
   * lane in this round. Those participants may still be present in the
   * serial `remaining` queue captured before the fan-out call; skip them
   * there so one tool call cannot produce duplicate future turns.
   */
  fannedOutParticipantIds?: Set<string>
  /**
   * Participant ids currently reserved for an explicit `ensemble_fanout`
   * lane whose promise has not settled yet. This closes the race where the
   * caller yields/finishes while fan-out lanes are still running and the
   * serial queue still contains those targets.
   */
  fanoutReservedParticipantIds?: Set<string>
  /**
   * Boss/Captain who launched (or ended) an owned fan-out wave without
   * synthesizing. Survives across re-summoned authority turns so ordinary
   * serial writers cannot start until that seat produces a post-wave answer
   * (or hands off to another available manager).
   */
  pendingAuthorityFanoutSynthesisParticipantId?: string
  /**
   * Dispatch-start receipts for additive user-tagged fan-out. A serial turn
   * reaching one of these seats waits only for its routing receipt, then skips
   * an accepted lane or proceeds normally after a rejection. This prevents a
   * transient reservation from silently consuming that seat's serial turn.
   */
  userFanoutDispatchSettlements?: Map<string, Promise<boolean>>
  /**
   * Explicit user-tagged seats that must run at the next serial boundary when
   * the concurrent-write kill switch forbids their configured write posture
   * from entering a parallel lane. Includes Background seats, which ordinary
   * roster construction excludes from serial rotation.
   */
  userFanoutSerialParticipantIds?: Set<string>
  /**
   * 1.0.4-AK6 — structured briefs recorded by participants during
   * the parallel fan-out pass via the `scout_brief` MCP tool. After
   * the fan-out pass closes, the serial writer's prompt builder
   * reads these and injects them as a "Fan-out briefs from the
   * parallel pass:" context block. Cleared at round-end so a
   * subsequent serial round doesn't accidentally re-use stale
   * briefs.
   */
  scoutBriefs?: ScoutBriefRecord[]
  /**
   * Tree-derived churn baseline for this round, captured lazily on the FIRST
   * dispatch (before any seat has written) and subtracted on every later
   * dispatch so each seat sees what its peers actually changed.
   *
   * Lives on the runtime rather than in a keyed registry so it dies with the
   * round exactly like `scoutBriefs` — nothing to reap, nothing to persist. Set
   * to `null` once sampling has been attempted and failed (not a repository, no
   * commits, git error) so a doomed sample is not retried on every dispatch of
   * a long round.
   */
  workspaceChurnBaseline?: WorkspaceChurnSample | null
  unreachableParticipantIds?: Set<string>
  orchestrationMode: EnsembleOrchestrationMode
  fanoutPolicy?: EnsembleFanoutPolicy
  concurrentMode?: boolean
  continuationHops: number
  maxContinuationHops: number
  /** One-based autonomous pass. Kept separately from per-seat hop accounting. */
  continuationPass: number
  /** Tagged authority call-ins waiting to be attached to the resulting run. */
  pendingAuthorityRoutingCheckpoints?: Map<string, EnsembleAuthorityRoutingCheckpoint>
  continuationLimitNotified?: boolean
  /**
   * The serial continuation budget is exhausted, but terminal publication is
   * waiting for the true drain tail. Detached BG lanes and fan-out reservation
   * windows can outlive the serial queue, so "returning control" is only honest
   * after those lanes settle and no higher-priority closure supersedes it.
   */
  continuationLimitPending?: boolean
  /**
   * Set when the closing Review wave settles. The next Continuous drain may
   * soft-fail `tryAutoContinueRound`'s no-progress predicate (empty/skipped
   * lane output) even though hops remain — suppress that one guard so the
   * round returns to authority / the next pass instead of Task-Complete.
   */
  suppressNoProgressAfterReviewWave?: boolean
  /**
   * C4 — one-shot guard for the administrative-idle-consensus escalation
   * (`detectAdministrativeIdleConsensus`). Set when the deadlock stop fires so a
   * single idle streak escalates at most once; re-armed by a productive
   * continuation pass or a fresh `assign_work` (genuine net-new work).
   */
  administrativeIdleEscalated?: boolean
  /**
   * Snapshot of the active goal's identity/terminality when this runtime was
   * built. The serial-loop terminal-goal pre-emption
   * (`preemptRemainingForTerminalGoal`) may only fire when the goal went
   * terminal DURING this round — a stale completed/blocked goal carried in
   * from a prior round must not pre-empt pass 1 of a fresh round (agents are
   * prompted to set_goal/reactivate at round start instead). A goal that is
   * reactivated and re-completed within one round keeps its id and start
   * snapshot, so it conservatively does NOT pre-empt — rare and harmless.
   */
  roundStartGoalId?: string
  roundStartGoalWasTerminal?: boolean
  /** Fire-once guard for the terminal-goal pre-emption round-status note. */
  goalTerminalPreemptionNoted?: boolean
  bossmanSummonCountsByParticipantId?: Map<string, number>
  /**
   * Canonical yield-routing outcome planned during `markYielded` and
   * consumed by `runRound` after the yielding turn finalises. Queue
   * mutations happen at plan time so tool results can fail closed.
   */
  yieldRouting?: StoredYieldRouting
  /**
   * B8 — explicit-yield repair stack. When A yields to B, A is
   * remembered here so a real answered turn from B can auto-return to A.
   * Nested yields unwind LIFO (A→B→C returns C→B, then B→A).
   */
  yieldReturnStack?: YieldReturnFrame[]
  pendingParticipantSeatChanges?: PendingParticipantSeatChange[]
  /**
   * 1.0.4-AF — round-scoped self-reflective flag. Set when the user
   * opened the round with `/discuss` (alias `/meta`). Threaded into
   * the per-participant config passed to `buildEnsembleParticipantPrompt`
   * so the deictic rule inverts (`this app` → TaskWraith) for the whole
   * round, then dies with the runtime. Persistent toggling of the
   * EnsembleConfig flag is a separate UI surface (item 4 of the
   * earlier panel feedback); this only handles the slash-triggered
   * per-round case.
   */
  selfReflective?: boolean
  /**
   * 1.0.4-AT4 — composer-level external path grants captured at
   * startRound time. Pre-AT4 the round dispatch dropped these on
   * the floor (`runEnsembleRound` IPC schema didn't accept them),
   * so file-mention grants the user added in the composer never
   * reached the participants' effective permissions. Now they
   * land here on the runtime, get fed into
   * `resolveEffectiveRunPermissions` via
   * `explicitExternalPathGrants`, and the resolver's existing
   * provider filter ensures each participant only sees grants
   * tagged for its own provider.
   *
   * Empty / undefined when the user didn't add any explicit
   * grants — matches pre-AT4 behaviour for those rounds.
   */
  externalPathGrants?: ExternalPathGrant[]
  /**
   * P1 F6 — composer Use-next Project reference selection for this round.
   * Re-resolved per seat against the live Project registry; never grants access.
   */
  projectReferenceContextSelection?: ProjectReferenceContextSelection
  /**
   * Set for a scheduled/workflow occurrence; forces read-only
   * participant postures (no unattended auto-accept of edits).
   */
  unattended?: boolean
  /**
   * P2 — VERIFIED elevation level for an unattended round. When set,
   * resolveParticipantPermissions lifts the uniform posture from read-only to
   * the level's preset instead of the plan floor. Only ever set alongside `unattended`.
   */
  unattendedElevationLevel?: UnattendedElevationLevel
  pendingWakeups?: Map<string, EnsembleWakeupRecord>
  readyWakeups?: EnsembleWakeupRecord[]
  wakeWaiter?: () => void
  resumeWakeup?: EnsembleWakeupRecord
}

export class EnsembleOrchestrator {
  private roundsByChatId = new Map<string, ActiveRoundRuntime>()
  private runsByRunId = new Map<string, ActiveParticipantRun>()
  /**
   * Bounded receipts for provider calls that arrive just after terminal
   * settlement. They acknowledge a duplicate/late ensemble_yield without
   * reviving authority; unknown run ids still fail closed.
   */
  private terminalRunToolTombstones = new Map<string, number>()
  private readonly cursorCompletionWatchdog = new EnsembleCursorCompletionWatchdog()
  /** Last emitted monotonic usage value per active seat. Keeps the renderer
   * animation smooth without putting a timer or write loop in main. */
  private participantWorkingTelemetryByRunId = new Map<
    string,
    {
      sentAt: number
      inputTokens: number
      outputTokens: number
      totalTokens: number
      estimated: boolean
      contextUsage?: ContextUsageSnapshot
    }
  >()
  /**
   * Serial drains deferred because a detached `ensemble_fanout` lane was
   * still active when the serial queue emptied. Keyed by chatId; the value
   * is the drained round's runtime, kept alive so the resume path can replay
   * the exact drain tail (queued-prompt chaining included) once the last
   * lane goes terminal. Entries are cleared by the resume itself, by
   * `cancelRound` (Stop closes the round immediately — cancellation is never
   * deferred), and by `clearRuntimeIfCurrent` as teardown hygiene.
   */
  private deferredLaneDrainByChatId = new Map<string, ActiveRoundRuntime>()
  /**
   * Debounced transcript flush is per-chat, not per-run. Parallel fan-out
   * lanes all schedule through this scheduler so N dirty seats collapse to
   * one 250ms timer and one saveChat (see flushScheduledRuns).
   */
  private readonly chatFlushScheduler = new EnsembleChatFlushScheduler({
    delayMs: 250,
    onFlush: (chatId, runIds) => this.flushScheduledRuns(chatId, runIds)
  })
  /**
   * While flushScheduledRuns is applying several lanes, getChat/saveChat are
   * redirected through this overlay so intermediate flushRun calls mutate one
   * in-memory chat and only the final commit hits deps.saveChat.
   */
  private flushChatOverlay: { chatId: string; chat: ChatRecord } | null = null
  private bossmanPollTimeoutsById = new Map<
    string,
    {
      chatId: string
      pollId: string
      handle: ReturnType<typeof setTimeout>
    }
  >()
  private queuedPromptIdCounter = 0

  /** Failed-run overflow evidence waiting for the seat's settled maintenance seam. */
  private pendingSeatOverflowEvidence = new Map<string, PendingSeatOverflowEvidence>()

  constructor(private deps: EnsembleOrchestratorDeps) {}

  /**
   * Apply user-owned round controls to the canonical chat and, when present,
   * the in-memory runtime. The runtime reads these fields at fan-out admission
   * and at the continuation boundary, so current provider executions continue
   * unchanged while the next decision observes the new value.
   */
  updateLiveRoundConfig(
    input: EnsembleLiveRoundConfigUpdateInput
  ): EnsembleLiveRoundConfigUpdateResult {
    const chat = this.deps.getChat(input.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        error: 'not_ensemble',
        message: 'Live round configuration requires an Ensemble chat.'
      }
    }

    if (
      (input.orchestrationMode !== undefined &&
        input.orchestrationMode !== 'continuous' &&
        input.orchestrationMode !== 'turn_bound') ||
      (input.fanoutPolicy !== undefined && !isEnsembleFanoutPolicy(input.fanoutPolicy)) ||
      (input.maxContinuationHops !== undefined && !Number.isFinite(input.maxContinuationHops))
    ) {
      return {
        ok: false,
        error: 'invalid_config',
        message: 'Live round configuration contains an unsupported value.'
      }
    }

    const orchestrationMode =
      input.orchestrationMode ?? resolveEnsembleOrchestrationMode(chat.ensemble)
    const fanoutPolicy = input.fanoutPolicy ?? resolveEnsembleFanoutPolicy(chat.ensemble)
    const maxContinuationHops =
      input.maxContinuationHops === undefined
        ? resolveMaxContinuationHops(chat.ensemble)
        : Math.max(1, Math.min(MAX_CONTINUATION_HOP_LIMIT, Math.floor(input.maxContinuationHops)))
    const activeRound = chat.ensemble.activeRound
    const activeRoundUpdated = activeRound?.status === 'running'
    const runtime = this.roundsByChatId.get(input.chatId)

    if (
      runtime &&
      !runtime.cancelled &&
      activeRoundUpdated &&
      activeRound?.roundId === runtime.roundId
    ) {
      runtime.orchestrationMode = orchestrationMode
      runtime.fanoutPolicy = fanoutPolicy
      runtime.concurrentMode = fanoutPolicyEnablesConcurrent(fanoutPolicy) || undefined
      runtime.maxContinuationHops = maxContinuationHops
      // A newly raised cap should reopen a pending continuation boundary; a
      // lowered cap is re-evaluated at that same boundary against the new cap.
      runtime.continuationLimitNotified = false
      runtime.continuationLimitPending = false
    }

    const updated: ChatRecord = {
      ...chat,
      ensemble: {
        ...chat.ensemble,
        orchestrationMode,
        fanoutPolicy,
        concurrentModeEnabled: fanoutPolicyEnablesConcurrent(fanoutPolicy),
        maxContinuationHops,
        ...(activeRoundUpdated && activeRound
          ? {
              activeRound: {
                ...activeRound,
                orchestrationMode,
                fanoutPolicy,
                concurrentMode: fanoutPolicyEnablesConcurrent(fanoutPolicy) || undefined,
                maxContinuationHops
              }
            }
          : {}),
        updatedAt: this.deps.nowIso()
      },
      updatedAt: this.deps.now()
    }
    this.saveChatWithCheckpoint(
      updated,
      activeRoundUpdated ? 'round-updated' : 'participant-updated'
    )

    return {
      ok: true,
      orchestrationMode,
      fanoutPolicy,
      maxContinuationHops,
      activeRoundUpdated
    }
  }

  applyOrQueueUserRosterPreset(
    chatId: string,
    plan: PendingEnsembleRosterPresetApply
  ): EnsembleUserRosterPresetApplyResult {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        error: 'not_ensemble',
        message: 'Roster presets require an Ensemble chat.'
      }
    }
    if (plan.authority !== 'user') {
      return {
        ok: false,
        error: 'invalid_config',
        message: 'Only an explicit user roster change can use this route.'
      }
    }

    const deferred = isEnsembleRoundDispatchLive(chat.ensemble.activeRound)
    const queued = queuePendingEnsembleRosterPresetApply(chat, plan)
    const next = deferred ? queued : applyPendingEnsembleRosterPresetOnFinalize(queued)
    this.saveChatWithCheckpoint(
      { ...next, updatedAt: this.deps.now() },
      deferred ? 'round-updated' : 'participant-updated'
    )
    return { ok: true, deferred }
  }

  private startCursorCompletionWatchdog(run: ActiveParticipantRun): void {
    // The live main wiring supplies an exact RunManager child-liveness probe.
    // Keep test/legacy embedders that do not own provider transports on the
    // pre-watchdog path rather than guessing that an unobservable run died.
    if (run.participant.provider !== 'cursor' || !this.deps.getProviderRunTransportLiveness) {
      return
    }
    this.cursorCompletionWatchdog.start({
      runId: run.runId,
      now: this.deps.now,
      hasActiveToolOrApproval: () =>
        Boolean(
          this.deps.hasPendingProviderRunApprovals?.(run.runId) ||
          run.toolActivities?.some(
            (activity) => activity.status === 'pending' || activity.status === 'running'
          )
        ),
      transportLiveness: () => this.deps.getProviderRunTransportLiveness?.(run.runId) || 'unknown',
      contextPressurePercent: () => this.cursorContextPressurePercentForRun(run),
      isActive: () => {
        const current = this.runsByRunId.get(run.runId)
        return current === run && !run.terminalFinalized
      },
      onContextPressureRecovery: (reason) => {
        this.recoverCursorSeatFromContextPressure(run, reason)
      },
      onMissingTerminal: (reason) => {
        // Release the serial completion promise first. The exact provider
        // cancellation is best-effort cleanup and must never strand rotation
        // behind a provider that already stopped publishing lifecycle events.
        if (this.runsByRunId.get(run.runId) !== run || run.terminalFinalized) return
        const message = `Cursor turn recovered after missing terminal result: ${reason}`
        this.appendRoundStatus(run.chatId, run.roundId, message)
        this.finalizeRun(run, 'failed', message)
        void this.requestExactRunCancellation(run).catch(() => undefined)
      }
    })
  }

  private touchCursorCompletionWatchdog(run: ActiveParticipantRun): void {
    if (run.participant.provider === 'cursor') this.cursorCompletionWatchdog.touch(run.runId)
  }

  private stopCursorCompletionWatchdog(run: ActiveParticipantRun): void {
    if (run.participant.provider === 'cursor') this.cursorCompletionWatchdog.stop(run.runId)
  }

  private cursorContextPressurePercentForRun(run: ActiveParticipantRun): number | null {
    const telemetry = this.participantWorkingTelemetryByRunId.get(run.runId)
    if (!telemetry) return null
    const tokens = Math.max(
      telemetry.totalTokens || 0,
      (telemetry.inputTokens || 0) + (telemetry.outputTokens || 0),
      telemetry.contextUsage?.contextTokens || 0
    )
    if (tokens <= 0) return null
    const windowTokens = resolveContextWindow(
      run.participant.provider,
      run.participant.model,
      undefined
    )
    if (!(windowTokens > 0)) return null
    return contextPercent(tokens, windowTokens)
  }

  /**
   * Discreet Cursor Path-B recovery at critical context pressure: cancel the
   * hung child, persist a host prune summary, show the ordinary compaction
   * card, and re-dispatch the same seat. Never appends a failed/skipped coda.
   */
  private recoverCursorSeatFromContextPressure(run: ActiveParticipantRun, reason: string): void {
    if (this.runsByRunId.get(run.runId) !== run || run.terminalFinalized) return
    if (run.participant.provider !== 'cursor') return
    const runtime = this.roundsByChatId.get(run.chatId)
    if (!runtime || runtime.roundId !== run.roundId || runtime.cancelled) return
    runtime.cursorContextRecoveryAttemptedParticipantIds ??= new Set()
    if (runtime.cursorContextRecoveryAttemptedParticipantIds.has(run.participant.id)) {
      // Already recovered once this round — fall back to the visible fail path
      // so a looping seat cannot pin the roster forever.
      const message = `Cursor turn recovered after missing terminal result: ${reason}`
      this.appendRoundStatus(run.chatId, run.roundId, message)
      this.finalizeRun(run, 'failed', message)
      void this.requestExactRunCancellation(run).catch(() => undefined)
      return
    }
    runtime.cursorContextRecoveryAttemptedParticipantIds.add(run.participant.id)
    run.cursorContextPressureRecovery = true
    run.invalidatePromptShellReceipt = true
    run.invalidatePromptDynamicStateReceipt = true

    const chat = this.deps.getChat(run.chatId)
    const preTokens =
      this.participantWorkingTelemetryByRunId.get(run.runId)?.totalTokens ||
      this.participantWorkingTelemetryByRunId.get(run.runId)?.contextUsage?.contextTokens
    const summary = chat
      ? buildCursorPathBCompactionSummary({
          messages: chat.messages || [],
          roundPrompt: runtime.prompt,
          nowIso: this.deps.nowIso(),
          ...(typeof preTokens === 'number' ? { preTokens } : {})
        })
      : null

    this.emitSeatCompactionProgress(run.chatId, run.participant, 'started', 'auto')
    if (summary && chat?.ensemble) {
      const participants = (chat.ensemble.participants || []).map((participant) =>
        participant.id === run.participant.id
          ? {
              ...participant,
              contextCompactionSummary: {
                text: summary.text,
                createdAt: summary.createdAt,
                provider: summary.provider,
                ...(summary.preTokens !== undefined ? { preTokens: summary.preTokens } : {}),
                provenance: summary.provenance
              },
              linkedProviderSessionId: null,
              promptShellVersion: undefined,
              promptDynamicStateVersion: undefined
            }
          : participant
      )
      this.saveChatWithCheckpoint(
        {
          ...chat,
          ensemble: { ...chat.ensemble, participants },
          updatedAt: this.deps.now()
        },
        'participant-updated'
      )
      Object.assign(run.participant, {
        contextCompactionSummary: {
          text: summary.text,
          createdAt: summary.createdAt,
          provider: summary.provider,
          ...(summary.preTokens !== undefined ? { preTokens: summary.preTokens } : {}),
          provenance: summary.provenance
        },
        linkedProviderSessionId: null
      })
      delete (run.participant as { promptShellVersion?: string }).promptShellVersion
      delete (run.participant as { promptDynamicStateVersion?: string }).promptDynamicStateVersion
    }

    const completedSignal: ContextCompactionSignal = {
      kind: 'completed',
      telemetry: {
        provider: 'cursor',
        trigger: 'auto',
        ...(typeof preTokens === 'number' ? { preTokens } : {}),
        eventUuid: `cursor-pathb-recovery-${run.runId}`
      }
    }
    this.appendContextCompactionCard(run, run.runId, completedSignal)
    this.emitSeatCompactionProgress(run.chatId, run.participant, 'completed', 'auto')

    // Same-seat retry only for the serial foreground seat. Detached fan-out
    // Cursor lanes get the prune + compaction card, then settle quietly.
    if (!run.laneId && runtime.activeRunId === run.runId) {
      runtime.pendingCursorContextRecoveryParticipantId = run.participant.id
    }
    // Finalize first so a racing cancel/exit cannot stamp failed/skipped coda.
    this.finalizeRun(run, 'cancelled', reason)
    void this.requestExactRunCancellation(run).catch(() => undefined)
  }

  private trackRoundActivity(runtime: ActiveRoundRuntime, activity: Promise<void>): Promise<void> {
    const activities = runtime.roundActivities ?? new Set<Promise<void>>()
    runtime.roundActivities = activities
    const tracked = activity.finally(() => {
      activities.delete(tracked)
      if (activities.size === 0) runtime.roundActivities = undefined
    })
    activities.add(tracked)
    return tracked
  }

  private async requestExactRunCancellation(run: ActiveParticipantRun): Promise<boolean> {
    const cancelled = await this.deps.cancelRun(run.participant.provider, run.runId)
    if (cancelled === true) run.transportCancellationConfirmed = true
    return cancelled
  }

  private requestExactHistoryTransportTermination(run: ActiveParticipantRun): Promise<boolean> {
    const terminate = this.deps.terminateRunForHistory ?? this.deps.cancelRun
    return terminate(run.participant.provider, run.runId)
  }

  private exactRoundRuns(chatId: string, roundId: string): ActiveParticipantRun[] {
    return [...this.runsByRunId.values()].filter(
      (run) => run.chatId === chatId && run.roundId === roundId
    )
  }

  /**
   * Join every main-side activity that can still cross provider admission for
   * one cancelled round. Explicit fan-out dispatch windows are retained on the
   * source run separately from the root runRound promise, so both sets must
   * drain before history deletion can evaluate transport receipts.
   */
  private async joinHistoryRoundActivities(
    runtime: ActiveRoundRuntime,
    trackedRuns: Set<ActiveParticipantRun>
  ): Promise<void> {
    while (true) {
      for (const run of this.exactRoundRuns(runtime.chatId, runtime.roundId)) {
        trackedRuns.add(run)
      }
      const activities = [
        ...(runtime.roundActivities || []),
        ...[...trackedRuns].flatMap((run) => [
          ...(run.pendingFanoutDispatches || []),
          ...(run.ownedFanoutSettlements || [])
        ])
      ]
      if (activities.length === 0) return
      await Promise.allSettled(activities)
    }
  }

  /**
   * History prepare closes AppStore writes before the orchestrator is asked to
   * quiesce. Consequently this path must be entirely runtime-local: ordinary
   * run finalisation flushes transcript/run state and is intentionally not
   * reusable here.
   */
  private terminallyReleaseRunForHistory(run: ActiveParticipantRun, reason: string): void {
    this.stopCursorCompletionWatchdog(run)
    this.chatFlushScheduler.cancelRun(run.chatId, run.runId)
    if (run.flushTimer) {
      clearTimeout(run.flushTimer)
      run.flushTimer = undefined
    }
    run.fanoutDispatchCancelled = true
    run.suppressOwnedFanoutTranscriptRelease = true
    run.status = 'cancelled'
    run.terminalReason = reason
    run.terminalFinalized = true
    // Suppress every ordinary terminal side effect if an already-held async
    // closure still retains this run object after it leaves runsByRunId.
    run.terminalSideEffectsApplied = true
    run.terminalTokenTotalsApplied = true
    this.participantWorkingTelemetryByRunId.delete(run.runId)
    this.pendingSeatOverflowEvidence.delete(seatOverflowEvidenceKey(run.chatId, run.participant.id))
    try {
      this.deps.onParticipantWorkingTelemetry?.({
        type: 'clear',
        chatId: run.chatId,
        roundId: run.roundId,
        participantId: run.participant.id,
        runId: run.runId
      })
    } catch {
      // Renderer telemetry is best-effort and never part of the deletion receipt.
    }
    if (run.laneId) {
      try {
        this.deps.releaseWriteIntentsForLane?.(run.laneId)
      } catch {
        // The history transaction still owns the durable cleanup boundary.
      }
    }
    try {
      this.deps.releaseProviderSessionPersistenceDecision?.(run.runId)
    } catch {
      // Runtime-only decision cleanup must not bypass exact transport joining.
    }
    if (this.runsByRunId.get(run.runId) === run) this.runsByRunId.delete(run.runId)
    const completion = run.completion
    run.completion = undefined
    completion?.('cancelled')
  }

  /** Cancel every timer capable of reviving history for one target chat. */
  private cancelHistoryTimerHandles(
    chatId: string,
    runtime: ActiveRoundRuntime | undefined,
    chat: ChatRecord | null | undefined
  ): void {
    const wakeupIds = new Set<string>()
    for (const wakeup of Object.values(chat?.ensemble?.wakeups || {})) {
      // History deletion removes the whole target chat history, so orphaned or
      // sleeping wakeups from older rounds are in scope too.
      if (wakeup.status === 'pending') wakeupIds.add(wakeup.wakeupId)
    }
    for (const wakeup of runtime?.pendingWakeups?.values() || []) {
      if (wakeup.status === 'pending') wakeupIds.add(wakeup.wakeupId)
    }
    for (const wakeupId of wakeupIds) this.deps.cancelWakeupTimer?.(wakeupId)
    if (runtime) {
      runtime.pendingWakeups?.clear()
      runtime.readyWakeups = []
      runtime.resumeWakeup = undefined
      this.signalWakeWaiter(runtime)
    }
    this.chatFlushScheduler.cancelChat(chatId)

    // Advisory polls pre-date roundId stamping. Structured ownership is
    // required here: safe chat ids may contain `:`, so a raw string prefix can
    // mistake chat `a:b` for a descendant of chat `a`.
    for (const [key, entry] of this.bossmanPollTimeoutsById) {
      if (entry.chatId !== chatId) continue
      clearTimeout(entry.handle)
      this.bossmanPollTimeoutsById.delete(key)
    }
  }

  /**
   * Synchronously fence one live round without touching AppStore/checkpoints.
   * The caller retains the run objects separately until dispatch/activity and
   * exact transport receipts have joined.
   */
  private fenceRoundForHistory(
    runtime: ActiveRoundRuntime,
    trackedRuns: Set<ActiveParticipantRun>,
    reason: string,
    chat: ChatRecord | null | undefined
  ): void {
    runtime.cancelled = true
    const pendingParticipantSeatChanges = runtime.pendingParticipantSeatChanges
    runtime.pendingParticipantSeatChanges = undefined
    this.deferredLaneDrainByChatId.delete(runtime.chatId)
    runtime.queuedPrompts = []
    runtime.remainingParticipants = []
    runtime.fanoutReservedParticipantIds = undefined
    runtime.userFanoutDispatchSettlements = undefined
    runtime.userFanoutSerialParticipantIds = undefined
    runtime.yieldRouting = undefined
    runtime.yieldReturnStack = []
    this.cancelHistoryTimerHandles(runtime.chatId, runtime, chat)
    this.applyPendingParticipantSeatChanges(runtime, pendingParticipantSeatChanges)

    // Lanes first: their completion promises may release retained owners.
    const orderedRuns = [...trackedRuns].sort(
      (left, right) => Number(Boolean(right.laneId)) - Number(Boolean(left.laneId))
    )
    for (const run of orderedRuns) this.terminallyReleaseRunForHistory(run, reason)
    runtime.activeRunId = undefined
    runtime.activeScoutRunIds = undefined
    this.clearRuntimeIfCurrent(runtime)
  }

  private nextQueuedPromptId(chatId: string): string {
    const usedIds = new Set<string>()
    for (const entry of this.roundsByChatId.get(chatId)?.queuedPrompts || []) {
      usedIds.add(entry.id)
    }
    for (const entry of this.deps.getChat(chatId)?.ensemble?.activeRound?.queuedPromptEntries ||
      []) {
      usedIds.add(entry.id)
    }
    let candidate = ''
    do {
      this.queuedPromptIdCounter += 1
      candidate = `ensemble-queued-${chatId}-${this.queuedPromptIdCounter}`
    } while (usedIds.has(candidate))
    return candidate
  }

  private queuedPromptFields(entries: QueuedRoundEntry[]): {
    queuedPrompt: string | undefined
    queuedPrompts: string[]
    queuedPromptEntries: EnsembleQueuedPromptState[]
  } {
    const queuedPrompts = entries.map((entry) => entry.prompt)
    return {
      queuedPrompt: queuedPrompts[0],
      queuedPrompts,
      queuedPromptEntries: entries.map((entry) => ({
        persistenceVersion: 1,
        id: entry.id,
        prompt: entry.prompt,
        ...(entry.dmTargetParticipantId
          ? { dmTargetParticipantId: entry.dmTargetParticipantId }
          : {}),
        ...(entry.fanoutPolicy ? { fanoutPolicy: entry.fanoutPolicy } : {}),
        ...(entry.discordContextSnapshots?.length ? { hadDiscordContext: true } : {}),
        imageAttachments: entry.imageAttachments.map((attachment) => ({ ...attachment })),
        ...(entry.imageThumbnails?.length
          ? { imageThumbnails: entry.imageThumbnails.map((thumbnail) => ({ ...thumbnail })) }
          : {}),
        ...(entry.externalPathGrants?.some(
          (grant) => grant.duration !== 'thisRun' && !grant.appRunId
        )
          ? {
              externalPathGrants: entry.externalPathGrants
                .filter((grant) => grant.duration !== 'thisRun' && !grant.appRunId)
                .map((grant) => ({ ...grant }))
            }
          : {})
      }))
    }
  }

  /**
   * Rehydrate only a complete, versioned queue mirror. `null` deliberately
   * means fail closed: prompt-only legacy rows or a mismatched/corrupt mirror
   * do not contain enough authority to infer their original directed scope.
   */
  private restorePersistedQueuedEntries(round: EnsembleRoundState): QueuedRoundEntry[] | null {
    if (!Array.isArray(round.queuedPromptEntries)) return null
    const promptMirror =
      Array.isArray(round.queuedPrompts) && round.queuedPrompts.length > 0
        ? round.queuedPrompts
        : round.queuedPrompt
          ? [round.queuedPrompt]
          : []
    if (round.queuedPromptEntries.length !== promptMirror.length) return null

    const restored: QueuedRoundEntry[] = []
    for (let index = 0; index < round.queuedPromptEntries.length; index += 1) {
      const entry = round.queuedPromptEntries[index]
      if (
        !entry ||
        entry.persistenceVersion !== 1 ||
        typeof entry.id !== 'string' ||
        !entry.id.trim() ||
        typeof entry.prompt !== 'string' ||
        entry.prompt !== promptMirror[index] ||
        (entry.dmTargetParticipantId !== undefined &&
          (typeof entry.dmTargetParticipantId !== 'string' ||
            !entry.dmTargetParticipantId.trim())) ||
        (entry.fanoutPolicy !== undefined && !isEnsembleFanoutPolicy(entry.fanoutPolicy)) ||
        (entry.hadDiscordContext !== undefined && typeof entry.hadDiscordContext !== 'boolean') ||
        !Array.isArray(entry.imageAttachments) ||
        (entry.imageThumbnails !== undefined && !Array.isArray(entry.imageThumbnails)) ||
        (entry.externalPathGrants !== undefined &&
          (!Array.isArray(entry.externalPathGrants) ||
            entry.externalPathGrants.some(
              (grant) => !grant || typeof grant !== 'object' || typeof grant.duration !== 'string'
            )))
      ) {
        return null
      }
      const imageAttachments = normalizeEnsembleImageAttachments(entry.imageAttachments)
      const imageThumbnails = normalizeEnsembleImageThumbnails(entry.imageThumbnails)
      if (
        imageAttachments.length !== entry.imageAttachments.length ||
        imageThumbnails.length !== (entry.imageThumbnails?.length || 0)
      ) {
        return null
      }
      const restartRecoveryBlockedReasons: string[] = []
      if (imageAttachments.length > 0 || imageThumbnails.length > 0) {
        restartRecoveryBlockedReasons.push('attachment paths must be re-selected')
      }
      if (entry.hadDiscordContext) {
        restartRecoveryBlockedReasons.push('Discord context was run-only and must be re-selected')
      }
      restored.push({
        id: entry.id,
        prompt: entry.prompt,
        ...(entry.dmTargetParticipantId
          ? { dmTargetParticipantId: entry.dmTargetParticipantId }
          : {}),
        ...(entry.fanoutPolicy ? { fanoutPolicy: entry.fanoutPolicy } : {}),
        imageAttachments,
        ...(imageThumbnails.length ? { imageThumbnails } : {}),
        ...(entry.externalPathGrants?.some(
          (grant) => grant.duration !== 'thisRun' && !grant.appRunId
        )
          ? {
              externalPathGrants: entry.externalPathGrants
                .filter((grant) => grant.duration !== 'thisRun' && !grant.appRunId)
                .map((grant) => ({ ...grant }))
            }
          : {}),
        ...(restartRecoveryBlockedReasons.length > 0
          ? {
              restartRecoveryBlockedReason: `Queued prompt preserved but not dispatched after restart because ${restartRecoveryBlockedReasons.join(
                ' and '
              )}.`
            }
          : {})
      })
    }
    return restored
  }

  private queuedTargetUnavailableReason(
    chatId: string,
    entry: Pick<QueuedRoundEntry, 'dmTargetParticipantId'>
  ): string | null {
    const targetId = entry.dmTargetParticipantId
    if (!targetId) return null
    const targetExists = this.deps
      .getChat(chatId)
      ?.ensemble?.participants.some((participant) => participant.id === targetId)
    return targetExists
      ? null
      : `Directed queued prompt preserved but not dispatched because participant "${targetId}" is no longer in the roster.`
  }

  private resolveQueuedPrompt(
    runtime: ActiveRoundRuntime,
    input: { index: number; textPrefix?: string; queuedPromptId?: string }
  ): { selectedIndex: number; selected: QueuedRoundEntry } | { error: string } {
    const index = Number.isFinite(input.index) ? Math.floor(input.index) : -1
    if (input.queuedPromptId) {
      const selectedIndex = runtime.queuedPrompts.findIndex(
        (entry) => entry.id === input.queuedPromptId
      )
      if (selectedIndex < 0) {
        return { error: 'Queued item no longer exists' }
      }
      const selected = runtime.queuedPrompts[selectedIndex]
      if (!selected) {
        return { error: 'Queued item no longer exists' }
      }
      if (input.textPrefix && !selected.prompt.startsWith(input.textPrefix)) {
        return { error: 'Queue changed underneath — refresh and retry' }
      }
      if (index >= 0 && selectedIndex !== index) {
        return { error: 'Queue changed underneath — refresh and retry' }
      }
      return { selectedIndex, selected }
    }

    if (index < 0 || index >= runtime.queuedPrompts.length) {
      return { error: 'Queued item no longer exists' }
    }

    const selected = runtime.queuedPrompts[index]
    if (!selected) {
      return { error: 'Queued item no longer exists' }
    }
    if (input.textPrefix && !selected.prompt.startsWith(input.textPrefix)) {
      return { error: 'Queue changed underneath — refresh and retry' }
    }
    return { selectedIndex: index, selected }
  }

  private saveChatWithCheckpoint(chat: ChatRecord, reason: SessionCheckpointReason): void {
    // A multi-lane flush holds an in-memory overlay so sibling flushes share
    // one save. Any other writer (seat change, round status, …) that persists
    // during that window must advance the overlay too — otherwise the flush
    // tail saveChat reverts the store to a pre-mutation projection and can
    // drop the mutation's transcript row or revive wiped lane cards.
    if (this.flushChatOverlay?.chatId === chat.appChatId) {
      this.flushChatOverlay.chat = chat
    }
    this.deps.saveChat(chat)
    if (chat.ensemble?.activeRound?.status !== 'running') return
    // T3b: skip checkpoint persist for participant-updated while round is
    // running — checkpoints persist only at D2 lifecycle boundaries.
    if (reason === 'participant-updated') return
    try {
      this.deps.persistSessionCheckpoint?.(chat, reason)
    } catch {
      // Checkpoints are recovery hints. A persistence failure must never
      // interrupt the active ensemble run.
    }
  }

  private completeCheckpoint(
    chatId: string,
    roundId: string,
    status: Extract<EnsembleRoundState['status'], 'completed' | 'cancelled' | 'failed'>
  ): void {
    try {
      this.deps.completeSessionCheckpoint?.(chatId, roundId, status)
    } catch {
      // Same invariant as writes: checkpoint cleanup is best-effort.
    }
  }

  canAbsorbMidRunSteering(chatId: string, roundId?: string): boolean {
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime || runtime.cancelled) return false
    if (roundId && runtime.roundId !== roundId) return false
    const activeRound = this.deps.getChat(chatId)?.ensemble?.activeRound
    return Boolean(
      activeRound &&
      activeRound.roundId === runtime.roundId &&
      activeRound.status === 'running' &&
      this.deps.appendMidRunSteering
    )
  }

  /**
   * Append a user interjection without cancelling the active provider, round,
   * or hop sequence. Subsequent participant prompts pick it up from the live
   * transcript delta; optional attachments/grants/DM/discord context merge onto
   * the live runtime so later seats see them without a fresh round.
   */
  absorbMidRunSteering(input: {
    chatId: string
    roundId: string
    text: string
    imageAttachments?: EnsembleImageAttachment[]
    imageThumbnails?: EnsembleImageThumbnail[]
    dmTargetParticipantId?: string
    fanoutPolicy?: EnsembleFanoutPolicy
    externalPathGrants?: ExternalPathGrant[]
    discordContextSnapshots?: DiscordContextSnapshot[]
    projectReferenceContextSelection?: ProjectReferenceContextSelection
  }): EnsembleQueuedSteerResult {
    return this.absorbMidRunSteeringWithReceipt(input).result
  }

  private absorbMidRunSteeringWithReceipt(input: {
    chatId: string
    roundId: string
    text: string
    imageAttachments?: EnsembleImageAttachment[]
    imageThumbnails?: EnsembleImageThumbnail[]
    dmTargetParticipantId?: string
    fanoutPolicy?: EnsembleFanoutPolicy
    externalPathGrants?: ExternalPathGrant[]
    discordContextSnapshots?: DiscordContextSnapshot[]
    projectReferenceContextSelection?: ProjectReferenceContextSelection
  }): { result: EnsembleQueuedSteerResult; receipt?: MidRunSteeringAppendReceipt } {
    const text = input.text.trim()
    if (!text || !this.canAbsorbMidRunSteering(input.chatId, input.roundId)) {
      return { result: { status: 'ignored', error: 'No active Ensemble round' } }
    }
    const runtime = this.roundsByChatId.get(input.chatId)!
    this.cancelWakeupsOnUserInput(runtime)
    const imageAttachments = normalizeEnsembleImageAttachments(input.imageAttachments)
    const imageThumbnails = normalizeEnsembleImageThumbnails(input.imageThumbnails)
    const externalPathGrants = Array.isArray(input.externalPathGrants)
      ? input.externalPathGrants
      : []
    const discordContextSnapshots = normalizeDiscordContextSnapshots(input.discordContextSnapshots)
    this.mergeLiveRoundInterjectionOntoRuntime(runtime, {
      imageAttachments,
      imageThumbnails,
      dmTargetParticipantId: input.dmTargetParticipantId,
      fanoutPolicy: input.fanoutPolicy,
      externalPathGrants,
      discordContextSnapshots,
      projectReferenceContextSelection: input.projectReferenceContextSelection
    })
    const receipt = this.deps.appendMidRunSteering!({
      chatId: input.chatId,
      roundId: input.roundId,
      text,
      ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
      ...(imageThumbnails.length > 0 ? { imageThumbnails } : {})
    })
    return {
      result: { status: 'steered', roundId: input.roundId },
      receipt
    }
  }

  /**
   * Open the additive User Fan-Out wave an absorbed steer asked for.
   *
   * Both steer entries reach this: the queued-row Steer and the composer's
   * direct steer. They differ only in how the prompt arrived, never in what an
   * @mention means — routing the tagged seat a lane NOW rather than making the
   * user wait for its serial turn. Leaving it on one path made the same typed
   * text fan out or not depending on whether it had been parked in the queue
   * first, and silently dropped the wave for the composer's own Retry.
   *
   * Additive by construction: `launchUserFanout` skips seats already executing
   * and never replaces the active round.
   */
  private launchUserFanoutForAbsorbedSteer(
    runtime: ActiveRoundRuntime,
    input: {
      prompt: string
      dmTargetParticipantId?: string
      receipt?: MidRunSteeringAppendReceipt
    }
  ): void {
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) return
    const userFanout = resolveEnsembleUserFanoutTargets({
      text: input.prompt,
      participants: chat.ensemble.participants,
      ...(input.dmTargetParticipantId
        ? { exactTargetParticipantId: input.dmTargetParticipantId }
        : {})
    })
    if (!userFanout.hasParticipantMention) return
    for (const ambiguity of userFanout.ambiguities) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `User Fan-Out: \`@${ambiguity.text}\` is ambiguous (${ambiguity.participants
          .map((participant) => participantDisplayName(participant))
          .join(', ')}); no lane was started for that tag. Use a unique @role, @model, or @id.`
      )
    }
    // No receipt means the interjection never reached the transcript, so a lane
    // would have no user message to cite as its source.
    if (!input.receipt?.messageId) return
    this.launchUserFanout(runtime, userFanout.targets, input.prompt, input.receipt.messageId)
  }

  private mergeLiveRoundInterjectionOntoRuntime(
    runtime: ActiveRoundRuntime,
    input: {
      imageAttachments: EnsembleImageAttachment[]
      imageThumbnails: EnsembleImageThumbnail[]
      dmTargetParticipantId?: string
      fanoutPolicy?: EnsembleFanoutPolicy
      externalPathGrants: ExternalPathGrant[]
      discordContextSnapshots: DiscordContextSnapshot[]
      projectReferenceContextSelection?: ProjectReferenceContextSelection
    }
  ): void {
    if (input.imageAttachments.length > 0) {
      const seen = new Set(runtime.imageAttachments.map((attachment) => attachment.path))
      for (const attachment of input.imageAttachments) {
        if (seen.has(attachment.path)) continue
        seen.add(attachment.path)
        runtime.imageAttachments.push(attachment)
      }
    }
    if (input.imageThumbnails.length > 0) {
      runtime.imageThumbnails = [...runtime.imageThumbnails, ...input.imageThumbnails]
    }
    if (input.dmTargetParticipantId) {
      runtime.dmTargetParticipantId = input.dmTargetParticipantId
      // Directed absorb is a hard routing boundary for the seats still to
      // SPEAK: `runtime.dmTargetParticipantId` is what every dispatch gate
      // actually reads, so clamping fan-out here is enough to hold the scope,
      // and restart recovery rebuilds it from the persisted target alone.
      //
      // It is NOT a licence to rewrite the round that is already running. This
      // used to also stamp `fanoutPolicy: 'off'`, `concurrentMode: undefined`
      // and a one-seat `participants` list onto the persisted record so the UI
      // would "match beginRound DM scope" — but a live round's other seats are
      // real members with lanes in flight, and dropping them took their status
      // pills, token tallies, working rows and lane shimmer with them, for the
      // whole remaining life of the round. The composer infers a DM target from
      // any structured @mention, so a single "@Seat try again" silently
      // converted a running fan-out round into a one-seat serial one.
      runtime.fanoutPolicy = 'off'
      runtime.concurrentMode = undefined
      this.updateChatRound(runtime.chatId, (round) =>
        round?.roundId === runtime.roundId
          ? { ...round, dmTargetParticipantId: input.dmTargetParticipantId }
          : round
      )
    } else if (input.fanoutPolicy && isEnsembleFanoutPolicy(input.fanoutPolicy)) {
      runtime.fanoutPolicy = input.fanoutPolicy
      runtime.concurrentMode = fanoutPolicyEnablesConcurrent(input.fanoutPolicy) || undefined
      this.updateChatRound(runtime.chatId, (round) =>
        round?.roundId === runtime.roundId
          ? {
              ...round,
              fanoutPolicy: input.fanoutPolicy,
              concurrentMode: fanoutPolicyEnablesConcurrent(input.fanoutPolicy!) || undefined
            }
          : round
      )
    }
    if (input.externalPathGrants.length > 0) {
      runtime.externalPathGrants = [
        ...(runtime.externalPathGrants || []),
        ...input.externalPathGrants
      ]
    }
    if (input.discordContextSnapshots.length > 0) {
      runtime.discordContextSnapshots = [
        ...(runtime.discordContextSnapshots || []),
        ...input.discordContextSnapshots
      ]
    }
    if (input.projectReferenceContextSelection) {
      runtime.projectReferenceContextSelection = input.projectReferenceContextSelection
    }
  }

  /** Absorb the next FIFO queued prompt into the live round. Returns true when absorbed. */
  private absorbNextQueuedPromptIntoLiveRound(runtime: ActiveRoundRuntime): boolean {
    if (runtime.cancelled || runtime.queuedPrompts.length === 0) return false
    const [nextEntry, ...remainingQueue] = runtime.queuedPrompts
    if (!nextEntry) return false
    if (nextEntry.restartRecoveryBlockedReason) return false
    const targetError = this.queuedTargetUnavailableReason(runtime.chatId, nextEntry)
    if (targetError) {
      this.appendRoundStatus(runtime.chatId, runtime.roundId, targetError)
      return false
    }
    // Same ordering as steerQueuedPrompt: dequeue before absorb so the
    // mid-run append broadcast never republishes this prompt as queued.
    const previousQueue = runtime.queuedPrompts
    runtime.queuedPrompts = remainingQueue
    this.updateChatRound(runtime.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? { ...round, ...this.queuedPromptFields(remainingQueue) }
        : round
    )
    const absorbed = this.absorbMidRunSteering({
      chatId: runtime.chatId,
      roundId: runtime.roundId,
      text: nextEntry.prompt,
      imageAttachments: nextEntry.imageAttachments,
      imageThumbnails: nextEntry.imageThumbnails,
      dmTargetParticipantId: nextEntry.dmTargetParticipantId,
      fanoutPolicy: nextEntry.fanoutPolicy,
      externalPathGrants: nextEntry.externalPathGrants,
      discordContextSnapshots: nextEntry.discordContextSnapshots,
      projectReferenceContextSelection: nextEntry.projectReferenceContextSelection
    })
    if (absorbed.status === 'steered') return true
    runtime.queuedPrompts = previousQueue
    this.updateChatRound(runtime.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? { ...round, ...this.queuedPromptFields(previousQueue) }
        : round
    )
    return false
  }

  startRound(input: {
    chatId: string
    prompt: string
    event: EnsembleDispatchEvent
    mode?: EnsembleRunMode
    imageAttachments?: EnsembleImageAttachment[]
    imageThumbnails?: EnsembleImageThumbnail[]
    /**
     * A2 (1.0.3) — when set, scope the round to just this participant
     * (the "DM" routing the chip strip + composer pickers feed when
     * the user holds Cmd while sending). The round still flows through
     * the orchestrator's machinery (so per-participant status pills +
     * activeRound state + the per-participant token tally all keep
     * working), it just iterates a one-element participant list
     * instead of the full enabled set.
     */
    dmTargetParticipantId?: string
    /**
     * 1.0.4-AT4 — composer-level external path grants. Pre-AT4
     * the runEnsembleRound IPC payload didn't accept these, so
     * file-mention grants the user added in the composer never
     * reached the participant dispatch payload. The orchestrator
     * stashes them on the runtime and merges them into each
     * participant's effective permissions via
     * `resolveEffectiveRunPermissions`'s `explicitExternalPathGrants`
     * input (the resolver's provider-filter ensures each
     * participant only sees grants tagged for its own provider).
     */
    externalPathGrants?: ExternalPathGrant[]
    discordContextSnapshots?: DiscordContextSnapshot[]
    /**
     * P1 F6 — renderer Use-next selection. MAIN re-resolves per seat at
     * prompt assembly; selection grants no filesystem or network access.
     */
    projectReferenceContextSelection?: ProjectReferenceContextSelection
    /**
     * Legacy request for read-only concurrent fan-out for this round.
     * Prefer `fanoutPolicy`; `true` maps to `read_only`.
     */
    concurrentMode?: boolean
    fanoutPolicy?: EnsembleFanoutPolicy
    /**
     * P1b — set for a scheduled/workflow occurrence (unattended run).
     * Forces every participant's posture to the plan no-ask floor so an unattended
     * scheduled ensemble can't silently auto-accept edits via a
     * write-capable participant preset.
     */
    unattended?: boolean
    /**
     * P2 — a VERIFIED unattended-elevation level (resolved + HMAC-checked
     * main-side). On an unattended round, every participant's uniform posture
     * rises from read-only to the level's preset (full_access → workspace_write,
     * default → default). Absent ⇒ P1b plan (no-ask floor). Ignored when `unattended` is false.
     */
    unattendedElevationLevel?: UnattendedElevationLevel
    /**
     * Scheduled dispatches must own a genuinely new round. Unlike an
     * interactive send, they must never fall into the ordinary prompt queue
     * or reuse the id of a round that is already running/reserved.
     */
    requireFreshRound?: boolean
    /**
     * Synchronous ownership seam for callers that need to bind bookkeeping to
     * the new round before any participant (or an empty roster) can settle it.
     * Runs after the runtime reservation is installed and before `runRound`.
     */
    onRoundReserved?: (roundId: string) => void
    /**
     * Main-owned scheduled snapshot transform. It is evaluated only after all
     * fresh-round busy checks pass, inside the same synchronous stack that
     * persists the new active round, so a scheduled roster can never overwrite
     * an interactive round that already owns the chat.
     */
    prepareFreshChat?: (chat: ChatRecord) => ChatRecord
  }): { status: 'started' | 'queued' | 'steered' | 'ignored' | 'busy'; roundId?: string } {
    if (input.prepareFreshChat && !input.requireFreshRound) {
      throw new Error('A prepared Ensemble chat requires fresh-round ownership.')
    }
    // 1.0.4-AF — strip a leading `/discuss` (alias `/meta`) token so
    // the slash never reaches the panel verbatim. The flag flows
    // through to `beginRound` and lands on the runtime for the
    // round's lifetime; queued prompts get the same treatment so a
    // mid-round /discuss queue entry still flips its eventual round.
    const imageAttachments = normalizeEnsembleImageAttachments(input.imageAttachments)
    const parsed = parseSelfReflectivePrefix(input.prompt)
    const prompt =
      parsed.prompt.trim() ||
      (imageAttachments.length > 0 ? 'Please inspect the attached file(s).' : '')
    if (!prompt) return { status: 'ignored' }
    if (
      input.dmTargetParticipantId &&
      !input.prepareFreshChat &&
      !this.deps
        .getChat(input.chatId)
        ?.ensemble?.participants.some(
          (participant) => participant.id === input.dmTargetParticipantId
        )
    ) {
      throw new Error(
        `Directed Ensemble target "${input.dmTargetParticipantId}" is no longer in the roster.`
      )
    }
    const imageThumbnails = normalizeEnsembleImageThumbnails(input.imageThumbnails)
    let existing = this.roundsByChatId.get(input.chatId)
    if (existing) {
      const persistedRound = this.deps.getChat(input.chatId)?.ensemble?.activeRound
      const persistedRoundLive =
        persistedRound?.roundId === existing.roundId && isEnsembleRoundDispatchLive(persistedRound)
      if (!persistedRoundLive) {
        if (persistedRound?.roundId === existing.roundId) {
          this.finalizeInactiveRunningRoundSnapshot(
            input.chatId,
            existing.roundId,
            existing.cancelled ? 'cancelled' : 'completed'
          )
        }
        this.roundsByChatId.delete(input.chatId)
        existing = undefined
      }
    }
    if (input.requireFreshRound && existing) {
      return { status: 'busy' }
    }
    if (!existing) {
      const persistedRound = this.deps.getChat(input.chatId)?.ensemble?.activeRound
      const persistedQueue = persistedRound?.queuedPrompts?.length
        ? persistedRound.queuedPrompts
        : persistedRound?.queuedPrompt
          ? [persistedRound.queuedPrompt]
          : []
      if (
        input.requireFreshRound &&
        (isEnsembleRoundDispatchLive(persistedRound) || persistedQueue.length > 0)
      ) {
        return { status: 'busy' }
      }
      if (persistedRound && persistedQueue.length > 0) {
        this.appendRoundStatus(
          input.chatId,
          persistedRound.roundId,
          'New round not started after restart because queued Ensemble work is still preserved. Resume or delete the queued item first.'
        )
        return { status: 'ignored' }
      }
    }
    if (existing && !existing.cancelled) {
      this.cancelWakeupsOnUserInput(existing)
      if (input.mode === 'steer') {
        // Never cancel + beginRound for a live round. Absorb every shape into
        // the current round; fresh rounds are only for idle chats.
        const absorption = this.absorbMidRunSteeringWithReceipt({
          chatId: input.chatId,
          roundId: existing.roundId,
          text: prompt,
          imageAttachments,
          imageThumbnails,
          dmTargetParticipantId: input.dmTargetParticipantId,
          externalPathGrants: input.externalPathGrants,
          discordContextSnapshots: input.discordContextSnapshots,
          projectReferenceContextSelection: input.projectReferenceContextSelection
        })
        const absorbed = absorption.result
        if (absorbed.status === 'steered') {
          this.launchUserFanoutForAbsorbedSteer(existing, {
            prompt,
            ...(input.dmTargetParticipantId
              ? { dmTargetParticipantId: input.dmTargetParticipantId }
              : {}),
            ...(absorption.receipt ? { receipt: absorption.receipt } : {})
          })
          return { status: 'steered', roundId: existing.roundId }
        }
        // Absorb unavailable — queue instead of interrupting the live round.
        existing.queuedPrompts.push({
          id: this.nextQueuedPromptId(input.chatId),
          prompt: promptWithAttachmentReferences(prompt, imageAttachments),
          ...(input.dmTargetParticipantId
            ? { dmTargetParticipantId: input.dmTargetParticipantId }
            : {}),
          imageAttachments,
          ...(imageThumbnails.length ? { imageThumbnails } : {}),
          ...(input.externalPathGrants?.length
            ? { externalPathGrants: [...input.externalPathGrants] }
            : {}),
          fanoutPolicy: resolveRequestedEnsembleFanoutPolicy(
            this.deps.getChat(input.chatId)?.ensemble,
            input
          ),
          discordContextSnapshots: normalizeDiscordContextSnapshots(input.discordContextSnapshots),
          ...(input.projectReferenceContextSelection
            ? { projectReferenceContextSelection: input.projectReferenceContextSelection }
            : {})
        })
        this.updateChatRound(input.chatId, (round) =>
          round ? { ...round, ...this.queuedPromptFields(existing.queuedPrompts) } : round
        )
        return { status: 'queued', roundId: existing.roundId }
      }
      // Multi-entry queue: append rather than overwrite. The
      // chat-round state mirrors the runtime's `queuedPrompts` so the
      // renderer's stack picks up every entry.
      //
      // 1.0.5-EW43a — push a structured entry so the dequeue site
      // (line ~2150) can carry the attachments through to the
      // follow-up round. The prompt string still gets the
      // `promptWithAttachmentReferences` treatment so the
      // persisted/displayed form retains the text references the
      // renderer + transcript expect. Persistence keeps that string mirror and
      // a versioned structured mirror for restart-safe recovery.
      existing.queuedPrompts.push({
        id: this.nextQueuedPromptId(input.chatId),
        prompt: promptWithAttachmentReferences(prompt, imageAttachments),
        ...(input.dmTargetParticipantId
          ? { dmTargetParticipantId: input.dmTargetParticipantId }
          : {}),
        imageAttachments,
        ...(imageThumbnails.length ? { imageThumbnails } : {}),
        ...(input.externalPathGrants?.length
          ? { externalPathGrants: [...input.externalPathGrants] }
          : {}),
        fanoutPolicy: resolveRequestedEnsembleFanoutPolicy(
          this.deps.getChat(input.chatId)?.ensemble,
          input
        ),
        discordContextSnapshots: normalizeDiscordContextSnapshots(input.discordContextSnapshots),
        ...(input.projectReferenceContextSelection
          ? { projectReferenceContextSelection: input.projectReferenceContextSelection }
          : {})
      })
      this.updateChatRound(input.chatId, (round) =>
        round
          ? {
              ...round,
              // Keep the prompt-only renderer view and restart-safe routing
              // mirror in one atomic round update.
              ...this.queuedPromptFields(existing.queuedPrompts)
            }
          : round
      )
      return { status: 'queued', roundId: existing.roundId }
    }
    this.cancelPersistedWakeupsOnUserInput(input.chatId)
    const roundId = this.beginRound(
      input.chatId,
      prompt,
      input.event.sender,
      input.dmTargetParticipantId,
      imageAttachments,
      imageThumbnails,
      [],
      parsed.selfReflective,
      input.externalPathGrants,
      input.concurrentMode,
      input.fanoutPolicy,
      input.discordContextSnapshots,
      input.unattended,
      input.unattendedElevationLevel,
      undefined,
      input.onRoundReserved,
      input.prepareFreshChat,
      input.projectReferenceContextSelection
    )
    return { status: 'started', roundId }
  }

  /**
   * Restart-orphan recovery resolver. After an app restart the in-memory
   * `roundsByChatId` runtime is gone (nothing rehydrates it), but a persisted
   * active or terminal recovered round can retain queued rows after the
   * provider process disappears. Resolve the clicked item against its durable
   * structured mirror; terminal orphan recovery must not make the queue
   * unreachable merely because it correctly closed the dead parent round.
   *
   * Returns the persisted round + selected prompt + remaining queue when a
   * recoverable item matches, `{ error }` for a stale index/prefix, or `null`
   * when there is nothing to recover (caller keeps its existing no-runtime
   * behaviour).
   */
  private resolvePersistedQueuedPromptForRecovery(
    chatId: string,
    input: { index: number; textPrefix?: string; queuedPromptId?: string }
  ):
    | {
        round: EnsembleRoundState
        selectedIndex: number
        selected: QueuedRoundEntry
        remaining: QueuedRoundEntry[]
        restartSafe: true
      }
    | {
        round: EnsembleRoundState
        selectedIndex: number
        selected: string
        remaining: string[]
        restartSafe: false
      }
    | { error: string }
    | null {
    const round = this.deps.getChat(chatId)?.ensemble?.activeRound
    if (!round) return null
    const prompts =
      Array.isArray(round.queuedPrompts) && round.queuedPrompts.length > 0
        ? round.queuedPrompts
        : round.queuedPrompt
          ? [round.queuedPrompt]
          : []
    if (prompts.length === 0) return null
    const restored = this.restorePersistedQueuedEntries(round)
    const index = Number.isFinite(input.index) ? Math.floor(input.index) : -1
    if (index < 0 || index >= prompts.length) {
      return { error: 'Queued item no longer exists' }
    }
    if (restored) {
      const selectedIndex = input.queuedPromptId
        ? restored.findIndex((entry) => entry.id === input.queuedPromptId)
        : index
      if (selectedIndex < 0 || selectedIndex >= restored.length) {
        return { error: 'Queued item no longer exists' }
      }
      const selected = restored[selectedIndex]
      if (!selected || selectedIndex !== index) {
        return { error: 'Queue changed underneath — refresh and retry' }
      }
      if (input.textPrefix && !selected.prompt.startsWith(input.textPrefix)) {
        return { error: 'Queue changed underneath — refresh and retry' }
      }
      return {
        round,
        selectedIndex,
        selected,
        remaining: restored.filter((_, queuedIndex) => queuedIndex !== selectedIndex),
        restartSafe: true
      }
    }
    if (input.queuedPromptId) {
      return { error: 'Queued item no longer exists' }
    }
    const selected = prompts[index]
    if (input.textPrefix && !selected.startsWith(input.textPrefix)) {
      return { error: 'Queue changed underneath — refresh and retry' }
    }
    return {
      round,
      selectedIndex: index,
      selected,
      remaining: prompts.filter((_, queuedIndex) => queuedIndex !== index),
      restartSafe: false
    }
  }

  steerQueuedPrompt(input: {
    chatId: string
    index: number
    event: EnsembleDispatchEvent
    textPrefix?: string
    queuedPromptId?: string
    concurrentMode?: boolean
    fanoutPolicy?: EnsembleFanoutPolicy
  }): EnsembleQueuedSteerResult {
    const runtime = this.roundsByChatId.get(input.chatId)
    if (!runtime) {
      // Restart-orphan recovery. After an app restart the in-memory runtime is
      // gone, but a persisted dispatch-live round still renders queued rows + a
      // live Steer button — so clicking it hit `!runtime` and returned a dead
      // 'ignored' on every click. There is no live process to cancel (the
      // previous app instance's provider processes died with it), so begin a
      // FRESH round for the clicked queued prompt, mirroring how `startRound`
      // recovers a stale snapshot by falling through to `beginRound`.
      const recovered = this.resolvePersistedQueuedPromptForRecovery(input.chatId, input)
      if (!recovered) return { status: 'ignored', error: 'No active Ensemble round' }
      if ('error' in recovered) return { status: 'ignored', error: recovered.error }
      if (!recovered.restartSafe) {
        const error =
          'Queued prompt preserved but not dispatched because its restart-era routing metadata is unavailable.'
        this.appendRoundStatus(input.chatId, recovered.round.roundId, error)
        return { status: 'ignored', error }
      }
      if (recovered.selected.restartRecoveryBlockedReason) {
        const error = recovered.selected.restartRecoveryBlockedReason
        this.appendRoundStatus(input.chatId, recovered.round.roundId, error)
        return { status: 'ignored', error }
      }
      const targetError = this.queuedTargetUnavailableReason(input.chatId, recovered.selected)
      if (targetError) {
        this.appendRoundStatus(input.chatId, recovered.round.roundId, targetError)
        return { status: 'ignored', error: targetError }
      }
      this.cancelPersistedWakeupsOnUserInput(input.chatId)
      const roundId = this.beginRound(
        input.chatId,
        recovered.selected.prompt,
        input.event.sender,
        recovered.selected.dmTargetParticipantId,
        recovered.selected.imageAttachments,
        recovered.selected.imageThumbnails ?? [],
        recovered.remaining,
        false,
        recovered.selected.externalPathGrants ?? [],
        input.concurrentMode,
        recovered.selected.fanoutPolicy ?? input.fanoutPolicy,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        recovered.selected.projectReferenceContextSelection
      )
      this.appendRoundStatus(
        input.chatId,
        roundId,
        'Ensemble steered: recovered the round after restart and started the queued prompt.'
      )
      return { status: 'steered', roundId }
    }
    if (runtime.cancelled) {
      return { status: 'ignored', error: 'No active Ensemble round' }
    }
    // NOTE: a steer that lands while `runtime.startAfterCancellation` is still
    // set (the replacement round of a PRIOR steer is parked in `runRound`,
    // awaiting a slow Claude/Codex interrupt before it dispatches) falls through
    // to the real steer below. That is correct and safe: `cancelRound` on the
    // parked round finds an empty active-run set (it never dispatched → nothing
    // to orphan), and the truly-interrupted run from the prior steer was already
    // finalised 'cancelled' before its SIGINT — so nothing surfaces as a red
    // "Failed exit 130". An earlier coalesce guard here returned 'steered'
    // WITHOUT dispatching, which silently swallowed the user's genuine
    // first-click steer of a newly-queued message (it drained only at round-end)
    // and is exactly what forced the second click. The renderer single-flight
    // guard + `resolveQueuedPrompt`'s textPrefix check still absorb a true rapid
    // double-click of the SAME item (its index/prefix no longer matches ⇒
    // 'ignored'), so removing the coalesce does not reintroduce a double-fire.
    const resolved = this.resolveQueuedPrompt(runtime, input)
    if ('error' in resolved) {
      return { status: 'ignored', error: resolved.error }
    }
    const { selected, selectedIndex } = resolved
    if (selected.restartRecoveryBlockedReason) {
      const error = selected.restartRecoveryBlockedReason
      this.appendRoundStatus(input.chatId, runtime.roundId, error)
      return { status: 'ignored', error }
    }
    const targetError = this.queuedTargetUnavailableReason(input.chatId, selected)
    if (targetError) {
      this.appendRoundStatus(input.chatId, runtime.roundId, targetError)
      return { status: 'ignored', error: targetError }
    }

    const remainingQueue = runtime.queuedPrompts.filter(
      (_, queuedIndex) => queuedIndex !== selectedIndex
    )
    // Dequeue BEFORE mid-run absorb. Absorb appends a transcript message via
    // saveAndBroadcastChat; if the steered prompt is still in queuedPrompts
    // on that broadcast, the renderer can restore it after an optimistic
    // splice and then refuse the later empty-queue update
    // (preserveOptimisticEnsembleQueue keeps any longer local FIFO).
    const previousQueue = runtime.queuedPrompts
    runtime.queuedPrompts = remainingQueue
    this.updateChatRound(input.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? { ...round, ...this.queuedPromptFields(remainingQueue) }
        : round
    )
    const absorption = this.absorbMidRunSteeringWithReceipt({
      chatId: input.chatId,
      roundId: runtime.roundId,
      text: selected.prompt,
      imageAttachments: selected.imageAttachments,
      imageThumbnails: selected.imageThumbnails,
      dmTargetParticipantId: selected.dmTargetParticipantId,
      fanoutPolicy: selected.fanoutPolicy ?? input.fanoutPolicy,
      externalPathGrants: selected.externalPathGrants,
      discordContextSnapshots: selected.discordContextSnapshots,
      projectReferenceContextSelection: selected.projectReferenceContextSelection
    })
    const absorbed = absorption.result
    if (absorbed.status === 'steered') {
      this.launchUserFanoutForAbsorbedSteer(runtime, {
        prompt: selected.prompt,
        ...(selected.dmTargetParticipantId
          ? { dmTargetParticipantId: selected.dmTargetParticipantId }
          : {}),
        ...(absorption.receipt ? { receipt: absorption.receipt } : {})
      })
      return absorbed
    }
    // Absorb failed — put the entry back so Steer is not a silent drop.
    runtime.queuedPrompts = previousQueue
    this.updateChatRound(input.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? { ...round, ...this.queuedPromptFields(previousQueue) }
        : round
    )
    return { status: 'ignored', error: absorbed.error || 'No active Ensemble round' }
  }

  removeQueuedPrompt(input: {
    chatId: string
    index: number
    textPrefix?: string
    queuedPromptId?: string
  }): EnsembleQueuedPromptMutationResult {
    const runtime = this.roundsByChatId.get(input.chatId)
    if (!runtime) {
      // Restart-orphan recovery (same class as `steerQueuedPrompt`): with no
      // in-memory runtime, mutate the persisted round's `queuedPrompts` string
      // list directly so the queued-row Delete (✗) button isn't a dead no-op
      // after an app restart.
      const recovered = this.resolvePersistedQueuedPromptForRecovery(input.chatId, input)
      if (!recovered) return { ok: false, error: 'No active Ensemble round' }
      if ('error' in recovered) return { ok: false, error: recovered.error }
      this.updateChatRound(input.chatId, (round) =>
        round?.roundId === recovered.round.roundId
          ? {
              ...round,
              ...(recovered.restartSafe
                ? this.queuedPromptFields(recovered.remaining)
                : {
                    queuedPrompt: recovered.remaining[0],
                    queuedPrompts: recovered.remaining,
                    queuedPromptEntries: undefined
                  })
            }
          : round
      )
      if (recovered.restartSafe) {
        return {
          ok: true,
          prompt: recovered.selected.prompt,
          queuedPrompts: recovered.remaining.map((entry) => entry.prompt),
          imageAttachments: recovered.selected.imageAttachments.map((attachment) => ({
            ...attachment
          })),
          ...(recovered.selected.dmTargetParticipantId
            ? { dmTargetParticipantId: recovered.selected.dmTargetParticipantId }
            : {})
        }
      }
      return {
        ok: true,
        prompt: recovered.selected,
        queuedPrompts: recovered.remaining
      }
    }
    if (runtime.cancelled) {
      return { ok: false, error: 'No active Ensemble round' }
    }
    const resolved = this.resolveQueuedPrompt(runtime, input)
    if ('error' in resolved) {
      return { ok: false, error: resolved.error }
    }
    const { selected, selectedIndex } = resolved

    runtime.queuedPrompts = runtime.queuedPrompts.filter(
      (_, queuedIndex) => queuedIndex !== selectedIndex
    )
    this.updateChatRound(input.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? {
            ...round,
            ...this.queuedPromptFields(runtime.queuedPrompts)
          }
        : round
    )

    const nextQueuedPrompts = runtime.queuedPrompts.map((entry) => entry.prompt)
    return {
      ok: true,
      prompt: selected.prompt,
      queuedPrompts: nextQueuedPrompts,
      imageAttachments: selected.imageAttachments.map((attachment) => ({ ...attachment })),
      ...(selected.dmTargetParticipantId
        ? { dmTargetParticipantId: selected.dmTargetParticipantId }
        : {})
    }
  }

  private clearQueuedPromptsForRuntime(runtime: ActiveRoundRuntime): void {
    runtime.queuedPrompts = []
    this.updateChatRound(runtime.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? {
            ...round,
            queuedPrompt: undefined,
            queuedPrompts: [],
            queuedPromptEntries: []
          }
        : round
    )
  }

  private prepareBossYieldToUserClose(runtime: ActiveRoundRuntime): void {
    this.cancelWakeupsForRuntime(runtime, 'cancelled by Boss closeout')
    this.clearQueuedPromptsForRuntime(runtime)
    this.clearYieldReturnStack(runtime)
  }

  private finalizeInactiveRunningRoundSnapshot(
    chatId: string,
    roundId: string,
    status: Extract<EnsembleRoundState['status'], 'completed' | 'cancelled' | 'failed'>
  ): boolean {
    const round = this.deps.getChat(chatId)?.ensemble?.activeRound
    if (!round || round.roundId !== roundId || round.status !== 'running') return false
    if (isEnsembleRoundDispatchLive(round)) return false
    this.finishRound(chatId, roundId, status)
    return true
  }

  async cancelRound(
    chatId: string,
    reason = 'cancelled',
    expectedRoundId?: string,
    strictTransport = false
  ): Promise<boolean> {
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime) {
      const chat = this.deps.getChat(chatId)
      const round = chat?.ensemble?.activeRound
      if (!round || round.status !== 'running') return false
      if (expectedRoundId && round.roundId !== expectedRoundId) return false
      for (const wakeup of Object.values(chat?.ensemble?.wakeups || {})) {
        if (wakeup.roundId === round.roundId && wakeup.status === 'pending') {
          this.markWakeupCancelled(wakeup, reason)
        }
      }
      const endedAt = this.deps.nowIso()
      this.updateChatRound(chatId, (current) =>
        current?.roundId === round.roundId
          ? {
              ...current,
              status: 'cancelled',
              queuedPrompt: undefined,
              queuedPrompts: [],
              queuedPromptEntries: [],
              activeParticipantId: undefined,
              endedAt,
              participants: current.participants.map((participant) =>
                participant.status === 'idle' || participant.status === 'running'
                  ? {
                      ...participant,
                      status: 'cancelled',
                      reason,
                      endedAt
                    }
                  : participant
              )
            }
          : current
      )
      this.completeCheckpoint(chatId, round.roundId, 'cancelled')
      return true
    }
    if (expectedRoundId && runtime.roundId !== expectedRoundId) return false
    if (expectedRoundId) {
      const persistedRound = this.deps.getChat(chatId)?.ensemble?.activeRound
      if (
        !persistedRound ||
        persistedRound.roundId !== expectedRoundId ||
        persistedRound.status !== 'running'
      ) {
        return false
      }
    }
    runtime.cancelled = true
    // Stop closes the round immediately: a drain deferred behind active
    // lanes must not race this cancel path to a second finishRound.
    this.deferredLaneDrainByChatId.delete(chatId)
    runtime.queuedPrompts = []
    runtime.userFanoutSerialParticipantIds = undefined
    this.clearYieldReturnStack(runtime)
    const pendingParticipantSeatChanges = runtime.pendingParticipantSeatChanges
    runtime.pendingParticipantSeatChanges = undefined
    this.cancelWakeupsForRuntime(runtime, reason)
    const roundId = runtime.roundId
    const activeRunIds = new Set<string>()
    if (runtime.activeRunId) activeRunIds.add(runtime.activeRunId)
    // A fan-out owner can already be provider-terminal (and therefore no
    // longer runtime.activeRunId) while the serial loop awaits its lanes. Keep
    // it addressable until settlement so Stop can cancel its held transcript.
    for (const run of this.runsByRunId.values()) {
      if (
        run.chatId === chatId &&
        run.roundId === roundId &&
        !run.laneId &&
        this.hasOwnedFanoutWork(run)
      ) {
        activeRunIds.add(run.runId)
      }
    }
    for (const runId of runtime.activeScoutRunIds || []) {
      activeRunIds.add(runId)
    }
    const activeRuns = [...activeRunIds]
      .map((runId) => this.runsByRunId.get(runId))
      .filter((run): run is ActiveParticipantRun => Boolean(run))
    const liveActiveRuns = activeRuns.filter((run) => !run.terminalFinalized)
    for (const active of activeRuns) {
      this.finalizeRun(active, 'cancelled', reason)
    }
    for (const active of liveActiveRuns) {
      this.updateParticipantState(chatId, roundId, active.participant.id, 'cancelled', reason)
    }
    const endedAt = this.deps.nowIso()
    this.updateChatRound(chatId, (round) =>
      round?.roundId === roundId
        ? {
            ...round,
            status: 'cancelled',
            queuedPrompt: undefined,
            queuedPrompts: [],
            queuedPromptEntries: [],
            activeParticipantId: undefined,
            endedAt,
            participants: round.participants.map((participant) =>
              participant.status === 'idle' || participant.status === 'running'
                ? {
                    ...participant,
                    status: 'cancelled',
                    reason,
                    endedAt
                  }
                : participant
            )
          }
        : round
    )
    this.completeCheckpoint(chatId, roundId, 'cancelled')
    this.applyPendingParticipantSeatChanges(runtime, pendingParticipantSeatChanges)
    this.clearRuntimeIfCurrent(runtime)
    for (const active of liveActiveRuns) {
      try {
        const result = await this.requestExactRunCancellation(active)
        if (strictTransport && result !== true) {
          throw new Error(`Ensemble run ${active.runId} did not confirm cancellation.`)
        }
      } catch (error) {
        if (strictTransport) throw error
      }
    }
    return true
  }

  /** History deletion needs the round loop itself, not only seeded providers, quiesced. */
  async cancelRoundForHistory(
    chatId: string,
    reason = 'chat history cleared',
    expectedRoundId?: string
  ): Promise<boolean> {
    const chat = this.deps.getChat(chatId)
    const runtime = this.roundsByChatId.get(chatId)
    const persistedRound = chat?.ensemble?.activeRound

    // A stale coordinator must never fence a successor round. With no runtime,
    // there is no provider activity to join: cancel every target-chat timer and
    // let the outer history transaction own the sole durable commit.
    if (!runtime) {
      if (
        expectedRoundId &&
        persistedRound?.status === 'running' &&
        persistedRound.roundId !== expectedRoundId
      ) {
        return false
      }
      this.cancelHistoryTimerHandles(chatId, undefined, chat)
      return true
    }
    const roundId = expectedRoundId ?? runtime.roundId
    if (runtime.roundId !== roundId) return false
    if (
      expectedRoundId &&
      (!persistedRound ||
        persistedRound.roundId !== expectedRoundId ||
        persistedRound.status !== 'running')
    ) {
      return false
    }
    const trackedRuns = new Set(this.exactRoundRuns(chatId, roundId))
    const transportsRequiringHistoryJoin = [...trackedRuns].filter(
      (run) =>
        run.terminalFinalized !== true &&
        (run.transportDispatchState === 'pending' ||
          run.transportDispatchState === 'accepted' ||
          run.transportDispatchState === 'unknown')
    )
    // This call is deliberately synchronous up to the activity join. It closes
    // every in-memory admission/timer/event route before yielding, but performs
    // no AppStore/checkpoint write after the outer durable prepare.
    this.fenceRoundForHistory(runtime, trackedRuns, reason, chat)
    await this.joinHistoryRoundActivities(runtime, trackedRuns)
    for (const run of transportsRequiringHistoryJoin) {
      if (run.transportDispatchState === 'pending') {
        throw new Error(`Ensemble run ${run.runId} did not settle provider admission.`)
      }
      if (run.transportDispatchState === 'accepted' || run.transportDispatchState === 'unknown') {
        let confirmed = false
        try {
          confirmed = (await this.requestExactHistoryTransportTermination(run)) === true
        } catch {
          confirmed = false
        }
        if (!confirmed) {
          throw new Error(
            `Ensemble run ${run.runId} did not confirm history-safe transport settlement.`
          )
        }
      }
    }
    return true
  }

  /**
   * User-driven mid-round skip (1.0.3 post-ship).
   *
   * Cancels the active participant's provider run and finalises them
   * as `'skipped'`. The orchestrator's `runRound` while-loop sees the
   * completion promise resolve and naturally advances to the next
   * participant — so the round continues without restart, unlike the
   * existing Steer pattern (which cancels + re-dispatches the same
   * participant). Returns `true` if a skip was applied, `false` if
   * there's no active run for this chat (e.g. the user clicked Skip
   * after the round already moved on).
   *
   * Distinct from `markYielded` (participant-driven, "I voluntarily
   * pass") and from `cancelRound` (user-driven, "stop the entire
   * ensemble"). The composer's existing Stop button still handles
   * full-round cancellation via `cancelRound`.
   */
  async skipActiveParticipant(chatId: string): Promise<boolean> {
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime) return false
    const activeRunId = runtime.activeRunId
    const active =
      (activeRunId ? this.runsByRunId.get(activeRunId) : undefined) ||
      [...this.runsByRunId.values()].find(
        (run) =>
          run.chatId === chatId &&
          run.roundId === runtime.roundId &&
          !run.laneId &&
          run.terminalFinalized === true &&
          this.hasOwnedFanoutWork(run)
      )
    if (!active) return false
    const ownerWasTerminal = active.terminalFinalized === true
    const ownedLanes = [...(active.ownedFanoutRunIds || [])]
      .map((runId) => this.runsByRunId.get(runId))
      .filter((run): run is ActiveParticipantRun => Boolean(run?.laneId))
    // Finalise/suppress first, then terminally cancel every lane this owner is
    // awaiting so the serial loop can advance without a provider callback.
    active.fanoutDispatchCancelled = true
    this.finalizeRun(active, 'skipped', 'Skipped by user.')
    if (runtime.activeRunId === active.runId) runtime.activeRunId = undefined
    for (const lane of ownedLanes) {
      this.finalizeRun(lane, 'cancelled', 'Owning participant was skipped.')
      runtime.activeScoutRunIds?.delete(lane.runId)
    }
    if (runtime.activeScoutRunIds?.size === 0) runtime.activeScoutRunIds = undefined
    const cancellations: Promise<unknown>[] = []
    if (!ownerWasTerminal) {
      cancellations.push(
        this.deps.cancelRun(active.participant.provider, active.runId).catch(() => undefined)
      )
    }
    for (const lane of ownedLanes) {
      cancellations.push(
        this.deps.cancelRun(lane.participant.provider, lane.runId).catch(() => undefined)
      )
    }
    await Promise.all(cancellations)
    return true
  }

  async skipReadFanout(chatId: string): Promise<boolean> {
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime || runtime.cancelled || !runtime.activeScoutRunIds?.size) return false
    const chat = this.deps.getChat(chatId)
    const round = chat?.ensemble?.activeRound
    if (!round?.lanes || round.roundId !== runtime.roundId) return false

    const activeRuns = [...runtime.activeScoutRunIds]
      .map((runId) => this.runsByRunId.get(runId))
      .filter((run): run is ActiveParticipantRun => Boolean(run?.laneId))
    if (activeRuns.length === 0) return false

    const activeLaneForRun = (run: ActiveParticipantRun): ConcurrentLane | undefined => {
      const lane = run.laneId ? round.lanes?.[run.laneId] : undefined
      return lane && !isTerminalLaneStatus(lane.status) ? lane : undefined
    }
    const writeRuns = activeRuns.filter((run) => activeLaneForRun(run)?.intent === 'write')
    if (writeRuns.length > 0) return false

    const readRuns = activeRuns.filter((run) => activeLaneForRun(run)?.intent === 'read')
    if (readRuns.length === 0) return false

    const reason = 'Read fan-out skipped by user.'
    for (const run of readRuns) {
      this.finalizeRun(run, 'cancelled', reason)
      runtime.activeScoutRunIds?.delete(run.runId)
    }
    if (runtime.activeScoutRunIds?.size === 0) {
      runtime.activeScoutRunIds = undefined
    }
    this.appendRoundStatus(
      chatId,
      runtime.roundId,
      `Read fan-out skipped · ${readRuns.length} read/background lane(s) stopped; foreground rotation continues.`
    )
    for (const run of readRuns) {
      await this.deps.cancelRun(run.participant.provider, run.runId).catch(() => undefined)
    }
    return true
  }

  /**
   * Skip one live fan-out lane (User Fan-Out / orchestrated reader or writer
   * viewport) without cancelling the round or sibling lanes. The lane is
   * finalized as `cancelled` so wave waiters (`ensemble_await`, owned
   * settlements, concurrent-mode drain) treat it as terminal — not `failed`
   * (provider fault) and not participant `skipped` (which would map the lane
   * to `completed`).
   *
   * Distinct from `skipReadFanout` (whole read wave) and
   * `skipActiveParticipant` (serial speaker + owned-lane cascade).
   */
  async skipFanoutLane(chatId: string, laneId: string): Promise<boolean> {
    const trimmedLaneId = typeof laneId === 'string' ? laneId.trim() : ''
    if (!trimmedLaneId) return false
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime || runtime.cancelled) return false
    const chat = this.deps.getChat(chatId)
    const round = chat?.ensemble?.activeRound
    if (!round?.lanes || round.roundId !== runtime.roundId) return false
    const lane = round.lanes[trimmedLaneId]
    if (!lane || isTerminalLaneStatus(lane.status)) return false

    const activeRuns = [...(runtime.activeScoutRunIds || [])]
      .map((runId) => this.runsByRunId.get(runId))
      .filter((run): run is ActiveParticipantRun => Boolean(run?.laneId))
    const run =
      activeRuns.find((candidate) => candidate.laneId === trimmedLaneId) ||
      [...this.runsByRunId.values()].find(
        (candidate) =>
          candidate.chatId === chatId &&
          candidate.roundId === runtime.roundId &&
          candidate.laneId === trimmedLaneId &&
          candidate.terminalFinalized !== true
      )
    if (!run) return false

    const reason = 'Fan-out lane skipped by user.'
    this.finalizeRun(run, 'cancelled', reason)
    runtime.activeScoutRunIds?.delete(run.runId)
    if (runtime.activeScoutRunIds?.size === 0) {
      runtime.activeScoutRunIds = undefined
    }
    const who = participantDisplayName(run.participant)
    this.appendRoundStatus(
      chatId,
      runtime.roundId,
      `Fan-out lane skipped · ${who} stopped; remaining lanes continue.`
    )
    await this.deps.cancelRun(run.participant.provider, run.runId).catch(() => undefined)
    return true
  }

  markYielded(runId: string, reason?: string, target?: string): EnsembleYieldOutcome {
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return this.isRecentlyTerminalRun(runId)
        ? { kind: 'already_settled' }
        : { kind: 'no_active_run' }
    }
    const runtime = this.roundsByChatId.get(run.chatId)
    const chat = this.deps.getChat(run.chatId)
    const isFanoutLane = Boolean(run.laneId) || Boolean(runtime?.activeScoutRunIds?.has(runId))
    if (runtime && chat?.ensemble) {
      const fanoutHandoffHold = this.activeFanoutManagerHandoffHold(
        chat,
        runtime,
        run,
        target,
        isFanoutLane
      )
      if (fanoutHandoffHold) {
        this.appendRoundStatus(run.chatId, run.roundId, fanoutHandoffHold.message)
        this.completePendingYieldActivity(run, reason, target, {
          content: fanoutHandoffHold.message,
          result: {
            ok: true,
            tool: 'ensemble_yield',
            action: 'held_for_active_fanout',
            ...(reason ? { reason } : {}),
            ...(target ? { target } : {}),
            activeLaneCount: fanoutHandoffHold.activeLaneCount,
            eligibleManagerParticipantIds: fanoutHandoffHold.eligibleManagerParticipantIds,
            ...(fanoutHandoffHold.suggestedAliases.length
              ? { suggestedAliases: fanoutHandoffHold.suggestedAliases }
              : {})
          }
        })
        return fanoutHandoffHold
      }
    }
    const checkpoint = run.authorityRoutingCheckpoint
    const explicitCheckpointTarget = target
      ? resolveYieldTargetDetail(
          target,
          chat?.ensemble?.participants || [],
          new Set([run.participant.id])
        )
      : undefined
    const requiresExplicitAuthorityRoutingDecision =
      checkpoint?.selectionRequired || checkpoint?.kind === 'tagged_intervention'
    if (
      requiresExplicitAuthorityRoutingDecision &&
      !run.authorityRoutingDecision &&
      (!target || isUserYieldTarget(target) || explicitCheckpointTarget?.kind !== 'resolved')
    ) {
      this.appendRoundStatus(
        run.chatId,
        run.roundId,
        checkpoint?.kind === 'tagged_intervention'
          ? `Authority routing checkpoint: ${participantDisplayName(run.participant)} must make a targeted routing decision or explicitly skip this tagged intervention before yielding.`
          : `Authority routing checkpoint: ${participantDisplayName(run.participant)} must select pending participants, route with a targeted yield/@mention/fan-out, or explicitly preserve the queue before yielding this Continuous pass.`
      )
      return {
        kind: 'authority_routing_decision_required',
        pass: checkpoint.pass,
        requirement:
          checkpoint?.kind === 'tagged_intervention'
            ? 'tagged_intervention'
            : 'later_pass_selection'
      }
    }
    run.status = 'yielded'
    let routing: EnsembleYieldRoutingResult | undefined

    if (target && runtime && chat?.ensemble) {
      if (isFanoutLane) {
        routing = { ok: false, reason: 'fanout_lane_ignored', target }
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          yieldRejectStatusLine({ target, reason: 'fanout_lane_ignored' })
        )
      } else {
        routing = this.applyYieldTargetRouting(chat, runtime, run, target)
      }
      const stored = routing
        ? storedYieldRoutingFromResult(routing, run, {
            continuationReserved: routing.ok && routing.action === 'resummoned'
          })
        : undefined
      if (stored) runtime.yieldRouting = stored
      if (routing?.ok && routing.action !== 'user') {
        this.markAuthorityRoutingDecision(run, 'redirected')
      }
    }

    this.completePendingYieldActivity(run, reason, target)
    this.finalizeRun(run, 'yielded', reason || 'Participant yielded.')
    // Path-B Cursor has no TaskWraith MCP completion owner. Once its streamed
    // yield has been accepted (including a routing rejection), release the
    // round first and then terminate this exact child. Otherwise the logical
    // run is gone while a silent Cursor process can remain alive as a zombie.
    if (run.participant.provider === 'cursor') {
      void this.requestExactRunCancellation(run).catch(() => undefined)
    }
    return { kind: 'yielded', ...(routing ? { routing } : {}) }
  }

  /**
   * Keep an unsettled fan-out wave inside its configured authority ring.
   *
   * Ordinary yields remain unchanged once every lane/dispatch settles. While
   * work is live, a configured Boss or Captain may:
   * - hand off immediately to the OTHER currently-routable authority seat, or
   * - record an explicit yield to a concrete foreground worker (deferred until
   *   the wave settles, same as non-Boss owners).
   * Targetless yields, yields to the user, and unresolved/ambiguous targets
   * stay as acknowledged non-terminal holds so the authority seat remains
   * alive for ensemble_await / ensemble_lane_result synthesis.
   */
  private activeFanoutManagerHandoffHold(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun,
    target: string | undefined,
    isFanoutLane: boolean
  ): Extract<EnsembleYieldOutcome, { kind: 'fanout_handoff_held' }> | undefined {
    if (isFanoutLane) return undefined
    if (!this.fanoutAuthorityRoleForCaller(chat, runtime, run.participant.id)) return undefined

    const activeLaneCount = this.unsettledFanoutLaneCount(runtime, run)
    if (activeLaneCount === 0) return undefined

    const participants = chat.ensemble?.participants || []
    const configuredManagerIds = [
      this.activeBossmanParticipantId(chat, runtime),
      ...this.activeCaptainParticipantIds(chat, runtime)
    ].filter(
      (participantId, index, all): participantId is string =>
        typeof participantId === 'string' &&
        participantId !== run.participant.id &&
        all.indexOf(participantId) === index
    )
    const eligibleManagers = configuredManagerIds
      .map((participantId) => participants.find((participant) => participant.id === participantId))
      .filter((participant): participant is EnsembleParticipant => Boolean(participant))
      .filter((participant) =>
        this.canReceiveActiveFanoutManagerHandoff(chat, runtime, participant)
      )
    const eligibleManagerIds = new Set(eligibleManagers.map((participant) => participant.id))
    const detail =
      target && !isUserYieldTarget(target)
        ? resolveYieldTargetDetail(target, participants, new Set([run.participant.id]))
        : undefined
    if (detail?.kind === 'resolved' && eligibleManagerIds.has(detail.participant.id)) {
      return undefined
    }
    // Concrete foreground worker handoff: let markYielded store yieldRouting
    // (deferred until settlement). Keep the hold for targetless / user /
    // unresolved / ambiguous / background targets so Boss stays alive to
    // synthesize.
    if (
      detail?.kind === 'resolved' &&
      detail.participant.enabled &&
      !isBackgroundParticipant(detail.participant) &&
      !this.fanoutAuthorityRoleForCaller(chat, runtime, detail.participant.id)
    ) {
      return undefined
    }

    const suggestedAliases = suggestUniqueYieldAliases(eligibleManagers)
    const laneLabel = `${activeLaneCount} fan-out lane${activeLaneCount === 1 ? '' : 's'}`
    const attemptedTarget = target?.trim()
      ? ` Target "${target.trim()}" is not an available Boss/Captain handoff.`
      : ' An explicit Boss/Captain target is required.'
    const nextAction = suggestedAliases.length
      ? ` Available manager target${eligibleManagers.length === 1 ? '' : 's'}: ${suggestedAliases.join(', ')}.`
      : ' No peer Boss/Captain is currently routable, so keep this authority turn active.'
    const message =
      `Fan-out handoff held: ${participantDisplayName(run.participant)} remains responsible while ${laneLabel} ${activeLaneCount === 1 ? 'remains' : 'remain'} unsettled.` +
      `${attemptedTarget} During an active fan-out, Boss/Captain may yield only to another available Boss/Captain.` +
      `${nextAction} Use ensemble_await and ensemble_lane_result when listed to monitor and synthesize the wave; normal serial routing resumes after every lane settles.`
    return {
      kind: 'fanout_handoff_held',
      message,
      activeLaneCount,
      eligibleManagerParticipantIds: eligibleManagers.map((participant) => participant.id),
      suggestedAliases
    }
  }

  private unsettledFanoutLaneCount(runtime: ActiveRoundRuntime, run: ActiveParticipantRun): number {
    const round = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
    if (!round || round.roundId !== runtime.roundId || round.status !== 'running') return 0
    const activeLanes = Object.values(round.lanes || {}).filter(
      (lane) => !isTerminalLaneStatus(lane.status)
    )
    const activeParticipantIds = new Set(activeLanes.map((lane) => lane.participantId))
    let count = activeLanes.length
    for (const participantId of runtime.fanoutReservedParticipantIds || []) {
      if (!activeParticipantIds.has(participantId)) count += 1
    }
    return Math.max(count, run.pendingFanoutDispatches?.size || 0)
  }

  private runMissingOwnedFanoutSynthesis(run: ActiveParticipantRun): boolean {
    return (
      run.ownedFanoutTranscriptBoundary !== undefined &&
      (run.timeline?.length || 0) <= run.ownedFanoutTranscriptBoundary &&
      !run.fanoutTimedOut
    )
  }

  private noteMissingOwnedFanoutSynthesis(
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): void {
    if (!this.runMissingOwnedFanoutSynthesis(run)) return
    if (run.terminalFinalized === true) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${participantDisplayName(run.participant)} ended the turn without synthesizing fan-out results.`
      )
      return
    }
    run.fanoutSynthesisRequired = true
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${participantDisplayName(run.participant)} must synthesize fan-out results before the turn can advance.`
    )
  }

  private pendingYieldTargetsActiveFanoutManager(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): boolean {
    const pending = runtime.yieldRouting
    if (!pending || pending.kind !== 'queue') return false
    if (pending.targetParticipantId === run.participant.id) return false
    const target = chat.ensemble?.participants.find(
      (entry) => entry.id === pending.targetParticipantId && entry.enabled
    )
    if (!target) return false
    return Boolean(this.fanoutAuthorityRoleForCaller(chat, runtime, target.id))
  }

  private clearNonAuthorityFanoutYieldRouting(
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): void {
    // Preserve any explicit queue handoff with a concrete seat — manager or
    // worker. Authority-ring re-summons must not wipe a deferred Boss→worker
    // yieldRouting that should apply once the wave settles.
    if (
      runtime.yieldRouting?.kind === 'queue' &&
      runtime.yieldRouting.targetParticipantId
    ) {
      return
    }
    if (!runtime.yieldRouting) return
    runtime.yieldRouting = undefined
    this.discardYieldReturnFrameForYielder(runtime, run.participant.id)
  }

  /**
   * Keep Boss/Captain on the serial queue while an owned fan-out wave still
   * needs synthesis or settlement. Turn-bound rounds get a force re-queue;
   * continuous rounds consume a normal continuation hop when eligible.
   */
  private requeueAuthorityForActiveFanoutHold(
    runtime: ActiveRoundRuntime,
    remaining: EnsembleParticipant[],
    participant: EnsembleParticipant,
    statusMessage: string
  ): boolean {
    const existingIdx = remaining.findIndex((entry) => entry.id === participant.id)
    if (existingIdx === 0) {
      this.appendRoundStatus(runtime.chatId, runtime.roundId, statusMessage)
      return true
    }
    if (existingIdx > 0) {
      const [existing] = remaining.splice(existingIdx, 1)
      remaining.unshift(existing)
      this.appendRoundStatus(runtime.chatId, runtime.roundId, statusMessage)
      return true
    }
    if (runtime.orchestrationMode === 'continuous') {
      const continuation = this.tryAppendContinuationTurn(
        runtime,
        remaining,
        participant,
        statusMessage,
        {
          allowAnsweredParticipant: true,
          allowYieldedParticipant: true
        }
      )
      if (continuation.appended) return true
      // Hard blocks still fail closed. Hop/budget/status refusals must not let
      // ordinary writers race an unsettled authority-owned fan-out wave.
      if (
        continuation.reason === 'unreachable' ||
        continuation.reason === 'outside_round_scope' ||
        continuation.reason === 'active_fanout'
      ) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${statusMessage} Could not re-summon ${participantDisplayName(participant)}: ${this.describeContinuationDecline(continuation)}.`
        )
        return false
      }
    }
    // Turn-bound seats speak once by default; an active fan-out authority hold
    // outranks that so ordinary writers cannot race unsettled lanes. The same
    // force path covers continuous hop/budget refusals above.
    remaining.unshift(participant)
    this.appendRoundStatus(runtime.chatId, runtime.roundId, statusMessage)
    return true
  }

  private canReceiveActiveFanoutManagerHandoff(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant
  ): boolean {
    if (!participant.enabled) return false
    if (runtime.unreachableParticipantIds?.has(participant.id)) return false
    if (this.activeBossmanQuarantine(chat, runtime.roundId, participant.id)) return false
    if (runtime.dmTargetParticipantId && participant.id !== runtime.dmTargetParticipantId) {
      return false
    }
    if (this.participantFanoutDispatchState(runtime, participant.id)) return false
    if (runtime.remainingParticipants?.some((entry) => entry.id === participant.id)) return true
    return this.evaluateContinuationTurnEligibility(runtime, participant, {
      allowAnsweredParticipant: true,
      allowYieldedParticipant: true
    }).appended
  }

  private applyYieldTargetRouting(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun,
    target: string
  ): EnsembleYieldRoutingResult {
    const displayTarget = target.trim()
    const reject = (
      reason: Exclude<EnsembleYieldRoutingResult, { ok: true }>['reason'],
      extra?: { suggestedAliases?: string[]; detail?: string }
    ): EnsembleYieldRoutingResult => {
      const result: EnsembleYieldRoutingResult = {
        ok: false,
        reason,
        target: displayTarget,
        ...(extra?.suggestedAliases?.length ? { suggestedAliases: extra.suggestedAliases } : {})
      }
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        yieldRejectStatusLine({
          target: displayTarget,
          reason,
          suggestedAliases: extra?.suggestedAliases,
          detail: extra?.detail
        })
      )
      return result
    }

    const authority = this.resolveBossAuthorityForCaller(chat, runtime, run.participant.id)
    const hasAuthority = authority.ok

    if (isUserYieldTarget(target)) {
      runtime.returnedControlToUser = true
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${run.participant.role || providerLabel(run.participant.provider)} yielded to the user. Round closed.`
      )
      return { ok: true, action: 'user' }
    }

    const participants = chat.ensemble?.participants || []
    const detail = resolveYieldTargetDetail(target, participants, new Set([run.participant.id]))
    if (detail.kind === 'self') return reject('unresolved')
    if (detail.kind === 'ambiguous') {
      return reject('ambiguous', {
        suggestedAliases: suggestUniqueYieldAliases(detail.matches)
      })
    }
    if (detail.kind === 'unresolved') return reject('unresolved')

    const participant = detail.participant
    const displayName = participantDisplayName(participant)

    if (!participant.enabled) return reject('blocked_status')
    if (runtime.unreachableParticipantIds?.has(participant.id)) return reject('blocked_status')
    if (this.activeBossmanQuarantine(chat, runtime.roundId, participant.id)) {
      return reject('blocked_status')
    }
    if (runtime.dmTargetParticipantId && participant.id !== runtime.dmTargetParticipantId) {
      return reject('outside_scope')
    }
    // Only block seats whose fan-out lane is still live. A prior wave that
    // already settled ('handled') must remain a valid yield target — e.g. Boss
    // handing back to a reviewer after the Review wave completes.
    if (this.participantFanoutDispatchState(runtime, participant.id) === 'active') {
      return reject('blocked_status')
    }

    if (isBackgroundParticipant(participant)) {
      if (!hasAuthority) return reject('authority_precedence')
      const preflight = preflightBackgroundDispatchTarget({
        concurrentLanesEnabled: concurrentLanesEnabled(),
        runtimeCancelled: Boolean(runtime.cancelled),
        targetParticipant: participant,
        fanoutDispatchState: this.participantFanoutDispatchState(runtime, participant.id),
        budgetBlockReason: this.bossmanBudgetBlock(runtime, participant.id, 'fanout_call')
      })
      if (isBackgroundDispatchFailure(preflight)) {
        return reject(preflight.reason, preflight.detail ? { detail: preflight.detail } : undefined)
      }
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        yieldRouteSuccessStatusLine('background_reserved', displayName)
      )
      return {
        ok: true,
        action: 'background_reserved',
        targetParticipantId: participant.id
      }
    }

    const remaining = runtime.remainingParticipants ?? (runtime.remainingParticipants = [])
    const idx = remaining.findIndex((entry) => entry.id === participant.id)
    // A foreground `ensemble_yield(target)` is an explicit handoff, not an
    // authority-only scheduling hint. It deliberately outranks roster order —
    // including a still-pending Boss/Captain — so participants can skip seats
    // that have no work this pass. Background dispatch remains authority-gated
    // above because it starts a detached lane rather than handing off the
    // current serial turn.
    if (idx >= 0) {
      return { ok: true, action: 'promoted', targetParticipantId: participant.id }
    }
    if (runtime.orchestrationMode === 'continuous') {
      const eligibility = this.evaluateContinuationTurnEligibility(runtime, participant, {
        allowAnsweredParticipant: true,
        allowYieldedParticipant: true
      })
      if (!eligibility.appended) {
        if (eligibility.reason === 'hop_limit') return reject('hop_limit')
        if (eligibility.reason === 'outside_round_scope') return reject('outside_scope')
        return reject('blocked_status')
      }
      this.commitContinuationTurn(
        runtime,
        remaining,
        participant,
        `Yielded back to ${participant.role || participant.provider} (${participant.provider}).`
      )
      return { ok: true, action: 'resummoned', targetParticipantId: participant.id }
    }
    return reject('blocked_status')
  }

  private applyStoredYieldRouting(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun,
    remaining: EnsembleParticipant[],
    pending: StoredYieldRouting
  ): boolean {
    switch (pending.kind) {
      case 'rejected':
        return false
      case 'user':
        return true
      case 'background':
        return true
      case 'queue': {
        const participant = chat.ensemble?.participants.find(
          (entry) => entry.id === pending.targetParticipantId && entry.enabled
        )
        if (!participant) return false
        const displayName = participantDisplayName(participant)
        if (pending.action === 'resummoned') {
          if (pending.continuationReserved) {
            return true
          }
          const continuation = this.tryAppendContinuationTurn(
            runtime,
            remaining,
            participant,
            `Yielded back to ${participant.role || participant.provider} (${participant.provider}).`,
            { allowAnsweredParticipant: true, allowYieldedParticipant: true }
          )
          if (!continuation.appended) {
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              `Yield to ${displayName} was not routed because ${this.describeContinuationDecline(continuation)}; foreground rotation continues.`
            )
            this.discardYieldReturnFrameForYielder(runtime, run.participant.id)
            return false
          }
          return true
        }
        const idx = remaining.findIndex((entry) => entry.id === pending.targetParticipantId)
        if (idx > 0) {
          const [moved] = remaining.splice(idx, 1)
          remaining.unshift(moved)
        }
        if (idx >= 0) {
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            yieldRouteSuccessStatusLine(pending.action, displayName)
          )
          runtime.yieldReturnStack ??= []
          runtime.yieldReturnStack.push({
            returnParticipantId: run.participant.id,
            targetParticipantId: pending.targetParticipantId
          })
          return true
        }
        return false
      }
    }
  }

  private clearYieldReturnStack(runtime: ActiveRoundRuntime): void {
    if (runtime.yieldReturnStack?.length) runtime.yieldReturnStack = []
  }

  private discardYieldReturnFrameForYielder(
    runtime: ActiveRoundRuntime,
    returnParticipantId: string
  ): void {
    const stack = runtime.yieldReturnStack
    const frame = stack?.[stack.length - 1]
    if (!stack?.length || frame?.returnParticipantId !== returnParticipantId) return
    stack.pop()
  }

  private discardYieldReturnFrameForTarget(
    runtime: ActiveRoundRuntime,
    targetParticipantId: string
  ): void {
    const stack = runtime.yieldReturnStack
    const frame = stack?.[stack.length - 1]
    if (!stack?.length || frame?.targetParticipantId !== targetParticipantId) return
    stack.pop()
  }

  private completePendingYieldActivity(
    run: ActiveParticipantRun,
    reason?: string,
    target?: string,
    override?: { content: string; result: Record<string, unknown> }
  ): void {
    if (!run.toolActivities || run.toolActivities.length === 0) return
    for (let index = run.toolActivities.length - 1; index >= 0; index -= 1) {
      const activity = run.toolActivities[index]
      if (stripToolNamespace(activity.toolName) !== 'ensemble_yield') continue
      if (activity.status !== 'running' && activity.status !== 'pending') return
      const content = override?.content || reason || (target ? `Yielded to ${target}.` : 'Yielded.')
      run.toolActivities[index] = pairEnsembleToolResult(
        activity,
        {
          type: 'tool_result',
          tool_id: activity.id,
          success: true,
          content,
          result: override?.result || {
            ok: true,
            tool: 'ensemble_yield',
            ...(reason ? { reason } : {}),
            ...(target ? { target } : {})
          }
        },
        this.deps.nowIso()
      )
      return
    }
  }

  /** Resolve live tool/event authority without exposing retained terminal owners. */
  private actionableRunForTool(runId: string | undefined): ActiveParticipantRun | undefined {
    if (!runId) return undefined
    const run = this.runsByRunId.get(runId)
    // Terminal fan-out owners remain in runsByRunId solely so Stop and
    // settlement cleanup can find them. Map membership must not keep their MCP
    // authority alive for late/retried calls or provider events.
    return run?.terminalFinalized ? undefined : run
  }

  private rememberTerminalRun(runId: string): void {
    const now = this.deps.now()
    this.pruneTerminalRunToolTombstones(now)
    this.terminalRunToolTombstones.delete(runId)
    this.terminalRunToolTombstones.set(runId, now + TERMINAL_RUN_TOOL_TOMBSTONE_TTL_MS)
    while (this.terminalRunToolTombstones.size > TERMINAL_RUN_TOOL_TOMBSTONE_LIMIT) {
      const oldest = this.terminalRunToolTombstones.keys().next().value
      if (typeof oldest !== 'string') break
      this.terminalRunToolTombstones.delete(oldest)
    }
  }

  private isRecentlyTerminalRun(runId: string | undefined): boolean {
    if (!runId) return false
    if (this.runsByRunId.get(runId)?.terminalFinalized) return true
    const now = this.deps.now()
    this.pruneTerminalRunToolTombstones(now)
    return (this.terminalRunToolTombstones.get(runId) || 0) > now
  }

  private pruneTerminalRunToolTombstones(now: number): void {
    for (const [runId, expiresAt] of this.terminalRunToolTombstones) {
      if (expiresAt <= now) this.terminalRunToolTombstones.delete(runId)
    }
  }

  /**
   * 1.0.4-AK — public lookup for which participant owns a given
   * runId. The `scout_brief` MCP dispatcher in `index.ts` uses this
   * to attribute a brief to its lane participant. Returns `null` when no
   * actionable orchestrator-tracked run matches (e.g. the call came
   * from a non-ensemble single-participant or terminal run).
   */
  getParticipantIdForRun(runId: string | undefined): string | null {
    const run = this.actionableRunForTool(runId)
    return run?.participant.id || null
  }

  /**
   * Public enqueue for programmatic follow-up prompts (Boss
   * `queue_followup`, iOS remote queue). Mirrors the user-driven
   * `enqueuePrompt` flow but skips the steer/cancel paths since the
   * caller is not the composer. Returns `false` when no active
   * round runtime exists for the chat (the call is a no-op).
   */
  enqueueFollowUpPrompt(chatId: string, prompt: string): boolean {
    const trimmed = (prompt || '').trim()
    if (!trimmed) return false
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime || runtime.cancelled) return false
    // 1.0.5-EW43a — programmatic follow-ups don't carry attachments,
    // so the entry's `imageAttachments` is always empty.
    // Persist both the renderer string view and restart-safe structured view.
    runtime.queuedPrompts.push({
      id: this.nextQueuedPromptId(chatId),
      prompt: trimmed,
      imageAttachments: []
    })
    this.updateChatRound(chatId, (round) =>
      round ? { ...round, ...this.queuedPromptFields(runtime.queuedPrompts) } : round
    )
    return true
  }

  /**
   * 1.0.4-AK — public status-row append for tool-dispatch sites
   * that need to surface a transcript note tied to a specific run.
   * Looks up the run's chat/round context, then routes through the
   * private `appendRoundStatus` so the renderer sees the same
   * formatting other lifecycle notes use. No-op when the run isn't
   * known (e.g. the participant has already finalised).
   */
  appendStatusForRun(runId: string, note: string): boolean {
    if (!runId || !note) return false
    const run = this.actionableRunForTool(runId)
    if (!run) return false
    this.appendRoundStatus(run.chatId, run.roundId, note)
    return true
  }

  async bossmanControlForRun(
    runId: string | undefined,
    input: EnsembleBossmanControlInput
  ): Promise<EnsembleBossmanControlResult> {
    const action = input.action
    if (!action) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        message: 'ensemble_bossman_control: action is required.',
        error: 'invalid_action'
      }
    }
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        message: 'ensemble_bossman_control requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const caller = this.actionableRunForTool(runId)
    if (!caller) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        message: 'No active Ensemble participant run matches this Boss control call.',
        error: 'no_active_run'
      }
    }
    const chat = this.deps.getChat(caller.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        message: 'The active chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const runtime = this.roundsByChatId.get(caller.chatId)
    if (!runtime || runtime.roundId !== caller.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        message: 'There is no active Ensemble round for this Boss control call.',
        error: 'no_active_round'
      }
    }
    if (input.roundId && input.roundId !== runtime.roundId) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: 'Boss control rejected: roundId is no longer active.',
        error: 'stale_round'
      }
    }
    // C2 P3 — reviewer-only verdict (submit_review_verdict) is an OWNER-gated,
    // NON-upserting path that does NOT require Boss authority: the gate's OWN
    // reviewer (which may be a read_only seat) submits passed|failed on their own
    // gate, and the gate + its DERIVED completion block reconcile in ONE synchronous
    // transaction (closes pain #2's "gate passed but stayed open"). It intentionally
    // bypasses the authority gate below; a non-owner — even Boss — cannot pass
    // another's gate this way (Boss override stays on set_review_gate's create/upsert).
    if (action === 'submit_review_verdict') {
      return this.submitReviewVerdictForCaller(chat, runtime, caller, input)
    }
    const authority = this.resolveBossAuthorityForCaller(chat, runtime, caller.participant.id)
    if (!authority.ok) {
      const statusReason =
        authority.error === 'bossman_not_configured'
          ? 'no Boss is assigned for this Ensemble'
          : authority.message
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Boss control rejected from ${caller.participant.role || caller.participant.provider}: ${statusReason}.`
      )
      if (authority.error !== 'bossman_not_configured') {
        // An unauthorized control attempt is a security-relevant event — record
        // it to the durable audit ledger, not just the transcript.
        this.deps.recordBossmanControlRejection?.({
          provider: caller.participant.provider,
          workspacePath: chat.workspacePath,
          chatId: caller.chatId,
          runId: caller.runId,
          metadata: {
            kind: 'bossman_control_rejected',
            rejectionReason: authority.error,
            action,
            roundId: runtime.roundId,
            attemptingParticipantId: caller.participant.id,
            attemptingParticipantRole: caller.participant.role,
            attemptingProvider: caller.participant.provider,
            assignedBossmanParticipantId: authority.bossmanParticipantId,
            assignedSecondInCommandParticipantId: authority.secondInCommandParticipantId,
            primaryUnavailableReason: authority.primaryUnavailableReason
          }
        })
      }
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: `Boss control rejected: ${authority.message}.`,
        error: authority.error
      }
    }

    if (
      input.targetParticipantId &&
      !this.roundHasParticipant(
        chat.ensemble.activeRound,
        runtime.roundId,
        input.targetParticipantId
      )
    ) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: 'Boss control rejected: targetParticipantId is not part of the active round.',
        error: 'stale_target'
      }
    }
    const targetRun = input.targetRunId ? this.actionableRunForTool(input.targetRunId) : undefined
    if (
      input.targetRunId &&
      (!targetRun ||
        targetRun.chatId !== runtime.chatId ||
        targetRun.roundId !== runtime.roundId ||
        (input.targetParticipantId && targetRun.participant.id !== input.targetParticipantId))
    ) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: 'Boss control rejected: targetRunId is no longer active for that participant.',
        error: 'stale_target_run'
      }
    }

    if (action === 'stop_round') {
      const reason = input.reason || 'Stopped by Boss.'
      const ok = await this.cancelRound(runtime.chatId, reason)
      return {
        ok,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: ok ? `Boss stopped the round: ${reason}` : 'Boss stop failed: no active round.',
        ...(ok ? {} : { error: 'no_active_round' as const })
      }
    }

    if (action === 'skip_participant') {
      return this.skipParticipantByBossman(runtime, input, caller, authority.role, targetRun)
    }

    if (action === 'select_participants') {
      return this.selectParticipantsByBossman(runtime, input, caller, authority.role)
    }

    if (action === 'skip_intervention') {
      return this.skipAuthorityIntervention(runtime, caller, authority.role)
    }

    if (action === 'summon_participant') {
      return this.summonParticipantByBossman(runtime, input, caller, authority.role)
    }

    if (action === 'reorder_remaining') {
      return this.reorderRemainingByBossman(runtime, input.participantIds || [])
    }

    if (action === 'queue_followup') {
      const prompt = (input.prompt || '').trim()
      if (!prompt) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: 'Boss queue_followup requires a prompt.',
          error: 'missing_prompt'
        }
      }
      const ok = this.enqueueFollowUpPrompt(runtime.chatId, prompt)
      if (ok) {
        this.appendRoundStatus(runtime.chatId, runtime.roundId, 'Boss queued a follow-up round.')
      }
      return {
        ok,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: ok
          ? 'Boss queued a follow-up round.'
          : 'Boss queue_followup failed: no active runtime queue.',
        ...(ok ? {} : { error: 'queue_failed' as const })
      }
    }

    if (
      action === 'assign_work' ||
      action === 'set_round_plan' ||
      action === 'request_status' ||
      action === 'declare_decision' ||
      action === 'set_review_gate' ||
      action === 'quarantine_participant' ||
      action === 'allocate_budget' ||
      action === 'create_poll' ||
      action === 'set_goal' ||
      action === 'update_goal' ||
      action === 'clear_goal' ||
      action === 'adjust_hops' ||
      action === 'ensemble_scheduled_wakeup' ||
      action === 'check_quota_resets'
    ) {
      return this.structuredBossmanControl(runtime, input, caller.participant, authority.role)
    }

    if (action === 'replace_participant') {
      return this.replaceParticipantByBossman(runtime, input, targetRun)
    }

    return {
      ok: false,
      tool: 'ensemble_bossman_control',
      action,
      roundId: runtime.roundId,
      message: `ensemble_bossman_control: unsupported action "${action}".`,
      error: 'invalid_action'
    }
  }

  agentPoolRegistrationCandidateForRun(
    runId: string | undefined,
    input: { roundId?: string } = {}
  ): EnsembleAgentPoolRegistrationCandidateResult {
    const action = 'register_in_agent_pool' as const
    const caller = this.actionableRunForTool(runId)
    if (!caller) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message: 'Agent Pool registration requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const chat = this.deps.getChat(caller.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message: 'The active chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const runtime = this.roundsByChatId.get(caller.chatId)
    if (!runtime || runtime.roundId !== caller.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message: 'There is no active Ensemble round for this Agent Pool registration.',
        error: 'no_active_round'
      }
    }
    if (input.roundId && input.roundId !== runtime.roundId) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: 'Agent Pool registration rejected: roundId is no longer active.',
        error: 'stale_round'
      }
    }
    const participant = chat.ensemble.participants.find(
      (candidate) => candidate.id === caller.participant.id
    )
    if (!participant) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message:
          'Agent Pool registration rejected: the calling participant is no longer in the roster.',
        error: 'no_active_run'
      }
    }
    const role = participant.role.trim()
    if (!role) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: participant.id,
        message: 'Agent Pool registration requires the participant to have an assigned role.',
        error: 'role_required'
      }
    }
    if (Array.from(role).length > 50) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: participant.id,
        message:
          'Agent Pool registration requires a role of at most 50 characters; shorten the assigned role first.',
        error: 'role_too_long'
      }
    }
    return {
      ok: true,
      tool: 'ensemble_roster_edit',
      action,
      roundId: runtime.roundId,
      participantId: participant.id,
      participant,
      message:
        'The calling participant is eligible to register its assigned role in the Agent Pool.'
    }
  }

  registerParticipantInAgentPoolForRun(
    runId: string | undefined,
    input: {
      roundId?: string
      expectedRole: string
      pooledAgentId: string
      pooledAgentIdentity: PooledAgentIdentitySnapshot
      mode: 'created' | 'coalesced' | 'updated'
    }
  ): EnsembleAgentPoolRegistrationResult {
    const candidate = this.agentPoolRegistrationCandidateForRun(runId, input)
    const action = 'register_in_agent_pool' as const
    if (!candidate.ok || !candidate.participant || !candidate.roundId || !candidate.participantId) {
      return candidate
    }
    if (candidate.participant.role !== input.expectedRole) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: candidate.roundId,
        participantId: candidate.participantId,
        message:
          'Agent Pool registration rejected because the participant role changed while the pool was updating.',
        error: 'stale_participant'
      }
    }
    if (!isPooledAgentRegistrationReceipt(input)) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: candidate.roundId,
        participantId: candidate.participantId,
        message: 'Agent Pool registration rejected an invalid renderer receipt.',
        error: 'invalid_pool_receipt'
      }
    }
    const activeCaller = this.actionableRunForTool(runId)
    const chat = activeCaller ? this.deps.getChat(activeCaller.chatId) : undefined
    const runtime = activeCaller ? this.roundsByChatId.get(activeCaller.chatId) : undefined
    if (!chat?.ensemble || !runtime || runtime.roundId !== candidate.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: candidate.roundId,
        participantId: candidate.participantId,
        message: 'There is no active Ensemble round for this Agent Pool registration.',
        error: 'no_active_round'
      }
    }
    const nextParticipant = {
      ...candidate.participant,
      pooledAgentId: input.pooledAgentId,
      pooledAgentIdentity: input.pooledAgentIdentity
    }
    const nextParticipants = chat.ensemble.participants.map((participant) =>
      participant.id === candidate.participantId ? nextParticipant : participant
    )
    this.applyRosterEditToRuntime(
      runtime,
      'edit_participant',
      candidate.participantId,
      nextParticipants
    )
    const activeRound = this.applyRosterEditToActiveRound(
      chat.ensemble.activeRound,
      runtime.roundId,
      nextParticipants
    )
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: { ...chat.ensemble, participants: nextParticipants, activeRound },
        updatedAt: this.deps.now()
      },
      'participant-updated'
    )
    const caller = this.actionableRunForTool(runId)
    if (caller?.participant.id === candidate.participantId) caller.participant = nextParticipant
    return {
      ok: true,
      tool: 'ensemble_roster_edit',
      action,
      roundId: runtime.roundId,
      participantId: candidate.participantId,
      pooledAgentId: input.pooledAgentId,
      mode: input.mode,
      message:
        input.mode === 'coalesced'
          ? 'Linked this participant to the matching Agent Pool entry.'
          : input.mode === 'updated'
            ? 'Updated this participant’s linked Agent Pool entry.'
            : 'Registered this participant in the Agent Pool.'
    }
  }

  async rosterEditForRun(
    runId: string | undefined,
    input: EnsembleRosterEditInput
  ): Promise<EnsembleRosterEditResult> {
    const action = input.action
    if (!action || !isRosterEditAction(action)) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message:
          'ensemble_roster_edit: action must be add_participant, remove_participant, or edit_participant.',
        error: 'invalid_action'
      }
    }
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message: 'ensemble_roster_edit requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const caller = this.actionableRunForTool(runId)
    if (!caller) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message: 'No active Ensemble participant run matches this roster edit call.',
        error: 'no_active_run'
      }
    }
    const chat = this.deps.getChat(caller.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message: 'The active chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const runtime = this.roundsByChatId.get(caller.chatId)
    if (!runtime || runtime.roundId !== caller.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        message: 'There is no active Ensemble round for this roster edit call.',
        error: 'no_active_round'
      }
    }
    if (input.roundId && input.roundId !== runtime.roundId) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: 'Roster edit rejected: roundId is no longer active.',
        error: 'stale_round'
      }
    }
    const authority = this.resolveBossAuthorityForCaller(chat, runtime, caller.participant.id)
    if (!authority.ok) {
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Roster edit rejected from ${caller.participant.role || caller.participant.provider}: ${authority.message}.`
      )
      if (authority.error !== 'bossman_not_configured') {
        this.deps.recordBossmanControlRejection?.({
          provider: caller.participant.provider,
          workspacePath: chat.workspacePath,
          chatId: caller.chatId,
          runId: caller.runId,
          metadata: {
            kind: 'roster_edit_rejected',
            rejectionReason: authority.error,
            action,
            roundId: runtime.roundId,
            attemptingParticipantId: caller.participant.id,
            attemptingParticipantRole: caller.participant.role,
            attemptingProvider: caller.participant.provider,
            assignedBossmanParticipantId: authority.bossmanParticipantId,
            assignedSecondInCommandParticipantId: authority.secondInCommandParticipantId,
            primaryUnavailableReason: authority.primaryUnavailableReason
          }
        })
      }
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: `Roster edit rejected: ${authority.message}.`,
        error: authority.error
      }
    }

    if (
      input.targetParticipantId &&
      !this.roundHasParticipant(
        chat.ensemble.activeRound,
        runtime.roundId,
        input.targetParticipantId
      )
    ) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: 'Roster edit rejected: targetParticipantId is not part of the active round.',
        error: 'stale_target'
      }
    }
    if (
      action === 'edit_participant' &&
      input.targetParticipantId === caller.participant.id &&
      input.participant &&
      Object.prototype.hasOwnProperty.call(input.participant, 'instructions')
    ) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message:
          'Roster edit rejected: Boss/Captain participants cannot update their own Brief / Goal through MCP.',
        error: 'self_update_forbidden'
      }
    }

    const preflightCallerPermissions = this.resolveParticipantPermissions(
      chat,
      caller.participant,
      runtime.externalPathGrants
    )
    const preflight = evaluateRosterEdit(
      {
        action,
        targetParticipantId: input.targetParticipantId,
        participant: input.participant || undefined
      },
      {
        participants: chat.ensemble.participants,
        bossmanParticipantId: authority.rosterGuardParticipantId,
        autoApprovals: chat.ensemble.bossmanAutoApprovals,
        roundReadOnly: preflightCallerPermissions.readOnly,
        nextParticipantId: () => this.nextRosterEditParticipantId(chat.ensemble!.participants)
      }
    )
    if (!preflight.ok) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: preflight.message,
        error: preflight.error
      }
    }

    const providerValidation = this.validateRosterEditProvider(input, chat.ensemble.participants)
    if (!providerValidation.ok) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: providerValidation.message,
        error: providerValidation.error
      }
    }
    if (providerValidation.probeParticipant) {
      if (!this.deps.probeParticipant) {
        return {
          ok: false,
          tool: 'ensemble_roster_edit',
          action,
          roundId: runtime.roundId,
          message: 'Roster edit rejected: provider health checks are unavailable.',
          error: 'health_check_unavailable'
        }
      }
      const health = await this.deps.probeParticipant(providerValidation.probeParticipant)
      if (!health.reachable) {
        return {
          ok: false,
          tool: 'ensemble_roster_edit',
          action,
          roundId: runtime.roundId,
          message: `Roster edit rejected: ${health.reason || `${providerValidation.probeParticipant.provider} is not reachable`}.`,
          error: 'participant_unreachable'
        }
      }
    }

    const currentRuntime = this.roundsByChatId.get(caller.chatId)
    if (!currentRuntime || currentRuntime.roundId !== runtime.roundId || currentRuntime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: 'There is no active Ensemble round for this roster edit call.',
        error: 'no_active_round'
      }
    }
    const latestChat = this.deps.getChat(runtime.chatId)
    if (!latestChat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: 'Roster edit rejected: active chat is no longer an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const latestAuthority = this.resolveBossAuthorityForCaller(
      latestChat,
      runtime,
      caller.participant.id
    )
    if (!latestAuthority.ok) {
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Roster edit rejected from ${caller.participant.role || caller.participant.provider}: ${latestAuthority.message}.`
      )
      if (latestAuthority.error !== 'bossman_not_configured') {
        this.deps.recordBossmanControlRejection?.({
          provider: caller.participant.provider,
          workspacePath: latestChat.workspacePath,
          chatId: caller.chatId,
          runId: caller.runId,
          metadata: {
            kind: 'roster_edit_rejected',
            rejectionReason: latestAuthority.error,
            action,
            roundId: runtime.roundId,
            attemptingParticipantId: caller.participant.id,
            attemptingParticipantRole: caller.participant.role,
            attemptingProvider: caller.participant.provider,
            assignedBossmanParticipantId: latestAuthority.bossmanParticipantId,
            assignedSecondInCommandParticipantId: latestAuthority.secondInCommandParticipantId,
            primaryUnavailableReason: latestAuthority.primaryUnavailableReason
          }
        })
      }
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: `Roster edit rejected: ${latestAuthority.message}.`,
        error: latestAuthority.error
      }
    }
    const latestCaller =
      latestChat.ensemble.participants.find(
        (participant) => participant.id === caller.participant.id
      ) || caller.participant
    const callerPermissions = this.resolveParticipantPermissions(
      latestChat,
      latestCaller,
      runtime.externalPathGrants
    )
    const resolution = evaluateRosterEdit(
      {
        action,
        targetParticipantId: input.targetParticipantId,
        participant: input.participant || undefined
      },
      {
        participants: latestChat.ensemble.participants,
        bossmanParticipantId: latestAuthority.rosterGuardParticipantId,
        autoApprovals: latestChat.ensemble.bossmanAutoApprovals,
        roundReadOnly: callerPermissions.readOnly,
        nextParticipantId: () => this.nextRosterEditParticipantId(latestChat.ensemble!.participants)
      }
    )
    if (!resolution.ok) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: resolution.message,
        error: resolution.error
      }
    }

    const affectedBefore = latestChat.ensemble.participants.find(
      (participant) => participant.id === resolution.affectedParticipantId
    )
    const affectedAfter = resolution.nextParticipants.find(
      (participant) => participant.id === resolution.affectedParticipantId
    )
    if (
      action === 'edit_participant' &&
      affectedBefore &&
      affectedAfter &&
      this.isParticipantActivelyExecuting(runtime, resolution.affectedParticipantId)
    ) {
      const queued = this.queueOrApplyParticipantSeatChange({
        chat: latestChat,
        runtime,
        before: affectedBefore,
        after: affectedAfter,
        patch: input.participant || undefined,
        changedBy: 'orchestrator',
        reason: 'Boss roster edit queued while the participant was active.'
      })
      return {
        ok: queued.ok,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: resolution.affectedParticipantId,
        message: queued.message,
        deferred: true
      }
    }
    this.applyRosterEditToRuntime(
      runtime,
      action,
      resolution.affectedParticipantId,
      resolution.nextParticipants
    )
    const activeRound = this.applyRosterEditToActiveRound(
      latestChat.ensemble.activeRound,
      runtime.roundId,
      resolution.nextParticipants
    )
    const nextCaptainParticipantIds = configuredEnsembleCaptainParticipantIds({
      participants: resolution.nextParticipants,
      bossmanParticipantId: latestChat.ensemble.bossmanParticipantId,
      captainParticipantIds: latestChat.ensemble.captainParticipantIds,
      secondInCommandParticipantId: latestChat.ensemble.secondInCommandParticipantId
    })
    this.saveChatWithCheckpoint(
      {
        ...latestChat,
        ensemble: {
          ...latestChat.ensemble,
          participants: resolution.nextParticipants,
          captainParticipantIds: nextCaptainParticipantIds,
          secondInCommandParticipantId: nextCaptainParticipantIds[0],
          activeRound,
          ...(action === 'edit_participant' && affectedBefore && affectedAfter
            ? {
                sessionActivityLedger: [
                  ...(latestChat.ensemble.sessionActivityLedger || []),
                  this.createSeatChangeActivityEntry(
                    affectedBefore,
                    affectedAfter,
                    'orchestrator',
                    'Boss roster edit applied immediately.',
                    this.deps.nowIso()
                  )
                ].slice(-SESSION_ACTIVITY_LEDGER_LIMIT)
              }
            : {}),
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'participant-updated'
    )
    const affected = resolution.nextParticipants.find(
      (participant) => participant.id === resolution.affectedParticipantId
    )
    const label =
      affected?.role ||
      affected?.provider ||
      affectedBefore?.role ||
      affectedBefore?.provider ||
      input.targetParticipantId ||
      resolution.affectedParticipantId
    const verb =
      action === 'add_participant'
        ? 'added'
        : action === 'remove_participant'
          ? 'removed'
          : 'edited'
    const message =
      action === 'edit_participant' && affectedBefore && affectedAfter
        ? `Authoritative seat change applied for ${label}: ${participantSeatValue(affectedBefore)} -> ${participantSeatValue(affectedAfter)}.`
        : `Boss ${verb} ${label}.`
    // A roster CREATED mid-round is the solo→Ensemble case the stack is for:
    // before this add the thread held at most its one seed seat, so there is no
    // before side and the row should show the whole new roster. Adds onto an
    // ALREADY established roster keep their plain status line — except while a
    // stack from a creation flurry is still open, which 'refresh-only' folds
    // them into rather than stranding the reader between two vocabularies.
    const rosterStackMode =
      action === 'add_participant' && latestChat.ensemble.participants.length <= 1
        ? 'create-or-refresh'
        : 'refresh-only'
    if (action === 'edit_participant' && affectedBefore && affectedAfter) {
      this.appendSeatChange(runtime.chatId, runtime.roundId, affectedBefore, affectedAfter, message)
      // The edit has its own animated row; this only stops an open stack from
      // going on displaying the seat's superseded configuration.
      this.appendSeatRoster(
        runtime.chatId,
        runtime.roundId,
        resolution.nextParticipants,
        'refresh-only'
      )
    } else if (
      !this.appendSeatRoster(
        runtime.chatId,
        runtime.roundId,
        resolution.nextParticipants,
        rosterStackMode
      )
    ) {
      this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
    }
    return {
      ok: true,
      tool: 'ensemble_roster_edit',
      action,
      roundId: runtime.roundId,
      participantId: resolution.affectedParticipantId,
      message
    }
  }

  rosterPresetImportForRun(
    runId: string | undefined,
    input: EnsembleRosterPresetImportInput
  ): EnsembleRosterPresetImportResult {
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action: 'import_preset',
        message: 'Roster preset import requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const caller = this.actionableRunForTool(runId)
    if (!caller) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action: 'import_preset',
        message: 'No active Ensemble participant run matches this roster preset import.',
        error: 'no_active_run'
      }
    }
    const chat = this.deps.getChat(caller.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action: 'import_preset',
        message: 'The active chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const runtime = this.roundsByChatId.get(caller.chatId)
    if (!runtime || runtime.roundId !== caller.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action: 'import_preset',
        message: 'There is no active Ensemble round for this roster preset import.',
        error: 'no_active_round'
      }
    }
    if (input.roundId && input.roundId !== runtime.roundId) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action: 'import_preset',
        roundId: runtime.roundId,
        message: 'Roster preset import rejected: roundId is no longer active.',
        error: 'stale_round'
      }
    }
    let participantSequence = 0
    const resolution = buildEnsembleRosterPresetApply({
      chat,
      preset: input.preset,
      callerParticipantId: caller.participant.id,
      sourceRunId: runId,
      queuedAt: this.deps.nowIso(),
      makeParticipantId: () =>
        `agent-roster-${this.deps.now().toString(36)}-${++participantSequence}`,
      isProviderSelectable: (provider) =>
        selectableProviderIds(this.deps.getSettings()).includes(provider)
    })
    if (!resolution.ok) {
      if (resolution.error === 'not_authorized') {
        this.deps.recordBossmanControlRejection?.({
          provider: caller.participant.provider,
          workspacePath: chat.workspacePath,
          chatId: caller.chatId,
          runId: caller.runId,
          metadata: {
            kind: 'roster_preset_import_rejected',
            rejectionReason: resolution.error,
            roundId: runtime.roundId,
            attemptingParticipantId: caller.participant.id,
            attemptingParticipantRole: caller.participant.role,
            attemptingProvider: caller.participant.provider,
            assignedBossmanParticipantId: chat.ensemble.bossmanParticipantId,
            assignedSecondInCommandParticipantId: chat.ensemble.secondInCommandParticipantId
          }
        })
      }
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action: 'import_preset',
        roundId: runtime.roundId,
        message: resolution.message,
        error: resolution.error
      }
    }
    const activate = input.activate !== false
    if (activate) {
      this.saveChatWithCheckpoint(
        {
          ...queuePendingEnsembleRosterPresetApply(chat, resolution.plan),
          updatedAt: this.deps.now()
        },
        'round-updated'
      )
    }
    const authorityLabel = resolution.plan.authority === 'ensemble_captain' ? 'Captain' : 'Boss'
    const message = activate
      ? `${authorityLabel} imported roster preset "${resolution.plan.presetName}"; it will activate after this round finishes.`
      : `${authorityLabel} validated roster preset "${resolution.plan.presetName}" for import without activating it.`
    if (activate) this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
    return {
      ok: true,
      tool: 'ensemble_roster_edit',
      action: 'import_preset',
      roundId: runtime.roundId,
      presetId: resolution.plan.presetId,
      presetName: resolution.plan.presetName,
      deferred: activate,
      message
    }
  }

  async briefUpdateForRun(
    runId: string | undefined,
    input: EnsembleBriefUpdateInput
  ): Promise<EnsembleBriefUpdateResult> {
    const targetParticipantId =
      typeof input.targetParticipantId === 'string' ? input.targetParticipantId.trim() : ''
    const clear = input.clear === true
    const hasBrief = typeof input.brief === 'string'
    const nextBrief = clear ? '' : hasBrief ? input.brief! : undefined
    if (!targetParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        message: 'Brief update rejected: targetParticipantId is required.',
        error: 'invalid_request'
      }
    }
    if (nextBrief === undefined) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        message: 'Brief update rejected: provide brief text or set clear=true.',
        error: 'invalid_request'
      }
    }
    if (nextBrief.length > MAX_BOSSMAN_BRIEF_CHARS) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        message: `Brief update rejected: brief is longer than ${MAX_BOSSMAN_BRIEF_CHARS} characters.`,
        error: 'invalid_request'
      }
    }
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        message: 'ensemble_brief_update requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const caller = this.actionableRunForTool(runId)
    if (!caller) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        message: 'No active Ensemble participant run matches this brief update call.',
        error: 'no_active_run'
      }
    }
    const chat = this.deps.getChat(caller.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        message: 'The active chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const runtime = this.roundsByChatId.get(caller.chatId)
    if (!runtime || runtime.roundId !== caller.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        message: 'There is no active Ensemble round for this brief update call.',
        error: 'no_active_round'
      }
    }
    if (input.roundId && input.roundId !== runtime.roundId) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: 'Brief update rejected: roundId is no longer active.',
        error: 'stale_round'
      }
    }
    const authority = this.resolveBossAuthorityForCaller(chat, runtime, caller.participant.id)
    if (!authority.ok) {
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Brief update rejected from ${caller.participant.role || caller.participant.provider}: ${authority.message}.`
      )
      if (authority.error !== 'bossman_not_configured') {
        this.deps.recordBossmanControlRejection?.({
          provider: caller.participant.provider,
          workspacePath: chat.workspacePath,
          chatId: caller.chatId,
          runId: caller.runId,
          metadata: {
            kind: 'brief_update_rejected',
            rejectionReason: authority.error,
            roundId: runtime.roundId,
            targetParticipantId,
            attemptingParticipantId: caller.participant.id,
            attemptingParticipantRole: caller.participant.role,
            attemptingProvider: caller.participant.provider,
            assignedBossmanParticipantId: authority.bossmanParticipantId,
            assignedSecondInCommandParticipantId: authority.secondInCommandParticipantId,
            primaryUnavailableReason: authority.primaryUnavailableReason
          }
        })
      }
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: `Brief update rejected: ${authority.message}.`,
        error: authority.error
      }
    }
    if (targetParticipantId === caller.participant.id) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message:
          'Brief update rejected: Boss/Captain participants cannot update their own Brief / Goal through MCP.',
        error: 'self_update_forbidden'
      }
    }
    if (
      !this.roundHasParticipant(chat.ensemble.activeRound, runtime.roundId, targetParticipantId)
    ) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: 'Brief update rejected: targetParticipantId is not part of the active round.',
        error: 'stale_target'
      }
    }

    const patch: RosterEditParticipantInput = { instructions: nextBrief }
    const preflightCallerPermissions = this.resolveParticipantPermissions(
      chat,
      caller.participant,
      runtime.externalPathGrants
    )
    const preflight = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId,
        participant: patch
      },
      {
        participants: chat.ensemble.participants,
        bossmanParticipantId: authority.rosterGuardParticipantId,
        autoApprovals: chat.ensemble.bossmanAutoApprovals,
        roundReadOnly: preflightCallerPermissions.readOnly,
        nextParticipantId: () => this.nextRosterEditParticipantId(chat.ensemble!.participants)
      }
    )
    if (!preflight.ok) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: preflight.message,
        error: preflight.error
      }
    }

    const currentRuntime = this.roundsByChatId.get(caller.chatId)
    if (!currentRuntime || currentRuntime.roundId !== runtime.roundId || currentRuntime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: 'There is no active Ensemble round for this brief update call.',
        error: 'no_active_round'
      }
    }
    const latestChat = this.deps.getChat(runtime.chatId)
    if (!latestChat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: 'Brief update rejected: active chat is no longer an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const latestAuthority = this.resolveBossAuthorityForCaller(
      latestChat,
      runtime,
      caller.participant.id
    )
    if (!latestAuthority.ok) {
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Brief update rejected from ${caller.participant.role || caller.participant.provider}: ${latestAuthority.message}.`
      )
      if (latestAuthority.error !== 'bossman_not_configured') {
        this.deps.recordBossmanControlRejection?.({
          provider: caller.participant.provider,
          workspacePath: latestChat.workspacePath,
          chatId: caller.chatId,
          runId: caller.runId,
          metadata: {
            kind: 'brief_update_rejected',
            rejectionReason: latestAuthority.error,
            roundId: runtime.roundId,
            targetParticipantId,
            attemptingParticipantId: caller.participant.id,
            attemptingParticipantRole: caller.participant.role,
            attemptingProvider: caller.participant.provider,
            assignedBossmanParticipantId: latestAuthority.bossmanParticipantId,
            assignedSecondInCommandParticipantId: latestAuthority.secondInCommandParticipantId,
            primaryUnavailableReason: latestAuthority.primaryUnavailableReason
          }
        })
      }
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: `Brief update rejected: ${latestAuthority.message}.`,
        error: latestAuthority.error
      }
    }
    if (
      !this.roundHasParticipant(
        latestChat.ensemble.activeRound,
        runtime.roundId,
        targetParticipantId
      )
    ) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: 'Brief update rejected: targetParticipantId is not part of the active round.',
        error: 'stale_target'
      }
    }
    const latestCaller =
      latestChat.ensemble.participants.find(
        (participant) => participant.id === caller.participant.id
      ) || caller.participant
    const callerPermissions = this.resolveParticipantPermissions(
      latestChat,
      latestCaller,
      runtime.externalPathGrants
    )
    const resolution = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId,
        participant: patch
      },
      {
        participants: latestChat.ensemble.participants,
        bossmanParticipantId: latestAuthority.rosterGuardParticipantId,
        autoApprovals: latestChat.ensemble.bossmanAutoApprovals,
        roundReadOnly: callerPermissions.readOnly,
        nextParticipantId: () => this.nextRosterEditParticipantId(latestChat.ensemble!.participants)
      }
    )
    if (!resolution.ok) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: resolution.message,
        error: resolution.error
      }
    }

    const affectedBefore = latestChat.ensemble.participants.find(
      (participant) => participant.id === resolution.affectedParticipantId
    )
    const affectedAfter = resolution.nextParticipants.find(
      (participant) => participant.id === resolution.affectedParticipantId
    )
    if (!affectedBefore || !affectedAfter) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: 'Brief update rejected: target participant is not in the roster.',
        error: 'stale_target'
      }
    }
    const reason =
      input.reason ||
      (clear
        ? `Boss cleared ${participantLabel(affectedBefore)} Brief / Goal.`
        : `Boss updated ${participantLabel(affectedBefore)} Brief / Goal.`)
    if (this.isParticipantActivelyExecuting(runtime, resolution.affectedParticipantId)) {
      const queued = this.queueOrApplyParticipantSeatChange({
        chat: latestChat,
        runtime,
        before: affectedBefore,
        after: affectedAfter,
        patch: { instructions: affectedAfter.instructions || '' },
        changedBy: 'orchestrator',
        reason
      })
      return {
        ok: queued.ok,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        participantId: resolution.affectedParticipantId,
        message: queued.message,
        deferred: true
      }
    }

    this.applyRosterEditToRuntime(
      runtime,
      'edit_participant',
      resolution.affectedParticipantId,
      resolution.nextParticipants
    )
    const activeRound = this.applyRosterEditToActiveRound(
      latestChat.ensemble.activeRound,
      runtime.roundId,
      resolution.nextParticipants
    )
    this.saveChatWithCheckpoint(
      {
        ...latestChat,
        ensemble: {
          ...latestChat.ensemble,
          participants: resolution.nextParticipants,
          activeRound,
          sessionActivityLedger: [
            ...(latestChat.ensemble.sessionActivityLedger || []),
            this.createSeatChangeActivityEntry(
              affectedBefore,
              affectedAfter,
              'orchestrator',
              reason,
              this.deps.nowIso()
            )
          ].slice(-SESSION_ACTIVITY_LEDGER_LIMIT),
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'participant-updated'
    )
    const message = clear
      ? `Boss cleared ${participantLabel(affectedBefore)} Brief / Goal.`
      : `Boss updated ${participantLabel(affectedBefore)} Brief / Goal.`
    this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
    return {
      ok: true,
      tool: 'ensemble_brief_update',
      roundId: runtime.roundId,
      participantId: resolution.affectedParticipantId,
      message
    }
  }

  async requestParticipantSeatChange(
    input: EnsembleParticipantSeatChangeInput
  ): Promise<EnsembleParticipantSeatChangeResult> {
    const chat = this.deps.getChat(input.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        message: 'Participant seat change rejected: chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const before = chat.ensemble.participants.find(
      (participant) => participant.id === input.participantId
    )
    if (!before) {
      return {
        ok: false,
        message: 'Participant seat change rejected: target participant is not in the roster.',
        error: 'stale_target'
      }
    }
    if (!hasSeatChangePatch(input.participant)) {
      return {
        ok: false,
        message: 'Participant seat change rejected: no supported seat fields were provided.',
        error: 'invalid_patch'
      }
    }
    const provider =
      typeof input.participant.provider === 'string' ? input.participant.provider : undefined
    if (provider && !selectableProviderIds().includes(provider as ProviderId)) {
      return {
        ok: false,
        message: `Participant seat change rejected: ${provider} is not a live selectable provider.`,
        error: 'invalid_patch'
      }
    }
    const claudeRelinkError = claudeRosterSessionRelinkError(before, input.participant)
    if (claudeRelinkError) {
      return {
        ok: false,
        message: claudeRelinkError,
        error: 'invalid_patch'
      }
    }
    const after = applySeatChangePatch(before, input.participant)
    const runtime = this.roundsByChatId.get(chat.appChatId)
    return this.queueOrApplyParticipantSeatChange({
      chat,
      runtime:
        runtime && runtime.roundId === chat.ensemble.activeRound?.roundId && !runtime.cancelled
          ? runtime
          : undefined,
      before,
      after,
      patch: input.participant,
      changedBy: input.changedBy || 'user',
      reason: input.reason || 'Participant seat changed by user.'
    })
  }

  requestUserRosterMutation(
    input: EnsembleUserRosterMutationInput
  ): EnsembleUserRosterMutationResult {
    const chat = this.deps.getChat(input.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        message: 'Roster change rejected: chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const resolution = resolveEnsembleUserRosterMutation(chat.ensemble, input, {
      nowIso: this.deps.nowIso(),
      isProviderSelectable: (provider) =>
        selectableProviderIds(this.deps.getSettings()).includes(provider as ProviderId)
    })
    if (!resolution.ok) {
      return {
        ok: false,
        message: resolution.message,
        error: resolution.error
      }
    }

    const runtimeCandidate = this.roundsByChatId.get(chat.appChatId)
    const runtime =
      runtimeCandidate &&
      runtimeCandidate.roundId === chat.ensemble.activeRound?.roundId &&
      !runtimeCandidate.cancelled
        ? runtimeCandidate
        : undefined
    const participantId = resolution.value.affectedParticipantId
    if (
      input.action === 'remove' &&
      runtime &&
      participantId &&
      this.isParticipantActivelyExecuting(runtime, participantId)
    ) {
      const before = chat.ensemble.participants.find(
        (participant) => participant.id === participantId
      )
      if (!before) {
        return {
          ok: false,
          message: 'Participant remove rejected: participant is no longer in the roster.',
          error: 'stale_target'
        }
      }
      const queuedAt = this.deps.nowIso()
      runtime.pendingParticipantSeatChanges = [
        ...(runtime.pendingParticipantSeatChanges || []).filter(
          (change) => change.participantId !== participantId
        ),
        {
          participantId,
          before,
          after: before,
          removeAfterExecution: true,
          changedBy: 'user',
          reason: 'User removed the active participant.',
          queuedAt
        }
      ]
      const message =
        `Participant removal queued for ${participantLabel(before)}. ` +
        'It will apply when that participant finishes its current execution.'
      this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
      return {
        ok: true,
        status: 'queued',
        chat: this.deps.getChat(chat.appChatId) || chat,
        message,
        participantId,
        roundId: runtime.roundId
      }
    }

    const applied = this.applyUserRosterMutationToChat(chat, runtime, resolution.value, false)
    return {
      ok: true,
      status: 'applied',
      chat: applied,
      message: this.userRosterMutationMessage(resolution.value, false),
      participantId,
      roundId: runtime?.roundId
    }
  }

  private userRosterMutationMessage(
    mutation: ResolvedEnsembleUserRosterMutation,
    boundary: boolean
  ): string {
    const participant = mutation.affectedParticipantId
      ? mutation.participants.find((candidate) => candidate.id === mutation.affectedParticipantId)
      : undefined
    const label = participantLabel(participant)
    const suffix = boundary ? ' at the execution boundary.' : '.'
    switch (mutation.action) {
      case 'add':
        return `Participant ${label} added to the live roster${suffix}`
      case 'remove':
        return `Participant removed from the live roster${suffix}`
      case 'reorder':
        return `Participant order updated for the remaining live roster${suffix}`
      case 'set_authority':
        return `Participant authority updated for the next authority boundary${suffix}`
      case 'set_auto_approvals':
        return `Thread-wide Auto Approvals updated${suffix}`
    }
  }

  private applyUserRosterMutationToChat(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime | undefined,
    mutation: ResolvedEnsembleUserRosterMutation,
    boundary: boolean
  ): ChatRecord {
    const runtimeAction =
      mutation.action === 'add'
        ? 'add_participant'
        : mutation.action === 'remove'
          ? 'remove_participant'
          : mutation.action === 'reorder'
            ? 'edit_participant'
            : null
    if (runtime && runtimeAction) {
      this.applyRosterEditToRuntime(
        runtime,
        runtimeAction,
        mutation.affectedParticipantId || mutation.participants[0]?.id || '',
        mutation.participants
      )
      if (
        mutation.action === 'remove' &&
        mutation.affectedParticipantId === runtime.bossmanParticipantId
      ) {
        runtime.bossmanParticipantId = undefined
      }
    }
    const rosterUpdatedRound =
      runtime && runtimeAction
        ? this.applyRosterEditToActiveRound(
            chat.ensemble?.activeRound,
            runtime.roundId,
            mutation.participants
          )
        : chat.ensemble?.activeRound
    const activeRound =
      runtime && rosterUpdatedRound?.roundId === runtime.roundId
        ? {
            ...rosterUpdatedRound,
            bossmanParticipantId: mutation.bossmanParticipantId,
            captainParticipantIds: [...mutation.captainParticipantIds],
            secondInCommandParticipantId: mutation.secondInCommandParticipantId
          }
        : rosterUpdatedRound
    if (runtime) {
      runtime.bossmanParticipantId = mutation.bossmanParticipantId
      runtime.captainParticipantIds = [...mutation.captainParticipantIds]
      runtime.secondInCommandParticipantId = mutation.secondInCommandParticipantId
    }
    const updated: ChatRecord = {
      ...chat,
      ensemble: {
        ...chat.ensemble!,
        participants: mutation.participants,
        maxParticipants: mutation.maxParticipants,
        bossmanParticipantId: mutation.bossmanParticipantId,
        captainParticipantIds: mutation.captainParticipantIds,
        secondInCommandParticipantId: mutation.secondInCommandParticipantId,
        bossmanAutoApprovals: mutation.bossmanAutoApprovals,
        activeRound,
        updatedAt: this.deps.nowIso()
      },
      updatedAt: this.deps.now()
    }
    this.saveChatWithCheckpoint(updated, runtime ? 'round-updated' : 'participant-updated')
    if (runtime) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        this.userRosterMutationMessage(mutation, boundary)
      )
    }
    return this.deps.getChat(chat.appChatId) || updated
  }

  private queueOrApplyParticipantSeatChange(input: {
    chat: ChatRecord
    runtime?: ActiveRoundRuntime
    before: EnsembleParticipant
    after: EnsembleParticipant
    patch?: RosterEditParticipantInput
    changedBy: SessionActivityLedgerEntry['changedBy']
    reason: string
  }): EnsembleParticipantSeatChangeResult {
    const { chat, runtime, before, after, patch, changedBy, reason } = input
    const pendingChange = runtime?.pendingParticipantSeatChanges?.find(
      (change) => change.participantId === before.id
    )
    if (runtime && pendingChange?.removeAfterExecution) {
      return {
        ok: true,
        status: 'queued',
        chat: this.deps.getChat(chat.appChatId) || chat,
        message: `Participant removal is already queued for ${participantLabel(before)}.`,
        participantId: before.id,
        roundId: runtime.roundId
      }
    }
    const pendingTarget = pendingChange?.after || before
    // Rapid picker edits arrive as separate patches (provider/model first,
    // reasoning or permissions next). Compose each new patch onto the already
    // queued target so a busy seat adopts the complete user selection at its
    // execution boundary instead of letting the last click erase the first.
    const resolvedAfter =
      pendingChange && patch ? applySeatChangePatch(pendingTarget, patch) : after
    if (
      isBackgroundParticipant(resolvedAfter) &&
      chat.ensemble?.bossmanParticipantId === before.id
    ) {
      return {
        ok: false,
        chat: this.deps.getChat(chat.appChatId) || chat,
        message:
          'Participant seat change rejected: replace the configured Boss before moving that seat to BG.',
        participantId: before.id,
        roundId: runtime?.roundId,
        error: 'invalid_patch'
      }
    }

    // No-op / duplicate guard. Mid-execution the picker may re-submit the
    // running seat or the same pending target; neither should append another
    // authoritative status row.
    if (runtime) {
      if (participantSeatSelectionUnchanged(pendingTarget, resolvedAfter)) {
        return {
          ok: true,
          chat: this.deps.getChat(chat.appChatId) || chat,
          ...(pendingChange ? { pendingParticipant: pendingTarget } : {}),
          message: `Participant seat unchanged for ${participantLabel(before)} — nothing queued.`,
          participantId: before.id,
          roundId: runtime.roundId
        }
      }
    }
    if (runtime && this.isParticipantActivelyExecuting(runtime, before.id)) {
      const queuedAt = this.deps.nowIso()
      runtime.pendingParticipantSeatChanges = [
        ...(runtime.pendingParticipantSeatChanges || []).filter(
          (change) => change.participantId !== before.id
        ),
        {
          participantId: before.id,
          before: pendingChange?.before || before,
          after: resolvedAfter,
          changedBy,
          reason,
          queuedAt
        }
      ]
      const message =
        `Authoritative seat change queued for ${participantLabel(before)}: ` +
        `${participantSeatChangeValue(before, resolvedAfter, before)} -> ${participantSeatChangeValue(before, resolvedAfter, resolvedAfter)}. ` +
        'It will apply when that participant finishes its current execution.'
      // No transcript row at QUEUE time (owner call 2026-08-06). A queued
      // change has not happened: the participant is still executing as its
      // old seat, so a row here would either read as done or need a second,
      // near identical row when it lands at the execution boundary. The
      // boundary is usually the next tool call away, and
      // `applyParticipantSeatChangeToChat` writes the seat element there —
      // which says the same thing, truthfully, once. `message` still travels
      // back to the caller, so the authority that made the edit is told.
      return {
        ok: true,
        status: 'queued',
        chat: this.deps.getChat(chat.appChatId) || chat,
        pendingParticipant: resolvedAfter,
        message,
        participantId: before.id,
        roundId: runtime.roundId
      }
    }

    if (runtime && pendingChange) {
      runtime.pendingParticipantSeatChanges = runtime.pendingParticipantSeatChanges?.filter(
        (change) => change.participantId !== before.id
      )
      if (runtime.pendingParticipantSeatChanges?.length === 0) {
        runtime.pendingParticipantSeatChanges = undefined
      }
    }
    const applied = this.applyParticipantSeatChangeToChat({
      chat,
      runtime,
      before,
      after: resolvedAfter,
      changedBy,
      reason,
      boundary: false
    })
    return {
      ok: true,
      status: 'applied',
      chat: applied,
      message: `Authoritative seat change applied for ${participantLabel(before)}.`,
      participantId: before.id,
      roundId: runtime?.roundId
    }
  }

  private isParticipantActivelyExecuting(
    runtime: ActiveRoundRuntime,
    participantId: string
  ): boolean {
    const activeRun = runtime.activeRunId ? this.runsByRunId.get(runtime.activeRunId) : undefined
    if (activeRun?.participant.id === participantId) return true
    const activeRound = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
    if (
      activeRound?.roundId === runtime.roundId &&
      activeRound.activeParticipantId === participantId
    ) {
      return true
    }
    return this.participantFanoutDispatchState(runtime, participantId) === 'active'
  }

  private applyPendingParticipantSeatChanges(
    runtime: ActiveRoundRuntime,
    pendingSeatChanges: PendingParticipantSeatChange[] = runtime.pendingParticipantSeatChanges || []
  ): void {
    if (pendingSeatChanges.length === 0) return
    runtime.pendingParticipantSeatChanges = [...pendingSeatChanges]
    for (const change of pendingSeatChanges) {
      this.applyPendingParticipantSeatChangeFor(runtime, change.participantId)
    }
  }

  private applyPendingParticipantSeatChangeFor(
    runtime: ActiveRoundRuntime,
    participantId: string
  ): void {
    const pending = runtime.pendingParticipantSeatChanges || []
    const index = pending.findIndex((change) => change.participantId === participantId)
    if (index < 0) return
    const [change] = pending.splice(index, 1)
    if (pending.length === 0) runtime.pendingParticipantSeatChanges = undefined
    const chat = this.deps.getChat(runtime.chatId)
    const current = chat?.ensemble?.participants.find(
      (participant) => participant.id === participantId
    )
    if (!chat?.ensemble || !current) return
    if (change.removeAfterExecution) {
      const resolution = resolveEnsembleUserRosterMutation(
        chat.ensemble,
        {
          chatId: chat.appChatId,
          action: 'remove',
          participantId
        },
        {
          nowIso: this.deps.nowIso(),
          isProviderSelectable: () => true
        }
      )
      if (!resolution.ok) return
      this.applyUserRosterMutationToChat(chat, runtime, resolution.value, true)
      return
    }
    const after = { ...change.after, order: current.order }
    this.applyParticipantSeatChangeToChat({
      chat,
      runtime,
      before: current,
      after,
      changedBy: change.changedBy,
      reason: change.reason,
      boundary: true
    })
  }

  /**
   * Freshest chat bytes for a mutation that must not clobber concurrent
   * transcript writers. Fan-out lane flushes debounce through
   * `flushChatOverlay`; a seat-change save that spreads a pre-flush snapshot
   * would wipe those lane cards and the Fan-Out Scout disclosure can never
   * form (expectedLaneCount never met). Prefer the in-flight overlay, then
   * the store, then the caller snapshot.
   */
  private latestChatForMutation(chatId: string, fallback: ChatRecord): ChatRecord {
    if (this.flushChatOverlay?.chatId === chatId) return this.flushChatOverlay.chat
    return this.deps.getChat(chatId) || fallback
  }

  private applyParticipantSeatChangeToChat(input: {
    chat: ChatRecord
    runtime?: ActiveRoundRuntime
    before: EnsembleParticipant
    after: EnsembleParticipant
    changedBy: SessionActivityLedgerEntry['changedBy']
    reason: string
    boundary: boolean
    updateActiveRound?: boolean
  }): ChatRecord {
    const {
      chat,
      runtime,
      before,
      after,
      changedBy,
      reason,
      boundary,
      updateActiveRound = true
    } = input
    // Rebase onto the latest snapshot. Callers often hand in the chat they
    // read at request start; scout/review lane flushes can land in the store
    // (or the shared flush overlay) before this save runs.
    const latest = this.latestChatForMutation(chat.appChatId, chat)
    if (!latest.ensemble) return this.deps.getChat(chat.appChatId) || latest
    const nowIso = this.deps.nowIso()
    const nextParticipants = latest.ensemble.participants.map((participant) =>
      participant.id === before.id ? { ...after, order: participant.order } : participant
    )
    const editedActiveRound =
      runtime && updateActiveRound
        ? this.applyRosterEditToActiveRound(
            latest.ensemble.activeRound,
            runtime.roundId,
            nextParticipants
          )
        : latest.ensemble.activeRound
    // An execution-config change makes a standing failed/unreachable marker a
    // false alarm for the seat's NEW config: clear the round-state warning (and
    // stamp superseded failed lanes) whether the round is live or long over.
    // Identity-only edits (role rename etc.) leave the failure standing.
    const executionConfigChanged = ensembleSeatExecutionConfigChanged(before, after)
    const activeRound =
      executionConfigChanged && updateActiveRound
        ? clearEnsembleRoundFailureForSeatChange(editedActiveRound, before.id, nowIso)
        : editedActiveRound
    if (executionConfigChanged && runtime) {
      // The probe verdict described the old config; let Boss routing and
      // continuation paths reach the fixed seat again this round.
      runtime.unreachableParticipantIds?.delete(before.id)
    }
    const activityEntry = this.createSeatChangeActivityEntry(
      before,
      after,
      changedBy,
      reason,
      nowIso
    )
    const bossmanParticipantId = latest.ensemble.bossmanParticipantId
    const captainParticipantIds = configuredEnsembleCaptainParticipantIds({
      participants: nextParticipants,
      bossmanParticipantId,
      captainParticipantIds: latest.ensemble.captainParticipantIds,
      secondInCommandParticipantId: latest.ensemble.secondInCommandParticipantId
    })
    const saved: ChatRecord = {
      ...latest,
      ensemble: {
        ...latest.ensemble,
        participants: nextParticipants,
        bossmanParticipantId,
        captainParticipantIds,
        secondInCommandParticipantId: captainParticipantIds[0],
        bossmanAutoApprovals: latest.ensemble.bossmanAutoApprovals,
        activeRound,
        sessionActivityLedger: [
          ...(latest.ensemble.sessionActivityLedger || []),
          activityEntry
        ].slice(-SESSION_ACTIVITY_LEDGER_LIMIT),
        updatedAt: nowIso
      },
      updatedAt: this.deps.now()
    }
    this.saveChatWithCheckpoint(saved, 'participant-updated')
    if (runtime && updateActiveRound) {
      this.applyRosterEditToRuntime(runtime, 'edit_participant', before.id, nextParticipants)
      const message =
        `Authoritative seat change ${boundary ? 'applied at execution boundary' : 'applied'} for ` +
        `${participantLabel(before)}: ${participantSeatChangeValue(before, after, before)} -> ${participantSeatChangeValue(before, after, after)}.`
      this.appendSeatChange(runtime.chatId, runtime.roundId, before, after, message)
    }
    return this.deps.getChat(chat.appChatId) || saved
  }

  private createSeatChangeActivityEntry(
    before: EnsembleParticipant,
    after: EnsembleParticipant,
    changedBy: SessionActivityLedgerEntry['changedBy'],
    reason: string,
    timestamp: string
  ): SessionActivityLedgerEntry {
    return {
      id: `ensemble-seat-change-${before.id}-${this.deps.now()}`,
      timestamp,
      changedBy,
      scope: 'participant',
      target: before.id,
      oldValue: participantSeatChangeValue(before, after, before),
      newValue: participantSeatChangeValue(before, after, after),
      reason
    }
  }

  private validateRosterEditProvider(
    input: EnsembleRosterEditInput,
    participants: EnsembleParticipant[]
  ):
    | { ok: true; probeParticipant?: EnsembleParticipant }
    | { ok: false; error: 'unknown_provider'; message: string } {
    const patch = input.participant
    const provider = typeof patch?.provider === 'string' ? patch.provider : undefined
    if (input.action === 'add_participant') {
      if (!provider) return { ok: true }
      if (!selectableProviderIds().includes(provider as ProviderId)) {
        return {
          ok: false,
          error: 'unknown_provider',
          message: `Roster edit rejected: ${provider} is not a live selectable provider.`
        }
      }
      return {
        ok: true,
        probeParticipant: {
          id: this.nextRosterEditParticipantId(participants),
          provider: provider as ProviderId,
          enabled: true,
          role: patch?.role || providerLabel(provider as ProviderId),
          instructions: patch?.instructions || '',
          order: participants.length + 1,
          ...(patch?.model ? { model: patch.model } : {}),
          ...(patch?.permissionPresetId
            ? {
                permissionPresetId:
                  patch.permissionPresetId as EnsembleParticipant['permissionPresetId']
              }
            : {}),
          ...(patch?.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}),
          ...(typeof patch?.fastModeEnabled === 'boolean'
            ? { fastModeEnabled: patch.fastModeEnabled }
            : {}),
          ...(typeof patch?.thinkingEnabled === 'boolean'
            ? { thinkingEnabled: patch.thinkingEnabled }
            : {})
        }
      }
    }
    if (
      input.action !== 'edit_participant' ||
      !patch ||
      !Object.prototype.hasOwnProperty.call(patch, 'provider')
    ) {
      return { ok: true }
    }
    if (!provider) return { ok: true }
    if (!selectableProviderIds().includes(provider as ProviderId)) {
      return {
        ok: false,
        error: 'unknown_provider',
        message: `Roster edit rejected: ${provider} is not a live selectable provider.`
      }
    }
    const target = participants.find((participant) => participant.id === input.targetParticipantId)
    if (!target || target.provider === provider) return { ok: true }
    return {
      ok: true,
      probeParticipant: this.applyRosterEditProbePatch(target, patch, provider as ProviderId)
    }
  }

  private applyRosterEditProbePatch(
    target: EnsembleParticipant,
    patch: RosterEditParticipantInput,
    provider: ProviderId
  ): EnsembleParticipant {
    return {
      ...target,
      provider,
      ...(patch.model ? { model: patch.model } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.permissionPresetId
        ? {
            permissionPresetId:
              patch.permissionPresetId as EnsembleParticipant['permissionPresetId']
          }
        : {}),
      ...(patch.reasoningEffort ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(typeof patch.fastModeEnabled === 'boolean'
        ? { fastModeEnabled: patch.fastModeEnabled }
        : {}),
      ...(typeof patch.thinkingEnabled === 'boolean'
        ? { thinkingEnabled: patch.thinkingEnabled }
        : {})
    }
  }

  private applyRosterEditToRuntime(
    runtime: ActiveRoundRuntime,
    action: RosterEditAction,
    affectedParticipantId: string,
    nextParticipants: EnsembleParticipant[]
  ): void {
    const remaining = runtime.remainingParticipants
    runtime.captainParticipantIds = configuredEnsembleCaptainParticipantIds({
      participants: nextParticipants,
      bossmanParticipantId: runtime.bossmanParticipantId,
      captainParticipantIds: runtime.captainParticipantIds,
      secondInCommandParticipantId: runtime.secondInCommandParticipantId
    })
    runtime.secondInCommandParticipantId = runtime.captainParticipantIds[0]
    if (!remaining) return
    const nextById = new Map(nextParticipants.map((participant) => [participant.id, participant]))
    const affected = nextById.get(affectedParticipantId)
    if (action === 'add_participant') {
      if (
        affected &&
        affected.enabled !== false &&
        !isBackgroundParticipant(affected) &&
        !remaining.some((participant) => participant.id === affected.id)
      ) {
        remaining.push(affected)
      }
    } else if (action === 'remove_participant') {
      const filtered = remaining.filter((participant) => participant.id !== affectedParticipantId)
      remaining.length = 0
      remaining.push(...filtered)
    } else {
      const edited = remaining
        .map((participant) => nextById.get(participant.id) || participant)
        .filter(
          (participant) => participant.enabled !== false && !isBackgroundParticipant(participant)
        )
      const activeRound = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
      const affectedState = activeRound?.participants.find(
        (participant) => participant.participantId === affectedParticipantId
      )
      if (
        affected &&
        affected.enabled !== false &&
        !isBackgroundParticipant(affected) &&
        !edited.some((participant) => participant.id === affected.id) &&
        (!affectedState ||
          affectedState.status === 'idle' ||
          (affectedState.status === 'skipped' &&
            (affectedState.reason === 'Disabled during the active round.' ||
              affectedState.reason === 'Moved to BG during the active round.')))
      ) {
        edited.push(affected)
      }
      remaining.length = 0
      remaining.push(...edited)
    }
    remaining.sort((a, b) => a.order - b.order)
    runtime.remainingParticipants = remaining
  }

  private applyRosterEditToActiveRound(
    round: EnsembleRoundState | undefined,
    roundId: string,
    nextParticipants: EnsembleParticipant[]
  ): EnsembleRoundState | undefined {
    if (!round || round.roundId !== roundId) return round
    const nextById = new Map(nextParticipants.map((participant) => [participant.id, participant]))
    const existing = round.participants
      .filter((state) => nextById.has(state.participantId))
      .map((state) => {
        const participant = nextById.get(state.participantId)!
        const disabledWhileIdle = participant.enabled === false && state.status === 'idle'
        const backgroundWhileIdle = isBackgroundParticipant(participant) && state.status === 'idle'
        const restoredToSerial =
          participant.enabled !== false &&
          !isBackgroundParticipant(participant) &&
          state.status === 'skipped' &&
          (state.reason === 'Disabled during the active round.' ||
            state.reason === 'Moved to BG during the active round.')
        return {
          ...state,
          ...roundParticipantDisplayFields(participant),
          ...(disabledWhileIdle
            ? {
                status: 'skipped' as const,
                reason: 'Disabled during the active round.'
              }
            : backgroundWhileIdle
              ? {
                  status: 'skipped' as const,
                  reason: 'Moved to BG during the active round.'
                }
              : restoredToSerial
                ? {
                    status: 'idle' as const,
                    reason: undefined
                  }
                : {})
        }
      })
    const removed = round.participants
      .filter((state) => !nextById.has(state.participantId))
      .map((state) => ({
        ...state,
        status: state.status === 'idle' ? ('skipped' as const) : state.status,
        reason: state.reason || 'Removed from the active roster during this round.'
      }))
    const existingIds = new Set(existing.map((state) => state.participantId))
    const added = nextParticipants
      .filter(
        (participant) =>
          participant.enabled !== false &&
          !isBackgroundParticipant(participant) &&
          !existingIds.has(participant.id)
      )
      .map((participant) => roundParticipantStateFromParticipant(participant, 'idle'))
    const participantStates = [...existing, ...removed, ...added].sort((a, b) => a.order - b.order)
    const captainParticipantIds = configuredEnsembleCaptainParticipantIds({
      participants: nextParticipants,
      bossmanParticipantId: round.bossmanParticipantId,
      captainParticipantIds: round.captainParticipantIds,
      secondInCommandParticipantId: round.secondInCommandParticipantId
    })
    return {
      ...round,
      activeParticipantId:
        round.activeParticipantId && nextById.has(round.activeParticipantId)
          ? round.activeParticipantId
          : undefined,
      bossmanParticipantId:
        round.bossmanParticipantId && nextById.has(round.bossmanParticipantId)
          ? round.bossmanParticipantId
          : undefined,
      captainParticipantIds,
      secondInCommandParticipantId: captainParticipantIds[0],
      participants: participantStates
    }
  }

  private nextRosterEditParticipantId(participants: EnsembleParticipant[]): string {
    const existing = new Set(participants.map((participant) => participant.id))
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = `bossman-roster-${this.deps.now().toString(36)}-${attempt}`
      if (!existing.has(id)) return id
    }
    return `bossman-roster-${Math.random().toString(36).slice(2, 10)}`
  }

  private roundHasParticipant(
    round: EnsembleRoundState | undefined,
    roundId: string,
    participantId: string
  ): boolean {
    return (
      round?.roundId === roundId &&
      round.participants.some((participant) => participant.participantId === participantId)
    )
  }

  private selectParticipantsByBossman(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput,
    caller: ActiveParticipantRun,
    authorityRole: 'boss' | 'second_in_command'
  ): EnsembleBossmanControlResult {
    const authorityLabel = authorityRole === 'second_in_command' ? 'Captain' : 'Boss'
    if (
      preservesInitialPassRoster({
        orchestrationMode: runtime.orchestrationMode,
        continuationPass: runtime.continuationPass
      })
    ) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'select_participants',
        roundId: runtime.roundId,
        message:
          'Boss/Captain selection is unavailable during the initial Turn-bound Ensemble pass; every first-pass participant keeps its turn.',
        error: 'initial_pass_preserves_roster'
      }
    }
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'select_participants',
        roundId: runtime.roundId,
        message: `${authorityLabel} selection rejected: active chat is no longer an Ensemble chat.`,
        error: 'not_ensemble'
      }
    }
    const remaining = runtime.remainingParticipants || []
    const selection = resolveAuthoritySelection({
      participantIds: input.participantIds,
      participantRoles: input.participantRoles,
      participants: chat.ensemble.participants,
      pendingParticipants: remaining,
      callerParticipantId: caller.participant.id
    })
    if (!selection.ok) {
      const message =
        selection.error === 'missing_selection'
          ? `${authorityLabel} selection requires participantIds and/or participantRoles.`
          : selection.error === 'ambiguous_selector'
            ? `${authorityLabel} selection rejected: "${selection.selector}" is ambiguous. Use an exact participant id, unique role, or model.`
            : selection.error === 'not_pending_selector'
              ? `${authorityLabel} selection rejected: "${selection.selector}" is no longer pending in this pass.`
              : `${authorityLabel} selection rejected: "${selection.selector}" does not resolve to a participant.`
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'select_participants',
        roundId: runtime.roundId,
        message,
        error: selection.error === 'missing_selection' ? 'missing_required_field' : 'invalid_target'
      }
    }

    const reason = input.reason || `${authorityLabel} kept this participant for the current pass.`
    remaining.splice(0, remaining.length, ...selection.selected)
    for (const participant of selection.skipped) {
      this.updateParticipantState(
        runtime.chatId,
        runtime.roundId,
        participant.id,
        'skipped',
        `${authorityLabel} did not select this participant for pass ${runtime.continuationPass}. ${reason}`
      )
    }
    this.markAuthorityRoutingDecision(caller, 'selected')
    const kept = selection.selected.map((participant) => participantDisplayName(participant))
    const skipped = selection.skipped.map((participant) => participantDisplayName(participant))
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${authorityLabel} selected ${kept.join(', ') || 'no pending participants'} for pass ${runtime.continuationPass}.${
        skipped.length ? ` Skipped: ${skipped.join(', ')}.` : ''
      }`
    )
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'select_participants',
      roundId: runtime.roundId,
      message: `${authorityLabel} applied an explicit participant selection for this pass.`
    }
  }

  private skipAuthorityIntervention(
    runtime: ActiveRoundRuntime,
    caller: ActiveParticipantRun,
    authorityRole: 'boss' | 'second_in_command'
  ): EnsembleBossmanControlResult {
    const checkpoint = caller.authorityRoutingCheckpoint
    const authorityLabel = authorityRole === 'second_in_command' ? 'Captain' : 'Boss'
    if (!checkpoint) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'skip_intervention',
        roundId: runtime.roundId,
        message: `${authorityLabel} has no active authority-routing checkpoint to skip.`,
        error: 'authority_checkpoint_missing'
      }
    }
    this.markAuthorityRoutingDecision(caller, 'skipped_intervention')
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${authorityLabel} explicitly preserved the current queue at its authority-routing checkpoint.`
    )
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'skip_intervention',
      roundId: runtime.roundId,
      message: `${authorityLabel} skipped the authority intervention and preserved the current queue.`
    }
  }

  private skipParticipantByBossman(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput,
    caller: ActiveParticipantRun,
    authorityRole: 'boss' | 'second_in_command',
    targetRun?: ActiveParticipantRun
  ): EnsembleBossmanControlResult {
    const authorityLabel = authorityRole === 'second_in_command' ? 'Captain' : 'Boss'
    const reason = input.reason || `Skipped by ${authorityLabel}.`
    let active = targetRun
    if (!active && runtime.activeRunId) {
      const candidate = this.runsByRunId.get(runtime.activeRunId)
      if (
        candidate &&
        (!input.targetParticipantId || candidate.participant.id === input.targetParticipantId)
      ) {
        active = candidate
      }
    }
    if (active) {
      if (
        preservesInitialPassRoster({
          orchestrationMode: runtime.orchestrationMode,
          continuationPass: runtime.continuationPass
        })
      ) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action: 'skip_participant',
          roundId: runtime.roundId,
          participantId: active.participant.id,
          message:
            'Boss/Captain cannot skip a participant during the initial Turn-bound Ensemble pass; every first-pass participant keeps its turn.',
          error: 'initial_pass_preserves_roster'
        }
      }
      active.fanoutDispatchCancelled = true
      this.finalizeRun(active, 'skipped', reason)
      if (runtime.activeRunId === active.runId) runtime.activeRunId = undefined
      runtime.activeScoutRunIds?.delete(active.runId)
      this.markAuthorityRoutingDecision(caller, 'skipped_participant')
      void this.deps.cancelRun(active.participant.provider, active.runId).catch(() => undefined)
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action: 'skip_participant',
        roundId: runtime.roundId,
        participantId: active.participant.id,
        message: `${authorityLabel} skipped ${active.participant.role || active.participant.provider}.`
      }
    }

    const targetParticipantId = input.targetParticipantId
    if (!targetParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'skip_participant',
        roundId: runtime.roundId,
        message: 'Boss skip requires targetParticipantId or targetRunId.',
        error: 'stale_target'
      }
    }
    const remaining = runtime.remainingParticipants || []
    const index = remaining.findIndex((participant) => participant.id === targetParticipantId)
    if (index < 0) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'skip_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: 'Boss skip rejected: target participant is no longer pending.',
        error: 'stale_target'
      }
    }
    if (
      preservesInitialPassRoster({
        orchestrationMode: runtime.orchestrationMode,
        continuationPass: runtime.continuationPass
      })
    ) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'skip_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message:
          'Boss/Captain cannot skip a participant during the initial Turn-bound Ensemble pass; every first-pass participant keeps its turn.',
        error: 'initial_pass_preserves_roster'
      }
    }
    const [participant] = remaining.splice(index, 1)
    this.updateParticipantState(runtime.chatId, runtime.roundId, participant.id, 'skipped', reason)
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${authorityLabel} skipped ${participant.role || participant.provider}. ${reason}`
    )
    this.markAuthorityRoutingDecision(caller, 'skipped_participant')
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'skip_participant',
      roundId: runtime.roundId,
      participantId: participant.id,
      message: `${authorityLabel} skipped pending participant ${participant.role || participant.provider}.`
    }
  }

  private summonParticipantByBossman(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput,
    caller: ActiveParticipantRun,
    authorityRole: 'boss' | 'second_in_command'
  ): EnsembleBossmanControlResult {
    const authorityLabel = authorityRole === 'second_in_command' ? 'Captain' : 'Boss'
    const targetParticipantId = input.targetParticipantId
    if (!targetParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        message: `${authorityLabel} summon requires targetParticipantId.`,
        error: 'stale_target'
      }
    }
    if (targetParticipantId === caller.participant.id) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: `${authorityLabel} summon rejected: the controlling participant cannot summon itself.`,
        error: 'summon_self_target'
      }
    }
    if (runtime.orchestrationMode !== 'continuous') {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: `${authorityLabel} summon rejected: directed continuations require Continuous mode.`,
        error: 'summon_not_continuous'
      }
    }
    const chat = this.deps.getChat(runtime.chatId)
    const target = chat?.ensemble?.participants.find(
      (participant) => participant.id === targetParticipantId
    )
    if (!chat?.ensemble || !target) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: `${authorityLabel} summon rejected: target participant is no longer on the roster.`,
        error: 'stale_target'
      }
    }
    if (!target.enabled) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: `${authorityLabel} summon rejected: ${target.role || target.provider} is disabled.`,
        error: 'summon_target_disabled'
      }
    }
    const activeRun = runtime.activeRunId ? this.runsByRunId.get(runtime.activeRunId) : undefined
    const activeScoutRun = [...(runtime.activeScoutRunIds || [])]
      .map((runId) => this.runsByRunId.get(runId))
      .find((run) => run?.participant.id === target.id)
    if (
      activeRun?.participant.id === target.id ||
      activeScoutRun ||
      this.activeRoundParticipantStatus(runtime, target.id) === 'running'
    ) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: target.id,
        message: `${authorityLabel} summon rejected: ${target.role || target.provider} is already active.`,
        error: 'summon_target_active'
      }
    }
    const remaining = runtime.remainingParticipants ?? (runtime.remainingParticipants = [])
    if (remaining.some((participant) => participant.id === target.id)) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: target.id,
        message: `${authorityLabel} summon rejected: ${target.role || target.provider} is already pending; use reorder_remaining or ensemble_yield for pending participants.`,
        error: 'summon_target_pending'
      }
    }
    runtime.bossmanSummonCountsByParticipantId ??= new Map()
    const previousSummonCount = runtime.bossmanSummonCountsByParticipantId.get(target.id) || 0
    if (previousSummonCount >= MAX_BOSSMAN_SUMMONS_PER_PARTICIPANT_PER_ROUND) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: target.id,
        message: `${authorityLabel} summon rejected: ${target.role || target.provider} has already been re-summoned ${MAX_BOSSMAN_SUMMONS_PER_PARTICIPANT_PER_ROUND} times this round.`,
        error: 'summon_limit'
      }
    }

    const reason = (input.reason || 'Directed continuation requested.').trim()
    const continuation = this.tryAppendContinuationTurn(
      runtime,
      remaining,
      target,
      `${authorityLabel} re-summoned ${target.role || target.provider} (${target.provider}). Reason: ${reason}`,
      { allowAnsweredParticipant: true, allowYieldedParticipant: true }
    )
    if (!continuation.appended) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'summon_participant',
        roundId: runtime.roundId,
        participantId: target.id,
        message: `${authorityLabel} summon rejected: ${target.role || target.provider} cannot be re-summoned because ${this.describeContinuationDecline(continuation)}.`,
        error:
          continuation.reason === 'hop_limit'
            ? 'summon_hop_limit'
            : continuation.reason === 'not_continuous'
              ? 'summon_not_continuous'
              : continuation.reason === 'active_fanout'
                ? 'summon_target_active'
                : continuation.reason === 'budget_exhausted'
                  ? 'budget_exhausted'
                  : 'summon_blocked_status'
      }
    }
    runtime.bossmanSummonCountsByParticipantId.set(target.id, previousSummonCount + 1)
    this.markAuthorityRoutingDecision(caller, 'summoned')
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'summon_participant',
      roundId: runtime.roundId,
      participantId: target.id,
      message: `${authorityLabel} re-summoned ${target.role || target.provider} for another turn.`
    }
  }

  private structuredBossmanControl(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput,
    caller: EnsembleParticipant,
    authorityRole: 'boss' | 'second_in_command'
  ): EnsembleBossmanControlResult {
    const action = input.action
    const authorityLabel = authorityRole === 'second_in_command' ? 'Captain' : 'Boss'
    if (!action) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        message: 'Boss control rejected: action is required.',
        error: 'invalid_action'
      }
    }

    if (action === 'check_quota_resets') {
      const provider = input.provider
      if (provider && !selectableProviderIds().includes(provider)) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: 'Boss quota check rejected: provider is not recognized.',
          error: 'invalid_target'
        }
      }
      if (provider) {
        const snapshot = this.deps.getProviderUsageSnapshot?.(provider) || null
        const usage = summarizeProviderUsage(provider, snapshot)
        const resetWindows = usage.windows
          .filter((window) => window.resetAt)
          .map((window) => `${window.label}: ${window.resetAt}`)
        const message = snapshot
          ? `${authorityLabel} checked ${providerLabel(provider)} quota/reset status: ${usage.worstBand}${resetWindows.length ? `; resets ${resetWindows.join(', ')}` : ''}.`
          : `${authorityLabel} checked ${providerLabel(provider)} quota/reset status; no usage snapshot is available.`
        this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
        return {
          ok: Boolean(snapshot),
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          usage,
          message,
          ...(snapshot ? {} : { error: 'quota_unavailable' as const })
        }
      }
      const providers = selectableProviderIds().reduce<
        Partial<Record<ProviderId, ProviderUsageSummary>>
      >((acc, candidate) => {
        acc[candidate] = summarizeProviderUsage(
          candidate,
          this.deps.getProviderUsageSnapshot?.(candidate) || null
        )
        return acc
      }, {})
      const configuredCount = Object.values(providers).filter((entry) => entry?.configured).length
      const message = `${authorityLabel} checked provider quota/reset status for ${configuredCount} configured provider(s).`
      this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        providers,
        message
      }
    }

    if (action === 'clear_goal') {
      const chat = this.deps.getChat(runtime.chatId)
      if (!chat?.activeGoal) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: 'Boss clear_goal rejected: no active TaskWraith goal is set.',
          error: 'invalid_state'
        }
      }
      const goal = chat.activeGoal
      if (goal.status === 'active' && !input.reason?.trim()) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: 'Boss clear_goal rejected: clearing an active goal requires a reason.',
          error: 'missing_required_field'
        }
      }
      const reason = normalizeBossmanText(input.reason, 500) || 'Cleared by Boss/Captain control.'
      this.saveChatWithCheckpoint(
        {
          ...chat,
          activeGoal: undefined,
          updatedAt: this.deps.now()
        },
        'round-updated'
      )
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} cleared the TaskWraith goal "${goal.objective}". ${reason}`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: `${authorityLabel} cleared the active TaskWraith goal.`
      }
    }

    if (action === 'set_goal') {
      const chat = this.deps.getChat(runtime.chatId)
      if (!chat) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: `${authorityLabel} set_goal rejected: chat is no longer available.`,
          error: 'invalid_state'
        }
      }
      const objective = normalizeActiveGoalObjective(input.goal || input.objective || input.prompt)
      if (!objective) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: `${authorityLabel} set_goal rejected: goal/objective/prompt is required.`,
          error: 'missing_required_field'
        }
      }
      const nowIso = this.deps.nowIso()
      // C2 P2 — a materially-new objective (or a completed prior goal) MINTS a
      // fresh identity so its review gates don't inherit the prior goal's id (the
      // reuse trap that would make C2's goalId filter a no-op). Re-setting the
      // SAME objective preserves id (idempotent). edit/update/reopen preserve id
      // via their own updateActiveGoalLifecycle paths, unchanged.
      const priorGoal = chat.activeGoal
      const nextGoal =
        priorGoal && !shouldMintFreshGoalIdentity(priorGoal, objective)
          ? updateActiveGoalLifecycle(
              {
                ...priorGoal,
                objective,
                objectiveSource: 'agent',
                provider: caller.provider,
                mode: 'taskwraith_steered'
              },
              'active',
              input.reason,
              new Date(nowIso)
            )
          : createActiveGoal(caller.provider, objective, {
              now: new Date(nowIso),
              allowProviderNative: false,
              objectiveSource: 'agent'
            })
      this.saveChatWithCheckpoint(
        {
          ...chat,
          activeGoal: nextGoal,
          updatedAt: this.deps.now()
        },
        'round-updated'
      )
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} set the TaskWraith goal "${nextGoal.objective}".`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        goal: nextGoal,
        message: `${authorityLabel} set the active TaskWraith goal.`
      }
    }

    if (action === 'update_goal') {
      const chat = this.deps.getChat(runtime.chatId)
      if (!chat?.activeGoal) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: `${authorityLabel} update_goal rejected: no active TaskWraith goal is set.`,
          error: 'invalid_state'
        }
      }
      const status = input.goalStatus || input.status
      if (
        status !== 'active' &&
        status !== 'paused' &&
        status !== 'blocked' &&
        status !== 'completed'
      ) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: `${authorityLabel} update_goal rejected: goalStatus must be active, paused, blocked, or completed.`,
          error: 'missing_required_field'
        }
      }
      if (status === 'blocked' && !input.reason?.trim()) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: `${authorityLabel} update_goal rejected: blocking a goal requires a reason.`,
          error: 'missing_required_field'
        }
      }
      if (status === 'completed') {
        const blockingGates = this.activeBossmanReviewGateBlocks(chat)
        if (blockingGates.length > 0) {
          const message = `${authorityLabel} goal completion blocked by review gate(s): ${blockingGates.join('; ')}.`
          this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
          return {
            ok: false,
            tool: 'ensemble_bossman_control',
            action,
            roundId: runtime.roundId,
            message,
            error: 'review_gate_blocked'
          }
        }
      }
      const nextGoal = updateActiveGoalLifecycle(
        chat.activeGoal,
        status,
        input.reason,
        new Date(this.deps.nowIso())
      )
      this.saveChatWithCheckpoint(
        {
          ...chat,
          activeGoal: nextGoal,
          updatedAt: this.deps.now()
        },
        'round-updated'
      )
      const reason = normalizeBossmanText(input.reason, 500)
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} marked the TaskWraith goal ${status}.${reason ? ` ${reason}` : ''}`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        goal: nextGoal,
        message: `${authorityLabel} updated the active TaskWraith goal.`
      }
    }

    if (action === 'adjust_hops') {
      const requested =
        typeof input.maxContinuationHops === 'number'
          ? input.maxContinuationHops
          : typeof input.hopDelta === 'number'
            ? runtime.maxContinuationHops + input.hopDelta
            : NaN
      if (!Number.isFinite(requested)) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: 'Boss adjust_hops requires maxContinuationHops or hopDelta.',
          error: 'missing_required_field'
        }
      }
      const nextMax = Math.max(1, Math.min(MAX_CONTINUATION_HOP_LIMIT, Math.floor(requested)))
      runtime.maxContinuationHops = nextMax
      runtime.continuationLimitNotified = false
      runtime.continuationLimitPending = false
      this.updateChatRound(runtime.chatId, (round) =>
        round?.roundId === runtime.roundId
          ? { ...round, maxContinuationHops: nextMax, continuationHops: runtime.continuationHops }
          : round
      )
      const chat = this.deps.getChat(runtime.chatId)
      if (chat?.ensemble) {
        this.saveChatWithCheckpoint(
          {
            ...chat,
            ensemble: {
              ...chat.ensemble,
              maxContinuationHops: nextMax,
              updatedAt: this.deps.nowIso()
            },
            updatedAt: this.deps.now()
          },
          'round-updated'
        )
      }
      const reason = normalizeBossmanText(input.reason, 300)
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} adjusted the continuous handoff budget to ${runtime.continuationHops}/${nextMax}.${reason ? ` Reason: ${reason}` : ''}`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: `${authorityLabel} adjusted maxContinuationHops to ${nextMax}.`
      }
    }

    if (action === 'ensemble_scheduled_wakeup') {
      const delaySeconds =
        typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds)
          ? Math.floor(input.delaySeconds)
          : NaN
      if (!Number.isFinite(delaySeconds) || delaySeconds < 60) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: 'Boss ensemble_scheduled_wakeup requires delaySeconds >= 60.',
          error: 'missing_required_field'
        }
      }
      const reason = normalizeBossmanText(input.reason, 500) || 'Whole ensemble scheduled wake-up.'
      const result = this.scheduleWakeupForRun(runtime.activeRunId, {
        delaySeconds,
        reason,
        cancelOnUserInput: false
      })
      if (!result.ok) {
        return {
          ok: false,
          tool: 'ensemble_bossman_control',
          action,
          roundId: runtime.roundId,
          message: `Boss ensemble_scheduled_wakeup failed: ${result.error || 'unknown error'}`,
          error: 'wakeup_failed'
        }
      }
      runtime.remainingParticipants?.splice(0)
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: `${authorityLabel} scheduled an ensemble wake-up in ${delaySeconds} seconds.`
      }
    }

    const nowIso = this.deps.nowIso()
    const callerId = caller.id
    const participantIds = this.resolveBossmanTargetParticipantIds(runtime, input)
    const targetLabel = this.formatBossmanTargetLabels(runtime, participantIds)

    if (action === 'assign_work') {
      const objective = normalizeBossmanText(input.objective || input.prompt, 1000)
      if (!input.targetParticipantId || !objective) {
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'assign_work requires targetParticipantId and objective.'
        )
      }
      const participant = this.findRuntimeParticipant(runtime, input.targetParticipantId)
      if (!participant) return this.invalidBossmanTarget(action, runtime.roundId)
      const assignment = {
        id: input.assignmentId || this.nextBossmanControlId('assign'),
        participantId: participant.id,
        objective,
        acceptanceCriteria: normalizeBossmanText(input.acceptanceCriteria, 1000) || undefined,
        due: input.due || 'this_round',
        status: input.assignmentStatus || 'open',
        reason: normalizeBossmanText(input.reason, 500) || undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({
        ...state,
        assignments: capBossmanItems([
          ...(state.assignments || []).filter((entry) => entry.id !== assignment.id),
          assignment
        ])
      }))
      // C4 — a fresh assignment is genuine net-new work; re-arm the one-shot
      // administrative-idle escalation so a later real deadlock can stop the loop.
      runtime.administrativeIdleEscalated = false
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} assigned ${participantDisplayName(participant)}: ${objective}`
      )
      if (assignment.due === 'next_turn' || assignment.due === 'this_round') {
        this.routeBossmanTargets(
          runtime,
          [participant.id],
          `${authorityLabel} routed assigned work to ${participantDisplayName(participant)}.`
        )
      }
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        participantId: participant.id,
        message: `${authorityLabel} assigned work to ${participantDisplayName(participant)}.`
      }
    }

    if (action === 'set_round_plan') {
      const goal = normalizeBossmanText(input.goal || input.objective || input.prompt, 1200)
      if (!goal)
        return this.missingBossmanField(action, runtime.roundId, 'set_round_plan requires goal.')
      const plan = {
        goal,
        phase: normalizeBossmanText(input.phase, 240) || undefined,
        ownerParticipantIds: participantIds.length ? participantIds : undefined,
        blockers: normalizeBossmanTextArray(input.blockers, 8, 240),
        doneCriteria:
          normalizeBossmanText(input.doneCriteria || input.acceptanceCriteria, 1000) || undefined,
        updatedAt: nowIso,
        updatedByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({ ...state, roundPlan: plan }))
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} set the round plan: ${goal}`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: `${authorityLabel} set the round plan.`
      }
    }

    if (action === 'request_status') {
      const prompt = normalizeBossmanText(input.question || input.prompt || input.reason, 800)
      if (!prompt)
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'request_status requires prompt or question.'
        )
      const request = {
        id: this.nextBossmanControlId('status'),
        targetParticipantIds: participantIds.length ? participantIds : undefined,
        prompt,
        reason: normalizeBossmanText(input.reason, 400) || undefined,
        status: 'open' as const,
        createdAt: nowIso,
        createdByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({
        ...state,
        statusRequests: capBossmanItems([...(state.statusRequests || []), request])
      }))
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} requested status${targetLabel ? ` from ${targetLabel}` : ''}: ${prompt}`
      )
      if (participantIds.length > 0) {
        this.routeBossmanTargets(
          runtime,
          participantIds,
          `${authorityLabel} routed status check-in${targetLabel ? ` to ${targetLabel}` : ''}.`,
          { allowAnsweredParticipant: true }
        )
      }
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: `${authorityLabel} requested status.`
      }
    }

    if (action === 'declare_decision') {
      const decision = normalizeBossmanText(input.decision || input.prompt, 1000)
      if (!decision)
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'declare_decision requires decision.'
        )
      const record = {
        id: this.nextBossmanControlId('decision'),
        decision,
        rationale: normalizeBossmanText(input.rationale || input.reason, 1000) || undefined,
        reopenCriteria: normalizeBossmanText(input.reopenCriteria, 800) || undefined,
        createdAt: nowIso,
        createdByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({
        ...state,
        decisions: capBossmanItems([...(state.decisions || []), record])
      }))
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} declared decision: ${decision}`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: `${authorityLabel} recorded a decision.`
      }
    }

    if (action === 'set_review_gate') {
      const reviewerId = input.targetParticipantId || participantIds[0]
      const reviewer = reviewerId ? this.findRuntimeParticipant(runtime, reviewerId) : null
      const scope = normalizeBossmanText(input.scope || input.prompt, 800)
      if (!reviewer || !scope)
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'set_review_gate requires targetParticipantId and scope.'
        )
      const gateChat = this.deps.getChat(runtime.chatId)
      const gate = {
        id: input.gateId || this.nextBossmanControlId('gate'),
        reviewerParticipantId: reviewer.id,
        scope,
        criteria: normalizeBossmanText(input.acceptanceCriteria, 1000) || undefined,
        status: input.reviewStatus || 'required',
        reason: normalizeBossmanText(input.reason, 500) || undefined,
        // C2 — bind the gate to the active goal so it can't block a later goal.
        goalId: gateChat?.activeGoal?.id,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({
        ...state,
        reviewGates: capBossmanItems([
          ...(state.reviewGates || []).filter((entry) => entry.id !== gate.id),
          gate
        ])
      }))
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} set review gate for ${participantDisplayName(reviewer)}: ${scope}`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        participantId: reviewer.id,
        message: `${authorityLabel} set a review gate.`
      }
    }

    if (action === 'quarantine_participant') {
      const participantId = input.targetParticipantId
      const participant = participantId ? this.findRuntimeParticipant(runtime, participantId) : null
      if (!participant)
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'quarantine_participant requires targetParticipantId.'
        )
      const reason = normalizeBossmanText(input.reason, 500)
      if (!input.clear && !reason)
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'quarantine_participant requires reason unless clear=true.'
        )
      const quarantine = {
        participantId: participant.id,
        roundId: runtime.roundId,
        category: input.category || 'other',
        scope: input.quarantineScope || 'round',
        reason: reason || 'Cleared by Boss/Captain.',
        active: input.clear !== true,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({
        ...state,
        quarantines: capBossmanItems([
          ...(state.quarantines || []).filter((entry) => entry.participantId !== participant.id),
          quarantine
        ])
      }))
      if (quarantine.active) {
        const remaining = runtime.remainingParticipants || []
        const index = remaining.findIndex((entry) => entry.id === participant.id)
        if (index >= 0) remaining.splice(index, 1)
        this.updateParticipantState(
          runtime.chatId,
          runtime.roundId,
          participant.id,
          'skipped',
          `Quarantined: ${quarantine.reason}`
        )
      }
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        quarantine.active
          ? `${authorityLabel} quarantined ${participantDisplayName(participant)} (${quarantine.category}): ${quarantine.reason}`
          : `${authorityLabel} cleared quarantine for ${participantDisplayName(participant)}.`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        participantId: participant.id,
        message: quarantine.active
          ? `${authorityLabel} quarantined ${participantDisplayName(participant)}.`
          : `${authorityLabel} cleared quarantine.`
      }
    }

    if (action === 'allocate_budget') {
      if (
        input.targetParticipantId &&
        !this.findRuntimeParticipant(runtime, input.targetParticipantId)
      ) {
        return this.invalidBossmanTarget(action, runtime.roundId)
      }
      const budget = {
        id: input.budgetId || this.nextBossmanControlId('budget'),
        participantId: input.targetParticipantId || undefined,
        phase: normalizeBossmanText(input.phase, 240) || undefined,
        maxExtraTurns: clampOptionalInteger(input.maxExtraTurns, 0, 50),
        maxFanoutCalls: clampOptionalInteger(input.maxFanoutCalls, 0, 50),
        maxDurationSeconds: clampOptionalInteger(input.maxDurationSeconds, 0, 7 * 24 * 60 * 60),
        maxTokens: clampOptionalInteger(input.maxTokens, 0, 10_000_000),
        reason: normalizeBossmanText(input.reason, 500) || undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdByParticipantId: callerId
      }
      if (
        budget.maxExtraTurns === undefined &&
        budget.maxFanoutCalls === undefined &&
        budget.maxDurationSeconds === undefined &&
        budget.maxTokens === undefined
      ) {
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'allocate_budget requires at least one max* budget field.'
        )
      }
      this.updateBossmanControlState(runtime, (state) => ({
        ...state,
        budgets: capBossmanItems([
          ...(state.budgets || []).filter((entry) => entry.id !== budget.id),
          budget
        ])
      }))
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} allocated budget${targetLabel ? ` for ${targetLabel}` : ''}.`
      )
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        participantId: budget.participantId,
        message: `${authorityLabel} allocated a bounded budget.`
      }
    }

    if (action === 'create_poll') {
      // 1.0.4-AN — binding goal-complete poll: minted deterministically from the
      // active goal (fixed options, forced user vote, quorum resolution). Advisory
      // polls (no `binding`) fall through to the unchanged path below.
      if (input.binding) {
        const bindingKind = normalizeBossmanText(input.binding.kind, 40)
        if (bindingKind !== 'goal_complete') {
          return this.missingBossmanField(
            action,
            runtime.roundId,
            "create_poll binding.kind must be 'goal_complete'."
          )
        }
        const activeGoal = this.deps.getChat(runtime.chatId)?.activeGoal
        if (!activeGoal || activeGoal.status !== 'active') {
          return {
            ok: false,
            tool: 'ensemble_bossman_control',
            action,
            roundId: runtime.roundId,
            message: 'create_poll binding requires an active goal.',
            error: 'no_active_goal'
          }
        }
        const openBlock = this.bindingPollOpenBlock(runtime)
        if (openBlock) {
          return {
            ok: false,
            tool: 'ensemble_bossman_control',
            action,
            roundId: runtime.roundId,
            message: openBlock,
            error: 'binding_poll_unavailable'
          }
        }
        return this.openBindingGoalCompletePoll(
          runtime,
          activeGoal.id,
          callerId,
          authorityLabel,
          input.timeoutSeconds,
          input.pollId
        )
      }
      const question = normalizeBossmanText(input.question || input.prompt, 800)
      const options = normalizeBossmanTextArray(input.options, MAX_BOSSMAN_POLL_OPTIONS, 160)
      if (!question || options.length < 2)
        return this.missingBossmanField(
          action,
          runtime.roundId,
          'create_poll requires question and at least two options.'
        )
      const timeoutSeconds = clampOptionalInteger(input.timeoutSeconds, 30, 24 * 60 * 60)
      const pollTargetIds = participantIds.length
        ? participantIds
        : (this.deps.getChat(runtime.chatId)?.ensemble?.participants || [])
            .filter(
              (participant) =>
                participant.enabled &&
                participant.id !== callerId &&
                !runtime.unreachableParticipantIds?.has(participant.id)
            )
            .map((participant) => participant.id)
      const poll = {
        id: input.pollId || this.nextBossmanControlId('poll'),
        question,
        options,
        targetParticipantIds: pollTargetIds.length ? pollTargetIds : undefined,
        includeUser: input.includeUser === true,
        timeoutAt: timeoutSeconds
          ? new Date(this.deps.now() + timeoutSeconds * 1000).toISOString()
          : undefined,
        status: 'open' as const,
        votes: [] as EnsembleBossmanPollVote[],
        createdAt: nowIso,
        createdByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({
        ...state,
        polls: capBossmanItems([
          ...(state.polls || []).filter((entry) => entry.id !== poll.id),
          poll
        ])
      }))
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} opened poll ${poll.id}: ${question} Options: ${options.join(' / ')}`
      )
      this.appendBossmanPollMessage(runtime, poll.id, question, options, authorityLabel)
      this.scheduleBossmanPollTimeout(runtime.chatId, poll.id, poll.timeoutAt)
      if (pollTargetIds.length > 0) {
        this.routeBossmanTargets(
          runtime,
          pollTargetIds,
          `${authorityLabel} routed poll ${poll.id} voters.`,
          { allowAnsweredParticipant: true }
        )
      }
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: `${authorityLabel} opened poll ${poll.id}.`
      }
    }

    return {
      ok: false,
      tool: 'ensemble_bossman_control',
      action,
      roundId: runtime.roundId,
      message: `ensemble_bossman_control: unsupported action "${action}".`,
      error: 'invalid_action'
    }
  }

  pollResponseForRun(
    runId: string | undefined,
    input: EnsemblePollResponseInput
  ): EnsemblePollResponseResult {
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        message: 'ensemble_poll_response requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        message: 'No active Ensemble participant run matches this poll response.',
        error: 'no_active_run'
      }
    }
    const runtime = this.roundsByChatId.get(run.chatId)
    if (!runtime || runtime.roundId !== run.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        message: 'No active Ensemble round is available for this poll response.',
        error: 'no_active_round'
      }
    }
    const pollId = normalizeBossmanText(input.pollId, 120)
    const choice = normalizeBossmanText(input.choice, 160)
    if (!pollId || !choice) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        message: 'ensemble_poll_response requires pollId and choice.',
        error: 'invalid_choice'
      }
    }
    let response: EnsemblePollResponseResult = {
      ok: false,
      tool: 'ensemble_poll_response',
      pollId,
      message: 'Poll response failed.',
      error: 'poll_not_found'
    }
    const nowIso = this.deps.nowIso()
    // A4-1: a late vote arriving past a BINDING poll's timeout must terminalize
    // it through resolveBindingPoll('timeout') below, not a plain 'expired' mark.
    let bindingPollTimedOut = false
    this.updateBossmanControlState(runtime, (state) => {
      const polls = state.polls || []
      const index = polls.findIndex((poll) => poll.id === pollId)
      if (index < 0) {
        response = {
          ok: false,
          tool: 'ensemble_poll_response',
          pollId,
          message: `Poll ${pollId} was not found.`,
          error: 'poll_not_found'
        }
        return state
      }
      const poll = polls[index]
      if (poll.status !== 'open') {
        response = {
          ok: false,
          tool: 'ensemble_poll_response',
          pollId,
          message: `Poll ${pollId} is ${poll.status}.`,
          error: 'poll_closed'
        }
        return state
      }
      if (poll.timeoutAt && new Date(poll.timeoutAt).getTime() <= this.deps.now()) {
        // A4-1: binding polls resolve via the atomic resolver on timeout (after
        // this transaction), never a plain 'expired' mark — leave state untouched.
        if (poll.binding) {
          bindingPollTimedOut = true
          response = {
            ok: false,
            tool: 'ensemble_poll_response',
            pollId,
            message: `Poll ${pollId} reached its timeout; resolving.`,
            error: 'poll_closed'
          }
          return state
        }
        const nextPoll = { ...poll, status: 'expired' as const }
        this.clearBossmanPollTimeout(runtime.chatId, pollId)
        response = {
          ok: false,
          tool: 'ensemble_poll_response',
          pollId,
          message: `Poll ${pollId} expired at ${poll.timeoutAt}.`,
          error: 'poll_closed'
        }
        return { ...state, polls: [...polls.slice(0, index), nextPoll, ...polls.slice(index + 1)] }
      }
      if (!poll.options.includes(choice)) {
        response = {
          ok: false,
          tool: 'ensemble_poll_response',
          pollId,
          message: `Poll ${pollId} choice must be one of: ${poll.options.join(', ')}.`,
          error: 'invalid_choice'
        }
        return state
      }
      if (
        poll.targetParticipantIds?.length &&
        !poll.targetParticipantIds.includes(run.participant.id)
      ) {
        response = {
          ok: false,
          tool: 'ensemble_poll_response',
          pollId,
          message: `Poll ${pollId} is not targeted to this participant.`,
          error: 'invalid_choice'
        }
        return state
      }
      const vote: EnsembleBossmanPollVote = {
        voterParticipantId: run.participant.id,
        voterLabel: participantDisplayName(run.participant),
        choice,
        rationale: normalizeBossmanText(input.rationale, 500) || undefined,
        votedAt: nowIso
      }
      const nextPoll = {
        ...poll,
        votes: [
          ...poll.votes.filter((entry) => entry.voterParticipantId !== run.participant.id),
          vote
        ]
      }
      const expectedVoters = poll.targetParticipantIds || []
      const hasAllTargetVotes =
        expectedVoters.length > 0 &&
        expectedVoters.every((participantId) =>
          nextPoll.votes.some((entry) => entry.voterParticipantId === participantId)
        )
      if (hasAllTargetVotes) this.clearBossmanPollTimeout(runtime.chatId, pollId)
      response = {
        ok: true,
        tool: 'ensemble_poll_response',
        pollId,
        message: `${participantDisplayName(run.participant)} voted "${choice}" in poll ${pollId}.`
      }
      return {
        ...state,
        polls: [
          ...polls.slice(0, index),
          // Binding polls are terminalized by resolveBindingPoll (veto/quorum/
          // floor), never the generic all-votes close — leave them open here.
          hasAllTargetVotes && !nextPoll.binding
            ? { ...nextPoll, status: 'closed' as const }
            : nextPoll,
          ...polls.slice(index + 1)
        ]
      }
    })
    if (response.ok) {
      this.appendRoundStatus(runtime.chatId, runtime.roundId, response.message)
      // Binding goal-complete polls terminalize through the atomic resolver
      // (advisory polls no-op inside it, so their behavior is unchanged).
      this.resolveBindingPoll(runtime.chatId, pollId, 'vote')
    } else if (bindingPollTimedOut) {
      // A4-1: a late vote hit the timeout — resolve the binding poll now.
      this.resolveBindingPoll(runtime.chatId, pollId, 'timeout')
    }
    return response
  }

  /**
   * 1.0.4-AN — peer path for the ensemble_propose_goal_complete MCP tool. ANY
   * eligible-at-open participant may open a binding goal-complete poll from their
   * own run — the failure mode this goal fixes (a finished panel deadlocked when
   * authority is unreachable to call goal_complete). The poll body is minted from
   * the active goal (caller cannot pass free-form options/question); run-gated
   * like pollResponseForRun; one-open + cooldown enforced via bindingPollOpenBlock;
   * opener must be an eligible voter. Abuse guard = quorum + authority veto, NOT
   * an opener gate (per design/orchestration-poll-semantics).
   */
  proposeGoalCompleteForRun(
    runId: string | undefined,
    input: { rationale?: string }
  ): EnsembleBossmanControlResult {
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_propose_goal_complete',
        message: 'ensemble_propose_goal_complete requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return {
        ok: false,
        tool: 'ensemble_propose_goal_complete',
        message: 'No active Ensemble participant run matches this proposal.',
        error: 'no_active_run'
      }
    }
    const runtime = this.roundsByChatId.get(run.chatId)
    if (!runtime || runtime.roundId !== run.roundId || runtime.cancelled) {
      return {
        ok: false,
        tool: 'ensemble_propose_goal_complete',
        roundId: runtime?.roundId,
        message: 'No active Ensemble round is available for this proposal.',
        error: 'no_active_round'
      }
    }
    const chat = this.deps.getChat(runtime.chatId)
    const activeGoal = chat?.activeGoal
    if (!chat?.ensemble || !activeGoal || activeGoal.status !== 'active') {
      return {
        ok: false,
        tool: 'ensemble_propose_goal_complete',
        roundId: runtime.roundId,
        message: 'ensemble_propose_goal_complete requires an active goal.',
        error: 'no_active_goal'
      }
    }
    // Opener must be an eligible-at-open voter (same predicate as the denominator).
    const eligibleIds = this.bindingPollEligibleParticipantIds(chat, runtime)
    if (!eligibleIds.includes(run.participant.id)) {
      return {
        ok: false,
        tool: 'ensemble_propose_goal_complete',
        roundId: runtime.roundId,
        message:
          'Only an eligible (enabled, non-background, reachable, non-quarantined) participant may propose goal completion.',
        error: 'not_eligible_voter'
      }
    }
    const openBlock = this.bindingPollOpenBlock(runtime)
    if (openBlock) {
      return {
        ok: false,
        tool: 'ensemble_propose_goal_complete',
        roundId: runtime.roundId,
        message: openBlock,
        error: 'binding_poll_unavailable'
      }
    }
    const rationale = normalizeBossmanText(input.rationale, 500)
    if (rationale) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${participantDisplayName(run.participant)} proposed goal completion: ${rationale}`
      )
    }
    // Papercut C0-A: tag the result as THIS tool, not the shared bossman-control
    // identity openBindingGoalCompletePoll returns (that helper is also the
    // authority create_poll path, where 'ensemble_bossman_control' is correct).
    return {
      ...this.openBindingGoalCompletePoll(
        runtime,
        activeGoal.id,
        run.participant.id,
        participantDisplayName(run.participant),
        undefined,
        undefined
      ),
      tool: 'ensemble_propose_goal_complete'
    }
  }

  userPollResponseForChat(
    chatId: string | undefined,
    input: EnsemblePollResponseInput
  ): EnsemblePollResponseResult {
    if (!chatId) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        message: 'ensemble_poll_response requires a chat id.',
        error: 'no_active_round'
      }
    }
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        message: 'No Ensemble chat matches this poll response.',
        error: 'not_ensemble'
      }
    }
    const pollId = normalizeBossmanText(input.pollId, 120)
    const choice = normalizeBossmanText(input.choice, 160)
    if (!pollId || !choice) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        message: 'ensemble_poll_response requires pollId and choice.',
        error: 'invalid_choice'
      }
    }
    const state = chat.ensemble.bossmanControlState || {}
    const polls = state.polls || []
    const index = polls.findIndex((poll) => poll.id === pollId)
    if (index < 0) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        pollId,
        message: `Poll ${pollId} was not found.`,
        error: 'poll_not_found'
      }
    }
    const poll = polls[index]
    if (!poll.includeUser) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        pollId,
        message: `Poll ${pollId} is not accepting a user vote.`,
        error: 'invalid_choice'
      }
    }
    if (poll.status !== 'open') {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        pollId,
        message: `Poll ${pollId} is ${poll.status}.`,
        error: 'poll_closed'
      }
    }
    if (poll.timeoutAt && new Date(poll.timeoutAt).getTime() <= this.deps.now()) {
      // A4-1: binding polls resolve via the atomic resolver on timeout, not a
      // plain 'expired' mark (the user vote never blocks/drives resolution).
      if (poll.binding) {
        this.resolveBindingPoll(chatId, pollId, 'timeout')
        return {
          ok: false,
          tool: 'ensemble_poll_response',
          pollId,
          message: `Poll ${pollId} reached its timeout; resolving.`,
          error: 'poll_closed'
        }
      }
      const nextPoll = { ...poll, status: 'expired' as const }
      this.clearBossmanPollTimeout(chatId, pollId)
      this.saveChatWithCheckpoint(
        {
          ...chat,
          ensemble: {
            ...chat.ensemble,
            bossmanControlState: {
              ...state,
              polls: [...polls.slice(0, index), nextPoll, ...polls.slice(index + 1)]
            },
            updatedAt: this.deps.nowIso()
          },
          updatedAt: this.deps.now()
        },
        'round-updated'
      )
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        pollId,
        message: `Poll ${pollId} expired at ${poll.timeoutAt}.`,
        error: 'poll_closed'
      }
    }
    if (!poll.options.includes(choice)) {
      return {
        ok: false,
        tool: 'ensemble_poll_response',
        pollId,
        message: `Poll ${pollId} choice must be one of: ${poll.options.join(', ')}.`,
        error: 'invalid_choice'
      }
    }
    const nowIso = this.deps.nowIso()
    const vote: EnsembleBossmanPollVote = {
      voterLabel: 'User',
      choice,
      rationale: normalizeBossmanText(input.rationale, 500) || undefined,
      votedAt: nowIso
    }
    const nextPoll = {
      ...poll,
      votes: [...poll.votes.filter((entry) => entry.voterLabel !== 'User'), vote]
    }
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          bossmanControlState: {
            ...state,
            polls: [...polls.slice(0, index), nextPoll, ...polls.slice(index + 1)]
          },
          updatedAt: nowIso
        },
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
    if (chat.ensemble.activeRound?.status === 'running') {
      this.appendRoundStatus(
        chatId,
        chat.ensemble.activeRound.roundId,
        `User voted "${choice}" in poll ${pollId}.`
      )
    }
    return {
      ok: true,
      tool: 'ensemble_poll_response',
      pollId,
      message: `User voted "${choice}" in poll ${pollId}.`
    }
  }

  /**
   * C2 P3 — reviewer-only verdict handler (action 'submit_review_verdict'). Owner-
   * gated (G5): ONLY the gate's own reviewer may submit. Non-upserting: an
   * unknown/absent gateId is rejected, never created. Field-locked to
   * verdict∈{passed,failed}. Atomic: ONE synchronous updateBossmanControlState RMW
   * sets the verdict and — because the completion block is DERIVED from gate.status
   * via ReviewGateScope (C2a) — clears the block in the SAME transaction (no separate
   * Boss reconcile; closes pain #2). Idempotent: a repeat identical verdict is a
   * no-op with no duplicate audit/status line. Boss override stays disjoint on
   * set_review_gate's authority create/upsert.
   *
   * NOTE: the strict no-extra-key payload check + read-only reachability live in the
   * shared exact-invocation classifier (isExactReviewerVerdictInvocation) at the
   * preflight/bridge boundaries (C2b-ii); this handler is the final owner-gate (C-8),
   * reached only after those pass — defense-in-depth (preflight relaxes the prompt,
   * dispatch still owner-gates).
   */
  private submitReviewVerdictForCaller(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    caller: ActiveParticipantRun,
    input: EnsembleBossmanControlInput
  ): EnsembleBossmanControlResult {
    const action = 'submit_review_verdict' as const
    const verdict = input.verdict
    if (verdict !== 'passed' && verdict !== 'failed') {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: "submit_review_verdict requires verdict 'passed' or 'failed'.",
        error: 'invalid_verdict'
      }
    }
    const gates = chat.ensemble?.bossmanControlState?.reviewGates || []
    const gate = input.gateId ? gates.find((entry) => entry.id === input.gateId) : undefined
    if (!gate) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: 'submit_review_verdict requires an existing gateId owned by the caller.',
        error: 'review_gate_not_found'
      }
    }
    if (!gate.reviewerParticipantId || gate.reviewerParticipantId !== caller.participant.id) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: "Only the review gate's own reviewer may submit a verdict for it.",
        error: 'not_gate_reviewer'
      }
    }
    if (gate.status === verdict) {
      // Idempotent: identical repeat ⇒ no mutation, no duplicate audit/status line.
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        participantId: gate.reviewerParticipantId,
        message: `Review gate is already ${verdict}.`
      }
    }
    const nowIso = this.deps.nowIso()
    this.updateBossmanControlState(runtime, (state) => ({
      ...state,
      reviewGates: (state.reviewGates || []).map((entry) =>
        entry.id === gate.id ? { ...entry, status: verdict, updatedAt: nowIso } : entry
      )
    }))
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${participantDisplayName(caller.participant)} submitted review verdict for gate ${gate.id}: ${verdict}.`
    )
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action,
      roundId: runtime.roundId,
      participantId: gate.reviewerParticipantId,
      message: `Review gate ${verdict} by its reviewer.`
    }
  }

  private updateBossmanControlState(
    runtime: ActiveRoundRuntime,
    update: (
      state: NonNullable<EnsembleConfig['bossmanControlState']>
    ) => NonNullable<EnsembleConfig['bossmanControlState']>
  ): void {
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) return
    const nextState = update({ ...(chat.ensemble.bossmanControlState || {}) })
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          bossmanControlState: nextState,
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
  }

  private appendBossmanPollMessage(
    runtime: ActiveRoundRuntime,
    pollId: string,
    question: string,
    options: string[],
    authorityLabel: string
  ): void {
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) return
    const messageId = `ensemble-poll-${runtime.roundId}-${pollId}`
    if (chat.messages.some((message) => message.id === messageId)) return
    const timestamp = this.deps.nowIso()
    const message: ChatMessage = {
      id: messageId,
      role: 'system',
      content: `${authorityLabel} opened a poll: ${question}`,
      timestamp,
      metadata: {
        kind: 'ensembleBossmanPoll',
        pollId,
        pollQuestion: question,
        pollOptions: options,
        ensembleRoundId: runtime.roundId
      }
    }
    this.saveChatWithCheckpoint(
      {
        ...chat,
        messages: [...chat.messages, message],
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
  }

  private scheduleBossmanPollTimeout(
    chatId: string,
    pollId: string,
    timeoutAt: string | undefined
  ): void {
    if (!timeoutAt) return
    const key = JSON.stringify([chatId, pollId])
    const existing = this.bossmanPollTimeoutsById.get(key)
    if (existing) clearTimeout(existing.handle)
    const dueMs = new Date(timeoutAt).getTime()
    if (!Number.isFinite(dueMs)) return
    const delayMs = Math.max(0, dueMs - this.deps.now())
    const handle = setTimeout(() => {
      this.bossmanPollTimeoutsById.delete(key)
      this.expireBossmanPoll(chatId, pollId, timeoutAt)
    }, delayMs)
    handle.unref?.()
    this.bossmanPollTimeoutsById.set(key, { chatId, pollId, handle })
  }

  private clearBossmanPollTimeout(chatId: string, pollId: string): void {
    const key = JSON.stringify([chatId, pollId])
    const existing = this.bossmanPollTimeoutsById.get(key)
    if (!existing) return
    clearTimeout(existing.handle)
    this.bossmanPollTimeoutsById.delete(key)
  }

  private expireBossmanPoll(chatId: string, pollId: string, timeoutAt: string): void {
    const chat = this.deps.getChat(chatId)
    const state = chat?.ensemble?.bossmanControlState
    const polls = state?.polls || []
    const index = polls.findIndex((poll) => poll.id === pollId)
    if (!chat?.ensemble || !state || index < 0) return
    const poll = polls[index]
    if (poll.status !== 'open' || poll.timeoutAt !== timeoutAt) return
    // Binding goal-complete polls terminalize through the atomic resolver
    // (quorum/floor/veto on votes cast), not a plain 'expired' mark.
    if (poll.binding) {
      this.resolveBindingPoll(chatId, pollId, 'timeout')
      return
    }
    const nextPoll = { ...poll, status: 'expired' as const }
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          bossmanControlState: {
            ...state,
            polls: [...polls.slice(0, index), nextPoll, ...polls.slice(index + 1)]
          },
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
    if (chat.ensemble.activeRound?.status === 'running') {
      this.appendRoundStatus(
        chatId,
        chat.ensemble.activeRound.roundId,
        `Poll ${pollId} expired after reaching its timeout.`
      )
    }
  }

  /**
   * 1.0.4-AN — participants eligible to vote on (and count toward the
   * denominator of) a binding goal-complete poll. Mirrors the
   * tryAutoContinueRound roster predicate so the quorum matches who can actually
   * take a turn: enabled, non-background, reachable, not quarantined.
   */
  private bindingPollEligibleParticipantIds(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime
  ): string[] {
    return (chat.ensemble?.participants || [])
      .filter(
        (participant) =>
          participant.enabled &&
          !isBackgroundParticipant(participant) &&
          !runtime.unreachableParticipantIds?.has(participant.id) &&
          !this.activeBossmanQuarantine(chat, runtime.roundId, participant.id)
      )
      .map((participant) => participant.id)
  }

  /**
   * Reason a new binding goal-complete poll cannot open right now (one is
   * already open, or a post-FAIL cooldown is still active), or null when it may.
   */
  private bindingPollOpenBlock(runtime: ActiveRoundRuntime): string | null {
    const state = this.deps.getChat(runtime.chatId)?.ensemble?.bossmanControlState
    if ((state?.polls || []).some((poll) => poll.binding && poll.status === 'open')) {
      return 'A binding goal-complete poll is already open.'
    }
    const cooldownUntil = state?.bindingPollCooldownUntil
    if (cooldownUntil && new Date(cooldownUntil).getTime() > this.deps.now()) {
      return `Binding goal-complete polls are on cooldown until ${cooldownUntil}.`
    }
    return null
  }

  /**
   * Open a binding goal-complete poll minted from the active goal: fixed
   * options, forced user vote, eligible-voter + stable-authority snapshot, and a
   * default 300s timeout. Shared by the authority create_poll path and the peer
   * ensemble_propose_goal_complete tool (M3).
   */
  private openBindingGoalCompletePoll(
    runtime: ActiveRoundRuntime,
    goalId: string,
    callerId: string,
    authorityLabel: string,
    timeoutSecondsInput: number | undefined,
    pollIdInput: string | undefined
  ): EnsembleBossmanControlResult {
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) return this.invalidBossmanTarget('create_poll', runtime.roundId)
    const nowIso = this.deps.nowIso()
    const eligibleIds = this.bindingPollEligibleParticipantIds(chat, runtime)
    const authorityVoterIds = [
      chat.ensemble.bossmanParticipantId,
      ...this.activeCaptainParticipantIds(chat, runtime)
    ].filter((id): id is string => Boolean(id))
    const timeoutSeconds =
      clampOptionalInteger(timeoutSecondsInput, 30, 24 * 60 * 60) ??
      BINDING_POLL_DEFAULT_TIMEOUT_SECONDS
    const question = `Binding goal-complete poll — complete the active goal "${
      chat.activeGoal?.objective || goalId
    }"? Vote 'complete' or 'keep-working'. PASS completes the goal; Boss/Captain 'keep-working' vetoes.`
    const options = [...BINDING_GOAL_COMPLETE_OPTIONS]
    const poll: EnsembleBossmanPoll = {
      id: pollIdInput || this.nextBossmanControlId('poll'),
      question,
      options,
      targetParticipantIds: eligibleIds.length ? eligibleIds : undefined,
      includeUser: true,
      timeoutAt: new Date(this.deps.now() + timeoutSeconds * 1000).toISOString(),
      status: 'open',
      votes: [],
      createdAt: nowIso,
      createdByParticipantId: callerId,
      binding: { kind: 'goal_complete', goalId },
      roundId: runtime.roundId,
      eligibleAtOpen: eligibleIds.length,
      authorityVoterIds
    }
    this.updateBossmanControlState(runtime, (state) => ({
      ...state,
      polls: capBossmanItems([...(state.polls || []).filter((entry) => entry.id !== poll.id), poll])
    }))
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${authorityLabel} opened BINDING goal-complete poll ${poll.id}: vote 'complete' or 'keep-working' via ensemble_poll_response; PASS completes the active goal; Boss/Captain 'keep-working' vetoes.`
    )
    this.appendBossmanPollMessage(runtime, poll.id, question, options, authorityLabel)
    this.scheduleBossmanPollTimeout(runtime.chatId, poll.id, poll.timeoutAt)
    if (eligibleIds.length > 0) {
      this.routeBossmanTargets(
        runtime,
        eligibleIds,
        `${authorityLabel} routed binding poll ${poll.id} voters.`,
        { allowAnsweredParticipant: true }
      )
    }
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'create_poll',
      roundId: runtime.roundId,
      message: `${authorityLabel} opened binding goal-complete poll ${poll.id}.`
    }
  }

  /**
   * 1.0.4-AN — the single atomic terminalizer for a binding goal-complete poll,
   * invoked after each participant vote and on timeout. Owns veto, quorum/floor,
   * user-vote counting, stale goal/round guards, and review-gate preservation. A
   * no-op if the poll is advisory, already resolved (double-resolution guard),
   * or not yet terminal (a non-final vote never blocks or early-closes).
   */
  private resolveBindingPoll(chatId: string, pollId: string, trigger: 'vote' | 'timeout'): void {
    const chat = this.deps.getChat(chatId)
    const state = chat?.ensemble?.bossmanControlState
    const polls = state?.polls || []
    const index = polls.findIndex((entry) => entry.id === pollId)
    if (!chat?.ensemble || !state || index < 0) return
    const poll = polls[index]
    if (!poll.binding || poll.status !== 'open') return

    const authorityIds = new Set(poll.authorityVoterIds || [])
    const participantVotes = poll.votes.filter((vote) => Boolean(vote.voterParticipantId))
    const userVote = poll.votes.find(
      (vote) => !vote.voterParticipantId && vote.voterLabel === 'User'
    )
    const vetoVote = participantVotes.find(
      (vote) =>
        authorityIds.has(vote.voterParticipantId as string) && vote.choice === 'keep-working'
    )
    const expectedVoters = poll.targetParticipantIds || []
    const hasAllTargetVotes =
      expectedVoters.length > 0 &&
      expectedVoters.every((id) => participantVotes.some((vote) => vote.voterParticipantId === id))

    // Terminal only on timeout, an authority veto, or every target having voted.
    if (trigger !== 'timeout' && !vetoVote && !hasAllTargetVotes) return

    const denominator = participantVotes.length + (userVote ? 1 : 0)
    const completeVotes =
      participantVotes.filter((vote) => vote.choice === 'complete').length +
      (userVote?.choice === 'complete' ? 1 : 0)
    const floor = Math.max(2, Math.floor((poll.eligibleAtOpen || 0) / 2) + 1)
    const quorumThreshold = Math.ceil((2 / 3) * denominator)

    const currentRoundId = chat.ensemble.activeRound?.roundId
    const activeGoal = chat.activeGoal
    const goalFresh =
      Boolean(activeGoal) &&
      activeGoal!.id === poll.binding.goalId &&
      activeGoal!.status === 'active' &&
      poll.roundId === currentRoundId
    const gateBlocks = this.activeBossmanReviewGateBlocks(chat)

    let resolution: EnsembleBossmanPollResolution
    if (vetoVote) resolution = 'vetoed'
    else if (!goalFresh) resolution = 'stale'
    else if (gateBlocks.length > 0) resolution = 'gate_blocked'
    else if (participantVotes.length < floor) resolution = 'failed_floor'
    else if (denominator === 0 || completeVotes < quorumThreshold) resolution = 'failed_quorum'
    else resolution = 'passed'

    this.clearBossmanPollTimeout(chatId, pollId)
    const nowIso = this.deps.nowIso()
    const resolvedPoll: EnsembleBossmanPoll = {
      ...poll,
      status: 'closed',
      bindingResolution: resolution
    }
    const nextPolls = [...polls.slice(0, index), resolvedPoll, ...polls.slice(index + 1)]
    // Cooldown throttles re-open after a real failure/veto/gate; NOT after a
    // 'stale' no-op (the goal changed — a fresh poll on the new goal is valid).
    const applyCooldown = resolution !== 'passed' && resolution !== 'stale'
    const nextBossmanState = {
      ...state,
      polls: nextPolls,
      ...(applyCooldown
        ? {
            bindingPollCooldownUntil: new Date(
              this.deps.now() + BINDING_POLL_COOLDOWN_MS
            ).toISOString()
          }
        : {})
    }

    if (resolution === 'passed') {
      const reason = `Goal completed by binding poll ${pollId} (${completeVotes}/${denominator} 'complete').`
      const nextGoal = updateActiveGoalLifecycle(activeGoal!, 'completed', reason, new Date(nowIso))
      this.saveChatWithCheckpoint(
        {
          ...chat,
          activeGoal: nextGoal,
          ensemble: {
            ...chat.ensemble,
            bossmanControlState: nextBossmanState,
            updatedAt: nowIso
          },
          updatedAt: this.deps.now()
        },
        'round-updated'
      )
    } else {
      this.saveChatWithCheckpoint(
        {
          ...chat,
          ensemble: {
            ...chat.ensemble,
            bossmanControlState: nextBossmanState,
            updatedAt: nowIso
          },
          updatedAt: this.deps.now()
        },
        'round-updated'
      )
    }

    const auditRoundId = currentRoundId || poll.roundId
    if (auditRoundId) {
      const detail =
        resolution === 'passed'
          ? `PASSED (${completeVotes}/${denominator} 'complete', participation ${participantVotes.length}/${
              poll.eligibleAtOpen ?? '?'
            } ≥ floor ${floor}). Active goal marked complete.`
          : resolution === 'vetoed'
            ? `vetoed by ${vetoVote?.voterLabel || 'Boss/Captain'} — goal stays active.`
            : resolution === 'stale'
              ? 'active goal changed or is no longer active — resolution no-op.'
              : resolution === 'gate_blocked'
                ? `blocked by review gate(s): ${gateBlocks.join('; ')} — goal stays active.`
                : resolution === 'failed_floor'
                  ? `below participation floor (${participantVotes.length}/${floor}) — goal stays active.`
                  : `quorum not met (${completeVotes}/${denominator} 'complete', need ≥${quorumThreshold}) — goal stays active.`
      // A2/A4 authority-reachability visibility (audit-first mitigation): record
      // how many stable Boss/Captain voters actually cast, and flag when authority
      // was unreachable at resolution (health-probe out — e.g. a quota wall), so a
      // PASS with zero authority input is auditable (completed goals stay
      // authority-reopenable via update_goal, so audit-first is proportionate).
      const authorityVotesCast = participantVotes.filter((vote) =>
        authorityIds.has(vote.voterParticipantId as string)
      ).length
      const resolveRuntime = this.roundsByChatId.get(chatId)
      const authorityUnreachable =
        authorityIds.size > 0 &&
        [...authorityIds].some((id) => resolveRuntime?.unreachableParticipantIds?.has(id))
      const authoritySuffix = ` Authority votes: ${authorityVotesCast}/${authorityIds.size}${
        authorityUnreachable ? ' (authority unreachable at resolution)' : ''
      }.`
      this.appendRoundStatus(
        chatId,
        auditRoundId,
        `Binding goal-complete poll ${pollId} ${detail}${authoritySuffix}`
      )
    }
  }

  private resolveBossmanTargetParticipantIds(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput
  ): string[] {
    const ids = [
      ...(input.targetParticipantId ? [input.targetParticipantId] : []),
      ...(input.participantIds || [])
    ]
    const seen = new Set<string>()
    return ids.filter((id) => {
      if (!id || seen.has(id)) return false
      seen.add(id)
      return Boolean(this.findRuntimeParticipant(runtime, id))
    })
  }

  private findRuntimeParticipant(
    runtime: ActiveRoundRuntime,
    participantId: string
  ): EnsembleParticipant | null {
    const chat = this.deps.getChat(runtime.chatId)
    return (
      chat?.ensemble?.participants.find((participant) => participant.id === participantId) || null
    )
  }

  private formatBossmanTargetLabels(runtime: ActiveRoundRuntime, participantIds: string[]): string {
    return participantIds
      .map((id) => this.findRuntimeParticipant(runtime, id))
      .filter((participant): participant is EnsembleParticipant => Boolean(participant))
      .map(participantDisplayName)
      .join(', ')
  }

  private activeBossmanQuarantine(
    chat: ChatRecord,
    roundId: string,
    participantId: string
  ): EnsembleBossmanQuarantine | null {
    const quarantines = chat.ensemble?.bossmanControlState?.quarantines || []
    for (let index = quarantines.length - 1; index >= 0; index -= 1) {
      const quarantine = quarantines[index]
      if (quarantine.participantId !== participantId || !quarantine.active) continue
      if (quarantine.scope === 'session') return quarantine
      if (quarantine.roundId === roundId) return quarantine
    }
    return null
  }

  private activeBossmanReviewGateBlocks(chat: ChatRecord): string[] {
    const gates = chat.ensemble?.bossmanControlState?.reviewGates || []
    // C2 — goal-scoped via the SHARED predicate (the same one index goal_complete
    // and EnsemblePrompt import — no re-inline). A gate for a different/older goal
    // never blocks the active goal, and its evidence stays on the board. The 3
    // callers of this method (incl. the binding-poll gate_blocked branch) inherit
    // the scoping for free ⇒ a superseded gate can never drive gate_blocked/cooldown.
    return gates
      .filter((gate) => gateBlocksActiveGoal(gate, chat.activeGoal))
      .map((gate) => `${gate.id}: ${gate.scope} [${gate.status}]`)
  }

  private bossmanBudgetBlock(
    runtime: ActiveRoundRuntime,
    participantId: string,
    kind: 'extra_turn' | 'fanout_call'
  ): string | null {
    const chat = this.deps.getChat(runtime.chatId)
    const budgets = chat?.ensemble?.bossmanControlState?.budgets || []
    for (const budget of budgets) {
      if (budget.participantId && budget.participantId !== participantId) continue
      if (kind === 'extra_turn' && budget.maxExtraTurns !== undefined) {
        const used = budget.extraTurnsUsed || 0
        if (used >= budget.maxExtraTurns) {
          return `extra-turn budget exhausted (${used}/${budget.maxExtraTurns})`
        }
      }
      if (kind === 'fanout_call' && budget.maxFanoutCalls !== undefined) {
        const used = budget.fanoutCallsUsed || 0
        if (used >= budget.maxFanoutCalls) {
          return `fan-out budget exhausted (${used}/${budget.maxFanoutCalls})`
        }
      }
      if (budget.maxDurationSeconds !== undefined) {
        const used = budget.durationSecondsUsed || 0
        if (used >= budget.maxDurationSeconds) {
          return `duration budget exhausted (${used}/${budget.maxDurationSeconds}s)`
        }
      }
      if (budget.maxTokens !== undefined) {
        const used = budget.tokensUsed || 0
        if (used >= budget.maxTokens) {
          return `token budget exhausted (${used}/${budget.maxTokens})`
        }
      }
    }
    return null
  }

  private incrementBossmanBudgetUsage(
    runtime: ActiveRoundRuntime,
    participantIds: string[],
    usage: { extraTurns?: number; fanoutCalls?: number; durationSeconds?: number; tokens?: number }
  ): void {
    if (!usage.extraTurns && !usage.fanoutCalls && !usage.durationSeconds && !usage.tokens) {
      return
    }
    if (participantIds.length === 0) return
    const targetIds = new Set(participantIds)
    const chat = this.deps.getChat(runtime.chatId)
    const activeBudgets = chat?.ensemble?.bossmanControlState?.budgets || []
    const hasRelevantBudget = activeBudgets.some(
      (budget) =>
        (!budget.participantId || targetIds.has(budget.participantId)) &&
        ((usage.extraTurns && budget.maxExtraTurns !== undefined) ||
          (usage.fanoutCalls && budget.maxFanoutCalls !== undefined) ||
          (usage.durationSeconds && budget.maxDurationSeconds !== undefined) ||
          (usage.tokens && budget.maxTokens !== undefined))
    )
    if (!hasRelevantBudget) return
    const updatedAt = this.deps.nowIso()
    this.updateBossmanControlState(runtime, (state) => {
      const budgets = state.budgets || []
      let changed = false
      const nextBudgets = budgets.map((budget): EnsembleBossmanBudget => {
        if (budget.participantId && !targetIds.has(budget.participantId)) return budget
        const next = { ...budget }
        let budgetChanged = false
        if (usage.extraTurns && budget.maxExtraTurns !== undefined) {
          next.extraTurnsUsed = (budget.extraTurnsUsed || 0) + usage.extraTurns
          budgetChanged = true
        }
        if (usage.fanoutCalls && budget.maxFanoutCalls !== undefined) {
          next.fanoutCallsUsed = (budget.fanoutCallsUsed || 0) + usage.fanoutCalls
          budgetChanged = true
        }
        if (usage.durationSeconds && budget.maxDurationSeconds !== undefined) {
          next.durationSecondsUsed = (budget.durationSecondsUsed || 0) + usage.durationSeconds
          budgetChanged = true
        }
        if (usage.tokens && budget.maxTokens !== undefined) {
          next.tokensUsed = (budget.tokensUsed || 0) + usage.tokens
          budgetChanged = true
        }
        if (budgetChanged) {
          next.updatedAt = updatedAt
          changed = true
        }
        return next
      })
      return changed ? { ...state, budgets: nextBudgets } : state
    })
  }

  private reconcileBossmanControlAfterRun(
    run: ActiveParticipantRun,
    status: EnsembleParticipantStatus
  ): void {
    if (status !== 'answered' && status !== 'yielded' && status !== 'skipped') return
    const runtime = this.roundsByChatId.get(run.chatId)
    if (!runtime || runtime.roundId !== run.roundId) return
    const chat = this.deps.getChat(run.chatId)
    const roundParticipants = chat?.ensemble?.activeRound?.participants || []
    const statusRequests = chat?.ensemble?.bossmanControlState?.statusRequests || []
    if (
      !statusRequests.some(
        (request) =>
          request.status === 'open' && request.targetParticipantIds?.includes(run.participant.id)
      )
    ) {
      return
    }
    this.updateBossmanControlState(runtime, (state) => {
      const requests = state.statusRequests || []
      let changed = false
      const nextRequests = requests.map((request) => {
        if (request.status !== 'open') return request
        const targets = request.targetParticipantIds || []
        if (targets.length === 0 || !targets.includes(run.participant.id)) return request
        const allTargetsSettled = targets.every((participantId) => {
          const participant = roundParticipants.find(
            (entry) => entry.participantId === participantId
          )
          return (
            participant?.status === 'answered' ||
            participant?.status === 'yielded' ||
            participant?.status === 'skipped' ||
            participant?.status === 'failed' ||
            participant?.status === 'cancelled' ||
            participant?.status === 'unreachable'
          )
        })
        if (!allTargetsSettled) return request
        changed = true
        return { ...request, status: 'closed' as const }
      })
      return changed ? { ...state, statusRequests: nextRequests } : state
    })
  }

  private routeBossmanTargets(
    runtime: ActiveRoundRuntime,
    participantIds: string[],
    statusMessage: string,
    options: { allowAnsweredParticipant?: boolean } = {}
  ): number {
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble || participantIds.length === 0) return 0
    const remaining = runtime.remainingParticipants ?? (runtime.remainingParticipants = [])
    const routed: EnsembleParticipant[] = []
    const seen = new Set<string>()
    for (const participantId of participantIds) {
      if (seen.has(participantId)) continue
      seen.add(participantId)
      const participant = chat.ensemble.participants.find(
        (entry) => entry.id === participantId && entry.enabled
      )
      if (!participant) continue
      if (runtime.unreachableParticipantIds?.has(participant.id)) continue
      if (this.activeBossmanQuarantine(chat, runtime.roundId, participant.id)) continue
      if (this.participantFanoutDispatchState(runtime, participant.id)) continue
      const pendingIndex = remaining.findIndex((entry) => entry.id === participant.id)
      if (pendingIndex >= 0) {
        const [pending] = remaining.splice(pendingIndex, 1)
        routed.push(pending)
        continue
      }
      const status = this.activeRoundParticipantStatus(runtime, participant.id)
      if (status === 'idle') {
        routed.push(participant)
        continue
      }
      if (options.allowAnsweredParticipant) {
        const continuation = this.tryAppendContinuationTurn(
          runtime,
          remaining,
          participant,
          statusMessage,
          { allowAnsweredParticipant: true, allowYieldedParticipant: true }
        )
        if (continuation.appended) continue
      }
    }
    for (let index = routed.length - 1; index >= 0; index -= 1) {
      remaining.unshift(routed[index])
    }
    if (routed.length > 0) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${statusMessage} Routed next: ${routed.map(participantDisplayName).join(', ')}.`
      )
    }
    return routed.length
  }

  private nextBossmanControlId(prefix: string): string {
    return `${prefix}-${this.deps.now()}-${Math.random().toString(36).slice(2)}`
  }

  private missingBossmanField(
    action: EnsembleBossmanControlAction,
    roundId: string,
    message: string
  ): EnsembleBossmanControlResult {
    return {
      ok: false,
      tool: 'ensemble_bossman_control',
      action,
      roundId,
      message,
      error: 'missing_required_field'
    }
  }

  private invalidBossmanTarget(
    action: EnsembleBossmanControlAction,
    roundId: string
  ): EnsembleBossmanControlResult {
    return {
      ok: false,
      tool: 'ensemble_bossman_control',
      action,
      roundId,
      message: 'Boss control rejected: target participant is not available.',
      error: 'invalid_target'
    }
  }

  private reorderRemainingByBossman(
    runtime: ActiveRoundRuntime,
    participantIds: string[]
  ): EnsembleBossmanControlResult {
    const remaining = runtime.remainingParticipants || []
    const remainingIds = new Set(remaining.map((participant) => participant.id))
    if (participantIds.length === 0 || participantIds.some((id) => !remainingIds.has(id))) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'reorder_remaining',
        roundId: runtime.roundId,
        message: 'Boss reorder rejected: participantIds must name pending participants.',
        error: 'stale_target'
      }
    }
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'reorder_remaining',
        roundId: runtime.roundId,
        message: 'Boss reorder rejected: active chat is no longer an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const completedCount = chat.ensemble.bossmanControlState?.completedRoundCount || 0
    const lastReorderAt = chat.ensemble.bossmanControlState?.lastReorderAtCompletedRound
    if (lastReorderAt !== undefined && completedCount - lastReorderAt < 2) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'reorder_remaining',
        roundId: runtime.roundId,
        message:
          'Boss reorder rejected: turn order can change once every two completed Ensemble rounds.',
        error: 'reorder_cooldown'
      }
    }

    const requested = participantIds
      .map((id) => remaining.find((participant) => participant.id === id))
      .filter((participant): participant is EnsembleParticipant => Boolean(participant))
    const requestedSet = new Set(participantIds)
    const nextRemaining = [
      ...requested,
      ...remaining.filter((participant) => !requestedSet.has(participant.id))
    ]
    remaining.length = 0
    remaining.push(...nextRemaining)

    const remainingSet = new Set(nextRemaining.map((participant) => participant.id))
    const slotOrder = [...chat.ensemble.participants].sort((a, b) => a.order - b.order)
    let cursor = 0
    const reorderedSlots = slotOrder.map((participant) => {
      if (!remainingSet.has(participant.id)) return participant
      const next = nextRemaining[cursor]
      cursor += 1
      return next || participant
    })
    const orderById = new Map(
      reorderedSlots.map((participant, index) => [participant.id, index + 1])
    )
    const nextParticipants = chat.ensemble.participants.map((participant) => ({
      ...participant,
      order: orderById.get(participant.id) || participant.order
    }))
    const activeRound =
      chat.ensemble.activeRound?.roundId === runtime.roundId
        ? {
            ...chat.ensemble.activeRound,
            participants: chat.ensemble.activeRound.participants.map((participant) => ({
              ...participant,
              order: orderById.get(participant.participantId) || participant.order
            }))
          }
        : chat.ensemble.activeRound
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          participants: nextParticipants,
          activeRound,
          bossmanControlState: {
            ...(chat.ensemble.bossmanControlState || {}),
            completedRoundCount: completedCount,
            lastReorderAtCompletedRound: completedCount
          },
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'participant-updated'
    )
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      'Boss changed the remaining turn order.'
    )
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'reorder_remaining',
      roundId: runtime.roundId,
      message: 'Boss changed the remaining turn order.'
    }
  }

  private async replaceParticipantByBossman(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput,
    targetRun?: ActiveParticipantRun
  ): Promise<EnsembleBossmanControlResult> {
    const targetParticipantId = input.targetParticipantId || targetRun?.participant.id
    const provider = input.replacement?.provider
    if (!targetParticipantId || !provider) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        message: 'Boss replace_participant requires targetParticipantId and replacement.provider.',
        error: 'missing_replacement'
      }
    }
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        message: 'Boss replacement rejected: active chat is no longer an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const target = chat.ensemble.participants.find(
      (participant) => participant.id === targetParticipantId
    )
    if (!target) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: 'Boss replacement rejected: target participant is not in the roster.',
        error: 'stale_target'
      }
    }
    if (!this.deps.probeParticipant) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        message: 'Boss replacement rejected: provider health checks are unavailable.',
        error: 'health_check_unavailable'
      }
    }
    // A replacement is a MODEL/PROVIDER swap on ONE seat, not a permission edit.
    // The old check here only rejected full_access and custom, so `default`
    // sailed straight through: a Boss could replace a read_only reviewer with a
    // `default` one and hand the seat write access in the same call. That is a
    // widening, and it contradicts what the authority checkpoint tells the model
    // replace_participant does.
    //
    // The seat's posture is therefore INHERITED, always — preset AND overrides.
    // An explicit value is accepted only when it restates what the seat already
    // has, because the schema advertises the field and a model that faithfully
    // echoes the current preset should not be punished for it. Anything else is
    // refused rather than quietly ignored, so the Boss reads the rule instead of
    // receiving a seat it did not ask for.
    //
    // NARROWING IS REFUSED TOO. It is safe in isolation, but permitting it
    // would mean this path decides permission questions, and then "a swap never
    // moves permissions" stops being checkable by reading one function.
    // `ensemble_roster_edit` → edit_participant is the audited door for changing
    // what a seat may do; keeping it the ONLY door is the whole property.
    const requestedPermissionPresetId = input.replacement?.permissionPresetId
    const inheritedPermissionPresetId = target.permissionPresetId
    // Two conditions, not one. Equality alone would let a Boss NAME a preset
    // outside the assignable set whenever the seat already sat there — harmless
    // in effect, since the value is inherited either way, but it would put
    // `full_access` in the audit trail as something a model asked for. The
    // ceiling stays; equality is layered on top of it.
    const restatesInheritedPreset =
      requestedPermissionPresetId === inheritedPermissionPresetId &&
      ASSIGNABLE_PERMISSION_PRESET_SET.has(String(requestedPermissionPresetId))
    if (requestedPermissionPresetId !== undefined && !restatesInheritedPreset) {
      const restatable =
        inheritedPermissionPresetId &&
        ASSIGNABLE_PERMISSION_PRESET_SET.has(String(inheritedPermissionPresetId))
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: `Boss replacement rejected: a replacement keeps the seat's permissions unchanged, so replacement.permissionPresetId must be omitted${
          restatable ? ` or set to "${inheritedPermissionPresetId}"` : ''
        }. Use ensemble_roster_edit → edit_participant to change what a seat may do.`,
        error: 'permission_ceiling'
      }
    }
    // Not advertised in the tool schema, but the input type is a
    // Partial<EnsembleParticipant> and JSON Schema admits unlisted properties,
    // so a caller can supply this. It has always been dropped on the floor;
    // refusing it says so out loud rather than leaving the safety resting on an
    // omission somebody could "fix" later by wiring the field through.
    if (input.replacement?.permissionOverrides !== undefined) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message:
          "Boss replacement rejected: a replacement keeps the seat's permissions unchanged, so replacement.permissionOverrides is not accepted. Use ensemble_roster_edit → edit_participant to change what a seat may do.",
        error: 'permission_ceiling'
      }
    }
    const replacementId = this.nextReplacementParticipantId(chat.ensemble.participants)
    const replacement: EnsembleParticipant = {
      id: replacementId,
      provider,
      enabled: true,
      role: input.replacement?.role || providerLabel(provider),
      instructions:
        input.replacement?.instructions !== undefined
          ? input.replacement.instructions
          : target.instructions,
      order: target.order,
      ...(input.replacement?.model ? { model: input.replacement.model } : {}),
      // Inherited, never requested — see the refusal above. Overrides ride along
      // for the same reason: a target carrying a NARROWING override that the
      // replacement dropped would be widened by omission just as surely as by a
      // wider preset.
      ...(inheritedPermissionPresetId ? { permissionPresetId: inheritedPermissionPresetId } : {}),
      ...(target.permissionOverrides ? { permissionOverrides: target.permissionOverrides } : {}),
      ...(input.replacement?.reasoningEffort
        ? { reasoningEffort: input.replacement.reasoningEffort }
        : {}),
      ...(typeof input.replacement?.fastModeEnabled === 'boolean'
        ? { fastModeEnabled: input.replacement.fastModeEnabled }
        : {}),
      ...(typeof input.replacement?.thinkingEnabled === 'boolean'
        ? { thinkingEnabled: input.replacement.thinkingEnabled }
        : {}),
      linkedProviderSessionId: null
    }
    const health = await this.deps.probeParticipant(replacement)
    if (!health.reachable) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: `Boss replacement rejected: ${health.reason || `${provider} is not reachable`}.`,
        error: 'replacement_unreachable'
      }
    }

    // Re-read after the async health probe: a concurrent roster edit may have
    // landed while we awaited. A replacement is strictly 1:1 — if the roster
    // grew past the round's baseline participant count in the meantime,
    // swapping in the replacement would PERSIST a round larger than its
    // baseline. Adding a participant beyond the baseline is gated behind
    // explicit user approval, not something the Boss tool may grant, so we
    // refuse rather than grow the round.
    const postProbeParticipants = this.deps.getChat(runtime.chatId)?.ensemble?.participants || []
    const baselineCount =
      runtime.bossmanBaselineParticipantCount ??
      runtime.bossmanBaselineParticipantIds?.length ??
      postProbeParticipants.length
    const targetStillPresent = postProbeParticipants.some(
      (participant) => participant.id === targetParticipantId
    )
    const prospectiveParticipantCount =
      postProbeParticipants.length - (targetStillPresent ? 1 : 0) + 1
    if (prospectiveParticipantCount > baselineCount) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message:
          'Boss replacement rejected: the roster changed during the health check and the replacement would add a participant beyond the round baseline. Adding beyond the baseline requires explicit user approval.',
        error: 'baseline_exceeded'
      }
    }

    const remaining = runtime.remainingParticipants || []
    const pendingIndex = remaining.findIndex(
      (participant) => participant.id === targetParticipantId
    )
    const isActive =
      targetRun ||
      (runtime.activeRunId &&
        this.runsByRunId.get(runtime.activeRunId)?.participant.id === targetParticipantId)
    if (pendingIndex < 0 && !isActive) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message: 'Boss replacement rejected: target participant is no longer active or pending.',
        error: 'stale_target'
      }
    }
    if (pendingIndex >= 0) {
      remaining.splice(pendingIndex, 1, replacement)
    } else {
      const activeRun =
        targetRun || (runtime.activeRunId ? this.runsByRunId.get(runtime.activeRunId) : undefined)
      if (activeRun) {
        activeRun.fanoutDispatchCancelled = true
        this.finalizeRun(activeRun, 'skipped', input.reason || 'Replaced by Boss.')
        if (runtime.activeRunId === activeRun.runId) runtime.activeRunId = undefined
        runtime.activeScoutRunIds?.delete(activeRun.runId)
        void this.deps
          .cancelRun(activeRun.participant.provider, activeRun.runId)
          .catch(() => undefined)
      }
      remaining.unshift(replacement)
    }

    const latestChat = this.deps.getChat(runtime.chatId) || chat
    const latestEnsemble = latestChat.ensemble || chat.ensemble
    const replaceReason = input.reason || 'Replaced by Boss.'
    const nextParticipants = latestEnsemble.participants
      .filter((participant) => participant.id !== targetParticipantId)
      .concat(replacement)
      .sort((a, b) => a.order - b.order)
      .map((participant, index) => ({ ...participant, order: index + 1 }))
    const nextBossmanParticipantId =
      latestEnsemble.bossmanParticipantId === targetParticipantId
        ? replacement.id
        : latestEnsemble.bossmanParticipantId
    const currentCaptainParticipantIds = configuredEnsembleCaptainParticipantIds({
      participants: latestEnsemble.participants,
      bossmanParticipantId: latestEnsemble.bossmanParticipantId,
      captainParticipantIds: latestEnsemble.captainParticipantIds,
      secondInCommandParticipantId: latestEnsemble.secondInCommandParticipantId
    })
    const nextCaptainParticipantIds = configuredEnsembleCaptainParticipantIds({
      participants: nextParticipants,
      bossmanParticipantId: nextBossmanParticipantId,
      captainParticipantIds: currentCaptainParticipantIds.map((participantId) =>
        participantId === targetParticipantId ? replacement.id : participantId
      )
    })
    const replacementOrder =
      nextParticipants.find((participant) => participant.id === replacement.id)?.order ||
      replacement.order
    const activeRound =
      latestEnsemble.activeRound?.roundId === runtime.roundId
        ? {
            ...latestEnsemble.activeRound,
            bossmanParticipantId:
              latestEnsemble.activeRound.bossmanParticipantId === targetParticipantId
                ? replacement.id
                : latestEnsemble.activeRound.bossmanParticipantId,
            captainParticipantIds: nextCaptainParticipantIds,
            secondInCommandParticipantId: nextCaptainParticipantIds[0],
            participants: [
              ...latestEnsemble.activeRound.participants.map((participant) =>
                participant.participantId === targetParticipantId && pendingIndex >= 0
                  ? {
                      ...participant,
                      status: 'skipped' as const,
                      reason: replaceReason,
                      endedAt: this.deps.nowIso()
                    }
                  : participant
              ),
              {
                participantId: replacement.id,
                provider: replacement.provider,
                role: replacement.role,
                order: replacementOrder,
                status: 'idle' as const
              }
            ].map((participant) => ({
              ...participant,
              order:
                nextParticipants.find((configured) => configured.id === participant.participantId)
                  ?.order || participant.order
            }))
          }
        : chat.ensemble.activeRound
    this.saveChatWithCheckpoint(
      {
        ...latestChat,
        ensemble: {
          ...latestEnsemble,
          participants: nextParticipants,
          activeRound,
          bossmanParticipantId: nextBossmanParticipantId,
          captainParticipantIds: nextCaptainParticipantIds,
          secondInCommandParticipantId: nextCaptainParticipantIds[0],
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'participant-updated'
    )
    if (runtime.bossmanParticipantId === targetParticipantId) {
      runtime.bossmanParticipantId = replacement.id
    }
    runtime.captainParticipantIds = nextCaptainParticipantIds
    runtime.secondInCommandParticipantId = nextCaptainParticipantIds[0]
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `Boss replaced ${target.role || target.provider} with ${replacement.role || replacement.provider}.`
    )
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'replace_participant',
      roundId: runtime.roundId,
      participantId: replacement.id,
      message: `Boss replaced ${target.role || target.provider} with ${replacement.role || replacement.provider}.`
    }
  }

  private nextReplacementParticipantId(participants: EnsembleParticipant[]): string {
    const existing = new Set(participants.map((participant) => participant.id))
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = `bossman-replacement-${Date.now().toString(36)}-${attempt}`
      if (!existing.has(id)) return id
    }
    return `bossman-replacement-${Math.random().toString(36).slice(2, 10)}`
  }

  /**
   * Dispatch waves in this chat's round that still have a lane in flight.
   *
   * Joins the DURABLE lane statuses (the same `activeRound.lanes` record
   * `ensemble_await` polls) to the wave identity carried on the live runs.
   * Runs leave `runsByRunId` at finalization, but a run that is gone had a lane
   * that went terminal, and terminal lanes do not count — so the join only ever
   * has to cover lanes that are still open, which is exactly the set whose runs
   * are still registered.
   */
  private openFanoutWavesForChat(chatId: string): OpenFanoutWave[] {
    const lanes = this.deps.getChat(chatId)?.ensemble?.activeRound?.lanes
    if (!lanes) return []
    const waveByLaneId = new Map<string, { waveId?: string; label?: string }>()
    for (const candidate of this.runsByRunId.values()) {
      if (candidate.chatId !== chatId || !candidate.laneId) continue
      waveByLaneId.set(candidate.laneId, {
        waveId: candidate.fanoutWaveId,
        label: candidate.fanoutLabel
      })
    }
    return openFanoutWaves(
      Object.values(lanes).map((lane) => ({
        laneId: lane.laneId,
        status: lane.status,
        ...waveByLaneId.get(lane.laneId)
      }))
    )
  }

  async fanoutForRun(
    runId: string | undefined,
    input: EnsembleFanoutInput
  ): Promise<EnsembleFanoutResult> {
    const owner = this.actionableRunForTool(runId)
    if (!owner) return this.fanoutForRunExclusive(runId, input)

    const previous = owner.fanoutDispatchQueue || Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    owner.fanoutDispatchQueue = tail
    owner.pendingFanoutDispatches ??= new Set()
    owner.pendingFanoutDispatches.add(current)
    await previous.catch(() => undefined)
    try {
      return await this.fanoutForRunExclusive(runId, input)
    } finally {
      releaseCurrent()
      owner.pendingFanoutDispatches?.delete(current)
      if (owner.pendingFanoutDispatches?.size === 0) {
        owner.pendingFanoutDispatches = undefined
      }
      if (owner.fanoutDispatchQueue === tail) owner.fanoutDispatchQueue = undefined
      this.releaseOwnedFanoutHold(owner)
    }
  }

  /**
   * `ensemble_await` — the JOIN primitive for agent-programmed graphs.
   * Blocks (bounded) until the named lanes reach a terminal status, polling
   * the DURABLE lane records rather than riding in-memory settlement
   * promises: per-pass settlements cannot express per-lane granularity, a
   * timeout race must never detach their cleanup chain, and a Boss awaiting
   * lanes it did not dispatch has no owned settlement to ride. Polling the
   * persisted round state covers all three and survives orchestrator
   * restarts of in-memory bookkeeping.
   *
   * The MCP broker grants ensemble_await a long-poll budget, so the timeout clamps
   * to 600s (default 180) and expiry returns PARTIAL per-lane status (never an
   * error) — the
   * caller re-invokes to keep waiting. Deliberately NOT serialized through
   * the owner's fanoutDispatchQueue: a wait queued behind its own pending
   * dispatch would deadlock.
   */
  async awaitLanesForRun(
    runId: string | undefined,
    input: EnsembleAwaitInput
  ): Promise<EnsembleAwaitResult> {
    const invalid = (
      error: NonNullable<EnsembleAwaitResult['error']>,
      message: string
    ): EnsembleAwaitResult => ({ ok: false, tool: 'ensemble_await', message, error })
    if (!runId) {
      return invalid('no_active_run', 'ensemble_await requires an active Ensemble participant run.')
    }
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return invalid(
        'no_active_run',
        'ensemble_await: no active Ensemble participant run matches this tool call.'
      )
    }
    const runtime = this.roundsByChatId.get(run.chatId)
    if (!runtime || !this.deps.getChat(run.chatId)?.ensemble) {
      return invalid('not_ensemble', 'ensemble_await: the active chat is not an Ensemble round.')
    }
    const requestedLaneIds = normalizeLaneIdList(input.laneIds)
    if (requestedLaneIds === null) {
      return invalid('invalid_lane', 'ensemble_await: laneIds must be an array of lane id strings.')
    }
    if (run.laneId && requestedLaneIds?.includes(run.laneId)) {
      return invalid(
        'self_await',
        'ensemble_await: a lane cannot await itself — it would block until its own timeout.'
      )
    }

    const laneSnapshot = (): Map<string, ConcurrentLane> => {
      const lanes = this.deps.getChat(run.chatId)?.ensemble?.activeRound?.lanes || {}
      return new Map(Object.entries(lanes))
    }
    const initial = laneSnapshot()
    let awaitedIds: string[]
    if (requestedLaneIds) {
      const unknown = requestedLaneIds.filter((laneId) => !initial.has(laneId))
      if (unknown.length > 0) {
        return invalid(
          'invalid_lane',
          `ensemble_await: unknown lane id(s) in this round: ${unknown.join(', ')}.`
        )
      }
      awaitedIds = requestedLaneIds
    } else {
      awaitedIds = [...initial.keys()].filter((laneId) => laneId !== run.laneId)
    }
    if (awaitedIds.length === 0) {
      return invalid(
        'no_lanes',
        'ensemble_await: this round has no fan-out lanes to await. Dispatch lanes with ensemble_fanout first.'
      )
    }

    const timeoutSeconds = clampAwaitTimeoutSeconds(input.timeoutSeconds)
    const deadline = this.deps.now() + timeoutSeconds * 1_000
    let lanes = laneSnapshot()
    const report = (): EnsembleAwaitLaneStatus[] =>
      awaitedIds.map((laneId) => {
        const lane = lanes.get(laneId)
        return {
          laneId,
          participantId: lane?.participantId || '',
          provider: (lane?.provider || 'claude') as ProviderId,
          status: lane?.status || 'unknown',
          settled: lane ? isTerminalLaneStatus(lane.status) : false
        }
      })
    const allSettled = (): boolean =>
      awaitedIds.every((laneId) => {
        const lane = lanes.get(laneId)
        return Boolean(lane && isTerminalLaneStatus(lane.status))
      })

    while (!allSettled() && this.deps.now() < deadline && !runtime.cancelled) {
      await delayMs(ENSEMBLE_AWAIT_POLL_INTERVAL_MS)
      lanes = laneSnapshot()
    }
    const statuses = report()
    const settledCount = statuses.filter((lane) => lane.settled).length
    const pendingCount = statuses.length - settledCount
    const settled = pendingCount === 0
    return {
      ok: true,
      tool: 'ensemble_await',
      status: settled ? 'settled' : 'timeout',
      message: settled
        ? `All ${statuses.length} awaited lane(s) settled. Read outputs with ensemble_lane_result.`
        : `${settledCount}/${statuses.length} lane(s) settled within ${timeoutSeconds}s${
            runtime.cancelled ? ' (round cancelled)' : ''
          }. Re-invoke ensemble_await to keep waiting, or proceed with the settled lanes.`,
      lanes: statuses,
      settledCount,
      pendingCount
    }
  }

  /**
   * `ensemble_lane_result` — structured read of one lane's transcript output
   * (the READ primitive paired with ensemble_await's JOIN). Reads the DURABLE
   * chat messages keyed by ensembleLaneId — in-memory run objects are dropped
   * at finalization, but flushRun persists lane content as
   * kind==='ensembleParticipant' messages that outlive the round.
   */
  laneResultForRun(
    runId: string | undefined,
    input: EnsembleLaneResultInput
  ): EnsembleLaneResultResult {
    const invalid = (
      error: NonNullable<EnsembleLaneResultResult['error']>,
      message: string
    ): EnsembleLaneResultResult => ({ ok: false, tool: 'ensemble_lane_result', message, error })
    if (!runId) {
      return invalid(
        'no_active_run',
        'ensemble_lane_result requires an active Ensemble participant run.'
      )
    }
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return invalid(
        'no_active_run',
        'ensemble_lane_result: no active Ensemble participant run matches this tool call.'
      )
    }
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) {
      return invalid(
        'not_ensemble',
        'ensemble_lane_result: the active chat is not an Ensemble round.'
      )
    }
    const laneId = typeof input.laneId === 'string' ? input.laneId.trim() : ''
    if (!laneId) {
      return invalid('missing_lane_id', 'ensemble_lane_result: laneId is required.')
    }

    const lane = chat.ensemble.activeRound?.lanes?.[laneId]
    const laneMessages = (chat.messages || []).filter((message) => {
      if (message.role !== 'assistant') return false
      const metadata = message.metadata as
        | { kind?: unknown; ensembleLaneId?: unknown; ensembleTimelineIndex?: unknown }
        | undefined
      return metadata?.kind === 'ensembleParticipant' && metadata.ensembleLaneId === laneId
    })
    if (!lane && laneMessages.length === 0) {
      return invalid(
        'invalid_lane',
        `ensemble_lane_result: no lane "${laneId}" in this chat. Lane ids come from ensemble_fanout results.`
      )
    }

    const ordered = [...laneMessages].sort((a, b) => {
      const indexOf = (message: (typeof laneMessages)[number]): number => {
        const raw = (message.metadata as { ensembleTimelineIndex?: unknown } | undefined)
          ?.ensembleTimelineIndex
        return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
      }
      return indexOf(a) - indexOf(b)
    })
    const fullContent = ordered
      .map((message) => (typeof message.content === 'string' ? message.content : ''))
      .filter(Boolean)
      .join('\n\n')
    const maxChars = clampLaneResultMaxChars(input.maxChars)
    // Keep the TAIL on truncation — a lane's final answer outranks its
    // early narration.
    const truncated = fullContent.length > maxChars
    const content = truncated ? fullContent.slice(fullContent.length - maxChars) : fullContent
    const settled = lane ? isTerminalLaneStatus(lane.status) : true
    const laneRun = (chat.runs || []).find((candidate) => candidate.ensembleLaneId === laneId)
    return {
      ok: true,
      tool: 'ensemble_lane_result',
      message: settled
        ? content
          ? `Lane ${laneId} settled with ${fullContent.length} char(s) of output.`
          : `Lane ${laneId} settled without transcript output — its work may live in files or (if isolated) its worktree candidate.`
        : `Lane ${laneId} is still ${lane?.status || 'running'}; content below is a partial live read.`,
      laneId,
      participantId: lane?.participantId || laneRun?.ensembleParticipantId || '',
      ...(lane?.provider || laneRun?.provider
        ? { provider: (lane?.provider || laneRun?.provider) as ProviderId }
        : {}),
      laneStatus: lane?.status || 'archived',
      settled,
      content,
      contentChars: fullContent.length,
      truncated
    }
  }

  /**
   * Receipt note when a per-call isolation override lost to a user-pinned
   * chat Isolate setting. The dispatch itself proceeds under the pinned
   * regime (runParallelFanoutPass owns the clamp); this note teaches the
   * calling seat instead of silently ignoring its parameter.
   */
  private ignoredIsolationOverrideNote(
    chat: ChatRecord,
    isolation: EnsembleFanoutIsolation | undefined
  ): string {
    if (isolation === undefined) return ''
    const policy = resolveEnsembleFanoutIsolationPolicy(chat.ensemble?.fanoutIsolation)
    if (policy === 'any' || isolation === policy) return ''
    const pinned =
      policy === 'worktree' ? 'write lanes into isolated worktrees' : 'lanes to the shared checkout'
    return ` Requested isolation=${isolation} was ignored — this chat's Isolate setting pins ${pinned} (set Isolate to Any to let agents choose).`
  }

  private async fanoutForRunExclusive(
    runId: string | undefined,
    input: EnsembleFanoutInput
  ): Promise<EnsembleFanoutResult> {
    const mode = normalizeFanoutMode(input.mode)
    if (!mode) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode: 'read_only',
        message: 'ensemble_fanout: mode must be read_only or locked_writers.',
        error: 'invalid_mode'
      }
    }
    const targetStage = normalizeFanoutTargetStage(input.targetStage)
    if (targetStage === null) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message:
          'ensemble_fanout: targetStage must be all, scouts, workers, reviewers, or backgrounds.',
        error: 'invalid_target_stage'
      }
    }
    const isolation = normalizeFanoutIsolation(input.isolation)
    if (isolation === null) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: 'ensemble_fanout: isolation must be worktree or off.',
        error: 'invalid_isolation'
      }
    }
    const prompt = (input.prompt || '').trim()
    if (!prompt) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: 'ensemble_fanout: prompt is required.',
        error: 'missing_prompt'
      }
    }
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: 'ensemble_fanout requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: 'ensemble_fanout: no active Ensemble participant run matches this tool call.',
        error: 'no_active_run'
      }
    }
    const runtime = this.roundsByChatId.get(run.chatId)
    const chat = this.deps.getChat(run.chatId)
    if (!runtime || runtime.cancelled || !chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: 'ensemble_fanout: the active chat is not an Ensemble round.',
        error: 'not_ensemble'
      }
    }
    // A composer-directed round is a user-owned one-seat boundary. Agent
    // routing already prevents @mentions, yields, and continuous handoffs from
    // widening it; explicit fan-out must obey the same boundary. In
    // particular, do not let a live roster policy turn an apparent 1/1
    // round into hidden peer dispatches.
    if (runtime.dmTargetParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message:
          'ensemble_fanout: fan-out is unavailable in a user-targeted round. Start a non-directed round to delegate to other participants.',
        error: 'not_authorized'
      }
    }
    if (
      this.requiresExplicitInterventionTargets(run) &&
      isBroadFanoutRequest(input.targets) &&
      !targetStage
    ) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message:
          'ensemble_fanout: this tagged Boss/Captain intervention requires explicit participants or a targetStage/role. Use skip_intervention if no routing change is needed.',
        error: 'explicit_targets_required'
      }
    }
    const fanoutPolicy = runtime.fanoutPolicy ?? (runtime.concurrentMode ? 'read_only' : 'off')
    if (fanoutPolicy === 'off') {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: 'ensemble_fanout: fan-out is off for this round.',
        error: 'not_authorized'
      }
    }
    if (mode === 'read_only' && !fanoutPolicyAllowsRead(fanoutPolicy)) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message: 'ensemble_fanout: read-only fan-out requires the Read or All fan-out policy.',
        error: 'not_authorized'
      }
    }
    if (mode === 'locked_writers' && !fanoutPolicyAllowsWriters(fanoutPolicy)) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message: 'ensemble_fanout: locked writer lanes require the Write or All fan-out policy.',
        error: 'not_authorized'
      }
    }
    if (mode === 'locked_writers' && !concurrentWriteLanesEnabled()) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message: 'ensemble_fanout: locked writer lanes require TASKWRAITH_CONCURRENT_WRITE_LANES.',
        error: 'write_lanes_disabled'
      }
    }

    const fanoutAuthorityRole = this.fanoutAuthorityRoleForCaller(chat, runtime, run.participant.id)
    if (mode === 'locked_writers' && !fanoutAuthorityRole) {
      const message = this.lockedWriterFanoutAuthorizationMessage(chat, runtime, run)
      this.appendRoundStatus(run.chatId, run.roundId, message)
      this.recordFanoutAuthorizationRejection(chat, run, {
        mode,
        ...(targetStage ? { targetStage } : {}),
        reason: 'locked_writer_not_authorized',
        targets: normalizeTargetList(input.targets)
      })
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message,
        error: 'not_authorized'
      }
    }

    if (isBroadFanoutRequest(input.targets) && !this.canRequestBroadFanout(chat, run)) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message:
          'ensemble_fanout: broad fan-out requires the configured Boss or Captain. Use explicit targets for a narrow peer handoff.',
        error: 'not_authorized'
      }
    }

    const resolvedTargets = this.resolveFanoutTargets(
      chat,
      runtime,
      run,
      input.targets,
      mode,
      targetStage
    )
    if (!resolvedTargets.ok) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message: resolvedTargets.message,
        error: resolvedTargets.error
      }
    }

    // Last gate before dispatch, so a malformed call still hears what is wrong
    // with it rather than being told to wait. Safe from races: fanoutForRun
    // serializes every explicit dispatch behind the owner's fanoutDispatchQueue,
    // so two calls cannot both read "one wave open" and both dispatch.
    const concurrencyRefusal = refuseForConcurrentFanouts(
      this.openFanoutWavesForChat(run.chatId),
      'ensemble_fanout'
    )
    if (concurrencyRefusal) {
      this.appendRoundStatus(run.chatId, run.roundId, concurrencyRefusal.message)
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message: concurrencyRefusal.message,
        error: concurrencyRefusal.error
      }
    }

    const blockedByBudget = resolvedTargets.targets
      .map((participant) => ({
        participant,
        reason: this.bossmanBudgetBlock(runtime, participant.id, 'fanout_call')
      }))
      .filter((entry): entry is { participant: EnsembleParticipant; reason: string } =>
        Boolean(entry.reason)
      )
    if (blockedByBudget.length > 0) {
      const message = `ensemble_fanout: Boss/Captain budget blocks ${blockedByBudget
        .map((entry) => `${participantDisplayName(entry.participant)} (${entry.reason})`)
        .join(', ')}.`
      this.appendRoundStatus(run.chatId, run.roundId, message)
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message,
        error: 'budget_exhausted'
      }
    }

    let writeScopesByParticipantId: Map<string, ConcurrentLaneWriteScope[]> | undefined
    if (mode === 'locked_writers') {
      const resolvedScopes = this.resolveLockedWriterScopes(
        chat,
        runtime,
        resolvedTargets.targets,
        input.writeScopes,
        fanoutAuthorityRole === 'second_in_command' ? 'captain' : 'boss'
      )
      if (!resolvedScopes.ok) {
        return {
          ok: false,
          tool: 'ensemble_fanout',
          mode,
          message: resolvedScopes.message,
          error: resolvedScopes.error
        }
      }
      writeScopesByParticipantId = resolvedScopes.scopesByParticipantId
    }

    const label =
      mode === 'locked_writers' && !targetStage
        ? 'Locked writer fan-out'
        : fanoutTargetStageLabel(targetStage)
    const previousTranscriptBoundary = run.ownedFanoutTranscriptBoundary
    const previousForceNextTimelineContentEntry = run.forceNextTimelineContentEntry
    let acceptedOwnedFanout = false
    try {
      if (previousTranscriptBoundary === undefined) {
        run.ownedFanoutTranscriptBoundary = run.timeline?.length || 0
        run.forceNextTimelineContentEntry = true
        // Materialize every pre-boundary row before a fast lane can publish. The
        // normal debounce may not have fired yet, and a later tail release must
        // contain only the owner's post-fanout continuation.
        this.flushRun(run)
      }
      this.appendRoundStatus(
        run.chatId,
        run.roundId,
        `${label}: ${run.participant.role || run.participant.provider} requested ${resolvedTargets.targets.length} lane(s).${input.reason ? ` ${input.reason}` : ''}`
      )
      if (!runtime.fanoutReservedParticipantIds) runtime.fanoutReservedParticipantIds = new Set()
      for (const participant of resolvedTargets.targets) {
        runtime.fanoutReservedParticipantIds.add(participant.id)
      }
      const acceptedRuns: ActiveParticipantRun[] = []
      await this.runParallelFanoutPass(runtime, chat, resolvedTargets.targets, {
        prompt,
        reason: input.reason,
        mode,
        forceReadOnlyDispatch: mode === 'read_only',
        sourceRunId: runId,
        writeScopesByParticipantId,
        ...(isolation ? { isolation } : {}),
        acceptedRuns,
        waitForCompletion: false,
        completionDisposition: resolvedTargets.targets.every(isBackgroundParticipant)
          ? 'background'
          : 'caller'
      })
      const acceptedParticipantIds = new Set(
        acceptedRuns.map((acceptedRun) => acceptedRun.participant.id)
      )
      const acceptedTargets = resolvedTargets.targets.filter((participant) =>
        acceptedParticipantIds.has(participant.id)
      )
      const laneIds = acceptedRuns
        .map((acceptedRun) => acceptedRun.laneId)
        .filter((laneId): laneId is string => Boolean(laneId))
      if (acceptedTargets.length === 0) {
        const message = `${label} was not dispatched: no target passed preflight and reached provider-adapter invocation. The target remains eligible for serial rotation.`
        if (!runtime.cancelled) this.appendRoundStatus(run.chatId, run.roundId, message)
        return {
          ok: false,
          tool: 'ensemble_fanout',
          mode,
          ...(targetStage ? { targetStage } : {}),
          message,
          laneIds: [],
          participantIds: [],
          error: 'dispatch_failed'
        }
      }
      acceptedOwnedFanout = true
      this.markAuthorityRoutingDecision(run, 'fanout')
      this.incrementBossmanBudgetUsage(
        runtime,
        acceptedTargets.map((participant) => participant.id),
        { fanoutCalls: 1 }
      )
      if (!runtime.fannedOutParticipantIds) runtime.fannedOutParticipantIds = new Set()
      for (const participant of acceptedTargets) {
        runtime.fannedOutParticipantIds.add(participant.id)
      }
      const rejectedCount = resolvedTargets.targets.length - acceptedTargets.length
      return {
        ok: true,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        status: 'dispatched',
        laneIds,
        participantIds: acceptedTargets.map((participant) => participant.id),
        message: `${label} dispatched: ${laneIds.length} lane(s) entered provider setup.${rejectedCount > 0 ? ` ${rejectedCount} target(s) were rejected before adapter invocation and remain eligible for serial rotation.` : ''}${this.ignoredIsolationOverrideNote(chat, isolation)} Results and any asynchronous setup failures will appear in the transcript; this tool returns after adapter invocation so the caller does not time out while lanes are working.`
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ensemble_fanout: dispatch failed.'
      if (!runtime.cancelled) {
        try {
          this.appendRoundStatus(run.chatId, run.roundId, `${label} failed: ${message}`)
        } catch {
          // The structured failure + finally cleanup remain authoritative when
          // even the diagnostic projection cannot be persisted.
        }
      }
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message,
        error: 'dispatch_failed'
      }
    } finally {
      if (!acceptedOwnedFanout && !run.ownedFanoutSettlements?.size) {
        run.ownedFanoutTranscriptBoundary = previousTranscriptBoundary
        run.forceNextTimelineContentEntry = previousForceNextTimelineContentEntry
      }
      for (const participant of resolvedTargets.targets) {
        runtime.fanoutReservedParticipantIds?.delete(participant.id)
      }
      if (runtime.fanoutReservedParticipantIds?.size === 0) {
        runtime.fanoutReservedParticipantIds = undefined
      }
      // A dispatch that threw before seeding any lane must not strand a
      // deferred drain: with this call's reservation window closed, re-check
      // whether the round can finish. No-ops while lanes are still active.
      this.maybeResumeDeferredDrain(runtime.chatId)
    }
  }

  /**
   * `ensemble_fanout_all` — Boss/Captain-only "everyone, now" fan-out.
   *
   * Differences from `ensemble_fanout`: the round's fan-out policy, stage
   * filters (`targetStage`), and per-seat permission ELIGIBILITY filtering
   * are all ignored — every tagged (default: every enabled, idle) seat
   * dispatches concurrently, and each lane runs under the participant's OWN
   * normal-turn posture instead of a read-only clamp or locked-writer
   * scopes. What it deliberately does NOT bypass: caller authority (must be
   * the configured Boss or Captain), the composer-directed
   * one-seat round boundary (user intent), the Boss budget, the roster cap,
   * and every posture clamp inside resolveParticipantPermissions (the
   * unattended-round HMAC clamp in particular) — this tool mints no
   * permission any seat would not have on its own serial turn.
   */
  async fanoutAllForRun(
    runId: string | undefined,
    input: EnsembleFanoutAllInput
  ): Promise<EnsembleFanoutAllResult> {
    const owner = this.actionableRunForTool(runId)
    if (!owner) return this.fanoutAllForRunExclusive(runId, input)

    const previous = owner.fanoutDispatchQueue || Promise.resolve()
    let releaseCurrent!: () => void
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    owner.fanoutDispatchQueue = tail
    owner.pendingFanoutDispatches ??= new Set()
    owner.pendingFanoutDispatches.add(current)
    await previous.catch(() => undefined)
    try {
      return await this.fanoutAllForRunExclusive(runId, input)
    } finally {
      releaseCurrent()
      owner.pendingFanoutDispatches?.delete(current)
      if (owner.pendingFanoutDispatches?.size === 0) {
        owner.pendingFanoutDispatches = undefined
      }
      if (owner.fanoutDispatchQueue === tail) owner.fanoutDispatchQueue = undefined
      this.releaseOwnedFanoutHold(owner)
    }
  }

  private async fanoutAllForRunExclusive(
    runId: string | undefined,
    input: EnsembleFanoutAllInput
  ): Promise<EnsembleFanoutAllResult> {
    const prompt = (input.prompt || '').trim()
    if (!prompt) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message: 'ensemble_fanout_all: prompt is required.',
        error: 'missing_prompt'
      }
    }
    const isolation = normalizeFanoutIsolation(input.isolation)
    if (isolation === null) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message: 'ensemble_fanout_all: isolation must be worktree or off.',
        error: 'invalid_isolation'
      }
    }
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message: 'ensemble_fanout_all requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message: 'ensemble_fanout_all: no active Ensemble participant run matches this tool call.',
        error: 'no_active_run'
      }
    }
    const runtime = this.roundsByChatId.get(run.chatId)
    const chat = this.deps.getChat(run.chatId)
    if (!runtime || runtime.cancelled || !chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message: 'ensemble_fanout_all: the active chat is not an Ensemble round.',
        error: 'not_ensemble'
      }
    }
    // The composer-directed one-seat boundary is USER intent — no tool
    // widens it (same rule as ensemble_fanout).
    if (runtime.dmTargetParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message:
          'ensemble_fanout_all: fan-out is unavailable in a user-targeted round. Start a non-directed round to delegate to other participants.',
        error: 'not_authorized'
      }
    }
    const authorityRole = this.fanoutAuthorityRoleForCaller(chat, runtime, run.participant.id)
    if (!authorityRole) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message:
          'ensemble_fanout_all: only the configured Boss or Captain may fan out the full roster.',
        error: 'not_authorized'
      }
    }
    if (this.requiresExplicitInterventionTargets(run) && isBroadFanoutRequest(input.targets)) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message:
          'ensemble_fanout_all: a tagged Boss/Captain intervention must name specific participants. Use ensemble_fanout with explicit targets or skip_intervention instead.',
        error: 'explicit_targets_required'
      }
    }

    const resolvedTargets = this.resolveFanoutAllTargets(chat, runtime, run, input.targets)
    if (!resolvedTargets.ok) {
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message: resolvedTargets.message,
        error: resolvedTargets.error
      }
    }

    // Same gate as ensemble_fanout, and deliberately the same cap: the two
    // tools dispatch into one round, so counting them separately would let a
    // caller alternate between them and keep four waves alive.
    const concurrencyRefusal = refuseForConcurrentFanouts(
      this.openFanoutWavesForChat(run.chatId),
      'ensemble_fanout_all'
    )
    if (concurrencyRefusal) {
      this.appendRoundStatus(run.chatId, run.roundId, concurrencyRefusal.message)
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message: concurrencyRefusal.message,
        error: concurrencyRefusal.error
      }
    }

    const blockedByBudget = resolvedTargets.targets
      .map((participant) => ({
        participant,
        reason: this.bossmanBudgetBlock(runtime, participant.id, 'fanout_call')
      }))
      .filter((entry): entry is { participant: EnsembleParticipant; reason: string } =>
        Boolean(entry.reason)
      )
    if (blockedByBudget.length > 0) {
      const message = `ensemble_fanout_all: Boss/Captain budget blocks ${blockedByBudget
        .map((entry) => `${participantDisplayName(entry.participant)} (${entry.reason})`)
        .join(', ')}.`
      this.appendRoundStatus(run.chatId, run.roundId, message)
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message,
        error: 'budget_exhausted'
      }
    }

    const label = 'Full fan-out'
    const previousTranscriptBoundary = run.ownedFanoutTranscriptBoundary
    const previousForceNextTimelineContentEntry = run.forceNextTimelineContentEntry
    let acceptedOwnedFanout = false
    try {
      if (previousTranscriptBoundary === undefined) {
        run.ownedFanoutTranscriptBoundary = run.timeline?.length || 0
        run.forceNextTimelineContentEntry = true
        this.flushRun(run)
      }
      this.appendRoundStatus(
        run.chatId,
        run.roundId,
        `${label}: ${run.participant.role || run.participant.provider} requested ${resolvedTargets.targets.length} lane(s) under their own permissions.${input.reason ? ` ${input.reason}` : ''}`
      )
      if (!runtime.fanoutReservedParticipantIds) runtime.fanoutReservedParticipantIds = new Set()
      for (const participant of resolvedTargets.targets) {
        runtime.fanoutReservedParticipantIds.add(participant.id)
      }
      const acceptedRuns: ActiveParticipantRun[] = []
      await this.runParallelFanoutPass(runtime, chat, resolvedTargets.targets, {
        prompt,
        reason: input.reason,
        sourceRunId: runId,
        label,
        dispatchOwnPermissions: true,
        ...(isolation ? { isolation } : {}),
        acceptedRuns,
        waitForCompletion: false,
        completionDisposition: resolvedTargets.targets.every(isBackgroundParticipant)
          ? 'background'
          : 'caller'
      })
      const acceptedParticipantIds = new Set(
        acceptedRuns.map((acceptedRun) => acceptedRun.participant.id)
      )
      const acceptedTargets = resolvedTargets.targets.filter((participant) =>
        acceptedParticipantIds.has(participant.id)
      )
      const laneIds = acceptedRuns
        .map((acceptedRun) => acceptedRun.laneId)
        .filter((laneId): laneId is string => Boolean(laneId))
      if (acceptedTargets.length === 0) {
        const message = `${label} was not dispatched: no target provider accepted a lane. The targets remain eligible for serial rotation.`
        if (!runtime.cancelled) this.appendRoundStatus(run.chatId, run.roundId, message)
        return {
          ok: false,
          tool: 'ensemble_fanout_all',
          message,
          laneIds: [],
          participantIds: [],
          error: 'dispatch_failed'
        }
      }
      acceptedOwnedFanout = true
      this.markAuthorityRoutingDecision(run, 'fanout')
      this.incrementBossmanBudgetUsage(
        runtime,
        acceptedTargets.map((participant) => participant.id),
        { fanoutCalls: 1 }
      )
      if (!runtime.fannedOutParticipantIds) runtime.fannedOutParticipantIds = new Set()
      for (const participant of acceptedTargets) {
        runtime.fannedOutParticipantIds.add(participant.id)
      }
      const rejectedCount = resolvedTargets.targets.length - acceptedTargets.length
      return {
        ok: true,
        tool: 'ensemble_fanout_all',
        status: 'dispatched',
        laneIds,
        participantIds: acceptedTargets.map((participant) => participant.id),
        message: `${label} dispatched: ${laneIds.length} lane(s) started under each participant's own permissions.${rejectedCount > 0 ? ` ${rejectedCount} target(s) did not accept dispatch and remain eligible for serial rotation.` : ''}${this.ignoredIsolationOverrideNote(chat, isolation)} Results will appear in the transcript; this tool returns after dispatch so the caller does not time out while lanes are working.`
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'ensemble_fanout_all: dispatch failed.'
      if (!runtime.cancelled) {
        try {
          this.appendRoundStatus(run.chatId, run.roundId, `${label} failed: ${message}`)
        } catch {
          // Structured failure + finally cleanup remain authoritative.
        }
      }
      return {
        ok: false,
        tool: 'ensemble_fanout_all',
        message,
        error: 'dispatch_failed'
      }
    } finally {
      if (!acceptedOwnedFanout && !run.ownedFanoutSettlements?.size) {
        run.ownedFanoutTranscriptBoundary = previousTranscriptBoundary
        run.forceNextTimelineContentEntry = previousForceNextTimelineContentEntry
      }
      for (const participant of resolvedTargets.targets) {
        runtime.fanoutReservedParticipantIds?.delete(participant.id)
      }
      if (runtime.fanoutReservedParticipantIds?.size === 0) {
        runtime.fanoutReservedParticipantIds = undefined
      }
      this.maybeResumeDeferredDrain(runtime.chatId)
    }
  }

  /** Target resolution for ensemble_fanout_all: STRUCTURAL checks only —
   * enabled, live provider, not the caller, not already active or reserved.
   * No stage filter, no fan-out policy, no permission eligibility. */
  private resolveFanoutAllTargets(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun,
    rawTargets: unknown
  ):
    | { ok: true; targets: EnsembleParticipant[] }
    | {
        ok: false
        message: string
        error: Exclude<EnsembleFanoutAllResult['error'], undefined>
      } {
    const explicitTargets = normalizeTargetList(rawTargets)
    const participants = this.scopedFanoutParticipants(chat)
    const activeParticipantIds = new Set<string>()
    for (const active of this.runsByRunId.values()) {
      if (active.chatId === runtime.chatId && active.roundId === runtime.roundId) {
        activeParticipantIds.add(active.participant.id)
      }
    }
    const isDispatchable = (participant: EnsembleParticipant): boolean => {
      if (!participant.enabled) return false
      if (!isEnsembleSeatProvider(participant.provider)) return false
      if (participant.id === run.participant.id) return false
      if (activeParticipantIds.has(participant.id)) return false
      if (this.participantFanoutDispatchState(runtime, participant.id) === 'active') return false
      return true
    }
    if (explicitTargets.length === 0 || explicitTargets.some((target) => /^@?all$/i.test(target))) {
      const targets = participants.filter(isDispatchable)
      if (targets.length === 0) {
        return {
          ok: false,
          message: 'ensemble_fanout_all: no enabled, idle peer participants are available.',
          error: 'no_eligible_targets'
        }
      }
      return { ok: true, targets }
    }
    const targets: EnsembleParticipant[] = []
    for (const rawTarget of explicitTargets) {
      const target = stripLeadingAt(rawTarget)
      const participant = resolvePhraseToParticipant(
        target,
        participants,
        new Set([run.participant.id])
      )
      if (!participant || !participant.enabled) {
        return {
          ok: false,
          message: `ensemble_fanout_all: target "${rawTarget}" did not resolve to an enabled participant.`,
          error: 'invalid_target'
        }
      }
      if (!isEnsembleSeatProvider(participant.provider)) {
        return {
          ok: false,
          message: `ensemble_fanout_all: target "${rawTarget}" uses a provider that is unavailable for new runs.`,
          error: 'invalid_target'
        }
      }
      if (activeParticipantIds.has(participant.id)) {
        return {
          ok: false,
          message: `ensemble_fanout_all: target "${rawTarget}" is already active in this round.`,
          error: 'invalid_target'
        }
      }
      if (this.participantFanoutDispatchState(runtime, participant.id) === 'active') {
        return {
          ok: false,
          message: `ensemble_fanout_all: target "${rawTarget}" is already reserved for or running in a fan-out lane.`,
          error: 'invalid_target'
        }
      }
      targets.push(participant)
    }
    const deduped = dedupeParticipants(targets)
    if (deduped.length === 0) {
      return {
        ok: false,
        message: 'ensemble_fanout_all: no eligible targets resolved.',
        error: 'no_eligible_targets'
      }
    }
    return { ok: true, targets: deduped }
  }

  sendSideMessageForRun(
    runId: string | undefined,
    input: EnsembleSideMessageInput
  ): EnsembleSideMessageResult {
    if (!runId) {
      return {
        ok: false,
        tool: 'ensemble_send',
        message: 'ensemble_send requires an active Ensemble participant run.',
        error: 'no_active_run'
      }
    }
    const run = this.actionableRunForTool(runId)
    if (!run) {
      return {
        ok: false,
        tool: 'ensemble_send',
        message: 'ensemble_send: no active Ensemble participant run matches this tool call.',
        error: 'no_active_run'
      }
    }
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) {
      return {
        ok: false,
        tool: 'ensemble_send',
        message: 'ensemble_send: the active chat is not an Ensemble chat.',
        error: 'not_ensemble'
      }
    }
    const message = (input.message || '').trim()
    if (!message) {
      return {
        ok: false,
        tool: 'ensemble_send',
        message: 'ensemble_send: message is required.',
        error: 'missing_message'
      }
    }
    const targets = normalizeTargetList(input.to)
    const participants = chat.ensemble.participants || []
    const recipients =
      targets.length === 0
        ? []
        : dedupeParticipants(
            targets
              .map((target) =>
                resolvePhraseToParticipant(
                  stripLeadingAt(target),
                  participants,
                  new Set([run.participant.id])
                )
              )
              .filter((participant): participant is EnsembleParticipant =>
                Boolean(participant?.enabled)
              )
          )
    if (recipients.length === 0) {
      return {
        ok: false,
        tool: 'ensemble_send',
        message:
          'ensemble_send: target did not resolve to an enabled participant. Use list_ensemble_participants first.',
        error: 'invalid_target'
      }
    }
    const timestamp = this.deps.nowIso()
    const senderLabel = run.participant.role || providerLabel(run.participant.provider)
    const recipientLabels = recipients.map(
      (participant) => participant.role || providerLabel(participant.provider)
    )
    const content = `↪ ${senderLabel} to ${recipientLabels.join(', ')}: ${message}${
      input.reason ? `\nReason: ${input.reason}` : ''
    }`
    const sideMessage: ChatMessage = {
      id: `ensemble-side-message-${run.roundId}-${this.deps.now()}-${this.nextStatusSeq()}`,
      role: 'system',
      content,
      timestamp,
      runId: run.runId,
      metadata: {
        kind: 'ensembleSideMessage',
        ensembleRoundId: run.roundId,
        ensembleParticipantId: run.participant.id,
        ensembleProvider: run.participant.provider,
        ensembleRole: run.participant.role,
        ...(run.participant.stageRole ? { ensembleStageRole: run.participant.stageRole } : {}),
        ensembleOrder: run.participant.order,
        ...pooledAgentTranscriptMetadata(run.participant),
        fromParticipantId: run.participant.id,
        fromProvider: run.participant.provider,
        fromRole: run.participant.role,
        toParticipantIds: recipients.map((participant) => participant.id),
        toProviders: recipients.map((participant) => participant.provider),
        toRoles: recipients.map((participant) => participant.role),
        ...laneTranscriptMetadata(run),
        ...(input.reason ? { reason: input.reason } : {})
      }
    }
    this.saveChatWithCheckpoint(
      {
        ...chat,
        messages: [...chat.messages, sideMessage],
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
    return {
      ok: true,
      tool: 'ensemble_send',
      toParticipantIds: recipients.map((participant) => participant.id),
      message: `ensemble_send: delivered visible side message to ${recipientLabels.join(', ')}.`
    }
  }

  markLaneBlockedForRun(runId: string | undefined, reason: string): boolean {
    if (!runId) return false
    const run = this.actionableRunForTool(runId)
    if (!run?.laneId) return false
    const nowIso = this.deps.nowIso()
    this.updateChatRound(run.chatId, (round) => {
      if (!round?.lanes?.[run.laneId!]) return round
      return {
        ...round,
        lanes: {
          ...round.lanes,
          [run.laneId!]: transitionLane(round.lanes[run.laneId!], {
            status: 'blocked',
            reason,
            nowIso
          })
        }
      }
    })
    this.appendRoundStatus(
      run.chatId,
      run.roundId,
      `${run.participant.role || providerLabel(run.participant.provider)} lane blocked: ${reason}`
    )
    return true
  }

  validateLaneWriteScopeForRun(
    runId: string | undefined,
    input: {
      toolName: string
      workspacePath: string
      resourcePaths?: readonly string[]
      resourcePath?: string
    }
  ): { ok: true } | { ok: false; reason: string } {
    if (!runId) return { ok: true }
    const retainedRun = this.runsByRunId.get(runId)
    if (retainedRun?.terminalFinalized) {
      return {
        ok: false,
        reason:
          'This Ensemble participant run is no longer active and cannot mutate workspace state.'
      }
    }
    const run = this.actionableRunForTool(runId)
    if (!run?.laneId) return { ok: true }
    const proposedResourcePaths = input.resourcePaths
      ? [...input.resourcePaths]
      : input.resourcePath
        ? [input.resourcePath]
        : undefined
    // Some historically runtime-labelled tools only read the checkout or
    // write TaskWraith's private asset store. Exact derivation proves that
    // before this gate, so they need no writer lane or workspace exclusion.
    if (proposedResourcePaths?.length === 0) return { ok: true }
    const lane = this.deps.getChat(run.chatId)?.ensemble?.activeRound?.lanes?.[run.laneId]
    if (lane?.intent !== 'write') {
      return {
        ok: false,
        reason: `Lane ${run.laneId} is not a writer lane and cannot mutate workspace state.`
      }
    }
    if (
      input.toolName === 'git_stage' ||
      input.toolName === 'git_commit' ||
      input.toolName === 'git_push' ||
      input.toolName === 'git_create_pr'
    ) {
      return {
        ok: false,
        reason:
          'git stage/commit/push/PR tools are disabled inside parallel writer lanes; finish the lane and publish from a serial owner.'
      }
    }
    const scopes = run.approvedWriteScopes || lane?.approvedWriteScopes || []
    if (scopes.length === 0) {
      return {
        ok: false,
        reason: `Lane ${run.laneId} has no approved write scope.`
      }
    }
    const workspacePath = resolve(input.workspacePath)
    const resourcePaths = proposedResourcePaths?.map((resourcePath) => resolve(resourcePath))
    if (resourcePaths?.some((resourcePath) => !pathIsInsideOrSame(workspacePath, resourcePath))) {
      return {
        ok: false,
        reason:
          'External path writes are disabled inside parallel writer lanes; use a serial writer for external grants.'
      }
    }
    if (!resourcePaths) {
      return scopes.some((scope) => scope.kind === 'workspace')
        ? { ok: true }
        : {
            ok: false,
            reason: `Tool ${input.toolName} did not provide an exact edit scope and cannot use a path-scoped writer lane.`
          }
    }
    const deniedResource = resourcePaths.find(
      (resourcePath) =>
        !scopes.some((scope) => writeScopeAllowsResource(scope, workspacePath, resourcePath))
    )
    return deniedResource
      ? {
          ok: false,
          reason: `Lane ${run.laneId} is not approved to write ${toWorkspaceRelative(workspacePath, deniedResource)}.`
        }
      : { ok: true }
  }

  private activeBossmanParticipantId(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime
  ): string | undefined {
    const participantId =
      runtime.bossmanParticipantId ||
      chat.ensemble?.activeRound?.bossmanParticipantId ||
      chat.ensemble?.bossmanParticipantId
    const participant = chat.ensemble?.participants.find(
      (candidate) => candidate.id === participantId
    )
    return participant && isBackgroundParticipant(participant) ? undefined : participantId
  }

  private activeCaptainParticipantIds(chat: ChatRecord, runtime: ActiveRoundRuntime): string[] {
    return configuredEnsembleCaptainParticipantIds({
      participants: chat.ensemble?.participants || [],
      bossmanParticipantId: this.activeBossmanParticipantId(chat, runtime),
      captainParticipantIds:
        runtime.captainParticipantIds ??
        chat.ensemble?.activeRound?.captainParticipantIds ??
        chat.ensemble?.captainParticipantIds,
      secondInCommandParticipantId:
        runtime.secondInCommandParticipantId ||
        chat.ensemble?.activeRound?.secondInCommandParticipantId ||
        chat.ensemble?.secondInCommandParticipantId
    })
  }

  private activeSecondInCommandParticipantId(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime
  ): string | undefined {
    return this.activeCaptainParticipantIds(chat, runtime)[0]
  }

  private primaryBossUnavailable(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    bossmanParticipantId: string | undefined
  ): { unavailable: boolean; reason?: string; liveBossmanParticipantId?: string } {
    if (!bossmanParticipantId) {
      return { unavailable: true, reason: 'no Boss is assigned' }
    }
    const rosterBoss = chat.ensemble?.participants.find(
      (participant) => participant.id === bossmanParticipantId
    )
    if (!rosterBoss) {
      return { unavailable: true, reason: 'the assigned Boss is no longer in the roster' }
    }
    if (rosterBoss.enabled === false) {
      return {
        unavailable: true,
        reason: `${rosterBoss.role || providerLabel(rosterBoss.provider)} is disabled`,
        liveBossmanParticipantId: bossmanParticipantId
      }
    }
    const round = chat.ensemble?.activeRound
    if (round?.roundId === runtime.roundId) {
      const state = round.participants.find(
        (participant) => participant.participantId === bossmanParticipantId
      )
      if (!state) {
        return {
          unavailable: true,
          reason: 'the assigned Boss is not part of this active round',
          liveBossmanParticipantId: bossmanParticipantId
        }
      }
      if (
        state.status === 'failed' ||
        state.status === 'unreachable' ||
        state.status === 'cancelled' ||
        state.status === 'skipped'
      ) {
        return {
          unavailable: true,
          reason:
            state.lastFailureReason ||
            state.reason ||
            `${rosterBoss.role || providerLabel(rosterBoss.provider)} is ${state.status}`,
          liveBossmanParticipantId: bossmanParticipantId
        }
      }
      // C1 — quota-aware soft failover. A hard provider quota wall finalizes as
      // an ANSWERED turn (finalizeRun) whose wall text is the assistant CONTENT,
      // not lastFailureReason, so the status checks above miss the lived Boss
      // wall. The SHARED pure evaluator (also used by the index auto-approval
      // twin, so the two paths cannot drift) reads the Boss's OWN latest terminal
      // and classifies it. Folding it in HERE means both consumers of THIS method
      // — resolveBossAuthorityForCaller and @-mention priority routing — see the
      // signal, while worker routing (which never calls this method) stays
      // untouched (soft-scope invariant, Captain G1b-v2). Purely derived from the
      // current terminal ⇒ non-sticky (a later healthy turn restores it).
      if (
        evaluateBossQuotaSoftUnavailable(chat, round.roundId, {
          id: bossmanParticipantId,
          provider: rosterBoss.provider
        })
      ) {
        return {
          unavailable: true,
          reason: `${rosterBoss.role || providerLabel(rosterBoss.provider)} hit a provider quota wall`,
          liveBossmanParticipantId: bossmanParticipantId
        }
      }
    }
    return { unavailable: false, liveBossmanParticipantId: bossmanParticipantId }
  }

  private activeActingCaptainParticipantId(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime
  ): string | undefined {
    const captainParticipantIds = this.activeCaptainParticipantIds(chat, runtime)
    const unavailableCaptainParticipantIds = new Set(runtime.unreachableParticipantIds || [])
    const round = chat.ensemble?.activeRound
    if (round?.roundId === runtime.roundId) {
      for (const participantId of captainParticipantIds) {
        const participant = chat.ensemble?.participants.find(
          (candidate) => candidate.id === participantId
        )
        if (
          participant &&
          evaluateBossQuotaSoftUnavailable(chat, round.roundId, {
            id: participant.id,
            provider: participant.provider
          })
        ) {
          unavailableCaptainParticipantIds.add(participantId)
        }
      }
    }
    return resolveActingCaptainParticipantId({
      participants: chat.ensemble?.participants || [],
      bossmanParticipantId: this.activeBossmanParticipantId(chat, runtime),
      captainParticipantIds,
      unavailableParticipantIds: unavailableCaptainParticipantIds,
      roundParticipantStates: round?.participants,
      roundLive: round?.roundId === runtime.roundId && round.status === 'running'
    })
  }

  private resolveBossAuthorityForCaller(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    callerParticipantId: string
  ):
    | {
        ok: true
        role: 'boss' | 'second_in_command'
        bossmanParticipantId: string
        captainParticipantIds: string[]
        secondInCommandParticipantId?: string
        rosterGuardParticipantId: string
        primaryUnavailableReason?: string
      }
    | {
        ok: false
        error: 'bossman_not_configured' | 'second_in_command_standby' | 'not_bossman'
        message: string
        bossmanParticipantId?: string
        captainParticipantIds?: string[]
        secondInCommandParticipantId?: string
        primaryUnavailableReason?: string
      } {
    const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
    const captainParticipantIds = this.activeCaptainParticipantIds(chat, runtime)
    const secondInCommandParticipantId = captainParticipantIds[0]
    const primary = this.primaryBossUnavailable(chat, runtime, bossmanParticipantId)
    const actingCaptainParticipantId = this.activeActingCaptainParticipantId(chat, runtime)
    if (!bossmanParticipantId) {
      return {
        ok: false,
        error: 'bossman_not_configured',
        message: 'no Boss is assigned for this Ensemble',
        captainParticipantIds,
        secondInCommandParticipantId,
        primaryUnavailableReason: primary.reason
      }
    }
    if (callerParticipantId === bossmanParticipantId) {
      return {
        ok: true,
        role: 'boss',
        bossmanParticipantId,
        captainParticipantIds,
        secondInCommandParticipantId,
        rosterGuardParticipantId: bossmanParticipantId
      }
    }
    if (captainParticipantIds.includes(callerParticipantId)) {
      if (primary.unavailable && callerParticipantId === actingCaptainParticipantId) {
        return {
          ok: true,
          role: 'second_in_command',
          bossmanParticipantId,
          captainParticipantIds,
          secondInCommandParticipantId,
          rosterGuardParticipantId: primary.liveBossmanParticipantId || actingCaptainParticipantId,
          primaryUnavailableReason: primary.reason
        }
      }
      return {
        ok: false,
        error: 'second_in_command_standby',
        message: primary.unavailable
          ? 'another configured Captain has acting authority for this unavailable Boss'
          : 'the assigned Boss is still available, so Captains remain standby',
        bossmanParticipantId,
        captainParticipantIds,
        secondInCommandParticipantId
      }
    }
    return {
      ok: false,
      error: 'not_bossman',
      message:
        'only the assigned Boss, or the single acting Captain while the Boss is unavailable, may use this control',
      bossmanParticipantId,
      captainParticipantIds,
      secondInCommandParticipantId,
      primaryUnavailableReason: primary.unavailable ? primary.reason : undefined
    }
  }

  /**
   * Fan-out is a deliberately shared Boss/Captain power. Unlike controlling
   * authority, roster mutation, approvals, and goal closure, it does not put
   * Captain on standby while Boss is healthy: either configured seat may
   * dispatch parallel work, subject to the same policy, scope, budget, and
   * user-targeted-round boundaries.
   */
  private fanoutAuthorityRoleForCaller(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    callerParticipantId: string
  ): 'boss' | 'second_in_command' | undefined {
    if (callerParticipantId === this.activeBossmanParticipantId(chat, runtime)) {
      return 'boss'
    }
    if (this.activeCaptainParticipantIds(chat, runtime).includes(callerParticipantId)) {
      return 'second_in_command'
    }
    return undefined
  }

  private isBossParticipant(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participantId: string | undefined
  ): boolean {
    if (!participantId) return false
    return this.resolveBossAuthorityForCaller(chat, runtime, participantId).ok
  }

  private isInitialAuthorityPass(runtime: ActiveRoundRuntime): boolean {
    return runtime.continuationPass <= 1
  }

  private takeAuthorityRoutingCheckpoint(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    isLane: boolean
  ): EnsembleAuthorityRoutingCheckpoint | undefined {
    if (isLane) return undefined
    if (!this.resolveBossAuthorityForCaller(chat, runtime, participant.id).ok) return undefined

    const tagged = runtime.pendingAuthorityRoutingCheckpoints?.get(participant.id)
    if (tagged) {
      runtime.pendingAuthorityRoutingCheckpoints?.delete(participant.id)
      return tagged
    }

    if (
      shouldAttachContinuousAuthoritySelectionCheckpoint({
        orchestrationMode: runtime.orchestrationMode,
        remainingParticipantCount: runtime.remainingParticipants?.length || 0
      })
    ) {
      return {
        kind: 'later_pass',
        pass: runtime.continuationPass,
        selectionRequired: true
      }
    }
    return undefined
  }

  private markAuthorityRoutingDecision(
    run: ActiveParticipantRun | undefined,
    decision: NonNullable<ActiveParticipantRun['authorityRoutingDecision']>
  ): void {
    if (!run?.authorityRoutingCheckpoint) return
    run.authorityRoutingDecision = decision
  }

  private noteUnresolvedAuthorityRoutingCheckpoint(run: ActiveParticipantRun): void {
    const checkpoint = run.authorityRoutingCheckpoint
    if (!checkpoint || run.authorityRoutingDecision) return
    const requirement = checkpoint.selectionRequired
      ? 'No explicit keep/skip, targeted fan-out, or redirect decision was received'
      : 'No explicit interstitial routing decision was received'
    this.appendRoundStatus(
      run.chatId,
      run.roundId,
      `Authority routing checkpoint: ${requirement} from ${participantDisplayName(run.participant)}; the host preserved the existing queue.`
    )
  }

  private requiresExplicitInterventionTargets(run: ActiveParticipantRun): boolean {
    return (
      run.authorityRoutingCheckpoint?.kind === 'tagged_intervention' &&
      !run.authorityRoutingDecision
    )
  }

  private taggedAuthorityRoutingCheckpoint(
    runtime: ActiveRoundRuntime,
    sourceRun: ActiveParticipantRun
  ): EnsembleAuthorityRoutingCheckpoint {
    return {
      kind: 'tagged_intervention',
      pass: runtime.continuationPass,
      selectionRequired:
        runtime.orchestrationMode === 'continuous' && !this.isInitialAuthorityPass(runtime),
      sourceParticipantLabel: participantDisplayName(sourceRun.participant)
    }
  }

  private scheduleTaggedAuthorityIntervention(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    remaining: EnsembleParticipant[],
    sourceRun: ActiveParticipantRun,
    matches: ParticipantMentionMatch[]
  ): boolean {
    const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
    const primary = this.primaryBossUnavailable(chat, runtime, bossmanParticipantId)
    const authorityId = primary.unavailable
      ? this.activeActingCaptainParticipantId(chat, runtime)
      : bossmanParticipantId
    if (!authorityId) return false
    const authorityMatch = matches.find(
      (match) =>
        match.participant.id === authorityId &&
        !match.ambiguousAmong?.length &&
        !isBackgroundParticipant(match.participant)
    )
    if (!authorityMatch) return false

    const checkpoint = this.taggedAuthorityRoutingCheckpoint(runtime, sourceRun)
    const authority = authorityMatch.participant
    const pendingIndex = remaining.findIndex((participant) => participant.id === authority.id)
    if (pendingIndex >= 0) {
      const [pending] = remaining.splice(pendingIndex, 1)
      remaining.unshift(pending)
      runtime.pendingAuthorityRoutingCheckpoints ??= new Map()
      runtime.pendingAuthorityRoutingCheckpoints.set(authority.id, checkpoint)
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Authority checkpoint: ${participantDisplayName(authority)} was tagged by ${participantDisplayName(sourceRun.participant)} and takes precedence before the requested handoff.`
      )
      return true
    }

    const continuation = this.tryAppendContinuationTurn(
      runtime,
      remaining,
      authority,
      `Authority checkpoint: ${participantDisplayName(authority)} was tagged by ${participantDisplayName(sourceRun.participant)}.`,
      { allowAnsweredParticipant: true, allowYieldedParticipant: true }
    )
    if (!continuation.appended) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Authority checkpoint: could not summon ${participantDisplayName(authority)} after ${participantDisplayName(sourceRun.participant)} tagged it — ${this.describeContinuationDecline(continuation)}.`
      )
      return false
    }
    runtime.pendingAuthorityRoutingCheckpoints ??= new Map()
    runtime.pendingAuthorityRoutingCheckpoints.set(authority.id, checkpoint)
    return true
  }

  private lockedWriterFanoutAuthorizationMessage(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): string {
    if (this.fanoutAuthorityRoleForCaller(chat, runtime, run.participant.id)) {
      return 'Locked writer fan-out authorized.'
    }
    const authority = this.resolveBossAuthorityForCaller(chat, runtime, run.participant.id)
    if (authority.ok) return 'Locked writer fan-out authorized.'
    if (authority.error === 'bossman_not_configured') {
      return 'Locked writer fan-out rejected: no Boss is assigned, so writer lanes require a user write-scope preflight before parallel mutation is allowed.'
    }
    return `Locked writer fan-out rejected from ${run.participant.role || providerLabel(run.participant.provider)}: only the assigned Boss or Captain may authorize parallel writer lanes.`
  }

  private recordFanoutAuthorizationRejection(
    chat: ChatRecord,
    run: ActiveParticipantRun,
    metadata: Record<string, unknown>
  ): void {
    try {
      const runtime = this.roundsByChatId.get(run.chatId)
      this.deps.recordFanoutAuthorizationRejection?.({
        provider: run.participant.provider,
        workspacePath: chat.scope === 'global' ? undefined : chat.workspacePath,
        chatId: run.chatId,
        runId: run.runId,
        metadata: {
          kind: 'ensemble_fanout_rejected',
          roundId: run.roundId,
          participantId: run.participant.id,
          participantRole: run.participant.role,
          assignedBossmanParticipantId: runtime
            ? this.activeBossmanParticipantId(chat, runtime)
            : chat.ensemble?.bossmanParticipantId,
          assignedSecondInCommandParticipantId: runtime
            ? this.activeSecondInCommandParticipantId(chat, runtime)
            : chat.ensemble?.secondInCommandParticipantId,
          ...metadata
        }
      })
    } catch {
      // Audit is best-effort; the tool result still rejects.
    }
  }

  private resolveLockedWriterScopes(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    targets: EnsembleParticipant[],
    rawScopes: unknown,
    approvedBy: ConcurrentLaneWriteScope['approvedBy']
  ):
    | { ok: true; scopesByParticipantId: Map<string, ConcurrentLaneWriteScope[]> }
    | {
        ok: false
        message: string
        error: Extract<EnsembleFanoutResult['error'], 'missing_write_scope' | 'invalid_write_scope'>
      } {
    const writerTargets = targets.filter(
      (participant) =>
        !this.resolveFanoutDispatchPermissions(chat, runtime, participant, 'locked_writers')
          .readOnly
    )
    const scopesByParticipantId = new Map<string, ConcurrentLaneWriteScope[]>()
    if (writerTargets.length === 0) return { ok: true, scopesByParticipantId }
    if (rawScopes === undefined || rawScopes === null || rawScopes === '') {
      return {
        ok: false,
        message:
          'ensemble_fanout: locked writer lanes require explicit writeScopes for every writer target.',
        error: 'missing_write_scope'
      }
    }
    for (const participant of writerTargets) {
      const rawForParticipant = pickRawWriteScopesForParticipant(rawScopes, participant)
      if (rawForParticipant === undefined) {
        return {
          ok: false,
          message: `ensemble_fanout: missing writeScopes for ${participant.role || providerLabel(participant.provider)}.`,
          error: 'missing_write_scope'
        }
      }
      const scopes = normalizeConcurrentWriteScopes(
        rawForParticipant,
        approvedBy,
        this.deps.nowIso()
      )
      if (scopes.length === 0) {
        return {
          ok: false,
          message: `ensemble_fanout: invalid or empty writeScopes for ${participant.role || providerLabel(participant.provider)}.`,
          error: 'invalid_write_scope'
        }
      }
      scopesByParticipantId.set(participant.id, scopes)
    }
    return { ok: true, scopesByParticipantId }
  }

  private nextLaneId(runtime: ActiveRoundRuntime, participant: EnsembleParticipant): string {
    if (!runtime.laneAttemptByParticipantId) {
      runtime.laneAttemptByParticipantId = new Map<string, number>()
    }
    const attempt = (runtime.laneAttemptByParticipantId.get(participant.id) || 0) + 1
    runtime.laneAttemptByParticipantId.set(participant.id, attempt)
    return buildLaneId(runtime.roundId, participant.id, attempt)
  }

  private evaluateUserWriteScopeClaims(
    chat: ChatRecord,
    writers: EnsembleParticipant[],
    runs: ActiveParticipantRun[]
  ): { ok: true; preflight: ConcurrentWriteScopePreflight } | { ok: false; reason: string } {
    const workspacePath = chat.scope === 'global' ? '' : chat.workspacePath || ''
    if (!workspacePath) {
      return {
        ok: false,
        reason: 'user write-scope preflight requires a workspace-scoped chat.'
      }
    }
    const runByParticipantId = new Map(runs.map((run) => [run.participant.id, run]))
    const claims: ConcurrentWriteScopeClaim[] = []
    for (const writer of writers) {
      const run = runByParticipantId.get(writer.id)
      if (!run) {
        return {
          ok: false,
          reason: `${writer.role || providerLabel(writer.provider)} did not complete a write-scope claim lane.`
        }
      }
      const parsed = parseConcurrentWriteScopeClaim(run, this.deps.nowIso())
      if (!parsed.ok) return parsed
      for (const scope of parsed.claim.scopes) {
        if (!scopeIsInsideWorkspace(workspacePath, scope)) {
          return {
            ok: false,
            reason: `${parsed.claim.participantRole} claimed an external write scope (${formatWriteScope(scope)}).`
          }
        }
      }
      claims.push(parsed.claim)
    }

    const conflicts: string[] = []
    for (let i = 0; i < claims.length; i += 1) {
      for (let j = i + 1; j < claims.length; j += 1) {
        const left = claims[i]
        const right = claims[j]
        const overlaps = left.scopes.some((leftScope) =>
          right.scopes.some((rightScope) =>
            writeScopesMayOverlap(workspacePath, leftScope, rightScope)
          )
        )
        if (overlaps) {
          conflicts.push(
            `${left.participantRole} (${left.scopes.map(formatWriteScope).join(', ')}) overlaps ${right.participantRole} (${right.scopes.map(formatWriteScope).join(', ')})`
          )
        }
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `write-scope preflight found overlapping claims: ${conflicts.join('; ')}.`
      }
    }
    const scopesByParticipantId = new Map<string, ConcurrentLaneWriteScope[]>(
      claims.map((claim) => [claim.participantId, claim.scopes])
    )
    const matrixSummary = claims
      .map((claim) => `${claim.participantRole}: ${claim.scopes.map(formatWriteScope).join(', ')}`)
      .join('\n')
    return {
      ok: true,
      preflight: {
        claims,
        scopesByParticipantId,
        matrixSummary
      }
    }
  }

  private async runUserWriteScopePreflight(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord,
    writers: EnsembleParticipant[]
  ): Promise<boolean> {
    if (writers.length < 2 || runtime.cancelled) return false
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `Write-scope preflight: ${writers.length} writer-capable participant(s) will claim non-overlapping scopes before any parallel writes are allowed.`
    )
    const claimRuns: ActiveParticipantRun[] = []
    await this.runParallelFanoutPass(runtime, chat, writers, {
      mode: 'read_only',
      label: 'Write-scope claim preflight',
      forceReadOnlyDispatch: true,
      prompt: writeScopeClaimPrompt(),
      reason: 'No Boss is assigned; user-enabled fan-out requires write-scope claims first.',
      onCompleteRuns: (runs) => {
        claimRuns.push(...runs)
      }
    })
    if (runtime.cancelled) return false
    const evaluated = this.evaluateUserWriteScopeClaims(chat, writers, claimRuns)
    if (!evaluated.ok) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Write-scope preflight rejected parallel writers: ${evaluated.reason} Continuing with serial writers.`
      )
      return false
    }

    const ackRuns: ActiveParticipantRun[] = []
    await this.runParallelFanoutPass(runtime, chat, writers, {
      mode: 'read_only',
      label: 'Write-scope matrix ack',
      forceReadOnlyDispatch: true,
      prompt: writeScopeAckPrompt(evaluated.preflight.matrixSummary),
      reason: 'Confirm the host-built non-overlap matrix before write lanes start.',
      onCompleteRuns: (runs) => {
        ackRuns.push(...runs)
      }
    })
    if (runtime.cancelled) return false
    const missingAck = ackRuns.find((run) => !parseConcurrentWriteScopeAck(run))
    if (missingAck) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Write-scope preflight rejected parallel writers: ${missingAck.participant.role || providerLabel(missingAck.participant.provider)} did not acknowledge the host conflict matrix. Continuing with serial writers.`
      )
      return false
    }

    await this.runParallelFanoutPass(runtime, chat, writers, {
      mode: 'locked_writers',
      label: 'User-preflight writer fan-out',
      prompt: writeScopeExecutionPrompt(evaluated.preflight.matrixSummary),
      reason: 'User enabled fan-out and all writer claims were non-overlapping and acknowledged.',
      writeScopesByParticipantId: evaluated.preflight.scopesByParticipantId
    })
    return !runtime.cancelled
  }

  /**
   * 1.0.4-AK6 — public lookup for fan-out membership. The
   * `scout_brief` dispatcher in `index.ts` uses this to refuse
   * briefs from outside an active parallel fan-out pass.
   */
  isParticipantInScoutPass(runId: string): boolean {
    if (!runId) return false
    const run = this.actionableRunForTool(runId)
    if (!run) return false
    const runtime = this.roundsByChatId.get(run.chatId)
    return Boolean(runtime?.activeScoutRunIds?.has(runId))
  }

  /**
   * 1.0.4-AK6 — lookup the participant's role + provider for
   * scout-brief recording. Used by the dispatch site to populate
   * the brief's identity fields without exposing the orchestrator's
   * internal run registry.
   */
  getParticipantMetaForRun(runId: string): { role: string; provider: ProviderId } | null {
    if (!runId) return null
    const run = this.actionableRunForTool(runId)
    if (!run) return null
    return {
      role: run.participant.role || '',
      provider: run.participant.provider
    }
  }

  /**
   * 1.0.4-AK6 — record a scout brief into the round runtime. Called
   * by the `scout_brief` MCP tool dispatcher after handler
   * validation. The brief is read after the parallel fan-out pass
   * closes and threaded into the serial writer's prompt via
   * `formatScoutBriefsForPrompt`.
   *
   * No-op when the runtime doesn't exist (defensive against late
   * calls after the round closed).
   */
  recordScoutBrief(runId: string, brief: ScoutBriefRecord): void {
    if (!runId) return
    const run = this.actionableRunForTool(runId)
    if (!run) return
    const runtime = this.roundsByChatId.get(run.chatId)
    if (!runtime) return
    if (!runtime.scoutBriefs) runtime.scoutBriefs = []
    runtime.scoutBriefs.push(brief)
    // Spike 6 (docs/ensemble-posture-fanout-preamble-design.md) — durable
    // copy on the shared blackboard. `runtime.scoutBriefs` dies with the
    // round runtime, so pre-spike a brief was invisible to every subsequent
    // round even though it often carries exactly the hand-off context a
    // later writer needs. Session scope survives round turnover; the stable
    // (participantId, key, scope) upsert means a re-scouting participant
    // replaces its prior brief instead of stacking; deterministic id keeps
    // this clock/random-free.
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) return
    const briefValue = [
      brief.findings,
      ...(brief.recommendations?.length ? [`Recommends: ${brief.recommendations.join('; ')}`] : []),
      ...(brief.blockers?.length ? [`Blockers: ${brief.blockers.join('; ')}`] : [])
    ].join(' — ')
    const entry = makeBlackboardEntry({
      id: `${runtime.roundId}-scout-${brief.participantId}`,
      chatId: chat.appChatId,
      roundId: runtime.roundId,
      participantId: brief.participantId,
      key: `scout-brief:${brief.participantRole || brief.participantId}`,
      value: briefValue,
      category: 'note',
      scope: 'session',
      derivedFrom: 'scout_brief',
      createdAt: brief.emittedAt
    })
    if (!entry) return
    const upsert = upsertBlackboardEntry(chat.ensemble.blackboard || [], entry, {
      currentRoundId: runtime.roundId,
      tombstones: chat.ensemble.blackboardTombstones,
      prunedAt: brief.emittedAt
    })
    if (!upsert.ok) return
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          blackboard: upsert.entries,
          blackboardTombstones: upsert.tombstones,
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      // Mid-round config-state change — same checkpoint class as the other
      // in-flight round mutations (SessionCheckpointReason is a closed union).
      'round-updated'
    )
  }

  listParticipantsForRun(runId: string | undefined): {
    ok: boolean
    error?: string
    chatId?: string
    roundId?: string
    activeParticipantId?: string
    bossmanParticipantId?: string
    captainParticipantIds?: string[]
    secondInCommandParticipantId?: string
    bossmanAuthorityRole?: 'boss' | 'second_in_command'
    bossmanPrimaryUnavailableReason?: string
    bossmanAutoApprovalsEnabled?: boolean
    rosterEditAllowed?: boolean
    rosterPresetImportAllowed?: boolean
    rosterPresetAuthorityRole?: 'boss' | 'captain'
    availableProviders?: EnsembleParticipantProviderCatalogEntry[]
    participants?: Array<{
      id: string
      provider: ProviderId
      role: string
      model?: string
      order: number
      enabled: boolean
      status: EnsembleParticipantStatus
      contextTokens: number
      contextWindow: number
      contextPercent: number
      contextSeverity: ContextPressureSeverity
    }>
  } {
    if (!runId) return { ok: false, error: 'list_ensemble_participants requires an active run id.' }
    const run = this.actionableRunForTool(runId)
    if (!run)
      return { ok: false, error: 'No active Ensemble participant run matches this tool call.' }
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) return { ok: false, error: 'The active chat is not an Ensemble chat.' }
    const states = new Map(
      (chat.ensemble.activeRound?.participants || []).map((participant) => [
        participant.participantId,
        participant.status
      ])
    )
    const runtime = this.roundsByChatId.get(run.chatId)
    const authority = runtime
      ? this.resolveBossAuthorityForCaller(chat, runtime, run.participant.id)
      : null
    const captainParticipantIds = runtime
      ? this.activeCaptainParticipantIds(chat, runtime)
      : configuredEnsembleCaptainParticipantIds({
          participants: chat.ensemble.participants,
          bossmanParticipantId: chat.ensemble.bossmanParticipantId,
          captainParticipantIds: chat.ensemble.captainParticipantIds,
          secondInCommandParticipantId: chat.ensemble.secondInCommandParticipantId
        })
    const rosterPresetAuthorityRole =
      run.participant.id === chat.ensemble.bossmanParticipantId
        ? 'boss'
        : captainParticipantIds.includes(run.participant.id)
          ? 'captain'
          : undefined
    return {
      ok: true,
      chatId: chat.appChatId,
      roundId: run.roundId,
      activeParticipantId: run.participant.id,
      bossmanParticipantId: chat.ensemble.bossmanParticipantId,
      captainParticipantIds,
      secondInCommandParticipantId: captainParticipantIds[0],
      ...(authority?.ok ? { bossmanAuthorityRole: authority.role } : {}),
      ...(authority?.ok && authority.primaryUnavailableReason
        ? { bossmanPrimaryUnavailableReason: authority.primaryUnavailableReason }
        : {}),
      bossmanAutoApprovalsEnabled: chat.ensemble.bossmanAutoApprovals?.enabled === true,
      rosterEditAllowed:
        authority?.ok === true &&
        chat.ensemble.bossmanAutoApprovals?.enabled === true &&
        chat.ensemble.bossmanAutoApprovals?.mode === 'permission_preset_once',
      rosterPresetImportAllowed: rosterPresetAuthorityRole !== undefined,
      ...(rosterPresetAuthorityRole ? { rosterPresetAuthorityRole } : {}),
      availableProviders: buildEnsembleParticipantProviderCatalog(
        this.deps.getProviderUsageSnapshot,
        undefined,
        this.deps.getSettings()
      ),
      participants: (chat.ensemble.participants || []).map((participant) => {
        const participantContext = latestRunContextUsage(chat.runs ?? [], participant.id)
        const participantContextWindow = resolveContextWindow(
          isContextWindowProviderId(participant.provider) ? participant.provider : undefined,
          participant.model,
          participantContext.totalTokenLimit
        )
        return {
          id: participant.id,
          provider: participant.provider,
          role: participant.role,
          model: participant.model,
          order: participant.order,
          enabled: participant.enabled,
          status: states.get(participant.id) || 'idle',
          contextTokens: participantContext.tokens,
          contextWindow: participantContextWindow,
          contextPercent: contextPercent(participantContext.tokens, participantContextWindow),
          // Boss-facing pressure grade (warn ≥80% / critical ≥95%) so a roster
          // manager can see which seat is nearing its window without doing the
          // division itself.
          contextSeverity: contextPressureSeverity(
            contextPercent(participantContext.tokens, participantContextWindow)
          )
        }
      })
    }
  }

  scheduleWakeupForRun(
    runId: string | undefined,
    input: ScheduleWakeupInput
  ): {
    ok: boolean
    error?: string
    wakeup?: EnsembleWakeupRecord
    message?: string
  } {
    if (!runId) return { ok: false, error: 'schedule_wakeup requires an active run id.' }
    const run = this.actionableRunForTool(runId)
    if (!run)
      return { ok: false, error: 'No active Ensemble participant run matches this wakeup request.' }
    const runtime = this.roundsByChatId.get(run.chatId)
    if (!runtime || runtime.roundId !== run.roundId || runtime.cancelled) {
      return { ok: false, error: 'No active Ensemble round is available for this wakeup.' }
    }
    if (runtime.activeScoutRunIds?.has(runId)) {
      return {
        ok: false,
        error: 'schedule_wakeup is not available from parallel fan-out lanes.'
      }
    }
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) return { ok: false, error: 'The active chat is not an Ensemble chat.' }
    const existing = this.findPendingWakeupForParticipant(chat, run.roundId, run.participant.id)
    if (existing) {
      return {
        ok: false,
        error: `Participant already has a pending wakeup for this round (${existing.wakeupId}).`
      }
    }
    const nowMs = this.deps.now()
    const wakeAtMs = resolveWakeAtMs(input, nowMs)
    if (!Number.isFinite(wakeAtMs)) {
      return {
        ok: false,
        error: 'schedule_wakeup requires wakeAt, delayMs, or delaySeconds.'
      }
    }
    // 1.0.5-N4 — Reject far-future wakeups before they hit the
    // Node setTimeout clamp. See MAX_WAKEUP_DELAY_MS for context.
    const requestedDelayMs = wakeAtMs - nowMs
    if (requestedDelayMs > MAX_WAKEUP_DELAY_MS) {
      const requestedDays = Math.round(requestedDelayMs / (24 * 60 * 60 * 1000))
      return {
        ok: false,
        error: `schedule_wakeup max delay is 7 days; requested ~${requestedDays} days. Schedule sequential wakeups (one now, another on resume) for longer horizons.`
      }
    }
    const nowIso = this.deps.nowIso()
    const wakeup: EnsembleWakeupRecord = {
      wakeupId: `wakeup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chatId: run.chatId,
      roundId: run.roundId,
      participantId: run.participant.id,
      provider: run.participant.provider,
      role: run.participant.role,
      stageRole: run.participant.stageRole ?? null,
      runId: run.runId,
      scheduledAt: nowIso,
      wakeAt: new Date(wakeAtMs).toISOString(),
      status: 'pending',
      reason: input.reason,
      cancelOnUserInput: input.cancelOnUserInput !== false
    }
    wakeup.permissionPosture = this.buildWakeupPermissionPosture(chat, run, runtime, wakeup)
    wakeup.dispatchReceipt = this.buildWakeupDispatchReceipt(chat, wakeup)
    if (!runtime.pendingWakeups) runtime.pendingWakeups = new Map()
    runtime.pendingWakeups.set(wakeup.wakeupId, wakeup)
    this.saveWakeupRecord(chat, wakeup)
    this.updateSleepingRoundState(run.chatId, run.roundId)
    this.deps.scheduleWakeupTimer?.(wakeup)
    this.finalizeRun(run, 'sleeping', formatWakeupScheduledReason(wakeup))
    const message = `${run.participant.role || providerLabel(run.participant.provider)} sleeping until ${wakeup.wakeAt}.`
    this.appendRoundStatus(run.chatId, run.roundId, message)
    return { ok: true, wakeup, message }
  }

  cancelWakeupForRun(
    runId: string | undefined,
    input: CancelWakeupInput = {}
  ): {
    ok: boolean
    error?: string
    cancelled?: EnsembleWakeupRecord[]
    message?: string
  } {
    if (!runId) return { ok: false, error: 'cancel_wakeup requires an active run id.' }
    const run = this.actionableRunForTool(runId)
    if (!run)
      return {
        ok: false,
        error: 'No active Ensemble participant run matches this wakeup cancellation.'
      }
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) return { ok: false, error: 'The active chat is not an Ensemble chat.' }
    const wakeups = Object.values(chat.ensemble.wakeups || {}).filter((wakeup) => {
      if (wakeup.status !== 'pending') return false
      if (wakeup.roundId !== run.roundId) return false
      if (wakeup.participantId !== run.participant.id) return false
      return input.wakeupId ? wakeup.wakeupId === input.wakeupId : true
    })
    if (input.wakeupId && wakeups.length === 0) {
      return { ok: false, error: 'No matching pending wakeup belongs to this participant.' }
    }
    if (wakeups.length === 0)
      return { ok: true, cancelled: [], message: 'No pending wakeups to cancel.' }
    const cancelled = wakeups.map((wakeup) =>
      this.markWakeupCancelled(wakeup, 'cancelled by participant')
    )
    const runtime = this.roundsByChatId.get(run.chatId)
    if (runtime) {
      for (const wakeup of cancelled) runtime.pendingWakeups?.delete(wakeup.wakeupId)
      this.signalWakeWaiter(runtime)
    }
    this.updateSleepingRoundState(run.chatId, run.roundId)
    return {
      ok: true,
      cancelled,
      message: `Cancelled ${cancelled.length} wakeup${cancelled.length === 1 ? '' : 's'}.`
    }
  }

  handleWakeupFired(wakeupId: string): boolean {
    if (!wakeupId) return false
    const located = this.findRuntimeByWakeupId(wakeupId)
    if (!located) return false
    const { runtime, wakeup } = located
    if (wakeup.status !== 'pending') return false
    const fired: EnsembleWakeupRecord = {
      ...wakeup,
      status: 'fired',
      firedAt: this.deps.nowIso()
    }
    runtime.pendingWakeups?.delete(wakeupId)
    if (!runtime.readyWakeups) runtime.readyWakeups = []
    runtime.readyWakeups.push(fired)
    this.saveWakeupRecord(this.deps.getChat(fired.chatId), fired)
    this.updateSleepingRoundState(fired.chatId, fired.roundId)
    this.signalWakeWaiter(runtime)
    return true
  }

  /**
   * 1.0.5-N7 — User-initiated cancel of a specific pending wakeup
   * by id. Symmetric with handleWakeupFired but marks the record
   * cancelled instead of fired. Returns the cancelled record or
   * null when no in-memory runtime matches. Persisted-only fallback
   * is the caller's responsibility (IPC layer).
   */
  cancelWakeupById(wakeupId: string, message: string): EnsembleWakeupRecord | null {
    if (!wakeupId) return null
    const located = this.findRuntimeByWakeupId(wakeupId)
    if (!located) return null
    const { runtime, wakeup } = located
    if (wakeup.status !== 'pending') return null
    const cancelled = this.markWakeupCancelled(wakeup, message)
    runtime.pendingWakeups?.delete(wakeupId)
    this.updateSleepingRoundState(wakeup.chatId, wakeup.roundId)
    this.signalWakeWaiter(runtime)
    return cancelled
  }

  resumePersistedWakeup(wakeup: EnsembleWakeupRecord, sender: Electron.WebContents): boolean {
    if (wakeup.status !== 'pending') return false
    const chat = this.deps.getChat(wakeup.chatId)
    const round = chat?.ensemble?.activeRound
    if (
      !chat?.ensemble ||
      !round ||
      round.roundId !== wakeup.roundId ||
      round.status !== 'running'
    ) {
      return false
    }
    const participant = this.participantForWakeup(chat, wakeup)
    if (!participant) return false
    if (round.dmTargetParticipantId) {
      const directedTarget = chat.ensemble.participants.find(
        (entry) => entry.id === round.dmTargetParticipantId
      )
      if (!directedTarget || participant.id !== directedTarget.id) {
        this.appendRoundStatus(
          wakeup.chatId,
          wakeup.roundId,
          `Directed round recovery blocked: participant "${round.dmTargetParticipantId}" is unavailable or does not own this wakeup.`
        )
        return false
      }
    }
    const recoveredFanoutPolicy =
      round.fanoutPolicy !== undefined || round.concurrentMode !== undefined
        ? resolveEnsembleFanoutPolicy(round)
        : resolveEnsembleFanoutPolicy(chat.ensemble)
    const recoveredQueuedEntries = this.restorePersistedQueuedEntries(round)
    const legacyQueuedPrompts =
      recoveredQueuedEntries === null
        ? [...(round.queuedPrompts || (round.queuedPrompt ? [round.queuedPrompt] : []))]
        : []
    const runtime: ActiveRoundRuntime = {
      chatId: wakeup.chatId,
      roundId: wakeup.roundId,
      sender,
      prompt: round.prompt,
      ...(round.dmTargetParticipantId
        ? { dmTargetParticipantId: round.dmTargetParticipantId }
        : {}),
      imageAttachments: [],
      imageThumbnails: [],
      cancelled: false,
      queuedPrompts: recoveredQueuedEntries || [],
      ...(legacyQueuedPrompts.length
        ? { quarantinedLegacyQueuedPrompts: legacyQueuedPrompts }
        : {}),
      orchestrationMode: round.orchestrationMode || chat.ensemble.orchestrationMode || 'turn_bound',
      fanoutPolicy: recoveredFanoutPolicy,
      ...(fanoutPolicyEnablesConcurrent(recoveredFanoutPolicy) ? { concurrentMode: true } : {}),
      continuationHops: round.continuationHops || 0,
      maxContinuationHops:
        round.maxContinuationHops ||
        chat.ensemble.maxContinuationHops ||
        DEFAULT_CONTINUATION_HOP_LIMIT,
      continuationPass: Math.max(1, round.continuationPass || 1),
      ...(chat.activeGoal
        ? {
            roundStartGoalId: chat.activeGoal.id,
            roundStartGoalWasTerminal: chat.activeGoal.status !== 'active'
          }
        : {}),
      pendingWakeups: new Map(
        Object.values(chat.ensemble.wakeups || {})
          .filter((entry) => entry.status === 'pending' && entry.roundId === wakeup.roundId)
          .map((entry) => [entry.wakeupId, entry])
      )
    }
    this.roundsByChatId.set(wakeup.chatId, runtime)
    const fired: EnsembleWakeupRecord = {
      ...wakeup,
      status: 'fired',
      firedAt: this.deps.nowIso(),
      message: 'recovered after app restart'
    }
    runtime.pendingWakeups?.delete(wakeup.wakeupId)
    runtime.resumeWakeup = fired
    this.saveWakeupRecord(chat, fired)
    this.updateSleepingRoundState(wakeup.chatId, wakeup.roundId)
    this.appendRoundStatus(
      wakeup.chatId,
      wakeup.roundId,
      `${participant.role || providerLabel(participant.provider)} woke after app restart (${wakeup.wakeAt}).`
    )
    if (legacyQueuedPrompts.length > 0) {
      this.appendRoundStatus(
        wakeup.chatId,
        wakeup.roundId,
        `${legacyQueuedPrompts.length} queued prompt${legacyQueuedPrompts.length === 1 ? '' : 's'} preserved but quarantined because restart-safe routing metadata is unavailable.`
      )
    }
    const attachmentQuarantineCount =
      recoveredQueuedEntries?.filter((entry) => entry.restartRecoveryBlockedReason).length || 0
    if (attachmentQuarantineCount > 0) {
      this.appendRoundStatus(
        wakeup.chatId,
        wakeup.roundId,
        `${attachmentQuarantineCount} queued attachment-bearing prompt${attachmentQuarantineCount === 1 ? '' : 's'} preserved but quarantined until the files are re-selected.`
      )
    }
    if (!participant.linkedProviderSessionId) {
      this.appendRoundStatus(
        wakeup.chatId,
        wakeup.roundId,
        `${participant.role || providerLabel(participant.provider)} is resuming from TaskWraith transcript context; no native provider session id was available.`
      )
    }
    void this.trackRoundActivity(
      runtime,
      this.runRound(runtime, [participant]).catch((error) =>
        this.failUnexpectedRound(runtime, error)
      )
    )
    return true
  }

  private findPendingWakeupForParticipant(
    chat: ChatRecord,
    roundId: string,
    participantId: string
  ): EnsembleWakeupRecord | null {
    return (
      Object.values(chat.ensemble?.wakeups || {}).find(
        (wakeup) =>
          wakeup.status === 'pending' &&
          wakeup.roundId === roundId &&
          wakeup.participantId === participantId
      ) || null
    )
  }

  private participantForWakeup(
    chat: ChatRecord | null | undefined,
    wakeup: EnsembleWakeupRecord
  ): EnsembleParticipant | null {
    const participant = chat?.ensemble?.participants.find(
      (entry) => entry.id === wakeup.participantId && entry.enabled
    )
    if (!participant) return null
    const hasFrozenStageRole = Object.prototype.hasOwnProperty.call(wakeup, 'stageRole')
    const stageRole = hasFrozenStageRole ? wakeup.stageRole : participant.stageRole
    const resolved: EnsembleParticipant = {
      ...participant,
      provider: wakeup.provider,
      role: wakeup.role ?? participant.role
    }
    if (stageRole) {
      resolved.stageRole = stageRole
    } else {
      delete resolved.stageRole
    }
    return resolved
  }

  private buildWakeupDispatchReceipt(
    chat: ChatRecord | null | undefined,
    wakeup: EnsembleWakeupRecord
  ): EnsembleWakeupRecord['dispatchReceipt'] {
    const scope = chat?.scope === 'global' ? 'global' : 'workspace'
    return buildRunQueueDispatchReceipt({
      runId: wakeup.wakeupId,
      provider: wakeup.provider,
      source: 'scheduled',
      scope,
      ...(chat?.workspaceId ? { workspaceId: chat.workspaceId } : {}),
      chatId: wakeup.chatId,
      ensembleParticipantId: wakeup.participantId,
      ...(wakeup.role ? { ensembleRole: wakeup.role } : {}),
      ...(wakeup.stageRole ? { ensembleStageRole: wakeup.stageRole } : {}),
      ...(wakeup.permissionPosture ? { permissionPosture: wakeup.permissionPosture } : {})
    })
  }

  private buildWakeupPermissionPosture(
    chat: ChatRecord,
    run: ActiveParticipantRun,
    runtime: ActiveRoundRuntime,
    wakeup: EnsembleWakeupRecord
  ): EnsembleWakeupRecord['permissionPosture'] {
    if (!this.deps.signRunPermissionPosture) return undefined
    const permissions = this.resolveParticipantPermissions(
      chat,
      run.participant,
      runtime.externalPathGrants,
      { ensembleLaneId: run.laneId }
    )
    const workflowMode = chat.workflowMode === 'plan' ? 'plan' : 'normal'
    const context: RunPermissionPostureContext = {
      provider: run.participant.provider,
      scope: chat.scope === 'global' ? 'global' : 'workspace',
      appRunId: wakeup.wakeupId,
      appChatId: wakeup.chatId,
      prompt: runtime.prompt,
      workflowMode,
      runtimeProfileId: run.participant.runtimeProfileId,
      ensembleParticipantId: run.participant.id,
      ensembleLaneId: run.laneId
    }
    return buildRunPermissionPostureSnapshot({
      approvalMode: permissions.approvalMode,
      workflowMode,
      effectivePermissions: permissions,
      signature: this.deps.signRunPermissionPosture(permissions.approvalMode, permissions, context),
      context
    })
  }

  private saveWakeupRecord(
    chat: ChatRecord | null | undefined,
    wakeup: EnsembleWakeupRecord
  ): void {
    if (!chat?.ensemble) return
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          wakeups: {
            ...(chat.ensemble.wakeups || {}),
            [wakeup.wakeupId]: wakeup
          },
          updatedAt: wakeup.firedAt || wakeup.cancelledAt || wakeup.expiredAt || wakeup.scheduledAt
        },
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
  }

  private markWakeupCancelled(wakeup: EnsembleWakeupRecord, message: string): EnsembleWakeupRecord {
    this.deps.cancelWakeupTimer?.(wakeup.wakeupId)
    const cancelled: EnsembleWakeupRecord = {
      ...wakeup,
      status: 'cancelled',
      cancelledAt: this.deps.nowIso(),
      message
    }
    this.saveWakeupRecord(this.deps.getChat(wakeup.chatId), cancelled)
    return cancelled
  }

  private cancelWakeupsForRuntime(runtime: ActiveRoundRuntime, message: string): void {
    const wakeups = Array.from(runtime.pendingWakeups?.values() || [])
    if (wakeups.length === 0) return
    for (const wakeup of wakeups) {
      this.markWakeupCancelled(wakeup, message)
    }
    runtime.pendingWakeups?.clear()
    runtime.readyWakeups = []
    this.updateSleepingRoundState(runtime.chatId, runtime.roundId)
    this.signalWakeWaiter(runtime)
  }

  private cancelWakeupsOnUserInput(runtime: ActiveRoundRuntime): void {
    const wakeups = Array.from(runtime.pendingWakeups?.values() || []).filter(
      (wakeup) => wakeup.cancelOnUserInput !== false
    )
    if (wakeups.length === 0) return
    for (const wakeup of wakeups) {
      this.markWakeupCancelled(wakeup, 'cancelled by user input')
      runtime.pendingWakeups?.delete(wakeup.wakeupId)
    }
    this.updateSleepingRoundState(runtime.chatId, runtime.roundId)
    this.signalWakeWaiter(runtime)
  }

  private cancelPersistedWakeupsOnUserInput(chatId: string): void {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return
    const wakeups = Object.values(chat.ensemble.wakeups || {}).filter(
      (wakeup) => wakeup.status === 'pending' && wakeup.cancelOnUserInput !== false
    )
    if (wakeups.length === 0) return
    const affectedRoundIds = new Set<string>()
    for (const wakeup of wakeups) {
      affectedRoundIds.add(wakeup.roundId)
      this.markWakeupCancelled(wakeup, 'cancelled by user input')
    }
    for (const roundId of affectedRoundIds) {
      this.updateSleepingRoundState(chatId, roundId)
    }
  }

  private updateSleepingRoundState(chatId: string, roundId: string): void {
    const chat = this.deps.getChat(chatId)
    const round = chat?.ensemble?.activeRound
    if (!chat?.ensemble || !round || round.roundId !== roundId) return
    const pending = Object.values(chat.ensemble.wakeups || {}).filter(
      (wakeup) => wakeup.status === 'pending' && wakeup.roundId === roundId
    )
    const pendingIds = new Set(pending.map((wakeup) => wakeup.wakeupId))
    const sleepingIds = new Set(pending.map((wakeup) => wakeup.participantId))
    const nextRound: EnsembleRoundState = {
      ...round,
      pendingWakeupIds: pendingIds.size ? Array.from(pendingIds) : undefined,
      sleepingParticipantIds: sleepingIds.size ? Array.from(sleepingIds) : undefined,
      participants: round.participants.map((participant) => {
        if (sleepingIds.has(participant.participantId)) {
          const wakeup = pending.find((entry) => entry.participantId === participant.participantId)
          return {
            ...participant,
            status: 'sleeping',
            reason: wakeup ? formatWakeupScheduledReason(wakeup) : participant.reason,
            endedAt: this.deps.nowIso()
          }
        }
        if (participant.status === 'sleeping') {
          return {
            ...participant,
            status: 'idle',
            reason: undefined,
            endedAt: undefined
          }
        }
        return participant
      })
    }
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          activeRound: nextRound,
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
  }

  private findRuntimeByWakeupId(
    wakeupId: string
  ): { runtime: ActiveRoundRuntime; wakeup: EnsembleWakeupRecord } | null {
    for (const runtime of this.roundsByChatId.values()) {
      const wakeup = runtime.pendingWakeups?.get(wakeupId)
      if (wakeup) return { runtime, wakeup }
    }
    return null
  }

  private hasPendingWakeups(runtime: ActiveRoundRuntime): boolean {
    return Boolean(runtime.pendingWakeups && runtime.pendingWakeups.size > 0)
  }

  private waitForNextWakeup(runtime: ActiveRoundRuntime): Promise<EnsembleWakeupRecord | null> {
    const ready = runtime.readyWakeups?.shift()
    if (ready) return Promise.resolve(ready)
    if (!this.hasPendingWakeups(runtime)) return Promise.resolve(null)
    return new Promise((resolve) => {
      runtime.wakeWaiter = () => {
        runtime.wakeWaiter = undefined
        resolve(runtime.readyWakeups?.shift() || null)
      }
    })
  }

  private signalWakeWaiter(runtime: ActiveRoundRuntime): void {
    const waiter = runtime.wakeWaiter
    if (waiter) waiter()
  }

  /**
   * Forward a provider's live usage signal to the active participant's working
   * indicator. This is intentionally a best-effort UI lane: it neither writes
   * ChatRun.stats nor flushes/broadcasts a ChatRecord. The per-run maxima make
   * the counter an accumulator even when a provider reports a context snapshot
   * that shrinks after compaction.
   */
  reportParticipantTokenUsage(
    runId: string | undefined,
    stats: Record<string, unknown> | null | undefined,
    source?: { provider?: ProviderId; chatId?: string }
  ): boolean {
    if (!runId || !stats || typeof stats !== 'object' || Array.isArray(stats)) return false
    const run = this.actionableRunForTool(runId)
    if (!run) return false
    if (source?.provider && run.participant.provider !== source.provider) return false
    if (source?.chatId && run.chatId !== source.chatId) return false
    this.touchCursorCompletionWatchdog(run)

    const previous = this.participantWorkingTelemetryByRunId.get(runId)
    const inputTokens = Math.max(
      previous?.inputTokens || 0,
      numericRunStat(stats, 'input_tokens', 'inputTokens')
    )
    const outputTokens = Math.max(
      previous?.outputTokens || 0,
      numericRunStat(stats, 'output_tokens', 'outputTokens')
    )
    const totalTokens = Math.max(
      previous?.totalTokens || 0,
      numericRunStat(stats, 'total_tokens', 'totalTokens'),
      inputTokens + outputTokens
    )
    const contextUsage = contextUsageFromStats(stats) || undefined
    if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0 && !contextUsage) return false

    // Estimated only while EVERY report so far was an estimate — the first
    // authoritative provider snapshot flips the seat to authoritative for good.
    const estimated = statsAreEstimated(stats) && (previous ? previous.estimated : true)
    const pressureTokens = Math.max(totalTokens, contextUsage?.contextTokens || 0)
    if (run.participant.provider === 'cursor' && pressureTokens > 0) {
      this.cursorCompletionWatchdog.noteTokenSample(runId, pressureTokens)
    }

    const now = this.deps.now()
    const changed =
      !previous ||
      inputTokens !== previous.inputTokens ||
      outputTokens !== previous.outputTokens ||
      totalTokens !== previous.totalTokens ||
      estimated !== previous.estimated ||
      !contextUsageSnapshotsEqual(contextUsage, previous.contextUsage)
    // Always retain the latest sample for Cursor pressure recovery even when no
    // working-telemetry listener is wired (tests / headless embedders).
    if (changed || !previous) {
      this.participantWorkingTelemetryByRunId.set(runId, {
        sentAt: now,
        inputTokens,
        outputTokens,
        totalTokens,
        estimated,
        contextUsage
      })
    }

    const telemetry = this.deps.onParticipantWorkingTelemetry
    if (!telemetry) return true
    if (!changed) return true
    if (previous && now - previous.sentAt < PARTICIPANT_WORKING_TELEMETRY_MIN_INTERVAL_MS) {
      return true
    }
    telemetry({
      type: 'snapshot',
      chatId: run.chatId,
      roundId: run.roundId,
      participantId: run.participant.id,
      runId,
      startedAt: run.startedAt,
      provider: run.participant.provider,
      inputTokens,
      outputTokens,
      totalTokens,
      estimated,
      ...(contextUsage ? { contextUsage } : {})
    })
    return true
  }

  /**
   * Record provider-authored context-overflow evidence for an ACTIVE ensemble
   * run. The route and provider checks keep solo/stale/cross-provider stderr
   * from influencing a seat. Classification is intentionally delegated only
   * to the shared narrow matcher (quota and generic token errors stay out).
   */
  noteProviderFailureText(
    provider: ProviderId,
    routed: AgentRunRoute,
    text: string | undefined | null
  ): boolean {
    const runId = routed.appRunId
    if (!runId) return false
    const run = this.actionableRunForTool(runId)
    if (!run || run.participant.provider !== provider) return false
    if (routed.appChatId && routed.appChatId !== run.chatId) return false
    if (provider === 'antigravity' && isAntigravityHeadlessPermissionNoOutput(text)) {
      run.providerDiagnostic = ANTIGRAVITY_HEADLESS_PERMISSION_NO_OUTPUT_REASON
      return true
    }
    if (!isHostSeatCompactionProvider(provider)) return false
    if (!isContextOverflowErrorText(text)) return false
    run.classifiedContextOverflow = true
    return true
  }

  markRunExited(runId: string | undefined, exitCode: number): boolean {
    if (!runId) return false
    const run = this.actionableRunForTool(runId)
    if (!run || run.status === 'answered' || run.status === 'yielded') return false
    // A clean exit (code 0) that already streamed content is a FINISHED turn,
    // not a skip — mirror the result-event path (which finalizes 'answered' when
    // run.content.trim() is non-empty). Without this, a seat that emitted its
    // answer and then exited 0 (e.g. after the Ollama retry-ceiling finalize,
    // where the exit can be processed before the result event) is mislabeled
    // 'skipped', losing the turn from the panel.
    if (exitCode === 0 && run.content.trim().length > 0) {
      this.finalizeRun(run, 'answered')
      return true
    }
    const status: EnsembleParticipantStatus =
      exitCode === 0 && !run.providerDiagnostic ? 'skipped' : 'failed'
    this.finalizeRun(
      run,
      status,
      run.providerDiagnostic ||
        (exitCode === 0 ? 'Exited without result.' : `Exited with code ${exitCode}.`)
    )
    return true
  }

  handleProviderOutput(provider: ProviderId, routed: AgentRunRoute, payload: any): boolean {
    const runId = routed.appRunId
    if (!runId) return false
    const run = this.actionableRunForTool(runId)
    if (!run || run.participant.provider !== provider) return false
    if (routed.appChatId && routed.appChatId !== run.chatId) return false
    this.touchCursorCompletionWatchdog(run)

    const sessionId = extractProviderSessionId(payload)
    if (sessionId) run.providerSessionId = sessionId
    if (payload?.type === 'init' && typeof payload.model === 'string') {
      run.actualModel = payload.model
      this.flushRun(run)
      return true
    }
    // Agent-produced image (image_edit/svg_rasterize/image_generate tool result).
    // The run is already resolved by appRunId above, so there's no cross-
    // attribution ambiguity here (unlike the renderer's trailing-message path,
    // which is why that one is suppressed for ensemble). Accumulate + flush; the
    // refs land on this participant's last content message in flushRun.
    if (payload?.type === 'media_refs' && Array.isArray(payload.mediaRefs)) {
      // RAW provider lane: these refs come straight from provider stdout, so a
      // hostile/compromised provider controls every field. Sanitize before
      // trusting any of it — drop unsafe `path`s, oversize/non-raster
      // thumbnails, svg/unknown mimes, and bogus sources (see
      // src/shared/transcriptMediaRefSanitize.ts). The sanitized main-side lane
      // (createToolResultMediaRefs) is unaffected — its output re-validates
      // cleanly here.
      const incoming = sanitizeRawProviderMediaRefs(payload.mediaRefs)
      if (incoming.length > 0) {
        run.mediaRefs = mergeTranscriptMediaRefs(run.mediaRefs, incoming)
        this.flushRun(run)
      }
      return true
    }
    // Provider context compaction (src/shared/contextCompaction.ts). Ensemble
    // transcripts are orchestrator-canonical, so the card is persisted HERE
    // (the renderer's compaction_notice branch skips ensemble chats). Consumed
    // either way so the signal never falls through to the content lanes.
    if (payload?.type === 'compaction_event') {
      const signal = payload.compaction as ContextCompactionSignal | undefined
      if (
        signal &&
        typeof signal === 'object' &&
        (signal.kind === 'started' || signal.kind === 'completed' || signal.kind === 'failed')
      ) {
        const telemetry =
          signal.telemetry && typeof signal.telemetry === 'object' ? signal.telemetry : {}
        const normalizedSignal: ContextCompactionSignal = {
          kind: signal.kind,
          telemetry
        }
        this.emitSeatCompactionProgress(
          run.chatId,
          run.participant,
          normalizedSignal.kind,
          normalizedSignal.telemetry.trigger || 'auto'
        )
        if (normalizedSignal.kind === 'completed') {
          // Native compaction rewrites the provider's retained context. Clear
          // any prior dynamic-state acknowledgement immediately and prevent
          // this run's final flush from re-acknowledging the pre-compaction
          // candidate. The next resumed turn will carry a replacement snapshot.
          run.invalidatePromptShellReceipt = true
          run.invalidatePromptDynamicStateReceipt = true
          this.flushRun(run)
        }
        if (normalizedSignal.kind !== 'started') {
          this.appendContextCompactionCard(run, runId, normalizedSignal)
        }
      }
      return true
    }
    // 1.0.5-EW16 — Accept `payload.content` as a fallback when
    // `payload.text` is missing. Gemini CLI emits both shapes
    // depending on internal state; the renderer's GeminiAdapter
    // handles them via `parsed.text || parsed.content` (see
    // GeminiAdapter.ts:99). Pre-EW16 the orchestrator only
    // checked `payload.text`, so `{ type: 'content', content: '…' }`
    // events were silently dropped — run.content stayed empty,
    // flushRun's content-trim guard skipped the assistant message
    // append, and the transcript stayed blank even though Gemini
    // was clearly streaming (timer kept resetting because events
    // ARE arriving, just with the wrong field name).
    if (
      payload?.type === 'content' &&
      (typeof payload.text === 'string' || typeof payload.content === 'string')
    ) {
      const itemId =
        typeof payload.itemId === 'string' && payload.itemId ? payload.itemId : undefined
      const text =
        typeof payload.text === 'string' && payload.text
          ? payload.text
          : typeof payload.content === 'string'
            ? payload.content
            : ''
      if (text) {
        const taggedCumulative = isTaggedCumulativeRestatement(payload)
        const itemTransition =
          itemId !== undefined &&
          run.lastContentItemId !== undefined &&
          itemId !== run.lastContentItemId &&
          run.content.length > 0
        const chunk = `${itemTransition ? '\n\n---\n\n' : ''}${text}`
        const appended = appendProviderContent(run, chunk, {
          trustedIncremental: !taggedCumulative,
          claudeCumulative: payload.cumulative === true
        })
        if (itemId) run.lastContentItemId = itemId
        if (appended) this.scheduleFlush(run)
      } else if (itemId) {
        run.lastContentItemId = itemId
      }
      return true
    }
    // 1.0.5-EW16 — Gemini CLI also emits `{ type: 'token',
    // content: '…' }` events (see GeminiAdapter.ts:158-162 for
    // the renderer-side handling). Pre-EW16 the orchestrator
    // had no branch for `'token'` and these silently fell through
    // to the final `return true` — token-streamed turns went into
    // the transcript as empty assistant bubbles. Treat token
    // events as plain delta chunks.
    if (payload?.type === 'token' && typeof payload.content === 'string') {
      const text = payload.content
      if (text) {
        const appended = appendProviderContent(run, text, {
          trustedIncremental: !isTaggedCumulativeRestatement(payload),
          claudeCumulative: payload.cumulative === true
        })
        if (appended) this.scheduleFlush(run)
      }
      return true
    }
    // Gemini CLI fallback path emits `{ type: 'message', role: 'assistant',
    // delta: true, content }` events instead of `{ type: 'content', text }`.
    // Without this branch the orchestrator never accumulates anything for
    // Gemini participants in ensemble mode — `run.content` stays empty,
    // `flushRun()` skips the assistant-message append (`if
    // (run.content.trim())`), and the authoritative chat save clobbers
    // whatever the renderer had locally appended from the same delta
    // stream. Symptom: Gemini's turn appears as "still working…" forever,
    // raw logs full of deltas, transcript empty. Codex / Claude / Kimi
    // are unaffected — they all emit `type: 'content'`.
    //
    // 1.0.4-AB — non-delta finals are NOT auto-appended any more.
    // Previously a closing `{ type: 'message', role: 'assistant',
    // content: <full text> }` arriving AFTER a stream of `delta:true`
    // chunks would re-append the entire turn, doubling the assistant
    // bubble (the maintainer's "(And — same ECONNREFUSED…)" paragraph showing
    // up twice). Two cases now:
    //   (a) `delta === true` → streamed chunk, always append.
    //   (b) no `delta` flag → treat as authoritative ONLY when we
    //       haven't accumulated anything yet. If we already have
    //       content, the non-delta is the trailing repeat the
    //       provider emits for parity with non-streaming clients,
    //       and we ignore it. The trailing `type: 'result'` event
    //       still drives finalisation via the branch below.
    if (
      payload?.type === 'message' &&
      payload?.role === 'assistant' &&
      typeof payload.content === 'string'
    ) {
      const text = payload.content
      if (text) {
        const isDelta = payload.delta === true
        if (isDelta) {
          if (appendProviderContent(run, text, { trustedIncremental: true })) {
            this.scheduleFlush(run)
          }
        } else if (run.content.length === 0) {
          // First and only message-shape payload for this turn —
          // treat as the authoritative body.
          run.content = text
          appendTimelineContent(run, text)
          this.scheduleFlush(run)
        }
        // else: non-delta repeat-of-deltas → drop on the floor.
      }
      return true
    }
    if (payload?.type === 'tool_use' || payload?.type === 'tool_call') {
      // Tool calls in ensemble mode previously vanished — the renderer-
      // side tool accumulator (App.tsx:10292+) only runs for solo runs
      // (the active-run-context registry is populated by `executeRun`
      // which ensemble doesn't go through). Without an orchestrator-
      // side persist, tool messages never landed in the authoritative
      // chat.messages, so the transcript stayed silent even when
      // participants used tools. Build the activity, push it into
      // the run's timeline at the current position so flushRun can
      // emit it inline between content chunks.
      const activity = buildEnsembleToolActivity(
        payload,
        this.deps.nowIso(),
        run.participant,
        this.deps.getChat(run.chatId)?.ensemble?.participants
      )
      const upsert = upsertEnsembleToolUseActivity(run, activity)
      if (upsert === 'inserted') {
        appendTimelineTool(run, activity.id)
      }
      // Diagnostic for the 1.0.3 ship-night investigation — single
      // line per event, low volume, safe to leave in.

      console.log(
        `[ensemble:tool_use] provider=${provider} run=${run.runId} tool=${activity.toolName} id=${activity.id}`
      )
      this.scheduleFlush(run)
      return true
    }
    if (
      payload?.type === 'tool_result' ||
      payload?.type === 'tool_output' ||
      payload?.type === 'tool_response'
    ) {
      if (!run.toolActivities || run.toolActivities.length === 0) return true
      const id = extractToolId(payload)
      const idx = run.toolActivities.findIndex((a) => a.id === id)
      if (idx >= 0) {
        const activity = run.toolActivities[idx]
        run.toolActivities[idx] = pairEnsembleToolResult(activity, payload, this.deps.nowIso())
        // Managed Cursor Path-B streams the visible MCP-shaped yield call and
        // its tool result through provider output, rather than invoking the
        // TaskWraith MCP dispatcher. Pairing the result alone leaves the
        // orchestrator waiting forever for a canonical provider `result`.
        // Treat every completed streamed yield as an explicit terminal turn;
        // markYielded performs routing and records rejected/ambiguous targets
        // while still releasing rotation.
        if (
          provider === 'cursor' &&
          !run.terminalFinalized &&
          stripToolNamespace(activity.toolName) === 'ensemble_yield'
        ) {
          const reason = getStringParameter(activity.parameters || {}, ['reason', 'message'])
          const target = getStringParameter(activity.parameters || {}, [
            'target',
            'participant',
            'to',
            'next'
          ])
          this.markYielded(run.runId, reason || undefined, target || undefined)
          return true
        }
      } else {
        // Orphan result — pair with a synthetic activity so the
        // outcome still surfaces. Same pattern as the renderer's
        // fallback at App.tsx:10336.
        const orphan = buildEnsembleToolActivity(
          { ...payload, type: 'tool_use', tool_id: id },
          this.deps.nowIso(),
          run.participant,
          this.deps.getChat(run.chatId)?.ensemble?.participants
        )
        run.toolActivities.push(pairEnsembleToolResult(orphan, payload, this.deps.nowIso()))
      }
      this.scheduleFlush(run)
      return true
    }
    if (payload?.type === 'result') {
      run.stats = payload.stats
      const failed = payload.status === 'failed' || payload.subtype === 'error'
      // 1.0.7 — record this participant's usage into the shared store so
      // ensemble runs count toward the welcome wall-clock, activity heatmaps,
      // and Providers-tab token totals (solo runs record via the renderer's
      // handleProviderExit; ensemble runs complete here instead). Skipped/
      // already-recorded runs return null from the builder. Best-effort: a
      // recording failure must never break round finalisation.
      this.recordParticipantUsage(run)
      // Kimi Wire can publish a provisional success notification before the
      // child process has actually closed. Quota/auth failures may arrive on
      // stderr immediately afterward, followed by a failed result + exit 1.
      // Let that final wire outcome settle the participant instead of deleting
      // the active run here as an empty-output "skipped" turn.
      if (
        provider === 'kimi' &&
        !failed &&
        payload.fallback === false &&
        payload.subtype === 'success'
      ) {
        return true
      }
      const emptyAfterProviderDiagnostic =
        Boolean(run.providerDiagnostic) && run.content.trim().length === 0
      this.finalizeRun(
        run,
        failed || emptyAfterProviderDiagnostic
          ? 'failed'
          : run.content.trim()
            ? 'answered'
            : 'skipped',
        failed || emptyAfterProviderDiagnostic ? run.providerDiagnostic : undefined
      )
      return true
    }
    return true
  }

  private beginRound(
    chatId: string,
    prompt: string,
    sender: Electron.WebContents,
    dmTargetParticipantId?: string,
    imageAttachments: EnsembleImageAttachment[] = [],
    imageThumbnails: EnsembleImageThumbnail[] = [],
    /**
     * Carry-over queue from a previous round's `queuedPrompts` (FIFO
     * after we shifted off `prompt`). Lets the chain continue
     * through every queued message until the queue drains.
     *
     * 1.0.5-EW43a — structured entries (was `string[]` pre-EW43a)
     * so per-entry image attachments propagate through every
     * follow-up round, not just the first. Persistence keeps a prompt-only
     * renderer mirror alongside the structured recovery record.
     */
    carryOverQueue: QueuedRoundEntry[] = [],
    /**
     * 1.0.4-AF — `/discuss` (alias `/meta`) prefix detected at
     * startRound. Stashed on the runtime so every
     * `buildEnsembleParticipantPrompt` call this round sees the
     * inverted deictic rule. Persistent toggling of the EnsembleConfig
     * flag is a separate concern handled outside this path.
     */
    selfReflective = false,
    /**
     * 1.0.4-AT4 — composer-level external path grants captured at
     * `startRound`. Lands on the runtime so each participant's
     * `resolveParticipantPermissions` can merge it into
     * `resolveEffectiveRunPermissions` via
     * `explicitExternalPathGrants`. The resolver's existing
     * provider filter ensures each participant only sees grants
     * tagged for its own provider.
     */
    externalPathGrants: ExternalPathGrant[] = [],
    concurrentMode?: boolean,
    fanoutPolicy?: EnsembleFanoutPolicy,
    discordContextSnapshotsInput?: DiscordContextSnapshot[],
    unattended?: boolean,
    unattendedElevationLevel?: UnattendedElevationLevel,
    startAfterCancellation?: Promise<unknown>,
    onRoundReserved?: (roundId: string) => void,
    prepareFreshChat?: (chat: ChatRecord) => ChatRecord,
    projectReferenceContextSelection?: ProjectReferenceContextSelection
  ): string {
    const storedChat = this.deps.getChat(chatId)
    if (!storedChat?.ensemble) throw new Error('Ensemble chat not found.')
    const chat = prepareFreshChat ? prepareFreshChat(storedChat) : storedChat
    if (
      !chat?.ensemble ||
      chat.appChatId !== storedChat.appChatId ||
      chat.workspaceId !== storedChat.workspaceId ||
      chat.workspacePath !== storedChat.workspacePath ||
      chat.scope !== storedChat.scope ||
      chat.chatKind !== storedChat.chatKind
    ) {
      throw new Error('Prepared Ensemble chat changed immutable round authority.')
    }
    const roundId = `ensemble-${this.deps.now()}-${Math.random().toString(36).slice(2)}`
    const orderedFull = getOrderedEnsembleParticipants(chat.ensemble, prompt)
    // A2 (1.0.3) — when DM, filter to just the targeted participant.
    // We still allow disabled participants when explicitly targeted —
    // the user clicked their chip and held Cmd, that's an unambiguous
    // intent. Unknown ids fail closed; widening a stale directed request to
    // the full roster would violate the user's routing boundary.
    const dmTargetParticipant = dmTargetParticipantId
      ? chat.ensemble.participants.find((participant) => participant.id === dmTargetParticipantId)
      : undefined
    if (dmTargetParticipantId && !dmTargetParticipant) {
      throw new Error(
        `Directed Ensemble target "${dmTargetParticipantId}" is no longer in the roster.`
      )
    }
    const requestedParticipants = dmTargetParticipant ? [dmTargetParticipant] : orderedFull
    const backgroundMentionResolution = resolveBackgroundMentions(
      prompt,
      chat.ensemble.participants
    )
    const backgroundParticipants = requestedParticipants.filter(
      (participant) =>
        isBackgroundParticipant(participant) &&
        (participant.id === dmTargetParticipant?.id ||
          backgroundMentionResolution.participantIds.has(participant.id))
    )
    // Background seats are rostered and addressable, but never consume an
    // ordinary serial/review-wave turn. Only explicitly addressed seats enter
    // this round, and they enter through detached lanes below.
    const ordered = requestedParticipants.filter(
      (participant) => !isBackgroundParticipant(participant)
    )
    const roundParticipants = [...ordered, ...backgroundParticipants]
    const startedAt = this.deps.nowIso()
    const normalizedImageAttachments = normalizeEnsembleImageAttachments(imageAttachments)
    const normalizedImageThumbnails = normalizeEnsembleImageThumbnails(imageThumbnails)
    const discordContextSnapshots = normalizeDiscordContextSnapshots(discordContextSnapshotsInput)
    const discordContextReads = discordContextSnapshots.map((snapshot) =>
      redactDiscordContextReadMetadataForHistory(snapshot.metadata)
    )
    const promptForParticipants = promptWithAttachmentReferences(prompt, normalizedImageAttachments)
    const orchestrationMode = resolveEnsembleOrchestrationMode(chat.ensemble)
    const maxContinuationHops = resolveMaxContinuationHops(chat.ensemble)
    // Directed user rounds are a hard routing boundary. Clamp fan-out here as
    // defence-in-depth even when an older or remote caller forgets to do so;
    // otherwise a one-participant DM can inherit a roster-wide concurrent
    // policy, either widening scope or failing the concurrent participant
    // count check below.
    const requestedFanoutPolicy = dmTargetParticipant
      ? 'off'
      : resolveRequestedEnsembleFanoutPolicy(chat.ensemble, {
          concurrentMode,
          fanoutPolicy
        })
    const requestedConcurrentMode = fanoutPolicyEnablesConcurrent(requestedFanoutPolicy)
    const concurrentCheck = canStartConcurrentRound({
      concurrentLanesEnabled: concurrentLanesEnabled(),
      chatIsEnsemble: true,
      requestedConcurrentMode,
      // BG seats still count as valid enabled panel members for the feature
      // gate even when this particular prompt did not delegate one. Otherwise
      // a common Lead + BG roster would fail to start whenever Read fan-out is
      // selected, despite safely running the lone foreground seat serially.
      enabledParticipantCount: requestedParticipants.length
    })
    let effectiveConcurrentMode = requestedConcurrentMode
    let effectiveFanoutPolicy = requestedFanoutPolicy
    let concurrentFallbackReason: string | undefined
    if (!concurrentCheck.ok) {
      if (
        requestedConcurrentMode &&
        concurrentCheck.reason?.includes('TASKWRAITH_CONCURRENT_LANES')
      ) {
        effectiveConcurrentMode = false
        effectiveFanoutPolicy = 'off'
        concurrentFallbackReason = concurrentCheck.reason
      } else {
        throw new Error(concurrentCheck.reason || 'Concurrent Ensemble dispatch is not available.')
      }
    }
    const captainParticipantIds = configuredEnsembleCaptainParticipantIds({
      participants: chat.ensemble.participants,
      bossmanParticipantId: chat.ensemble.bossmanParticipantId,
      captainParticipantIds: chat.ensemble.captainParticipantIds,
      secondInCommandParticipantId: chat.ensemble.secondInCommandParticipantId
    })
    const secondInCommandParticipantId = captainParticipantIds[0]
    const round: EnsembleRoundState = {
      roundId,
      status: 'running',
      prompt,
      startedAt,
      ...(dmTargetParticipant ? { dmTargetParticipantId: dmTargetParticipant.id } : {}),
      orchestrationMode,
      continuationHops: 0,
      maxContinuationHops,
      continuationPass: 1,
      ...(chat.ensemble.bossmanParticipantId
        ? { bossmanParticipantId: chat.ensemble.bossmanParticipantId }
        : {}),
      captainParticipantIds,
      ...(secondInCommandParticipantId ? { secondInCommandParticipantId } : {}),
      bossmanBaselineParticipantIds: roundParticipants.map((participant) => participant.id),
      bossmanBaselineParticipantCount: roundParticipants.length,
      ...(effectiveConcurrentMode ? { concurrentMode: true } : {}),
      fanoutPolicy: effectiveFanoutPolicy,
      participants: roundParticipants.map((participant) =>
        roundParticipantStateFromParticipant(participant, 'idle')
      ),
      // Surface any carry-over queue on the chat record so the
      // renderer's queued-messages above-row reflects everything
      // still pending. Mirrors `runtime.queuedPrompts` below.
      //
      // Persist the string queue for renderer back-compat and the structured
      // queue for restart recovery or explicit quarantine.
      ...(carryOverQueue.length > 0
        ? {
            ...this.queuedPromptFields(carryOverQueue)
          }
        : {})
    }
    const userMessage: ChatMessage = {
      id: `ensemble-user-${roundId}`,
      role: 'user',
      content: prompt,
      timestamp: startedAt,
      metadata: {
        kind: 'ensembleRoundPrompt',
        ensembleRoundId: roundId,
        ...(normalizedImageAttachments.length
          ? {
              imageAttachments: normalizedImageAttachments,
              imagePaths: imagePathsForEnsembleAttachments(normalizedImageAttachments)
            }
          : {}),
        ...(normalizedImageThumbnails.length ? { imageThumbnails: normalizedImageThumbnails } : {}),
        ...(discordContextReads.length > 0 ? { discordContextReads } : {})
      }
    }
    const toolMessages =
      discordContextReads.length > 0
        ? [createDiscordContextToolMessage(discordContextReads, startedAt)]
        : []
    const updated: ChatRecord = {
      ...chat,
      title:
        chat.messages.length === 0 && chat.title === 'New Ensemble'
          ? prompt.length > 30
            ? `${prompt.slice(0, 30)}...`
            : prompt
          : chat.title,
      messages: [...chat.messages, userMessage, ...toolMessages],
      ensemble: {
        ...chat.ensemble,
        activeRound: round,
        updatedAt: startedAt
      },
      updatedAt: this.deps.now()
    }
    this.saveChatWithCheckpoint(updated, 'round-started')
    const runtime: ActiveRoundRuntime = {
      chatId,
      roundId,
      sender,
      prompt: promptForParticipants,
      ...(dmTargetParticipant ? { dmTargetParticipantId: dmTargetParticipant.id } : {}),
      imageAttachments: normalizedImageAttachments,
      imageThumbnails: normalizedImageThumbnails,
      ...(discordContextSnapshots.length > 0 ? { discordContextSnapshots } : {}),
      cancelled: false,
      queuedPrompts: [...carryOverQueue],
      ...(chat.ensemble.bossmanParticipantId
        ? { bossmanParticipantId: chat.ensemble.bossmanParticipantId }
        : {}),
      captainParticipantIds,
      ...(secondInCommandParticipantId ? { secondInCommandParticipantId } : {}),
      bossmanBaselineParticipantIds: roundParticipants.map((participant) => participant.id),
      bossmanBaselineParticipantCount: roundParticipants.length,
      ...(chat.activeGoal
        ? {
            roundStartGoalId: chat.activeGoal.id,
            roundStartGoalWasTerminal: chat.activeGoal.status !== 'active'
          }
        : {}),
      orchestrationMode,
      fanoutPolicy: effectiveFanoutPolicy,
      ...(effectiveConcurrentMode ? { concurrentMode: true } : {}),
      continuationHops: 0,
      maxContinuationHops,
      continuationPass: 1,
      ...(startAfterCancellation ? { startAfterCancellation } : {}),
      ...(selfReflective ? { selfReflective: true } : {}),
      ...(externalPathGrants.length > 0 ? { externalPathGrants: [...externalPathGrants] } : {}),
      ...(projectReferenceContextSelection
        ? { projectReferenceContextSelection }
        : {}),
      ...(unattended ? { unattended: true } : {}),
      ...(unattended && unattendedElevationLevel ? { unattendedElevationLevel } : {})
    }
    this.roundsByChatId.set(chatId, runtime)
    try {
      onRoundReserved?.(roundId)
      for (const mention of backgroundMentionResolution.ambiguities) {
        const candidates = [mention.participant, ...(mention.ambiguousAmong || [])]
        this.appendRoundStatus(
          chatId,
          roundId,
          `@-mention: \`@${mention.text}\` was ambiguous (${candidates
            .map((participant) => participantDisplayName(participant))
            .join(', ')}). No background lane launched. Use a unique @role, @model, or @id.`
        )
      }
      const configuredCaptainParticipantIds = Array.isArray(chat.ensemble.captainParticipantIds)
        ? chat.ensemble.captainParticipantIds
        : chat.ensemble.secondInCommandParticipantId
          ? [chat.ensemble.secondInCommandParticipantId]
          : []
      const backgroundAuthorityAssignments = [
        ['Boss', chat.ensemble.bossmanParticipantId],
        ...configuredCaptainParticipantIds.map((participantId): [string, string] => [
          'Captain',
          participantId
        ]),
        ['synthesizer', chat.ensemble.synthesizerParticipantId]
      ]
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .filter(([, participantId]) =>
          chat.ensemble!.participants.some(
            (participant) =>
              participant.id === participantId && isBackgroundParticipant(participant)
          )
        )
      if (backgroundAuthorityAssignments.length > 0) {
        this.appendRoundStatus(
          chatId,
          roundId,
          `BG seats cannot own Ensemble authority; ignored ${backgroundAuthorityAssignments
            .map(([role, participantId]) => `${role}=${participantId}`)
            .join(', ')} for this round.`
        )
      }
      if (ordered.length === 0 && backgroundParticipants.length === 0) {
        this.appendRoundStatus(
          chatId,
          roundId,
          'No foreground participant was scheduled. @mention a BG seat explicitly, or change at least one participant Stage to Any, Scout, Work, or Review.'
        )
      }
      if (concurrentFallbackReason) {
        this.appendRoundStatus(
          chatId,
          roundId,
          'Fan-out requested but parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0) — running participants serially.'
        )
      }
      void this.trackRoundActivity(
        runtime,
        this.runRound(runtime, ordered, { backgroundParticipants }).catch((error) =>
          this.failUnexpectedRound(runtime, error)
        )
      )
    } catch (error) {
      this.failUnexpectedRound(runtime, error)
      throw error
    }
    return roundId
  }

  private failUnexpectedRound(runtime: ActiveRoundRuntime, error: unknown): void {
    const current = this.roundsByChatId.get(runtime.chatId)
    const activeRound = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
    if (
      current !== runtime ||
      runtime.cancelled ||
      activeRound?.roundId !== runtime.roundId ||
      activeRound.status !== 'running'
    ) {
      return
    }
    runtime.cancelled = true
    const reason = `Ensemble round failed before completion: ${
      error instanceof Error ? error.message : String(error)
    }`
    this.deferredLaneDrainByChatId.delete(runtime.chatId)
    runtime.fanoutReservedParticipantIds = undefined
    runtime.userFanoutDispatchSettlements = undefined
    runtime.userFanoutSerialParticipantIds = undefined
    try {
      this.cancelWakeupsForRuntime(runtime, reason)
    } catch {
      // Wakeup cleanup is best-effort; terminal round ownership must continue.
    }
    const seededRuns = [...this.runsByRunId.values()]
      .filter((run) => run.chatId === runtime.chatId && run.roundId === runtime.roundId)
      // Drain lanes first so an owner holding their settlement can finalize.
      .sort((left, right) => Number(Boolean(right.laneId)) - Number(Boolean(left.laneId)))
    for (const run of seededRuns) {
      try {
        this.finalizeRun(run, 'failed', reason)
      } catch {
        this.runsByRunId.delete(run.runId)
      }
      try {
        void Promise.resolve(this.deps.cancelRun(run.participant.provider, run.runId)).catch(
          () => undefined
        )
      } catch {
        // A malformed synchronous cancellation dependency cannot interrupt
        // the terminal round transition.
      }
    }
    runtime.activeRunId = undefined
    runtime.activeScoutRunIds = undefined
    try {
      this.appendRoundStatus(runtime.chatId, runtime.roundId, reason)
    } catch {
      // The terminal transition below remains authoritative when the status
      // annotation itself cannot be persisted.
    }
    try {
      this.finishRound(runtime.chatId, runtime.roundId, 'failed')
    } catch {
      // If the round projection cannot be persisted, still notify terminal
      // ownership. The callback itself is guarded by completeCheckpoint.
      this.completeCheckpoint(runtime.chatId, runtime.roundId, 'failed')
    } finally {
      this.clearRuntimeIfCurrent(runtime)
    }
  }

  /**
   * Tree-derived churn stanza for the seat about to be dispatched, or undefined.
   *
   * Exactly ONE git sample per dispatch: the first dispatch of a round stores
   * its sample as the baseline and returns nothing (definitionally, no seat has
   * written yet), and every later dispatch subtracts the baseline from a fresh
   * sample. That keeps the added cost to one `git diff --numstat` plus one
   * `git status` per turn, and makes the opening turn free.
   *
   * Fails open in every direction — no workspace, no repository, a git error, or
   * a throw all yield undefined, and the prompt simply omits the section. This
   * is evidence, not a gate: it must never be able to block a dispatch.
   */
  private async resolveWorkspaceChurnStanza(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord
  ): Promise<string | undefined> {
    const workspacePath = (chat.workspacePath || '').trim()
    if (!workspacePath) return undefined
    // A prior attempt already failed for this round; do not retry per dispatch.
    if (runtime.workspaceChurnBaseline === null) return undefined
    try {
      const sample = await (this.deps.sampleWorkspaceChurn || sampleWorkspaceChurn)(workspacePath)
      if (!sample) {
        runtime.workspaceChurnBaseline = null
        return undefined
      }
      const baseline = runtime.workspaceChurnBaseline
      if (!baseline) {
        runtime.workspaceChurnBaseline = sample
        return undefined
      }
      return (
        formatWorkspaceChurnStanza(diffWorkspaceChurn(baseline, sample), {
          heading:
            'Workspace changes so far this round (tree-derived — this is what the files actually hold):'
        }) || undefined
      )
    } catch {
      runtime.workspaceChurnBaseline = null
      return undefined
    }
  }

  /**
   * Progressive skill discovery + SessionStart stdout for ensemble seat prompts.
   * Global / missing workspace paths return empty (PromptComposition parity).
   */
  private async resolveParticipantSkillHookContext(
    chat: ChatRecord
  ): Promise<RunSkillHookContext> {
    const isGlobalRun = (chat.scope ?? 'workspace') === 'global'
    const workspacePath =
      !isGlobalRun && typeof chat.workspacePath === 'string' ? chat.workspacePath.trim() : ''
    if (!workspacePath) return {}
    return resolveRunSkillHookContext({
      workspacePath,
      workspaceId: chat.workspaceId || undefined,
      isGlobalRun: false,
      allowWorkspaceHooks: this.deps.getSettings().trustWorkspaceHooks === true
    })
  }

  private async runRound(
    runtime: ActiveRoundRuntime,
    participants: EnsembleParticipant[],
    // `skipPreamble` is set for continuation and steering-boundary passes so
    // they do not repeat health checks, background dispatch, or writer
    // preflight. Continuous auto-continuation opts back into just the opening
    // read-only Scout wave with `repeatOpeningScoutFanout`.
    options: {
      skipPreamble?: boolean
      repeatOpeningScoutFanout?: boolean
      backgroundParticipants?: EnsembleParticipant[]
    } = {}
  ): Promise<void> {
    if (runtime.startAfterCancellation) {
      await runtime.startAfterCancellation.catch(() => undefined)
      if (
        runtime.cancelled ||
        this.roundsByChatId.get(runtime.chatId)?.roundId !== runtime.roundId
      ) {
        return
      }
      // The interrupted round's cancellation has settled and this replacement
      // round now owns the chat, so it is committed to dispatch. Drop the
      // "parked" marker: from here on a concurrent steer cancels THIS round
      // through its live activeRun (correctly finalising the interrupted
      // participant as 'cancelled'), rather than being coalesced by the
      // parked-steer guard in `steerQueuedPrompt`.
      runtime.startAfterCancellation = undefined
    }
    // Slice C extension (1.0.3) — convert the fixed for-loop into a
    // mutable remaining-queue so `ensemble_yield(target:...)` can
    // reorder upcoming turns after each completion. The original
    // for-loop iterated `participants` directly; reordering required
    // a queue + while-loop pattern.
    const remaining: EnsembleParticipant[] = [...participants]
    runtime.remainingParticipants = remaining
    let dispatchAttempts = 0
    let unreachableFailures = 0
    if (
      !options.skipPreamble &&
      this.deps.probeParticipant &&
      remaining.length > 0 &&
      !runtime.cancelled
    ) {
      const health = await this.probeParticipantsForRound(runtime, remaining)
      if (
        runtime.cancelled ||
        this.roundsByChatId.get(runtime.chatId)?.roundId !== runtime.roundId
      ) {
        return
      }
      dispatchAttempts += health.unreachable.length
      unreachableFailures += health.unreachable.length
      remaining.length = 0
      remaining.push(...health.reachable)
      if (health.unreachable.length > 0) {
        runtime.unreachableParticipantIds = new Set(
          health.unreachable.map(({ participant }) => participant.id)
        )
        for (const { participant, result } of health.unreachable) {
          this.markParticipantUnreachable(
            runtime.chatId,
            runtime.roundId,
            participant,
            result.reason || `${participant.provider} runtime not reachable`
          )
        }
      }
    }

    if (!options.skipPreamble && options.backgroundParticipants?.length && !runtime.cancelled) {
      const chatForBackground = this.deps.getChat(runtime.chatId)
      if (chatForBackground?.ensemble) {
        await this.dispatchBackgroundParticipants(
          runtime,
          chatForBackground,
          options.backgroundParticipants,
          // beginRound-only path: every prompt reaching here is user-authored
          // (composer send / steer / queued drain), so the seat's own posture
          // applies. Peer mentions and the yield route dispatch elsewhere and
          // keep the read-only clamp.
          { honorSeatPosture: true }
        )
      }
    }

    // Parallel fan-out. Default/safe path: fan out read-only
    // participants first, then continue with writer-capable
    // participants serially. Writer-capable lanes only run in parallel
    // after either Boss authorization via ensemble_fanout or, when no
    // Boss is assigned, a host-owned user-preflight claim + ack pass.
    const chatForFanout = this.deps.getChat(runtime.chatId)
    const roundFanoutPolicy = runtime.fanoutPolicy ?? (runtime.concurrentMode ? 'read_only' : 'off')
    const readFanoutRequested = fanoutPolicyAllowsRead(roundFanoutPolicy)
    const writerFanoutRequested = fanoutPolicyAllowsWriters(roundFanoutPolicy)
    const shouldRunReadOnlyFanout = readFanoutRequested
    const shouldRunOpeningScoutFanout =
      !options.skipPreamble || options.repeatOpeningScoutFanout === true
    const shouldRunOpeningWriterFanout = !options.skipPreamble
    if (
      ((shouldRunOpeningScoutFanout && shouldRunReadOnlyFanout) ||
        (shouldRunOpeningWriterFanout && writerFanoutRequested)) &&
      !runtime.cancelled
    ) {
      const readers: EnsembleParticipant[] = []
      const writers: EnsembleParticipant[] = []
      // Spike 4 (staged fan-out) + review F1, revised 2026-08-04: stage roles
      // are PERMISSION-AGNOSTIC — an explicit stage is a pure dispatch role
      // and never consults the seat's configured preset. Three-way partition:
      //   readers  — explicit stage 'scout' (any preset), or unstaged seats
      //              whose OWN permissions resolve read-only (the pre-stage
      //              legacy inference) → round-start parallel pass, every
      //              lane dispatched under the signed read_only lane clamp.
      //   writers  — explicit stage 'worker' (any preset, including presets
      //              that resolve read-only: it still takes its serial turn
      //              and must NOT be silently dropped from BOTH buckets — a
      //              stranded participant left inert in `remaining`
      //              permanently defeats `eligibleWriterTail`), plus unstaged
      //              seats that are not read-only-eligible → candidates for
      //              the locked-writer fan-out block below. Stage-role
      //              REVIEWERS are excluded even when write-capable: a
      //              reviewer must never be dispatched at round start, and
      //              the user-preflight write-claim pass requires EVERY
      //              member of `writers` to produce a valid claim (review
      //              F1: a reviewer's missing claim rejected the whole
      //              preflight and it was dispatched a write-claim lane
      //              before any work existed).
      //   neither  — reviewers stay in `remaining` for the serial loop,
      //              where the reviewer stage gate defers them until
      //              non-reviewers finish.
      for (const participant of remaining) {
        if (participant.stageRole === 'reviewer') continue
        if (participant.stageRole === 'scout') {
          readers.push(participant)
          continue
        }
        if (participant.stageRole === 'worker') {
          writers.push(participant)
          continue
        }
        const permissions = chatForFanout
          ? this.resolveFanoutEligibilityPermissions(
              chatForFanout,
              runtime,
              participant,
              'read_only'
            )
          : null
        if (permissions?.readOnly) {
          readers.push(participant)
        } else {
          writers.push(participant)
        }
      }
      if (
        shouldRunOpeningScoutFanout &&
        shouldRunReadOnlyFanout &&
        readers.length >= 2 &&
        chatForFanout
      ) {
        // Remove ONLY the dispatched readers from `remaining` (preserving
        // original order) so the serial while-loop below still sees stage
        // reviewers / read-only stage workers alongside the writers.
        const readerIds = new Set(readers.map((reader) => reader.id))
        const rest = remaining.filter((participant) => !readerIds.has(participant.id))
        remaining.splice(0, remaining.length, ...rest)
        await this.runParallelFanoutPass(runtime, chatForFanout, readers, {
          mode: 'read_only',
          // Readers may include write-postured explicit scouts; the flag
          // routes the pre-dispatch check through the same read_only lane
          // clamp the dispatch itself already uses.
          forceReadOnlyDispatch: true,
          label: 'Automatic read stage'
        })
      } else if (shouldRunOpeningScoutFanout && readFanoutRequested && readers.length > 0) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          'Parallel mode requested but fewer than two read-pass participants were available; continuing serially.'
        )
      }
      if (
        shouldRunOpeningWriterFanout &&
        chatForFanout &&
        writers.length > 0 &&
        !runtime.cancelled
      ) {
        const bossmanParticipantId = this.activeBossmanParticipantId(chatForFanout, runtime)
        const writerPolicy =
          roundFanoutPolicy === 'all'
            ? bossmanParticipantId
              ? 'locked_writers_with_boss'
              : 'locked_writers_user_preflight'
            : roundFanoutPolicy
        // A writer fan-out needs >=2 writers that form the contiguous tail of the
        // round (no genuine serial participant runs between the read-only fan-out
        // and the writers). A stage-role REVIEWER sitting in `remaining` does NOT
        // count as an intervening participant: the reviewer stage-gate below
        // always defers reviewers until every non-reviewer has spoken, so a
        // reviewer is provably never dispatched before the writers this round.
        // (Before this exclusion, a single deferred reviewer wrongly vetoed the
        // whole writer fan-out, dropping the writers to serial.)
        const eligibleWriterTail =
          writers.length >= 2 &&
          remaining.every(
            (participant) =>
              participant.stageRole === 'reviewer' ||
              writers.some((writer) => writer.id === participant.id)
          )
        if (
          !writerFanoutRequested ||
          (writerPolicy !== 'locked_writers_with_boss' &&
            writerPolicy !== 'locked_writers_user_preflight')
        ) {
          // Read-only fan-out intentionally leaves writer-capable participants serial.
        } else if (!concurrentWriteLanesEnabled()) {
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            'Locked writer fan-out requested but TASKWRAITH_CONCURRENT_WRITE_LANES=0; continuing with serial writers.'
          )
        } else if (!eligibleWriterTail) {
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            'Locked writer fan-out needs at least two writer-capable participants with no intervening serial participants after the read-only fan-out step; continuing serially.'
          )
        } else if (writerPolicy === 'locked_writers_with_boss') {
          if (bossmanParticipantId) {
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              'Locked writer fan-out requires the assigned Boss to call ensemble_fanout with explicit writeScopes; continuing with serial writers.'
            )
          } else {
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              'Locked writer fan-out requires an assigned Boss for this policy; continuing with serial writers.'
            )
          }
        } else if (bossmanParticipantId) {
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            'User-preflight writer fan-out is only used when no Boss is assigned; continuing with serial writers.'
          )
        } else {
          const handledWriters = await this.runUserWriteScopePreflight(
            runtime,
            chatForFanout,
            writers
          )
          if (handledWriters) {
            remaining.length = 0
          }
        }
      }
    }
    // 1.0.4 — participant id of the just-promoted yield target. Set
    // at the end of the previous iteration when ensemble_yield's
    // target landed at remaining[0]; consumed at the top of the next
    // iteration so the dispatch-failure branch can surface a yield-
    // specific transcript note ("Yield target X unreachable. Routing
    // to next-in-rotation Y.") instead of the generic skip note.
    let yieldedTargetParticipantId: string | null = null
    // Spike 4 (staged fan-out) — reviewer stage-gate state. Stage-role
    // reviewers wait until every non-reviewer turn has drained, EXCEPT when
    // explicitly routed by a yield / yield-return / @-mention (agent-directed
    // routing outranks the declarative stage — ids land in the exempt set at
    // each promotion point). `reviewerWaveEligible` mirrors the round-start
    // read-pass gates so the closing review wave obeys the same policy/env
    // switches as the opening scout pass; when concurrency is unavailable
    // reviewers still run LAST, just serially.
    const stageGateExemptIds = new Set<string>()
    const reviewerDeferralNoted = new Set<string>()
    const reviewerWaveEligible = shouldRunReadOnlyFanout
    // 1.0.4 — round-end all-unreachable fallback. Counts every
    // dispatch attempt and how many of those attempts failed with
    // `kind: 'unreachable'`. If the round exhausts `remaining` with
    // every attempt unreachable, we emit a final "no reachable
    // participants left" note so the user knows to re-launch.
    while (remaining.length > 0) {
      if (runtime.cancelled) break
      const chat = this.deps.getChat(runtime.chatId)
      if (!chat?.ensemble) break
      for (const participantId of runtime.userFanoutSerialParticipantIds || []) {
        stageGateExemptIds.add(participantId)
      }
      // Terminal-goal pre-emption: once the goal leaves 'active' mid-round,
      // undispatched ordinary serial seats are confirmation ceremony — sweep
      // them out (marked 'skipped') instead of dispatching each in turn.
      this.preemptRemainingForTerminalGoal(runtime, chat, remaining, stageGateExemptIds)
      if (remaining.length === 0) break
      const nextParticipant = remaining[0]
      // Any external seated at or before this one takes its turn first.
      this.deliverExternalSeatTurns(runtime, nextParticipant.order)
      const quarantine = this.activeBossmanQuarantine(chat, runtime.roundId, nextParticipant.id)
      if (quarantine) {
        remaining.shift()
        this.updateParticipantState(
          runtime.chatId,
          runtime.roundId,
          nextParticipant.id,
          'skipped',
          `Quarantined: ${quarantine.reason}`
        )
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${participantDisplayName(nextParticipant)} skipped by active Boss/Captain quarantine: ${quarantine.reason}`
        )
        continue
      }
      // Spike 4 — closing review wave: once only stage-role reviewers (and
      // leftovers already dispatched via mid-round ensemble_fanout) remain,
      // run the pending reviewers as ONE parallel pass — the inverse of the
      // round-start scout pass. Wave members are spliced out of `remaining`
      // BEFORE the pass so nothing double-dispatches (the pass itself does
      // not mark fannedOutParticipantIds — only the ensemble_fanout tool
      // path does). Stage roles are permission-agnostic (2026-08-04): a
      // write-postured reviewer joins the wave like any other; every wave
      // lane dispatches under the read_only lane clamp.
      if (
        reviewerWaveEligible &&
        remaining.length >= 2 &&
        remaining.every(
          (entry) =>
            entry.stageRole === 'reviewer' || runtime.fannedOutParticipantIds?.has(entry.id)
        )
      ) {
        const pendingReviewers = remaining.filter(
          // Live/reserved fan-out lanes are excluded alongside completed ones:
          // a reviewer whose mid-round lane is still running must not be
          // spliced into the wave as a duplicate concurrent dispatch (the
          // serial shift-guard below cannot see wave members).
          (entry) =>
            entry.stageRole === 'reviewer' &&
            !this.participantFanoutDispatchState(runtime, entry.id)
        )
        if (pendingReviewers.length >= 2) {
          const waveIds = new Set(pendingReviewers.map((entry) => entry.id))
          const rest = remaining.filter((entry) => !waveIds.has(entry.id))
          remaining.splice(0, remaining.length, ...rest)
          await this.runParallelFanoutPass(runtime, chat, pendingReviewers, {
            mode: 'read_only',
            forceReadOnlyDispatch: true,
            label: 'Review wave'
          })
          // Closing Review wave ends ordinary serial work for this pass.
          // Drop already-handled leftovers (prior MCP fan-out) so Continuous
          // drain sees an empty queue. Suppress one no-progress soft-stop:
          // empty/skipped review lanes must not Task-Complete while hops
          // remain (return to authority / next pass instead). Do NOT mark
          // wave members in fannedOutParticipantIds — that would re-admit
          // them on the next Continuous pass only for serial to skip them
          // as 'handled' and finalize with hops left.
          remaining.splice(
            0,
            remaining.length,
            ...remaining.filter(
              (entry) => this.participantFanoutDispatchState(runtime, entry.id) !== 'handled'
            )
          )
          if (
            remaining.length === 0 &&
            runtime.orchestrationMode === 'continuous' &&
            !runtime.cancelled &&
            !runtime.returnedControlToUser
          ) {
            runtime.suppressNoProgressAfterReviewWave = true
          }
          continue
        }
      }
      let participant = remaining.shift()!
      runtime.userFanoutSerialParticipantIds?.delete(participant.id)
      if (runtime.userFanoutSerialParticipantIds?.size === 0) {
        runtime.userFanoutSerialParticipantIds = undefined
      }
      const pendingUserFanoutDispatch = runtime.userFanoutDispatchSettlements?.get(participant.id)
      if (pendingUserFanoutDispatch) {
        // The user wave was launched from a synchronous Steer handler while
        // this serial loop was already live. Wait only for the provider-entry
        // receipt: an accepted lane is skipped below, while a rejected lane
        // falls through and keeps the seat's original serial turn.
        await pendingUserFanoutDispatch.catch(() => false)
        if (
          runtime.cancelled ||
          this.roundsByChatId.get(runtime.chatId)?.roundId !== runtime.roundId
        ) {
          break
        }
      }
      const fanoutDispatchState = this.participantFanoutDispatchState(runtime, participant.id)
      if (fanoutDispatchState === 'active') {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${participantDisplayName(participant)} is already running in a fan-out lane; skipping duplicate serial dispatch.`
        )
        continue
      }
      // A prior settled fan-out ('handled') still suppresses the ordinary serial
      // seat so the wave does not double-speak. Explicit yield / @-mention /
      // yield-return routing populates stageGateExemptIds and must be allowed
      // through — otherwise Boss→reviewer handoffs after Review wave are no-ops.
      if (fanoutDispatchState === 'handled' && !stageGateExemptIds.has(participant.id)) {
        continue
      }
      // Spike 4 — defer stage-role reviewers while any non-reviewer still
      // awaits its turn this round. Explicitly-routed reviewers (yield /
      // yield-return / @-mention promotions populate stageGateExemptIds)
      // run immediately instead. Rotation always terminates: the gate
      // requires a pending non-reviewer, and each rotation moves the queue
      // toward that participant's turn.
      if (
        participant.stageRole === 'reviewer' &&
        !stageGateExemptIds.has(participant.id) &&
        remaining.some(
          (entry) =>
            entry.stageRole !== 'reviewer' && !runtime.fannedOutParticipantIds?.has(entry.id)
        )
      ) {
        remaining.push(participant)
        if (!reviewerDeferralNoted.has(participant.id)) {
          reviewerDeferralNoted.add(participant.id)
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `${participant.role || providerLabel(participant.provider)} is a reviewer; deferring their turn until the other participants finish.`
          )
        }
        continue
      }
      const wasYieldTarget = yieldedTargetParticipantId === participant.id
      yieldedTargetParticipantId = null
      const resumeWakeup =
        runtime.resumeWakeup?.participantId === participant.id ? runtime.resumeWakeup : undefined
      if (resumeWakeup) runtime.resumeWakeup = undefined
      // Wave 3 — a seat compaction in flight (post-round auto or manual) may be
      // about to REPLACE this participant's provider session; dispatching
      // against the old one would strand the turn in an abandoned session.
      // Await it (bounded by the lane's own 240s timeout) and refresh the
      // session/summary fields the compaction may have rewritten.
      await this.awaitSeatCompactionBeforeDispatch(runtime.chatId, participant)
      // Re-check cancellation AFTER the await. The loop-top `runtime.cancelled`
      // check (and the `await completion` between participants) guard every other
      // suspension point, but seat compaction can block here for seconds while a
      // deep-work chat's context is rewritten — and a Steer/Stop landing in that
      // window sets `runtime.cancelled` (with `activeRunId` still undefined, so
      // `cancelRound` finds nothing to interrupt). Without this guard the loop
      // would resume and dispatch a participant onto an already-cancelled,
      // already-superseded round — a "zombie" run the current round's runtime no
      // longer owns, so it keeps speaking, Stop can't reach it, and the round
      // reads stuck 'running'. Bail cleanly; `finishRound` below no-ops against
      // the replacement round, leaving the live round untouched.
      if (runtime.cancelled) break

      // A user steer can reserve this exact seat while the serial path is
      // suspended in compaction. Reconcile the dispatch-start receipt again at
      // this boundary: accepted/active lanes own the turn, while a rejected
      // lane leaves the original serial dispatch intact.
      const postCompactionUserFanoutDispatch = runtime.userFanoutDispatchSettlements?.get(
        participant.id
      )
      if (postCompactionUserFanoutDispatch) {
        await postCompactionUserFanoutDispatch.catch(() => false)
      }
      if (
        runtime.cancelled ||
        this.roundsByChatId.get(runtime.chatId)?.roundId !== runtime.roundId
      ) {
        break
      }
      const postCompactionFanoutState = this.participantFanoutDispatchState(runtime, participant.id)
      if (postCompactionFanoutState === 'active') {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${participantDisplayName(participant)} entered a fan-out lane while its serial turn was preparing; skipping duplicate serial dispatch.`
        )
        continue
      }
      if (postCompactionFanoutState === 'handled' && !stageGateExemptIds.has(participant.id)) {
        continue
      }

      // A host compaction can replace session/summary/receipt fields while
      // this loop is awaiting it. Refresh those context-bearing fields, but
      // retain the frozen role/stage seat snapshot for scheduled wakeups and
      // active-round audit semantics (a later live roster edit must not
      // rewrite the identity of an already-scheduled participant).
      const dispatchChat = this.deps.getChat(runtime.chatId)
      const refreshedParticipant = dispatchChat?.ensemble?.participants?.find(
        (candidate) => candidate.id === participant.id
      )
      if (!dispatchChat?.ensemble || !refreshedParticipant) continue
      participant = {
        ...participant,
        linkedProviderSessionId: refreshedParticipant.linkedProviderSessionId,
        contextCompactionSummary: refreshedParticipant.contextCompactionSummary,
        promptShellVersion: refreshedParticipant.promptShellVersion,
        promptDynamicStateVersion: refreshedParticipant.promptDynamicStateVersion,
        taskWraithMcpProfileReceipt: refreshedParticipant.taskWraithMcpProfileReceipt
      }
      // 1.0.5-N6 — A wakeup-resume run with no linked provider session is
      // re-establishing working memory from TaskWraith transcript context.
      const sleepResumeWarning =
        resumeWakeup && !participant.linkedProviderSessionId
          ? 'Resumed from TaskWraith transcript context; no native provider session id was available.'
          : undefined

      const run = this.seedParticipantRun(dispatchChat, runtime, participant, {
        sleepResumeWarning
      })
      runtime.activeRunId = run.runId
      const completion = new Promise<EnsembleParticipantStatus>((resolve) => {
        run.completion = resolve
      })
      const runScopedExternalPathGrants =
        this.deps.issueRunScopedExternalGrants?.({
          chat: dispatchChat,
          participant,
          appRunId: run.runId,
          attachments: runtime.imageAttachments
        }) || []
      const participantExternalPathGrants = [
        ...runScopedExternalPathGrants,
        ...(runtime.externalPathGrants || [])
      ]
      const permissions = this.resolveParticipantPermissions(
        dispatchChat,
        participant,
        participantExternalPathGrants,
        { ensembleLaneId: run.laneId }
      )
      // 1.0.4-AF — merge the round-scoped `selfReflective` flag (set
      // by `/discuss` at startRound) into the config so the prompt
      // builder sees the inverted deictic rule for this round only.
      // The persisted `chat.ensemble.selfReflective` toggle (future
      // UI control) takes precedence so an explicit pre-set isn't
      // accidentally overridden by a non-discuss round.
      const ensembleConfigForRound: EnsembleConfig = runtime.selfReflective
        ? { ...dispatchChat.ensemble, selfReflective: true }
        : dispatchChat.ensemble
      const chatContextTurns = this.deps.getSettings().chatContextTurns
      // Spike 5 — slim resumed-turn prompt (TASKWRAITH_ENSEMBLE_SLIM_RESUME,
      // default OFF). Eligible only when: the flag is on; the seat's provider
      // session genuinely resumes across turns (claude/codex plus Kimi
      // Code ACP seats marked after a successful session/new or session/resume;
      // legacy Kimi Wire, Grok-ACP, and Ollama remain ineligible); a resume id
      // exists; this is NOT a
      // wakeup re-entry (those explicitly rebuild working memory from the
      // transcript); and the seat's persisted shell stamp matches the current
      // config (roster/rules/instructions unchanged since its last full
      // briefing). The fresh stamp is recorded on the run either way and
      // persisted by flushRun next to linkedProviderSessionId.
      const promptShellStamp = computeEnsemblePromptShellStamp(ensembleConfigForRound)
      const dynamicStateSnapshot = buildEnsembleDynamicStateSnapshot(
        dispatchChat,
        ensembleConfigForRound
      )
      const slimTurn =
        ensembleSlimResumeEnabled() &&
        SLIM_RESUME_PROVIDERS.has(participant.provider) &&
        Boolean(run.providerSessionId || participant.linkedProviderSessionId) &&
        (participant.provider !== 'codex' ||
          isCodexAppServerThreadId(run.providerSessionId || participant.linkedProviderSessionId)) &&
        (participant.provider !== 'kimi' ||
          (isProductionKimiAcpSeat(participant) &&
            String(run.providerSessionId || participant.linkedProviderSessionId).startsWith(
              'session_'
            ))) &&
        !resumeWakeup &&
        participant.promptShellVersion === promptShellStamp
      const promptUsageTelemetry = buildEnsemblePromptUsageTelemetry({
        slimTurn,
        dynamicStateBlockChars: dynamicStateSnapshot.block.length,
        dynamicStateVersion: dynamicStateSnapshot.version,
        priorDynamicStateReceipt: participant.promptDynamicStateVersion
      })
      // Blackboard delta bookkeeping: same selection the prompt builder makes
      // (full board on a full briefing, unseen-only on a slim turn). Captured
      // BEFORE dispatch so entries posted mid-run stay unseen; stamped onto
      // the run only after the provider received the prompt (below), then
      // merged into each entry's seenBy at flush.
      const injectedBlackboardEntryIds = (() => {
        const visible = selectBlackboardForRound(
          ensembleConfigForRound.blackboard || [],
          runtime.roundId
        )
        return (slimTurn ? selectUnseenBlackboard(visible, participant.id) : visible).map(
          (entry) => entry.id
        )
      })()
      // Tree-derived churn evidence. Sampled here — immediately before the
      // prompt is composed — so the numbers describe the tree the seat is about
      // to act on, not the tree as it stood when the round opened.
      const workspaceChurnStanza = await this.resolveWorkspaceChurnStanza(runtime, dispatchChat)
      // `resolveWorkspaceChurnStanza` is an actual async boundary. A user steer
      // can append a durable row while git is being sampled, so refresh ONLY
      // the transcript-facing chat state afterwards. Permission/role/config
      // authority remains the frozen dispatch snapshot above.
      const latestPromptChat = this.deps.getChat(runtime.chatId)
      const promptChat = latestPromptChat?.ensemble
        ? { ...dispatchChat, messages: latestPromptChat.messages }
        : dispatchChat
      const skillHookContext = await this.resolveParticipantSkillHookContext(promptChat)
      const promptProjection = buildEnsembleParticipantPromptProjection({
        chat: promptChat,
        config: ensembleConfigForRound,
        participant,
        currentPrompt: resumeWakeup
          ? formatWakeupResumePrompt(runtime.prompt, resumeWakeup)
          : runtime.prompt,
        roundId: runtime.roundId,
        chatContextTurns,
        ...(workspaceChurnStanza ? { workspaceChurnStanza } : {}),
        // 1.0.4-AK6 — thread fan-out briefs into the writer's prompt
        // when a parallel fan-out pass just completed. Empty array
        // (or undefined) skips the section entirely.
        scoutBriefs: runtime.scoutBriefs,
        slimTurn,
        dynamicStateSnapshot,
        effectiveApprovalMode: permissions.approvalMode,
        authorityRoutingCheckpoint: run.authorityRoutingCheckpoint,
        ...skillHookContext
      })
      const prompt = promptProjection.prompt
      const shellRoutingPrompt = buildProviderShellRoutingPrompt({
        provider: participant.provider,
        effectivePermissions: permissions
      })
      const projectReferenceAppendix = this.buildProjectReferenceAppendixForSeat(
        runtime,
        participant,
        permissions,
        dispatchChat.workspacePath
      )
      const promptWithDiscordContext = `${shellRoutingPrompt}${prompt}${formatDiscordContextPromptAppendix(
        runtime.discordContextSnapshots
      )}${externalPathGrantPromptAppendix(permissions.externalPathGrants)}${projectReferenceAppendix}`
      const resumeFallbackProjection =
        slimTurn && (participant.provider === 'kimi' || participant.provider === 'codex')
          ? buildEnsembleParticipantPromptProjection({
              chat: promptChat,
              config: ensembleConfigForRound,
              participant,
              currentPrompt: runtime.prompt,
              roundId: runtime.roundId,
              chatContextTurns,
              scoutBriefs: runtime.scoutBriefs,
              slimTurn: false,
              dynamicStateSnapshot,
              effectiveApprovalMode: permissions.approvalMode,
              authorityRoutingCheckpoint: run.authorityRoutingCheckpoint,
              // Same dispatch, same evidence — reuse the sample rather than
              // re-shelling git for the resume-failure fallback.
              ...(workspaceChurnStanza ? { workspaceChurnStanza } : {}),
              ...skillHookContext
            })
          : undefined
      const resumeFallbackPrompt = resumeFallbackProjection
        ? `${shellRoutingPrompt}${resumeFallbackProjection.prompt}${formatDiscordContextPromptAppendix(
            runtime.discordContextSnapshots
          )}${externalPathGrantPromptAppendix(permissions.externalPathGrants)}${projectReferenceAppendix}`
        : undefined
      // The adapter may use either the slim prompt or its cold-session
      // fallback. Receipt only rows present in BOTH possible prompts; that is
      // the exact evidence guaranteed to have reached the accepted dispatch.
      const suppliedMessageIds = resumeFallbackProjection
        ? promptProjection.suppliedMessageIds.filter((messageId) =>
            resumeFallbackProjection.suppliedMessageIds.includes(messageId)
          )
        : promptProjection.suppliedMessageIds
      // Slice D (1.0.3) — per-participant reasoning + speed + thinking
      // settings flow through the same AgentRunPayload fields the
      // composer uses for solo runs. Provider adapters already accept
      // these at the per-run level; we only fill the field that
      // matches the participant's provider so adapters don't see
      // cross-provider noise. Falls back silently when a participant
      // pre-dates the setup-sheet picker rework.
      const sharedReasoning =
        participant.provider === 'codex' ||
        participant.provider === 'kimi' ||
        (participant.provider === 'grok' && isGrok45ReasoningModelId(participant.model)) ||
        (participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model))
          ? participant.reasoningEffort
          : undefined
      const sharedServiceTier =
        participant.provider === 'codex'
          ? (participant.serviceTier ?? (participant.fastModeEnabled ? 'fast' : ''))
          : participant.provider === 'kimi'
            ? participant.fastModeEnabled && !isKimiK3Model(participant.model)
              ? 'fast'
              : 'standard'
            : participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model)
              ? participant.fastModeEnabled
                ? 'fast'
                : ''
              : undefined
      const claudeReasoning =
        participant.provider === 'claude' ? participant.reasoningEffort : undefined
      const claudeFastMode =
        participant.provider === 'claude' ? Boolean(participant.fastModeEnabled) : undefined
      const kimiThinking = participant.provider === 'kimi' ? true : undefined
      const ollamaRunControls = ensembleOllamaRunControls(participant)

      const payload: AgentRunPayload = {
        provider: participant.provider,
        scope: dispatchChat.scope === 'global' ? 'global' : 'workspace',
        ...(dispatchChat.scope === 'global' ? {} : { workspace: dispatchChat.workspacePath || '' }),
        prompt: promptWithDiscordContext,
        ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
        imagePaths: this.imagePathsForParticipantDispatch(runtime, participant),
        appRunId: run.runId,
        appChatId: dispatchChat.appChatId,
        model: participant.model || 'cli-default',
        approvalMode: permissions.approvalMode,
        workflowMode: dispatchChat.workflowMode === 'plan' ? 'plan' : 'normal',
        runtimeProfileId: participant.runtimeProfileId,
        geminiAuthProfileId:
          participant.provider === 'gemini' ? participant.geminiAuthProfileId || null : null,
        providerSessionId: run.providerSessionId || participant.linkedProviderSessionId || null,
        externalPathGrants: permissions.externalPathGrants,
        effectivePermissions: permissions,
        ...(this.deps.signRunPermissionPosture
          ? {
              effectivePermissionsSignature: this.deps.signRunPermissionPosture(
                permissions.approvalMode,
                permissions,
                {
                  provider: participant.provider,
                  scope: dispatchChat.scope === 'global' ? 'global' : 'workspace',
                  appRunId: run.runId,
                  appChatId: dispatchChat.appChatId,
                  prompt: promptWithDiscordContext,
                  ...(resumeFallbackPrompt ? { resumeFallbackPrompt } : {}),
                  workflowMode: dispatchChat.workflowMode === 'plan' ? 'plan' : 'normal',
                  runtimeProfileId: participant.runtimeProfileId,
                  ensembleParticipantId: participant.id
                }
              )
            }
          : {}),
        ensembleRun: ensembleRunIdentity(
          runtime.roundId,
          participant,
          undefined,
          ensembleConfigForRound,
          chatContextTurns,
          slimTurn ? 'slim' : 'full'
        ),
        ...(sharedReasoning !== undefined ? { reasoningEffort: sharedReasoning } : {}),
        ...(sharedServiceTier !== undefined ? { serviceTier: sharedServiceTier } : {}),
        ...(claudeReasoning !== undefined ? { claudeReasoningEffort: claudeReasoning } : {}),
        ...(claudeFastMode !== undefined ? { claudeFastMode } : {}),
        ...(kimiThinking !== undefined ? { kimiThinking } : {}),
        ...ollamaRunControls
      }
      // 1.0.4 — wrap dispatch in try/catch so socket-level errors
      // (ECONNREFUSED on a dead MCP bridge, ETIMEDOUT on a hung
      // provider, ENOENT on a missing CLI binary) classify into a
      // typed failure and emit a structured transcript note rather
      // than crashing the whole round on the first dead participant.
      // The round-self-heal path was already correct structurally —
      // while-loop continues to the next participant in `remaining`
      // after a failed dispatch — this just adds the diagnostic.
      //
      // See `src/main/EnsembleErrors.ts` for the classifier; the
      // note shape is `formatDispatchFailureNote(participant, reason)`.
      // Origin: Claude/Explorer's introspective feedback in
      // production when ensemble_yield hit ECONNREFUSED on Gemini.
      let dispatchedResult: {
        dispatched: boolean
        appRunId: string
        failureMessage?: string
      } | null = null
      let dispatchFailure: DispatchFailureReason | null = null
      run.transportDispatchState = 'pending'
      try {
        dispatchedResult = await this.deps.dispatch(
          payload,
          { sender: runtime.sender },
          undefined,
          { suppliedMessageIds }
        )
        run.transportDispatchState = dispatchedResult.dispatched ? 'accepted' : 'rejected'
      } catch (error) {
        // Adapter entry may publish a process/controller before rejecting. Stop
        // that exact run before failed bookkeeping clears its only handle.
        run.transportDispatchState = 'unknown'
        await this.requestExactRunCancellation(run).catch(() => false)
        dispatchFailure = classifyDispatchError(error)
      }
      if (dispatchedResult?.dispatched && (runtime.cancelled || run.terminalFinalized === true)) {
        // Stop/history deletion may have reached cancelRun before dispatch
        // registered this run. An accepted receipt is the first point at which
        // the exact transport can be cancelled authoritatively.
        await this.requestExactRunCancellation(run).catch(() => false)
        if (this.runsByRunId.get(run.runId) === run) {
          this.finalizeRun(run, 'cancelled', 'Round cancelled during provider dispatch.')
        }
        runtime.activeRunId = undefined
        continue
      }
      if (dispatchFailure || !dispatchedResult?.dispatched) {
        // Reason precedence: the typed classification from a thrown
        // error wins over the generic `dispatched: false` path,
        // because the classifier carries more information (posix
        // code, preflight message). For the `dispatched: false`
        // case with no thrown error, we surface as `unknown` since
        // RunCoordinator already consumed the error in its preflight
        // try/catch and we don't have access to the original.
        dispatchAttempts += 1
        // Precedence: a typed classification from a thrown error wins (it
        // carries a posix code). Next, a preflight message handed back on the
        // `dispatched: false` result — RunCoordinator sends that text to the
        // sender for a solo run, and now returns it so a seat's note can say
        // WHY instead of "dispatch failed" with no cause. `unknown` is the
        // last resort, for a refusal that genuinely carried no reason.
        const failureMessage = dispatchedResult?.failureMessage || ''
        const reason: DispatchFailureReason =
          dispatchFailure ||
          (failureMessage
            ? isExternalPathGrantAuthorityMessage(failureMessage)
              ? { kind: 'external_path_grant', message: failureMessage }
              : { kind: 'preflight', message: failureMessage }
            : { kind: 'unknown', message: '' })

        // Stale secondary-workspace grants must never soft-skip a seat.
        // Remint every active provider from prior consent when possible, then
        // pause the round for an explicit grant prompt (or a clean resend
        // after silent remint). User dismiss is the only deny.
        if (reason.kind === 'external_path_grant') {
          const repaired =
            !run.externalPathGrantRepairAttempted &&
            (await this.deps.repairStaleExternalPathGrants?.(runtime.chatId)) === true
          run.externalPathGrantRepairAttempted = true
          if (repaired) {
            const liveChat = this.deps.getChat(runtime.chatId)
            if (liveChat) {
              runtime.externalPathGrants = collectExternalPathGrantsFromMetadata(
                liveChat.providerMetadata
              )
            }
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              `${PARTICIPANT_HEALTH_TAG} Rebounded workspace access grants for every active provider. Resend to continue — seats were not skipped.`
            )
          }
          const note = formatDispatchFailureNote(participant, reason)
          this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
          this.deps.notifyExternalPathGrantRepairNeeded?.({
            chatId: runtime.chatId,
            roundId: runtime.roundId,
            message: reason.message
          })
          this.finalizeRun(run, 'cancelled', note)
          runtime.activeRunId = undefined
          await this.cancelRound(
            runtime.chatId,
            repaired
              ? 'Workspace grants were rebound — resend to continue. Seats were not skipped.'
              : 'Waiting for external path grant approval — seats were not skipped.',
            runtime.roundId
          )
          break
        }

        if (reason.kind === 'unreachable') unreachableFailures += 1
        const note = formatDispatchFailureNote(participant, reason)
        // 1.0.4 — yield-target-specific transcript note. When the
        // just-shifted participant was promoted to the front via
        // ensemble_yield(target:...) and we couldn't reach them, the
        // round-status line should explicitly call out the yield
        // routing (it's more informative than the generic skip note
        // for this case). The per-participant run still records the
        // generic note as its reason so the chip strip / status pill
        // copy stays consistent with non-yield failures.
        if (wasYieldTarget && reason.kind === 'unreachable') {
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            formatYieldTargetUnreachableNote(
              participant,
              reason.underlyingCode,
              remaining[0] || null
            )
          )
        } else {
          this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
        }
        this.finalizeRun(run, 'failed', note)
      } else {
        dispatchAttempts += 1
        runtime.lastForegroundParticipantId = participant.id
        this.startCursorCompletionWatchdog(run)
        // Review F2c — record the shell stamp only once the provider
        // actually RECEIVED this prompt. Stamping before dispatch let a
        // spawn/preflight failure persist a stamp for a shell the session
        // never saw, wrongly slim-qualifying the next turn. Same rule for
        // the injected blackboard ids: a prompt the session never saw must
        // not mark entries seen.
        run.promptShellStamp = promptShellStamp
        run.promptDynamicStateVersion = dynamicStateSnapshot.version
        run.ensemblePromptUsageTelemetry = promptUsageTelemetry
        run.injectedBlackboardEntryIds = injectedBlackboardEntryIds
        await completion
        // History cancellation resolves the local completion only to release
        // this activity join. It has already removed the run/runtime under a
        // durable AppStore write gate, so no post-turn maintenance or routing
        // projection may run after that resolution.
        if (runtime.cancelled) break
        if (
          runtime.pendingCursorContextRecoveryParticipantId === participant.id &&
          !runtime.cancelled
        ) {
          // Same-seat Path-B retry after discreet context recovery. Do not
          // charge Continuous hops — this is maintenance, not a new answer.
          runtime.pendingCursorContextRecoveryParticipantId = undefined
          const refreshed = this.deps
            .getChat(runtime.chatId)
            ?.ensemble?.participants?.find((candidate) => candidate.id === participant.id)
          if (refreshed) {
            Object.assign(participant, persistedSeatRuntimeState(refreshed))
          }
          remaining.unshift(participant)
          runtime.activeRunId = undefined
          continue
        }
        this.maybeAutoCompactSeatAfterTurn(runtime.chatId, participant.id)
      }
      runtime.activeRunId = undefined
      this.applyPendingParticipantSeatChangeFor(runtime, participant.id)
      // `ensemble_fanout` returns to the provider after dispatch so the tool call
      // itself cannot time out. The caller may then finish, yield, or @mention a
      // peer while its reader/writer lanes are still working. Keep foreground
      // ownership with that caller until those detached passes settle; routing
      // below is intentionally evaluated AFTER the wait so its exact target and
      // hop accounting are preserved. Stop/steer still cancels the runtime and
      // releases the wait through lane finalization.
      //
      // Boss/Captain authority ring: while owned fan-out is unsettled or the
      // authority ended without synthesis, do not auto-advance to ordinary
      // serial writers. Re-summon the authority so it can keep working /
      // synthesize (ensemble_await / ensemble_lane_result) — the only other
      // allowed exit is an explicit yield to another available Boss/Captain.
      const authorityFanoutRole = this.fanoutAuthorityRoleForCaller(chat, runtime, participant.id)
      const managerFanoutHandoffPending =
        Boolean(authorityFanoutRole) &&
        this.pendingYieldTargetsActiveFanoutManager(chat, runtime, run)
      if (authorityFanoutRole && this.runMissingOwnedFanoutSynthesis(run)) {
        runtime.pendingAuthorityFanoutSynthesisParticipantId = participant.id
      }
      if (
        managerFanoutHandoffPending &&
        runtime.yieldRouting?.kind === 'queue' &&
        runtime.pendingAuthorityFanoutSynthesisParticipantId === participant.id
      ) {
        // The peer manager inherits the synthesis obligation for this wave.
        runtime.pendingAuthorityFanoutSynthesisParticipantId =
          runtime.yieldRouting.targetParticipantId
      }
      if (authorityFanoutRole && !managerFanoutHandoffPending) {
        const unsettledLaneCount = this.unsettledFanoutLaneCount(runtime, run)
        const ownedFanoutWork = this.hasOwnedFanoutWork(run)
        const synthesisPendingForSeat =
          this.runMissingOwnedFanoutSynthesis(run) ||
          runtime.pendingAuthorityFanoutSynthesisParticipantId === participant.id
        const waveActive = ownedFanoutWork || unsettledLaneCount > 0
        const waveSettled = !waveActive
        const synthesizedThisTurn =
          waveSettled &&
          synthesisPendingForSeat &&
          run.content.trim().length > 0 &&
          !this.runMissingOwnedFanoutSynthesis(run)
        if (synthesizedThisTurn) {
          runtime.pendingAuthorityFanoutSynthesisParticipantId = undefined
        } else if (waveSettled && synthesisPendingForSeat && runtime.yieldRouting) {
          // Post-settlement explicit handoff outranks the synthesis obligation.
          runtime.pendingAuthorityFanoutSynthesisParticipantId = undefined
        }
        let notedMissingSynthesis = false
        const noteMissingOnce = (): void => {
          if (notedMissingSynthesis || !this.runMissingOwnedFanoutSynthesis(run)) return
          this.noteMissingOwnedFanoutSynthesis(runtime, run)
          notedMissingSynthesis = true
        }
        // While lanes are live, keep the authority ring closed (no ordinary
        // serial writers). An explicit queue yieldRouting to a concrete seat is
        // preserved and applied after settlement — same deferred handoff model
        // as non-Boss owners. Only a silent end with a still-pending synthesis
        // obligation re-summons the authority seat.
        const retainAuthorityRing =
          !synthesizedThisTurn && (waveActive || (synthesisPendingForSeat && !runtime.yieldRouting))
        const pendingDeferredNonManagerYield =
          runtime.yieldRouting?.kind === 'queue' &&
          Boolean(runtime.yieldRouting.targetParticipantId) &&
          !this.pendingYieldTargetsActiveFanoutManager(chat, runtime, run)
        if (retainAuthorityRing) {
          noteMissingOnce()
          if (waveActive) {
            this.clearNonAuthorityFanoutYieldRouting(runtime, run)
          }
          // Prefer an immediate re-summon so Boss/Captain can keep working
          // (ensemble_await / more tools) while lanes run — unless an explicit
          // non-manager handoff is already stored. Re-summoning in that case
          // would start another Boss speaking turn and bury the deferred yield;
          // wait for settlement instead, then fall through to applyStoredYieldRouting.
          if (
            !pendingDeferredNonManagerYield &&
            this.requeueAuthorityForActiveFanoutHold(
              runtime,
              remaining,
              participant,
              synthesisPendingForSeat
                ? unsettledLaneCount > 0 || ownedFanoutWork
                  ? `${participantDisplayName(participant)} retains the authority turn while ${Math.max(unsettledLaneCount, ownedFanoutWork ? 1 : 0)} fan-out lane(s) remain unsettled; synthesize before ordinary serial writers.`
                  : `${participantDisplayName(participant)} retains the authority turn to synthesize fan-out results.`
                : `${participantDisplayName(participant)} retains the authority turn while ${Math.max(unsettledLaneCount, ownedFanoutWork ? 1 : 0)} fan-out lane(s) remain unsettled.`
            )
          ) {
            continue
          }
          if (ownedFanoutWork) {
            await this.waitForOwnedFanoutSettlements(runtime, run)
            if (runtime.cancelled) break
          }
          const stillUnsettledCount = this.unsettledFanoutLaneCount(runtime, run)
          const stillOwned = this.hasOwnedFanoutWork(run)
          const stillWaveActive = stillOwned || stillUnsettledCount > 0
          // After settlement, an explicit yieldRouting waives synthesis and
          // must fall through to applyStoredYieldRouting (not requeue Boss).
          // Re-check here: the pre-wait waiver only saw waveActive=true.
          const stillDeferredNonManagerYield =
            runtime.yieldRouting?.kind === 'queue' &&
            Boolean(runtime.yieldRouting.targetParticipantId) &&
            !this.pendingYieldTargetsActiveFanoutManager(chat, runtime, run)
          if (
            !stillWaveActive &&
            stillDeferredNonManagerYield &&
            runtime.pendingAuthorityFanoutSynthesisParticipantId === participant.id
          ) {
            runtime.pendingAuthorityFanoutSynthesisParticipantId = undefined
          }
          const stillSynthesisPending =
            this.runMissingOwnedFanoutSynthesis(run) ||
            runtime.pendingAuthorityFanoutSynthesisParticipantId === participant.id
          const stillRetain =
            !stillDeferredNonManagerYield &&
            (stillWaveActive || (stillSynthesisPending && !runtime.yieldRouting))
          if (stillRetain) {
            noteMissingOnce()
            if (stillWaveActive) {
              this.clearNonAuthorityFanoutYieldRouting(runtime, run)
            }
            if (
              this.requeueAuthorityForActiveFanoutHold(
                runtime,
                remaining,
                participant,
                `${participantDisplayName(participant)} retains the authority turn while fan-out work remains unsettled.`
              )
            ) {
              continue
            }
            if (stillWaveActive && this.ownedFanoutHadWriteIntent(run)) {
              this.appendRoundStatus(
                runtime.chatId,
                runtime.roundId,
                `Authority fan-out hold: could not re-summon ${participantDisplayName(participant)} while writer lane(s) remain unsettled. Routing paused for this round.`
              )
              remaining.length = 0
              break
            }
          }
        }
      } else if (this.hasOwnedFanoutWork(run)) {
        await this.waitForOwnedFanoutSettlements(runtime, run)
        if (runtime.cancelled) break
      }
      // 1.0.7 — Option B enforcement for non-authority owners (and authority
      // seats that could not be re-queued): mark missing synthesis. Authority
      // re-summon above is the preferred path so ordinary writers do not start
      // while Boss/Captain still owes a synthesis turn.
      if (
        !(authorityFanoutRole && !managerFanoutHandoffPending) &&
        this.runMissingOwnedFanoutSynthesis(run)
      ) {
        this.noteMissingOwnedFanoutSynthesis(runtime, run)
      }
      // 1.0.7 — Defensive writer-lane conflict guard. The serial queue should
      // already be blocked while owned writer lanes are in flight; if another
      // serial writer somehow started during the hold, abort routing rather
      // than allow overlapping write intents.
      if (
        this.ownedFanoutHadWriteIntent(run) &&
        runtime.activeRunId !== undefined &&
        runtime.activeRunId !== run.runId
      ) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `Lane conflict: a serial writer started while ${participantDisplayName(run.participant)}'s writer lane(s) were still in flight. Routing paused for this round.`
        )
        remaining.length = 0
        break
      }
      // Continuous selectionRequired checkpoints are resolved after yield/@mention
      // routing below. Soft-note only the non-blocking tagged interventions here.
      if (
        !shouldResummonAuthorityForUnresolvedRouting({
          orchestrationMode: runtime.orchestrationMode,
          selectionRequired: run.authorityRoutingCheckpoint?.selectionRequired,
          decision: run.authorityRoutingDecision
        })
      ) {
        this.noteUnresolvedAuthorityRoutingCheckpoint(run)
      }
      const bossYieldedToUser =
        runtime.returnedControlToUser && this.isBossParticipant(chat, runtime, participant.id)
      if (bossYieldedToUser) {
        this.prepareBossYieldToUserClose(runtime)
      }
      // Absorb at most one queued prompt per participant boundary — FIFO,
      // same cadence as the old finishRound+beginRound chain — then let the
      // next seat see that single interjection. Never finishRound+beginRound.
      // When the serial roster is empty but detached lanes are still live,
      // leave the queue for the deferred drain tail so BG/fan-out output
      // lands before the interjection is delivered.
      if (runtime.queuedPrompts.length > 0) {
        const activeRound = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
        const holdForLanes =
          remaining.length === 0 && Boolean(activeRound && roundHasActiveLanes(activeRound))
        if (!holdForLanes) {
          this.absorbNextQueuedPromptIntoLiveRound(runtime)
        }
      }
      let routedByYieldTarget = false
      const pendingYieldRouting = runtime.yieldRouting
      if (pendingYieldRouting) {
        runtime.yieldRouting = undefined
        switch (pendingYieldRouting.kind) {
          case 'user':
            routedByYieldTarget = true
            this.clearYieldReturnStack(runtime)
            remaining.length = 0
            break
          case 'background': {
            const backgroundTarget = chat.ensemble.participants.find(
              (entry) => entry.id === pendingYieldRouting.targetParticipantId && entry.enabled
            )
            if (!backgroundTarget) {
              this.appendRoundStatus(
                runtime.chatId,
                runtime.roundId,
                backgroundDispatchFailureStatusLine({ ok: false, reason: 'target_missing' })
              )
              break
            }
            const dispatchResult = await this.dispatchBackgroundParticipants(
              runtime,
              chat,
              [backgroundTarget],
              {
                prompt: pendingYieldRouting.prompt,
                sourceRunId: pendingYieldRouting.sourceRunId,
                reason: `Explicit yield from ${participantDisplayName(participant)}.`
              }
            )
            if (dispatchResult.ok) {
              routedByYieldTarget = true
            }
            break
          }
          case 'queue':
            routedByYieldTarget = this.applyStoredYieldRouting(
              chat,
              runtime,
              run,
              remaining,
              pendingYieldRouting
            )
            break
          case 'rejected':
            this.discardYieldReturnFrameForYielder(runtime, participant.id)
            break
        }
      }
      const allParticipants = chat?.ensemble?.participants || []
      const detectedParticipantTagMatches = findAllMentions(
        run.content,
        allParticipants,
        new Set([participant.id])
      ).filter(
        (match): match is ParticipantMentionMatch =>
          match.kind === 'participant' && match.participant.enabled
      )
      // An explicit yield normally wins over conversational @mentions. The
      // active Boss/Captain is the deliberate exception: if a participant tags
      // the authority and then yields, run the bounded authority checkpoint
      // first, then let the requested handoff continue. This makes the tag a
      // usable between-turn intervention rather than an accidental no-op.
      if (routedByYieldTarget && !runtime.returnedControlToUser) {
        this.scheduleTaggedAuthorityIntervention(
          chat,
          runtime,
          remaining,
          run,
          detectedParticipantTagMatches
        )
      }
      const pendingParticipantTagMatches = routedByYieldTarget ? [] : detectedParticipantTagMatches
      const hasRoutableForegroundMention = pendingParticipantTagMatches.some(
        (match) =>
          (!runtime.dmTargetParticipantId ||
            match.participant.id === runtime.dmTargetParticipantId) &&
          !isBackgroundParticipant(match.participant) &&
          !match.ambiguousAmong?.length
      )
      if (!routedByYieldTarget && hasRoutableForegroundMention) {
        // A yielded target explicitly handed control onward in its assistant
        // response. That route outranks the implicit return to the original
        // yielder, and consumes the frame so it cannot fire if this participant
        // is summoned again later in the same round.
        this.discardYieldReturnFrameForTarget(runtime, participant.id)
      } else if (!routedByYieldTarget) {
        routedByYieldTarget = this.tryRouteYieldReturn(
          runtime,
          remaining,
          chat,
          participant,
          run.status
        )
      }
      // @-mention auto-promotion (1.0.3 post-ship).
      //
      // When a participant tags another participant in their reply
      // ("Yielding to @Researcher for fact-check", "@GPT 5.5 take a
      // look"), promote that tagged participant to the front of the
      // remaining queue OR append them if they've already had their
      // turn in this round. The result: collaborative back-and-forth
      // doesn't stall at the round boundary — agents can call each
      // other by name and the orchestrator routes the next turn
      // there.
      //
      // Resolution lives in `EnsembleMentionAlias.findAllMentions`,
      // shared with the renderer-side composer overlay + DM router so
      // tagging behaves identically across the three surfaces. New in
      // 1.0.3: multi-word model-name aliases (`@GPT 5.5`,
      // `@Sonnet 4.7`, `@Flash Lite`, `@Kimi K2.7 Coding`) for the 1.0.4
      // same-provider-multiple-models case.
      //
      // Skips self-mentions (agents talking about themselves) — the
      // `excludeIds` arg drops the speaker from the alias-map result
      // so an agent narrating its own role can't promote itself into
      // an infinite loop. Participant mentions are applied in prompt
      // order, while user mentions (`@user`, `@human`, `@you`) are
      // informational and never route the round.
      //
      // `chat` is already in scope from the top of the while loop —
      // no need to re-fetch.
      const participantTagMatches = routedByYieldTarget ? [] : pendingParticipantTagMatches
      const outOfScopeTagMatches = runtime.dmTargetParticipantId
        ? participantTagMatches.filter(
            (match) => match.participant.id !== runtime.dmTargetParticipantId
          )
        : []
      if (outOfScopeTagMatches.length > 0) {
        const ignoredMentions = [...new Set(outOfScopeTagMatches.map((match) => `@${match.text}`))]
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `@-mention: ${ignoredMentions.join(', ')} ${ignoredMentions.length === 1 ? 'is' : 'are'} outside this user-targeted round; no turn appended.`
        )
      }
      const tagMatches = runtime.dmTargetParticipantId
        ? participantTagMatches.filter(
            (match) => match.participant.id === runtime.dmTargetParticipantId
          )
        : participantTagMatches

      if (tagMatches.length > 0) {
        const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
        const primary = this.primaryBossUnavailable(chat, runtime, bossmanParticipantId)
        const priorityAuthorityId = primary.unavailable
          ? this.activeActingCaptainParticipantId(chat, runtime)
          : bossmanParticipantId
        const priorityAuthorityMatch = priorityAuthorityId
          ? tagMatches.find((tagMatch) => tagMatch.participant.id === priorityAuthorityId)
          : undefined
        const routeableTagMatches =
          priorityAuthorityMatch &&
          tagMatches.some(
            (tagMatch) => tagMatch.participant.id !== priorityAuthorityMatch.participant.id
          )
            ? [priorityAuthorityMatch]
            : tagMatches
        if (priorityAuthorityMatch && routeableTagMatches.length !== tagMatches.length) {
          const authorityLabel =
            priorityAuthorityMatch.participant.id === bossmanParticipantId
              ? 'Boss'
              : 'active Captain'
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `@-mention: ${participantDisplayName(priorityAuthorityMatch.participant)} is ${authorityLabel} and takes routing priority over advisory participant mentions.`
          )
        }
        const seenTagged = new Set<string>()
        const mentionedParticipants: EnsembleParticipant[] = []
        const ambiguityWarnings: string[] = []
        for (const tagMatch of routeableTagMatches) {
          const tagged = tagMatch.participant
          if (tagMatch.ambiguousAmong && tagMatch.ambiguousAmong.length > 0) {
            const candidates = [tagMatch.participant, ...tagMatch.ambiguousAmong]
            const candidateLabels = candidates.map((p) => participantDisplayName(p)).join(', ')
            const providerGroupLabel = participantProviderGroupLabel(candidates)
            ambiguityWarnings.push(
              `@-mention: \`@${tagMatch.text}\` was ambiguous (${candidates.length} ${providerGroupLabel}s: ${candidateLabels}). ` +
                'No route changed. Use @<role> or @<model> for explicit targeting.'
            )
            continue
          }
          if (seenTagged.has(tagged.id)) continue
          seenTagged.add(tagged.id)
          mentionedParticipants.push(tagged)
        }
        for (const warning of ambiguityWarnings) {
          this.appendRoundStatus(runtime.chatId, runtime.roundId, warning)
        }
        const backgroundTargets = mentionedParticipants.filter(isBackgroundParticipant)
        if (backgroundTargets.length > 0) {
          await this.dispatchBackgroundParticipants(runtime, chat, backgroundTargets, {
            prompt: run.content,
            sourceRunId: run.runId,
            reason: `Explicit @mention from ${participantDisplayName(participant)}.`
          })
        }
        const routedMentionedParticipants = mentionedParticipants.filter(
          (tagged) => !isBackgroundParticipant(tagged)
        )
        const remainingTargetIds = new Set(
          routedMentionedParticipants
            .filter((tagged) => remaining.some((entry) => entry.id === tagged.id))
            .map((tagged) => tagged.id)
        )
        const orderedTargets = routedMentionedParticipants.filter((tagged) =>
          remainingTargetIds.has(tagged.id)
        )
        let mentionRouted = false
        if (orderedTargets.length > 0) {
          const rest = remaining.filter((entry) => !remainingTargetIds.has(entry.id))
          remaining.splice(0, remaining.length, ...orderedTargets, ...rest)
          mentionRouted = true
          if (
            priorityAuthorityMatch &&
            remainingTargetIds.has(priorityAuthorityMatch.participant.id)
          ) {
            runtime.pendingAuthorityRoutingCheckpoints ??= new Map()
            runtime.pendingAuthorityRoutingCheckpoints.set(
              priorityAuthorityMatch.participant.id,
              this.taggedAuthorityRoutingCheckpoint(runtime, run)
            )
          }
          // Spike 4 — an explicit @-mention outranks the reviewer stage gate.
          for (const target of orderedTargets) stageGateExemptIds.add(target.id)
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `@-mention: ${orderedTargets
              .map((entry) => entry.role || entry.provider)
              .join(', ')} promoted to speak next.`
          )
        }
        const extraTargets = routedMentionedParticipants.filter(
          (tagged) => !remainingTargetIds.has(tagged.id)
        )
        if (runtime.orchestrationMode === 'continuous') {
          for (const tagged of extraTargets.slice().reverse()) {
            // The Boss/Captain priority authority is re-summoned even after it
            // already spoke ('answered') OR explicitly yielded ('yielded') this
            // round — a directed @-mention to the Boss must actually route, not
            // just print the priority note above (mirrors summon_participant at
            // :5194, which passes both allowAnswered + allowYielded).
            // The hop budget still throttles it (one hop per re-summon, same as
            // any continuation). Advisory (non-authority) participants keep the
            // existing "no re-summon of an already-terminal participant" behavior.
            const isPriorityAuthority = tagged.id === priorityAuthorityMatch?.participant.id
            const continuation = this.tryAppendContinuationTurn(
              runtime,
              remaining,
              tagged,
              `@-mention: extra turn appended for ${tagged.role || tagged.provider}.`,
              {
                allowAnsweredParticipant: isPriorityAuthority,
                allowYieldedParticipant: isPriorityAuthority
              }
            )
            if (continuation.appended) {
              mentionRouted = true
              if (isPriorityAuthority) {
                runtime.pendingAuthorityRoutingCheckpoints ??= new Map()
                runtime.pendingAuthorityRoutingCheckpoints.set(
                  tagged.id,
                  this.taggedAuthorityRoutingCheckpoint(runtime, run)
                )
              }
              // Spike 4 — an explicitly summoned extra turn outranks the
              // reviewer stage gate.
              stageGateExemptIds.add(tagged.id)
            } else if (isPriorityAuthority) {
              // The priority route couldn't be delivered. Report the ACTUAL
              // reason (hop budget vs. the Boss run failed/skipped/cancelled)
              // so the earlier "takes routing priority" note isn't left as an
              // unfulfilled promise — and isn't misattributed to the hop budget.
              const authorityLabel = tagged.id === bossmanParticipantId ? 'Boss' : 'active Captain'
              this.appendRoundStatus(
                runtime.chatId,
                runtime.roundId,
                `@-mention: could not re-summon ${participantDisplayName(tagged)} (${authorityLabel}) — ${this.describeContinuationDecline(continuation)}.`
              )
            }
          }
        } else {
          for (const tagged of extraTargets) {
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              `@-mention: ${tagged.role || tagged.provider} already spoke in this turn-bound round; no extra turn appended. Use Continuous mode for back-and-forth handoffs.`
            )
          }
        }
        if (mentionRouted) {
          this.markAuthorityRoutingDecision(run, 'mentioned')
        }
      }
      if (
        shouldResummonAuthorityForUnresolvedRouting({
          orchestrationMode: runtime.orchestrationMode,
          selectionRequired: run.authorityRoutingCheckpoint?.selectionRequired,
          decision: run.authorityRoutingDecision
        })
      ) {
        const statusMessage = `Authority routing checkpoint: ${participantDisplayName(participant)} ended without an explicit routing decision; re-summoning before ordinary serial writers.`
        if (
          this.requeueAuthorityForActiveFanoutHold(runtime, remaining, participant, statusMessage)
        ) {
          runtime.pendingAuthorityRoutingCheckpoints ??= new Map()
          runtime.pendingAuthorityRoutingCheckpoints.set(
            participant.id,
            run.authorityRoutingCheckpoint!
          )
          continue
        }
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${statusMessage} Could not re-summon ${participantDisplayName(participant)}; pausing ordinary serial writers for this round.`
        )
        remaining.length = 0
        break
      }
      // 1.0.4 — remember whose dispatch is "the yield target" for
      // the next iteration so a failed dispatch on that participant
      // emits the yield-specific transcript note. Only the yield
      // path sets this; the @-mention block above promotes via its
      // own logic but doesn't get the yield-specific treatment (the
      // generic skip note still names the participant, which is
      // sufficient for that case).
      if (routedByYieldTarget && remaining.length > 0) {
        yieldedTargetParticipantId = remaining[0].id
        // Spike 4 — an explicit yield / yield-return promotion outranks the
        // reviewer stage gate for the promoted participant.
        stageGateExemptIds.add(remaining[0].id)
      }
    }

    // cancelRound owns the terminal projection and checkpoint notification.
    // A participant completion resolved by that cancellation wakes this serial
    // loop; returning here prevents the stale async tail from terminalizing the
    // same round a second time.
    if (runtime.cancelled) return

    // 1.0.4 — user-fallback note. When every dispatch in this round
    // failed with `unreachable`, the round closed with no speaker.
    // Tell the user explicitly so they know to re-launch their
    // providers — otherwise the transcript just shows back-to-back
    // skip notes with no overall verdict. Bounded by:
    //   - `remaining.length === 0` — we exhausted every participant
    //     (didn't break early on queued prompts or cancellation)
    //   - `!runtime.cancelled` — user-initiated cancel has its own
    //     cancellation transcript line
    //   - `dispatchAttempts > 0` — empty participant list shouldn't
    //     trigger this (DM target was disabled, ordered set empty)
    //   - all attempts unreachable — at least one non-unreachable
    //     reason means the user has a per-participant note to act
    //     on; the fallback note would be misleading there
    if (
      remaining.length === 0 &&
      !runtime.cancelled &&
      dispatchAttempts > 0 &&
      unreachableFailures === dispatchAttempts
    ) {
      this.appendRoundStatus(runtime.chatId, runtime.roundId, formatAllUnreachableNote())
    }

    // Detached lanes must settle before queue absorb / steering boundary /
    // continuous auto-continue, so BG and fan-out output stay ahead of the
    // next same-round interjection delivery.
    if (!runtime.cancelled) this.deliverExternalSeatTurns(runtime, undefined)
    if (!runtime.cancelled && this.deferDrainForActiveLanes(runtime)) return

    // Absorb one queued prompt at the drain boundary, then grant a same-round
    // seat turn for it. Remaining FIFO entries wait for later boundaries —
    // never finishRound+beginRound from the queue.
    if (!runtime.cancelled && remaining.length === 0 && runtime.queuedPrompts.length > 0) {
      this.absorbNextQueuedPromptIntoLiveRound(runtime)
    }

    const steeringBoundaryParticipant = this.takeMidRunSteeringBoundaryParticipant(runtime)
    if (steeringBoundaryParticipant && !runtime.cancelled) {
      await this.trackRoundActivity(
        runtime,
        this.runRound(runtime, [steeringBoundaryParticipant], { skipPreamble: true })
      )
      return
    }

    if (
      remaining.length === 0 &&
      !runtime.cancelled &&
      !runtime.returnedControlToUser &&
      runtime.queuedPrompts.length === 0 &&
      this.hasPendingWakeups(runtime)
    ) {
      const wakeup = await this.waitForNextWakeup(runtime)
      if (wakeup && !runtime.cancelled) {
        const chatForWake = this.deps.getChat(runtime.chatId)
        const participant = this.participantForWakeup(chatForWake, wakeup)
        if (participant) {
          runtime.resumeWakeup = wakeup
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `${participant.role || providerLabel(participant.provider)} woke for scheduled continuation (${wakeup.wakeAt}).`
          )
          if (!participant.linkedProviderSessionId) {
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              `${participant.role || providerLabel(participant.provider)} is resuming from TaskWraith transcript context; no native provider session id was available.`
            )
          }
          await this.trackRoundActivity(runtime, this.runRound(runtime, [participant]))
          return
        }
      }
    }

    const chatAfterCheck = this.deps.getChat(runtime.chatId)

    // Continuous-mode autonomous continuation. When the serial loop drained with
    // NO explicit yield/@-mention handoff, a 'continuous' round must not silently
    // end at the round boundary — it keeps re-dispatching the roster (consuming
    // one hop per participant) until a stop condition fires. Priority order is
    // preserved: a queued user prompt (checked here) and a pending wakeup
    // (handled + `return`ed above) both win over auto-continuation. A permission
    // elevation stall can't reach this point — it blocks `await completion`
    // upstream, so the loop never drains while a run is paused for approval.
    // `tryAutoContinueRound` owns the mode/goal/hop/no-progress gating.
    if (
      remaining.length === 0 &&
      !runtime.cancelled &&
      !runtime.returnedControlToUser &&
      runtime.queuedPrompts.length === 0 &&
      chatAfterCheck
    ) {
      const continuationRoster = this.tryAutoContinueRound(runtime, chatAfterCheck)
      if (continuationRoster && continuationRoster.length > 0 && !runtime.cancelled) {
        await this.trackRoundActivity(
          runtime,
          this.runRound(runtime, continuationRoster, {
            skipPreamble: true,
            repeatOpeningScoutFanout: true
          })
        )
        return
      }
    }

    this.finalizeDrainedRound(runtime)
  }

  /**
   * Returns true (and records the deferral) when the just-drained round
   * still has a non-terminal fan-out lane, or an `ensemble_fanout` call is
   * mid-dispatch (participants reserved, lanes not yet seeded). The round
   * stays `'running'` so lane output keeps landing in an open round;
   * `maybeResumeDeferredDrain` replays the drain tail once every lane is
   * terminal and the reservation window has closed.
   */
  private deferDrainForActiveLanes(runtime: ActiveRoundRuntime): boolean {
    const round = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
    if (!round || round.roundId !== runtime.roundId || round.status !== 'running') return false
    const reservedCount = runtime.fanoutReservedParticipantIds?.size || 0
    if (!roundHasActiveLanes(round) && reservedCount === 0) return false
    this.deferredLaneDrainByChatId.set(runtime.chatId, runtime)
    const activeLaneCount = Object.values(round.lanes || {}).filter(
      (lane) => !isTerminalLaneStatus(lane.status)
    ).length
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `Serial queue drained · holding the round open for ${Math.max(activeLaneCount, reservedCount)} active fan-out lane(s).`
    )
    return true
  }

  private async waitForOwnedFanoutSettlements(
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): Promise<void> {
    let noted = false
    const timeoutMs =
      this.deps.ownedFanoutSettlementTimeoutMs ?? DEFAULT_OWNED_FANOUT_SETTLEMENT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    while (!runtime.cancelled) {
      const settlements = [
        ...(run.pendingFanoutDispatches || []),
        ...(run.ownedFanoutSettlements || [])
      ]
      if (settlements.length === 0) return
      if (!noted) {
        noted = true
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${participantDisplayName(run.participant)} is waiting for its fan-out lane(s) to return before foreground handoff.`
        )
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        run.fanoutTimedOut = true
        const pendingLabels = this.pendingOwnedFanoutLaneLabels(run)
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${participantDisplayName(run.participant)}'s fan-out lane(s) did not settle within ${timeoutMs / 1000}s; proceeding with partial results. Pending: ${pendingLabels}.`
        )
        return
      }
      // Re-read after every wave. A dispatch reservation can resolve only after
      // it has attached the accepted lane settlement, and concurrent fan-out
      // calls can add another reservation while this owner is still live.
      await Promise.race([
        Promise.all(settlements),
        new Promise<void>((resolve) => setTimeout(resolve, remainingMs))
      ])
    }
  }

  private pendingOwnedFanoutLaneLabels(run: ActiveParticipantRun): string {
    const runIds = run.ownedFanoutRunIds
    if (!runIds || runIds.size === 0) return 'unknown'
    const labels: string[] = []
    for (const runId of runIds) {
      const laneRun = this.runsByRunId.get(runId)
      labels.push(
        laneRun
          ? `${participantDisplayName(laneRun.participant)} (${laneRun.laneId || runId})`
          : runId
      )
    }
    return labels.join(', ') || 'unknown'
  }

  private hasOwnedFanoutWork(run: ActiveParticipantRun): boolean {
    return Boolean(run.pendingFanoutDispatches?.size || run.ownedFanoutSettlements?.size)
  }

  private hasPendingOwnedFanoutSettlements(chatId: string, roundId: string): boolean {
    return [...this.runsByRunId.values()].some(
      (run) =>
        run.chatId === chatId &&
        run.roundId === roundId &&
        !run.laneId &&
        this.hasOwnedFanoutWork(run)
    )
  }

  /**
   * Warn-and-continue for seats without image transport: strip paths, emit a
   * participant-health notice, and let the text turn dispatch.
   */
  private imagePathsForParticipantDispatch(
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant
  ): string[] {
    const resolved = resolveImagePathsForProvider(
      participant.provider,
      imagePathsForEnsembleAttachments(runtime.imageAttachments),
      providerLabel(participant.provider)
    )
    if (resolved.warning) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${PARTICIPANT_HEALTH_TAG} △ ${participantDisplayName(participant)}: ${resolved.warning}`
      )
    }
    return resolved.imagePaths
  }

  private ownedFanoutHadWriteIntent(run: ActiveParticipantRun): boolean {
    const runIds = run.ownedFanoutRunIds
    if (!runIds || runIds.size === 0) return false
    for (const runId of runIds) {
      const laneRun = this.runsByRunId.get(runId)
      if (laneRun && laneRun.laneIntent === 'write') return true
    }
    return false
  }

  /**
   * Release terminal bookkeeping/transcript ownership only after both the
   * dispatch window and every accepted lane settlement have drained.
   */
  private releaseOwnedFanoutHold(sourceRun: ActiveParticipantRun): void {
    if (this.hasOwnedFanoutWork(sourceRun)) return
    if (sourceRun.releasingOwnedFanoutHold) return
    try {
      sourceRun.releasingOwnedFanoutHold = true
      const round = this.deps.getChat(sourceRun.chatId)?.ensemble?.activeRound
      const runtime = this.roundsByChatId.get(sourceRun.chatId)
      const boundary = sourceRun.ownedFanoutTranscriptBoundary
      const hasPostFanoutTimeline =
        boundary !== undefined && (sourceRun.timeline?.length || 0) > boundary
      const permanentSuppress =
        !runtime ||
        runtime.roundId !== sourceRun.roundId ||
        runtime.cancelled ||
        sourceRun.suppressOwnedFanoutTranscriptRelease === true ||
        !round ||
        round.roundId !== sourceRun.roundId ||
        round.status !== 'running'
      // 1.0.7 — Option B enforcement: keep the hold until the caller emits
      // post-fan-out synthesis prose. This applies even before the serial loop
      // has stamped fanoutSynthesisRequired, because lane settlement callbacks
      // can reach releaseOwnedFanoutHold first. A terminal turn is released
      // anyway so the serial queue is never pinned by a silent provider; a
      // timed-out turn has already been announced as proceeding with partial
      // results.
      const awaitingSynthesis =
        boundary !== undefined &&
        !hasPostFanoutTimeline &&
        sourceRun.terminalFinalized !== true &&
        sourceRun.fanoutTimedOut !== true
      if (permanentSuppress || awaitingSynthesis) {
        if (permanentSuppress) {
          /* Dropping the held tail once the round is gone is defensible.
           * Dropping it SILENTLY is not: the transcript just stops at the
           * fan-out call, which is indistinguishable from the provider
           * truncating the reply, and has repeatedly sent people hunting
           * max_tokens and context walls for prose this method discarded.
           *
           * Only speak when there is something to mourn (`hasPostFanoutTimeline`)
           * — an owner that never wrote after fanning out has lost nothing.
           *
           * Cause comes from the ROUND, not the runtime: by the time a late
           * settlement lands the runtime is typically already gone (measured:
           * `runtime` undefined, `round.status` still readable as 'cancelled'),
           * so reading `runtime?.cancelled` here would report every stop as an
           * ordinary close. */
          if (hasPostFanoutTimeline && !sourceRun.discardedSynthesisNoticePosted) {
            sourceRun.discardedSynthesisNoticePosted = true
            const cause =
              round?.status === 'cancelled'
                ? 'the round was stopped before its fan-out lane(s) returned.'
                : 'the round had already ended when its fan-out lane(s) returned.'
            this.appendRoundStatus(
              sourceRun.chatId,
              sourceRun.roundId,
              `${participantDisplayName(sourceRun.participant)}'s continuation written after it fanned out was discarded: ${cause}`
            )
          }
          sourceRun.suppressOwnedFanoutTranscriptRelease = true
          sourceRun.releaseOwnedFanoutTranscriptAtTail = undefined
        }
      } else if (boundary !== undefined) {
        sourceRun.fanoutSynthesisRequired = false
        sourceRun.ownedFanoutTranscriptBoundary = undefined
        sourceRun.forceNextTimelineContentEntry = !hasPostFanoutTimeline
        sourceRun.releaseOwnedFanoutTranscriptAtTail = true
        this.flushRun(sourceRun, sourceRun.terminalFinalized === true, sourceRun.terminalReason)
      }
      if (sourceRun.terminalFinalized) {
        this.applyTerminalRunSideEffects(sourceRun)
      }
    } finally {
      sourceRun.releasingOwnedFanoutHold = false
      if (sourceRun.terminalFinalized && this.runsByRunId.get(sourceRun.runId) === sourceRun) {
        this.runsByRunId.delete(sourceRun.runId)
      }
    }
  }

  /**
   * Resume a serial drain that was deferred behind active fan-out lanes.
   * No-ops unless every lane for the deferred round is terminal AND no
   * fan-out reservation window is open. If the round was cancelled (or
   * superseded) while deferred, the entry is dropped — `cancelRound`
   * already closed the round.
   */
  private maybeResumeDeferredDrain(chatId: string): void {
    const runtime = this.deferredLaneDrainByChatId.get(chatId)
    if (!runtime) return
    const round = this.deps.getChat(chatId)?.ensemble?.activeRound
    if (!round || round.roundId !== runtime.roundId || round.status !== 'running') {
      this.deferredLaneDrainByChatId.delete(chatId)
      return
    }
    if (roundHasActiveLanes(round) || runtime.fanoutReservedParticipantIds?.size) return
    // A lane's durable status becomes terminal before the detached fan-out
    // settlement finishes its owner cleanup. Do not close the round in that
    // window: the owner may already have post-fan-out prose buffered behind
    // its transcript boundary, and Continuous mode still needs the ordinary
    // drain hook to decide whether to auto-continue.
    if (this.hasPendingOwnedFanoutSettlements(chatId, runtime.roundId)) return
    this.deferredLaneDrainByChatId.delete(chatId)
    const pendingSerialParticipants = runtime.remainingParticipants || []
    if (pendingSerialParticipants.length > 0 && !runtime.cancelled) {
      void this.trackRoundActivity(
        runtime,
        this.runRound(runtime, [...pendingSerialParticipants], { skipPreamble: true })
      )
      return
    }
    if (!runtime.cancelled && runtime.queuedPrompts.length > 0) {
      this.absorbNextQueuedPromptIntoLiveRound(runtime)
    }
    const steeringBoundaryParticipant = this.takeMidRunSteeringBoundaryParticipant(runtime)
    if (steeringBoundaryParticipant && !runtime.cancelled) {
      void this.trackRoundActivity(
        runtime,
        this.runRound(runtime, [steeringBoundaryParticipant], { skipPreamble: true })
      )
      return
    }
    // Same Continuous drain tail as runRound: once every lane/reservation and
    // owned settlement is clear, auto-continue when hops remain. Previously
    // gated behind `allowAutoContinuation`, which left BG / non-owned deferred
    // resumes calling finalizeDrainedRound with unused hops (Review wave or
    // other fan-out completes → Task Complete while Continuous should keep
    // going / return to Boss). Owned settlement ordering stays protected by
    // `hasPendingOwnedFanoutSettlements` above.
    if (!runtime.cancelled && runtime.queuedPrompts.length === 0) {
      const chat = this.deps.getChat(chatId)
      if (chat) {
        const continuationRoster = this.tryAutoContinueRound(runtime, chat)
        if (continuationRoster && continuationRoster.length > 0 && !runtime.cancelled) {
          void this.trackRoundActivity(
            runtime,
            this.runRound(runtime, continuationRoster, {
              skipPreamble: true,
              repeatOpeningScoutFanout: true
            })
          )
          return
        }
      }
    }
    this.finalizeDrainedRound(runtime)
  }

  /**
   * Claim one same-round participant turn when an interjection arrived after
   * the final ordinary prompt was composed. This is user-input delivery, not
   * an autonomous continuation: it neither starts a new round nor consumes the
   * Continuous-mode hop budget.
   */
  private takeMidRunSteeringBoundaryParticipant(
    runtime: ActiveRoundRuntime
  ): EnsembleParticipant | null {
    if (runtime.cancelled) return null
    const getPending = this.deps.getPendingMidRunSteeringEntryIds
    if (!getPending) return null
    const chat = this.deps.getChat(runtime.chatId)
    const round = chat?.ensemble?.activeRound
    if (
      !chat?.ensemble ||
      !round ||
      round.roundId !== runtime.roundId ||
      round.status !== 'running' ||
      roundHasActiveLanes(round) ||
      runtime.fanoutReservedParticipantIds?.size
    ) {
      return null
    }
    const pendingIds = getPending(runtime.chatId).filter(Boolean)
    if (pendingIds.length === 0) return null
    const roundStatusByParticipantId = new Map(
      round.participants.map((participant) => [participant.participantId, participant.status])
    )
    const unavailableParticipantIds = new Set(runtime.unreachableParticipantIds || [])
    for (const participant of chat.ensemble.participants) {
      if (this.participantFanoutDispatchState(runtime, participant.id)) {
        unavailableParticipantIds.add(participant.id)
      }
    }
    const plan = planEnsembleMidRunSteeringBoundary({
      pendingEntryIds: pendingIds,
      participants: chat.ensemble.participants,
      participantStatusById: roundStatusByParticipantId,
      preferredParticipantIds: [
        runtime.dmTargetParticipantId,
        runtime.lastForegroundParticipantId,
        runtime.bossmanParticipantId,
        ...this.activeCaptainParticipantIds(chat, runtime),
        resolveForegroundSynthesizerParticipantId(chat.ensemble)
      ],
      dmTargetParticipantId: runtime.dmTargetParticipantId,
      unavailableParticipantIds,
      previousState: runtime.midRunSteeringBoundaryState
    })
    runtime.midRunSteeringBoundaryState = plan.state
    if (plan.exhausted) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        'The user interjected at the round boundary, but no eligible foreground participant remained to receive it.'
      )
      return null
    }
    return plan.participant
  }

  /**
   * The serial drain tail: finish the round and release the runtime.
   * Queued prompts are absorbed into the live round earlier in `runRound`;
   * this path must never `beginRound` from the queue (steer/queue never
   * start a fresh round). Any leftover queue is preserved on the finished
   * round for restart/orphan recovery only.
   */
  private finalizeDrainedRound(runtime: ActiveRoundRuntime): void {
    const chat = this.deps.getChat(runtime.chatId)
    const continuationLimitStillOwnsClose =
      runtime.continuationLimitPending === true &&
      !runtime.cancelled &&
      !runtime.returnedControlToUser &&
      runtime.queuedPrompts.length === 0 &&
      (!chat?.activeGoal || chat.activeGoal.status === 'active')
    runtime.continuationLimitPending = false
    if (continuationLimitStillOwnsClose) {
      this.notifyContinuationLimitReached(runtime)
    }
    const quarantinedLegacyPrompts = !runtime.cancelled
      ? runtime.quarantinedLegacyQueuedPrompts || []
      : []
    const leftoverQueue =
      !runtime.cancelled && runtime.queuedPrompts.length > 0 ? runtime.queuedPrompts : []
    this.finishRound(
      runtime.chatId,
      runtime.roundId,
      runtime.cancelled ? 'cancelled' : 'completed',
      {
        queuedPromptEntries: leftoverQueue,
        quarantinedLegacyPrompts
      }
    )
    this.clearRuntimeIfCurrent(runtime)
  }

  private resolveFanoutTargets(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun,
    rawTargets: unknown,
    /** Eligibility is mode-independent since 2026-08-04 (read_only lanes are
     * clamped at dispatch; locked_writers lanes still require write scopes
     * there). Kept in the signature so call sites stay self-documenting. */
    _mode: EnsembleFanoutMode,
    targetStage?: EnsembleFanoutTargetStage
  ):
    | { ok: true; targets: EnsembleParticipant[] }
    | {
        ok: false
        message: string
        error: Exclude<EnsembleFanoutResult['error'], undefined>
      } {
    const explicitTargets = normalizeTargetList(rawTargets)
    const participants = this.scopedFanoutParticipants(chat)
    const activeParticipantIds = new Set<string>()
    for (const active of this.runsByRunId.values()) {
      if (active.chatId === runtime.chatId && active.roundId === runtime.roundId) {
        activeParticipantIds.add(active.participant.id)
      }
    }
    // Boss/Captain authority seats are structurally excluded from BROAD
    // discovery: authority allocates lanes, it is never conscripted into
    // one by a peer's `all` sweep. (Pre-2026-08-04 this exclusion was a
    // posture accident — a write-postured Boss failed the read-only filter
    // while a read-only Boss would have been swept.) Explicit targets can
    // still name an authority seat deliberately.
    const authorityParticipantIds = new Set<string>(
      [
        chat.ensemble?.bossmanParticipantId,
        ...configuredEnsembleCaptainParticipantIds({
          participants: chat.ensemble?.participants || [],
          bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
          captainParticipantIds: chat.ensemble?.captainParticipantIds,
          secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId
        })
      ].filter((id): id is string => Boolean(id))
    )
    const isEligible = (participant: EnsembleParticipant): boolean => {
      if (!participant.enabled) return false
      if (!isEnsembleSeatProvider(participant.provider)) return false
      if (participant.id === run.participant.id) return false
      if (authorityParticipantIds.has(participant.id)) return false
      if (activeParticipantIds.has(participant.id)) return false
      // A target can be reserved for a concurrent ensemble_fanout call whose
      // lane runs are not yet seeded into runsByRunId (the seat-compaction
      // barrier holds that window open for seconds). '=== active' keeps
      // participants whose lane already SETTLED re-targetable, as before.
      if (this.participantFanoutDispatchState(runtime, participant.id) === 'active') return false
      if (!fanoutTargetStageMatches(participant, targetStage)) return false
      // Eligibility is otherwise permission-agnostic (2026-08-04): broad
      // discovery matches explicit-target semantics. A seat's configured
      // preset is immaterial because read_only-mode lanes are dispatched
      // under the signed read_only clamp; locked_writers lanes still
      // require write scopes at dispatch.
      return true
    }
    if (explicitTargets.length === 0 || explicitTargets.some((target) => /^@?all$/i.test(target))) {
      const targets = participants.filter(isEligible)
      if (targets.length === 0) {
        return {
          ok: false,
          message: 'ensemble_fanout: no enabled, idle peer participants are available.',
          error: 'no_eligible_targets'
        }
      }
      return { ok: true, targets }
    }

    const targets: EnsembleParticipant[] = []
    for (const rawTarget of explicitTargets) {
      const target = stripLeadingAt(rawTarget)
      const participant = resolvePhraseToParticipant(
        target,
        participants,
        new Set([run.participant.id])
      )
      if (!participant || !participant.enabled) {
        return {
          ok: false,
          message: `ensemble_fanout: target "${rawTarget}" did not resolve to an enabled participant.`,
          error: 'invalid_target'
        }
      }
      if (!isEnsembleSeatProvider(participant.provider)) {
        return {
          ok: false,
          message: `ensemble_fanout: target "${rawTarget}" uses a provider that is unavailable for new runs.`,
          error: 'invalid_target'
        }
      }
      if (activeParticipantIds.has(participant.id)) {
        return {
          ok: false,
          message: `ensemble_fanout: target "${rawTarget}" is already active in this round.`,
          error: 'invalid_target'
        }
      }
      if (this.participantFanoutDispatchState(runtime, participant.id) === 'active') {
        return {
          ok: false,
          message: `ensemble_fanout: target "${rawTarget}" is already reserved for or running in a fan-out lane.`,
          error: 'invalid_target'
        }
      }
      if (!fanoutTargetStageMatches(participant, targetStage)) {
        return {
          ok: false,
          message: `ensemble_fanout: target "${rawTarget}" does not match targetStage=${targetStage}.`,
          error: 'invalid_target'
        }
      }
      // An explicit target is an operator-authored routing decision. In
      // read_only mode its configured seat posture is immaterial because the
      // actual lane dispatch below is rebuilt with the signed read_only preset,
      // ignores overrides, and disallows Full Access. Broad/all discovery
      // applies the same permission-agnostic rule.
      targets.push(participant)
    }
    const deduped = dedupeParticipants(targets)
    if (deduped.length === 0) {
      return {
        ok: false,
        message: 'ensemble_fanout: no eligible targets resolved.',
        error: 'no_eligible_targets'
      }
    }
    return { ok: true, targets: deduped }
  }

  private scopedFanoutParticipants(chat: ChatRecord): EnsembleParticipant[] {
    return chat.ensemble?.participants || []
  }

  private canRequestBroadFanout(chat: ChatRecord, run: ActiveParticipantRun): boolean {
    const ensemble = chat.ensemble
    if (!ensemble) return false
    if (isBackgroundParticipant(run.participant)) return false
    const runtime = this.roundsByChatId.get(run.chatId)
    if (runtime && this.fanoutAuthorityRoleForCaller(chat, runtime, run.participant.id)) {
      return true
    }
    return (
      ensemble.bossmanParticipantId === run.participant.id ||
      configuredEnsembleCaptainParticipantIds({
        participants: ensemble.participants,
        bossmanParticipantId: ensemble.bossmanParticipantId,
        captainParticipantIds: ensemble.captainParticipantIds,
        secondInCommandParticipantId: ensemble.secondInCommandParticipantId
      }).includes(run.participant.id)
    )
  }

  /**
   * Open one additive user-owned wave without replacing the active round.
   * Running/reserved seats keep the ordinary transcript steer and are not
   * duplicated; every other explicitly tagged current seat is reserved before
   * the async dispatch starts so the serial loop cannot race it.
   */
  private launchUserFanout(
    runtime: ActiveRoundRuntime,
    requested: EnsembleParticipant[],
    prompt: string,
    sourceMessageId: string
  ): void {
    if (runtime.cancelled) return
    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) return
    const idleParticipants = dedupeParticipants(requested).filter(
      (participant) =>
        participant.enabled !== false &&
        !this.isParticipantActivelyExecuting(runtime, participant.id)
    )
    // Materialize every explicit idle target in the round projection before
    // splitting concurrent and serial execution. Background seats are absent
    // from ordinary serial roster construction, but a direct user tag remains
    // authoritative routing even when the write-lane kill switch is off.
    this.updateChatRound(runtime.chatId, (round) => {
      if (!round || round.roundId !== runtime.roundId) return round
      const present = new Set(round.participants.map((entry) => entry.participantId))
      const added = idleParticipants
        .filter((participant) => !present.has(participant.id))
        .map((participant) => roundParticipantStateFromParticipant(participant, 'idle'))
      return added.length > 0
        ? { ...round, participants: [...round.participants, ...added] }
        : round
    })
    const writeLanesEnabled = concurrentWriteLanesEnabled()
    const participants = idleParticipants.filter(
      (participant) =>
        writeLanesEnabled ||
        this.resolveFanoutOwnDispatchPermissions(chat, runtime, participant).readOnly
    )
    const participantIds = new Set(participants.map((participant) => participant.id))
    const deferredWriters = idleParticipants.filter(
      (participant) => !participantIds.has(participant.id)
    )
    if (deferredWriters.length > 0) {
      const remaining = runtime.remainingParticipants ?? (runtime.remainingParticipants = [])
      const deferredIds = new Set(deferredWriters.map((participant) => participant.id))
      const rest = remaining.filter((participant) => !deferredIds.has(participant.id))
      remaining.splice(0, remaining.length, ...deferredWriters, ...rest)
      runtime.userFanoutSerialParticipantIds ??= new Set()
      for (const participant of deferredWriters) {
        runtime.userFanoutSerialParticipantIds.add(participant.id)
      }
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `User Fan-Out queued ${deferredWriters.length} write-capable tagged seat(s) for the next serial boundary because TASKWRAITH_CONCURRENT_WRITE_LANES=0; their configured posture was not weakened.`
      )
    }
    if (participants.length === 0) return

    runtime.fanoutReservedParticipantIds ??= new Set()
    for (const participant of participants) {
      runtime.fanoutReservedParticipantIds.add(participant.id)
    }

    const acceptedParticipantIds = this.dispatchUserFanout(
      runtime,
      participants,
      prompt,
      sourceMessageId
    )
    runtime.userFanoutDispatchSettlements ??= new Map()
    const settlements = new Map<string, Promise<boolean>>()
    for (const participant of participants) {
      const settlement = acceptedParticipantIds.then((acceptedIds) =>
        acceptedIds.has(participant.id)
      )
      settlements.set(participant.id, settlement)
      runtime.userFanoutDispatchSettlements.set(participant.id, settlement)
    }
    const activity = acceptedParticipantIds
      .then(() => undefined)
      .finally(() => {
        for (const [participantId, settlement] of settlements) {
          if (runtime.userFanoutDispatchSettlements?.get(participantId) === settlement) {
            runtime.userFanoutDispatchSettlements.delete(participantId)
          }
        }
        if (runtime.userFanoutDispatchSettlements?.size === 0) {
          runtime.userFanoutDispatchSettlements = undefined
        }
      })
    void this.trackRoundActivity(runtime, activity)
  }

  private async dispatchUserFanout(
    runtime: ActiveRoundRuntime,
    participants: EnsembleParticipant[],
    prompt: string,
    sourceMessageId: string
  ): Promise<Set<string>> {
    const acceptedParticipantIds = new Set<string>()
    try {
      if (!concurrentLanesEnabled()) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          'User Fan-Out not launched because parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0); tagged seats remain in normal rotation.'
        )
        return acceptedParticipantIds
      }
      const chat = this.deps.getChat(runtime.chatId)
      if (!chat?.ensemble || runtime.cancelled) return acceptedParticipantIds
      const acceptedRuns: ActiveParticipantRun[] = []
      await this.runParallelFanoutPass(runtime, chat, participants, {
        prompt,
        label: 'User Fan-Out',
        promptAuthority: 'user',
        userPromptSourceMessageId: sourceMessageId,
        dispatchOwnPermissions: true,
        acceptedRuns,
        waitForCompletion: false,
        completionDisposition: 'background'
      })
      for (const acceptedRun of acceptedRuns) {
        acceptedParticipantIds.add(acceptedRun.participant.id)
      }
      if (acceptedParticipantIds.size > 0) {
        runtime.fannedOutParticipantIds ??= new Set()
        for (const participantId of acceptedParticipantIds) {
          runtime.fannedOutParticipantIds.add(participantId)
        }
      }
      const rejectedCount = participants.length - acceptedParticipantIds.size
      if (rejectedCount > 0 && !runtime.cancelled) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `User Fan-Out dispatch receipt: ${acceptedParticipantIds.size} lane(s) accepted; ${rejectedCount} tagged seat(s) did not reach provider invocation and remain eligible for normal rotation.`
        )
      }
      return acceptedParticipantIds
    } catch (error) {
      if (!runtime.cancelled) {
        const message = error instanceof Error ? error.message : String(error)
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `User Fan-Out dispatch failed without interrupting the round: ${message}`
        )
      }
      return acceptedParticipantIds
    } finally {
      for (const participant of participants) {
        runtime.fanoutReservedParticipantIds?.delete(participant.id)
      }
      if (runtime.fanoutReservedParticipantIds?.size === 0) {
        runtime.fanoutReservedParticipantIds = undefined
      }
      this.maybeResumeDeferredDrain(runtime.chatId)
    }
  }

  /**
   * Explicit BG routing reuses the normal fan-out lane executor, but automatic
   * @mention/yield launches are always read-only. This keeps shell/test/recon
   * useful while reserving asynchronous mutations for the existing
   * Boss/Captain-authorized locked-writer path with explicit write scopes.
   */
  private async dispatchBackgroundParticipants(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord,
    requested: EnsembleParticipant[],
    options: {
      prompt?: string
      sourceRunId?: string
      reason?: string
      /** User-directed dispatch (composer @mention / DM chip target): run
       * each lane under the seat's OWN normal-turn permissions instead of
       * the read-only clamp — boss_fanout_all semantics. Peer mentions and
       * yield routes never set this. TASKWRAITH_CONCURRENT_WRITE_LANES=0
       * restores the clamp, loudly. */
      honorSeatPosture?: boolean
    } = {}
  ): Promise<BackgroundDispatchResult> {
    if (!concurrentLanesEnabled()) {
      const result = { ok: false as const, reason: 'concurrent_lanes_disabled' as const }
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        'Background dispatch not launched because parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0).'
      )
      return result
    }
    const requestedBackgrounds = dedupeParticipants(requested).filter(isBackgroundParticipant)
    if (requestedBackgrounds.length === 0) {
      return { ok: false, reason: 'target_missing' }
    }
    const alreadyActive = requestedBackgrounds.filter(
      (participant) => this.participantFanoutDispatchState(runtime, participant.id) === 'active'
    )
    if (alreadyActive.length > 0) {
      const displayNames = alreadyActive.map(participantDisplayName).join(', ')
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        backgroundDispatchFailureStatusLine({ ok: false, reason: 'already_active' }, displayNames)
      )
    }
    const candidates = requestedBackgrounds.filter(
      (participant) => this.participantFanoutDispatchState(runtime, participant.id) !== 'active'
    )
    const blocked = candidates
      .map((participant) => ({
        participant,
        reason: this.bossmanBudgetBlock(runtime, participant.id, 'fanout_call')
      }))
      .filter((entry): entry is { participant: EnsembleParticipant; reason: string } =>
        Boolean(entry.reason)
      )
    if (blocked.length > 0) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Background dispatch skipped by budget: ${blocked
          .map((entry) => `${participantDisplayName(entry.participant)} (${entry.reason})`)
          .join(', ')}.`
      )
    }
    const blockedIds = new Set(blocked.map((entry) => entry.participant.id))
    const participants = candidates.filter((participant) => !blockedIds.has(participant.id))
    if (participants.length === 0 || runtime.cancelled) {
      if (runtime.cancelled) {
        return { ok: false, reason: 'cancelled' }
      }
      if (alreadyActive.length > 0) {
        return { ok: false, reason: 'already_active' }
      }
      if (blocked.length > 0) {
        return { ok: false, reason: 'budget_blocked', detail: blocked[0]!.reason }
      }
      return { ok: false, reason: 'target_missing' }
    }

    // Unmentioned BG seats are intentionally absent from activeRound. Add only
    // the explicitly delegated seats so chip/lane state can transition without
    // filling every ordinary round with synthetic skipped participants.
    this.updateChatRound(runtime.chatId, (round) => {
      if (!round || round.roundId !== runtime.roundId) return round
      const present = new Set(round.participants.map((entry) => entry.participantId))
      const added = participants
        .filter((participant) => !present.has(participant.id))
        .map((participant) => roundParticipantStateFromParticipant(participant, 'idle'))
      return added.length > 0
        ? { ...round, participants: [...round.participants, ...added] }
        : round
    })

    runtime.fanoutReservedParticipantIds ??= new Set()
    for (const participant of participants) {
      runtime.fanoutReservedParticipantIds.add(participant.id)
    }
    try {
      const latestChat = this.deps.getChat(runtime.chatId) || chat
      const acceptedRuns: ActiveParticipantRun[] = []
      const posture = resolveBackgroundDispatchPosture({
        honorSeatPosture: Boolean(options.honorSeatPosture),
        writeLanesEnabled: concurrentWriteLanesEnabled(),
        laneCount: participants.length
      })
      if (posture.statusLine) {
        this.appendRoundStatus(runtime.chatId, runtime.roundId, posture.statusLine)
      }
      await this.runParallelFanoutPass(runtime, latestChat, participants, {
        prompt: options.prompt,
        reason: options.reason,
        sourceRunId: options.sourceRunId,
        label: 'Background',
        ...(posture.mode === 'own_permissions'
          ? { dispatchOwnPermissions: true }
          : { mode: 'read_only' as const, forceReadOnlyDispatch: true }),
        acceptedRuns,
        waitForCompletion: false,
        completionDisposition: 'background'
      })
      const acceptedParticipantIds = new Set(
        acceptedRuns.map((acceptedRun) => acceptedRun.participant.id)
      )
      const acceptedParticipants = participants.filter((participant) =>
        acceptedParticipantIds.has(participant.id)
      )
      runtime.fannedOutParticipantIds ??= new Set()
      for (const participant of acceptedParticipants) {
        runtime.fannedOutParticipantIds.add(participant.id)
      }
      this.incrementBossmanBudgetUsage(
        runtime,
        acceptedParticipants.map((participant) => participant.id),
        { fanoutCalls: 1 }
      )
      const laneIds = acceptedRuns
        .map((acceptedRun) => acceptedRun.laneId)
        .filter((laneId): laneId is string => Boolean(laneId))
      if (laneIds.length === 0) {
        const result = { ok: false as const, reason: 'launch_failed' as const }
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          backgroundDispatchFailureStatusLine(result)
        )
        return result
      }
      return { ok: true, laneIds }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'background dispatch failed.'
      const result = { ok: false as const, reason: 'launch_failed' as const, detail: message }
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        backgroundDispatchFailureStatusLine(result)
      )
      return result
    } finally {
      for (const participant of participants) {
        runtime.fanoutReservedParticipantIds?.delete(participant.id)
      }
      if (runtime.fanoutReservedParticipantIds?.size === 0) {
        runtime.fanoutReservedParticipantIds = undefined
      }
      this.maybeResumeDeferredDrain(runtime.chatId)
    }
  }

  /**
   * 1.0.4-AK5 — Parallel fan-out executor.
   *
   * Dispatches N participants concurrently via Promise.all,
   * then, by default, awaits all their completion promises before
   * returning to `runRound`. MCP-triggered fan-out sets
   * `waitForCompletion: false` so the agent-facing tool gets a dispatch
   * receipt before provider MCP timeouts while the transcript continues
   * tracking lane completion in the background. The orchestrator emits a
   * transcript status row at the start ("Parallel pass · N scouts
   * dispatched.") so the user sees the fan-out as it happens.
   *
   * Critical invariants:
   *   - Read-only mode requires every participant to resolve as
   *     read-only. Locked-writer mode requires the writer-lane flag.
   *   - Each lane gets its own `runId` (UUID, collision-free).
   *   - Dispatch failures for individual lanes are NOT round-fatal
   *     — the existing typed-error path runs per-lane, marks that
   *     lane as `failed` or `unreachable`, but the other lanes
   *     continue. After `Promise.all` settles we return to the
   *     serial writer step as normal.
   *
   * MCP routing for parallel runs: every dispatch payload carries
   * an explicit `appRunId` (matching the run's id), so the existing
   * `runManager.resolve` path at `src/main/index.ts:7498-7528`
   * already handles concurrent runs correctly when callers pass
   * their `route.appRunId`. The unrouted-with-multiple-active-runs
   * guard at index.ts:13970-13988 will reject ambiguous calls,
   * which is the right behaviour — tool calls MUST carry their
   * runId binding to dispatch correctly.
   */
  private async runParallelFanoutPass(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord,
    participants: EnsembleParticipant[],
    options: {
      prompt?: string
      reason?: string
      mode?: EnsembleFanoutMode
      sourceRunId?: string
      label?: string
      /** Authority of an explicit per-lane prompt. User-authored prompts keep
       * user authority; all existing agent/orchestrator fan-out briefs retain
       * their lower-authority wrapper. */
      promptAuthority?: 'user' | 'orchestrator' | 'peer'
      /** Exact durable source row for a user-directed prompt. Never recover
       * this identity by comparing message content after an async barrier. */
      userPromptSourceMessageId?: string
      forceReadOnlyDispatch?: boolean
      /** ensemble_fanout_all: each lane runs under the participant's OWN
       * normal-turn posture (unattended clamps included via
       * resolveParticipantPermissions) — no read-only clamp, no
       * locked-writer scope requirement. Mutually exclusive with mode
       * validation below. */
      dispatchOwnPermissions?: boolean
      writeScopesByParticipantId?: Map<string, ConcurrentLaneWriteScope[]>
      /** Per-call choice, honored only while the chat Isolate policy is
       * 'any' — pinned 'off'/'worktree' policies clamp it. Omitted defers
       * to the chat policy ('any' defaults to the shared checkout). */
      isolation?: EnsembleFanoutIsolation
      onCompleteRuns?: (runs: ActiveParticipantRun[]) => void
      acceptedRuns?: ActiveParticipantRun[]
      waitForCompletion?: boolean
      completionDisposition?: 'serial' | 'caller' | 'background'
    } = {}
  ): Promise<string[]> {
    if (participants.length === 0) return []
    const sourceRun =
      options.sourceRunId && options.completionDisposition !== 'background'
        ? this.runsByRunId.get(options.sourceRunId)
        : undefined
    const sourceOwner = sourceRun && !sourceRun.laneId ? sourceRun : undefined
    const dispatchWasCancelled = (): boolean =>
      runtime.cancelled || sourceOwner?.fanoutDispatchCancelled === true
    const mode = options.mode || 'read_only'
    if (mode === 'locked_writers' && !concurrentWriteLanesEnabled()) {
      throw new Error('Locked writer fan-out requires TASKWRAITH_CONCURRENT_WRITE_LANES.')
    }
    if (!options.dispatchOwnPermissions) {
      for (const participant of participants) {
        const permissions = options.forceReadOnlyDispatch
          ? this.resolveFanoutDispatchPermissions(chat, runtime, participant, 'read_only')
          : this.resolveFanoutEligibilityPermissions(chat, runtime, participant, mode)
        if (mode === 'read_only' && !permissions.readOnly) {
          throw new Error(
            `runParallelFanoutPass: non-read-only participant ${participant.id} cannot run in read_only fan-out.`
          )
        }
        if (
          mode === 'locked_writers' &&
          !permissions.readOnly &&
          (options.writeScopesByParticipantId?.get(participant.id)?.length || 0) === 0
        ) {
          throw new Error(
            `runParallelFanoutPass: writer participant ${participant.id} has no approved write scope.`
          )
        }
      }
    }

    if (!runtime.activeScoutRunIds) runtime.activeScoutRunIds = new Set<string>()

    const readOnlyCount = participants.filter((participant) => {
      if (options.dispatchOwnPermissions) {
        return this.resolveFanoutOwnDispatchPermissions(chat, runtime, participant).readOnly
      }
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      return this.resolveFanoutDispatchPermissions(chat, runtime, participant, dispatchMode)
        .readOnly
    }).length
    const writeCount = participants.length - readOnlyCount
    // Worktree isolation applies to WRITE-intent lanes only: read lanes need
    // the live checkout (and cannot mutate it), while parallel writers are the
    // stomping hazard. The chat-level Isolate policy is USER AUTHORITY,
    // live-read at pass time (a mid-round toggle applies from the next pass):
    // 'off'/'worktree' are pinned regimes a per-call override cannot escape;
    // only 'any' delegates the choice to the caller, defaulting to the shared
    // checkout when omitted.
    const isolationPolicy = resolveEnsembleFanoutIsolationPolicy(
      (this.deps.getChat(runtime.chatId) || chat).ensemble?.fanoutIsolation
    )
    const fanoutIsolation: EnsembleFanoutIsolation =
      isolationPolicy === 'any' ? (options.isolation ?? 'off') : isolationPolicy
    // Global-scope chats have no workspace checkout to isolate; write lanes
    // there run as before. Missing allocator/workspace on a workspace-scoped
    // chat is NOT an exemption — those lanes fail closed per-lane below
    // instead of silently sharing the checkout.
    const isolateWriteLanes =
      fanoutIsolation === 'worktree' && writeCount > 0 && chat.scope !== 'global'
    const label =
      options.label || (mode === 'locked_writers' ? 'Locked writer fan-out' : 'Parallel fan-out')
    const ollamaLaneCount = participants.filter((p) => p.provider === 'ollama').length
    const ollamaRamNote =
      ollamaLaneCount >= 2
        ? ` ${ollamaLaneCount} Ollama lane(s) — local models share RAM; expect slower loads when multiple quants are resident.`
        : ''
    const isolationNote = isolateWriteLanes
      ? ' Write lanes run in isolated worktrees (forked from the last commit); results land as candidates to compare and promote.'
      : ''
    // Wave 3 — same seat-compaction barrier as the serial path, for every
    // fan-out lane (a Kimi/Grok lane can be mid-compaction too).
    await Promise.all(
      participants.map((participant) =>
        this.awaitSeatCompactionBeforeDispatch(runtime.chatId, participant)
      )
    )
    // Same cancellation re-check as the serial loop: the seat-compaction barrier
    // above can block for seconds, and a Stop/steer landing in that window sets
    // `runtime.cancelled` while `activeScoutRunIds` is still empty (lanes not yet
    // seeded), so `cancelRound` interrupts nothing. Without this guard the pass
    // would seed + dispatch zombie fan-out lanes that speak to completion after
    // the cancel. The post-`Promise.all(completionPromises)` check further down
    // fires only AFTER the lanes have already run — too late.
    if (dispatchWasCancelled()) return []
    const fanoutCategory = options.promptAuthority === 'user' ? 'user' : 'orchestrated'
    const fanoutWaveId = this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      writeCount > 0
        ? `${label} · ${participants.length} participant(s) dispatched concurrently (${readOnlyCount} read / ${writeCount} write-intent).${isolationNote}${ollamaRamNote}`
        : `${label} · ${participants.length} participant(s) dispatched concurrently (read-clamped lanes).${ollamaRamNote}`,
      { fanoutCategory, fanoutLabel: label }
    )

    // Seed each lane's run synchronously. UUIDs don't collide.
    // The seedParticipantRun helper takes care of building the
    // ChatRun + ActiveParticipantRun + registry entry + chat save.
    //
    // Re-fetch chat per seed so each save sees the LATEST chat —
    // important because `appendRoundStatus` above mutated
    // `chat.messages` via `deps.saveChat`, and `seedParticipantRun`
    // spreads its `chat` parameter to compose the next save. Using
    // the stale `chat` would clobber the status note we just
    // appended.
    const laneRuns: ActiveParticipantRun[] = participants.map((participant) => {
      const freshChat = this.deps.getChat(runtime.chatId) || chat
      const freshParticipant =
        freshChat.ensemble?.participants?.find((candidate) => candidate.id === participant.id) ||
        participant
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      const permissions = options.dispatchOwnPermissions
        ? this.resolveFanoutOwnDispatchPermissions(freshChat, runtime, freshParticipant)
        : this.resolveFanoutDispatchPermissions(freshChat, runtime, freshParticipant, dispatchMode)
      return this.seedParticipantRun(freshChat, runtime, freshParticipant, {
        laneId: this.nextLaneId(runtime, freshParticipant),
        laneIntent: permissions.readOnly ? 'read' : 'write',
        ...(fanoutWaveId ? { fanoutWaveId } : {}),
        fanoutLabel: label,
        fanoutCategory,
        approvedWriteScopes: permissions.readOnly
          ? undefined
          : options.writeScopesByParticipantId?.get(freshParticipant.id)
      })
    })
    for (const run of laneRuns) {
      runtime.activeScoutRunIds.add(run.runId)
    }
    // Ownership starts at seeding, not at provider acceptance. Skip/Stop can
    // land while dispatch is still in main-side preflight, before the provider
    // adapter knows this run id; recording provisional ids here lets those
    // controls terminally close the lane immediately, while the post-receipt
    // cancellation below catches any adapter that starts after that first
    // cancel attempt.
    if (sourceOwner) {
      sourceOwner.ownedFanoutRunIds ??= new Set()
      for (const run of laneRuns) sourceOwner.ownedFanoutRunIds.add(run.runId)
    }

    // Build the per-lane dispatch payload + completion promise pair. Keep
    // dispatch-start and completion promises separate: an async mapper that
    // returns `completion` would be promise-assimilated by JavaScript, causing
    // Promise.all(dispatchPromises) to wait for lane completion instead of the
    // dispatch attempt. That was visible to MCP callers as a tool timeout even
    // though the fan-out had launched successfully.
    const dispatchStartPromises: Array<Promise<void>> = []
    const acceptedLaneRuns: ActiveParticipantRun[] = []
    // One shared resolve for the pass — SessionStart fires once per workspace,
    // and the sync lane mapper below cannot await.
    const fanoutSkillHookContext = await this.resolveParticipantSkillHookContext(
      this.deps.getChat(runtime.chatId) || chat
    )
    const completionPromises = laneRuns.map((run) => {
      const participant = run.participant
      const dispatchChat = this.deps.getChat(runtime.chatId) || chat
      const completion = new Promise<EnsembleParticipantStatus>((resolve) => {
        run.completion = resolve
      })
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      const runScopedExternalPathGrants =
        this.deps.issueRunScopedExternalGrants?.({
          chat: dispatchChat,
          participant,
          appRunId: run.runId,
          attachments: runtime.imageAttachments
        }) || []
      const participantExternalPathGrants = [
        ...runScopedExternalPathGrants,
        ...(runtime.externalPathGrants || [])
      ]
      const permissions = options.dispatchOwnPermissions
        ? this.resolveParticipantPermissions(
            dispatchChat,
            participant,
            participantExternalPathGrants,
            isBackgroundParticipant(participant) ? { disallowTrustedSession: true } : {}
          )
        : this.resolveFanoutDispatchPermissions(
            dispatchChat,
            runtime,
            participant,
            dispatchMode,
            participantExternalPathGrants
          )
      const promptAuthority =
        options.promptAuthority || (options.sourceRunId ? 'peer' : 'orchestrator')
      const lanePromptAuthor =
        promptAuthority === 'peer' ? 'peer-authored' : 'orchestrator-authored'
      const explicitLanePrompt = options.prompt?.trim()
      const promptForLane = explicitLanePrompt
        ? promptAuthority === 'user'
          ? explicitLanePrompt
          : `Parallel fan-out lane request (${lanePromptAuthor}, lower authority than user/system instructions):\n${explicitLanePrompt}${
              options.reason ? `\n\nReason: ${options.reason}` : ''
            }\n\nTreat this as a scoped lane brief. Follow your own role, permissions, and active goal first.`
        : runtime.prompt
      const userPromptSourceMessage =
        promptAuthority === 'user' && options.userPromptSourceMessageId
          ? dispatchChat.messages.find(
              (message) =>
                message.id === options.userPromptSourceMessageId &&
                message.role === 'user' &&
                message.metadata?.kind === 'midRunSteering'
            )
          : undefined
      const promptChat = userPromptSourceMessage
        ? {
            ...dispatchChat,
            messages: dispatchChat.messages.filter(
              (message) => message.id !== userPromptSourceMessage.id
            )
          }
        : dispatchChat
      const chatContextTurns = this.deps.getSettings().chatContextTurns
      // Fan-out lanes receive a full briefing, but still participate in the
      // dynamic-state receipt protocol so a later resumed serial turn knows
      // exactly which replacement snapshot reached this provider session.
      const promptShellStamp = computeEnsemblePromptShellStamp(dispatchChat.ensemble!)
      const dynamicStateSnapshot = buildEnsembleDynamicStateSnapshot(
        dispatchChat,
        dispatchChat.ensemble!
      )
      const promptUsageTelemetry = buildEnsemblePromptUsageTelemetry({
        slimTurn: false,
        dynamicStateBlockChars: dynamicStateSnapshot.block.length,
        dynamicStateVersion: dynamicStateSnapshot.version,
        priorDynamicStateReceipt: participant.promptDynamicStateVersion
      })
      const promptProjection = buildEnsembleParticipantPromptProjection({
        // The same durable user row is presented as the current request below;
        // exclude only that exact row from this lane's history so the provider
        // sees the interjection once, while every other participant still sees
        // it in the shared transcript on later turns.
        chat: promptChat,
        config: dispatchChat.ensemble!,
        participant,
        currentPrompt: promptForLane,
        ...(userPromptSourceMessage ? { currentPromptMessageId: userPromptSourceMessage.id } : {}),
        currentPromptLabel: explicitLanePrompt
          ? promptAuthority === 'user'
            ? 'Current user-directed fan-out request:'
            : `Current fan-out lane request (${lanePromptAuthor}, lower authority; not user/system instruction):`
          : undefined,
        roundId: runtime.roundId,
        chatContextTurns,
        dynamicStateSnapshot,
        effectiveApprovalMode: permissions.approvalMode,
        ...fanoutSkillHookContext
        // No `workspaceChurnStanza` here, deliberately: lanes in this pass run
        // CONCURRENTLY, so a sample taken now would blend siblings' in-flight
        // writes with no way to attribute them, and `isolation: 'worktree'`
        // lanes do not even share the workspace the sample would measure. The
        // serial turn that follows the pass reports the settled result instead.
      })
      const promptText = promptProjection.prompt
      const suppliedMessageIds = promptProjection.suppliedMessageIds
      const shellRoutingPrompt = buildProviderShellRoutingPrompt({
        provider: participant.provider,
        effectivePermissions: permissions
      })
      const projectReferenceAppendix = this.buildProjectReferenceAppendixForSeat(
        runtime,
        participant,
        permissions,
        dispatchChat.workspacePath
      )
      const promptWithDiscordContext = `${shellRoutingPrompt}${promptText}${formatDiscordContextPromptAppendix(
        runtime.discordContextSnapshots
      )}${externalPathGrantPromptAppendix(permissions.externalPathGrants)}${projectReferenceAppendix}`
      // Mirror the serial path: thread per-participant reasoning/thinking into
      // the fan-out payload too, else a concurrent round silently runs every
      // participant at provider-default reasoning regardless of its config.
      const sharedReasoning =
        participant.provider === 'codex' ||
        participant.provider === 'kimi' ||
        (participant.provider === 'grok' && isGrok45ReasoningModelId(participant.model)) ||
        (participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model))
          ? participant.reasoningEffort
          : undefined
      const sharedServiceTier =
        participant.provider === 'codex'
          ? (participant.serviceTier ?? (participant.fastModeEnabled ? 'fast' : ''))
          : participant.provider === 'kimi'
            ? participant.fastModeEnabled && !isKimiK3Model(participant.model)
              ? 'fast'
              : 'standard'
            : participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model)
              ? participant.fastModeEnabled
                ? 'fast'
                : ''
              : undefined
      const claudeReasoning =
        participant.provider === 'claude' ? participant.reasoningEffort : undefined
      const claudeFastMode =
        participant.provider === 'claude' ? Boolean(participant.fastModeEnabled) : undefined
      const kimiThinking = participant.provider === 'kimi' ? true : undefined
      const ollamaRunControls = ensembleOllamaRunControls(participant)
      const payload: AgentRunPayload = {
        provider: participant.provider,
        scope: dispatchChat.scope === 'global' ? 'global' : 'workspace',
        ...(dispatchChat.scope === 'global' ? {} : { workspace: dispatchChat.workspacePath || '' }),
        prompt: promptWithDiscordContext,
        imagePaths: this.imagePathsForParticipantDispatch(runtime, participant),
        appRunId: run.runId,
        appChatId: dispatchChat.appChatId,
        model: participant.model || 'cli-default',
        approvalMode: permissions.approvalMode,
        workflowMode: dispatchChat.workflowMode === 'plan' ? 'plan' : 'normal',
        runtimeProfileId: participant.runtimeProfileId,
        geminiAuthProfileId:
          participant.provider === 'gemini' ? participant.geminiAuthProfileId || null : null,
        providerSessionId: participant.linkedProviderSessionId || null,
        externalPathGrants: permissions.externalPathGrants,
        effectivePermissions: permissions,
        ...(this.deps.signRunPermissionPosture
          ? {
              effectivePermissionsSignature: this.deps.signRunPermissionPosture(
                permissions.approvalMode,
                permissions,
                {
                  provider: participant.provider,
                  scope: dispatchChat.scope === 'global' ? 'global' : 'workspace',
                  appRunId: run.runId,
                  appChatId: dispatchChat.appChatId,
                  prompt: promptWithDiscordContext,
                  workflowMode: dispatchChat.workflowMode === 'plan' ? 'plan' : 'normal',
                  runtimeProfileId: participant.runtimeProfileId,
                  ensembleParticipantId: participant.id,
                  ensembleLaneId: run.laneId
                }
              )
            }
          : {}),
        ensembleRun: ensembleRunIdentity(
          runtime.roundId,
          participant,
          run.laneId,
          dispatchChat.ensemble,
          chatContextTurns,
          'full'
        ),
        ...(sharedReasoning !== undefined ? { reasoningEffort: sharedReasoning } : {}),
        ...(sharedServiceTier !== undefined ? { serviceTier: sharedServiceTier } : {}),
        ...(claudeReasoning !== undefined ? { claudeReasoningEffort: claudeReasoning } : {}),
        ...(claudeFastMode !== undefined ? { claudeFastMode } : {}),
        ...(kimiThinking !== undefined ? { kimiThinking } : {}),
        ...ollamaRunControls
      }
      dispatchStartPromises.push(
        (async () => {
          if (dispatchWasCancelled()) {
            if (this.runsByRunId.get(run.runId) === run) {
              this.finalizeRun(
                run,
                'cancelled',
                runtime.cancelled
                  ? 'Round cancelled before fan-out dispatch.'
                  : 'Owning participant was skipped before fan-out dispatch.'
              )
            }
            return
          }

          if (isolateWriteLanes && run.laneIntent === 'write' && run.laneId) {
            // Allocate this lane's isolated worktree before the provider sees
            // the payload. Fail CLOSED on allocation errors: silently falling
            // back to the shared checkout would defeat the isolation the user
            // (or Boss) explicitly asked for and reintroduce writer stomping.
            try {
              if (!this.deps.allocateFanoutLaneWorktree || !dispatchChat.workspacePath) {
                throw new Error(
                  'worktree isolation is required for this dispatch, but no workspace worktree allocator is available — refusing to run this write lane in the shared checkout.'
                )
              }
              const allocation = await this.deps.allocateFanoutLaneWorktree({
                chatId: runtime.chatId,
                roundId: runtime.roundId,
                laneId: run.laneId,
                runId: run.runId,
                participantId: participant.id,
                ...(participant.role ? { participantLabel: participant.role } : {}),
                provider: participant.provider,
                ...(participant.model ? { model: participant.model } : {}),
                baseWorkspacePath: dispatchChat.workspacePath || ''
              })
              payload.runtimeWorktree = {
                requested: true,
                source: 'ensembleLane',
                baseWorkspacePath: allocation.baseWorkspacePath,
                effectiveWorkspacePath: allocation.effectiveWorkspacePath,
                status: 'selected'
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              const note = `${participant.role || participant.provider} fan-out lane failed before dispatch: ${message}`
              this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
              if (this.runsByRunId.get(run.runId) === run) {
                this.finalizeRun(run, 'failed', note)
              }
              return
            }
            // Worktree allocation can take real time (git worktree add).
            // Re-check cancellation before handing the payload to a provider.
            if (dispatchWasCancelled()) {
              if (this.runsByRunId.get(run.runId) === run) {
                this.finalizeRun(
                  run,
                  'cancelled',
                  runtime.cancelled
                    ? 'Round cancelled before fan-out dispatch.'
                    : 'Owning participant was skipped before fan-out dispatch.'
                )
              }
              return
            }
          }

          run.transportDispatchState = 'pending'
          await new Promise<void>((resolveDispatchStart) => {
            let dispatchStartSettled = false
            let adapterInvoked = false
            const settleDispatchStart = (): void => {
              if (dispatchStartSettled) return
              dispatchStartSettled = true
              resolveDispatchStart()
            }
            const acceptAdapterInvocation = (): void => {
              if (adapterInvoked) return
              adapterInvoked = true
              try {
                run.transportDispatchState = 'accepted'
                if (!dispatchWasCancelled()) {
                  acceptedLaneRuns.push(run)
                  options.acceptedRuns?.push(run)
                  this.startCursorCompletionWatchdog(run)
                  // The lane becomes a candidate once main has passed every
                  // preflight and invoked its provider adapter. Provider setup and
                  // terminal outcome remain asynchronous transcript evidence.
                  run.promptShellStamp = promptShellStamp
                  run.promptDynamicStateVersion = dynamicStateSnapshot.version
                  run.ensemblePromptUsageTelemetry = promptUsageTelemetry
                }
              } finally {
                settleDispatchStart()
              }
            }
            const handleDispatchRejection = async (error: unknown): Promise<void> => {
              run.transportDispatchState = 'unknown'
              if (dispatchWasCancelled()) {
                // Dispatch may have crossed into the provider adapter before it
                // rejected. Repeat cancellation against the now-known run id.
                await this.requestExactRunCancellation(run).catch(() => false)
                if (this.runsByRunId.get(run.runId) === run) {
                  this.finalizeRun(
                    run,
                    'cancelled',
                    runtime.cancelled
                      ? 'Round cancelled during fan-out dispatch.'
                      : 'Owning participant was skipped during fan-out dispatch.'
                  )
                }
                return
              }
              // A thrown dispatch can occur after adapter entry. Exact cancellation
              // is safe even when preflight rejected before any transport existed.
              await this.requestExactRunCancellation(run).catch(() => false)
              if (this.runsByRunId.get(run.runId) === run) {
                const reason = classifyDispatchError(error)
                const note = formatDispatchFailureNote(participant, reason)
                this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
                this.finalizeRun(run, 'failed', note)
              }
            }
            const handleDispatchResult = async (
              dispatched: Awaited<ReturnType<EnsembleOrchestratorDeps['dispatch']>>
            ): Promise<void> => {
              if (dispatched.dispatched) {
                acceptAdapterInvocation()
              } else if (!adapterInvoked) {
                run.transportDispatchState = 'rejected'
              }
              if (dispatchWasCancelled()) {
                if (dispatched.dispatched || adapterInvoked) {
                  // A Stop/Skip may have called cancel before the dispatch facade
                  // registered the provider run. Repeat against the accepted id.
                  await this.requestExactRunCancellation(run).catch(() => false)
                }
                if (this.runsByRunId.get(run.runId) === run) {
                  this.finalizeRun(
                    run,
                    'cancelled',
                    runtime.cancelled
                      ? 'Round cancelled during fan-out dispatch.'
                      : 'Owning participant was skipped during fan-out dispatch.'
                  )
                }
                return
              }

              if (!dispatched.dispatched) {
                if (this.runsByRunId.get(run.runId) === run) {
                  const note = dispatched.failureMessage
                    ? formatDispatchFailureNote(
                        participant,
                        classifyDispatchError(new Error(dispatched.failureMessage))
                      )
                    : formatDispatchFailureNote(participant, { kind: 'unknown', message: '' })
                  this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
                  this.finalizeRun(run, 'failed', note)
                }
                return
              }
            }

            let dispatchOperation: ReturnType<EnsembleOrchestratorDeps['dispatch']>
            try {
              dispatchOperation = this.deps.dispatch(
                payload,
                { sender: runtime.sender },
                { onAdapterInvoked: acceptAdapterInvocation },
                { suppliedMessageIds }
              )
            } catch (error) {
              void handleDispatchRejection(error).finally(settleDispatchStart)
              return
            }
            void dispatchOperation
              .then(handleDispatchResult, handleDispatchRejection)
              .finally(settleDispatchStart)
          })
        })()
      )
      return completion
    })

    const laneIds = laneRuns
      .map((run) => run.laneId)
      .filter((laneId): laneId is string => Boolean(laneId))

    // Wait for dispatch attempts, not lane completion, so agent-facing MCP
    // callers get a real dispatch receipt while serial orchestrator fan-out can
    // still wait for lane completion below.
    await Promise.all(dispatchStartPromises)
    if (sourceOwner?.ownedFanoutRunIds) {
      const acceptedRunIds = new Set(acceptedLaneRuns.map((run) => run.runId))
      for (const run of laneRuns) {
        if (!acceptedRunIds.has(run.runId)) sourceOwner.ownedFanoutRunIds.delete(run.runId)
      }
      if (sourceOwner.ownedFanoutRunIds.size === 0) {
        sourceOwner.ownedFanoutRunIds = undefined
      }
    }
    if (runtime.cancelled) {
      if (options.waitForCompletion === false) return laneIds
      return []
    }
    const finishFanoutPass = async (): Promise<void> => {
      try {
        await Promise.all(completionPromises)
        if (runtime.cancelled) return
        // Consume overflow evidence against the exact failed seat snapshot
        // before queued roster changes can relink that participant id.
        for (const run of laneRuns) {
          if (run.status === 'failed' && run.classifiedContextOverflow) {
            this.maybeAutoCompactSeatAfterTurn(runtime.chatId, run.participant.id)
          }
        }
        for (const run of laneRuns) {
          this.applyPendingParticipantSeatChangeFor(runtime, run.participant.id)
        }
        options.onCompleteRuns?.(laneRuns)

        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          (() => {
            const skippedCount = laneRuns.filter((run) => run.status === 'cancelled').length
            if (skippedCount === laneRuns.length) {
              return `${label} skipped · ${skippedCount} lane(s) stopped.`
            }
            if (skippedCount > 0) {
              return `${label} complete · ${laneRuns.length - skippedCount} lane(s) returned, ${skippedCount} skipped.`
            }
            if (options.completionDisposition === 'background') {
              return `${label} complete · ${laneRuns.length} lane(s) returned.`
            }
            if (options.completionDisposition === 'caller' || options.sourceRunId) {
              return `${label} complete · ${laneRuns.length} lane(s) returned to the caller.`
            }
            if (label === 'Review wave' && runtime.orchestrationMode === 'continuous') {
              return `${label} complete · continuing Continuous while hops remain.`
            }
            return `${label} complete · returning to serial writer step.`
          })()
        )
      } finally {
        for (const run of laneRuns) {
          runtime.activeScoutRunIds?.delete(run.runId)
        }
        if (runtime.activeScoutRunIds?.size === 0) {
          runtime.activeScoutRunIds = undefined
        }
      }
    }

    if (options.waitForCompletion === false) {
      const settlement = finishFanoutPass()
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : 'fan-out completion tracking failed.'
          try {
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              `${label} tracking failed: ${message}`
            )
          } catch {
            // Ownership cleanup below must still run if status persistence fails.
          }
        })
        .finally(() => {
          // A detached BG lane can be the last live work in a deferred round.
          // Resume only after its completion/tracking status has been appended;
          // otherwise finishRound (and a queued next round) can overtake that
          // old-round status in the transcript.
          this.maybeResumeDeferredDrain(runtime.chatId)
        })
      if (sourceOwner && acceptedLaneRuns.length > 0) {
        const ownedRunIds = acceptedLaneRuns.map((run) => run.runId)
        sourceOwner.ownedFanoutSettlements ??= new Set()
        sourceOwner.ownedFanoutSettlements.add(settlement)
        sourceOwner.ownedFanoutRunIds ??= new Set()
        for (const runId of ownedRunIds) sourceOwner.ownedFanoutRunIds.add(runId)
        void settlement
          .finally(() => {
            sourceOwner.ownedFanoutSettlements?.delete(settlement)
            for (const runId of ownedRunIds) sourceOwner.ownedFanoutRunIds?.delete(runId)
            if (sourceOwner.ownedFanoutRunIds?.size === 0) {
              sourceOwner.ownedFanoutRunIds = undefined
            }
            if (sourceOwner.ownedFanoutSettlements?.size === 0) {
              sourceOwner.ownedFanoutSettlements = undefined
            }
            this.releaseOwnedFanoutHold(sourceOwner)
            // The round drain must run after the held owner transcript has been
            // released. `finishFanoutPass` marks the lane terminal before this
            // cleanup callback, so resuming from its inner finally can otherwise
            // finish the round and make the owner's continuation look late.
            this.maybeResumeDeferredDrain(sourceOwner.chatId)
          })
          .catch(() => undefined)
      }
      return laneIds
    }

    await finishFanoutPass()
    if (runtime.cancelled) return []
    return laneIds
  }

  private seedParticipantRun(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    options: {
      sleepResumeWarning?: string
      laneId?: string
      laneIntent?: ConcurrentLane['intent']
      fanoutWaveId?: string
      fanoutLabel?: string
      fanoutCategory?: 'user' | 'orchestrated'
      approvedWriteScopes?: ConcurrentLaneWriteScope[]
    } = {}
  ): ActiveParticipantRun {
    const startedAt = this.deps.nowIso()
    const runId = this.deps.createRunId(participant.provider)
    // Serial seats still have one deterministic message identity per round.
    // A fan-out/BG seat may be delegated more than once in that same round,
    // so lane records need the run id suffix to avoid colliding in ChatRun
    // bookkeeping even though timeline rows are already run-id keyed.
    const laneRunSuffix = options.laneId ? `-${runId}` : ''
    const promptMessageId = `ensemble-prompt-${runtime.roundId}-${participant.id}${laneRunSuffix}`
    const assistantMessageId = `ensemble-assistant-${runtime.roundId}-${participant.id}${laneRunSuffix}`
    const authorityRoutingCheckpoint = this.takeAuthorityRoutingCheckpoint(
      chat,
      runtime,
      participant,
      Boolean(options.laneId)
    )
    const run: ChatRun = {
      runId,
      provider: participant.provider,
      startedAt,
      promptMessageId,
      requestedModel: participant.model || 'cli-default',
      approvalMode: participant.permissionPresetId || 'default',
      status: 'running',
      ensembleRoundId: runtime.roundId,
      ensembleParticipantId: participant.id,
      ...(options.laneId ? { ensembleLaneId: options.laneId } : {}),
      ...(options.laneId ? { ensembleLaneIntent: options.laneIntent || 'read' } : {}),
      ensembleRole: participant.role,
      ...(participant.stageRole ? { ensembleStageRole: participant.stageRole } : {}),
      ensembleOrder: participant.order,
      ensembleSeatSnapshot: ensembleSeatSnapshot(participant),
      ...pooledAgentTranscriptMetadata(participant),
      runtimeProfileId: participant.runtimeProfileId,
      ...(participant.provider === 'gemini' && participant.geminiAuthProfileId
        ? { geminiAuthProfileId: participant.geminiAuthProfileId }
        : {}),
      ...(participant.linkedProviderSessionId
        ? { providerThreadId: participant.linkedProviderSessionId }
        : {}),
      // 1.0.5-N6 — Surface the "resumed from transcript context"
      // signal on the run itself so the RunCard can render a small
      // warning chip beside the status. The transcript status row
      // is easy to scroll past; this chip rides with the run.
      ...(options.sleepResumeWarning
        ? { ensembleSleepResumeWarning: options.sleepResumeWarning }
        : {})
    }
    const activeRun: ActiveParticipantRun = {
      chatId: chat.appChatId,
      roundId: runtime.roundId,
      runId,
      ...(options.laneId ? { laneId: options.laneId } : {}),
      ...(options.laneId ? { laneIntent: options.laneIntent || 'read' } : {}),
      ...(options.fanoutWaveId ? { fanoutWaveId: options.fanoutWaveId } : {}),
      ...(options.fanoutLabel ? { fanoutLabel: options.fanoutLabel } : {}),
      ...(options.fanoutCategory ? { fanoutCategory: options.fanoutCategory } : {}),
      ...(options.approvedWriteScopes?.length
        ? { approvedWriteScopes: options.approvedWriteScopes }
        : {}),
      ...(authorityRoutingCheckpoint ? { authorityRoutingCheckpoint } : {}),
      participant,
      promptMessageId,
      assistantMessageId,
      startedAt,
      content: '',
      status: 'running'
    }
    this.runsByRunId.set(runId, activeRun)
    const updatedRuns = [...chat.runs, run]
    this.saveChatWithCheckpoint(
      {
        ...chat,
        runs: updatedRuns,
        ensemble: {
          ...chat.ensemble!,
          activeRound: addLaneToRound(
            updateRoundParticipant(
              chat.ensemble!.activeRound,
              participant.id,
              {
                status: 'running',
                runId,
                startedAt
              },
              { setActive: !options.laneId }
            ),
            options.laneId
              ? transitionLane(
                  createLane({
                    laneId: options.laneId,
                    participantId: participant.id,
                    provider: participant.provider,
                    intent: options.laneIntent || 'read',
                    approvedWriteScopes: options.approvedWriteScopes,
                    runId,
                    providerSessionId: participant.linkedProviderSessionId || null,
                    nowIso: startedAt
                  }),
                  { status: 'running', nowIso: startedAt }
                )
              : undefined
          ),
          updatedAt: startedAt
        },
        updatedAt: this.deps.now()
      },
      'participant-updated'
    )
    return activeRun
  }

  private activeRoundParticipantStatus(
    runtime: ActiveRoundRuntime,
    participantId: string
  ): EnsembleParticipantStatus | undefined {
    const round = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
    if (!round || round.roundId !== runtime.roundId) return undefined
    return round.participants.find((participant) => participant.participantId === participantId)
      ?.status
  }

  private activeFanoutRunForParticipant(
    runtime: ActiveRoundRuntime,
    participantId: string
  ): ActiveParticipantRun | undefined {
    for (const runId of runtime.activeScoutRunIds || []) {
      const run = this.runsByRunId.get(runId)
      if (run?.participant.id === participantId) return run
    }
    return undefined
  }

  private participantFanoutDispatchState(
    runtime: ActiveRoundRuntime,
    participantId: string
  ): 'handled' | 'active' | null {
    // The 'active' layers are checked before the completed-fanout marker so a
    // participant whose earlier lane already settled ('handled') but who has
    // been re-reserved by a NEW ensemble_fanout call reads as 'active' —
    // `resolveFanoutTargets` and the review wave key off that distinction.
    if (runtime.fanoutReservedParticipantIds?.has(participantId)) return 'active'
    if (this.activeFanoutRunForParticipant(runtime, participantId)) return 'active'
    const round = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
    if (round && round.roundId === runtime.roundId) {
      const activeLane = Object.values(round.lanes || {}).find(
        (lane) => lane.participantId === participantId && !isTerminalLaneStatus(lane.status)
      )
      if (activeLane) return 'active'
    }
    return runtime.fannedOutParticipantIds?.has(participantId) ? 'handled' : null
  }

  private tryRouteYieldReturn(
    runtime: ActiveRoundRuntime,
    remaining: EnsembleParticipant[],
    chat: ChatRecord,
    completedParticipant: EnsembleParticipant,
    completedStatus: EnsembleParticipantStatus
  ): boolean {
    const stack = runtime.yieldReturnStack
    const frame = stack?.[stack.length - 1]
    if (!stack?.length || frame?.targetParticipantId !== completedParticipant.id) return false
    stack.pop()
    if (completedStatus !== 'answered') return false
    const returnParticipant = chat.ensemble?.participants.find(
      (participant) => participant.id === frame.returnParticipantId && participant.enabled
    )
    if (!returnParticipant) return false
    return this.tryAppendContinuationTurn(
      runtime,
      remaining,
      returnParticipant,
      `Yield-return: returning to ${returnParticipant.role || returnParticipant.provider} (${returnParticipant.provider}).`,
      { allowYieldedParticipant: true }
    ).appended
  }

  private evaluateContinuationTurnEligibility(
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    options: { allowYieldedParticipant?: boolean; allowAnsweredParticipant?: boolean } = {}
  ): ContinuationTurnResult {
    if (runtime.orchestrationMode !== 'continuous')
      return { appended: false, reason: 'not_continuous' }
    if (runtime.dmTargetParticipantId && participant.id !== runtime.dmTargetParticipantId) {
      return { appended: false, reason: 'outside_round_scope' }
    }
    if (runtime.unreachableParticipantIds?.has(participant.id)) {
      return { appended: false, reason: 'unreachable' }
    }
    if (this.participantFanoutDispatchState(runtime, participant.id) === 'active') {
      return { appended: false, reason: 'active_fanout' }
    }
    const participantStatus = this.activeRoundParticipantStatus(runtime, participant.id)
    if (
      participantStatus &&
      CONTINUATION_BLOCKED_PARTICIPANT_STATUSES.has(participantStatus) &&
      !(options.allowYieldedParticipant && participantStatus === 'yielded') &&
      !(options.allowAnsweredParticipant && participantStatus === 'answered')
    ) {
      return { appended: false, reason: 'blocked_status', blockedStatus: participantStatus }
    }
    if (runtime.continuationHops >= runtime.maxContinuationHops) {
      return { appended: false, reason: 'hop_limit' }
    }
    const budgetBlock = this.bossmanBudgetBlock(runtime, participant.id, 'extra_turn')
    if (budgetBlock) {
      return { appended: false, reason: 'budget_exhausted', budgetMessage: budgetBlock }
    }
    return { appended: true }
  }

  private commitContinuationTurn(
    runtime: ActiveRoundRuntime,
    remaining: EnsembleParticipant[],
    participant: EnsembleParticipant,
    statusMessage: string
  ): void {
    runtime.continuationHops += 1
    remaining.unshift(participant)
    this.incrementBossmanBudgetUsage(runtime, [participant.id], { extraTurns: 1 })
    this.updateChatRound(runtime.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? {
            ...round,
            continuationHops: runtime.continuationHops,
            maxContinuationHops: runtime.maxContinuationHops
          }
        : round
    )
    const label = runtime.orchestrationMode === 'continuous' ? 'Continuous handoff' : 'Extra turn'
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${statusMessage} ${label} ${runtime.continuationHops}/${runtime.maxContinuationHops}.`
    )
  }

  private tryAppendContinuationTurn(
    runtime: ActiveRoundRuntime,
    remaining: EnsembleParticipant[],
    participant: EnsembleParticipant,
    statusMessage: string,
    // `allowYieldedParticipant` re-summons a participant who explicitly yielded
    // (yield-return). `allowAnsweredParticipant` re-summons one who already
    // answered normally. Both are used by explicit foreground handoffs and
    // authority continuations; generic @-mentions remain more conservative.
    // Neither bypasses 'skipped'/'failed'/'cancelled'/'unreachable' (those mean
    // the participant errored out or was removed — re-summoning is a different,
    // riskier concern).
    options: { allowYieldedParticipant?: boolean; allowAnsweredParticipant?: boolean } = {}
  ): ContinuationTurnResult {
    const eligibility = this.evaluateContinuationTurnEligibility(runtime, participant, options)
    if (!eligibility.appended) {
      if (eligibility.reason === 'budget_exhausted' && eligibility.budgetMessage) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${participantDisplayName(participant)} was not given an extra turn: ${eligibility.budgetMessage}.`
        )
      }
      return eligibility
    }
    this.commitContinuationTurn(runtime, remaining, participant, statusMessage)
    return { appended: true }
  }

  /**
   * Human-readable reason a priority @-mention re-summon was declined, so the
   * "could not re-summon the Boss/Captain" note is honest about WHY (the whole
   * point of the note) instead of always blaming the hop budget.
   */
  private describeContinuationDecline(result: ContinuationTurnResult): string {
    if (result.appended) return ''
    switch (result.reason) {
      case 'outside_round_scope':
        return 'it is outside this user-targeted round'
      case 'hop_limit':
        return 'continuation-hop budget exhausted'
      case 'unreachable':
        return 'it is unreachable this round'
      case 'active_fanout':
        return 'it is already reserved for or handled by a fan-out lane'
      case 'budget_exhausted':
        return result.budgetMessage || 'its allocated extra-turn budget is exhausted'
      case 'blocked_status':
        switch (result.blockedStatus) {
          case 'failed':
            return 'its last run failed'
          case 'skipped':
            return 'its last run was skipped'
          case 'cancelled':
            return 'its last run was cancelled'
          case 'yielded':
            return 'it yielded control this round'
          default:
            return 'it already completed its turn'
        }
      default:
        return 'the round is no longer continuous'
    }
  }

  private notifyContinuationLimitReached(runtime: ActiveRoundRuntime): void {
    if (runtime.continuationLimitNotified) return
    runtime.continuationLimitNotified = true
    const label = runtime.orchestrationMode === 'continuous' ? 'Continuous handoff' : 'Extra turn'
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `${label} limit reached (${runtime.continuationHops}/${runtime.maxContinuationHops}); returning control to the user.`
    )
  }

  /**
   * C4 — administrative-idle-consensus detector. A terminal condition DISTINCT from
   * hop-cap / cancel / no-progress: the just-finished pass DID produce
   * `anyProducedContent` (so the no-progress guard passed), yet every seat merely
   * yielded — a whole-panel consensus that nothing is left to do — while the one
   * seat that could END the round is unreachable. The lived symptom (goal item
   * "Continuous mode lacked an administrative-deadlock stop"): the Boss yields
   * control, so it will not self-complete the goal, but it stays classified
   * AVAILABLE, so the Captain remains on standby and cannot complete either — and
   * the loop burns another identical pass that cannot break the deadlock.
   *
   * Returns true (→ escalate + stop) only when ALL hold:
   *  1. No PRODUCTIVE turn this pass — nobody reached `'answered'`/`'sleeping'`.
   *     Reaching here means `anyProducedContent` was true, so ≥1 seat `'yielded'`;
   *     requiring zero answered/sleeping makes this an idle CONSENSUS, not one
   *     seat's handoff amid real work — so a single ordinary Boss yield never trips
   *     it (A2/A4 refinement).
   *  2. No concrete pending work — no assignment is `'open'`/`'in_progress'`. Status
   *     alone is not enough (A2/A4): a still-actionable assignment means the round
   *     must keep rotating so its owner can act.
   *  3. Completion authority is unreachable — the Boss `'yielded'` (won't
   *     self-complete) AND is still classified available, so the Captain stays
   *     standby and also cannot complete. Reuses the shared authority resolver
   *     (`primaryBossUnavailable`, c88cd98ef) rather than re-deriving a second
   *     authority path; a Boss that is genuinely UNavailable is NOT a deadlock (the
   *     Captain can then take authority, so the round should continue and promote).
   *
   * A queued user prompt (an active user steer) is never a deadlock — the caller
   * drains the queue first, but the predicate also short-circuits on it so it stays
   * self-contained and honest when called directly.
   */
  private detectAdministrativeIdleConsensus(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord,
    roundParticipants: EnsembleRoundParticipantState[]
  ): boolean {
    if (runtime.queuedPrompts.length > 0) return false
    const hadProductiveTurn = roundParticipants.some(
      (participant) => participant.status === 'answered' || participant.status === 'sleeping'
    )
    if (hadProductiveTurn) return false
    const assignments = chat.ensemble?.bossmanControlState?.assignments || []
    const hasActionableAssignment = assignments.some(
      (assignment) => assignment.status === 'open' || assignment.status === 'in_progress'
    )
    if (hasActionableAssignment) return false
    const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
    if (!bossmanParticipantId) return false
    const bossState = roundParticipants.find(
      (participant) => participant.participantId === bossmanParticipantId
    )
    if (bossState?.status !== 'yielded') return false
    // Boss yielded but still classified available ⇒ Captain standby ⇒ nobody can
    // complete. If the Boss is already UNavailable, the Captain can take authority,
    // so that is reachable completion, not a deadlock — let the round continue.
    if (this.primaryBossUnavailable(chat, runtime, bossmanParticipantId).unavailable) return false
    return true
  }

  private notifyAdministrativeIdleDeadlock(runtime: ActiveRoundRuntime): void {
    if (runtime.administrativeIdleEscalated) return
    runtime.administrativeIdleEscalated = true
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      'Continuous mode: administrative deadlock — every active seat yielded with no pending assignment, and completion authority is unreachable (the Boss yielded control yet stays available, so the Captain remains on standby). Returning control so the Captain or user can complete or block the goal instead of burning another pass.'
    )
  }

  /**
   * Efficiency audit 2026-07 — terminal-goal pre-emption of the serial queue.
   *
   * Once the active goal leaves 'active' DURING a round, every still-undispatched
   * ordinary serial seat would burn a full provider turn just to confirm the
   * closure (the observed transcript pattern: Boss calls goal_complete, then
   * Captain/scouts/workers/reviewers each wake to report "nothing open"). Sweep
   * those seats out of the queue as 'skipped' instead. Applies to Continuous and
   * Turn-bound; skipped seats are persisted on the durable round projection via
   * updateParticipantState / saveChat (not runtime-only UI).
   *
   * Deliberately narrow:
   *  - explicitly-routed seats (yield / yield-return / @-mention promotions in
   *    `exemptIds`) keep their turn — agent-directed routing outranks the sweep;
   *  - seats with a live/reserved/settled fan-out lane are left to the existing
   *    lane bookkeeping (the serial loop already drops them silently);
   *  - era-guarded via the round-start goal snapshot so a stale terminal goal
   *    carried in from a prior round never pre-empts a fresh round;
   *  - queued user prompts are unaffected (they chain via finalizeDrainedRound).
   */
  private preemptRemainingForTerminalGoal(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord,
    remaining: EnsembleParticipant[],
    exemptIds: ReadonlySet<string>
  ): void {
    if (remaining.length === 0) return
    const goal = chat.activeGoal
    if (!goal || goal.status === 'active') return
    if (runtime.roundStartGoalWasTerminal && goal.id === runtime.roundStartGoalId) return
    const survivors: EnsembleParticipant[] = []
    const preempted: EnsembleParticipant[] = []
    for (const participant of remaining) {
      if (
        exemptIds.has(participant.id) ||
        this.participantFanoutDispatchState(runtime, participant.id)
      ) {
        survivors.push(participant)
      } else {
        preempted.push(participant)
      }
    }
    if (preempted.length === 0) return
    remaining.splice(0, remaining.length, ...survivors)
    for (const participant of preempted) {
      this.updateParticipantState(
        runtime.chatId,
        runtime.roundId,
        participant.id,
        'skipped',
        `Goal ${goal.status} — remaining turn pre-empted.`
      )
    }
    if (!runtime.goalTerminalPreemptionNoted) {
      runtime.goalTerminalPreemptionNoted = true
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Goal ${goal.status} — pre-empted ${preempted.length} remaining serial turn(s): ${preempted
          .map((participant) => participantDisplayName(participant))
          .join(
            ', '
          )}. Live fan-out/background lanes settle per policy; queued user messages still run.`
      )
    }
  }

  /**
   * Continuous-mode AUTONOMOUS continuation. When the serial loop drains with no
   * explicit yield/@-mention handoff, a `'continuous'` round must not silently
   * end at the round boundary (`finishRound`) — it keeps re-dispatching the
   * roster for another pass until a stop condition fires (assignment-aware once
   * assign_work is in play — see `narrowContinuationRosterToOpenWork`). Returns
   * the roster to run next (each participant costs one continuation hop), or
   * `null` to stop.
   *
   * Stop conditions:
   *  - not continuous mode / user cancelled;
   *  - the active goal is marked complete (`chat.activeGoal.status === 'completed'`)
   *    — agents end the loop by completing the goal/tasks (see the Continuous-mode
   *    system prompt);
   *  - the hop budget is exhausted (`continuationHops >= maxContinuationHops`);
   *  - NO-PROGRESS: the just-finished pass produced no real output — no
   *    participant reached `'answered'`/`'yielded'` (everyone `'skipped'`/`'failed'`/
   *    `'unreachable'`). Another identical pass would just repeat the silence, so
   *    stop instead of spinning hops on nothing.
   *  - ADMINISTRATIVE DEADLOCK (C4): the pass produced content, but every seat
   *    merely `'yielded'` with no pending assignment and completion authority is
   *    unreachable (Boss yielded yet still available → Captain standby). Escalate to
   *    Captain/user instead of burning another identical pass — see
   *    `detectAdministrativeIdleConsensus`.
   *
   * A permission-elevation stall needs no check here (it blocks `await completion`
   * upstream, so this drain point is unreachable while a run is paused for
   * approval); queued-prompt + pending-wakeup priority are
   * enforced by the caller before this is invoked.
   *
   * Unlike `tryAppendContinuationTurn`, this does NOT apply
   * `CONTINUATION_BLOCKED_PARTICIPANT_STATUSES` — that guard exists to stop
   * re-promoting an already-spoken participant WITHIN a pass; a fresh pass
   * legitimately re-dispatches the whole roster.
   */
  private tryAutoContinueRound(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord
  ): EnsembleParticipant[] | null {
    if (runtime.orchestrationMode !== 'continuous') return null
    if (runtime.cancelled) return null
    if (runtime.returnedControlToUser) return null
    // A composer @mention opens a one-seat interaction, not a seed for an
    // autonomous panel pass. Once that participant answers/yields, control
    // returns to the user; agent mentions cannot widen the user's scope.
    if (runtime.dmTargetParticipantId) return null
    // Stop once the goal leaves 'active' — completed (done), blocked, or paused.
    // Agents are prompted to call goal_complete when done and goal_blocked when
    // genuinely stuck; both hand control back to the user, so don't keep spinning
    // the roster to the hop cap after either signal. A missing goal is fine (the
    // round auto-continues until hops/no-progress, per the user's spec).
    if (chat.activeGoal && chat.activeGoal.status !== 'active') return null
    const roundParticipants = chat.ensemble?.activeRound?.participants || []
    const anyProducedContent = roundParticipants.some(
      (participant) =>
        participant.status === 'answered' ||
        participant.status === 'yielded' ||
        // 'sleeping' = a scheduled-wakeup continuation is in flight (real
        // progress, matching statusToRunQueueJobStatus's convention); don't
        // treat it as a no-op pass. In the common path a pending wakeup is
        // intercepted before this drain hook, but keep the predicate honest.
        participant.status === 'sleeping'
    )
    if (!anyProducedContent) {
      // Closing Review wave may settle with only skipped/empty lane output.
      // That is soft no-progress for a normal drain, but Continuous still has
      // hop budget and must return to authority / another pass rather than
      // Task-Complete on the "Review wave complete" boundary.
      if (runtime.suppressNoProgressAfterReviewWave) {
        runtime.suppressNoProgressAfterReviewWave = false
      } else {
        return null
      }
    } else {
      runtime.suppressNoProgressAfterReviewWave = false
    }
    // C4 — administrative-idle-consensus terminal condition. `anyProducedContent`
    // is true here (a `'yielded'` seat counts as content), but a whole-panel idle
    // consensus with no pending work and unreachable completion authority is a
    // DEADLOCK another identical pass cannot resolve. Escalate to Captain/user and
    // stop instead of burning a hop. Fire-once per idle streak.
    if (this.detectAdministrativeIdleConsensus(runtime, chat, roundParticipants)) {
      this.notifyAdministrativeIdleDeadlock(runtime)
      return null
    }
    // A productive pass (or one with real pending work) breaks any prior idle
    // streak, so re-arm the one-shot deadlock escalation for a future streak.
    runtime.administrativeIdleEscalated = false
    if (runtime.continuationHops >= runtime.maxContinuationHops) {
      // The serial queue is exhausted, but detached BG lanes or a reservation
      // window may still own live work. Record the terminal reason now and let
      // finalizeDrainedRound publish it only after the true drain tail, unless
      // cancel/steer/user-yield/goal closure supersedes it.
      runtime.continuationLimitPending = true
      return null
    }
    if (!chat.ensemble) return null
    const fullRoster = getOrderedEnsembleParticipants(chat.ensemble, runtime.prompt).filter(
      (participant) =>
        participant.enabled &&
        !isBackgroundParticipant(participant) &&
        !runtime.unreachableParticipantIds?.has(participant.id) &&
        !this.activeBossmanQuarantine(chat, runtime.roundId, participant.id) &&
        !this.bossmanBudgetBlock(runtime, participant.id, 'extra_turn')
    )
    if (fullRoster.length === 0) return null
    const roster = this.narrowContinuationRosterToOpenWork(chat, fullRoster, runtime)
    const fresh: EnsembleParticipant[] = []
    for (const participant of roster) {
      if (runtime.continuationHops >= runtime.maxContinuationHops) {
        // A non-divisible hop budget can leave room for a partial final pass.
        // Do not publish the terminal limit status while constructing that
        // pass: its participants have not run yet, so claiming control is
        // already returning to the user would be false. The next drain enters
        // the exhausted-budget guard above and publishes the fire-once status
        // after every admitted participant has completed.
        break
      }
      runtime.continuationHops += 1
      fresh.push(participant)
    }
    if (fresh.length === 0) return null
    runtime.continuationPass += 1
    // A fresh Continuous pass may re-dispatch seats that already spoke via
    // fan-out in the prior pass. Clear the completed-fanout marker so serial
    // skip does not treat those seats as permanently 'handled' for the rest
    // of the round (which would empty the queue and Task-Complete early).
    runtime.fannedOutParticipantIds = undefined
    this.incrementBossmanBudgetUsage(
      runtime,
      fresh.map((participant) => participant.id),
      { extraTurns: 1 }
    )
    this.updateChatRound(runtime.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? {
            ...round,
            continuationHops: runtime.continuationHops,
            maxContinuationHops: runtime.maxContinuationHops,
            continuationPass: runtime.continuationPass
          }
        : round
    )
    const narrowingNote =
      roster.length < fullRoster.length
        ? ` Focused continuation pass: ${fresh.length} of ${fullRoster.length} seats have open work, directed routing, or authority.`
        : ''
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `Continuous mode: no explicit handoff — auto-continuing for pass ${runtime.continuationPass} (${runtime.continuationHops}/${runtime.maxContinuationHops} hops).${narrowingNote} Mark the goal complete to stop.`
    )
    return fresh
  }

  /**
   * Efficiency audit 2026-07 — assignment-aware + authority-directed
   * continuation rosters.
   *
   * Structured Boss assignments used to affect ordering only: the next
   * continuous pass still re-dispatched EVERY enabled foreground seat, so
   * completed workers reported "standby", idle scouts re-probed an unchanged
   * tree, and reviewers woke with nothing to review. Once assign_work is in
   * play for this chat, a continuation pass admits only seats with a live
   * reason to speak:
   *
   *  - owners of 'open' / 'in_progress' assignments;
   *  - reviewers of 'required' gates that block the ACTIVE goal (the same
   *    ReviewGateScope predicate the goal_complete gate check uses);
   *  - targets of open TARGETED status requests (untargeted requests never
   *    auto-close — see reconcileBossmanControlAfterRun — so they must not pin
   *    the full roster forever);
   *  - the Boss (decision/closure authority runs every pass), or exactly one
   *    acting Captain when the Boss is unavailable (standby Captain
   *    confirmation turns were a measured waste pattern).
   *
   * When assign_work was never used, Continuous still avoids full-roster
   * churn by admitting authority-directed seats only (fan-out / reserved
   * fan-out / yield-return / foreground synthesizer when configured) plus
   * Boss/acting Captain. Prior speakers are not re-seeded from round status.
   *
   * Fail-open: missing Continuous runtime / empty directed admit set keeps
   * the full roster; an open poll keeps the full roster (voting is the whole
   * roster's job, and polls always close/expire so this cannot pin forever);
   * a narrowing that would admit nobody falls back to the full roster instead
   * of stranding the goal.
   */
  private narrowContinuationRosterToOpenWork(
    chat: ChatRecord,
    fullRoster: EnsembleParticipant[],
    runtime?: ActiveRoundRuntime
  ): EnsembleParticipant[] {
    const control = chat.ensemble?.bossmanControlState
    const assignments = control?.assignments || []
    if ((control?.polls || []).some((poll) => poll.status === 'open')) return fullRoster

    const admitted = new Set<string>()
    if (assignments.length > 0) {
      for (const assignment of assignments) {
        if (assignment.status === 'open' || assignment.status === 'in_progress') {
          admitted.add(assignment.participantId)
        }
      }
      for (const gate of control?.reviewGates || []) {
        if (gate.status === 'required' && gateBlocksActiveGoal(gate, chat.activeGoal)) {
          admitted.add(gate.reviewerParticipantId)
        }
      }
      for (const request of control?.statusRequests || []) {
        if (request.status !== 'open') continue
        for (const participantId of request.targetParticipantIds || []) {
          admitted.add(participantId)
        }
      }
    } else if (runtime?.orchestrationMode === 'continuous') {
      const synthesizerParticipantId =
        chat.ensemble && resolveForegroundSynthesizerParticipantId(chat.ensemble)
      const synthesizerInRoster =
        synthesizerParticipantId &&
        fullRoster.some((participant) => participant.id === synthesizerParticipantId)
          ? synthesizerParticipantId
          : undefined
      for (const participantId of collectAuthorityOnlyContinuationCandidateIds({
        fannedOutParticipantIds: runtime.fannedOutParticipantIds,
        fanoutReservedParticipantIds: runtime.fanoutReservedParticipantIds,
        yieldReturnParticipantIds: (runtime.yieldReturnStack || []).flatMap((frame) => [
          frame.returnParticipantId,
          frame.targetParticipantId
        ]),
        synthesizerParticipantId: synthesizerInRoster
      })) {
        admitted.add(participantId)
      }
    } else {
      return fullRoster
    }

    const bossId = chat.ensemble?.bossmanParticipantId
    const bossEligible = runtime
      ? !this.primaryBossUnavailable(chat, runtime, bossId).unavailable &&
        fullRoster.some((participant) => participant.id === bossId)
      : Boolean(bossId && fullRoster.some((participant) => participant.id === bossId))
    if (bossId && bossEligible) admitted.add(bossId)
    const captainId = runtime
      ? this.activeActingCaptainParticipantId(chat, runtime)
      : resolveActingCaptainParticipantId({
          participants: fullRoster,
          captainParticipantIds: configuredEnsembleCaptainParticipantIds({
            participants: fullRoster,
            bossmanParticipantId: bossId,
            captainParticipantIds: chat.ensemble?.captainParticipantIds,
            secondInCommandParticipantId: chat.ensemble?.secondInCommandParticipantId
          })
        })
    if (captainId && !bossEligible) admitted.add(captainId)
    const narrowed = fullRoster.filter((participant) => admitted.has(participant.id))
    if (narrowed.length === 0) return fullRoster
    return narrowed
  }

  private async probeParticipantsForRound(
    runtime: ActiveRoundRuntime,
    participants: EnsembleParticipant[]
  ): Promise<{
    reachable: EnsembleParticipant[]
    unreachable: Array<{ participant: EnsembleParticipant; result: ParticipantProbeResult }>
  }> {
    const probe = this.deps.probeParticipant
    if (!probe) return { reachable: participants, unreachable: [] }
    const results = await Promise.all(
      participants.map(async (participant) => ({
        participant,
        result: await probe(participant).catch((err: unknown) => probeErrorToResult(err))
      }))
    )
    if (runtime.cancelled || this.roundsByChatId.get(runtime.chatId)?.roundId !== runtime.roundId) {
      return { reachable: [], unreachable: [] }
    }
    // 1.0.5-EW29 — Emit the participant-health header as a
    // structured message the renderer can render as a card
    // (matching the tool-call / ensemble-block visual treatment)
    // instead of as plain system-message text. The orchestrator
    // still includes the human-readable string as `content` so
    // anything that reads `message.content` (logs, debug dumps,
    // future agent-prompt context) keeps working — the renderer
    // just sees `metadata.kind === 'ensembleParticipantHealth'`
    // and picks a card component over the default bubble.
    this.appendParticipantHealthCard(runtime.chatId, runtime.roundId, results)
    return {
      reachable: results
        .filter(({ result }) => result.reachable)
        .map(({ participant }) => participant),
      unreachable: results.filter(
        (entry): entry is { participant: EnsembleParticipant; result: ParticipantProbeResult } =>
          !entry.result.reachable
      )
    }
  }

  /**
   * 1.0.7 — record a finished participant run's usage. Ensemble participant
   * runs complete here (not via the renderer's handleProviderExit), so this is
   * what gets them into usage.json → welcome wall-clock + activity heatmaps +
   * Providers-tab token totals. The builder returns null for already-recorded
   * or empty runs (no double-count, no junk rows). Best-effort: a failure must
   * never break round finalisation.
   */
  private recordParticipantUsage(run: ActiveParticipantRun): void {
    const record = this.deps.recordUsage
    if (!record) return
    try {
      const chat = this.deps.getChat(run.chatId)
      const workspaceId =
        chat?.scope === 'global' || !chat?.workspaceId
          ? ENSEMBLE_GLOBAL_USAGE_WORKSPACE_ID
          : chat.workspaceId
      const fallbackDurationMs = run.startedAt
        ? Math.max(0, this.deps.now() - new Date(run.startedAt).getTime())
        : 0
      const entry = buildEnsembleUsageRecord({
        provider: run.participant.provider,
        model: run.actualModel || run.participant.model || 'unknown',
        workspaceId,
        chatId: run.chatId,
        runId: run.runId,
        stats: run.stats as Record<string, unknown> | undefined,
        fallbackDurationMs,
        ...run.ensemblePromptUsageTelemetry
      })
      if (entry) record(entry)
    } catch {
      // Usage recording is best-effort; never block round finalisation.
    }
  }

  private bossmanRunBudgetUsage(run: ActiveParticipantRun): {
    durationSeconds?: number
    tokens?: number
  } {
    const stats =
      run.stats && typeof run.stats === 'object' && !Array.isArray(run.stats)
        ? (run.stats as Record<string, unknown>)
        : {}
    const inputTokens = numericRunStat(stats, 'input_tokens', 'inputTokens')
    const outputTokens = numericRunStat(stats, 'output_tokens', 'outputTokens')
    const totalTokens =
      numericRunStat(stats, 'total_tokens', 'totalTokens') || inputTokens + outputTokens
    const statsDurationMs = numericRunStat(stats, 'duration_ms', 'durationMs')
    const startedAtMs = Date.parse(run.startedAt || '')
    const fallbackDurationMs = Number.isFinite(startedAtMs)
      ? Math.max(0, this.deps.now() - startedAtMs)
      : 0
    const durationMs = statsDurationMs || fallbackDurationMs
    return {
      ...(durationMs > 0 ? { durationSeconds: Math.ceil(durationMs / 1000) } : {}),
      ...(totalTokens > 0 ? { tokens: totalTokens } : {})
    }
  }

  private finalizeRun(
    run: ActiveParticipantRun,
    status: EnsembleParticipantStatus,
    reason?: string
  ): void {
    this.stopCursorCompletionWatchdog(run)
    const suppressOwnedFanout =
      (status === 'cancelled' || status === 'skipped') && this.hasOwnedFanoutWork(run)
    if (suppressOwnedFanout) {
      run.suppressOwnedFanoutTranscriptRelease = true
    }
    if (run.terminalFinalized) {
      if (suppressOwnedFanout) {
        // The round may stop while a provider-terminal fan-out owner is still
        // retained solely to settle its lanes. Release/suppress that held
        // transcript — and, ONLY when the suppression actually costs the user
        // something, adopt the outcome they just asked for.
        //
        // The discriminator is whether this owner produced anything after it
        // fanned out. If it did, that synthesis never reaches the transcript,
        // and leaving the seat reading 'answered' would have the panel claim an
        // answer nobody can see. If it did not, the seat said everything it had
        // before the boundary, the transcript is complete, and its provider
        // outcome is the honest one — that is the case Stop must leave alone.
        //
        // Either way this is the ROUND's view of the seat, never the
        // transport's: no late cancellation is sent to a provider that already
        // completed. cancelRound's `liveActiveRuns` filter and
        // skipActiveParticipant's `ownerWasTerminal` guard still spare it that.
        const withheldSynthesis =
          run.ownedFanoutTranscriptBoundary !== undefined &&
          (run.timeline?.length || 0) > run.ownedFanoutTranscriptBoundary
        if (withheldSynthesis) {
          run.status = status
          run.terminalReason = reason
        }
        this.flushRun(run, true, withheldSynthesis ? reason : run.terminalReason)
        this.applyTerminalRunSideEffects(run)
        if (withheldSynthesis) {
          this.updateParticipantState(run.chatId, run.roundId, run.participant.id, status, reason)
        }
      }
      return
    }
    const promoteOverflowEvidence =
      status === 'failed' &&
      run.classifiedContextOverflow === true &&
      isHostSeatCompactionProvider(run.participant.provider)
    run.status = status
    run.terminalFinalized = true
    run.terminalReason = reason
    this.rememberTerminalRun(run.runId)
    const runtime = this.roundsByChatId.get(run.chatId)
    if (runtime?.roundId === run.roundId) {
      this.incrementBossmanBudgetUsage(
        runtime,
        [run.participant.id],
        this.bossmanRunBudgetUsage(run)
      )
    }
    this.flushRun(run, true, reason)
    if (!this.hasOwnedFanoutWork(run) || suppressOwnedFanout) {
      this.applyTerminalRunSideEffects(run)
    }
    if (!this.hasOwnedFanoutWork(run)) this.runsByRunId.delete(run.runId)
    // Promote only after terminal transcript/queue bookkeeping. An owner with
    // live fan-out settlements remains addressable for Stop until its lanes
    // return; resolving completion still happens last so serial/fan-out
    // maintenance cannot observe evidence while the provider callback unwinds.
    if (promoteOverflowEvidence) {
      this.pendingSeatOverflowEvidence.set(
        seatOverflowEvidenceKey(run.chatId, run.participant.id),
        {
          provider: run.participant.provider as HostSeatCompactionProvider,
          model: run.participant.model || '',
          linkedProviderSessionId:
            run.providerSessionId || run.participant.linkedProviderSessionId || null
        }
      )
    }
    run.completion?.(status)
    // A serial drain deferred behind active fan-out lanes resumes only once
    // every lane is terminal. Checked on every run finalization because lane
    // runs end through this path from dispatch failures, cancels, and normal
    // completion alike; no-ops when nothing is deferred for this chat.
    if (!run.laneId || !runtime?.activeScoutRunIds?.has(run.runId)) {
      this.maybeResumeDeferredDrain(run.chatId)
    }
  }

  private applyTerminalRunSideEffects(run: ActiveParticipantRun): void {
    if (run.terminalSideEffectsApplied) return
    run.terminalSideEffectsApplied = true
    try {
      this.reconcileBossmanControlAfterRun(run, run.status)
    } catch {
      // Durable transcript ownership must still release if a control-state
      // projection fails to persist; the terminal snapshot remains canonical.
    }
    this.transitionParticipantRunQueueJob(run, run.status, run.terminalReason)
    this.participantWorkingTelemetryByRunId.delete(run.runId)
    try {
      this.deps.onParticipantWorkingTelemetry?.({
        type: 'clear',
        chatId: run.chatId,
        roundId: run.roundId,
        participantId: run.participant.id,
        runId: run.runId
      })
    } catch {
      // Working telemetry is best-effort terminal projection only.
    }
    if (run.laneId) {
      try {
        this.deps.releaseWriteIntentsForLane?.(run.laneId)
      } catch {
        // Lock cleanup is best-effort; the in-memory registry is defensive.
      }
      try {
        // Candidate settlement for isolated lanes. Missing candidates are a
        // normal no-op inside the dep — most lanes never ran isolated.
        // 'skipped' maps to completed on purpose: a lane that returned no
        // transcript text still ran, and its worktree diff (not its chatter)
        // is the candidate's deliverable.
        this.deps.settleFanoutLaneWorktree?.({
          chatId: run.chatId,
          laneId: run.laneId,
          runStatus:
            run.status === 'failed' || run.status === 'unreachable'
              ? 'failed'
              : run.status === 'cancelled'
                ? 'cancelled'
                : 'completed'
        })
      } catch {
        // Candidate settlement is best-effort terminal projection only.
      }
    }
  }

  private transitionParticipantRunQueueJob(
    run: ActiveParticipantRun,
    status: EnsembleParticipantStatus,
    reason?: string
  ): void {
    const transition = this.deps.transitionRunQueueJob
    if (!transition) return
    const queueStatus = statusToRunQueueJobStatus(status)
    if (!queueStatus) return
    try {
      transition(run.runId, queueStatus, {
        ...(reason ? { statusReason: reason } : {}),
        ...(queueStatus === 'failed' && reason ? { lastError: reason } : {})
      })
    } catch {
      // Active Runs cleanup is best-effort; transcript/round finalization must still complete.
    }
  }

  /**
   * S1b-3 — TRUSTED media-ref injection from a MAIN-side ffmpeg producer tool
   * (audio_extract / transcode_audio / transcode_video). Unlike the `media_refs`
   * ingestion in handleProviderOutput, these refs are already verified (the
   * executor wrote a content-addressed asset), so they must NOT pass through
   * sanitizeRawProviderMediaRefs. Called in-process by index.ts's
   * injectTrustedMediaRefs keyed on appRunId — never reachable from provider
   * stdout, so a hostile provider cannot forge an audio/video ref through here.
   */
  appendTrustedMediaRefs(appRunId: string, refs: readonly TranscriptMediaRef[]): void {
    if (!appRunId || refs.length === 0) return
    const run = this.actionableRunForTool(appRunId)
    if (!run) return
    run.mediaRefs = mergeTranscriptMediaRefs(run.mediaRefs, refs)
    this.flushRun(run)
  }

  private flushRun(run: ActiveParticipantRun, final = false, reason?: string): void {
    // Immediate / terminal flushes must not also fire from the chat debounce.
    this.chatFlushScheduler.cancelRun(run.chatId, run.runId)
    if (run.flushTimer) {
      clearTimeout(run.flushTimer)
      run.flushTimer = undefined
    }
    // 1.0.7 — If a synthesis-required owner has now produced post-fan-out
    // content (or ended its turn without doing so), release the transcript
    // hold. The reentrancy guard prevents a recursive loop because
    // releaseOwnedFanoutHold calls flushRun internally.
    if (
      !run.releasingOwnedFanoutHold &&
      run.fanoutSynthesisRequired === true &&
      run.ownedFanoutTranscriptBoundary !== undefined &&
      !this.hasOwnedFanoutWork(run)
    ) {
      const hasPostFanoutTimeline = (run.timeline?.length || 0) > run.ownedFanoutTranscriptBoundary
      if (hasPostFanoutTimeline || final) {
        run.fanoutSynthesisRequired = false
        this.releaseOwnedFanoutHold(run)
        return
      }
    }
    const chat =
      this.flushChatOverlay?.chatId === run.chatId
        ? this.flushChatOverlay.chat
        : this.deps.getChat(run.chatId)
    if (!chat?.ensemble) return
    // Chat-level authority, resolved HERE because it does not live on the
    // participant: a lane card cannot derive Boss/Captain from the seat alone.
    // Written onto the row so it stays historically true — a seat that was the
    // Boss when the lane ran keeps its crown after the roster moves on.
    const laneSeatAuthority = resolveSeatAuthority({
      participantId: run.participant.id,
      stageRole: run.participant.stageRole,
      bossmanParticipantId: chat.ensemble.bossmanParticipantId,
      captainParticipantIds: chat.ensemble.captainParticipantIds
    })
    const timestamp = this.deps.nowIso()
    const holdingOwnedFanoutTranscript =
      run.ownedFanoutTranscriptBoundary !== undefined && this.hasOwnedFanoutWork(run)
    const suppressingOwnedFanoutTranscript =
      run.ownedFanoutTranscriptBoundary !== undefined &&
      run.suppressOwnedFanoutTranscriptRelease === true
    const preservingOwnedFanoutBoundary =
      holdingOwnedFanoutTranscript || suppressingOwnedFanoutTranscript
    const effectiveFinal =
      final && (!holdingOwnedFanoutTranscript || suppressingOwnedFanoutTranscript)
    const visibleStatus: EnsembleParticipantStatus = run.cursorContextPressureRecovery
      ? 'running'
      : suppressingOwnedFanoutTranscript
        ? run.status
        : holdingOwnedFanoutTranscript
          ? 'running'
          : run.status
    let messages = [...chat.messages]
    const existingMessageById = new Map(messages.map((message) => [message.id, message]))

    // Timeline-driven materialisation. Each entry in `run.timeline`
    // becomes a message in the transcript, preserving the speak →
    // do → speak → do chronology agents naturally follow. Each
    // message id is deterministic on (runId, ordinal, kind) so
    // subsequent flushes replace in place — no message duplication
    // even across many delta events.
    //
    // Per-run cleanup: any previously-emitted timeline messages
    // for this run whose ids are no longer present in the current
    // timeline get removed (defends against the rare case where
    // the orchestrator decides to collapse adjacent entries on a
    // later flush — currently we always preserve order, but the
    // cleanup makes the rebuild idempotent regardless).
    const fullTimeline = run.timeline || []
    const timeline = preservingOwnedFanoutBoundary
      ? fullTimeline.slice(0, run.ownedFanoutTranscriptBoundary)
      : fullTimeline
    const desiredIds = new Set<string>()
    const desiredMessages: ChatMessage[] = []
    for (let i = 0; i < timeline.length; i += 1) {
      const entry = timeline[i]
      if (entry.kind === 'content') {
        const id = timelineMessageId(run.runId, i, 'content')
        desiredIds.add(id)
        const rawContent = stripPseudoSystemYieldLines(entry.text)
        if (!rawContent.trim()) continue
        const previous = existingMessageById.get(id)
        const parsedPlan = parseExplicitProposedPlan(rawContent)
        const shouldStampPlan = Boolean(
          parsedPlan && shouldStampEnsembleProposedPlan(chat, run.roundId, run.participant.id)
        )
        const previousPlan = shouldStampEnsembleProposedPlan(chat, run.roundId, run.participant.id)
          ? previous?.metadata?.proposedPlan
          : undefined
        const proposedPlan =
          parsedPlan && shouldStampPlan
            ? {
                title: parsedPlan.title,
                body: parsedPlan.body,
                status: previousPlan?.status || 'pending'
              }
            : previousPlan
        const content = shouldStampPlan ? stripExplicitProposedPlanBlock(rawContent) : rawContent
        desiredMessages.push({
          id,
          role: 'assistant',
          content,
          timestamp: previous?.timestamp || timestamp,
          runId: run.runId,
          metadata: {
            kind: 'ensembleParticipant',
            ensembleRoundId: run.roundId,
            ensembleParticipantId: run.participant.id,
            ...laneTranscriptMetadata(run),
            ensembleProvider: run.participant.provider,
            ensembleRole: run.participant.role,
            ...(run.participant.stageRole ? { ensembleStageRole: run.participant.stageRole } : {}),
            ensembleOrder: run.participant.order,
            // The seat AS CONFIGURED for this run, so a fan-out lane card can
            // render the same seat element the close-out and peer-message cards
            // use. Carries the permission preset, which role/model/reasoning
            // alone do not — without it a lane's chip would claim the default
            // tier rather than the one it actually ran under.
            ensembleSeatSnapshot: ensembleSeatSnapshot(run.participant),
            ...(laneSeatAuthority ? { ensembleSeatAuthority: laneSeatAuthority } : {}),
            ensembleStatus: visibleStatus,
            ensembleTimelineIndex: i,
            ...pooledAgentTranscriptMetadata(run.participant),
            // Model preview: pass the participant's configured model so
            // the renderer can show e.g. "Codex / GPT 5.5" next to the
            // bubble. Crucial preview for 1.0.4's same-provider
            // ensembles where the role+provider alone won't tell the
            // user which Claude/Codex is speaking.
            ensembleModel: run.participant.model,
            // Reasoning suffix companion to `ensembleModel`. The
            // renderer's `formatAssistantMessageLabel` appends this via
            // `reasoningDisplayLabel` so the header reads "5.5 Extra
            // High" / "Opus 4.7 · Max" / "K2.7 Coding Thinking" — matching
            // the composer chip the user picked. Only the field that
            // applies to this participant's provider is set; the others
            // stay undefined.
            ...ensembleReasoningMetadata(run.participant),
            ...(proposedPlan ? { proposedPlan } : {})
          }
        })
      } else {
        const id = timelineMessageId(run.runId, i, 'tool')
        desiredIds.add(id)
        const activity = run.toolActivities?.find((a) => a.id === entry.toolId)
        if (!activity) continue
        const previous = existingMessageById.get(id)
        desiredMessages.push({
          id,
          role: 'tool',
          content: '',
          timestamp: previous?.timestamp || timestamp,
          runId: run.runId,
          toolActivities: [activity],
          metadata: {
            kind: 'ensembleParticipantTools',
            ensembleRoundId: run.roundId,
            ensembleParticipantId: run.participant.id,
            ...laneTranscriptMetadata(run),
            ensembleProvider: run.participant.provider,
            ensembleRole: run.participant.role,
            ...(run.participant.stageRole ? { ensembleStageRole: run.participant.stageRole } : {}),
            ensembleOrder: run.participant.order,
            ensembleTimelineIndex: i,
            ensembleModel: run.participant.model,
            ...pooledAgentTranscriptMetadata(run.participant),
            ...ensembleReasoningMetadata(run.participant)
          }
        })
      }
    }

    // Stamp accumulated agent-produced media (image tool results) onto this
    // run's LAST content message so the transcript media strip renders it.
    // Sourced from run.mediaRefs (not bolted onto a message object) so it
    // survives the wholesale message rebuild above on every re-flush.
    if (!preservingOwnedFanoutBoundary && run.mediaRefs && run.mediaRefs.length > 0) {
      let stamped = false
      for (let i = desiredMessages.length - 1; i >= 0; i -= 1) {
        const candidate = desiredMessages[i]
        if (candidate.role === 'assistant' && candidate.metadata?.kind === 'ensembleParticipant') {
          candidate.metadata = {
            ...candidate.metadata,
            mediaRefs: mergeTranscriptMediaRefs(
              candidate.metadata.mediaRefs as TranscriptMediaRef[] | undefined,
              run.mediaRefs
            )
          }
          stamped = true
          break
        }
      }
      // No assistant content message to carry the media — this happens when a
      // participant's terminal action is a producer tool (audio_extract /
      // transcode_audio / transcode_video) with no surrounding prose, so the
      // timeline holds only a `{kind:'tool'}` entry and the stamp loop above
      // finds no candidate. Without this, the produced asset is on disk but
      // never renders. Synthesize a minimal empty-content assistant message to
      // carry the refs, mirroring the solo-bridge and background sub-thread
      // paths which already do this. The id is stable beyond the real timeline
      // entries (0..timeline.length-1) so it's idempotent across re-flushes; on
      // a later flush where the participant DOES emit text `stamped` is true and
      // this synthetic message is never built, so the reconciliation below
      // drops the stale synthetic because it is absent from `desiredMessages`.
      if (!stamped) {
        const id = timelineMessageId(run.runId, timeline.length, 'content')
        desiredIds.add(id)
        const previous = existingMessageById.get(id)
        desiredMessages.push({
          id,
          role: 'assistant',
          content: '',
          timestamp: previous?.timestamp || timestamp,
          runId: run.runId,
          metadata: {
            kind: 'ensembleParticipant',
            ensembleRoundId: run.roundId,
            ensembleParticipantId: run.participant.id,
            ...laneTranscriptMetadata(run),
            ensembleProvider: run.participant.provider,
            ensembleRole: run.participant.role,
            ...(run.participant.stageRole ? { ensembleStageRole: run.participant.stageRole } : {}),
            ensembleOrder: run.participant.order,
            ensembleSeatSnapshot: ensembleSeatSnapshot(run.participant),
            ...(laneSeatAuthority ? { ensembleSeatAuthority: laneSeatAuthority } : {}),
            ensembleStatus: visibleStatus,
            ensembleTimelineIndex: timeline.length,
            ensembleModel: run.participant.model,
            ...pooledAgentTranscriptMetadata(run.participant),
            ...ensembleReasoningMetadata(run.participant),
            mediaRefs: mergeTranscriptMediaRefs(undefined, run.mediaRefs)
          }
        })
      }
    }

    // Reconcile already-materialised timeline rows in place so system/status
    // rows keep the exact event position where they were appended. A run can
    // continue after one of those rows (for example: speak -> system event ->
    // tool -> speak); rebuilding the whole run at its first anchor would move
    // the later tool/speech above the system row and leave that row glued to
    // the transcript tail until the next participant started. Existing rows
    // are updated where they sit, stale rows are removed, and only genuinely
    // new timeline rows append at the current tail. First materialisation still
    // uses the fan-out/dispatch placement rules below.
    const existingTimelineStartIndex = messages.findIndex((message) =>
      isRunTimelineMessage(message, run)
    )
    const preferredInsertionIndex =
      existingTimelineStartIndex >= 0
        ? messages
            .slice(0, existingTimelineStartIndex)
            .filter((message) => !isRunTimelineMessage(message, run)).length
        : null
    const desiredMessageById = new Map(
      desiredMessages.map((message) => [message.id, message] as const)
    )
    let retainedExistingTimelineMessage = false
    messages = messages.flatMap((message) => {
      if (!isRunTimelineMessage(message, run)) return [message]
      const replacement = desiredMessageById.get(message.id)
      if (!replacement) return []
      desiredMessageById.delete(message.id)
      retainedExistingTimelineMessage = true
      return [replacement]
    })
    const newTimelineMessages = desiredMessages.filter((message) =>
      desiredMessageById.has(message.id)
    )
    // Dispatch chronology for the first-flush placement rules: chat.runs is
    // appended per seeded run, so its array order IS the dispatch order.
    const runDispatchOrder = new Map(chat.runs.map((chatRun, index) => [chatRun.runId, index]))
    messages = retainedExistingTimelineMessage
      ? [...messages, ...newTimelineMessages]
      : run.releaseOwnedFanoutTranscriptAtTail
        ? [...messages, ...newTimelineMessages]
        : insertRunTimelineMessages(
            messages,
            newTimelineMessages,
            run,
            preferredInsertionIndex,
            runDispatchOrder
          )

    // Status card for yielded / failed / skipped, appended after
    // the timeline messages so it reads as a coda. Unchanged from
    // the pre-timeline version aside from running after the new
    // messages are materialised.
    if (
      effectiveFinal &&
      (run.status === 'yielded' ||
        run.status === 'failed' ||
        run.status === 'skipped' ||
        run.status === 'sleeping')
    ) {
      const statusLine = (() => {
        const who = run.participant.role || run.participant.provider
        const suffix = reason ? ` ${reason}` : ''
        if (run.status === 'yielded') return `${who} yielded.${suffix}`
        if (run.status === 'failed') return `${who} failed.${suffix}`
        if (run.status === 'sleeping') return `${who} sleeping.${suffix}`
        return `${who} skipped.${suffix}`
      })()
      const statusId = `ensemble-status-${run.runId}`
      // Replace existing status card if one is already in messages
      // (defensive — we filtered timeline messages above but the
      // status card has its own id namespace).
      const existingStatusIdx = messages.findIndex((m) => m.id === statusId)
      const previousStatus = existingStatusIdx >= 0 ? messages[existingStatusIdx] : null
      const statusMsg: ChatMessage = {
        id: statusId,
        role: 'system',
        content: statusLine,
        timestamp: previousStatus?.timestamp || timestamp,
        runId: run.runId,
        metadata: {
          kind: 'ensembleParticipantStatus',
          ensembleRoundId: run.roundId,
          ensembleParticipantId: run.participant.id,
          ...laneTranscriptMetadata(run),
          ensembleProvider: run.participant.provider,
          ensembleRole: run.participant.role,
          ...(run.participant.stageRole ? { ensembleStageRole: run.participant.stageRole } : {}),
          ensembleOrder: run.participant.order,
          ensembleStatus: visibleStatus,
          ensembleModel: run.participant.model,
          ...pooledAgentTranscriptMetadata(run.participant),
          ...ensembleReasoningMetadata(run.participant)
        }
      }
      if (existingStatusIdx >= 0) {
        messages[existingStatusIdx] = statusMsg
      } else {
        messages = [...messages, statusMsg]
      }
    }

    // Prompt receipts require both adapter acceptance and a terminal state
    // where the provider session is safe to resume. Cancellation/failure cannot
    // acknowledge either the shell or dynamic snapshot, and compaction
    // invalidates both even after an otherwise successful completion.
    const shouldPersistDynamicStateReceipt =
      effectiveFinal &&
      !run.invalidatePromptDynamicStateReceipt &&
      Boolean(run.promptDynamicStateVersion) &&
      isDynamicStateReceiptTerminalStatus(run.status)
    const shouldPersistPromptShellReceipt =
      effectiveFinal &&
      !run.invalidatePromptShellReceipt &&
      Boolean(run.promptShellStamp) &&
      isDynamicStateReceiptTerminalStatus(run.status)

    const runs = chat.runs.map((existingRun) => {
      if (existingRun.runId !== run.runId) return existingRun
      const next: ChatRun = {
        ...existingRun,
        actualModel: run.actualModel || existingRun.actualModel,
        providerThreadId: run.providerSessionId || existingRun.providerThreadId,
        stats: run.stats || existingRun.stats,
        status: effectiveFinal ? statusToRunStatus(run.status) : existingRun.status || 'running',
        endedAt: effectiveFinal ? timestamp : existingRun.endedAt,
        ...(effectiveFinal && run.status === 'sleeping'
          ? {
              ensembleSleepWakeupId: reason
                ? extractWakeupIdFromReason(reason)
                : existingRun.ensembleSleepWakeupId,
              ensembleSleepUntil: reason
                ? extractWakeAtFromReason(reason)
                : existingRun.ensembleSleepUntil,
              ensembleSleepReason: reason || existingRun.ensembleSleepReason
            }
          : {})
      }
      if (run.invalidatePromptDynamicStateReceipt) {
        delete next.promptDynamicStateVersion
      } else if (shouldPersistDynamicStateReceipt) {
        next.promptDynamicStateVersion = run.promptDynamicStateVersion
      }
      return next
    })

    const persistProviderSession =
      this.deps.shouldPersistProviderSessionForRun?.(run.runId) !== false
    const shouldMergeTerminalTokenTotals = effectiveFinal && !run.terminalTokenTotalsApplied
    const participants = (chat.ensemble.participants || []).map((participant) => {
      if (participant.id !== run.participant.id) return participant
      const tokenTotals = shouldMergeTerminalTokenTotals
        ? mergeTokenTotals(participant.tokenTotals, run.stats)
        : participant.tokenTotals
      const next: EnsembleParticipant = {
        ...participant,
        ...(persistProviderSession && run.providerSessionId
          ? { linkedProviderSessionId: run.providerSessionId }
          : {}),
        ...(tokenTotals ? { tokenTotals } : {})
      }
      if (run.invalidatePromptShellReceipt) {
        delete next.promptShellVersion
      } else if (shouldPersistPromptShellReceipt) {
        next.promptShellVersion = run.promptShellStamp
      }
      if (run.invalidatePromptDynamicStateReceipt) {
        delete next.promptDynamicStateVersion
      } else if (shouldPersistDynamicStateReceipt) {
        next.promptDynamicStateVersion = run.promptDynamicStateVersion
      }
      return next
    })
    const activeRound = updateLaneInRound(
      updateRoundParticipant(
        chat.ensemble.activeRound,
        run.participant.id,
        {
          status: visibleStatus,
          runId: run.cursorContextPressureRecovery ? undefined : run.runId,
          ...(effectiveFinal && reason && !run.cursorContextPressureRecovery ? { reason } : {}),
          ...(effectiveFinal && !run.cursorContextPressureRecovery ? { endedAt: timestamp } : {})
        },
        { setActive: !run.laneId }
      ),
      run.laneId,
      visibleStatus,
      timestamp,
      run.cursorContextPressureRecovery ? undefined : reason
    )
    // Blackboard delta bookkeeping — the entries injected into this run's
    // prompt are now part of the seat's session memory. Idempotent + same-ref
    // when nothing changes, so repeat flushes cost nothing.
    const blackboard = markBlackboardEntriesSeen(
      chat.ensemble.blackboard || [],
      run.injectedBlackboardEntryIds || [],
      run.participant.id
    )
    const nextChat: ChatRecord = {
      ...chat,
      messages,
      runs,
      ensemble: {
        ...chat.ensemble,
        participants,
        activeRound,
        ...(blackboard !== chat.ensemble.blackboard ? { blackboard } : {}),
        updatedAt: timestamp
      },
      updatedAt: this.deps.now()
    }
    if (this.flushChatOverlay?.chatId === run.chatId) {
      this.flushChatOverlay.chat = nextChat
    } else {
      this.saveChatWithCheckpoint(nextChat, 'participant-updated')
    }
    if (shouldMergeTerminalTokenTotals) run.terminalTokenTotalsApplied = true
    if (run.releaseOwnedFanoutTranscriptAtTail && newTimelineMessages.length > 0) {
      run.releaseOwnedFanoutTranscriptAtTail = undefined
    }
    if (effectiveFinal) this.deps.releaseProviderSessionPersistenceDecision?.(run.runId)
  }

  /**
   * Debounce transcript persistence per chat. Multiple fan-out lanes calling
   * this within the 250ms window share one timer; flushScheduledRuns then
   * applies every pending lane and saves once.
   */
  private scheduleFlush(run: ActiveParticipantRun): void {
    this.chatFlushScheduler.schedule(run.chatId, run.runId)
  }

  /**
   * Timer callback for the per-chat debounce. One dirty seat flushes normally;
   * several seats share an in-memory overlay so intermediate flushRun calls do
   * not each hit deps.saveChat.
   */
  private flushScheduledRuns(chatId: string, runIds: string[]): void {
    const runs = runIds
      .map((runId) => this.runsByRunId.get(runId))
      .filter((run): run is ActiveParticipantRun => Boolean(run))
    if (runs.length === 0) return
    if (runs.length === 1) {
      this.flushRun(runs[0])
      return
    }
    const base = this.deps.getChat(chatId)
    if (!base?.ensemble) return
    const priorOverlay = this.flushChatOverlay
    this.flushChatOverlay = { chatId, chat: base }
    try {
      for (const run of runs) this.flushRun(run)
      const result = this.flushChatOverlay.chat
      if (result !== base) this.saveChatWithCheckpoint(result, 'participant-updated')
    } finally {
      this.flushChatOverlay = priorOverlay
    }
  }

  private updateParticipantState(
    chatId: string,
    roundId: string,
    participantId: string | undefined,
    status: EnsembleParticipantStatus,
    reason?: string
  ): void {
    if (!participantId) return
    this.updateChatRound(chatId, (round) =>
      round?.roundId === roundId
        ? updateRoundParticipant(round, participantId, {
            status,
            reason,
            endedAt: this.deps.nowIso()
          })
        : round
    )
  }

  /**
   * 1.0.4-AD — pre-flight probe rejected this participant. Mark them
   * `'unreachable'` in the active round, stash the reason on
   * `lastFailureReason` so the chip strip tooltip can surface it, and
   * stamp `endedAt` so the per-participant timing card closes. No run
   * record is created (we never seeded one) so this is a pure round-
   * state mutation — distinct from `finalizeRun` which also walks the
   * provider-run / message timeline.
   */
  private markParticipantUnreachable(
    chatId: string,
    roundId: string,
    participant: EnsembleParticipant,
    reason: string
  ): void {
    const endedAt = this.deps.nowIso()
    this.updateChatRound(chatId, (round) =>
      round?.roundId === roundId
        ? updateRoundParticipant(round, participant.id, {
            status: 'unreachable',
            reason,
            lastFailureReason: reason,
            endedAt
          })
        : round
    )
  }

  private finishRound(
    chatId: string,
    roundId: string,
    status: Extract<EnsembleRoundState['status'], 'completed' | 'cancelled' | 'failed'>,
    options: {
      queuedPromptEntries?: QueuedRoundEntry[]
      quarantinedLegacyPrompts?: string[]
    } = {}
  ): void {
    const runtime = this.roundsByChatId.get(chatId)
    if (runtime?.roundId === roundId) {
      this.clearYieldReturnStack(runtime)
      const pendingParticipantSeatChanges = runtime.pendingParticipantSeatChanges
      runtime.pendingParticipantSeatChanges = undefined
      this.applyPendingParticipantSeatChanges(runtime, pendingParticipantSeatChanges)
    }
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return
    const endedAt = this.deps.nowIso()
    const activeRound = chat.ensemble.activeRound
    if (activeRound?.roundId !== roundId) return
    const persistedQueueFields = options.quarantinedLegacyPrompts?.length
      ? {
          queuedPrompt: options.quarantinedLegacyPrompts[0],
          queuedPrompts: [
            ...options.quarantinedLegacyPrompts,
            ...(options.queuedPromptEntries || []).map((entry) => entry.prompt)
          ],
          queuedPromptEntries: undefined
        }
      : this.queuedPromptFields(options.queuedPromptEntries || [])
    const nextRound: EnsembleRoundState = {
      ...activeRound,
      status,
      activeParticipantId: undefined,
      ...persistedQueueFields,
      endedAt,
      participants: activeRound.participants.map((participant) =>
        participant.status === 'idle'
          ? {
              ...participant,
              status: status === 'cancelled' ? 'cancelled' : 'skipped',
              reason:
                status === 'cancelled'
                  ? 'Round cancelled before this participant spoke.'
                  : 'Round superseded before this participant spoke.',
              endedAt
            }
          : participant
      )
    }
    const summaryRecord =
      status === 'completed'
        ? findTerminalSynthesizerRoundSummary({
            messages: chat.messages,
            roundId,
            synthesizerParticipantId: resolveForegroundSynthesizerParticipantId(chat.ensemble),
            capturedAt: endedAt
          })
        : null
    // M4 — derive blackboard entries from the synthesizer summary and upsert
    // them onto the shared scratchpad. Session-scoped + stable-keyed, so each
    // round's summary replaces the prior round's derived entries (the
    // blackboard reflects the panel's *current* agreed state; full per-round
    // history stays in `roundSummaries`). Deterministic ids (roundId + seq) so
    // there's no clock/random dependence here. Skipped when no summary.
    let nextBlackboard = chat.ensemble.blackboard
    let nextBlackboardTombstones = chat.ensemble.blackboardTombstones
    if (summaryRecord) {
      const derived = deriveBlackboardFromRoundSummary({
        summary: summaryRecord.summary,
        chatId: chat.appChatId,
        roundId,
        participantId: summaryRecord.participantId,
        createdAt: endedAt,
        makeId: (seq) => `${roundId}-bb-${seq}`
      })
      if (derived.length > 0) {
        nextBlackboard = chat.ensemble.blackboard || []
        for (const derivedEntry of derived) {
          const upsert = upsertBlackboardEntry(nextBlackboard, derivedEntry, {
            currentRoundId: roundId,
            tombstones: nextBlackboardTombstones,
            prunedAt: endedAt
          })
          if (!upsert.ok) break
          nextBlackboard = upsert.entries
          nextBlackboardTombstones = upsert.tombstones
        }
      }
    }
    // M5 — run the complexity-escalation heuristic over the finished round's
    // end-state and append any signals. Advisory ONLY: we persist + broadcast
    // (via the saveChat → 'chat-updated' path) but never auto-act. Deterministic
    // ids (roundId + kind) keep this clock/random-free. Skipped for cancelled
    // rounds (a user Stop isn't a complexity event).
    let nextEscalationSignals = chat.ensemble.escalationSignals
    if (status === 'completed') {
      const fresh = detectComplexityEscalation({
        chatId: chat.appChatId,
        roundId,
        participants: nextRound.participants,
        continuationHops: nextRound.continuationHops,
        maxContinuationHops: nextRound.maxContinuationHops,
        hasSynthesizer: Boolean(resolveForegroundSynthesizerParticipantId(chat.ensemble)),
        createdAt: endedAt,
        makeId: (kind) => `${roundId}-esc-${kind}`
      })
      nextEscalationSignals = appendEscalationSignals(chat.ensemble.escalationSignals, fresh)
    }
    const nextBossmanControlState =
      status === 'completed'
        ? {
            ...(chat.ensemble.bossmanControlState || {}),
            completedRoundCount: (chat.ensemble.bossmanControlState?.completedRoundCount || 0) + 1
          }
        : chat.ensemble.bossmanControlState
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          activeRound: nextRound,
          lastRoundSummary: summaryRecord ? summaryRecord.summary : undefined,
          roundSummaries: summaryRecord
            ? {
                ...(chat.ensemble.roundSummaries || {}),
                [roundId]: summaryRecord
              }
            : chat.ensemble.roundSummaries,
          ...(nextBossmanControlState ? { bossmanControlState: nextBossmanControlState } : {}),
          ...(nextBlackboard ? { blackboard: nextBlackboard } : {}),
          ...(nextBlackboardTombstones ? { blackboardTombstones: nextBlackboardTombstones } : {}),
          ...(nextEscalationSignals ? { escalationSignals: nextEscalationSignals } : {}),
          updatedAt: endedAt
        },
        updatedAt: this.deps.now()
      },
      status === 'completed'
        ? 'round-completed'
        : status === 'cancelled'
          ? 'round-cancelled'
          : 'round-failed'
    )
    this.completeCheckpoint(chatId, roundId, status)
    const pendingRosterChat = this.deps.getChat(chatId)
    if (pendingRosterChat) {
      const appliedRosterChat = applyPendingEnsembleRosterPresetOnFinalize(pendingRosterChat)
      if (appliedRosterChat !== pendingRosterChat) {
        this.saveChatWithCheckpoint(
          { ...appliedRosterChat, updatedAt: this.deps.now() },
          'participant-updated'
        )
      }
    }
    this.maybeAutoCompactSeatsAfterRound(chatId, status)
  }

  /**
   * S16 — deliver approved external contributions at their seat's turn.
   *
   * The external is NOT a member of the round state machine:
   * `EnsembleRoundParticipantState.provider` is a required `ProviderId` and a
   * human has none, so fabricating one would put a lie into persisted state and
   * into every prompt that reads it. What the external has instead is a
   * POSITION — `EffectiveSeat.order` sorts model and external seats in one
   * shared space — and this method honours it: called at each seat boundary,
   * it materialises every approved contribution whose seat sorts at or before
   * the seat about to run.
   *
   * `beforeOrder` undefined means the round is over and this is the backstop
   * sweep. A round can end before reaching position 7 — the goal completes,
   * seats yield, a quarantine cuts it short — and without the sweep an approved
   * message would silently wait for a whole further round. Anything delivered
   * that way is stamped `outOfPosition` so the transcript can say so rather
   * than implying the panel reached that seat.
   *
   * Nothing here dispatches: no run, no hop, no round-participant mutation.
   */
  private deliverExternalSeatTurns(
    runtime: ActiveRoundRuntime,
    beforeOrder: number | undefined
  ): void {
    const queue = this.deps.externalContributionQueue
    const resolveSeats = this.deps.resolveExternalSeats
    if (!queue || !resolveSeats) return

    let awaiting: readonly ExternalContributionEntry[]
    try {
      awaiting = queue.listAwaitingMaterialisation()
    } catch {
      return
    }
    if (awaiting.length === 0) return
    const forChat = awaiting.filter((entry) => entry.chatId === runtime.chatId)
    if (forChat.length === 0) return

    const chat = this.deps.getChat(runtime.chatId)
    if (!chat?.ensemble) return

    const roster = resolveEffectiveRoster({
      participants: chat.ensemble.participants,
      externals: resolveSeats(runtime.chatId)
    })
    const seatByCollaborator = new Map(
      roster.seats.filter(isExternalSeat).map((seat) => [seat.collaboratorId, seat] as const)
    )

    // Oldest approval first within a seat, so a person's own messages keep the
    // order they wrote them in.
    const due = forChat
      .filter((entry) => {
        const seat = seatByCollaborator.get(entry.collaboratorId)
        // A seat the host muted holds its position but does not take its turn.
        // A seat that no longer exists (revoked between approve and now) never
        // delivers — trust was withdrawn after the approval.
        if (!seat || !seat.enabled) return false
        return beforeOrder === undefined || seat.order <= beforeOrder
      })
      .sort((a, b) => a.sequence - b.sequence)
    if (due.length === 0) return

    // THE ID CHECK IS THE DUPLICATE GUARD, and it has to be real rather than
    // asserted. An earlier version of this comment claimed the deterministic
    // message id prevented double delivery; nothing implemented that, while the
    // same guard sits 150 lines below for the compaction card.
    //
    // The window is narrow but one-directional, which is what makes it worth
    // closing. The chat store fsyncs and RETHROWS, so a failed transcript write
    // aborts before anything is marked. The queue's persist neither fsyncs nor
    // rethrows — it logs and returns — so the only asymmetric outcome is
    // precisely the bad one: the row lands durably, the queue file still says
    // `materialised: false`, and on relaunch the entry is handed back for
    // delivery with its body intact. A second row would then share one id,
    // which scrambles the id-keyed virtualised transcript, shows the
    // contribution twice to every collaborator, and burns two slots of the
    // per-prompt external budget for one message.
    const timestamp = this.deps.nowIso()
    const seenIds = new Set(chat.messages.map((message) => message.id))
    const rows: ChatMessage[] = []
    const settled: ExternalContributionEntry[] = []
    for (const entry of due) {
      const id = entry.messageId || `external-seat-turn-${entry.entryId}`
      // Already in the transcript: the delivery happened, only the bookkeeping
      // was lost. Mark it and move on — that reconciles the divergence rather
      // than leaving it to be retried at every boundary forever.
      settled.push(entry)
      if (seenIds.has(id)) continue
      seenIds.add(id)
      const seat = seatByCollaborator.get(entry.collaboratorId)
      rows.push(
        makeDeliveredExternalContribution({
          id,
          content: entry.body ?? '',
          timestamp,
          shareId: entry.shareId,
          collaboratorId: entry.collaboratorId,
          collaboratorDisplayName: entry.displayName,
          clientMessageId: entry.clientMessageId,
          sequence: entry.sequence,
          ...(seat ? { seatOrder: seat.order } : {}),
          outOfPosition: beforeOrder === undefined
        })
      )
    }

    if (rows.length > 0) {
      this.saveChatWithCheckpoint(
        {
          ...chat,
          messages: [...chat.messages, ...rows],
          updatedAt: this.deps.now()
        },
        'participant-updated'
      )
    }

    // Mark AFTER the transcript write, never before. The two writes cannot be
    // made atomic, and a crash between them must leave the entry re-deliverable
    // rather than silently consumed — losing a message is recoverable, dropping
    // one is not. The id check above is what makes that retry safe.
    //
    // No try/catch: markMaterialised's only write is the queue's persist, which
    // swallows its own errors, so it cannot throw. A catch here would be
    // unreachable code implying a failure mode that does not exist.
    for (const entry of settled) queue.markMaterialised(entry.entryId)
  }

  /**
   * Authoritative seat change → structured transcript row (owner spec
   * 2026-08-05). The plain sentence stays as `content` so TUI/iOS/plaintext
   * surfaces degrade to exactly the old system line; the renderer promotes
   * `metadata.seatChange` into the animated row. Rapid adjustments to the same
   * participant within the sliding window coalesce (see SeatChangeMessages.ts):
   * the superseded row is removed in the SAME checkpoint that appends the
   * fresh one, preserving the lose-one/gain-one row invariance. Deliberately
   * NO laneId — that keeps the row out of fan-out viewport folds.
   */
  private appendSeatChange(
    chatId: string,
    roundId: string,
    before: EnsembleParticipant,
    after: EnsembleParticipant,
    content: string
  ): string | null {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return null
    const grantsCount = chat.workspacePath
      ? (this.deps.getSettings().agenticWorkspaceGrants || []).filter(
          (grant) => grant.workspacePath === chat.workspacePath
        ).length
      : undefined
    const seatAuthorityFor = (participant: EnsembleParticipant): 'boss' | 'captain' | undefined =>
      resolveSeatAuthority({
        participantId: participant.id,
        stageRole: participant.stageRole,
        bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
        captainParticipantIds: chat.ensemble?.captainParticipantIds
      })
    const timestamp = this.deps.nowIso()
    const { messages, payload } = coalesceSeatChangeMessages(
      chat.messages,
      {
        participantId: before.id,
        label: participantLabel(after) || participantLabel(before),
        before: seatChangeSeatState(before, grantsCount, seatAuthorityFor(before)),
        after: seatChangeSeatState(after, grantsCount, seatAuthorityFor(after)),
        appliedAt: timestamp,
        // The brief is the one part of a seat `seatChangeSeatState` does not
        // carry — nothing renders it, and the text is paragraphs against the
        // row's one line. So a brief-only edit produced a payload whose two
        // sides were identical: a change row with nothing changed in it. The
        // flag is what the row's "(Brief updated)" note reads.
        ...(before.instructions !== after.instructions ? { briefUpdated: true } : {})
      },
      this.deps.now()
    )
    const id = `ensemble-seat-change-${roundId}-${this.deps.now()}-${this.nextStatusSeq()}`
    this.saveChatWithCheckpoint(
      {
        ...chat,
        messages: [
          ...messages,
          {
            id,
            role: 'system',
            content,
            timestamp,
            metadata: {
              kind: 'ensembleSeatChange',
              ensembleRoundId: roundId,
              seatChange: payload
            }
          }
        ],
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
    return id
  }

  /**
   * The agent built a roster mid-round → ONE transcript row showing the roster
   * as it now stands, as a stack of seat elements with no before side (owner
   * spec 2026-08-06).
   *
   * This is the solo→Ensemble case: a single-provider thread where the agent
   * switches Ensemble on and adds seats. There is no "before" to roll from —
   * a moment ago the round had no such seat at all — so the row is a portrait
   * of the new roster rather than a transition. A run of adds folds into the
   * one row (see `coalesceSeatRosterMessages`), which is why the plain "Boss
   * added X." status line is REPLACED here rather than written alongside.
   *
   * `mode: 'refresh-only'` is the caller that is not itself a roster mutation:
   * a seat EDIT already writes its own animated row, but leaving the open
   * roster row showing that seat's superseded config would make it a lie.
   *
   * Returns the row id, or null when nothing was written — the caller falls
   * back to its plain status line on null, so a mutation is never silent.
   */
  private appendSeatRoster(
    chatId: string,
    roundId: string,
    participants: readonly EnsembleParticipant[],
    mode: 'create-or-refresh' | 'refresh-only'
  ): string | null {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return null
    const seats = participants.filter((participant) => participant.enabled !== false)
    if (seats.length === 0) return null
    const grantsCount = chat.workspacePath
      ? (this.deps.getSettings().agenticWorkspaceGrants || []).filter(
          (grant) => grant.workspacePath === chat.workspacePath
        ).length
      : undefined
    const rosterSeats: SeatRosterSeat[] = seats.map((participant) => ({
      participantId: participant.id,
      ...seatChangeSeatState(
        participant,
        grantsCount,
        resolveSeatAuthority({
          participantId: participant.id,
          stageRole: participant.stageRole,
          bossmanParticipantId: chat.ensemble?.bossmanParticipantId,
          captainParticipantIds: chat.ensemble?.captainParticipantIds
        })
      )
    }))
    const timestamp = this.deps.nowIso()
    const label = `Ensemble roster applied — ${rosterSeats.length} seat${
      rosterSeats.length === 1 ? '' : 's'
    }`
    const { messages, payload } = coalesceSeatRosterMessages(
      chat.messages,
      { seats: rosterSeats, label, appliedAt: timestamp },
      this.deps.now(),
      mode
    )
    if (!payload) return null
    // The plain sentence is what TUI / iOS / copy-paste read — the stack is a
    // renderer promotion, so the roster has to survive in prose too.
    const content = `${label}: ${seats.map((participant) => participantSeatValue(participant)).join('; ')}.`
    const id = `ensemble-seat-roster-${roundId}-${this.deps.now()}-${this.nextStatusSeq()}`
    this.saveChatWithCheckpoint(
      {
        ...chat,
        messages: [
          ...messages,
          {
            id,
            role: 'system',
            content,
            timestamp,
            metadata: {
              kind: 'ensembleSeatChange',
              ensembleRoundId: roundId,
              seatChange: payload
            }
          }
        ],
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
    return id
  }

  private appendRoundStatus(
    chatId: string,
    roundId: string,
    content: string,
    options: {
      fanoutCategory?: 'user' | 'orchestrated'
      fanoutLabel?: string
    } = {}
  ): string | null {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return null
    const timestamp = this.deps.nowIso()
    // 1.0.7 — UNIQUE id per status message. Pre-1.0.7 every status line in a
    // round shared `ensemble-round-status-${roundId}`, so a round that emitted
    // multiple ("Yielded back…", "@-mention: extra turn…", handoff 1/12, 2/12…)
    // produced several messages with the SAME id. Duplicate React keys +
    // collisions in the transcript's id-keyed measurement Map scrambled render
    // order (old status lines surfacing above newer messages) — exposed badly
    // once the virtualised transcript keys rows by message id. Append a
    // monotonic-ish suffix (matches the `${Date.now()}-${random}` idiom used
    // for tool rows / wakeups / round ids elsewhere in this file). The
    // `ensembleRoundId` metadata still carries the round association.
    const id = `ensemble-round-status-${roundId}-${this.deps.now()}-${this.nextStatusSeq()}`
    this.saveChatWithCheckpoint(
      {
        ...chat,
        messages: [
          ...chat.messages,
          {
            id,
            role: 'system',
            content,
            timestamp,
            metadata: {
              kind: 'ensembleRoundStatus',
              ensembleRoundId: roundId,
              ...(options.fanoutCategory
                ? {
                    ensembleFanoutWaveId: id,
                    ensembleFanoutCategory: options.fanoutCategory,
                    ensembleFanoutLabel: options.fanoutLabel || content.split(' · ', 1)[0]
                  }
                : {})
            }
          }
        ],
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
    return id
  }

  /**
   * 1.0.7 — monotonic counter to disambiguate status-message ids emitted within
   * the same `now()` tick (the unit-test harness uses a fixed clock, and two
   * statuses can land on the same millisecond in production). Guarantees a
   * unique id per `appendRoundStatus` call without relying on Math.random
   * (keeps ids deterministic-ish + greppable).
   */
  private statusSeqCounter = 0
  private nextStatusSeq(): number {
    this.statusSeqCounter += 1
    return this.statusSeqCounter
  }

  /**
   * 1.0.5-EW29 — Structured participant-health header.
   *
   * Replaces the pre-EW29 plain-text variant of `appendRoundStatus`
   * for the per-round health pre-flight summary. The transcript
   * renderer routes on `metadata.kind === 'ensembleParticipantHealth'`
   * to draw a chip-strip card (provider tints, status icons,
   * compact header) instead of the muted "System" text block.
   * The text variant is kept on `content` as a fallback for
   * anything that still reads `message.content` directly (logs,
   * exports, debugging).
   */
  private appendParticipantHealthCard(
    chatId: string,
    roundId: string,
    results: Array<{ participant: EnsembleParticipant; result: ParticipantProbeResult }>
  ): void {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return
    const timestamp = this.deps.nowIso()
    const entries = results.map(({ participant, result }) => {
      const presentation = resolveHealthEntryPresentation(
        participant.provider,
        participant.model,
        providerLabel(participant.provider)
      )
      return {
        participantId: participant.id,
        provider: participant.provider,
        // Carry the model so renderers can spoof the Ollama display brand
        // (e.g. Qwen → Alibaba) on the health chip, matching the transcript
        // header + @-mention chips.
        model: participant.model,
        // Frozen at stamp time — health cards are per-round records and must
        // not change when the live roster is edited for future rounds.
        displayProviderLabel: presentation.displayProviderLabel,
        displayHueClass: presentation.displayHueClass,
        role: (participant.role || 'Participant').trim(),
        status: result.reachable ? ('ok' as const) : ('unreachable' as const),
        reason: result.reachable ? undefined : result.reason,
        underlyingCode: result.reachable ? undefined : result.underlyingCode
      }
    })
    const okCount = entries.filter((e) => e.status === 'ok').length
    const totalCount = entries.length
    this.saveChatWithCheckpoint(
      {
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: `ensemble-participant-health-${roundId}`,
            role: 'system',
            // Keep the human-readable text on `content` as the
            // fallback / debug surface — same string the pre-EW29
            // path emitted, so existing logs / exports don't lose
            // information.
            content: formatParticipantHealthHeader(results),
            timestamp,
            metadata: {
              kind: 'ensembleParticipantHealth',
              ensembleRoundId: roundId,
              entries,
              okCount,
              totalCount
            }
          }
        ],
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
  }

  /**
   * Persist a participant's context-compaction card into the canonical
   * ensemble transcript. Idempotent via the deterministic message id
   * (provider event uuid, else runId+kind), so duplicate signals across
   * flush/replay lanes converge on one card. Presentation labels are FROZEN
   * at stamp time, matching the participant-health card contract.
   */
  private appendContextCompactionCard(
    run: ActiveParticipantRun,
    runId: string,
    signal: ContextCompactionSignal
  ): void {
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) return
    const participant = run.participant
    const messageId = contextCompactionMessageId(signal.telemetry, `${runId}-${signal.kind}`)
    if (chat.messages.some((message) => message.id === messageId)) return
    const presentation = resolveHealthEntryPresentation(
      participant.provider,
      participant.model,
      providerLabel(participant.provider)
    )
    const role = (participant.role || 'Participant').trim()
    const displayParticipantLabel = `${presentation.displayProviderLabel} / ${role}`
    this.saveChatWithCheckpoint(
      {
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: messageId,
            role: 'system',
            // Human-readable fallback for exports and the iOS system row.
            content: formatContextCompactionSummary(signal, displayParticipantLabel),
            timestamp: this.deps.nowIso(),
            metadata: {
              kind: CONTEXT_COMPACTION_MESSAGE_KIND,
              contextCompaction: { kind: signal.kind, telemetry: signal.telemetry },
              provider: participant.provider,
              ensembleParticipantId: participant.id,
              ensembleRoundId: run.roundId,
              // Frozen at stamp time — never recomputed from the live roster.
              displayParticipantLabel,
              displayHueClass: presentation.displayHueClass
            }
          }
        ],
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
  }

  /** Wave 3 — per-seat auto-compaction cooldown (attempts, success or not). */
  private seatAutoCompactLastAttemptAt = new Map<string, number>()

  private emitSeatCompactionProgress(
    chatId: string,
    participant: EnsembleParticipant,
    status: ContextCompactionProgressEvent['status'],
    trigger: ContextCompactionProgressEvent['trigger'] = 'auto'
  ): void {
    const emit = this.deps.onContextCompactionProgress
    if (!emit) return
    const presentation = resolveHealthEntryPresentation(
      participant.provider,
      participant.model,
      providerLabel(participant.provider)
    )
    const role = (participant.role || 'Participant').trim()
    emit({
      chatId,
      participantId: participant.id,
      provider: participant.provider,
      trigger,
      status,
      label: `${presentation.displayProviderLabel} / ${role}`,
      hueClass: presentation.displayHueClass
    })
  }

  /**
   * Await an in-flight host seat compaction for this participant, then refresh
   * the roster object's session/summary fields from the persisted chat — the
   * compaction may have cleared a provider seat's session id, and dispatching
   * with the stale one would resume the abandoned session.
   */
  private async awaitSeatCompactionBeforeDispatch(
    chatId: string,
    participant: EnsembleParticipant
  ): Promise<void> {
    const pending = this.deps.awaitPendingSeatCompaction?.(chatId, participant.id)
    if (pending) {
      this.emitSeatCompactionProgress(chatId, participant, 'started')
      let succeeded = true
      try {
        const result = await Promise.resolve(pending)
        if (
          result &&
          typeof result === 'object' &&
          'ok' in result &&
          (result as { ok?: unknown }).ok === false
        ) {
          succeeded = false
        }
      } catch {
        succeeded = false
      }
      this.emitSeatCompactionProgress(chatId, participant, succeeded ? 'completed' : 'failed')
      const refreshed = this.deps
        .getChat(chatId)
        ?.ensemble?.participants?.find((candidate) => candidate.id === participant.id)
      if (refreshed) {
        Object.assign(participant, persistedSeatRuntimeState(refreshed))
      }
    }
    await this.maybeAutoCompactSeatBeforeDispatch(chatId, participant)
  }

  private async maybeAutoCompactSeatBeforeDispatch(
    chatId: string,
    participant: EnsembleParticipant
  ): Promise<void> {
    const compactSeatContext = this.deps.compactSeatContext
    if (!compactSeatContext) return
    const request = this.buildAutoCompactSeatRequest(chatId, participant)
    if (!request) return
    this.emitSeatCompactionProgress(chatId, participant, 'started', request.trigger)
    try {
      const result = await compactSeatContext(request)
      this.emitSeatCompactionProgress(
        chatId,
        participant,
        result.ok === false ? 'failed' : 'completed',
        request.trigger
      )
    } catch {
      this.emitSeatCompactionProgress(chatId, participant, 'failed', request.trigger)
      return
    }
    const refreshed = this.deps
      .getChat(chatId)
      ?.ensemble?.participants?.find((candidate) => candidate.id === participant.id)
    if (refreshed) {
      Object.assign(participant, persistedSeatRuntimeState(refreshed))
    }
  }

  private maybeAutoCompactSeatAfterTurn(chatId: string, participantId: string): void {
    const compactSeatContext = this.deps.compactSeatContext
    if (!compactSeatContext) return
    const participant = this.deps
      .getChat(chatId)
      ?.ensemble?.participants?.find((candidate) => candidate.id === participantId)
    if (!participant) return
    const request = this.buildAutoCompactSeatRequest(chatId, participant)
    if (!request) return
    void compactSeatContext(request).catch(() => {
      // Best-effort maintenance; pre-dispatch compaction remains the safety net.
    })
  }

  private buildAutoCompactSeatRequest(
    chatId: string,
    participant: EnsembleParticipant
  ): {
    chatId: string
    participantId: string
    provider: HostSeatCompactionProvider
    trigger: 'auto'
  } | null {
    if (this.deps.getSettings().hostAutoCompactEnabled === false) return null
    if (!isHostSeatCompactionProvider(participant.provider)) return null
    if (participant.enabled === false) return null
    // Preserve fresh evidence while another summarize/reset is already in
    // flight. The dispatch barrier will await that work; a later settled check
    // can decide whether the new overflow still needs its own attempt.
    if (this.deps.awaitPendingSeatCompaction?.(chatId, participant.id)) return null
    const lastAttempt = this.seatAutoCompactLastAttemptAt.get(participant.id)
    if (
      lastAttempt !== undefined &&
      this.deps.now() - lastAttempt < CONTEXT_AUTO_COMPACT_COOLDOWN_MS
    ) {
      return null
    }
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return null
    const evidenceKey = seatOverflowEvidenceKey(chatId, participant.id)
    const overflowEvidence = this.pendingSeatOverflowEvidence.get(evidenceKey)
    const currentSeatFingerprint = {
      provider: participant.provider,
      model: participant.model || '',
      linkedProviderSessionId: participant.linkedProviderSessionId || null
    }
    if (
      overflowEvidence &&
      (overflowEvidence.provider !== currentSeatFingerprint.provider ||
        overflowEvidence.model !== currentSeatFingerprint.model ||
        overflowEvidence.linkedProviderSessionId !== currentSeatFingerprint.linkedProviderSessionId)
    ) {
      // Provider/model/session relinks replace the context that produced the
      // failure. Drop stale evidence fail-open rather than compacting the new
      // seat merely because it reuses the participant id.
      this.pendingSeatOverflowEvidence.delete(evidenceKey)
    } else if (
      overflowEvidence &&
      shouldAutoCompactHostContext(participant.provider, {
        kind: 'classified_context_overflow'
      })
    ) {
      // Consume on acceptance, before invoking the async maintenance lane.
      // Repeated stderr/result/exit observations therefore collapse to one
      // attempt, and the cooldown contains a failed summarize turn.
      this.pendingSeatOverflowEvidence.delete(evidenceKey)
      this.seatAutoCompactLastAttemptAt.set(participant.id, this.deps.now())
      return {
        chatId,
        participantId: participant.id,
        provider: participant.provider,
        trigger: 'auto'
      }
    }
    if (isProductionKimiAcpSeat(participant)) {
      // Kimi ACP now owns live occupancy. Without provider-semantic token
      // telemetry, compact only after a classified overflow (handled above),
      // never from the host transcript projection.
      return null
    }
    if (participant.provider === 'kimi') {
      const messageIds = findUncoveredEnsemblePromptMessageIds({
        chat,
        config: chat.ensemble,
        participant,
        chatContextTurns: this.deps.getSettings().chatContextTurns,
        ...(isEnsembleRoundDispatchLive(chat.ensemble.activeRound) && chat.ensemble.activeRound
          ? { excludeEnsembleRoundPromptRoundId: chat.ensemble.activeRound.roundId }
          : {})
      })
      if (
        !shouldAutoCompactHostContext('kimi', {
          kind: 'prompt_projection_uncovered',
          messageIds
        })
      ) {
        return null
      }
      this.seatAutoCompactLastAttemptAt.set(participant.id, this.deps.now())
      return {
        chatId,
        participantId: participant.id,
        provider: 'kimi',
        trigger: 'auto'
      }
    }
    const usage = latestRunContextUsage(chat.runs ?? [], participant.id)
    const windowTokens = resolveContextWindow(
      participant.provider,
      participant.model,
      usage.totalTokenLimit
    )
    const percent = contextPercent(usage.tokens, windowTokens)
    // Latest run input+output is processed usage, not provider-semantic live
    // occupancy. Keep it available for diagnostics, but never let it reset a
    // Cursor/Grok session on its own. Kimi's separate prompt-projection
    // evidence above is row-specific and refreshes only its durable summary.
    if (
      !shouldAutoCompactHostContext(participant.provider, {
        kind: 'generic_run_usage',
        percent
      })
    ) {
      return null
    }
    this.seatAutoCompactLastAttemptAt.set(participant.id, this.deps.now())
    return {
      chatId,
      participantId: participant.id,
      provider: participant.provider,
      trigger: 'auto'
    }
  }

  /**
   * Wave 3 — post-round host auto-compaction for Grok and legacy Kimi seats.
   * Native Kimi ACP compacts only on a classified overflow or a manual
   * request because its live occupancy is provider-owned. Runs in idle time after a
   * COMPLETED round: deferred a tick so a chained queued round is visible.
   * Kimi may refresh its non-destructive durable summary when exact transcript
   * projection proves rows fell outside the live prompt window. Generic run
   * usage remains advisory and cannot reset Grok sessions.
   * Fire-and-forget —
   * the maintenance lane cards success/failure itself, and the dispatch-wait
   * above protects any round that starts mid-compaction.
   */
  private maybeAutoCompactSeatsAfterRound(
    chatId: string,
    status: Extract<EnsembleRoundState['status'], 'completed' | 'cancelled' | 'failed'>
  ): void {
    if (status !== 'completed') return
    const compactSeatContext = this.deps.compactSeatContext
    if (!compactSeatContext) return
    if (this.deps.getSettings().hostAutoCompactEnabled === false) return
    setTimeout(() => {
      try {
        if (this.deps.getSettings().hostAutoCompactEnabled === false) return
        const chat = this.deps.getChat(chatId)
        if (!chat?.ensemble) return
        if (this.roundsByChatId.has(chatId)) return
        if (isEnsembleRoundDispatchLive(chat.ensemble.activeRound)) return
        let worst: { participant: EnsembleParticipant; rank: number } | null = null
        for (const participant of chat.ensemble.participants || []) {
          if (participant.enabled === false) continue
          if (!isHostSeatCompactionProvider(participant.provider)) continue
          if (isProductionKimiAcpSeat(participant)) {
            continue
          }
          // Cooldown applies only to a seat we've ALREADY attempted — a
          // genuinely-new seat (no recorded attempt) is never held back. Using
          // `|| 0` here would conflate "never attempted" with "attempted at
          // t=0", falsely cooling a fresh seat within COOLDOWN of the epoch.
          const lastAttempt = this.seatAutoCompactLastAttemptAt.get(participant.id)
          if (
            lastAttempt !== undefined &&
            this.deps.now() - lastAttempt < CONTEXT_AUTO_COMPACT_COOLDOWN_MS
          ) {
            continue
          }
          let rank: number
          if (participant.provider === 'kimi') {
            const messageIds = findUncoveredEnsemblePromptMessageIds({
              chat,
              config: chat.ensemble,
              participant,
              chatContextTurns: this.deps.getSettings().chatContextTurns
            })
            if (
              !shouldAutoCompactHostContext('kimi', {
                kind: 'prompt_projection_uncovered',
                messageIds
              })
            ) {
              continue
            }
            rank = messageIds.length
          } else {
            const usage = latestRunContextUsage(chat.runs ?? [], participant.id)
            const windowTokens = resolveContextWindow(
              participant.provider,
              participant.model,
              usage.totalTokenLimit
            )
            const percent = contextPercent(usage.tokens, windowTokens)
            if (
              !shouldAutoCompactHostContext(participant.provider, {
                kind: 'generic_run_usage',
                percent
              })
            ) {
              continue
            }
            rank = percent
          }
          if (!worst || rank > worst.rank) worst = { participant, rank }
        }
        if (!worst) return
        this.seatAutoCompactLastAttemptAt.set(worst.participant.id, this.deps.now())
        void compactSeatContext({
          chatId,
          participantId: worst.participant.id,
          provider: worst.participant.provider as HostSeatCompactionProvider,
          trigger: 'auto'
        }).catch(() => {
          // Best-effort: the lane cards its own failures; cooldown holds.
        })
      } catch {
        // Best-effort maintenance — never let it disturb round bookkeeping.
      }
    }, 250)
  }

  private clearRuntimeIfCurrent(runtime: ActiveRoundRuntime): void {
    if (this.roundsByChatId.get(runtime.chatId)?.roundId === runtime.roundId) {
      this.roundsByChatId.delete(runtime.chatId)
    }
    // Teardown hygiene: a runtime leaving the registry must not leave a
    // deferred drain behind (identity-checked so a successor round's
    // deferral is never swept by a stale teardown).
    if (this.deferredLaneDrainByChatId.get(runtime.chatId) === runtime) {
      this.deferredLaneDrainByChatId.delete(runtime.chatId)
    }
    this.chatFlushScheduler.cancelChat(runtime.chatId)
  }

  private resolveFanoutEligibilityPermissions(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    _mode: EnsembleFanoutMode
  ): EffectiveRunPermissions {
    return this.resolveParticipantPermissions(
      chat,
      participant,
      runtime.externalPathGrants,
      isBackgroundParticipant(participant) ? { disallowTrustedSession: true } : {}
    )
  }

  /** ensemble_fanout_all dispatch posture: the participant's OWN normal-turn
   * permissions, exactly as a serial rotation turn would resolve them — no
   * read-only clamp, no eligibility filtering. All safety clamps inside
   * resolveParticipantPermissions (unattended-round HMAC clamp) still
   * apply; background seats still never inherit Full Access. */
  private resolveFanoutOwnDispatchPermissions(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant
  ): EffectiveRunPermissions {
    return this.resolveParticipantPermissions(
      chat,
      participant,
      runtime.externalPathGrants,
      isBackgroundParticipant(participant) ? { disallowTrustedSession: true } : {}
    )
  }

  private resolveFanoutDispatchPermissions(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    mode: EnsembleFanoutMode,
    explicitExternalPathGrants: ExternalPathGrant[] = runtime.externalPathGrants || []
  ): EffectiveRunPermissions {
    return this.resolveParticipantPermissions(
      chat,
      participant,
      explicitExternalPathGrants,
      mode === 'read_only'
        ? {
            presetId: 'read_only',
            ignoreOverrides: true,
            disallowTrustedSession: true
          }
        : isBackgroundParticipant(participant)
          ? { disallowTrustedSession: true }
          : {}
    )
  }

  private updateChatRound(
    chatId: string,
    update: (round: EnsembleRoundState | undefined) => EnsembleRoundState | undefined
  ): void {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return
    const activeRound = update(chat.ensemble.activeRound)
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          ...(activeRound ? { activeRound } : {}),
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'round-updated'
    )
  }

  /**
   * Per-seat Project reference Use-next appendix. Catalogue for every seat;
   * consentful extract bodies only for non-BG seats. Fail soft on stale
   * selection so a deleted Project cannot kill seat dispatch.
   */
  private buildProjectReferenceAppendixForSeat(
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    permissions: EffectiveRunPermissions,
    workspacePath?: string
  ): string {
    const selection = runtime.projectReferenceContextSelection
    if (!selection || !this.deps.listProjects || !this.deps.listProjectReferences) return ''
    try {
      const context = resolveProjectReferenceContext({
        selection,
        chatId: runtime.chatId,
        provider: participant.provider,
        workspacePath,
        projects: this.deps.listProjects(),
        references: this.deps.listProjectReferences(),
        externalPathGrants: permissions.externalPathGrants,
        ...(this.deps.projectReferenceExtractLoader
          ? { extractLoader: this.deps.projectReferenceExtractLoader }
          : {})
      })
      const catalogue = formatEnsembleProjectReferenceAppendix({
        context,
        backgroundLane: isBackgroundParticipant(participant)
      })
      if (isBackgroundParticipant(participant)) return catalogue
      return `${catalogue}${formatProjectReferenceExtractsPromptAppendix(context, {
        readExtractText: (id) =>
          this.deps.projectReferenceExtractLoader?.readExtractText(id) ?? null
      })}`
    } catch {
      return ''
    }
  }

  private resolveParticipantPermissions(
    chat: ChatRecord,
    participant: EnsembleParticipant,
    explicitExternalPathGrants?: ExternalPathGrant[],
    options: {
      ignoreOverrides?: boolean
      presetId?: string | null
      ensembleLaneId?: string | null
      disallowTrustedSession?: boolean
    } = {}
  ): EffectiveRunPermissions {
    // P1b — unattended (scheduled/workflow) ensemble clamp. A scheduled
    // ensemble round runs with no human at the keyboard, so a
    // write-capable participant preset (or a workspace-write session
    // override) would silently auto-accept edits. Force the safe
    // read-only posture for EVERY participant of an unattended round,
    // regardless of preset / overrides. This is
    // the single chokepoint for both the serial writer and every
    // fan-out lane, and the read_only preset resolves to approvalMode
    // 'plan' + readOnly:true, so both signing sites sign the safe
    // posture automatically.
    const round = this.roundsByChatId.get(chat.appChatId)
    const roundUnattended = round?.unattended === true
    if (roundUnattended) {
      // P2 — a VERIFIED elevation lifts the uniform posture from read-only to the
      // level's preset (full_access → workspace_write, default → default). No
      // verified elevation ⇒ P1b plan (no-ask floor). The level was HMAC-verified main-side
      // before reaching the runtime, so it's a trusted capability here; the preset
      // still flows through resolveEffectiveRunPermissions (approval gates intact).
      const previewRiskModel = isPreviewRiskModel(participant.provider, participant.model)
      const elevatedPreset =
        round?.unattendedElevationLevel && !previewRiskModel
          ? unattendedElevationPresetId(round.unattendedElevationLevel)
          : undefined
      // Fork 4B: Simulator Canvas is NOT hard-denied with subThreadDelegation —
      // applyUnattendedSimulatorCanvasOverride keeps plan-floor ask and demotes
      // elevated Accept Edits / Full WS allow unless an explicit grant exists.
      return applyUnattendedSimulatorCanvasOverride(
        resolveEffectiveRunPermissions({
          provider: participant.provider,
          workspacePath: chat.scope === 'global' ? undefined : chat.workspacePath,
          model: participant.model,
          settings: this.deps.getSettings(),
          // Posture inversion (2026-08-04): the unattended fallback is the plan
          // NO-ASK floor — read_only (Ask) would raise approval modals nobody is
          // attending (they die by timeout as denials anyway, noisily).
          presetId: elevatedPreset || 'plan',
          // Force-deny network egress in EVERY unattended posture (plan/read
          // presets carry networkAccess 'allow' for attended web reads, and
          // workspace_write/default fall to the settings default 'allow').
          // Also deny sub-thread delegation so unattended Plan/elevation cannot
          // modal-ask or silently spawn children.
          overrides: {
            networkAccess: 'deny',
            ...unattendedSubThreadDelegationOverride()
          }
          // Deliberately drop explicitExternalPathGrants either way: an unattended
          // round must not widen file access via composer-supplied grants.
        })
      )
    }
    const requestedPresetId = options.presetId || participant.permissionPresetId
    const trustedSessionGranted =
      options.disallowTrustedSession !== true &&
      requestedPresetId === 'full_access' &&
      this.deps.isTrustedSessionGranted?.({
        chatId: chat.appChatId,
        provider: participant.provider,
        workspacePath: chat.scope === 'global' ? undefined : chat.workspacePath,
        ensembleParticipantId: participant.id,
        ensembleLaneId: options.ensembleLaneId,
        runtimeProfileId: participant.runtimeProfileId
      }) === true
    const presetId =
      requestedPresetId === 'full_access' && !trustedSessionGranted
        ? 'workspace_write'
        : requestedPresetId
    return resolveEffectiveRunPermissions({
      provider: participant.provider,
      workspacePath: chat.scope === 'global' ? undefined : chat.workspacePath,
      model: participant.model,
      settings: this.deps.getSettings(),
      presetId,
      overrides: options.ignoreOverrides ? null : participant.permissionOverrides || null,
      // 1.0.4-AT4 — composer-level grants merge in here. The
      // resolver dedupes across (`explicit` ∪ `overrides.externalPathGrants`)
      // and provider-filters before returning, so each
      // participant only sees grants tagged for its own provider.
      ...(explicitExternalPathGrants && explicitExternalPathGrants.length > 0
        ? { explicitExternalPathGrants }
        : {})
    })
  }
}

function ensembleRunIdentity(
  roundId: string,
  participant: EnsembleParticipant,
  laneId?: string,
  config?: EnsembleConfig,
  contextTurns?: number,
  promptMode?: EnsembleRunIdentity['promptMode']
): EnsembleRunIdentity {
  const ollamaContextBudget =
    participant.provider === 'ollama'
      ? {
          ...(typeof config?.ensembleContextChars === 'number'
            ? { ensembleContextChars: config.ensembleContextChars }
            : {}),
          ...(typeof contextTurns === 'number' ? { ensembleContextTurns: contextTurns } : {})
        }
      : {}
  return {
    roundId,
    participantId: participant.id,
    ...(promptMode ? { promptMode } : {}),
    ...(laneId ? { laneId } : {}),
    provider: participant.provider,
    role: participant.role,
    ...(participant.stageRole ? { stageRole: participant.stageRole } : {}),
    order: participant.order,
    ...ollamaContextBudget
  }
}

/**
 * Companion fields to `ensembleModel` on the assistant message metadata
 * so the transcript header can append a reasoning suffix that mirrors
 * what the user picked in the composer chip
 * (`reasoningDisplayLabel` in `composerChipFormat.ts`).
 *
 * Only the field that applies to this participant's provider is set:
 *   codex / claude  → `ensembleReasoningEffort` (token: low/medium/high/xhigh/off)
 *   kimi            → `ensembleThinkingEnabled` (boolean)
 *   gemini          → nothing (no reasoning axis)
 *
 * Returning an object that gets spread keeps the call-sites compact and
 * avoids stamping `undefined` keys onto the metadata when the field
 * doesn't apply.
 */
function ensembleReasoningMetadata(participant: EnsembleParticipant): Record<string, unknown> {
  if (
    participant.provider === 'codex' ||
    participant.provider === 'claude' ||
    (participant.provider === 'grok' && isGrok45ReasoningModelId(participant.model)) ||
    (participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model))
  ) {
    return participant.reasoningEffort
      ? { ensembleReasoningEffort: participant.reasoningEffort }
      : {}
  }
  if (participant.provider === 'kimi') {
    return { ensembleThinkingEnabled: Boolean(participant.thinkingEnabled) }
  }
  return {}
}

function pooledAgentTranscriptMetadata(participant: EnsembleParticipant): Record<string, unknown> {
  const snapshot = participant.pooledAgentIdentity
  const fallbackAgentId =
    typeof participant.pooledAgentId === 'string' && participant.pooledAgentId.trim()
      ? participant.pooledAgentId.trim()
      : ''
  if (!snapshot || typeof snapshot !== 'object') {
    return fallbackAgentId ? { pooledAgentId: fallbackAgentId } : {}
  }
  const agentId =
    fallbackAgentId ||
    (typeof snapshot.agentId === 'string' && snapshot.agentId.trim() ? snapshot.agentId.trim() : '')
  const nickname =
    typeof snapshot.nickname === 'string' && snapshot.nickname.trim()
      ? snapshot.nickname.trim()
      : ''
  const hue = Number(snapshot.hue)
  const iconKind = snapshot.iconKind
  if (
    !agentId ||
    !nickname ||
    !Number.isFinite(hue) ||
    (iconKind !== 'named' && iconKind !== 'seed' && iconKind !== 'asset')
  ) {
    return fallbackAgentId ? { pooledAgentId: fallbackAgentId } : {}
  }
  const pooledAgentIdentity: PooledAgentIdentitySnapshot = {
    schemaVersion: 1,
    agentId,
    nickname,
    iconKind,
    hue: ((Math.round(hue) % 360) + 360) % 360,
    ...(Number.isFinite(Number(snapshot.saturation))
      ? {
          saturation: Math.max(0, Math.min(100, Math.round(Number(snapshot.saturation))))
        }
      : {}),
    ...(Number.isFinite(Number(snapshot.brightness))
      ? {
          brightness: Math.max(0, Math.min(100, Math.round(Number(snapshot.brightness))))
        }
      : {}),
    ...(typeof snapshot.accent === 'string' && snapshot.accent ? { accent: snapshot.accent } : {}),
    ...(typeof snapshot.slug === 'string' && snapshot.slug ? { slug: snapshot.slug } : {}),
    ...(typeof snapshot.assetKey === 'string' && snapshot.assetKey
      ? { assetKey: snapshot.assetKey }
      : {}),
    ...(typeof snapshot.seed === 'string' && snapshot.seed ? { seed: snapshot.seed } : {}),
    ...(typeof snapshot.hueEnabled === 'boolean' ? { hueEnabled: snapshot.hueEnabled } : {})
  }
  return { pooledAgentId: agentId, pooledAgentIdentity }
}

function isPooledAgentRegistrationReceipt(input: {
  pooledAgentId: string
  pooledAgentIdentity: PooledAgentIdentitySnapshot
  mode: 'created' | 'coalesced' | 'updated'
}): boolean {
  const identity = input.pooledAgentIdentity
  return (
    typeof input.pooledAgentId === 'string' &&
    input.pooledAgentId.startsWith('pooled-agent-') &&
    input.pooledAgentId.length > 'pooled-agent-'.length &&
    identity?.schemaVersion === 1 &&
    identity.agentId === input.pooledAgentId &&
    typeof identity.nickname === 'string' &&
    Boolean(identity.nickname.trim()) &&
    (identity.iconKind === 'named' ||
      identity.iconKind === 'seed' ||
      identity.iconKind === 'asset') &&
    typeof identity.hue === 'number' &&
    Number.isFinite(identity.hue)
  )
}

function ensembleOllamaRunControls(participant: EnsembleParticipant): Partial<AgentRunPayload> {
  if (participant.provider !== 'ollama') return {}
  return {
    ...(participant.ollamaRunProfile ? { ollamaRunProfile: participant.ollamaRunProfile } : {})
  }
}

function updateRoundParticipant(
  round: EnsembleRoundState | undefined,
  participantId: string,
  partial: Partial<EnsembleRoundState['participants'][number]>,
  options: { setActive?: boolean } = {}
): EnsembleRoundState | undefined {
  if (!round) return round
  const setActive = options.setActive !== false
  return {
    ...round,
    activeParticipantId:
      setActive && partial.status === 'running'
        ? participantId
        : round.activeParticipantId === participantId
          ? undefined
          : round.activeParticipantId,
    participants: round.participants.map((participant) =>
      participant.participantId === participantId ? { ...participant, ...partial } : participant
    )
  }
}

function addLaneToRound(
  round: EnsembleRoundState | undefined,
  lane: ConcurrentLane | undefined
): EnsembleRoundState | undefined {
  if (!round || !lane) return round
  return {
    ...round,
    concurrentMode: true,
    lanes: {
      ...(round.lanes || {}),
      [lane.laneId]: lane
    }
  }
}

function updateLaneInRound(
  round: EnsembleRoundState | undefined,
  laneId: string | undefined,
  participantStatus: EnsembleParticipantStatus,
  nowIso: string,
  reason?: string
): EnsembleRoundState | undefined {
  if (!round || !laneId || !round.lanes?.[laneId]) return round
  const laneStatus: ConcurrentLane['status'] =
    participantStatus === 'answered' ||
    participantStatus === 'yielded' ||
    participantStatus === 'sleeping'
      ? 'completed'
      : participantStatus === 'skipped'
        ? 'completed'
        : participantStatus === 'unreachable'
          ? 'failed'
          : participantStatus === 'idle'
            ? 'pending'
            : participantStatus
  return {
    ...round,
    lanes: {
      ...round.lanes,
      [laneId]: transitionLane(round.lanes[laneId], {
        status: laneStatus,
        reason,
        nowIso
      })
    }
  }
}

function probeErrorToResult(err: unknown): ParticipantProbeResult {
  const message = err instanceof Error ? err.message : String(err)
  const code =
    typeof (err as { code?: unknown })?.code === 'string'
      ? ((err as { code?: string }).code as string)
      : undefined
  return {
    reachable: false,
    reason: message,
    ...(code ? { underlyingCode: code } : {})
  }
}

function formatParticipantHealthHeader(
  results: Array<{ participant: EnsembleParticipant; result: ParticipantProbeResult }>
): string {
  const lines = results.map(({ participant, result }) => {
    const presentation = resolveHealthEntryPresentation(
      participant.provider,
      participant.model,
      providerLabel(participant.provider)
    )
    const who = `${presentation.displayProviderLabel} / ${participant.role || 'Participant'}`
    if (result.reachable) return `  ${who}: ok`
    const reason = result.reason || `${participant.provider} runtime not reachable`
    const code = result.underlyingCode ? ` (${result.underlyingCode})` : ''
    return `  ${who}: unreachable${code} - ${reason}`
  })
  return `${PARTICIPANT_HEALTH_TAG}\n${lines.join('\n')}`
}

/**
 * 1.0.5-N4 — Maximum wakeup delay. Node's `setTimeout` silently
 * clamps delays > 2³¹−1 ms (~24.86 days) to 1ms, which would make
 * a far-future wakeup fire IMMEDIATELY instead of at the requested
 * time. We cap at 7 days here — generous enough for any plausible
 * long-running task, and forces agents to be explicit about
 * longer horizons via sequential wakeups (schedule one, work, on
 * resume schedule another) rather than passing 30+ days as a
 * single delay and getting bitten by the Node clamp.
 */
export const MAX_WAKEUP_DELAY_MS = 7 * 24 * 60 * 60 * 1000

function resolveWakeAtMs(input: ScheduleWakeupInput, nowMs: number): number {
  const delayMs =
    typeof input.delayMs === 'number' && Number.isFinite(input.delayMs)
      ? input.delayMs
      : typeof input.delaySeconds === 'number' && Number.isFinite(input.delaySeconds)
        ? input.delaySeconds * 1000
        : undefined
  if (delayMs !== undefined) return nowMs + Math.max(0, delayMs)
  if (input.wakeAt) {
    const parsed = new Date(input.wakeAt).getTime()
    return Number.isFinite(parsed) ? parsed : Number.NaN
  }
  return Number.NaN
}

function formatWakeupScheduledReason(wakeup: EnsembleWakeupRecord): string {
  const reason = wakeup.reason ? ` Reason: ${wakeup.reason}` : ''
  return `[wakeup:${wakeup.wakeupId} until ${wakeup.wakeAt}]${reason}`
}

function formatWakeupResumePrompt(prompt: string, wakeup: EnsembleWakeupRecord): string {
  const reason = wakeup.reason ? `\nWake reason: ${wakeup.reason}` : ''
  return `${prompt}\n\n[Scheduled wakeup]\nWakeup id: ${wakeup.wakeupId}\nScheduled at: ${wakeup.scheduledAt}\nWoke at: ${wakeup.firedAt || new Date().toISOString()}${reason}\nContinue this same Ensemble round from where you intentionally slept.`
}

function extractWakeupIdFromReason(reason: string): string | undefined {
  return /\[wakeup:([^\s\]]+)/.exec(reason)?.[1]
}

function extractWakeAtFromReason(reason: string): string | undefined {
  return /\[wakeup:[^\]]+ until ([^\]]+)\]/.exec(reason)?.[1]
}

function statusToRunStatus(status: EnsembleParticipantStatus): string {
  if (status === 'answered' || status === 'yielded' || status === 'skipped') return 'success'
  if (status === 'sleeping') return 'sleeping'
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

function statusToRunQueueJobStatus(
  status: EnsembleParticipantStatus
): RunQueueJobStatus | undefined {
  if (status === 'answered' || status === 'yielded' || status === 'sleeping') {
    return 'completed'
  }
  if (status === 'skipped' || status === 'cancelled') return 'cancelled'
  if (status === 'failed' || status === 'unreachable') return 'failed'
  return undefined
}

function mergeTokenTotals(existing: EnsembleParticipant['tokenTotals'], stats: any) {
  if (!stats || typeof stats !== 'object') return existing
  const next = { ...(existing || {}) }
  const read = (snake: keyof NonNullable<EnsembleParticipant['tokenTotals']>, camel: string) => {
    const value = Number(stats[snake] ?? stats[camel])
    return Number.isFinite(value) && value > 0 ? value : 0
  }
  for (const [snake, camel] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
    ['duration_ms', 'durationMs']
  ] as const) {
    const value = read(snake, camel)
    if (value > 0) next[snake] = (next[snake] || 0) + value
  }
  return Object.keys(next).length > 0 ? next : existing
}

function extractProviderSessionId(payload: any): string | undefined {
  const raw =
    payload?.providerThreadId ??
    payload?.providerSessionId ??
    payload?.session_id ??
    payload?.sessionId ??
    payload?.thread_id ??
    payload?.threadId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function resolveEnsembleOrchestrationMode(
  config: Pick<EnsembleConfig, 'orchestrationMode'> | null | undefined
): EnsembleOrchestrationMode {
  return config?.orchestrationMode === 'continuous' ? 'continuous' : 'turn_bound'
}

function resolveMaxContinuationHops(
  config: Pick<EnsembleConfig, 'maxContinuationHops'> | null | undefined
): number {
  const raw = Number(config?.maxContinuationHops)
  if (!Number.isFinite(raw)) return DEFAULT_CONTINUATION_HOP_LIMIT
  return Math.max(1, Math.min(MAX_CONTINUATION_HOP_LIMIT, Math.floor(raw)))
}

function normalizeEnsembleImageAttachments(
  attachments: EnsembleImageAttachment[] | undefined
): EnsembleImageAttachment[] {
  if (!Array.isArray(attachments)) return []
  const seen = new Set<string>()
  const normalized: EnsembleImageAttachment[] = []
  for (const attachment of attachments) {
    const path = typeof attachment?.path === 'string' ? attachment.path.trim() : ''
    if (!path || seen.has(path)) continue
    seen.add(path)
    normalized.push({
      ...(typeof attachment.id === 'string' && attachment.id.trim()
        ? { id: attachment.id.trim() }
        : {}),
      path,
      ...(typeof attachment.name === 'string' && attachment.name.trim()
        ? { name: attachment.name.trim() }
        : {})
    })
  }
  return normalized
}

function isEnsembleImageAttachment(attachment: EnsembleImageAttachment): boolean {
  return ENSEMBLE_IMAGE_ATTACHMENT_EXT.test(attachment.path)
}

function imagePathsForEnsembleAttachments(attachments: EnsembleImageAttachment[]): string[] {
  return normalizeEnsembleImageAttachments(attachments)
    .filter(isEnsembleImageAttachment)
    .map((attachment) => attachment.path)
}

function normalizeEnsembleImageThumbnails(
  thumbnails: EnsembleImageThumbnail[] | undefined
): EnsembleImageThumbnail[] {
  if (!Array.isArray(thumbnails)) return []
  const normalized: EnsembleImageThumbnail[] = []
  for (const thumbnail of thumbnails) {
    if (!thumbnail || typeof thumbnail !== 'object') continue
    const dataBase64 = typeof thumbnail.dataBase64 === 'string' ? thumbnail.dataBase64.trim() : ''
    if (!dataBase64) continue
    normalized.push({
      dataBase64,
      mimeType:
        typeof thumbnail.mimeType === 'string' && thumbnail.mimeType.trim()
          ? thumbnail.mimeType.trim()
          : 'image/jpeg',
      ...(typeof thumbnail.width === 'number' && Number.isFinite(thumbnail.width)
        ? { width: thumbnail.width }
        : {}),
      ...(typeof thumbnail.height === 'number' && Number.isFinite(thumbnail.height)
        ? { height: thumbnail.height }
        : {})
    })
  }
  return normalized
}

function promptWithAttachmentReferences(
  prompt: string,
  attachments: EnsembleImageAttachment[]
): string {
  const normalized = normalizeEnsembleImageAttachments(attachments)
  if (normalized.length === 0) return prompt
  const lines = normalized.map(
    (attachment, index) =>
      `${index + 1}. ${attachment.name ? `${attachment.name}: ` : ''}"${attachment.path}"`
  )
  return `${prompt}\n\nAttachment references for this request:\n${lines.join('\n')}`
}

function externalPathGrantPromptAppendix(grants: ExternalPathGrant[] | undefined): string {
  if (!Array.isArray(grants) || grants.length === 0) return ''
  const lines = grants
    .filter((grant) => typeof grant?.path === 'string' && grant.path.trim())
    .map((grant, index) => {
      const access = grant.access === 'write' ? 'view and edit' : 'view'
      const kind = grant.kind === 'directory' ? 'directory' : 'file'
      return `${index + 1}. ${access} ${kind}: "${grant.path.trim().replace(/"/g, '\\"')}"`
    })
  if (lines.length === 0) return ''
  return `\n\nUser-approved additional workspace access for this participant turn:\n${lines.join('\n')}\nUse only these paths outside the primary workspace.`
}

function numericRunStat(
  stats: Record<string, unknown>,
  ...paths: Array<string | string[]>
): number {
  for (const path of paths) {
    const keys = Array.isArray(path) ? path : [path]
    let cursor: unknown = stats
    let found = true
    for (const key of keys) {
      if (!cursor || typeof cursor !== 'object' || !(key in cursor)) {
        found = false
        break
      }
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (!found) continue
    const value = cursor
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value))
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return Math.max(0, Math.trunc(parsed))
    }
  }
  return 0
}

/**
 * Ensemble participants each run in their own model window. The useful current
 * context proxy is the latest run for that participant, not the cumulative sum
 * across every run, because each turn resends the accumulated transcript.
 */
function latestRunContextUsage(
  runs: ReadonlyArray<ChatRun>,
  participantId: string
): { tokens: number; totalTokenLimit?: number } {
  let bestTime = Number.NEGATIVE_INFINITY
  let best: { tokens: number; totalTokenLimit?: number } = { tokens: 0 }
  for (const run of runs) {
    if (run.ensembleParticipantId !== participantId) continue
    const stats = (run.stats ?? {}) as Record<string, unknown>
    const input = numericRunStat(stats, 'input_tokens', 'inputTokens')
    const output = numericRunStat(stats, 'output_tokens', 'outputTokens')
    const total = numericRunStat(stats, 'total_tokens', 'totalTokens')
    const tokens = Math.max(total, input + output)
    if (tokens <= 0) continue
    const totalTokenLimit = numericRunStat(
      stats,
      'totalTokenLimit',
      'totalTokensLimit',
      'total_tokens_limit',
      'total_limit_tokens',
      'modelContextWindow',
      ['tokenLimits', 'total'],
      ['token_limits', 'total'],
      ['usageLimits', 'total_tokens'],
      ['limits', 'total_tokens']
    )
    const parsed = Date.parse(run.startedAt || '')
    const time = Number.isFinite(parsed) ? parsed : 0
    if (time >= bestTime) {
      bestTime = time
      best = {
        tokens,
        ...(totalTokenLimit > 0 ? { totalTokenLimit } : {})
      }
    }
  }
  return best
}

/**
 * Slice C extension (1.0.3) — resolve a free-form yield `target`
 * string (as passed to `ensemble_yield`) against the round's remaining
 * participants. Returns the index of the first match, or -1 if no
 * remaining participant matches. Tries (in order):
 *   1. exact participant.id ('ensemble-codex')
 *   2. case-insensitive provider name ('codex')
 *   3. case-insensitive role ('Worker')
 *   4. canonical mention aliases, including model-name aliases
 *      ('Sonnet 4.7', 'GPT 5.5', 'Flash Lite')
 *
 * Only consults the `remaining` array — yielding to a participant
 * who has already spoken in this round is a no-op (the round won't
 * loop back through this helper). Continuous-mode loop-back is handled
 * separately after the remaining-queue lookup fails. Whitespace +
 * 'me' / 'self' targets are rejected so a model that mis-fills the
 * field doesn't recurse onto itself.
 */
/**
 * 1.0.4-AF — strip a leading `/discuss` (alias `/meta`) token from
 * the user-supplied ensemble prompt. Only matches when the token is
 * the first non-whitespace word; a `/discuss` later in the prompt is
 * passed through verbatim so users can still quote the command.
 * Returns the cleaned prompt and a `selfReflective` flag the
 * orchestrator threads onto the runtime.
 */
export function parseSelfReflectivePrefix(input: string): {
  prompt: string
  selfReflective: boolean
} {
  const match = input.match(/^[ \t]*\/(discuss|meta)\b[ \t]*/i)
  if (!match) return { prompt: input, selfReflective: false }
  return { prompt: input.slice(match[0].length), selfReflective: true }
}

export function resolveYieldTargetIndex(remaining: EnsembleParticipant[], target: string): number {
  const trimmed = stripLeadingAt(target || '')
  if (!trimmed) return -1
  const lc = trimmed.toLowerCase()
  if (lc === 'me' || lc === 'self' || lc === 'user' || lc === 'human') return -1
  const byId = remaining.findIndex((p) => p.id === trimmed)
  if (byId !== -1) return byId
  const byAlias = resolvePhraseToParticipant(trimmed, remaining)
  if (byAlias) {
    return remaining.findIndex((p) => p.id === byAlias.id)
  }
  return -1
}

/**
 * Scan a participant's emitted content for `@Token` mentions.
 * Returns the first matched phrase (without the `@`) so the caller
 * can resolve against the ensemble's participant list.
 *
 * NOTE: legacy export kept so older tests + any plugin code that
 * imports it stays working. The runtime call path (`runRound`'s
 * auto-promotion) now uses `findFirstMention` directly so it can
 * resolve multi-word model aliases (`@GPT 5.5`, `@Sonnet 4.7`,
 * `@Flash Lite`, `@Kimi K2.7 Coding`) without losing the trailing words.
 *
 * Pattern mirrors the renderer-side composer overlay tokeniser via
 * the shared `EnsembleMentionAlias` module so coverage stays aligned:
 * word boundary before `@`, letter-led identifier, max 33 chars per
 * chunk, up to 4 chunks total. The boundary check skips email-style
 * tokens like `chris@example.com` (the `@` there is preceded by a
 * letter, not a boundary char).
 */
export function extractFirstAtMentionTarget(content: string): string | null {
  if (!content || !content.includes('@')) return null
  const re =
    /(^|[\s([{<>"'`!?,;:.])@([A-Za-z][A-Za-z0-9._-]{0,32}(?:\s+[A-Za-z0-9][A-Za-z0-9._-]{0,32}){0,3})/g
  const match = re.exec(content)
  return match ? match[2] : null
}

/**
 * Resolve an `@Token` (or `@Multi-Word`) mention against a participant
 * list. Delegates to the shared `EnsembleMentionAlias` resolver so the
 * orchestrator's auto-promotion path and the renderer-side surfaces
 * see identical results. Filters out the speaker themself so agents
 * that happen to reference their own role in narration don't get
 * promoted into an infinite self-loop.
 */
export function resolveAtMentionTarget(
  token: string,
  participants: EnsembleParticipant[],
  speaker?: EnsembleParticipant
): EnsembleParticipant | null {
  const trimmed = token?.trim()
  if (!trimmed) return null
  const excludeIds = speaker ? new Set([speaker.id]) : undefined
  return resolvePhraseToParticipant(trimmed, participants, excludeIds)
}
