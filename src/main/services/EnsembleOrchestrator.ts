import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  unattendedElevationPresetId,
  type UnattendedElevationLevel
} from '../UnattendedPostureGate'
import {
  buildRunPermissionPostureSnapshot,
  type RunPermissionPostureContext
} from '../RunPermissionPosture'
import type { TrustedSessionScope } from '../TrustedSessionGrants'
import {
  buildEnsembleDynamicStateSnapshot,
  buildEnsembleParticipantPrompt,
  computeEnsemblePromptShellStamp,
  findUncoveredEnsemblePromptMessageIds,
  getOrderedEnsembleParticipants,
  providerLabel,
  resolveForegroundSynthesizerParticipantId
} from '../EnsemblePrompt'
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
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  EnsembleParticipant,
  EnsembleParticipantStatus,
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
import {
  findAllMentions,
  resolvePhraseToParticipant,
  type ParticipantMentionMatch
} from './EnsembleMentionAlias'
import {
  classifyDispatchError,
  formatAllUnreachableNote,
  formatDispatchFailureNote,
  formatYieldTargetUnreachableNote,
  PARTICIPANT_HEALTH_TAG,
  type DispatchFailureReason
} from '../EnsembleErrors'
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
import { createActiveGoal, normalizeActiveGoalObjective, updateActiveGoalLifecycle } from '../GoalState'
import { findTerminalSynthesizerRoundSummary } from '../EnsembleRoundSummary'
import { mergeTranscriptMediaRefs } from './TranscriptMediaService'
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
import { foldBridgeRunText } from '../bridge/BridgeTextFold'
import {
  formatDiscordContextPromptAppendix,
  normalizeDiscordContextSnapshots,
  redactDiscordContextReadMetadataForHistory,
  type DiscordContextReadMetadata,
  type DiscordContextSnapshot
} from '../channels/DiscordContextService'
import { contextPercent, resolveContextWindow } from '../../shared/contextWindows'
import { isEnsembleRoundDispatchLive } from '../../shared/ensembleRoundLifecycle'
import type { ParticipantWorkingTelemetryEvent } from '../../shared/participantWorkingTelemetry'
import { isCursorGrok45ModelId, isGrok45ReasoningModelId } from '../../shared/grok45Models'
import { isPreviewRiskModel } from '../../shared/previewModelCatalog'
import type { NormalizedProviderUsageSnapshot } from '../ProviderQuotaSnapshots'
import { summarizeProviderUsage, type ProviderUsageSummary } from '../ProviderUsageStatus'
import {
  ASSIGNABLE_PERMISSION_PRESETS,
  claudeRosterSessionRelinkError,
  evaluateRosterEdit,
  type RosterEditAction,
  type RosterEditError,
  type RosterEditParticipantInput,
  type RosterEditRequest
} from '../EnsembleRosterMutation'
import { getStaticProviderModels } from '../providers/StaticProviderModels'
import { selectableProviderIds } from '../settings/MainSanitizers'
import { buildRunQueueDispatchReceipt } from '../RunQueueDispatchReceipt'
import { isCodexAppServerThreadId } from '../CodexSessionIdentity'

export type EnsembleRunMode = 'normal' | 'queue' | 'steer'
export type EnsembleQueuedSteerResult = {
  status: 'steered' | 'ignored'
  roundId?: string
  error?: string
}

const BOSSMAN_ASSIGNABLE_PERMISSION_PRESET_SET = new Set<string>(ASSIGNABLE_PERMISSION_PRESETS)
const ENSEMBLE_SEAT_STAGE_ROLES = new Set<string>([
  'scout',
  'worker',
  'reviewer',
  'background'
])
const SESSION_ACTIVITY_LEDGER_LIMIT = 40
const MAX_BOSSMAN_BRIEF_CHARS = 4000
const BRIEF_SEAT_VALUE_PREVIEW_CHARS = 160
type HostSeatCompactionProvider = 'cursor' | 'kimi' | 'grok'
interface PendingSeatOverflowEvidence {
  provider: HostSeatCompactionProvider
  model: string
  linkedProviderSessionId: string | null
}
function isHostSeatCompactionProvider(provider: ProviderId): provider is HostSeatCompactionProvider {
  return provider === 'cursor' || provider === 'kimi' || provider === 'grok'
}
function seatOverflowEvidenceKey(chatId: string, participantId: string): string {
  return `${chatId}:${participantId}`
}
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
  error?: string
}

/**
 * 1.0.7 — sentinel workspace id for global-chat ensemble usage records. MUST
 * stay byte-identical to the renderer's `GLOBAL_USAGE_WORKSPACE_ID`
 * (App.tsx) so global-chat ensemble usage buckets into the same workspace
 * tally the solo path uses. Hard-coded (not imported) because the renderer
 * const isn't reachable from the main process.
 */
const ENSEMBLE_GLOBAL_USAGE_WORKSPACE_ID = '__taskwraith_global_chats__'
// 1.7.x — 18 → 20 in step with MAX_ENSEMBLE_PARTICIPANTS (a fanout can
// target every roster peer, so the two ceilings must match).
const MAX_ENSEMBLE_FANOUT_TARGETS = 20

const DEFAULT_CONTINUATION_HOP_LIMIT = 6
const MAX_BOSSMAN_SUMMONS_PER_PARTICIPANT_PER_ROUND = 3
const MAX_CONTINUATION_HOP_LIMIT = 500
const MAX_BOSSMAN_CONTROL_ITEMS = 40
const MAX_BOSSMAN_POLL_OPTIONS = 6
// 1.0.4-AN — binding goal-complete poll. Options are FIXED so resolution is
// deterministic; a FAILED/vetoed poll sets a cooldown before another may open.
const BINDING_GOAL_COMPLETE_OPTIONS = ['complete', 'keep-working'] as const
const BINDING_POLL_DEFAULT_TIMEOUT_SECONDS = 300
const BINDING_POLL_COOLDOWN_MS = 10 * 60 * 1000
const ENSEMBLE_IMAGE_ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff|tif|svg|jfif)(\?.*)?$/i
// The visual Odometer roll takes 430ms. Coalescing provider usage snapshots to
// roughly two per second lets each roll finish, while keeping the event lane
// ephemeral and far below the transcript's streaming cadence.
const PARTICIPANT_WORKING_TELEMETRY_MIN_INTERVAL_MS = 450

export interface EnsembleDispatchEvent {
  sender: Electron.WebContents
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
  dispatch: (
    payload: AgentRunPayload,
    event: EnsembleDispatchEvent
  ) => Promise<{ dispatched: boolean; appRunId: string }>
  /** False for an ephemeral cross-provider reroute with no target session lane. */
  shouldPersistProviderSessionForRun?: (runId: string) => boolean
  releaseProviderSessionPersistenceDecision?: (runId: string) => void
  cancelRun: (provider: ProviderId, runId?: string) => Promise<unknown>
  createRunId: (provider: ProviderId) => string
  now: () => number
  nowIso: () => string
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
   * Wave 3 seat compaction — host maintenance-lane compaction for cursor/kimi/grok
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
  notifyUserAttention?: (input: {
    reason: 'yieldToUser'
    chatId: string
    workspaceId?: string | null
    runId?: string
    roundId?: string
    participantId?: string
  }) => void
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
 * Spike 5 — providers whose sessions genuinely resume with full history
 * across ensemble turns, making them eligible for the slim resumed-turn
 * prompt. Kimi's --resume restores a session token (not the transcript),
 * Grok's default ACP transport opens a fresh session every turn, and
 * Ollama is stateless — all three must keep the full shell.
 */
const SLIM_RESUME_PROVIDERS: ReadonlySet<ProviderId> = new Set(['claude', 'codex', 'cursor'])

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
  laneId?: string
  laneIntent?: ConcurrentLane['intent']
  approvedWriteScopes?: ConcurrentLaneWriteScope[]
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
  flushTimer?: ReturnType<typeof setTimeout>
}

function isDynamicStateReceiptTerminalStatus(status: EnsembleParticipantStatus): boolean {
  return status === 'answered' || status === 'yielded' || status === 'sleeping'
}

interface EnsembleParticipantModelCatalogEntry {
  id: string
  label: string
  contextWindow: number
  isDefault?: boolean
  description?: string
  reasoningEfforts?: Array<{
    id: string
    disabled?: boolean
    disabledReason?: string
  }>
  defaultReasoningEffort?: string
  speedTiers?: string[]
}

interface EnsembleParticipantProviderCatalogEntry {
  provider: ProviderId
  label: string
  usage: ProviderUsageSummary
  models: EnsembleParticipantModelCatalogEntry[]
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

function staticModelRecord(model: unknown): Record<string, any> | null {
  return model && typeof model === 'object' && !Array.isArray(model)
    ? (model as Record<string, any>)
    : null
}

function modelReasoningEfforts(model: Record<string, any>):
  | EnsembleParticipantModelCatalogEntry['reasoningEfforts']
  | undefined {
  if (!Array.isArray(model.supportedReasoningEfforts)) return undefined
  const efforts = model.supportedReasoningEfforts
    .map((entry: unknown) => {
      if (typeof entry === 'string' && entry.trim()) return { id: entry.trim() }
      const record = staticModelRecord(entry)
      if (!record) return null
      const id = typeof record?.reasoningEffort === 'string' ? record.reasoningEffort.trim() : ''
      if (!id) return null
      return {
        id,
        ...(record.disabled === true ? { disabled: true } : {}),
        ...(typeof record.disabledReason === 'string' && record.disabledReason.trim()
          ? { disabledReason: record.disabledReason.trim() }
          : {})
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
  return efforts.length > 0 ? efforts : undefined
}

function buildParticipantModelCatalog(
  provider: ProviderId
): EnsembleParticipantModelCatalogEntry[] {
  return getStaticProviderModels(provider)
    .map((model) => {
      const record = staticModelRecord(model)
      if (!record) return null
      const id = typeof record?.id === 'string' ? record.id.trim() : ''
      if (!id) return null
      const label =
        typeof record?.label === 'string' && record.label.trim() ? record.label.trim() : id
      const reasoningEfforts = modelReasoningEfforts(record)
      return {
        id,
        label,
        contextWindow: resolveContextWindow(provider, id),
        ...(record.isDefault === true ? { isDefault: true } : {}),
        ...(typeof record.description === 'string' && record.description.trim()
          ? { description: record.description.trim() }
          : {}),
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
        ...(typeof record.defaultReasoningEffort === 'string' && record.defaultReasoningEffort.trim()
          ? { defaultReasoningEffort: record.defaultReasoningEffort.trim() }
          : {}),
        ...(Array.isArray(record.additionalSpeedTiers)
          ? { speedTiers: record.additionalSpeedTiers.filter((tier) => typeof tier === 'string') }
          : {})
      }
    })
    .filter((entry): entry is EnsembleParticipantModelCatalogEntry => Boolean(entry))
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
export type EnsembleFanoutTargetStage =
  | 'all'
  | 'scouts'
  | 'workers'
  | 'reviewers'
  | 'backgrounds'

export interface EnsembleFanoutInput {
  targets?: unknown
  prompt?: string
  reason?: string
  mode?: EnsembleFanoutMode
  targetStage?: unknown
  writeScopes?: unknown
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
    | 'no_eligible_targets'
    | 'not_authorized'
    | 'missing_write_scope'
    | 'invalid_write_scope'
    | 'write_lanes_disabled'
    | 'budget_exhausted'
    | 'dispatch_failed'
}

export type EnsembleBossmanControlAction =
  | 'skip_participant'
  | 'summon_participant'
  | 'stop_round'
  | 'replace_participant'
  | 'reorder_remaining'
  | 'queue_followup'
  | 'pause_work_session'
  | 'complete_work_session'
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

export interface EnsembleBossmanControlInput {
  action?: EnsembleBossmanControlAction
  roundId?: string
  targetParticipantId?: string
  targetRunId?: string
  participantIds?: string[]
  prompt?: string
  reason?: string
  objective?: string
  acceptanceCriteria?: string
  due?: EnsembleBossmanAssignmentDue
  assignmentStatus?: EnsembleBossmanAssignmentStatus
  assignmentId?: string
  gateId?: string
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
  error?: 'no_active_run' | 'not_ensemble' | 'no_active_round' | 'poll_not_found' | 'poll_closed' | 'invalid_choice'
}

export interface EnsembleBossmanControlResult {
  ok: boolean
  tool: 'ensemble_bossman_control'
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
    | 'queue_failed'
    | 'no_active_work_session'
    | 'baseline_exceeded'
    | 'no_active_goal'
    | 'binding_poll_unavailable'
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
  message: string
  participantId?: string
  roundId?: string
  error?: 'not_ensemble' | 'stale_target' | 'invalid_patch'
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

function laneTranscriptMetadata(
  run: ActiveParticipantRun
): { ensembleLaneId?: string; ensembleLaneIntent?: ConcurrentLane['intent'] } {
  return run.laneId
    ? {
        ensembleLaneId: run.laneId,
        ensembleLaneIntent: run.laneIntent || 'read'
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

function isComparableFanoutTimelineMessage(message: ChatMessage, run: ActiveParticipantRun): boolean {
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
  if (last && last.kind === 'content') {
    last.text += text
    return
  }
  run.timeline.push({ kind: 'content', text })
}

function replaceTimelineContent(run: ActiveParticipantRun, text: string): void {
  run.content = text
  run.timeline = text ? [{ kind: 'content', text }] : []
}

function appendProviderContent(
  run: ActiveParticipantRun,
  text: string,
  options: { cumulative?: boolean } = {}
): boolean {
  if (!text) return false

  if (run.content.length > 0) {
    const fold = foldBridgeRunText(run.content, text)
    if (fold.kind === 'skip') return false
    if (fold.kind === 'tail') {
      run.content = text
      appendTimelineContent(run, fold.tail)
      return true
    }
    if (options.cumulative) {
      const hasToolBoundary = run.timeline?.some((entry) => entry.kind === 'tool') ?? false
      if (hasToolBoundary) {
        return false
      }
      replaceTimelineContent(run, text)
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

function normalizeFanoutTargetStage(value: unknown): EnsembleFanoutTargetStage | null | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, '')
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
  if (
    normalized === 'bg' ||
    normalized === 'background' ||
    normalized === 'backgrounds'
  ) {
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
    value === 'add_participant' ||
    value === 'remove_participant' ||
    value === 'edit_participant'
  )
}

function isEnsembleFanoutPolicy(value: unknown): value is EnsembleFanoutPolicy {
  return typeof value === 'string' && ENSEMBLE_FANOUT_POLICIES.includes(value as EnsembleFanoutPolicy)
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
      .slice(0, MAX_ENSEMBLE_FANOUT_TARGETS)
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
  const kindRaw = String(raw.kind || raw.type || '').trim().toLowerCase()
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

function scopeStaticRoot(
  workspacePath: string,
  scope: ConcurrentLaneWriteScope
): string | null {
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
):
  | { ok: true; claim: ConcurrentWriteScopeClaim }
  | { ok: false; reason: string } {
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

function clampOptionalInteger(
  value: unknown,
  min: number,
  max: number
): number | undefined {
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

function participantSeatValue(participant: EnsembleParticipant): string {
  const provider = providerLabel(participant.provider)
  const model = participant.model ? ` / ${participant.model}` : ''
  const role = participant.role ? ` (${participant.role})` : ''
  const stage = participant.stageRole ? ` [${participant.stageRole}]` : ''
  return `${provider}${model}${role}${stage}`
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

function hasProviderOrModelSeatChangePatch(
  patch: RosterEditParticipantInput | undefined | null
): boolean {
  if (!patch) return false
  return (
    Object.prototype.hasOwnProperty.call(patch, 'provider') ||
    Object.prototype.hasOwnProperty.call(patch, 'model')
  )
}

function hasProviderOrModelSeatChange(
  before: EnsembleParticipant,
  after: EnsembleParticipant
): boolean {
  return before.provider !== after.provider || (before.model || '') !== (after.model || '')
}

function applySeatChangePatch(
  target: EnsembleParticipant,
  patch: RosterEditParticipantInput
): EnsembleParticipant {
  const next: EnsembleParticipant = { ...target, linkedProviderSessionId: target.linkedProviderSessionId }
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
    if (typeof patch.linkedProviderSessionId === 'string' || patch.linkedProviderSessionId === null) {
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
    cleanParticipantId(participantId) ===
    resolveEnsembleProposedPlanOwnerId(chat.ensemble, roundId)
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
  participant?: EnsembleParticipant
): string {
  const name = stripToolNamespace(toolName)
  if (name === 'ensemble_yield') {
    const target = getStringParameter(parameters, ['target', 'participant', 'to', 'next'])
    const actor = participantLabel(participant)
    return target ? `${actor} yielding to ${target}` : `${actor} yielding`
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
  const existingHasCounts =
    typeof normalizedExisting.additions === 'number' ||
    typeof normalizedExisting.deletions === 'number'
  const resultHasCounts =
    typeof normalizedResult.additions === 'number' ||
    typeof normalizedResult.deletions === 'number'
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

/**
 * How many consecutive failed edits to the SAME file (with no successful
 * write in between) end a Work Session. Small, like the other reliability
 * guards: a participant that keeps failing the same file is stuck, and the
 * coarse per-provider round budget would let it keep trying for dozens of
 * rounds before giving up.
 */
export const MAX_CONSECUTIVE_FILE_EDIT_FAILURES = 3

/**
 * Work-session supervisor guard. Walks a single run's file-write tool
 * activities in order and tracks the CURRENT consecutive-failure streak per
 * file — a successful write to a file resets that file's streak, so a run that
 * recovered after a couple of bad patches is NOT flagged. Returns the file
 * left with the largest unresolved failure streak (or null). Pure; exported
 * for the regression suite.
 */
export function worstConsecutiveFileEditFailure(
  toolActivities: ToolActivity[] | undefined
): { filePath: string; failures: number } | null {
  const streak = new Map<string, number>()
  for (const activity of toolActivities ?? []) {
    const filePath = activity.filePath
    if (!filePath) continue
    if (!FILE_WRITE_TOOL_NAMES.has(stripToolNamespace(activity.toolName))) continue
    if (activity.status === 'error') {
      streak.set(filePath, (streak.get(filePath) ?? 0) + 1)
    } else if (activity.status === 'success') {
      streak.set(filePath, 0)
    }
    // 'running' / 'pending' (unpaired) outcomes don't move the streak.
  }
  let worst: { filePath: string; failures: number } | null = null
  for (const [filePath, failures] of streak) {
    if (failures > 0 && (!worst || failures > worst.failures)) {
      worst = { filePath, failures }
    }
  }
  return worst
}

function buildEnsembleToolActivity(
  event: any,
  startedAt: string,
  participant?: EnsembleParticipant
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
    displayName: getEnsembleToolDisplayName(toolName, parameters, participant),
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
  const reasoningTool = /(?:^|_)(?:thinking|reasoning)$/i.test(stripToolNamespace(activity.toolName))
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

/**
 * 1.0.5-EW43a — Runtime-only structured queue entry. Carries both
 * the prompt string (already enriched with `promptWithAttachment
 * References` so any persistence/read-back retains the text refs)
 * AND the structured image-attachment array. The chat-round state
 * still persists only the prompt strings (the renderer reads that
 * shape and would be confused by structured entries), so the
 * `updateChatRound` mirror sites map `entries.map(e => e.prompt)`
 * when writing back. Recovery after app restart loses the
 * attachment objects (the prompt strings survive); for live
 * mid-session queueing — the user's actual symptom — the runtime
 * structure keeps attachments intact through the dequeue + new-
 * round dispatch.
 */
interface QueuedRoundEntry {
  id: string
  prompt: string
  fanoutPolicy?: EnsembleFanoutPolicy
  imageAttachments: EnsembleImageAttachment[]
  imageThumbnails?: EnsembleImageThumbnail[]
  externalPathGrants?: ExternalPathGrant[]
  discordContextSnapshots?: DiscordContextSnapshot[]
}

interface YieldReturnFrame {
  returnParticipantId: string
  targetParticipantId: string
}

interface PendingParticipantSeatChange {
  participantId: string
  before: EnsembleParticipant
  after: EnsembleParticipant
  patch?: RosterEditParticipantInput
  changedBy: SessionActivityLedgerEntry['changedBy']
  reason: string
  queuedAt: string
}

interface ActiveRoundRuntime {
  chatId: string
  roundId: string
  sender: Electron.WebContents
  prompt: string
  imageAttachments: EnsembleImageAttachment[]
  imageThumbnails: EnsembleImageThumbnail[]
  discordContextSnapshots?: DiscordContextSnapshot[]
  cancelled: boolean
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
   * actual image data attached. The chat-round state mirror at
   * `updateChatRound` still persists `queuedPrompts: string[]`
   * (the renderer reads that shape for the queued-messages
   * above-row, and the persistence type stays back-compat).
   */
  queuedPrompts: QueuedRoundEntry[]
  startAfterCancellation?: Promise<unknown>
  remainingParticipants?: EnsembleParticipant[]
  bossmanParticipantId?: string
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
   * 1.0.4-AK6 — structured briefs recorded by participants during
   * the parallel fan-out pass via the `scout_brief` MCP tool. After
   * the fan-out pass closes, the serial writer's prompt builder
   * reads these and injects them as a "Fan-out briefs from the
   * parallel pass:" context block. Cleared at round-end so a
   * subsequent serial round doesn't accidentally re-use stale
   * briefs.
   */
  scoutBriefs?: ScoutBriefRecord[]
  unreachableParticipantIds?: Set<string>
  orchestrationMode: EnsembleOrchestrationMode
  fanoutPolicy?: EnsembleFanoutPolicy
  concurrentMode?: boolean
  continuationHops: number
  maxContinuationHops: number
  continuationLimitNotified?: boolean
  bossmanSummonCountsByParticipantId?: Map<string, number>
  /**
   * Slice C extension (1.0.3) — when a participant calls
   * `ensemble_yield` with an explicit `target` argument, the
   * orchestrator stashes the raw target string here. `runRound`'s
   * loop consults it after each turn to reorder the remaining
   * participants so the named target speaks next. Cleared after
   * resolution (or ignored if the string doesn't resolve to a
   * remaining participant).
   */
  yieldTarget?: string
  /**
   * B8 — explicit-yield repair stack. When A yields to B, A is
   * remembered here so a real answered turn from B can auto-return to A.
   * Nested yields unwind LIFO (A→B→C returns C→B, then B→A).
   */
  yieldReturnStack?: YieldReturnFrame[]
  pendingParticipantSeatChanges?: PendingParticipantSeatChange[]
  pendingRoundEndParticipantSeatChanges?: PendingParticipantSeatChange[]
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
   * Set for a scheduled/workflow occurrence; forces read-only
   * participant postures (no unattended auto-accept of edits).
   */
  unattended?: boolean
  /**
   * P2 — VERIFIED elevation level for an unattended round. When set,
   * resolveParticipantPermissions lifts the uniform posture from read-only to
   * the level's preset instead of read_only. Only ever set alongside `unattended`.
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
  /** Last emitted monotonic usage value per active seat. Keeps the renderer
   * animation smooth without putting a timer or write loop in main. */
  private participantWorkingTelemetryByRunId = new Map<
    string,
    { sentAt: number; inputTokens: number; outputTokens: number; totalTokens: number }
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
  private bossmanPollTimeoutsById = new Map<string, ReturnType<typeof setTimeout>>()
  private queuedPromptIdCounter = 0

  /** Failed-run overflow evidence waiting for the seat's settled maintenance seam. */
  private pendingSeatOverflowEvidence = new Map<string, PendingSeatOverflowEvidence>()

  constructor(private deps: EnsembleOrchestratorDeps) {}

  private nextQueuedPromptId(chatId: string): string {
    this.queuedPromptIdCounter += 1
    return `ensemble-queued-${chatId}-${this.queuedPromptIdCounter}`
  }

  private resolveQueuedPrompt(
    runtime: ActiveRoundRuntime,
    input: { index: number; textPrefix?: string; queuedPromptId?: string }
  ):
    | { selectedIndex: number; selected: QueuedRoundEntry }
    | { error: string } {
    const index = Number.isFinite(input.index) ? Math.floor(input.index) : -1
    if (input.queuedPromptId) {
      const selectedIndex = runtime.queuedPrompts.findIndex((entry) => entry.id === input.queuedPromptId)
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
    this.deps.saveChat(chat)
    if (chat.ensemble?.activeRound?.status !== 'running') return
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
     * Legacy request for read-only concurrent fan-out for this round.
     * Prefer `fanoutPolicy`; `true` maps to `read_only`.
     */
    concurrentMode?: boolean
    fanoutPolicy?: EnsembleFanoutPolicy
    /**
     * P1b — set for a scheduled/workflow occurrence (unattended run).
     * Forces every participant's posture to read-only so an unattended
     * scheduled ensemble can't silently auto-accept edits via a
     * write-capable participant preset.
     */
    unattended?: boolean
    /**
     * P2 — a VERIFIED unattended-elevation level (resolved + HMAC-checked
     * main-side). On an unattended round, every participant's uniform posture
     * rises from read-only to the level's preset (full_access → workspace_write,
     * default → default). Absent ⇒ P1b read-only. Ignored when `unattended` is false.
     */
    unattendedElevationLevel?: UnattendedElevationLevel
  }): { status: 'started' | 'queued' | 'steered' | 'ignored'; roundId?: string } {
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
    const imageThumbnails = normalizeEnsembleImageThumbnails(input.imageThumbnails)
    let existing = this.roundsByChatId.get(input.chatId)
    if (existing) {
      const persistedRound = this.deps.getChat(input.chatId)?.ensemble?.activeRound
      const persistedRoundLive =
        persistedRound?.roundId === existing.roundId &&
        isEnsembleRoundDispatchLive(persistedRound)
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
    if (existing && !existing.cancelled) {
      this.cancelWakeupsOnUserInput(existing)
      if (input.mode === 'steer') {
        const startAfterCancellation = this.cancelRound(input.chatId, 'steered')
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
          startAfterCancellation
        )
        this.appendRoundStatus(
          input.chatId,
          roundId,
          'Ensemble steered: interrupted the active speaker and started a fresh round.'
        )
        return { status: 'steered', roundId }
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
      // renderer + transcript expect. Persistence to chat round
      // state below maps `e => e.prompt` to keep the back-compat
      // `string[]` shape that the renderer reads.
      existing.queuedPrompts.push({
        id: this.nextQueuedPromptId(input.chatId),
        prompt: promptWithAttachmentReferences(prompt, imageAttachments),
        imageAttachments,
        ...(imageThumbnails.length ? { imageThumbnails } : {}),
        ...(input.externalPathGrants?.length
          ? { externalPathGrants: [...input.externalPathGrants] }
          : {}),
        fanoutPolicy: resolveRequestedEnsembleFanoutPolicy(
          this.deps.getChat(input.chatId)?.ensemble,
          input
        ),
        discordContextSnapshots: normalizeDiscordContextSnapshots(input.discordContextSnapshots)
      })
      const nextQueuedPrompts = existing.queuedPrompts.map((entry) => entry.prompt)
      this.updateChatRound(input.chatId, (round) =>
        round
          ? {
              ...round,
              // Keep legacy `queuedPrompt` in sync with the head of
              // the array so back-compat readers still see the next
              // one. New readers should iterate `queuedPrompts`.
              queuedPrompt: nextQueuedPrompts[0],
              queuedPrompts: nextQueuedPrompts
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
      input.unattendedElevationLevel
    )
    return { status: 'started', roundId }
  }

  /**
   * Restart-orphan recovery resolver. After an app restart the in-memory
   * `roundsByChatId` runtime is gone (nothing rehydrates it), but a persisted
   * dispatch-live round still renders queued rows + a live Steer/Delete button
   * because the renderer gates on `isEnsembleRoundDispatchLive`. The persisted
   * round only carries the back-compat `queuedPrompts: string[]` shape (the
   * structured `QueuedRoundEntry[]` lived on the runtime, which no longer
   * exists), so resolve the clicked queued item against that.
   *
   * Returns the persisted round + selected prompt + remaining queue when a
   * recoverable item matches, `{ error }` for a stale index/prefix, or `null`
   * when there is nothing to recover (caller keeps its existing no-runtime
   * behaviour).
   */
  private resolvePersistedQueuedPromptForRecovery(
    chatId: string,
    input: { index: number; textPrefix?: string }
  ):
    | { round: EnsembleRoundState; selectedIndex: number; selected: string; remaining: string[] }
    | { error: string }
    | null {
    const round = this.deps.getChat(chatId)?.ensemble?.activeRound
    if (!round || !isEnsembleRoundDispatchLive(round)) return null
    const prompts =
      Array.isArray(round.queuedPrompts) && round.queuedPrompts.length > 0
        ? round.queuedPrompts
        : round.queuedPrompt
          ? [round.queuedPrompt]
          : []
    if (prompts.length === 0) return null
    const index = Number.isFinite(input.index) ? Math.floor(input.index) : -1
    if (index < 0 || index >= prompts.length) {
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
      remaining: prompts.filter((_, queuedIndex) => queuedIndex !== index)
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
      this.cancelPersistedWakeupsOnUserInput(input.chatId)
      const carryOverQueue: QueuedRoundEntry[] = recovered.remaining.map((queuedPrompt) => ({
        id: this.nextQueuedPromptId(input.chatId),
        prompt: queuedPrompt,
        imageAttachments: []
      }))
      const roundId = this.beginRound(
        input.chatId,
        recovered.selected,
        input.event.sender,
        undefined,
        [],
        [],
        carryOverQueue,
        false,
        [],
        input.concurrentMode,
        input.fanoutPolicy,
        undefined,
        undefined,
        undefined
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

    const remainingQueue = runtime.queuedPrompts.filter((_, queuedIndex) => queuedIndex !== selectedIndex)
    const startAfterCancellation = this.cancelRound(input.chatId, 'steered')
    const roundId = this.beginRound(
      input.chatId,
      selected.prompt,
      input.event.sender,
      undefined,
      selected.imageAttachments,
      selected.imageThumbnails ?? [],
      remainingQueue,
      false,
      selected.externalPathGrants ?? [],
      input.concurrentMode,
      input.fanoutPolicy ?? selected.fanoutPolicy,
      selected.discordContextSnapshots,
      undefined,
      undefined,
      startAfterCancellation
    )
    this.appendRoundStatus(
      input.chatId,
      roundId,
      'Ensemble steered: interrupted the active speaker and started a queued prompt.'
    )
    return { status: 'steered', roundId }
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
              queuedPrompt: recovered.remaining[0],
              queuedPrompts: recovered.remaining
            }
          : round
      )
      return { ok: true, prompt: recovered.selected, queuedPrompts: recovered.remaining }
    }
    if (runtime.cancelled) {
      return { ok: false, error: 'No active Ensemble round' }
    }
    const resolved = this.resolveQueuedPrompt(runtime, input)
    if ('error' in resolved) {
      return { ok: false, error: resolved.error }
    }
    const { selected, selectedIndex } = resolved

    runtime.queuedPrompts = runtime.queuedPrompts.filter((_, queuedIndex) => queuedIndex !== selectedIndex)
    const nextQueuedPrompts = runtime.queuedPrompts.map((entry) => entry.prompt)
    this.updateChatRound(input.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? {
            ...round,
            queuedPrompt: nextQueuedPrompts[0],
            queuedPrompts: nextQueuedPrompts
          }
        : round
    )

    return {
      ok: true,
      prompt: selected.prompt,
      queuedPrompts: nextQueuedPrompts
    }
  }

  private clearQueuedPromptsForRuntime(runtime: ActiveRoundRuntime): void {
    runtime.queuedPrompts = []
    this.updateChatRound(runtime.chatId, (round) =>
      round?.roundId === runtime.roundId
        ? {
            ...round,
            queuedPrompt: undefined,
            queuedPrompts: []
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

  async cancelRound(chatId: string, reason = 'cancelled'): Promise<boolean> {
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime) {
      const chat = this.deps.getChat(chatId)
      const round = chat?.ensemble?.activeRound
      if (!round || round.status !== 'running') return false
      const endedAt = this.deps.nowIso()
      this.updateChatRound(chatId, (current) =>
        current?.roundId === round.roundId
          ? {
              ...current,
              status: 'cancelled',
              queuedPrompt: undefined,
              queuedPrompts: [],
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
    runtime.cancelled = true
    // Stop closes the round immediately: a drain deferred behind active
    // lanes must not race this cancel path to a second finishRound.
    this.deferredLaneDrainByChatId.delete(chatId)
    runtime.queuedPrompts = []
    this.clearYieldReturnStack(runtime)
    runtime.pendingParticipantSeatChanges = undefined
    this.cancelWakeupsForRuntime(runtime, reason)
    const roundId = runtime.roundId
    const activeRunIds = new Set<string>()
    if (runtime.activeRunId) activeRunIds.add(runtime.activeRunId)
    for (const runId of runtime.activeScoutRunIds || []) {
      activeRunIds.add(runId)
    }
    const activeRuns = [...activeRunIds]
      .map((runId) => this.runsByRunId.get(runId))
      .filter((run): run is ActiveParticipantRun => Boolean(run))
    for (const active of activeRuns) {
      this.finalizeRun(active, 'cancelled', reason)
    }
    for (const active of activeRuns) {
      this.updateParticipantState(chatId, roundId, active.participant.id, 'cancelled', reason)
    }
    this.updateChatRound(chatId, (round) =>
      round?.roundId === roundId
        ? {
            ...round,
            status: 'cancelled',
            queuedPrompt: undefined,
            queuedPrompts: [],
            activeParticipantId: undefined,
            endedAt: this.deps.nowIso()
        }
        : round
    )
    this.completeCheckpoint(chatId, roundId, 'cancelled')
    this.clearRuntimeIfCurrent(runtime)
    for (const active of activeRuns) {
      await this.deps.cancelRun(active.participant.provider, active.runId).catch(() => undefined)
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
    if (!activeRunId) return false
    const active = this.runsByRunId.get(activeRunId)
    if (!active) return false
    // Finalise/suppress first so the orchestrator advances immediately,
    // then best-effort cancel the provider process.
    this.finalizeRun(active, 'skipped', 'Skipped by user.')
    if (runtime.activeRunId === active.runId) runtime.activeRunId = undefined
    await this.deps.cancelRun(active.participant.provider, active.runId).catch(() => undefined)
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

  markYielded(runId: string, reason?: string, target?: string): boolean {
    const run = this.runsByRunId.get(runId)
    if (!run) return false
    run.status = 'yielded'
    const runtime = this.roundsByChatId.get(run.chatId)
    const isFanoutLane = Boolean(run.laneId) || Boolean(runtime?.activeScoutRunIds?.has(runId))
    // Slice C extension (1.0.3) — if the participant named a target,
    // remember it on the round runtime so `runRound` can reorder
    // remaining participants before the next turn. We always set
    // runtime.yieldTarget on the round that owns this run, regardless
    // of how the orchestrator's loop resolves it (resolution + clear
    // happens in runRound after the current turn finalises).
    if (target && runtime && !isFanoutLane) {
      runtime.yieldTarget = target
      this.pushYieldReturnFrame(runtime, run, target)
    }
    this.completePendingYieldActivity(run, reason, target)
    this.finalizeRun(run, 'yielded', reason || 'Participant yielded.')
    return true
  }

  private pushYieldReturnFrame(
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun,
    target: string
  ): void {
    if (isUserYieldTarget(target)) return
    const chat = this.deps.getChat(run.chatId)
    const targetParticipant = resolveYieldTargetParticipant(
      chat?.ensemble?.participants || [],
      target,
      run.participant
    )
    if (!targetParticipant?.enabled) return
    if (isBackgroundParticipant(targetParticipant)) return
    runtime.yieldReturnStack ??= []
    runtime.yieldReturnStack.push({
      returnParticipantId: run.participant.id,
      targetParticipantId: targetParticipant.id
    })
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

  private completePendingYieldActivity(
    run: ActiveParticipantRun,
    reason?: string,
    target?: string
  ): void {
    if (!run.toolActivities || run.toolActivities.length === 0) return
    for (let index = run.toolActivities.length - 1; index >= 0; index -= 1) {
      const activity = run.toolActivities[index]
      if (stripToolNamespace(activity.toolName) !== 'ensemble_yield') continue
      if (activity.status !== 'running' && activity.status !== 'pending') return
      const content = reason || (target ? `Yielded to ${target}.` : 'Yielded.')
      run.toolActivities[index] = pairEnsembleToolResult(
        activity,
        {
          type: 'tool_result',
          tool_id: activity.id,
          success: true,
          content,
          result: {
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

  /**
   * 1.0.4-AK — public lookup for which participant owns a given
   * runId. The `ensemble_continue` MCP dispatcher in `index.ts`
   * uses this to populate `EnsembleContinueDeps.callingParticipantId`
   * for the allowed-participants gate. Returns `null` when no
   * orchestrator-tracked run matches (e.g. the call came from a
   * non-ensemble single-participant run).
   */
  getParticipantIdForRun(runId: string | undefined): string | null {
    if (!runId) return null
    const run = this.runsByRunId.get(runId)
    return run?.participant.id || null
  }

  /**
   * 1.0.4-AK — public enqueue for autonomous follow-up prompts from
   * `ensemble_continue`. Mirrors the user-driven `enqueuePrompt`
   * flow but skips the steer/cancel paths since an in-flight
   * participant is calling this. Returns `false` when no active
   * round runtime exists for the chat (the call is a no-op).
   */
  enqueueWorkSessionContinuation(chatId: string, prompt: string): boolean {
    const trimmed = (prompt || '').trim()
    if (!trimmed) return false
    const runtime = this.roundsByChatId.get(chatId)
    if (!runtime || runtime.cancelled) return false
    // 1.0.5-EW43a — autonomous follow-ups don't carry attachments
    // (the `ensemble_continue` MCP tool schema doesn't accept
    // them), so the entry's `imageAttachments` is always empty.
    // Persisted shape mapped to `string[]` for renderer back-compat.
    runtime.queuedPrompts.push({
      id: this.nextQueuedPromptId(chatId),
      prompt: trimmed,
      imageAttachments: []
    })
    const nextQueuedPrompts = runtime.queuedPrompts.map((entry) => entry.prompt)
    this.updateChatRound(chatId, (round) =>
      round ? { ...round, queuedPrompts: nextQueuedPrompts } : round
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
    const run = this.runsByRunId.get(runId)
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
    const caller = this.runsByRunId.get(runId)
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
      !this.roundHasParticipant(chat.ensemble.activeRound, runtime.roundId, input.targetParticipantId)
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
    const targetRun = input.targetRunId ? this.runsByRunId.get(input.targetRunId) : undefined
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
      return this.skipParticipantByBossman(runtime, input, targetRun)
    }

    if (action === 'summon_participant') {
      return this.summonParticipantByBossman(runtime, input, caller.participant, authority.role)
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
      const ok = this.enqueueWorkSessionContinuation(runtime.chatId, prompt)
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

    if (action === 'pause_work_session' || action === 'complete_work_session') {
      return this.transitionWorkSessionByBossman(runtime, action, input.reason)
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
        message: 'ensemble_roster_edit: action must be add_participant, remove_participant, or edit_participant.',
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
    const caller = this.runsByRunId.get(runId)
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
      !this.roundHasParticipant(chat.ensemble.activeRound, runtime.roundId, input.targetParticipantId)
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
        message: 'Roster edit rejected: Boss/Captain participants cannot update their own Brief / Goal through MCP.',
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
      latestChat.ensemble.participants.find((participant) => participant.id === caller.participant.id) ||
      caller.participant
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
      (this.isParticipantActivelyExecuting(runtime, resolution.affectedParticipantId) ||
        (hasProviderOrModelSeatChangePatch(input.participant) &&
          hasProviderOrModelSeatChange(affectedBefore, affectedAfter)))
    ) {
      const queued = this.queueOrApplyParticipantSeatChange({
        chat: latestChat,
        runtime,
        before: affectedBefore,
        after: affectedAfter,
        patch: input.participant || undefined,
        changedBy: 'orchestrator',
        reason: hasProviderOrModelSeatChangePatch(input.participant)
          ? 'Boss roster edit queued for the next round.'
          : 'Boss roster edit queued while the participant was active.'
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
    this.applyRosterEditToRuntime(runtime, action, resolution.affectedParticipantId, resolution.nextParticipants)
    const activeRound = this.applyRosterEditToActiveRound(
      latestChat.ensemble.activeRound,
      runtime.roundId,
      resolution.nextParticipants
    )
    const nextSecondInCommandParticipantId =
      latestChat.ensemble.secondInCommandParticipantId &&
      latestChat.ensemble.secondInCommandParticipantId !== latestChat.ensemble.bossmanParticipantId &&
      resolution.nextParticipants.some(
        (participant) => participant.id === latestChat.ensemble!.secondInCommandParticipantId
      )
        ? latestChat.ensemble.secondInCommandParticipantId
        : undefined
    this.saveChatWithCheckpoint(
      {
        ...latestChat,
        ensemble: {
          ...latestChat.ensemble,
          participants: resolution.nextParticipants,
          secondInCommandParticipantId: nextSecondInCommandParticipantId,
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
      action === 'add_participant' ? 'added' : action === 'remove_participant' ? 'removed' : 'edited'
    const message =
      action === 'edit_participant' && affectedBefore && affectedAfter
        ? `Authoritative seat change applied for ${label}: ${participantSeatValue(affectedBefore)} -> ${participantSeatValue(affectedAfter)}.`
        : `Boss ${verb} ${label}.`
    this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
    return {
      ok: true,
      tool: 'ensemble_roster_edit',
      action,
      roundId: runtime.roundId,
      participantId: resolution.affectedParticipantId,
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
    const caller = this.runsByRunId.get(runId)
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
        message: 'Brief update rejected: Boss/Captain participants cannot update their own Brief / Goal through MCP.',
        error: 'self_update_forbidden'
      }
    }
    if (!this.roundHasParticipant(chat.ensemble.activeRound, runtime.roundId, targetParticipantId)) {
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
    if (!this.roundHasParticipant(latestChat.ensemble.activeRound, runtime.roundId, targetParticipantId)) {
      return {
        ok: false,
        tool: 'ensemble_brief_update',
        roundId: runtime.roundId,
        message: 'Brief update rejected: targetParticipantId is not part of the active round.',
        error: 'stale_target'
      }
    }
    const latestCaller =
      latestChat.ensemble.participants.find((participant) => participant.id === caller.participant.id) ||
      caller.participant
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
    if (
      runtime &&
      hasProviderOrModelSeatChangePatch(patch) &&
      hasProviderOrModelSeatChange(before, after)
    ) {
      const queuedAt = this.deps.nowIso()
      runtime.pendingRoundEndParticipantSeatChanges = [
        ...(runtime.pendingRoundEndParticipantSeatChanges || []).filter(
          (change) => change.participantId !== before.id
        ),
        {
          participantId: before.id,
          before,
          after,
          patch,
          changedBy,
          reason,
          queuedAt
        }
      ]
      const message =
        `Authoritative seat change queued for ${participantLabel(before)}: ` +
        `${participantSeatChangeValue(before, after, before)} -> ${participantSeatChangeValue(before, after, after)}. ` +
        'It will apply after this round finishes.'
      this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
      return {
        ok: true,
        status: 'queued',
        chat: this.deps.getChat(chat.appChatId) || chat,
        message,
        participantId: before.id,
        roundId: runtime.roundId
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
          before,
          after,
          patch,
          changedBy,
          reason,
          queuedAt
        }
      ]
      const message =
        `Authoritative seat change queued for ${participantLabel(before)}: ` +
        `${participantSeatChangeValue(before, after, before)} -> ${participantSeatChangeValue(before, after, after)}. ` +
        'It will apply at that participant turn boundary.'
      this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
      return {
        ok: true,
        status: 'queued',
        chat: this.deps.getChat(chat.appChatId) || chat,
        message,
        participantId: before.id,
        roundId: runtime.roundId
      }
    }

    const applied = this.applyParticipantSeatChangeToChat({
      chat,
      runtime,
      before,
      after,
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
    for (const runId of runtime.activeScoutRunIds || []) {
      if (this.runsByRunId.get(runId)?.participant.id === participantId) return true
    }
    return false
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

  private applyPendingRoundEndParticipantSeatChanges(runtime: ActiveRoundRuntime): void {
    const pending = runtime.pendingRoundEndParticipantSeatChanges || []
    if (pending.length === 0) return
    runtime.pendingRoundEndParticipantSeatChanges = undefined

    for (const change of pending) {
      const chat = this.deps.getChat(runtime.chatId)
      const current = chat?.ensemble?.participants.find(
        (participant) => participant.id === change.participantId
      )
      if (!chat?.ensemble || !current) continue
      const after = applySeatChangePatch(current, change.patch || change.after)
      this.applyParticipantSeatChangeToChat({
        chat,
        before: current,
        after,
        changedBy: change.changedBy,
        reason: change.reason,
        boundary: false,
        updateActiveRound: false
      })
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Authoritative seat change applied after round for ${participantLabel(current)}: ` +
          `${participantSeatChangeValue(current, after, current)} -> ${participantSeatChangeValue(current, after, after)}.`
      )
    }
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
    const { chat, runtime, before, after, changedBy, reason, boundary, updateActiveRound = true } = input
    const nowIso = this.deps.nowIso()
    const nextParticipants = chat.ensemble!.participants.map((participant) =>
      participant.id === before.id ? { ...after, order: participant.order } : participant
    )
    const activeRound = runtime && updateActiveRound
      ? this.applyRosterEditToActiveRound(chat.ensemble!.activeRound, runtime.roundId, nextParticipants)
      : chat.ensemble!.activeRound
    const activityEntry = this.createSeatChangeActivityEntry(
      before,
      after,
      changedBy,
      reason,
      nowIso
    )
    const saved: ChatRecord = {
      ...chat,
      ensemble: {
        ...chat.ensemble!,
        participants: nextParticipants,
        activeRound,
        sessionActivityLedger: [
          ...(chat.ensemble!.sessionActivityLedger || []),
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
        `Authoritative seat change ${boundary ? 'applied at turn boundary' : 'applied'} for ` +
        `${participantLabel(before)}: ${participantSeatChangeValue(before, after, before)} -> ${participantSeatChangeValue(before, after, after)}.`
      this.appendRoundStatus(runtime.chatId, runtime.roundId, message)
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
            ? { permissionPresetId: patch.permissionPresetId as EnsembleParticipant['permissionPresetId'] }
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
        ? { permissionPresetId: patch.permissionPresetId as EnsembleParticipant['permissionPresetId'] }
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
    if (!remaining) return
    const nextById = new Map(nextParticipants.map((participant) => [participant.id, participant]))
    const affected = nextById.get(affectedParticipantId)
    if (action === 'add_participant') {
      if (affected && !remaining.some((participant) => participant.id === affected.id)) {
        remaining.push(affected)
      }
    } else if (action === 'remove_participant') {
      const filtered = remaining.filter((participant) => participant.id !== affectedParticipantId)
      remaining.length = 0
      remaining.push(...filtered)
      if (runtime.secondInCommandParticipantId === affectedParticipantId) {
        runtime.secondInCommandParticipantId = undefined
      }
    } else {
      const edited = remaining.map((participant) => nextById.get(participant.id) || participant)
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
        return {
          ...state,
          ...roundParticipantDisplayFields(participant)
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
      .filter((participant) => !existingIds.has(participant.id))
      .map((participant) => roundParticipantStateFromParticipant(participant, 'idle'))
    const participantStates = [...existing, ...removed, ...added].sort((a, b) => a.order - b.order)
    return {
      ...round,
      activeParticipantId:
        round.activeParticipantId && nextById.has(round.activeParticipantId)
          ? round.activeParticipantId
          : undefined,
      secondInCommandParticipantId:
        round.secondInCommandParticipantId && nextById.has(round.secondInCommandParticipantId)
          ? round.secondInCommandParticipantId
          : undefined,
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

  private skipParticipantByBossman(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput,
    targetRun?: ActiveParticipantRun
  ): EnsembleBossmanControlResult {
    const reason = input.reason || 'Skipped by Boss.'
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
      this.finalizeRun(active, 'skipped', reason)
      if (runtime.activeRunId === active.runId) runtime.activeRunId = undefined
      runtime.activeScoutRunIds?.delete(active.runId)
      void this.deps.cancelRun(active.participant.provider, active.runId).catch(() => undefined)
      return {
        ok: true,
        tool: 'ensemble_bossman_control',
        action: 'skip_participant',
        roundId: runtime.roundId,
        participantId: active.participant.id,
        message: `Boss skipped ${active.participant.role || active.participant.provider}.`
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
    const [participant] = remaining.splice(index, 1)
    this.updateParticipantState(runtime.chatId, runtime.roundId, participant.id, 'skipped', reason)
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `Boss skipped ${participant.role || participant.provider}. ${reason}`
    )
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'skip_participant',
      roundId: runtime.roundId,
      participantId: participant.id,
      message: `Boss skipped pending participant ${participant.role || participant.provider}.`
    }
  }

  private summonParticipantByBossman(
    runtime: ActiveRoundRuntime,
    input: EnsembleBossmanControlInput,
    caller: EnsembleParticipant,
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
    if (targetParticipantId === caller.id) {
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
      const providers = selectableProviderIds().reduce<Partial<Record<ProviderId, ProviderUsageSummary>>>(
        (acc, candidate) => {
          acc[candidate] = summarizeProviderUsage(
            candidate,
            this.deps.getProviderUsageSnapshot?.(candidate) || null
          )
          return acc
        },
        {}
      )
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
      const nextGoal = chat.activeGoal
        ? updateActiveGoalLifecycle(
            {
              ...chat.activeGoal,
              objective,
              provider: caller.provider,
              mode: 'taskwraith_steered'
            },
            'active',
            input.reason,
            new Date(nowIso)
          )
        : createActiveGoal(caller.provider, objective, {
            now: new Date(nowIso),
            allowProviderNative: false
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
      const reason =
        normalizeBossmanText(input.reason, 500) || 'Whole ensemble scheduled wake-up.'
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
        return this.missingBossmanField(action, runtime.roundId, 'assign_work requires targetParticipantId and objective.')
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
      if (!goal) return this.missingBossmanField(action, runtime.roundId, 'set_round_plan requires goal.')
      const plan = {
        goal,
        phase: normalizeBossmanText(input.phase, 240) || undefined,
        ownerParticipantIds: participantIds.length ? participantIds : undefined,
        blockers: normalizeBossmanTextArray(input.blockers, 8, 240),
        doneCriteria: normalizeBossmanText(input.doneCriteria || input.acceptanceCriteria, 1000) || undefined,
        updatedAt: nowIso,
        updatedByParticipantId: callerId
      }
      this.updateBossmanControlState(runtime, (state) => ({ ...state, roundPlan: plan }))
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${authorityLabel} set the round plan: ${goal}`
      )
      return { ok: true, tool: 'ensemble_bossman_control', action, roundId: runtime.roundId, message: `${authorityLabel} set the round plan.` }
    }

    if (action === 'request_status') {
      const prompt = normalizeBossmanText(input.question || input.prompt || input.reason, 800)
      if (!prompt) return this.missingBossmanField(action, runtime.roundId, 'request_status requires prompt or question.')
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
      return { ok: true, tool: 'ensemble_bossman_control', action, roundId: runtime.roundId, message: `${authorityLabel} requested status.` }
    }

    if (action === 'declare_decision') {
      const decision = normalizeBossmanText(input.decision || input.prompt, 1000)
      if (!decision) return this.missingBossmanField(action, runtime.roundId, 'declare_decision requires decision.')
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
      this.appendRoundStatus(runtime.chatId, runtime.roundId, `${authorityLabel} declared decision: ${decision}`)
      return { ok: true, tool: 'ensemble_bossman_control', action, roundId: runtime.roundId, message: `${authorityLabel} recorded a decision.` }
    }

    if (action === 'set_review_gate') {
      const reviewerId = input.targetParticipantId || participantIds[0]
      const reviewer = reviewerId ? this.findRuntimeParticipant(runtime, reviewerId) : null
      const scope = normalizeBossmanText(input.scope || input.prompt, 800)
      if (!reviewer || !scope) return this.missingBossmanField(action, runtime.roundId, 'set_review_gate requires targetParticipantId and scope.')
      const gate = {
        id: input.gateId || this.nextBossmanControlId('gate'),
        reviewerParticipantId: reviewer.id,
        scope,
        criteria: normalizeBossmanText(input.acceptanceCriteria, 1000) || undefined,
        status: input.reviewStatus || 'required',
        reason: normalizeBossmanText(input.reason, 500) || undefined,
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
      return { ok: true, tool: 'ensemble_bossman_control', action, roundId: runtime.roundId, participantId: reviewer.id, message: `${authorityLabel} set a review gate.` }
    }

    if (action === 'quarantine_participant') {
      const participantId = input.targetParticipantId
      const participant = participantId ? this.findRuntimeParticipant(runtime, participantId) : null
      if (!participant) return this.missingBossmanField(action, runtime.roundId, 'quarantine_participant requires targetParticipantId.')
      const reason = normalizeBossmanText(input.reason, 500)
      if (!input.clear && !reason) return this.missingBossmanField(action, runtime.roundId, 'quarantine_participant requires reason unless clear=true.')
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
        this.updateParticipantState(runtime.chatId, runtime.roundId, participant.id, 'skipped', `Quarantined: ${quarantine.reason}`)
      }
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        quarantine.active
          ? `${authorityLabel} quarantined ${participantDisplayName(participant)} (${quarantine.category}): ${quarantine.reason}`
          : `${authorityLabel} cleared quarantine for ${participantDisplayName(participant)}.`
      )
      return { ok: true, tool: 'ensemble_bossman_control', action, roundId: runtime.roundId, participantId: participant.id, message: quarantine.active ? `${authorityLabel} quarantined ${participantDisplayName(participant)}.` : `${authorityLabel} cleared quarantine.` }
    }

    if (action === 'allocate_budget') {
      if (input.targetParticipantId && !this.findRuntimeParticipant(runtime, input.targetParticipantId)) {
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
        return this.missingBossmanField(action, runtime.roundId, 'allocate_budget requires at least one max* budget field.')
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
      return { ok: true, tool: 'ensemble_bossman_control', action, roundId: runtime.roundId, participantId: budget.participantId, message: `${authorityLabel} allocated a bounded budget.` }
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
      if (!question || options.length < 2) return this.missingBossmanField(action, runtime.roundId, 'create_poll requires question and at least two options.')
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
        polls: capBossmanItems([...(state.polls || []).filter((entry) => entry.id !== poll.id), poll])
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
      return { ok: true, tool: 'ensemble_bossman_control', action, roundId: runtime.roundId, message: `${authorityLabel} opened poll ${poll.id}.` }
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
    const run = this.runsByRunId.get(runId)
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
        votes: [...poll.votes.filter((entry) => entry.voterParticipantId !== run.participant.id), vote]
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
    }
    return response
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
      this.appendRoundStatus(chatId, chat.ensemble.activeRound.roundId, `User voted "${choice}" in poll ${pollId}.`)
    }
    return {
      ok: true,
      tool: 'ensemble_poll_response',
      pollId,
      message: `User voted "${choice}" in poll ${pollId}.`
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
    const key = `${chatId}:${pollId}`
    const existing = this.bossmanPollTimeoutsById.get(key)
    if (existing) clearTimeout(existing)
    const dueMs = new Date(timeoutAt).getTime()
    if (!Number.isFinite(dueMs)) return
    const delayMs = Math.max(0, dueMs - this.deps.now())
    const handle = setTimeout(() => {
      this.bossmanPollTimeoutsById.delete(key)
      this.expireBossmanPoll(chatId, pollId, timeoutAt)
    }, delayMs)
    handle.unref?.()
    this.bossmanPollTimeoutsById.set(key, handle)
  }

  private clearBossmanPollTimeout(chatId: string, pollId: string): void {
    const key = `${chatId}:${pollId}`
    const existing = this.bossmanPollTimeoutsById.get(key)
    if (!existing) return
    clearTimeout(existing)
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
      chat.ensemble.secondInCommandParticipantId
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
      polls: capBossmanItems([
        ...(state.polls || []).filter((entry) => entry.id !== poll.id),
        poll
      ])
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
    const userVote = poll.votes.find((vote) => !vote.voterParticipantId && vote.voterLabel === 'User')
    const vetoVote = participantVotes.find(
      (vote) => authorityIds.has(vote.voterParticipantId as string) && vote.choice === 'keep-working'
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
      this.appendRoundStatus(chatId, auditRoundId, `Binding goal-complete poll ${pollId} ${detail}`)
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
    return chat?.ensemble?.participants.find((participant) => participant.id === participantId) || null
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
    return gates
      .filter((gate) => gate.status === 'required' || gate.status === 'failed')
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
    if (
      !usage.extraTurns &&
      !usage.fanoutCalls &&
      !usage.durationSeconds &&
      !usage.tokens
    ) {
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
        message: 'Boss reorder rejected: turn order can change once every two completed Ensemble rounds.',
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
    this.appendRoundStatus(runtime.chatId, runtime.roundId, 'Boss changed the remaining turn order.')
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action: 'reorder_remaining',
      roundId: runtime.roundId,
      message: 'Boss changed the remaining turn order.'
    }
  }

  private transitionWorkSessionByBossman(
    runtime: ActiveRoundRuntime,
    action: Extract<EnsembleBossmanControlAction, 'pause_work_session' | 'complete_work_session'>,
    reasonInput?: string
  ): EnsembleBossmanControlResult {
    const chat = this.deps.getChat(runtime.chatId)
    const session = chat?.ensemble?.workSession
    if (!chat?.ensemble || !session || !session.enabled || session.status !== 'active') {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: 'Boss Work Session control rejected: no active Work Session.',
        error: 'no_active_work_session'
      }
    }
    const reason =
      reasonInput ||
      (action === 'complete_work_session'
        ? 'Boss marked the Work Session complete.'
        : 'Boss paused the Work Session.')
    const nowIso = this.deps.nowIso()
    const status = action === 'complete_work_session' ? 'completed' : 'paused'
    if (status === 'completed') {
      const blockingGates = this.activeBossmanReviewGateBlocks(chat)
      if (blockingGates.length > 0) {
        const message = `Boss Work Session completion blocked by review gate(s): ${blockingGates.join('; ')}.`
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
    // If this session was started from a linked active Goal and that goal is
    // STILL the chat's current active goal, completing the session completes
    // the goal too. A different/absent active goal (the user moved on) is left
    // untouched — "unrelated goals are not affected".
    const linkedGoalId = session.linkedActiveGoalId
    const completesLinkedGoal =
      status === 'completed' &&
      Boolean(linkedGoalId) &&
      chat.activeGoal?.id === linkedGoalId &&
      chat.activeGoal?.status !== 'completed'
    const nextActiveGoal = completesLinkedGoal
      ? updateActiveGoalLifecycle(chat.activeGoal!, 'completed', reason, new Date(nowIso))
      : chat.activeGoal
    this.deps.saveChat({
      ...chat,
      ...(nextActiveGoal !== chat.activeGoal ? { activeGoal: nextActiveGoal } : {}),
      ensemble: {
        ...chat.ensemble,
        workSession: {
          ...session,
          status,
          endedReason: reason,
          ...(status === 'completed' ? { endedAt: nowIso } : {})
        },
        updatedAt: nowIso
      },
      updatedAt: this.deps.now()
    })
    this.appendRoundStatus(runtime.chatId, runtime.roundId, `Boss ${status === 'completed' ? 'completed' : 'paused'} the Work Session. ${reason}`)
    if (completesLinkedGoal) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Boss completed the linked goal "${chat.activeGoal?.objective || linkedGoalId}".`
      )
    }
    return {
      ok: true,
      tool: 'ensemble_bossman_control',
      action,
      roundId: runtime.roundId,
      message: `Boss ${status === 'completed' ? 'completed' : 'paused'} the Work Session.`
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
    const target = chat.ensemble.participants.find((participant) => participant.id === targetParticipantId)
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
    const requestedPermissionPresetId = input.replacement?.permissionPresetId
    if (
      requestedPermissionPresetId &&
      !BOSSMAN_ASSIGNABLE_PERMISSION_PRESET_SET.has(String(requestedPermissionPresetId))
    ) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'replace_participant',
        roundId: runtime.roundId,
        participantId: targetParticipantId,
        message:
          'Boss replacement rejected: permissionPresetId must be read_only, plan, or default.',
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
      ...(requestedPermissionPresetId
        ? { permissionPresetId: requestedPermissionPresetId }
        : target.permissionPresetId
          ? { permissionPresetId: target.permissionPresetId }
          : {}),
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
    const postProbeParticipants =
      this.deps.getChat(runtime.chatId)?.ensemble?.participants || []
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
    const pendingIndex = remaining.findIndex((participant) => participant.id === targetParticipantId)
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
        targetRun ||
        (runtime.activeRunId ? this.runsByRunId.get(runtime.activeRunId) : undefined)
      if (activeRun) {
        this.finalizeRun(activeRun, 'skipped', input.reason || 'Replaced by Boss.')
        if (runtime.activeRunId === activeRun.runId) runtime.activeRunId = undefined
        runtime.activeScoutRunIds?.delete(activeRun.runId)
        void this.deps.cancelRun(activeRun.participant.provider, activeRun.runId).catch(() => undefined)
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
    const replacementOrder = nextParticipants.find((participant) => participant.id === replacement.id)?.order || replacement.order
    const activeRound =
      latestEnsemble.activeRound?.roundId === runtime.roundId
        ? {
            ...latestEnsemble.activeRound,
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
          ...(latestEnsemble.bossmanParticipantId === targetParticipantId
            ? { bossmanParticipantId: undefined, bossmanAutoApprovals: undefined }
            : {}),
          ...(latestEnsemble.secondInCommandParticipantId === targetParticipantId
            ? { secondInCommandParticipantId: undefined }
            : {}),
          updatedAt: this.deps.nowIso()
        },
        updatedAt: this.deps.now()
      },
      'participant-updated'
    )
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

  async fanoutForRun(runId: string | undefined, input: EnsembleFanoutInput): Promise<EnsembleFanoutResult> {
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
    const run = this.runsByRunId.get(runId)
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
    const fanoutPolicy = runtime.fanoutPolicy ?? (runtime.concurrentMode ? 'read_only' : 'off')
    const workSessionScoutPass =
      chat.ensemble.workSession?.enabled &&
      chat.ensemble.workSession.status === 'active' &&
      chat.ensemble.workSession.enableScoutPass
    if (fanoutPolicy === 'off' && !workSessionScoutPass) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: 'ensemble_fanout: fan-out is off for this round.',
        error: 'not_authorized'
      }
    }
    if (mode === 'read_only' && !fanoutPolicyAllowsRead(fanoutPolicy) && !workSessionScoutPass) {
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
        message:
          'ensemble_fanout: locked writer lanes require the Write or All fan-out policy.',
        error: 'not_authorized'
      }
    }
    if (mode === 'locked_writers' && !concurrentWriteLanesEnabled()) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message:
          'ensemble_fanout: locked writer lanes require TASKWRAITH_CONCURRENT_WRITE_LANES.',
        error: 'write_lanes_disabled'
      }
    }

    if (mode === 'locked_writers' && !this.canRequestLockedWriterFanout(chat, runtime, run)) {
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
          'ensemble_fanout: broad fan-out requires the configured Boss/Lead/manager, or an active Work Session with an explicit participant scope. Use explicit targets for a narrow peer handoff.',
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
        'boss'
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
    this.appendRoundStatus(
      run.chatId,
      run.roundId,
      `${label}: ${run.participant.role || run.participant.provider} requested ${resolvedTargets.targets.length} lane(s).${input.reason ? ` ${input.reason}` : ''}`
    )
    if (!runtime.fanoutReservedParticipantIds) runtime.fanoutReservedParticipantIds = new Set()
    for (const participant of resolvedTargets.targets) {
      runtime.fanoutReservedParticipantIds.add(participant.id)
    }
    try {
      const laneIds = await this.runParallelFanoutPass(runtime, chat, resolvedTargets.targets, {
        prompt,
        reason: input.reason,
        mode,
        sourceRunId: runId,
        writeScopesByParticipantId,
        waitForCompletion: false
      })
      this.incrementBossmanBudgetUsage(
        runtime,
        resolvedTargets.targets.map((participant) => participant.id),
        { fanoutCalls: 1 }
      )
      if (!runtime.fannedOutParticipantIds) runtime.fannedOutParticipantIds = new Set()
      for (const participant of resolvedTargets.targets) {
        runtime.fannedOutParticipantIds.add(participant.id)
      }
      return {
        ok: true,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        status: 'dispatched',
        laneIds,
        participantIds: resolvedTargets.targets.map((participant) => participant.id),
        message: `${label} dispatched: ${laneIds.length} lane(s) started. Results will appear in the transcript; this tool returns after dispatch so the caller does not time out while lanes are working.`
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'ensemble_fanout: dispatch failed.'
      this.appendRoundStatus(run.chatId, run.roundId, `${label} failed: ${message}`)
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        ...(targetStage ? { targetStage } : {}),
        message,
        error: 'dispatch_failed'
      }
    } finally {
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
    const run = this.runsByRunId.get(runId)
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
                resolvePhraseToParticipant(stripLeadingAt(target), participants, new Set([run.participant.id]))
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
    const recipientLabels = recipients.map((participant) => participant.role || providerLabel(participant.provider))
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
    const run = this.runsByRunId.get(runId)
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
      resourcePath?: string
    }
  ): { ok: true } | { ok: false; reason: string } {
    if (!runId) return { ok: true }
    const run = this.runsByRunId.get(runId)
    if (!run?.laneId) return { ok: true }
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
    const resourcePath = input.resourcePath ? resolve(input.resourcePath) : undefined
    if (resourcePath && !pathIsInsideOrSame(workspacePath, resourcePath)) {
      return {
        ok: false,
        reason:
          'External path writes are disabled inside parallel writer lanes; use a serial writer for external grants.'
      }
    }
    if (!resourcePath) {
      return scopes.some((scope) => scope.kind === 'workspace')
        ? { ok: true }
        : {
            ok: false,
            reason: `Workspace-wide tool ${input.toolName} requires an approved workspace write scope.`
          }
    }
    return scopes.some((scope) => writeScopeAllowsResource(scope, workspacePath, resourcePath))
      ? { ok: true }
      : {
          ok: false,
          reason: `Lane ${run.laneId} is not approved to write ${toWorkspaceRelative(workspacePath, resourcePath)}.`
        }
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

  private activeSecondInCommandParticipantId(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime
  ): string | undefined {
    const participantId =
      runtime.secondInCommandParticipantId ||
      chat.ensemble?.activeRound?.secondInCommandParticipantId ||
      chat.ensemble?.secondInCommandParticipantId
    const participant = chat.ensemble?.participants.find(
      (candidate) => candidate.id === participantId
    )
    return participant && isBackgroundParticipant(participant) ? undefined : participantId
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
    }
    return { unavailable: false, liveBossmanParticipantId: bossmanParticipantId }
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
        secondInCommandParticipantId?: string
        rosterGuardParticipantId: string
        primaryUnavailableReason?: string
      }
    | {
        ok: false
        error: 'bossman_not_configured' | 'second_in_command_standby' | 'not_bossman'
        message: string
        bossmanParticipantId?: string
        secondInCommandParticipantId?: string
        primaryUnavailableReason?: string
      } {
    const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
    const secondInCommandParticipantId = this.activeSecondInCommandParticipantId(chat, runtime)
    const primary = this.primaryBossUnavailable(chat, runtime, bossmanParticipantId)
    if (!bossmanParticipantId) {
      return {
        ok: false,
        error: 'bossman_not_configured',
        message: 'no Boss is assigned for this Ensemble',
        secondInCommandParticipantId,
        primaryUnavailableReason: primary.reason
      }
    }
    if (callerParticipantId === bossmanParticipantId) {
      return {
        ok: true,
        role: 'boss',
        bossmanParticipantId,
        secondInCommandParticipantId,
        rosterGuardParticipantId: bossmanParticipantId
      }
    }
    if (callerParticipantId === secondInCommandParticipantId) {
      if (primary.unavailable) {
        return {
          ok: true,
          role: 'second_in_command',
          bossmanParticipantId,
          secondInCommandParticipantId,
          rosterGuardParticipantId: primary.liveBossmanParticipantId || secondInCommandParticipantId,
          primaryUnavailableReason: primary.reason
        }
      }
      return {
        ok: false,
        error: 'second_in_command_standby',
        message: 'the assigned Boss is still available, so Captain remains standby',
        bossmanParticipantId,
        secondInCommandParticipantId
      }
    }
    return {
      ok: false,
      error: 'not_bossman',
      message:
        'only the assigned Boss, or Captain while the Boss is unavailable, may use this control',
      bossmanParticipantId,
      secondInCommandParticipantId,
      primaryUnavailableReason: primary.unavailable ? primary.reason : undefined
    }
  }

  private isBossParticipant(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participantId: string | undefined
  ): boolean {
    if (!participantId) return false
    return this.resolveBossAuthorityForCaller(chat, runtime, participantId).ok
  }

  private canRequestLockedWriterFanout(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): boolean {
    return this.resolveBossAuthorityForCaller(chat, runtime, run.participant.id).ok
  }

  private lockedWriterFanoutAuthorizationMessage(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): string {
    const authority = this.resolveBossAuthorityForCaller(chat, runtime, run.participant.id)
    if (authority.ok) return 'Locked writer fan-out authorized.'
    if (authority.error === 'bossman_not_configured') {
      return 'Locked writer fan-out rejected: no Boss is assigned, so writer lanes require a user write-scope preflight before parallel mutation is allowed.'
    }
    if (authority.error === 'second_in_command_standby') {
      return `Locked writer fan-out rejected from ${run.participant.role || providerLabel(run.participant.provider)}: the assigned Boss is still available, so Captain remains standby.`
    }
    return `Locked writer fan-out rejected from ${run.participant.role || providerLabel(run.participant.provider)}: only the assigned Boss, or Captain while Boss is unavailable, may authorize parallel writer lanes.`
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
  ):
    | { ok: true; preflight: ConcurrentWriteScopePreflight }
    | { ok: false; reason: string } {
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
      .map(
        (claim) =>
          `${claim.participantRole}: ${claim.scopes.map(formatWriteScope).join(', ')}`
      )
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
    const run = this.runsByRunId.get(runId)
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
    const run = this.runsByRunId.get(runId)
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
    const run = this.runsByRunId.get(runId)
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
      ...(brief.recommendations?.length
        ? [`Recommends: ${brief.recommendations.join('; ')}`]
        : []),
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
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          blackboard: upsertBlackboardEntry(chat.ensemble.blackboard || [], entry),
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
    secondInCommandParticipantId?: string
    bossmanAuthorityRole?: 'boss' | 'second_in_command'
    bossmanPrimaryUnavailableReason?: string
    bossmanAutoApprovalsEnabled?: boolean
    rosterEditAllowed?: boolean
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
    const run = this.runsByRunId.get(runId)
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
    return {
      ok: true,
      chatId: chat.appChatId,
      roundId: run.roundId,
      activeParticipantId: run.participant.id,
      bossmanParticipantId: chat.ensemble.bossmanParticipantId,
      secondInCommandParticipantId: chat.ensemble.secondInCommandParticipantId,
      ...(authority?.ok ? { bossmanAuthorityRole: authority.role } : {}),
      ...(authority?.ok && authority.primaryUnavailableReason
        ? { bossmanPrimaryUnavailableReason: authority.primaryUnavailableReason }
        : {}),
      bossmanAutoApprovalsEnabled: chat.ensemble.bossmanAutoApprovals?.enabled === true,
      rosterEditAllowed:
        authority?.ok === true &&
        chat.ensemble.bossmanAutoApprovals?.enabled === true &&
        chat.ensemble.bossmanAutoApprovals?.mode === 'permission_preset_once',
      availableProviders: selectableProviderIds().map((provider) => ({
        provider,
        label: providerLabel(provider),
        usage: summarizeProviderUsage(provider, this.deps.getProviderUsageSnapshot?.(provider)),
        models: buildParticipantModelCatalog(provider)
      })),
      participants: (chat.ensemble.participants || []).map((participant) => {
        const participantContext = latestRunContextUsage(chat.runs ?? [], participant.id)
        const participantContextWindow = resolveContextWindow(
          participant.provider,
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
    const run = this.runsByRunId.get(runId)
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
    const run = this.runsByRunId.get(runId)
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
    const recoveredFanoutPolicy =
      round.fanoutPolicy !== undefined || round.concurrentMode !== undefined
        ? resolveEnsembleFanoutPolicy(round)
        : resolveEnsembleFanoutPolicy(chat.ensemble)
    const runtime: ActiveRoundRuntime = {
      chatId: wakeup.chatId,
      roundId: wakeup.roundId,
      sender,
      prompt: round.prompt,
      imageAttachments: [],
      imageThumbnails: [],
      cancelled: false,
      // 1.0.5-EW43a — persisted shape is `string[]`; runtime
      // wants `QueuedRoundEntry[]`. Wakeup recovery has no
      // attachment metadata stored (the persisted form lost the
      // structured objects across the app-quit boundary), so each
      // restored entry gets an empty attachment array. Mid-session
      // attachment delivery is preserved through the live queue;
      // app-restart-mid-queue users will see only the prompt's
      // text references — known limitation, acceptable for
      // 1.0.5.
      queuedPrompts: (round.queuedPrompts || []).map((prompt) => ({
        id: this.nextQueuedPromptId(wakeup.chatId),
        prompt,
        fanoutPolicy: recoveredFanoutPolicy,
        imageAttachments: []
      })),
      orchestrationMode: round.orchestrationMode || chat.ensemble.orchestrationMode || 'turn_bound',
      fanoutPolicy: recoveredFanoutPolicy,
      ...(fanoutPolicyEnablesConcurrent(recoveredFanoutPolicy) ? { concurrentMode: true } : {}),
      continuationHops: round.continuationHops || 0,
      maxContinuationHops:
        round.maxContinuationHops ||
        chat.ensemble.maxContinuationHops ||
        DEFAULT_CONTINUATION_HOP_LIMIT,
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
    if (!participant.linkedProviderSessionId) {
      this.appendRoundStatus(
        wakeup.chatId,
        wakeup.roundId,
        `${participant.role || providerLabel(participant.provider)} is resuming from TaskWraith transcript context; no native provider session id was available.`
      )
    }
    void this.runRound(runtime, [participant])
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
      signature: this.deps.signRunPermissionPosture(
        permissions.approvalMode,
        permissions,
        context
      ),
      context
    })
  }

  private saveWakeupRecord(
    chat: ChatRecord | null | undefined,
    wakeup: EnsembleWakeupRecord
  ): void {
    if (!chat?.ensemble) return
    this.saveChatWithCheckpoint({
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
    }, 'round-updated')
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
    this.saveChatWithCheckpoint({
      ...chat,
      ensemble: {
        ...chat.ensemble,
        activeRound: nextRound,
        updatedAt: this.deps.nowIso()
      },
      updatedAt: this.deps.now()
    }, 'round-updated')
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
    const run = this.runsByRunId.get(runId)
    if (!run) return false
    if (source?.provider && run.participant.provider !== source.provider) return false
    if (source?.chatId && run.chatId !== source.chatId) return false

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
    if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return false

    const telemetry = this.deps.onParticipantWorkingTelemetry
    if (!telemetry) return true
    const now = this.deps.now()
    const changed =
      !previous ||
      inputTokens !== previous.inputTokens ||
      outputTokens !== previous.outputTokens ||
      totalTokens !== previous.totalTokens
    if (!changed) return true
    if (previous && now - previous.sentAt < PARTICIPANT_WORKING_TELEMETRY_MIN_INTERVAL_MS) {
      return true
    }

    this.participantWorkingTelemetryByRunId.set(runId, {
      sentAt: now,
      inputTokens,
      outputTokens,
      totalTokens
    })
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
      estimated: false
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
    if (!isHostSeatCompactionProvider(provider)) return false
    const runId = routed.appRunId
    if (!runId) return false
    const run = this.runsByRunId.get(runId)
    if (!run || run.participant.provider !== provider) return false
    if (routed.appChatId && routed.appChatId !== run.chatId) return false
    if (!isContextOverflowErrorText(text)) return false
    run.classifiedContextOverflow = true
    return true
  }

  markRunExited(runId: string | undefined, exitCode: number): boolean {
    if (!runId) return false
    const run = this.runsByRunId.get(runId)
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
    const status: EnsembleParticipantStatus = exitCode === 0 ? 'skipped' : 'failed'
    this.finalizeRun(
      run,
      status,
      exitCode === 0 ? 'Exited without result.' : `Exited with code ${exitCode}.`
    )
    return true
  }

  handleProviderOutput(provider: ProviderId, routed: AgentRunRoute, payload: any): boolean {
    const runId = routed.appRunId
    if (!runId) return false
    const run = this.runsByRunId.get(runId)
    if (!run || run.participant.provider !== provider) return false
    if (routed.appChatId && routed.appChatId !== run.chatId) return false

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
        const itemTransition =
          itemId !== undefined &&
          run.lastContentItemId !== undefined &&
          itemId !== run.lastContentItemId &&
          run.content.length > 0
        const chunk = `${itemTransition ? '\n\n---\n\n' : ''}${text}`
        const appended = appendProviderContent(run, chunk, {
          cumulative: payload.cumulative === true
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
          cumulative: payload.cumulative === true
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
          if (appendProviderContent(run, text)) this.scheduleFlush(run)
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
      const activity = buildEnsembleToolActivity(payload, this.deps.nowIso(), run.participant)
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
        run.toolActivities[idx] = pairEnsembleToolResult(
          run.toolActivities[idx],
          payload,
          this.deps.nowIso()
        )
      } else {
        // Orphan result — pair with a synthetic activity so the
        // outcome still surfaces. Same pattern as the renderer's
        // fallback at App.tsx:10336.
        const orphan = buildEnsembleToolActivity(
          { ...payload, type: 'tool_use', tool_id: id },
          this.deps.nowIso(),
          run.participant
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
      this.finalizeRun(run, failed ? 'failed' : run.content.trim() ? 'answered' : 'skipped')
      this.haltWorkSessionOnRepeatedFileFailures(run)
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
     * follow-up round, not just the first. Persistence into chat-
     * round state maps `e => e.prompt` for renderer back-compat.
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
    startAfterCancellation?: Promise<unknown>
  ): string {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) throw new Error('Ensemble chat not found.')
    const roundId = `ensemble-${this.deps.now()}-${Math.random().toString(36).slice(2)}`
    const orderedFull = getOrderedEnsembleParticipants(chat.ensemble, prompt)
    // A2 (1.0.3) — when DM, filter to just the targeted participant.
    // We still allow disabled participants when explicitly targeted —
    // the user clicked their chip and held Cmd, that's an unambiguous
    // intent. The filter falls back to the full ordered set if the
    // id doesn't match (safety net; should never hit in practice).
    const requestedParticipants = dmTargetParticipantId
      ? (() => {
          const target = chat.ensemble.participants.find((p) => p.id === dmTargetParticipantId)
          return target ? [target] : orderedFull
        })()
      : orderedFull
    const backgroundMentionResolution = resolveBackgroundMentions(
      prompt,
      chat.ensemble.participants
    )
    const backgroundParticipants = requestedParticipants.filter(
      (participant) =>
        isBackgroundParticipant(participant) &&
        (participant.id === dmTargetParticipantId ||
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
    const requestedFanoutPolicy = resolveRequestedEnsembleFanoutPolicy(chat.ensemble, {
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
      if (requestedConcurrentMode && concurrentCheck.reason?.includes('TASKWRAITH_CONCURRENT_LANES')) {
        effectiveConcurrentMode = false
        effectiveFanoutPolicy = 'off'
        concurrentFallbackReason = concurrentCheck.reason
      } else {
        throw new Error(concurrentCheck.reason || 'Concurrent Ensemble dispatch is not available.')
      }
    }
    const secondInCommandParticipantId =
      chat.ensemble.secondInCommandParticipantId &&
      chat.ensemble.secondInCommandParticipantId !== chat.ensemble.bossmanParticipantId &&
      roundParticipants.some(
        (participant) => participant.id === chat.ensemble!.secondInCommandParticipantId
      )
        ? chat.ensemble.secondInCommandParticipantId
        : undefined
    const round: EnsembleRoundState = {
      roundId,
      status: 'running',
      prompt,
      startedAt,
      orchestrationMode,
      continuationHops: 0,
      maxContinuationHops,
      ...(chat.ensemble.bossmanParticipantId
        ? { bossmanParticipantId: chat.ensemble.bossmanParticipantId }
        : {}),
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
      // 1.0.5-EW43a — persisted shape stays `string[]` (renderer
      // reads that for the queued-above-row); strip the
      // structured attachment objects via map here. The runtime
      // mirror lower in this method keeps the structured form so
      // the dispatch path can deliver the attachments.
      ...(carryOverQueue.length > 0
        ? {
            queuedPrompt: carryOverQueue[0].prompt,
            queuedPrompts: carryOverQueue.map((entry) => entry.prompt)
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
      imageAttachments: normalizedImageAttachments,
      imageThumbnails: normalizedImageThumbnails,
      ...(discordContextSnapshots.length > 0 ? { discordContextSnapshots } : {}),
      cancelled: false,
      queuedPrompts: [...carryOverQueue],
      ...(chat.ensemble.bossmanParticipantId
        ? { bossmanParticipantId: chat.ensemble.bossmanParticipantId }
        : {}),
      ...(secondInCommandParticipantId ? { secondInCommandParticipantId } : {}),
      bossmanBaselineParticipantIds: roundParticipants.map((participant) => participant.id),
      bossmanBaselineParticipantCount: roundParticipants.length,
      orchestrationMode,
      fanoutPolicy: effectiveFanoutPolicy,
      ...(effectiveConcurrentMode ? { concurrentMode: true } : {}),
      continuationHops: 0,
      maxContinuationHops,
      ...(startAfterCancellation ? { startAfterCancellation } : {}),
      ...(selfReflective ? { selfReflective: true } : {}),
      ...(externalPathGrants.length > 0 ? { externalPathGrants: [...externalPathGrants] } : {}),
      ...(unattended ? { unattended: true } : {}),
      ...(unattended && unattendedElevationLevel ? { unattendedElevationLevel } : {})
    }
    this.roundsByChatId.set(chatId, runtime)
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
    const backgroundAuthorityAssignments = [
      ['Boss', chat.ensemble.bossmanParticipantId],
      ['Captain', chat.ensemble.secondInCommandParticipantId],
      ['synthesizer', chat.ensemble.synthesizerParticipantId],
      ['Work Session lead', chat.ensemble.workSession?.leadParticipantId],
      ['Work Session manager', chat.ensemble.workSession?.managerParticipantId]
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
    void this.runRound(runtime, ordered, { backgroundParticipants })
    return roundId
  }

  private async runRound(
    runtime: ActiveRoundRuntime,
    participants: EnsembleParticipant[],
    // `skipPreamble` is set for a continuous-mode auto-continuation pass
    // (see `tryAutoContinueRound`): the round already ran its health probe +
    // round-start read-only fan-out on the FIRST pass, so a re-dispatched
    // continuation pass jumps straight to the serial loop rather than
    // re-probing / re-fanning-out every hop.
    options: {
      skipPreamble?: boolean
      backgroundParticipants?: EnsembleParticipant[]
    } = {}
  ): Promise<void> {
    if (runtime.startAfterCancellation) {
      await runtime.startAfterCancellation.catch(() => undefined)
      if (runtime.cancelled || this.roundsByChatId.get(runtime.chatId)?.roundId !== runtime.roundId) {
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

    if (
      !options.skipPreamble &&
      options.backgroundParticipants?.length &&
      !runtime.cancelled
    ) {
      const chatForBackground = this.deps.getChat(runtime.chatId)
      if (chatForBackground?.ensemble) {
        await this.dispatchBackgroundParticipants(
          runtime,
          chatForBackground,
          options.backgroundParticipants
        )
      }
    }

    // Parallel fan-out. Default/safe path: fan out read-only
    // participants first, then continue with writer-capable
    // participants serially. Writer-capable lanes only run in parallel
    // after either Boss authorization via ensemble_fanout or, when no
    // Boss is assigned, a host-owned user-preflight claim + ack pass.
    const chatForFanout = this.deps.getChat(runtime.chatId)
    const workSessionForFanout = chatForFanout?.ensemble?.workSession
    const roundFanoutPolicy = runtime.fanoutPolicy ?? (runtime.concurrentMode ? 'read_only' : 'off')
    const readFanoutRequested = fanoutPolicyAllowsRead(roundFanoutPolicy)
    const writerFanoutRequested = fanoutPolicyAllowsWriters(roundFanoutPolicy)
    const workSessionScoutPass =
      workSessionForFanout?.enabled &&
      workSessionForFanout.status === 'active' &&
      workSessionForFanout.enableScoutPass
    // Work Session scout pass is its own explicit Work Session setting. Preserve
    // its existing read-only scout behavior even when the chat fan-out policy is off.
    const shouldRunReadOnlyFanout =
      readFanoutRequested || Boolean(workSessionScoutPass)
    if (
      !options.skipPreamble &&
      (shouldRunReadOnlyFanout || writerFanoutRequested) &&
      !runtime.cancelled
    ) {
      const readers: EnsembleParticipant[] = []
      const writers: EnsembleParticipant[] = []
      // Spike 4 (staged fan-out) + review F1 — three-way partition:
      //   readers  — read-only-eligible, unstaged or scout → round-start
      //              parallel read pass.
      //   writers  — NOT read-only-eligible → candidates for the
      //              locked-writer fan-out block below. Stage-role REVIEWERS
      //              are excluded even when write-capable: a reviewer must
      //              never be dispatched at round start, and the
      //              user-preflight write-claim pass requires EVERY member of
      //              `writers` to produce a valid claim (review F1: a
      //              reviewer's missing claim rejected the whole preflight
      //              and it was dispatched a write-claim lane before any work
      //              existed).
      //   neither  — reviewers and read-only-eligible stage workers stay in
      //              `remaining` for the serial loop, where the reviewer
      //              stage gate defers reviewers until non-reviewers finish.
      for (const participant of remaining) {
        if (participant.stageRole === 'reviewer') continue
        const permissions = chatForFanout
          ? this.resolveFanoutEligibilityPermissions(
              chatForFanout,
              runtime,
              participant,
              'read_only'
            )
          : null
        if (permissions?.readOnly && participant.stageRole !== 'worker') {
          readers.push(participant)
        } else {
          // Everything that isn't a read-only reader goes to `writers` — including
          // an explicit stage 'worker' whose permissions resolve read-only. That
          // worker still takes a serial turn (it's write-capable in role), but it
          // must NOT be silently dropped from BOTH buckets: a stranded participant
          // left inert in `remaining` permanently defeats `eligibleWriterTail`.
          writers.push(participant)
        }
      }
      if (shouldRunReadOnlyFanout && readers.length >= 2 && chatForFanout) {
        // Remove ONLY the dispatched readers from `remaining` (preserving
        // original order) so the serial while-loop below still sees stage
        // reviewers / read-only stage workers alongside the writers.
        const readerIds = new Set(readers.map((reader) => reader.id))
        const rest = remaining.filter((participant) => !readerIds.has(participant.id))
        remaining.splice(0, remaining.length, ...rest)
        await this.runParallelFanoutPass(runtime, chatForFanout, readers, {
          mode: 'read_only'
        })
      } else if (readFanoutRequested && readers.length > 0) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          'Parallel mode requested but fewer than two read-only participants were available; continuing serially.'
        )
      }
      if (chatForFanout && writers.length > 0 && !runtime.cancelled) {
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
      const nextParticipant = remaining[0]
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
      // run the read-only-eligible reviewers as ONE parallel pass — the
      // inverse of the round-start scout pass. Wave members are spliced out
      // of `remaining` BEFORE the pass so nothing double-dispatches (the
      // pass itself does not mark fannedOutParticipantIds — only the
      // ensemble_fanout tool path does). Ineligible reviewers
      // (write-capable presets) fall through to serial turns below.
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
            entry.stageRole === 'reviewer' && !this.participantFanoutDispatchState(runtime, entry.id)
        )
        const eligibleReviewers = pendingReviewers.filter(
          (entry) =>
            this.resolveFanoutEligibilityPermissions(chat, runtime, entry, 'read_only').readOnly
        )
        if (eligibleReviewers.length >= 2) {
          const eligibleIds = new Set(eligibleReviewers.map((entry) => entry.id))
          const rest = remaining.filter((entry) => !eligibleIds.has(entry.id))
          remaining.splice(0, remaining.length, ...rest)
          await this.runParallelFanoutPass(runtime, chat, eligibleReviewers, {
            mode: 'read_only',
            label: 'Review wave'
          })
          continue
        }
      }
      let participant = remaining.shift()!
      const fanoutDispatchState = this.participantFanoutDispatchState(runtime, participant.id)
      if (fanoutDispatchState) {
        if (fanoutDispatchState === 'active') {
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `${participantDisplayName(participant)} is already running in a fan-out lane; skipping duplicate serial dispatch.`
          )
        }
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

      const run = this.seedParticipantRun(dispatchChat, runtime, participant, { sleepResumeWarning })
      runtime.activeRunId = run.runId
      const completion = new Promise<EnsembleParticipantStatus>((resolve) => {
        run.completion = resolve
      })
      const permissions = this.resolveParticipantPermissions(
        dispatchChat,
        participant,
        runtime.externalPathGrants,
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
      // session genuinely resumes across turns (claude/codex/cursor — Kimi's
      // --resume restores a token not history, Grok-ACP opens a fresh session
      // per turn, Ollama is stateless); a resume id exists; this is NOT a
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
          isCodexAppServerThreadId(
            run.providerSessionId || participant.linkedProviderSessionId
          )) &&
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
      const prompt = buildEnsembleParticipantPrompt({
        chat: dispatchChat,
        config: ensembleConfigForRound,
        participant,
        currentPrompt: resumeWakeup
          ? formatWakeupResumePrompt(runtime.prompt, resumeWakeup)
          : runtime.prompt,
        roundId: runtime.roundId,
        chatContextTurns,
        // 1.0.4-AK6 — thread fan-out briefs into the writer's prompt
        // when a parallel fan-out pass just completed. Empty array
        // (or undefined) skips the section entirely.
        scoutBriefs: runtime.scoutBriefs,
        slimTurn,
        dynamicStateSnapshot
      })
      const promptWithDiscordContext = `${prompt}${formatDiscordContextPromptAppendix(
        runtime.discordContextSnapshots
      )}${externalPathGrantPromptAppendix(permissions.externalPathGrants)}`
      // Slice D (1.0.3) — per-participant reasoning + speed + thinking
      // settings flow through the same AgentRunPayload fields the
      // composer uses for solo runs. Provider adapters already accept
      // these at the per-run level; we only fill the field that
      // matches the participant's provider so adapters don't see
      // cross-provider noise. Falls back silently when a participant
      // pre-dates the setup-sheet picker rework.
      const sharedReasoning =
        participant.provider === 'codex' ||
        (participant.provider === 'grok' && isGrok45ReasoningModelId(participant.model)) ||
        (participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model))
          ? participant.reasoningEffort
          : undefined
      const sharedServiceTier =
        participant.provider === 'codex'
          ? (participant.serviceTier ?? (participant.fastModeEnabled ? 'fast' : ''))
          : participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model)
            ? participant.fastModeEnabled
              ? 'fast'
              : ''
          : undefined
      const claudeReasoning =
        participant.provider === 'claude' ? participant.reasoningEffort : undefined
      const claudeFastMode =
        participant.provider === 'claude' ? Boolean(participant.fastModeEnabled) : undefined
      const kimiThinking =
        // Unset resolves to thinking ON — must match the renderer's
        // getDefaultEnsembleParticipantConfig('kimi').thinkingEnabled so a
        // seat whose chip displays "Thinking on" dispatches the same way.
        participant.provider === 'kimi' ? (participant.thinkingEnabled ?? true) : undefined
      const ollamaRunControls = ensembleOllamaRunControls(participant)

      const payload: AgentRunPayload = {
        provider: participant.provider,
        scope: dispatchChat.scope === 'global' ? 'global' : 'workspace',
        ...(dispatchChat.scope === 'global' ? {} : { workspace: dispatchChat.workspacePath || '' }),
        prompt: promptWithDiscordContext,
        imagePaths: imagePathsForEnsembleAttachments(runtime.imageAttachments),
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
      let dispatchedResult: { dispatched: boolean; appRunId: string } | null = null
      let dispatchFailure: DispatchFailureReason | null = null
      try {
        dispatchedResult = await this.deps.dispatch(payload, { sender: runtime.sender })
      } catch (error) {
        dispatchFailure = classifyDispatchError(error)
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
        const reason: DispatchFailureReason = dispatchFailure || { kind: 'unknown', message: '' }
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
        this.maybeAutoCompactSeatAfterTurn(runtime.chatId, participant.id)
      }
      runtime.activeRunId = undefined
      this.applyPendingParticipantSeatChangeFor(runtime, participant.id)
      const bossYieldedToUser =
        Boolean(runtime.yieldTarget) &&
        isUserYieldTarget(runtime.yieldTarget) &&
        this.isBossParticipant(chat, runtime, participant.id)
      if (bossYieldedToUser) {
        this.prepareBossYieldToUserClose(runtime)
      }
      // Short-circuit the for-loop once anything is queued — the
      // round-end handler below picks the next prompt off the array
      // and starts a fresh round. The remaining unspoken participants
      // of this round are dropped intentionally: queued sends imply
      // the user wants a new turn, not the leftover of this one.
      if (runtime.queuedPrompts.length > 0) break
      // Slice C extension (1.0.3) — if the just-finished participant
      // yielded with `target`, find that target in `remaining` and
      // shuffle it to the front so it speaks next. Resolution rules
      // (first match wins):
      //   1. exact match on participant.id (e.g. 'ensemble-codex')
      //   2. case-insensitive provider name ('Codex' / 'codex')
      //   3. case-insensitive role match ('Worker' / 'worker')
      // Unresolved targets fall through to default ordering so a
      // typo doesn't strand the round. Cleared regardless so a
      // future yield without `target` reverts to default order.
      let routedByYieldTarget = false
      if (runtime.yieldTarget) {
        if (isUserYieldTarget(runtime.yieldTarget)) {
          routedByYieldTarget = true
          this.clearYieldReturnStack(runtime)
          remaining.length = 0
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `${participant.role || providerLabel(participant.provider)} yielded to the user. Round closed.`
          )
          this.deps.notifyUserAttention?.({
            reason: 'yieldToUser',
            chatId: runtime.chatId,
            workspaceId: chat.workspaceId ?? null,
            runId: run.runId,
            roundId: runtime.roundId,
            participantId: participant.id
          })
        } else {
          const resolvedTarget = resolveYieldTargetParticipant(
            chat.ensemble.participants || [],
            runtime.yieldTarget,
            participant
          )
          if (resolvedTarget?.enabled && isBackgroundParticipant(resolvedTarget)) {
            await this.dispatchBackgroundParticipants(runtime, chat, [resolvedTarget], {
              prompt: run.content,
              sourceRunId: run.runId,
              reason: `Explicit yield from ${participantDisplayName(participant)}.`
            })
            routedByYieldTarget = true
            this.appendRoundStatus(
              runtime.chatId,
              runtime.roundId,
              `Yielded background work to ${participantDisplayName(resolvedTarget)}; foreground rotation continues.`
            )
          } else {
            const idx = resolveYieldTargetIndex(remaining, runtime.yieldTarget)
            if (idx > 0) {
              const [moved] = remaining.splice(idx, 1)
              remaining.unshift(moved)
              routedByYieldTarget = true
              this.appendRoundStatus(
                runtime.chatId,
                runtime.roundId,
                `Yielded to ${moved.role || moved.provider} (${moved.provider}).`
              )
            } else if (idx === 0) {
              routedByYieldTarget = true
            } else if (runtime.orchestrationMode === 'continuous' && resolvedTarget?.enabled) {
              routedByYieldTarget = this.tryAppendContinuationTurn(
                runtime,
                remaining,
                resolvedTarget,
                `Yielded back to ${resolvedTarget.role || resolvedTarget.provider} (${resolvedTarget.provider}).`
              ).appended
            }
          }
          if (!routedByYieldTarget) {
            this.discardYieldReturnFrameForYielder(runtime, participant.id)
          }
        }
        runtime.yieldTarget = undefined
      }
      if (!routedByYieldTarget) {
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
      // `@Sonnet 4.7`, `@Flash Lite`, `@Kimi K2.7 Code`) for the 1.0.4
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
      const allParticipants = chat?.ensemble?.participants || []
      const tagMatches = routedByYieldTarget
        ? []
        : findAllMentions(run.content, allParticipants, new Set([participant.id])).filter(
            (match): match is ParticipantMentionMatch =>
              match.kind === 'participant' && match.participant.enabled
          )

      if (tagMatches.length > 0) {
        const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
        const secondInCommandParticipantId = this.activeSecondInCommandParticipantId(chat, runtime)
        const primary = this.primaryBossUnavailable(chat, runtime, bossmanParticipantId)
        const priorityAuthorityId =
          primary.unavailable && secondInCommandParticipantId
            ? secondInCommandParticipantId
            : bossmanParticipantId
        const priorityAuthorityMatch = priorityAuthorityId
          ? tagMatches.find((tagMatch) => tagMatch.participant.id === priorityAuthorityId)
          : undefined
        const routeableTagMatches =
          priorityAuthorityMatch &&
          tagMatches.some((tagMatch) => tagMatch.participant.id !== priorityAuthorityMatch.participant.id)
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
        if (orderedTargets.length > 0) {
          const rest = remaining.filter((entry) => !remainingTargetIds.has(entry.id))
          remaining.splice(0, remaining.length, ...orderedTargets, ...rest)
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
              { allowAnsweredParticipant: isPriorityAuthority, allowYieldedParticipant: isPriorityAuthority }
            )
            if (continuation.appended) {
              // Spike 4 — an explicitly summoned extra turn outranks the
              // reviewer stage gate.
              stageGateExemptIds.add(tagged.id)
            } else if (isPriorityAuthority) {
              // The priority route couldn't be delivered. Report the ACTUAL
              // reason (hop budget vs. the Boss run failed/skipped/cancelled)
              // so the earlier "takes routing priority" note isn't left as an
              // unfulfilled promise — and isn't misattributed to the hop budget.
              const authorityLabel =
                tagged.id === bossmanParticipantId ? 'Boss' : 'active Captain'
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

    if (
      remaining.length === 0 &&
      !runtime.cancelled &&
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
          await this.runRound(runtime, [participant])
          return
        }
      }
    }

    // 1.0.4-AK3 — Work Session hard-stop check at round end.
    //
    // Before honouring a queued continuation, re-read the chat's
    // current Work Session state. AK1's `ensemble_continue` may
    // have transitioned the session to `'completed'` / `'paused'` /
    // `'limit_reached'` from within the just-finished round; the
    // user may have flipped status to `'cancelled'` via the
    // session-strip Stop button. In any of those cases we must NOT
    // dispatch the queued prompt — the session has ended and the
    // queue should drain to the user as if the round closed
    // normally.
    //
    // Also check: even if the session is still `'active'`, has the
    // duration budget elapsed? Round-budget checks happen inside
    // `ensemble_continue` BEFORE queueing (so a queued prompt that
    // got past that gate is still valid for rounds), but the
    // duration cap can lapse asynchronously while the round is
    // running. We check it here so a long-running participant
    // doesn't accidentally extend the session past its time cap.
    const chatNow = this.deps.getChat(runtime.chatId)
    const workSessionAtEnd = chatNow?.ensemble?.workSession
    const sessionStillActive = workSessionAtEnd?.enabled && workSessionAtEnd.status === 'active'

    let workSessionEnded: 'duration_exhausted' | null = null
    if (sessionStillActive && workSessionAtEnd?.startedAt && workSessionAtEnd.maxDurationMs > 0) {
      const started = new Date(workSessionAtEnd.startedAt).getTime()
      if (Number.isFinite(started) && Date.now() - started >= workSessionAtEnd.maxDurationMs) {
        workSessionEnded = 'duration_exhausted'
      }
    }

    if (workSessionEnded === 'duration_exhausted' && chatNow && workSessionAtEnd) {
      const elapsedHours = (workSessionAtEnd.maxDurationMs / (1000 * 60 * 60)).toFixed(1)
      const reason = `Duration budget reached (${elapsedHours}h).`
      this.saveChatWithCheckpoint({
        ...chatNow,
        ensemble: {
          ...chatNow.ensemble!,
          workSession: {
            ...workSessionAtEnd,
            status: 'limit_reached',
            endedAt: new Date().toISOString(),
            endedReason: reason
          }
        }
      }, 'round-updated')
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `⏱ Work Session ended: ${reason} Queued continuations dropped.`
      )
    }

    // Re-derive after possible duration-exhaustion transition.
    const chatAfterCheck = this.deps.getChat(runtime.chatId)
    const finalSessionStatus = chatAfterCheck?.ensemble?.workSession?.status
    const sessionTerminal =
      finalSessionStatus === 'completed' ||
      finalSessionStatus === 'paused' ||
      finalSessionStatus === 'cancelled' ||
      finalSessionStatus === 'limit_reached'

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
      runtime.queuedPrompts.length === 0 &&
      !sessionTerminal &&
      chatAfterCheck
    ) {
      const continuationRoster = this.tryAutoContinueRound(runtime, chatAfterCheck)
      if (continuationRoster && continuationRoster.length > 0 && !runtime.cancelled) {
        await this.runRound(runtime, continuationRoster, { skipPreamble: true })
        return
      }
    }

    // Detached `ensemble_fanout` lanes outlive their caller by design (the
    // tool returns after dispatch so the caller does not time out while its
    // lanes work). If any lane is still active — or reserved but not yet
    // seeded (the seat-compaction window inside `runParallelFanoutPass`) —
    // when the serial queue drains, closing the round now would stamp
    // `endedAt` and derive the blackboard while lane output is still
    // landing. Defer the drain tail; the last lane terminal in `finalizeRun`
    // (or the reservation release in `fanoutForRun`) replays it. Cancelled
    // rounds never defer: Stop must close the round immediately.
    if (!runtime.cancelled && this.deferDrainForActiveLanes(runtime)) return
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
    this.deferredLaneDrainByChatId.delete(chatId)
    this.finalizeDrainedRound(runtime)
  }

  /**
   * The serial drain tail: dequeue the next queued prompt (FIFO), finish the
   * round, release the runtime, and chain into the follow-up round.
   * Extracted from `runRound` so a drain deferred behind active fan-out
   * lanes replays the exact same tail when the last lane goes terminal.
   * The Work Session terminal state is re-derived here (not captured at
   * drain time) because a lane can outlive the serial loop by minutes and
   * the session may have ended in between.
   */
  private finalizeDrainedRound(runtime: ActiveRoundRuntime): void {
    const sessionStatus = this.deps.getChat(runtime.chatId)?.ensemble?.workSession?.status
    const sessionTerminal =
      sessionStatus === 'completed' ||
      sessionStatus === 'paused' ||
      sessionStatus === 'cancelled' ||
      sessionStatus === 'limit_reached'
    // Dequeue the next prompt (FIFO) for the follow-up round. Anything
    // remaining stays in `runtime.queuedPrompts` and gets transferred
    // to the new runtime in `beginRound` so the chain continues
    // through every queued message until the queue drains. When a
    // Work Session terminal state is in effect we drop the queue
    // entirely — the session is over, queued prompts would re-arm
    // it.
    //
    // 1.0.5-EW43a — `runtime.queuedPrompts` is now structured
    // `QueuedRoundEntry[]` so the per-entry image attachments
    // carry through to the follow-up round's dispatch. Pre-EW43a
    // this site dequeued bare strings and called `beginRound`
    // with `imageAttachments: []` — meaning a user who sent a
    // message with attachments DURING a running round saw the
    // attachments dropped silently when the queue drained.
    const [nextEntry, ...remainingQueue] = sessionTerminal
      ? ([] as QueuedRoundEntry[])
      : runtime.queuedPrompts
    const queuedPromptsForFinishedRound =
      nextEntry && !runtime.cancelled && !sessionTerminal
        ? runtime.queuedPrompts.map((entry) => entry.prompt)
        : []
    this.finishRound(runtime.chatId, runtime.roundId, runtime.cancelled ? 'cancelled' : 'completed', {
      queuedPrompts: queuedPromptsForFinishedRound
    })
    this.clearRuntimeIfCurrent(runtime)
    if (nextEntry && !runtime.cancelled && !sessionTerminal) {
      this.beginRound(
        runtime.chatId,
        nextEntry.prompt,
        runtime.sender,
        undefined,
        nextEntry.imageAttachments,
        nextEntry.imageThumbnails ?? [],
        remainingQueue,
        false,
        nextEntry.externalPathGrants ?? [],
        undefined,
        nextEntry.fanoutPolicy,
        nextEntry.discordContextSnapshots
      )
    }
  }

  /**
   * Work-session supervisor guard: after a participant run completes, if it
   * left a file with MAX_CONSECUTIVE_FILE_EDIT_FAILURES or more consecutive
   * failed edits (no successful write in between), halt the Work Session
   * instead of letting it keep queueing rounds at an unfixable file. Mirrors
   * the duration / round budget halt — transition to `limit_reached` + a status
   * row; the round-end logic then drops queued continuations. No-op outside an
   * active Work Session.
   */
  private haltWorkSessionOnRepeatedFileFailures(run: ActiveParticipantRun): void {
    const worst = worstConsecutiveFileEditFailure(run.toolActivities)
    if (!worst || worst.failures < MAX_CONSECUTIVE_FILE_EDIT_FAILURES) return
    const chat = this.deps.getChat(run.chatId)
    const workSession = chat?.ensemble?.workSession
    if (!chat?.ensemble || !workSession?.enabled || workSession.status !== 'active') return
    const who = run.participant.role || run.participant.provider
    const reason = `${who} failed to edit ${worst.filePath} ${worst.failures} times in a row with no successful write.`
    this.saveChatWithCheckpoint(
      {
        ...chat,
        ensemble: {
          ...chat.ensemble,
          workSession: {
            ...workSession,
            status: 'limit_reached',
            endedAt: this.deps.nowIso(),
            endedReason: reason
          }
        }
      },
      'round-updated'
    )
    this.appendRoundStatus(
      run.chatId,
      run.roundId,
      `🛑 Work Session halted: ${reason} Queued continuations dropped — fix the file or give guidance, then start a new round.`
    )
  }

  private resolveFanoutTargets(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun,
    rawTargets: unknown,
    mode: EnsembleFanoutMode,
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
    const isEligible = (participant: EnsembleParticipant): boolean => {
      if (!participant.enabled) return false
      if (participant.id === run.participant.id) return false
      if (activeParticipantIds.has(participant.id)) return false
      // A target can be reserved for a concurrent ensemble_fanout call whose
      // lane runs are not yet seeded into runsByRunId (the seat-compaction
      // barrier holds that window open for seconds). '=== active' keeps
      // participants whose lane already SETTLED re-targetable, as before.
      if (this.participantFanoutDispatchState(runtime, participant.id) === 'active') return false
      if (!fanoutTargetStageMatches(participant, targetStage)) return false
      if (mode === 'locked_writers') return true
      return this.resolveFanoutEligibilityPermissions(chat, runtime, participant, mode).readOnly
    }
    if (explicitTargets.length === 0 || explicitTargets.some((target) => /^@?all$/i.test(target))) {
      const targets = participants.filter(isEligible)
      if (targets.length === 0) {
        return {
          ok: false,
          message:
            mode === 'locked_writers'
              ? 'ensemble_fanout: no enabled, idle peer participants are available.'
              : 'ensemble_fanout: no enabled, idle read-only peer participants are available.',
          error: 'no_eligible_targets'
        }
      }
      return { ok: true, targets }
    }

    const targets: EnsembleParticipant[] = []
    for (const rawTarget of explicitTargets) {
      const target = stripLeadingAt(rawTarget)
      const participant = resolvePhraseToParticipant(target, participants, new Set([run.participant.id]))
      if (!participant || !participant.enabled) {
        return {
          ok: false,
          message: `ensemble_fanout: target "${rawTarget}" did not resolve to an enabled participant.`,
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
      if (mode === 'read_only') {
        const permissions = this.resolveFanoutEligibilityPermissions(
          chat,
          runtime,
          participant,
          mode
        )
        if (!permissions.readOnly) {
          return {
            ok: false,
            message: `ensemble_fanout: target "${rawTarget}" is not read-only. Use mode=locked_writers with TASKWRAITH_CONCURRENT_WRITE_LANES enabled for writer-capable lanes.`,
            error: 'invalid_target'
          }
        }
      }
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
    const participants = chat.ensemble?.participants || []
    const workSession = chat.ensemble?.workSession
    if (!workSession?.enabled || workSession.status !== 'active' || workSession.allowedParticipantIds === null) {
      return participants
    }
    const allowed = new Set(workSession.allowedParticipantIds)
    return participants.filter((participant) => allowed.has(participant.id))
  }

  private canRequestBroadFanout(chat: ChatRecord, run: ActiveParticipantRun): boolean {
    const ensemble = chat.ensemble
    if (!ensemble) return false
    if (isBackgroundParticipant(run.participant)) return false
    const runtime = this.roundsByChatId.get(run.chatId)
    if (runtime && this.resolveBossAuthorityForCaller(chat, runtime, run.participant.id).ok) {
      return true
    }
    const workSession = ensemble.workSession
    const authorityIds = new Set(
      [
        ensemble.bossmanParticipantId,
        workSession?.leadParticipantId,
        workSession?.managerParticipantId
      ].filter(Boolean) as string[]
    )
    if (authorityIds.has(run.participant.id)) return true
    return Boolean(
      workSession?.enabled &&
        workSession.status === 'active' &&
        Array.isArray(workSession.allowedParticipantIds) &&
        workSession.allowedParticipantIds.includes(run.participant.id)
    )
  }

  /**
   * Explicit BG routing reuses the normal fan-out lane executor, but automatic
   * @mention/yield launches are always read-only. This keeps shell/test/recon
   * useful while reserving asynchronous mutations for the existing
   * Boss-authorized locked-writer path with explicit write scopes.
   */
  private async dispatchBackgroundParticipants(
    runtime: ActiveRoundRuntime,
    chat: ChatRecord,
    requested: EnsembleParticipant[],
    options: { prompt?: string; sourceRunId?: string; reason?: string } = {}
  ): Promise<string[]> {
    if (!concurrentLanesEnabled()) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        'Background dispatch not launched because parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0).'
      )
      return []
    }
    const requestedBackgrounds = dedupeParticipants(requested).filter(isBackgroundParticipant)
    const alreadyActive = requestedBackgrounds.filter(
      (participant) => this.participantFanoutDispatchState(runtime, participant.id) === 'active'
    )
    if (alreadyActive.length > 0) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Background dispatch not launched for ${alreadyActive
          .map(participantDisplayName)
          .join(', ')}: that seat already has an active lane. Wait for its result, then delegate again.`
      )
    }
    const candidates = requestedBackgrounds.filter(
      (participant) =>
        this.participantFanoutDispatchState(runtime, participant.id) !== 'active'
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
    if (participants.length === 0 || runtime.cancelled) return []

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
      const laneIds = await this.runParallelFanoutPass(runtime, latestChat, participants, {
        prompt: options.prompt,
        reason: options.reason,
        mode: 'read_only',
        sourceRunId: options.sourceRunId,
        label: 'Background',
        forceReadOnlyDispatch: true,
        waitForCompletion: false,
        completionDisposition: 'background'
      })
      runtime.fannedOutParticipantIds ??= new Set()
      for (const participant of participants) {
        runtime.fannedOutParticipantIds.add(participant.id)
      }
      this.incrementBossmanBudgetUsage(
        runtime,
        participants.map((participant) => participant.id),
        { fanoutCalls: 1 }
      )
      return laneIds
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'background dispatch failed.'
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `Background dispatch failed: ${message}`
      )
      return []
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
      forceReadOnlyDispatch?: boolean
      writeScopesByParticipantId?: Map<string, ConcurrentLaneWriteScope[]>
      onCompleteRuns?: (runs: ActiveParticipantRun[]) => void
      waitForCompletion?: boolean
      completionDisposition?: 'serial' | 'caller' | 'background'
    } = {}
  ): Promise<string[]> {
    if (participants.length === 0) return []
    const mode = options.mode || 'read_only'
    if (mode === 'locked_writers' && !concurrentWriteLanesEnabled()) {
      throw new Error('Locked writer fan-out requires TASKWRAITH_CONCURRENT_WRITE_LANES.')
    }
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

    if (!runtime.activeScoutRunIds) runtime.activeScoutRunIds = new Set<string>()

    const readOnlyCount = participants.filter((participant) => {
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      return this.resolveFanoutDispatchPermissions(chat, runtime, participant, dispatchMode).readOnly
    }).length
    const writeCount = participants.length - readOnlyCount
    const label =
      options.label ||
      (mode === 'locked_writers'
        ? 'Locked writer fan-out'
        : 'Parallel fan-out')
    const ollamaLaneCount = participants.filter((p) => p.provider === 'ollama').length
    const ollamaRamNote =
      ollamaLaneCount >= 2
        ? ` ${ollamaLaneCount} Ollama lane(s) — local models share RAM; expect slower loads when multiple quants are resident.`
        : ''
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      writeCount > 0
        ? `${label} · ${participants.length} participant(s) dispatched concurrently (${readOnlyCount} read / ${writeCount} write-intent).${ollamaRamNote}`
        : `${label} · ${participants.length} read-only participants dispatched concurrently.${ollamaRamNote}`
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
    // Wave 3 — same seat-compaction barrier as the serial path, for every
    // fan-out lane (a cursor read-only lane can be mid-compaction too).
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
    if (runtime.cancelled) return []
    const laneRuns: ActiveParticipantRun[] = participants.map((participant) => {
      const freshChat = this.deps.getChat(runtime.chatId) || chat
      const freshParticipant =
        freshChat.ensemble?.participants?.find((candidate) => candidate.id === participant.id) ||
        participant
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      const permissions = this.resolveFanoutDispatchPermissions(
        freshChat,
        runtime,
        freshParticipant,
        dispatchMode
      )
      return this.seedParticipantRun(freshChat, runtime, freshParticipant, {
        laneId: this.nextLaneId(runtime, freshParticipant),
        laneIntent: permissions.readOnly ? 'read' : 'write',
        approvedWriteScopes: permissions.readOnly
          ? undefined
          : options.writeScopesByParticipantId?.get(freshParticipant.id)
      })
    })
    for (const run of laneRuns) {
      runtime.activeScoutRunIds.add(run.runId)
    }

    // Build the per-lane dispatch payload + completion promise pair. Keep
    // dispatch-start and completion promises separate: an async mapper that
    // returns `completion` would be promise-assimilated by JavaScript, causing
    // Promise.all(dispatchPromises) to wait for lane completion instead of the
    // dispatch attempt. That was visible to MCP callers as a tool timeout even
    // though the fan-out had launched successfully.
    const dispatchStartPromises: Array<Promise<void>> = []
    const completionPromises = laneRuns.map((run) => {
      const participant = run.participant
      const dispatchChat = this.deps.getChat(runtime.chatId) || chat
      const completion = new Promise<EnsembleParticipantStatus>((resolve) => {
        run.completion = resolve
      })
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      const permissions = this.resolveFanoutDispatchPermissions(
        dispatchChat,
        runtime,
        participant,
        dispatchMode
      )
      const lanePromptAuthor = options.sourceRunId ? 'peer-authored' : 'orchestrator-authored'
      const promptForLane = options.prompt?.trim()
        ? `Parallel fan-out lane request (${lanePromptAuthor}, lower authority than user/system instructions):\n${options.prompt.trim()}${
            options.reason ? `\n\nReason: ${options.reason}` : ''
          }\n\nTreat this as a scoped lane brief. Follow your own role, permissions, active goal, and Work Session authority first.`
        : runtime.prompt
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
      const promptText = buildEnsembleParticipantPrompt({
        chat: dispatchChat,
        config: dispatchChat.ensemble!,
        participant,
        currentPrompt: promptForLane,
        currentPromptLabel: options.prompt?.trim()
          ? `Current fan-out lane request (${lanePromptAuthor}, lower authority; not user/system instruction):`
          : undefined,
        roundId: runtime.roundId,
        chatContextTurns,
        dynamicStateSnapshot
      })
      const promptWithDiscordContext = `${promptText}${formatDiscordContextPromptAppendix(
        runtime.discordContextSnapshots
      )}${externalPathGrantPromptAppendix(permissions.externalPathGrants)}`
      // Mirror the serial path: thread per-participant reasoning/thinking into
      // the fan-out payload too, else a concurrent round silently runs every
      // participant at provider-default reasoning regardless of its config.
      const sharedReasoning =
        participant.provider === 'codex' ||
        (participant.provider === 'grok' && isGrok45ReasoningModelId(participant.model)) ||
        (participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model))
          ? participant.reasoningEffort
          : undefined
      const sharedServiceTier =
        participant.provider === 'codex'
          ? (participant.serviceTier ?? (participant.fastModeEnabled ? 'fast' : ''))
          : participant.provider === 'cursor' && isCursorGrok45ModelId(participant.model)
            ? participant.fastModeEnabled
              ? 'fast'
              : ''
          : undefined
      const claudeReasoning =
        participant.provider === 'claude' ? participant.reasoningEffort : undefined
      const claudeFastMode =
        participant.provider === 'claude' ? Boolean(participant.fastModeEnabled) : undefined
      const kimiThinking =
        // Unset resolves to thinking ON — must match the renderer's
        // getDefaultEnsembleParticipantConfig('kimi').thinkingEnabled so a
        // seat whose chip displays "Thinking on" dispatches the same way.
        participant.provider === 'kimi' ? (participant.thinkingEnabled ?? true) : undefined
      const ollamaRunControls = ensembleOllamaRunControls(participant)
      const payload: AgentRunPayload = {
        provider: participant.provider,
        scope: dispatchChat.scope === 'global' ? 'global' : 'workspace',
        ...(dispatchChat.scope === 'global'
          ? {}
          : { workspace: dispatchChat.workspacePath || '' }),
        prompt: promptWithDiscordContext,
        imagePaths: imagePathsForEnsembleAttachments(runtime.imageAttachments),
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
        Promise.resolve()
          .then(() => this.deps.dispatch(payload, { sender: runtime.sender }))
          .then((dispatched) => {
            if (!dispatched.dispatched) {
              if (this.runsByRunId.get(run.runId) === run) {
                const note = formatDispatchFailureNote(participant, { kind: 'unknown', message: '' })
                this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
                this.finalizeRun(run, 'failed', note)
              }
            } else {
              // Candidate only after the adapter confirms it accepted the
              // prompt. flushRun persists it only after an eligible terminal
              // response, matching the serial dispatch contract.
              run.promptShellStamp = promptShellStamp
              run.promptDynamicStateVersion = dynamicStateSnapshot.version
              run.ensemblePromptUsageTelemetry = promptUsageTelemetry
            }
          })
          .catch((error) => {
            if (this.runsByRunId.get(run.runId) === run) {
              const reason = classifyDispatchError(error)
              const note = formatDispatchFailureNote(participant, reason)
              this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
              this.finalizeRun(run, 'failed', note)
            }
          })
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
    if (runtime.cancelled) {
      if (options.waitForCompletion === false) return laneIds
      return []
    }
    const finishFanoutPass = async (): Promise<void> => {
      await Promise.all(completionPromises)
      if (runtime.cancelled) {
        for (const run of laneRuns) {
          runtime.activeScoutRunIds?.delete(run.runId)
        }
        if (runtime.activeScoutRunIds?.size === 0) {
          runtime.activeScoutRunIds = undefined
        }
        return
      }
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

      for (const run of laneRuns) {
        runtime.activeScoutRunIds?.delete(run.runId)
      }
      if (runtime.activeScoutRunIds?.size === 0) {
        runtime.activeScoutRunIds = undefined
      }

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
          return options.completionDisposition === 'caller' || options.sourceRunId
            ? `${label} complete · ${laneRuns.length} lane(s) returned to the caller.`
            : `${label} complete · returning to serial writer step.`
        })()
      )
    }

    if (options.waitForCompletion === false) {
      void finishFanoutPass().catch((error) => {
        const message =
          error instanceof Error ? error.message : 'fan-out completion tracking failed.'
        this.appendRoundStatus(runtime.chatId, runtime.roundId, `${label} tracking failed: ${message}`)
      })
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
      ...(options.approvedWriteScopes?.length
        ? { approvedWriteScopes: options.approvedWriteScopes }
        : {}),
      participant,
      promptMessageId,
      assistantMessageId,
      startedAt,
      content: '',
      status: 'running'
    }
    this.runsByRunId.set(runId, activeRun)
    const updatedRuns = [...chat.runs, run]
    this.saveChatWithCheckpoint({
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
    }, 'participant-updated')
    return activeRun
  }

  private activeRoundParticipantStatus(
    runtime: ActiveRoundRuntime,
    participantId: string
  ): EnsembleParticipantStatus | undefined {
    const round = this.deps.getChat(runtime.chatId)?.ensemble?.activeRound
    if (!round || round.roundId !== runtime.roundId) return undefined
    return round.participants.find((participant) => participant.participantId === participantId)?.status
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

  private tryAppendContinuationTurn(
    runtime: ActiveRoundRuntime,
    remaining: EnsembleParticipant[],
    participant: EnsembleParticipant,
    statusMessage: string,
    // `allowYieldedParticipant` re-summons a participant who explicitly yielded
    // (yield-return). `allowAnsweredParticipant` re-summons one who already
    // answered normally — used only by explicit authority continuations:
    // Boss/Captain priority @-mentions back to the authority, and
    // ensemble_bossman_control({ action: 'summon_participant' }). Neither bypasses
    // 'skipped'/'failed'/'cancelled'/'unreachable' (those mean the participant
    // errored out or was removed — re-summoning is a different, riskier concern).
    options: { allowYieldedParticipant?: boolean; allowAnsweredParticipant?: boolean } = {}
  ): ContinuationTurnResult {
    if (runtime.orchestrationMode !== 'continuous') return { appended: false, reason: 'not_continuous' }
    if (runtime.unreachableParticipantIds?.has(participant.id))
      return { appended: false, reason: 'unreachable' }
    if (this.participantFanoutDispatchState(runtime, participant.id)) {
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
      this.notifyContinuationLimitReached(runtime)
      return { appended: false, reason: 'hop_limit' }
    }
    const budgetBlock = this.bossmanBudgetBlock(runtime, participant.id, 'extra_turn')
    if (budgetBlock) {
      this.appendRoundStatus(
        runtime.chatId,
        runtime.roundId,
        `${participantDisplayName(participant)} was not given an extra turn: ${budgetBlock}.`
      )
      return { appended: false, reason: 'budget_exhausted', budgetMessage: budgetBlock }
    }
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
   * Continuous-mode AUTONOMOUS continuation. When the serial loop drains with no
   * explicit yield/@-mention handoff, a `'continuous'` round must not silently
   * end at the round boundary (`finishRound`) — it keeps re-dispatching the full
   * roster for another pass until a stop condition fires. Returns the roster to
   * run next (each participant costs one continuation hop), or `null` to stop.
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
   *
   * A permission-elevation stall needs no check here (it blocks `await completion`
   * upstream, so this drain point is unreachable while a run is paused for
   * approval); work-session-terminal + queued-prompt + pending-wakeup priority are
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
    if (!anyProducedContent) return null
    if (runtime.continuationHops >= runtime.maxContinuationHops) {
      this.notifyContinuationLimitReached(runtime)
      return null
    }
    if (!chat.ensemble) return null
    const roster = getOrderedEnsembleParticipants(chat.ensemble, runtime.prompt).filter(
      (participant) =>
        participant.enabled &&
        !isBackgroundParticipant(participant) &&
        !runtime.unreachableParticipantIds?.has(participant.id) &&
        !this.activeBossmanQuarantine(chat, runtime.roundId, participant.id) &&
        !this.bossmanBudgetBlock(runtime, participant.id, 'extra_turn')
    )
    if (roster.length === 0) return null
    const fresh: EnsembleParticipant[] = []
    for (const participant of roster) {
      if (runtime.continuationHops >= runtime.maxContinuationHops) {
        this.notifyContinuationLimitReached(runtime)
        break
      }
      runtime.continuationHops += 1
      fresh.push(participant)
    }
    if (fresh.length === 0) return null
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
            maxContinuationHops: runtime.maxContinuationHops
          }
        : round
    )
    this.appendRoundStatus(
      runtime.chatId,
      runtime.roundId,
      `Continuous mode: no explicit handoff — auto-continuing for another pass (${runtime.continuationHops}/${runtime.maxContinuationHops} hops). Mark the goal complete to stop.`
    )
    return fresh
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
    const promoteOverflowEvidence =
      status === 'failed' &&
      run.classifiedContextOverflow === true &&
      isHostSeatCompactionProvider(run.participant.provider)
    run.status = status
    const runtime = this.roundsByChatId.get(run.chatId)
    if (runtime?.roundId === run.roundId) {
      this.incrementBossmanBudgetUsage(
        runtime,
        [run.participant.id],
        this.bossmanRunBudgetUsage(run)
      )
    }
    this.flushRun(run, true, reason)
    this.reconcileBossmanControlAfterRun(run, status)
    this.transitionParticipantRunQueueJob(run, status, reason)
    this.participantWorkingTelemetryByRunId.delete(run.runId)
    this.deps.onParticipantWorkingTelemetry?.({
      type: 'clear',
      chatId: run.chatId,
      roundId: run.roundId,
      participantId: run.participant.id,
      runId: run.runId
    })
    if (run.laneId) {
      try {
        this.deps.releaseWriteIntentsForLane?.(run.laneId)
      } catch {
        // Lock cleanup is best-effort; the in-memory registry is defensive.
      }
    }
    this.runsByRunId.delete(run.runId)
    // Promote only after the terminal transcript/queue flush and active-run
    // deletion. Resolving completion last guarantees serial/fanout maintenance
    // cannot observe the evidence while the failed provider callback is still
    // unwinding.
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
    this.maybeResumeDeferredDrain(run.chatId)
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
    const run = this.runsByRunId.get(appRunId)
    if (!run) return
    run.mediaRefs = mergeTranscriptMediaRefs(run.mediaRefs, refs)
    this.flushRun(run)
  }

  private flushRun(run: ActiveParticipantRun, final = false, reason?: string): void {
    if (run.flushTimer) {
      clearTimeout(run.flushTimer)
      run.flushTimer = undefined
    }
    const chat = this.deps.getChat(run.chatId)
    if (!chat?.ensemble) return
    const timestamp = this.deps.nowIso()
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
    const timeline = run.timeline || []
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
          parsedPlan &&
            shouldStampEnsembleProposedPlan(chat, run.roundId, run.participant.id)
        )
        const previousPlan = shouldStampEnsembleProposedPlan(
          chat,
          run.roundId,
          run.participant.id
        )
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
            ensembleStatus: run.status,
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
            // High" / "Opus 4.7 · Max" / "K2.7 Code Thinking" — matching
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
    if (run.mediaRefs && run.mediaRefs.length > 0) {
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
            ensembleStatus: run.status,
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
      final &&
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
          ensembleStatus: run.status,
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
      final &&
      !run.invalidatePromptDynamicStateReceipt &&
      Boolean(run.promptDynamicStateVersion) &&
      isDynamicStateReceiptTerminalStatus(run.status)
    const shouldPersistPromptShellReceipt =
      final &&
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
        status: final ? statusToRunStatus(run.status) : existingRun.status || 'running',
        endedAt: final ? timestamp : existingRun.endedAt,
        ...(run.status === 'sleeping'
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
    const participants = (chat.ensemble.participants || []).map((participant) => {
      if (participant.id !== run.participant.id) return participant
      const tokenTotals = mergeTokenTotals(participant.tokenTotals, run.stats)
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
          status: run.status,
          runId: run.runId,
          ...(reason ? { reason } : {}),
          ...(final ? { endedAt: timestamp } : {})
        },
        { setActive: !run.laneId }
      ),
      run.laneId,
      run.status,
      timestamp,
      reason
    )
    // Blackboard delta bookkeeping — the entries injected into this run's
    // prompt are now part of the seat's session memory. Idempotent + same-ref
    // when nothing changes, so repeat flushes cost nothing.
    const blackboard = markBlackboardEntriesSeen(
      chat.ensemble.blackboard || [],
      run.injectedBlackboardEntryIds || [],
      run.participant.id
    )
    this.saveChatWithCheckpoint({
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
    }, 'participant-updated')
    if (final) this.deps.releaseProviderSessionPersistenceDecision?.(run.runId)
  }

  private scheduleFlush(run: ActiveParticipantRun): void {
    if (run.flushTimer) return
    run.flushTimer = setTimeout(() => this.flushRun(run), 250)
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
    options: { queuedPrompts?: string[] } = {}
  ): void {
    const runtime = this.roundsByChatId.get(chatId)
    if (runtime?.roundId === roundId) {
      this.clearYieldReturnStack(runtime)
      runtime.pendingParticipantSeatChanges = undefined
    }
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return
    const endedAt = this.deps.nowIso()
    const activeRound = chat.ensemble.activeRound
    if (activeRound?.roundId !== roundId) return
    const nextRound: EnsembleRoundState = {
      ...activeRound,
      status,
      activeParticipantId: undefined,
      queuedPrompt: options.queuedPrompts?.[0],
      queuedPrompts: options.queuedPrompts ?? [],
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
        nextBlackboard = derived.reduce(
          (acc, entry) => upsertBlackboardEntry(acc, entry),
          chat.ensemble.blackboard || []
        )
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
            completedRoundCount:
              (chat.ensemble.bossmanControlState?.completedRoundCount || 0) + 1
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
    if (runtime?.roundId === roundId) {
      this.applyPendingRoundEndParticipantSeatChanges(runtime)
    }
    this.maybeAutoCompactSeatsAfterRound(chatId, status)
  }

  private appendRoundStatus(chatId: string, roundId: string, content: string): void {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return
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
    this.saveChatWithCheckpoint({
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
            ensembleRoundId: roundId
          }
        }
      ],
      updatedAt: this.deps.now()
    }, 'round-updated')
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
    this.saveChatWithCheckpoint({
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
    }, 'round-updated')
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
   * compaction may have cleared the cursor seat's session id, and dispatching
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
        participant.linkedProviderSessionId = refreshed.linkedProviderSessionId
        participant.contextCompactionSummary = refreshed.contextCompactionSummary
        participant.promptShellVersion = refreshed.promptShellVersion
        participant.promptDynamicStateVersion = refreshed.promptDynamicStateVersion
        participant.taskWraithMcpProfileReceipt = refreshed.taskWraithMcpProfileReceipt
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
      participant.linkedProviderSessionId = refreshed.linkedProviderSessionId
      participant.contextCompactionSummary = refreshed.contextCompactionSummary
      participant.promptShellVersion = refreshed.promptShellVersion
      participant.promptDynamicStateVersion = refreshed.promptDynamicStateVersion
      participant.taskWraithMcpProfileReceipt = refreshed.taskWraithMcpProfileReceipt
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
  ):
    | {
        chatId: string
        participantId: string
        provider: HostSeatCompactionProvider
        trigger: 'auto'
      }
    | null {
    if (this.deps.getSettings().hostAutoCompactEnabled === false) return null
    if (!isHostSeatCompactionProvider(participant.provider)) return null
    if (participant.enabled === false) return null
    if (participant.provider === 'cursor' && !participant.linkedProviderSessionId) return null
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
   * Wave 3 — post-round host auto-compaction for cursor/kimi/grok seats (the
   * providers with no native lever). Runs in the idle dead-time after a
   * COMPLETED round: deferred a tick so a chained queued round is visible.
   * Kimi may refresh its non-destructive durable summary when exact transcript
   * projection proves rows fell outside the live prompt window. Generic run
   * usage remains advisory and cannot reset Cursor/Grok sessions.
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
          if (participant.provider === 'cursor' && !participant.linkedProviderSessionId) continue
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
  }

  private resolveFanoutEligibilityPermissions(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    mode: EnsembleFanoutMode
  ): EffectiveRunPermissions {
    return this.resolveParticipantPermissions(
      chat,
      participant,
      runtime.externalPathGrants,
      mode === 'read_only'
        ? {
            ignoreWorkSessionOverride: true,
            ...(isBackgroundParticipant(participant)
              ? { disallowTrustedSession: true }
              : {})
          }
        : isBackgroundParticipant(participant)
          ? { disallowTrustedSession: true }
          : {}
    )
  }

  private resolveFanoutDispatchPermissions(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    participant: EnsembleParticipant,
    mode: EnsembleFanoutMode
  ): EffectiveRunPermissions {
    return this.resolveParticipantPermissions(
      chat,
      participant,
      runtime.externalPathGrants,
      mode === 'read_only'
        ? {
            presetId: 'read_only',
            ignoreWorkSessionOverride: true,
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

  private resolveParticipantPermissions(
    chat: ChatRecord,
    participant: EnsembleParticipant,
    explicitExternalPathGrants?: ExternalPathGrant[],
    options: {
      ignoreWorkSessionOverride?: boolean
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
    // regardless of preset / overrides / work-session config. This is
    // the single chokepoint for both the serial writer and every
    // fan-out lane, and the read_only preset resolves to approvalMode
    // 'plan' + readOnly:true, so both signing sites sign the safe
    // posture automatically.
    const round = this.roundsByChatId.get(chat.appChatId)
    const roundUnattended = round?.unattended === true
    if (roundUnattended) {
      // P2 — a VERIFIED elevation lifts the uniform posture from read-only to the
      // level's preset (full_access → workspace_write, default → default). No
      // verified elevation ⇒ P1b read-only. The level was HMAC-verified main-side
      // before reaching the runtime, so it's a trusted capability here; the preset
      // still flows through resolveEffectiveRunPermissions (approval gates intact).
      const previewRiskModel = isPreviewRiskModel(participant.provider, participant.model)
      const elevatedPreset = round?.unattendedElevationLevel && !previewRiskModel
        ? unattendedElevationPresetId(round.unattendedElevationLevel)
        : undefined
      return resolveEffectiveRunPermissions({
        provider: participant.provider,
        workspacePath: chat.scope === 'global' ? undefined : chat.workspacePath,
        model: participant.model,
        settings: this.deps.getSettings(),
        presetId: elevatedPreset || 'read_only',
        // Elevated → force-deny network egress (workspace_write/default don't set
        // it → settings default 'allow'); read_only already denies it via its preset.
        overrides: elevatedPreset ? { networkAccess: 'deny' } : null
        // Deliberately drop explicitExternalPathGrants either way: an unattended
        // round must not widen file access via composer-supplied grants.
      })
    }
    // 1.0.4-AK3 — Work Session permission clamp. When an active
    // Work Session is in flight, the session-wide
    // `permissionPresetId` overrides per-participant presets for
    // the duration of the session. This lets the user clamp the
    // entire panel's authority via one knob (e.g. "no writes for
    // this whole session" → `read_only`) without editing each
    // participant individually.
    //
    // CRITICAL — the override is fed INTO
    // `resolveEffectiveRunPermissions`, NOT a bypass of it. The
    // workspace-grant + overrides + EffectiveRunPermissions
    // resolution still happens normally; we're just substituting
    // the input `presetId`. Approval gates still fire.
    //
    // Skipped when the session is not 'active' — paused / completed
    // / cancelled / limit_reached sessions revert to participant
    // presets so the user can resume an interactive round without
    // the session config lingering.
    const workSession = chat.ensemble?.workSession
    const sessionActive =
      workSession?.enabled &&
      workSession?.status === 'active' &&
      !options.ignoreWorkSessionOverride &&
      !options.presetId
    const requestedPresetId =
      options.presetId || (sessionActive ? workSession.permissionPresetId : participant.permissionPresetId)
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
    (typeof snapshot.agentId === 'string' && snapshot.agentId.trim()
      ? snapshot.agentId.trim()
      : '')
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
    ...(typeof snapshot.accent === 'string' && snapshot.accent
      ? { accent: snapshot.accent }
      : {}),
    ...(typeof snapshot.slug === 'string' && snapshot.slug ? { slug: snapshot.slug } : {}),
    ...(typeof snapshot.assetKey === 'string' && snapshot.assetKey
      ? { assetKey: snapshot.assetKey }
      : {}),
    ...(typeof snapshot.seed === 'string' && snapshot.seed ? { seed: snapshot.seed } : {}),
    ...(typeof snapshot.hueEnabled === 'boolean' ? { hueEnabled: snapshot.hueEnabled } : {})
  }
  return { pooledAgentId: agentId, pooledAgentIdentity }
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

function numericRunStat(stats: Record<string, unknown>, ...paths: Array<string | string[]>): number {
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
    const tokens = input + output
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

function resolveYieldTargetParticipant(
  participants: EnsembleParticipant[],
  target: string,
  speaker?: EnsembleParticipant
): EnsembleParticipant | null {
  const trimmed = stripLeadingAt(target || '')
  if (!trimmed) return null
  const lc = trimmed.toLowerCase()
  if (lc === 'me' || lc === 'self' || lc === 'user' || lc === 'human') return null
  const byId = participants.find((p) => p.id === trimmed)
  if (byId && byId.id !== speaker?.id) return byId
  const resolved = resolvePhraseToParticipant(
    trimmed,
    participants,
    speaker ? new Set([speaker.id]) : undefined
  )
  return resolved || null
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
 * `@Flash Lite`, `@Kimi K2.7 Code`) without losing the trailing words.
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
