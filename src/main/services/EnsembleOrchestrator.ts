import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  unattendedElevationPresetId,
  type UnattendedElevationLevel
} from '../UnattendedPostureGate'
import type { RunPermissionPostureContext } from '../RunPermissionPosture'
import {
  buildEnsembleParticipantPrompt,
  getOrderedEnsembleParticipants,
  providerLabel
} from '../EnsemblePrompt'
import type {
  AppSettings,
  ChatMessage,
  ChatRecord,
  ChatRun,
  ConcurrentLane,
  ConcurrentLaneWriteScope,
  EffectiveRunPermissions,
  EnsembleConfig,
  EnsembleFanoutPolicy,
  EnsembleOrchestrationMode,
  EnsembleParticipant,
  EnsembleParticipantStatus,
  EnsembleRunIdentity,
  EnsembleRoundState,
  EnsembleWakeupRecord,
  ExternalPathGrant,
  PooledAgentIdentitySnapshot,
  ProviderId,
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
import type { ScoutBriefRecord } from '../ScoutBrief'
import { updateActiveGoalLifecycle } from '../GoalState'
import { findTerminalSynthesizerRoundSummary } from '../EnsembleRoundSummary'
import { mergeTranscriptMediaRefs } from './TranscriptMediaService'
import { sanitizeRawProviderMediaRefs } from '../../shared/transcriptMediaRefSanitize'
// M4 (1.0.7) — auto-derive blackboard entries from the synthesizer's
// round summary at round end, so the panel's agreed decisions / risks /
// corrections propagate to next round's prompts as a compact digest.
import {
  deriveBlackboardFromRoundSummary,
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
import { buildLaneId, canStartConcurrentRound, createLane, transitionLane } from '../EnsembleLanes'
import { concurrentLanesEnabled, concurrentWriteLanesEnabled } from '../featureGates'
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
import { isPreviewRiskModel } from '../../shared/previewModelCatalog'
import {
  evaluateRosterEdit,
  type RosterEditAction,
  type RosterEditError,
  type RosterEditParticipantInput,
  type RosterEditRequest
} from '../EnsembleRosterMutation'
import { selectableProviderIds } from '../settings/MainSanitizers'

export type EnsembleRunMode = 'normal' | 'queue' | 'steer'
export type EnsembleQueuedSteerResult = {
  status: 'steered' | 'ignored'
  roundId?: string
  error?: string
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

const DEFAULT_CONTINUATION_HOP_LIMIT = 6
const MAX_CONTINUATION_HOP_LIMIT = 500
const ENSEMBLE_IMAGE_ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff|tif|svg|jfif)(\?.*)?$/i

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
  dispatch: (
    payload: AgentRunPayload,
    event: EnsembleDispatchEvent
  ) => Promise<{ dispatched: boolean; appRunId: string }>
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

interface ActiveParticipantRun {
  chatId: string
  roundId: string
  runId: string
  laneId?: string
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

export interface EnsembleFanoutInput {
  targets?: unknown
  prompt?: string
  reason?: string
  mode?: EnsembleFanoutMode
  writeScopes?: unknown
}

export interface EnsembleFanoutResult {
  ok: boolean
  tool: 'ensemble_fanout'
  mode: EnsembleFanoutMode
  message: string
  laneIds?: string[]
  participantIds?: string[]
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'missing_prompt'
    | 'invalid_mode'
    | 'invalid_target'
    | 'no_eligible_targets'
    | 'not_authorized'
    | 'missing_write_scope'
    | 'invalid_write_scope'
    | 'write_lanes_disabled'
    | 'dispatch_failed'
}

export type EnsembleBossmanControlAction =
  | 'skip_participant'
  | 'stop_round'
  | 'replace_participant'
  | 'reorder_remaining'
  | 'queue_followup'
  | 'pause_work_session'
  | 'complete_work_session'

export interface EnsembleBossmanControlInput {
  action?: EnsembleBossmanControlAction
  roundId?: string
  targetParticipantId?: string
  targetRunId?: string
  participantIds?: string[]
  prompt?: string
  reason?: string
  replacement?: Partial<EnsembleParticipant> & { provider?: ProviderId }
}

export interface EnsembleBossmanControlResult {
  ok: boolean
  tool: 'ensemble_bossman_control'
  action?: EnsembleBossmanControlAction
  message: string
  roundId?: string
  participantId?: string
  error?:
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'bossman_not_configured'
    | 'not_bossman'
    | 'invalid_action'
    | 'stale_round'
    | 'stale_target'
    | 'stale_target_run'
    | 'missing_prompt'
    | 'missing_replacement'
    | 'health_check_unavailable'
    | 'replacement_unreachable'
    | 'reorder_cooldown'
    | 'queue_failed'
    | 'no_active_work_session'
    | 'baseline_exceeded'
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
  error?:
    | RosterEditError
    | 'no_active_run'
    | 'not_ensemble'
    | 'no_active_round'
    | 'bossman_not_configured'
    | 'not_bossman'
    | 'invalid_action'
    | 'stale_round'
    | 'unknown_provider'
    | 'health_check_unavailable'
    | 'participant_unreachable'
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
      .slice(0, 12)
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
    const knownServerPrefixes = ['mcp_taskwraith_']
    for (const prefix of knownServerPrefixes) {
      if (name.startsWith(prefix)) return name.slice(prefix.length)
    }
  }
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

function titleCaseToolName(toolName: string): string {
  return toolName
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function participantLabel(participant?: EnsembleParticipant): string {
  if (!participant) return 'Participant'
  return participant.role || participant.provider
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
  const orderedParticipants = getOrderedEnsembleParticipants(config)
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
  config: EnsembleConfig,
  roundId: string,
  participantId: string
): boolean {
  return cleanParticipantId(participantId) === resolveEnsembleProposedPlanOwnerId(config, roundId)
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
      return 'task'
    default:
      return undefined
  }
}

function getEnsembleToolCategory(toolName: string, toolKind = ''): ToolActivity['category'] {
  const kindCategory = mapEnsembleToolKindToCategory(toolKind)
  if (kindCategory) return kindCategory
  const name = stripToolNamespace(toolName)
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
  remainingParticipants?: EnsembleParticipant[]
  bossmanParticipantId?: string
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
  private queuedPromptIdCounter = 0

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
      if (persistedRound?.roundId !== existing.roundId || persistedRound.status !== 'running') {
        this.roundsByChatId.delete(input.chatId)
        existing = undefined
      }
    }
    if (existing && !existing.cancelled) {
      this.cancelWakeupsOnUserInput(existing)
      if (input.mode === 'steer') {
        void this.cancelRound(input.chatId, 'steered')
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
    if (!runtime || runtime.cancelled) {
      return { status: 'ignored', error: 'No active Ensemble round' }
    }
    const resolved = this.resolveQueuedPrompt(runtime, input)
    if ('error' in resolved) {
      return { status: 'ignored', error: resolved.error }
    }
    const { selected, selectedIndex } = resolved

    const remainingQueue = runtime.queuedPrompts.filter((_, queuedIndex) => queuedIndex !== selectedIndex)
    void this.cancelRound(input.chatId, 'steered')
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
      selected.discordContextSnapshots
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
    if (!runtime || runtime.cancelled) {
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
    runtime.queuedPrompts = []
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

  markYielded(runId: string, reason?: string, target?: string): boolean {
    const run = this.runsByRunId.get(runId)
    if (!run) return false
    run.status = 'yielded'
    // Slice C extension (1.0.3) — if the participant named a target,
    // remember it on the round runtime so `runRound` can reorder
    // remaining participants before the next turn. We always set
    // runtime.yieldTarget on the round that owns this run, regardless
    // of how the orchestrator's loop resolves it (resolution + clear
    // happens in runRound after the current turn finalises).
    if (target) {
      const runtime = this.roundsByChatId.get(run.chatId)
      if (runtime) runtime.yieldTarget = target
    }
    this.finalizeRun(run, 'yielded', reason || 'Participant yielded.')
    return true
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
    const bossmanParticipantId =
      runtime.bossmanParticipantId ||
      chat.ensemble.activeRound?.bossmanParticipantId ||
      chat.ensemble.bossmanParticipantId
    if (!bossmanParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        message: 'Boss control rejected: no Boss is assigned for this Ensemble.',
        error: 'bossman_not_configured'
      }
    }
    if (caller.participant.id !== bossmanParticipantId) {
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Boss control rejected from ${caller.participant.role || caller.participant.provider}: only the assigned Boss may use ensemble_bossman_control.`
      )
      // An impostor control attempt is a security-relevant event — record it to
      // the durable audit ledger, not just the transcript.
      this.deps.recordBossmanControlRejection?.({
        provider: caller.participant.provider,
        workspacePath: chat.workspacePath,
        chatId: caller.chatId,
        runId: caller.runId,
        metadata: {
          kind: 'bossman_control_rejected',
          rejectionReason: 'not_bossman',
          action,
          roundId: runtime.roundId,
          attemptingParticipantId: caller.participant.id,
          attemptingParticipantRole: caller.participant.role,
          attemptingProvider: caller.participant.provider,
          assignedBossmanParticipantId: bossmanParticipantId
        }
      })
      return {
        ok: false,
        tool: 'ensemble_bossman_control',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: 'Boss control rejected: caller is not the assigned Boss participant.',
        error: 'not_bossman'
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
    const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
    if (!bossmanParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: 'Roster edit rejected: no Boss is assigned for this Ensemble.',
        error: 'bossman_not_configured'
      }
    }
    if (caller.participant.id !== bossmanParticipantId) {
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Roster edit rejected from ${caller.participant.role || caller.participant.provider}: only the assigned Boss may use ensemble_roster_edit.`
      )
      this.deps.recordBossmanControlRejection?.({
        provider: caller.participant.provider,
        workspacePath: chat.workspacePath,
        chatId: caller.chatId,
        runId: caller.runId,
        metadata: {
          kind: 'roster_edit_rejected',
          rejectionReason: 'not_bossman',
          action,
          roundId: runtime.roundId,
          attemptingParticipantId: caller.participant.id,
          attemptingParticipantRole: caller.participant.role,
          attemptingProvider: caller.participant.provider,
          assignedBossmanParticipantId: bossmanParticipantId
        }
      })
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: 'Roster edit rejected: caller is not the assigned Boss participant.',
        error: 'not_bossman'
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
        bossmanParticipantId,
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
    const latestBossmanParticipantId = this.activeBossmanParticipantId(latestChat, runtime)
    if (!latestBossmanParticipantId) {
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        message: 'Roster edit rejected: no Boss is assigned for this Ensemble.',
        error: 'bossman_not_configured'
      }
    }
    if (caller.participant.id !== latestBossmanParticipantId) {
      this.appendRoundStatus(
        caller.chatId,
        runtime.roundId,
        `Roster edit rejected from ${caller.participant.role || caller.participant.provider}: only the assigned Boss may use ensemble_roster_edit.`
      )
      this.deps.recordBossmanControlRejection?.({
        provider: caller.participant.provider,
        workspacePath: latestChat.workspacePath,
        chatId: caller.chatId,
        runId: caller.runId,
        metadata: {
          kind: 'roster_edit_rejected',
          rejectionReason: 'not_bossman',
          action,
          roundId: runtime.roundId,
          attemptingParticipantId: caller.participant.id,
          attemptingParticipantRole: caller.participant.role,
          attemptingProvider: caller.participant.provider,
          assignedBossmanParticipantId: latestBossmanParticipantId
        }
      })
      return {
        ok: false,
        tool: 'ensemble_roster_edit',
        action,
        roundId: runtime.roundId,
        participantId: caller.participant.id,
        message: 'Roster edit rejected: caller is not the assigned Boss participant.',
        error: 'not_bossman'
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
        bossmanParticipantId: latestBossmanParticipantId,
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
    this.applyRosterEditToRuntime(runtime, action, resolution.affectedParticipantId, resolution.nextParticipants)
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
    const message = `Boss ${verb} ${label}.`
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
      runtime.remainingParticipants = remaining.filter(
        (participant) => participant.id !== affectedParticipantId
      )
    } else {
      runtime.remainingParticipants = remaining.map(
        (participant) => nextById.get(participant.id) || participant
      )
    }
    runtime.remainingParticipants?.sort((a, b) => a.order - b.order)
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
          provider: participant.provider,
          role: participant.role,
          order: participant.order
        }
      })
    const existingIds = new Set(existing.map((state) => state.participantId))
    const added = nextParticipants
      .filter((participant) => !existingIds.has(participant.id))
      .map((participant): EnsembleRoundState['participants'][number] => ({
        participantId: participant.id,
        provider: participant.provider,
        role: participant.role,
        order: participant.order,
        status: 'idle'
      }))
    const participantStates = [...existing, ...added].sort((a, b) => a.order - b.order)
    return {
      ...round,
      activeParticipantId:
        round.activeParticipantId && nextById.has(round.activeParticipantId)
          ? round.activeParticipantId
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
      ...(input.replacement?.permissionPresetId
        ? { permissionPresetId: input.replacement.permissionPresetId }
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
    if (mode === 'locked_writers' && fanoutPolicy !== 'locked_writers_with_boss') {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message:
          'ensemble_fanout: locked writer lanes require the Boss writer fan-out policy.',
        error: 'not_authorized'
      }
    }
    if (mode === 'locked_writers' && !concurrentWriteLanesEnabled()) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
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
        reason: 'locked_writer_not_authorized',
        targets: normalizeTargetList(input.targets)
      })
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message,
        error: 'not_authorized'
      }
    }

    if (isBroadFanoutRequest(input.targets) && !this.canRequestBroadFanout(chat, run)) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message:
          'ensemble_fanout: broad fan-out requires the configured Boss/Lead/manager, or an active Work Session with an explicit participant scope. Use explicit targets for a narrow peer handoff.',
        error: 'not_authorized'
      }
    }

    const resolvedTargets = this.resolveFanoutTargets(chat, runtime, run, input.targets, mode)
    if (!resolvedTargets.ok) {
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message: resolvedTargets.message,
        error: resolvedTargets.error
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

    const label = mode === 'locked_writers' ? 'Locked writer fan-out' : 'Parallel fan-out'
    this.appendRoundStatus(
      run.chatId,
      run.roundId,
      `${label}: ${run.participant.role || run.participant.provider} requested ${resolvedTargets.targets.length} lane(s).${input.reason ? ` ${input.reason}` : ''}`
    )
    try {
      const laneIds = await this.runParallelFanoutPass(runtime, chat, resolvedTargets.targets, {
        prompt,
        reason: input.reason,
        mode,
        sourceRunId: runId,
        writeScopesByParticipantId
      })
      if (!runtime.fannedOutParticipantIds) runtime.fannedOutParticipantIds = new Set()
      for (const participant of resolvedTargets.targets) {
        runtime.fannedOutParticipantIds.add(participant.id)
      }
      return {
        ok: true,
        tool: 'ensemble_fanout',
        mode,
        laneIds,
        participantIds: resolvedTargets.targets.map((participant) => participant.id),
        message: `${label} complete: ${laneIds.length} lane(s) returned.`
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'ensemble_fanout: dispatch failed.'
      this.appendRoundStatus(run.chatId, run.roundId, `${label} failed: ${message}`)
      return {
        ok: false,
        tool: 'ensemble_fanout',
        mode,
        message,
        error: 'dispatch_failed'
      }
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
        ensembleOrder: run.participant.order,
        ...pooledAgentTranscriptMetadata(run.participant),
        fromParticipantId: run.participant.id,
        fromProvider: run.participant.provider,
        fromRole: run.participant.role,
        toParticipantIds: recipients.map((participant) => participant.id),
        toProviders: recipients.map((participant) => participant.provider),
        toRoles: recipients.map((participant) => participant.role),
        ...(run.laneId ? { ensembleLaneId: run.laneId } : {}),
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
    return (
      runtime.bossmanParticipantId ||
      chat.ensemble?.activeRound?.bossmanParticipantId ||
      chat.ensemble?.bossmanParticipantId
    )
  }

  private canRequestLockedWriterFanout(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): boolean {
    const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
    return Boolean(bossmanParticipantId && run.participant.id === bossmanParticipantId)
  }

  private lockedWriterFanoutAuthorizationMessage(
    chat: ChatRecord,
    runtime: ActiveRoundRuntime,
    run: ActiveParticipantRun
  ): string {
    const bossmanParticipantId = this.activeBossmanParticipantId(chat, runtime)
    if (!bossmanParticipantId) {
      return 'Locked writer fan-out rejected: no Boss is assigned, so writer lanes require a user write-scope preflight before parallel mutation is allowed.'
    }
    return `Locked writer fan-out rejected from ${run.participant.role || providerLabel(run.participant.provider)}: only the assigned Boss may authorize parallel writer lanes.`
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
  }

  listParticipantsForRun(runId: string | undefined): {
    ok: boolean
    error?: string
    chatId?: string
    roundId?: string
    activeParticipantId?: string
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
    return {
      ok: true,
      chatId: chat.appChatId,
      roundId: run.roundId,
      activeParticipantId: run.participant.id,
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
          contextPercent: contextPercent(participantContext.tokens, participantContextWindow)
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
      runId: run.runId,
      scheduledAt: nowIso,
      wakeAt: new Date(wakeAtMs).toISOString(),
      status: 'pending',
      reason: input.reason,
      cancelOnUserInput: input.cancelOnUserInput !== false
    }
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
    const participant = chat.ensemble.participants.find(
      (entry) => entry.id === wakeup.participantId && entry.enabled
    )
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

  markRunExited(runId: string | undefined, exitCode: number): boolean {
    if (!runId) return false
    const run = this.runsByRunId.get(runId)
    if (!run || run.status === 'answered' || run.status === 'yielded') return false
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
      if (!run.toolActivities) run.toolActivities = []
      const activity = buildEnsembleToolActivity(payload, this.deps.nowIso(), run.participant)
      run.toolActivities.push(activity)
      appendTimelineTool(run, activity.id)
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
    unattendedElevationLevel?: UnattendedElevationLevel
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
    const ordered = dmTargetParticipantId
      ? (() => {
          const target = chat.ensemble.participants.find((p) => p.id === dmTargetParticipantId)
          return target ? [target] : orderedFull
        })()
      : orderedFull
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
      enabledParticipantCount: ordered.length
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
      bossmanBaselineParticipantIds: ordered.map((participant) => participant.id),
      bossmanBaselineParticipantCount: ordered.length,
      ...(effectiveConcurrentMode ? { concurrentMode: true } : {}),
      fanoutPolicy: effectiveFanoutPolicy,
      participants: ordered.map((participant) => ({
        participantId: participant.id,
        provider: participant.provider,
        role: participant.role,
        order: participant.order,
        status: 'idle'
      })),
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
      bossmanBaselineParticipantIds: ordered.map((participant) => participant.id),
      bossmanBaselineParticipantCount: ordered.length,
      orchestrationMode,
      fanoutPolicy: effectiveFanoutPolicy,
      ...(effectiveConcurrentMode ? { concurrentMode: true } : {}),
      continuationHops: 0,
      maxContinuationHops,
      ...(selfReflective ? { selfReflective: true } : {}),
      ...(externalPathGrants.length > 0 ? { externalPathGrants: [...externalPathGrants] } : {}),
      ...(unattended ? { unattended: true } : {}),
      ...(unattended && unattendedElevationLevel ? { unattendedElevationLevel } : {})
    }
    this.roundsByChatId.set(chatId, runtime)
    if (concurrentFallbackReason) {
      this.appendRoundStatus(
        chatId,
        roundId,
        'Fan-out requested but parallel lanes are disabled (TASKWRAITH_CONCURRENT_LANES=0) — running participants serially.'
      )
    }
    void this.runRound(runtime, ordered)
    return roundId
  }

  private async runRound(
    runtime: ActiveRoundRuntime,
    participants: EnsembleParticipant[]
  ): Promise<void> {
    // Slice C extension (1.0.3) — convert the fixed for-loop into a
    // mutable remaining-queue so `ensemble_yield(target:...)` can
    // reorder upcoming turns after each completion. The original
    // for-loop iterated `participants` directly; reordering required
    // a queue + while-loop pattern.
    const remaining: EnsembleParticipant[] = [...participants]
    runtime.remainingParticipants = remaining
    let dispatchAttempts = 0
    let unreachableFailures = 0
    if (this.deps.probeParticipant && remaining.length > 0 && !runtime.cancelled) {
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

    // Parallel fan-out. Default/safe path: fan out read-only
    // participants first, then continue with writer-capable
    // participants serially. Writer-capable lanes only run in parallel
    // after either Boss authorization via ensemble_fanout or, when no
    // Boss is assigned, a host-owned user-preflight claim + ack pass.
    const chatForFanout = this.deps.getChat(runtime.chatId)
    const workSessionForFanout = chatForFanout?.ensemble?.workSession
    const roundFanoutPolicy = runtime.fanoutPolicy ?? (runtime.concurrentMode ? 'read_only' : 'off')
    const userFanoutRequested = fanoutPolicyEnablesConcurrent(roundFanoutPolicy)
    const workSessionScoutPass =
      workSessionForFanout?.enabled &&
      workSessionForFanout.status === 'active' &&
      workSessionForFanout.enableScoutPass
    // Work Session scout pass is its own explicit Work Session setting. Preserve
    // its existing read-only scout behavior even when the chat fan-out policy is off.
    const shouldRunReadOnlyFanout =
      userFanoutRequested || Boolean(workSessionScoutPass)
    if (shouldRunReadOnlyFanout && !runtime.cancelled) {
      const readers: EnsembleParticipant[] = []
      const writers: EnsembleParticipant[] = []
      for (const participant of remaining) {
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
      if (readers.length >= 2 && chatForFanout) {
        // Replace `remaining` with the writers-only subset so the
        // serial while-loop below processes them in original order
        // after the read-only fan-out completes.
        remaining.length = 0
        remaining.push(...writers)
        await this.runParallelFanoutPass(runtime, chatForFanout, readers, {
          mode: 'read_only'
        })
      } else if (userFanoutRequested && readers.length > 0) {
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          'Parallel mode requested but fewer than two read-only participants were available; continuing serially.'
        )
      }
      if (chatForFanout && writers.length > 0 && !runtime.cancelled) {
        const writerPolicy = roundFanoutPolicy
        const bossmanParticipantId = this.activeBossmanParticipantId(chatForFanout, runtime)
        const eligibleWriterTail =
          writers.length >= 2 &&
          remaining.every((participant) => writers.some((writer) => writer.id === participant.id))
        if (
          writerPolicy !== 'locked_writers_with_boss' &&
          writerPolicy !== 'locked_writers_user_preflight'
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
    // 1.0.4 — round-end all-unreachable fallback. Counts every
    // dispatch attempt and how many of those attempts failed with
    // `kind: 'unreachable'`. If the round exhausts `remaining` with
    // every attempt unreachable, we emit a final "no reachable
    // participants left" note so the user knows to re-launch.
    while (remaining.length > 0) {
      if (runtime.cancelled) break
      const chat = this.deps.getChat(runtime.chatId)
      if (!chat?.ensemble) break
      const participant = remaining.shift()!
      if (runtime.fannedOutParticipantIds?.has(participant.id)) {
        continue
      }
      const wasYieldTarget = yieldedTargetParticipantId === participant.id
      yieldedTargetParticipantId = null
      const resumeWakeup =
        runtime.resumeWakeup?.participantId === participant.id ? runtime.resumeWakeup : undefined
      if (resumeWakeup) runtime.resumeWakeup = undefined
      // 1.0.5-N6 — A wakeup-resume run with no linked provider
      // session is re-establishing the agent's working memory from
      // the TaskWraith transcript only. Surface that on the new run so
      // the RunCard renders a small "transcript resumed" chip.
      const sleepResumeWarning =
        resumeWakeup && !participant.linkedProviderSessionId
          ? 'Resumed from TaskWraith transcript context; no native provider session id was available.'
          : undefined

      const run = this.seedParticipantRun(chat, runtime, participant, { sleepResumeWarning })
      runtime.activeRunId = run.runId
      const completion = new Promise<EnsembleParticipantStatus>((resolve) => {
        run.completion = resolve
      })
      const permissions = this.resolveParticipantPermissions(
        chat,
        participant,
        runtime.externalPathGrants
      )
      // 1.0.4-AF — merge the round-scoped `selfReflective` flag (set
      // by `/discuss` at startRound) into the config so the prompt
      // builder sees the inverted deictic rule for this round only.
      // The persisted `chat.ensemble.selfReflective` toggle (future
      // UI control) takes precedence so an explicit pre-set isn't
      // accidentally overridden by a non-discuss round.
      const ensembleConfigForRound: EnsembleConfig = runtime.selfReflective
        ? { ...chat.ensemble, selfReflective: true }
        : chat.ensemble
      const chatContextTurns = this.deps.getSettings().chatContextTurns
      const prompt = buildEnsembleParticipantPrompt({
        chat,
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
        scoutBriefs: runtime.scoutBriefs
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
      // 1.0.6-CRUX30 — codex AND grok both dispatch reasoning via the shared
      // `reasoningEffort` payload field (each adapter normalizes it — Codex
      // effort vs Grok's normalizeGrokEffortFlag). Thread both so a grok
      // ensemble participant's reasoning isn't silently dropped.
      const codexOrGrokReasoning =
        participant.provider === 'codex' || participant.provider === 'grok'
          ? participant.reasoningEffort
          : undefined
      const codexServiceTier =
        participant.provider === 'codex'
          ? (participant.serviceTier ?? (participant.fastModeEnabled ? 'fast' : ''))
          : undefined
      const claudeReasoning =
        participant.provider === 'claude' ? participant.reasoningEffort : undefined
      const claudeFastMode =
        participant.provider === 'claude' ? Boolean(participant.fastModeEnabled) : undefined
      const kimiThinking =
        participant.provider === 'kimi' ? Boolean(participant.thinkingEnabled) : undefined
      const ollamaRunControls = ensembleOllamaRunControls(participant)

      const payload: AgentRunPayload = {
        provider: participant.provider,
        scope: chat.scope === 'global' ? 'global' : 'workspace',
        ...(chat.scope === 'global' ? {} : { workspace: chat.workspacePath || '' }),
        prompt: promptWithDiscordContext,
        imagePaths: imagePathsForEnsembleAttachments(runtime.imageAttachments),
        appRunId: run.runId,
        appChatId: chat.appChatId,
        model: participant.model || 'cli-default',
        approvalMode: permissions.approvalMode,
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
                  scope: chat.scope === 'global' ? 'global' : 'workspace',
                  appRunId: run.runId,
                  appChatId: chat.appChatId,
                  prompt: promptWithDiscordContext,
                  runtimeProfileId: participant.runtimeProfileId
                }
              )
            }
          : {}),
        ensembleRun: ensembleRunIdentity(
          runtime.roundId,
          participant,
          undefined,
          ensembleConfigForRound,
          chatContextTurns
        ),
        ...(codexOrGrokReasoning !== undefined ? { reasoningEffort: codexOrGrokReasoning } : {}),
        ...(codexServiceTier !== undefined ? { serviceTier: codexServiceTier } : {}),
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
        await completion
      }
      runtime.activeRunId = undefined
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
          remaining.length = 0
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `${participant.role || providerLabel(participant.provider)} yielded to the user. Round closed.`
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
          } else if (runtime.orchestrationMode === 'continuous') {
            const target = resolveYieldTargetParticipant(
              chat.ensemble.participants || [],
              runtime.yieldTarget,
              participant
            )
            if (target?.enabled) {
              routedByYieldTarget = this.tryAppendContinuationTurn(
                runtime,
                remaining,
                target,
                `Yielded back to ${target.role || target.provider} (${target.provider}).`
              )
            }
          }
        }
        runtime.yieldTarget = undefined
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
        const bossmanParticipantId =
          runtime.bossmanParticipantId ||
          chat.ensemble?.activeRound?.bossmanParticipantId ||
          chat.ensemble?.bossmanParticipantId
        const bossmanMatch = bossmanParticipantId
          ? tagMatches.find((tagMatch) => tagMatch.participant.id === bossmanParticipantId)
          : undefined
        const routeableTagMatches =
          bossmanMatch && tagMatches.some((tagMatch) => tagMatch.participant.id !== bossmanMatch.participant.id)
            ? [bossmanMatch]
            : tagMatches
        if (bossmanMatch && routeableTagMatches.length !== tagMatches.length) {
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `@-mention: ${participantDisplayName(bossmanMatch.participant)} is Boss and takes routing priority over advisory participant mentions.`
          )
        }
        const seenTagged = new Set<string>()
        const mentionedParticipants: EnsembleParticipant[] = []
        const ambiguityWarnings: string[] = []
        for (const tagMatch of routeableTagMatches) {
          let tagged = tagMatch.participant
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
        const remainingTargetIds = new Set(
          mentionedParticipants
            .filter((tagged) => remaining.some((entry) => entry.id === tagged.id))
            .map((tagged) => tagged.id)
        )
        const orderedTargets = mentionedParticipants.filter((tagged) =>
          remainingTargetIds.has(tagged.id)
        )
        if (orderedTargets.length > 0) {
          const rest = remaining.filter((entry) => !remainingTargetIds.has(entry.id))
          remaining.splice(0, remaining.length, ...orderedTargets, ...rest)
          this.appendRoundStatus(
            runtime.chatId,
            runtime.roundId,
            `@-mention: ${orderedTargets
              .map((entry) => entry.role || entry.provider)
              .join(', ')} promoted to speak next.`
          )
        }
        const extraTargets = mentionedParticipants.filter(
          (tagged) => !remainingTargetIds.has(tagged.id)
        )
        if (runtime.orchestrationMode === 'continuous') {
          for (const tagged of extraTargets.slice().reverse()) {
            this.tryAppendContinuationTurn(
              runtime,
              remaining,
              tagged,
              `@-mention: extra turn appended for ${tagged.role || tagged.provider}.`
            )
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
        const participant = chatForWake?.ensemble?.participants.find(
          (entry) => entry.id === wakeup.participantId && entry.enabled
        )
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
    this.finishRound(runtime.chatId, runtime.roundId, runtime.cancelled ? 'cancelled' : 'completed')
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
    mode: EnsembleFanoutMode
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
   * 1.0.4-AK5 — Parallel fan-out executor.
   *
   * Dispatches N participants concurrently via Promise.all,
   * then awaits all their completion promises before returning to
   * `runRound`. The orchestrator emits a transcript status row at
   * the start ("Parallel pass · N scouts dispatched.") so the user
   * sees the fan-out as it happens.
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
    const laneRuns: ActiveParticipantRun[] = participants.map((participant) => {
      const freshChat = this.deps.getChat(runtime.chatId) || chat
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      const permissions = this.resolveFanoutDispatchPermissions(chat, runtime, participant, dispatchMode)
      return this.seedParticipantRun(freshChat, runtime, participant, {
        laneId: this.nextLaneId(runtime, participant),
        laneIntent: permissions.readOnly ? 'read' : 'write',
        approvedWriteScopes: permissions.readOnly
          ? undefined
          : options.writeScopesByParticipantId?.get(participant.id)
      })
    })
    for (const run of laneRuns) {
      runtime.activeScoutRunIds.add(run.runId)
    }

    // Build the per-lane dispatch payload + completion promise
    // pair. Dispatch concurrently via Promise.all so the round is
    // bounded by the SLOWEST lane, not the sum of lane durations.
    const dispatchPromises = laneRuns.map(async (run) => {
      const participant = run.participant
      const completion = new Promise<EnsembleParticipantStatus>((resolve) => {
        run.completion = resolve
      })
      const dispatchMode = options.forceReadOnlyDispatch ? 'read_only' : mode
      const permissions = this.resolveFanoutDispatchPermissions(chat, runtime, participant, dispatchMode)
      const lanePromptAuthor = options.sourceRunId ? 'peer-authored' : 'orchestrator-authored'
      const promptForLane = options.prompt?.trim()
        ? `Parallel fan-out lane request (${lanePromptAuthor}, lower authority than user/system instructions):\n${options.prompt.trim()}${
            options.reason ? `\n\nReason: ${options.reason}` : ''
          }\n\nTreat this as a scoped lane brief. Follow your own role, permissions, active goal, and Work Session authority first.`
        : runtime.prompt
      const chatContextTurns = this.deps.getSettings().chatContextTurns
      const promptText = buildEnsembleParticipantPrompt({
        chat,
        config: chat.ensemble!,
        participant,
        currentPrompt: promptForLane,
        currentPromptLabel: options.prompt?.trim()
          ? `Current fan-out lane request (${lanePromptAuthor}, lower authority; not user/system instruction):`
          : undefined,
        roundId: runtime.roundId,
        chatContextTurns
      })
      const promptWithDiscordContext = `${promptText}${formatDiscordContextPromptAppendix(
        runtime.discordContextSnapshots
      )}${externalPathGrantPromptAppendix(permissions.externalPathGrants)}`
      // Mirror the serial path: thread per-participant reasoning/thinking into
      // the fan-out payload too, else a concurrent round silently runs every
      // participant at provider-default reasoning regardless of its config.
      const codexOrGrokReasoning =
        participant.provider === 'codex' || participant.provider === 'grok'
          ? participant.reasoningEffort
          : undefined
      const codexServiceTier =
        participant.provider === 'codex'
          ? (participant.serviceTier ?? (participant.fastModeEnabled ? 'fast' : ''))
          : undefined
      const claudeReasoning =
        participant.provider === 'claude' ? participant.reasoningEffort : undefined
      const claudeFastMode =
        participant.provider === 'claude' ? Boolean(participant.fastModeEnabled) : undefined
      const kimiThinking =
        participant.provider === 'kimi' ? Boolean(participant.thinkingEnabled) : undefined
      const ollamaRunControls = ensembleOllamaRunControls(participant)
      const payload: AgentRunPayload = {
        provider: participant.provider,
        scope: chat.scope === 'global' ? 'global' : 'workspace',
        ...(chat.scope === 'global' ? {} : { workspace: chat.workspacePath || '' }),
        prompt: promptWithDiscordContext,
        imagePaths: imagePathsForEnsembleAttachments(runtime.imageAttachments),
        appRunId: run.runId,
        appChatId: chat.appChatId,
        model: participant.model || 'cli-default',
        approvalMode: permissions.approvalMode,
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
                  scope: chat.scope === 'global' ? 'global' : 'workspace',
                  appRunId: run.runId,
                  appChatId: chat.appChatId,
                  prompt: promptWithDiscordContext,
                  runtimeProfileId: participant.runtimeProfileId
                }
              )
            }
          : {}),
        ensembleRun: ensembleRunIdentity(
          runtime.roundId,
          participant,
          run.laneId,
          chat.ensemble,
          chatContextTurns
        ),
        ...(codexOrGrokReasoning !== undefined ? { reasoningEffort: codexOrGrokReasoning } : {}),
        ...(codexServiceTier !== undefined ? { serviceTier: codexServiceTier } : {}),
        ...(claudeReasoning !== undefined ? { claudeReasoningEffort: claudeReasoning } : {}),
        ...(claudeFastMode !== undefined ? { claudeFastMode } : {}),
        ...(kimiThinking !== undefined ? { kimiThinking } : {}),
        ...ollamaRunControls
      }
      try {
        const dispatched = await this.deps.dispatch(payload, { sender: runtime.sender })
        if (!dispatched.dispatched) {
          const note = formatDispatchFailureNote(participant, { kind: 'unknown', message: '' })
          this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
          this.finalizeRun(run, 'failed', note)
        }
      } catch (error) {
        const reason = classifyDispatchError(error)
        const note = formatDispatchFailureNote(participant, reason)
        this.appendRoundStatus(runtime.chatId, runtime.roundId, note)
        this.finalizeRun(run, 'failed', note)
      }
      return completion
    })

    // Wait for every dispatch to return its completion promise,
    // then wait for every completion promise to resolve.
    const completionPromises = await Promise.all(dispatchPromises)
    await Promise.all(completionPromises)
    if (runtime.cancelled) return []
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
      options.sourceRunId
        ? `${label} complete · ${laneRuns.length} lane(s) returned to the caller.`
        : `${label} complete · returning to serial writer step.`
    )
    return laneRuns.map((run) => run.laneId).filter((laneId): laneId is string => Boolean(laneId))
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
    const promptMessageId = `ensemble-prompt-${runtime.roundId}-${participant.id}`
    const assistantMessageId = `ensemble-assistant-${runtime.roundId}-${participant.id}`
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
      ensembleRole: participant.role,
      ensembleOrder: participant.order,
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

  private tryAppendContinuationTurn(
    runtime: ActiveRoundRuntime,
    remaining: EnsembleParticipant[],
    participant: EnsembleParticipant,
    statusMessage: string
  ): boolean {
    if (runtime.orchestrationMode !== 'continuous') return false
    if (runtime.unreachableParticipantIds?.has(participant.id)) return false
    if (runtime.continuationHops >= runtime.maxContinuationHops) {
      if (!runtime.continuationLimitNotified) {
        runtime.continuationLimitNotified = true
        const label =
          runtime.orchestrationMode === 'continuous' ? 'Continuous handoff' : 'Extra turn'
        this.appendRoundStatus(
          runtime.chatId,
          runtime.roundId,
          `${label} limit reached (${runtime.continuationHops}/${runtime.maxContinuationHops}); returning control to the user.`
        )
      }
      return false
    }
    runtime.continuationHops += 1
    remaining.unshift(participant)
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
    return true
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
        fallbackDurationMs
      })
      if (entry) record(entry)
    } catch {
      // Usage recording is best-effort; never block round finalisation.
    }
  }

  private finalizeRun(
    run: ActiveParticipantRun,
    status: EnsembleParticipantStatus,
    reason?: string
  ): void {
    run.status = status
    this.flushRun(run, true, reason)
    run.completion?.(status)
    if (run.laneId) {
      try {
        this.deps.releaseWriteIntentsForLane?.(run.laneId)
      } catch {
        // Lock cleanup is best-effort; the in-memory registry is defensive.
      }
    }
    this.runsByRunId.delete(run.runId)
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
            shouldStampEnsembleProposedPlan(chat.ensemble, run.roundId, run.participant.id)
        )
        const previousPlan = shouldStampEnsembleProposedPlan(
          chat.ensemble,
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
            ...(run.laneId ? { ensembleLaneId: run.laneId } : {}),
            ensembleProvider: run.participant.provider,
            ensembleRole: run.participant.role,
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
            ...(run.laneId ? { ensembleLaneId: run.laneId } : {}),
            ensembleProvider: run.participant.provider,
            ensembleRole: run.participant.role,
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
      // this synthetic message is never built, so the wholesale rebuild above
      // (which strips every `ensemble-content-${runId}-*` id and re-inserts only
      // `desiredMessages`) drops the stale synthetic.
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
            ...(run.laneId ? { ensembleLaneId: run.laneId } : {}),
            ensembleProvider: run.participant.provider,
            ensembleRole: run.participant.role,
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

    // Strip any prior timeline messages for this run from the chat
    // (other messages — round-prompt user msgs, status cards from
    // OTHER runs, etc. — stay untouched). Then re-insert the fresh
    // ordered sequence at the end. Insertion-at-end is correct here
    // because the orchestrator flushes participants in turn order
    // and each participant's content is contiguous within the
    // transcript anyway.
    messages = messages.filter((message) => {
      if (message.runId !== run.runId) return true
      if (message.role !== 'assistant' && message.role !== 'tool') return true
      // Only filter our own timeline-ids; non-timeline assistant
      // messages from older code paths (none remain in this file
      // but defending in depth) stay.
      const stableId = typeof message.id === 'string' ? message.id : ''
      return (
        !stableId.startsWith(`ensemble-content-${run.runId}-`) &&
        !stableId.startsWith(`ensemble-tool-${run.runId}-`) &&
        // Legacy single-id flush from earlier 1.0.3 builds — also
        // remove so migrated chats don't show stale duplicates.
        message.id !== run.assistantMessageId &&
        !stableId.startsWith(`ensemble-tool-${run.runId}`)
      )
    })
    messages = [...messages, ...desiredMessages]

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
          ...(run.laneId ? { ensembleLaneId: run.laneId } : {}),
          ensembleProvider: run.participant.provider,
          ensembleRole: run.participant.role,
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

    const runs = chat.runs.map((existingRun) =>
      existingRun.runId === run.runId
        ? {
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
        : existingRun
    )

    const participants = (chat.ensemble.participants || []).map((participant) => {
      if (participant.id !== run.participant.id) return participant
      const tokenTotals = mergeTokenTotals(participant.tokenTotals, run.stats)
      return {
        ...participant,
        ...(run.providerSessionId ? { linkedProviderSessionId: run.providerSessionId } : {}),
        ...(tokenTotals ? { tokenTotals } : {})
      }
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
    this.saveChatWithCheckpoint({
      ...chat,
      messages,
      runs,
      ensemble: {
        ...chat.ensemble,
        participants,
        activeRound,
        updatedAt: timestamp
      },
      updatedAt: this.deps.now()
    }, 'participant-updated')
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
    status: Extract<EnsembleRoundState['status'], 'completed' | 'cancelled' | 'failed'>
  ): void {
    const chat = this.deps.getChat(chatId)
    if (!chat?.ensemble) return
    const endedAt = this.deps.nowIso()
    const activeRound = chat.ensemble.activeRound
    if (activeRound?.roundId !== roundId) return
    const nextRound: EnsembleRoundState = {
      ...activeRound,
      status,
      activeParticipantId: undefined,
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
            synthesizerParticipantId: chat.ensemble.synthesizerParticipantId,
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
        hasSynthesizer: Boolean(chat.ensemble.synthesizerParticipantId),
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

  private clearRuntimeIfCurrent(runtime: ActiveRoundRuntime): void {
    if (this.roundsByChatId.get(runtime.chatId)?.roundId === runtime.roundId) {
      this.roundsByChatId.delete(runtime.chatId)
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
      mode === 'read_only' ? { ignoreWorkSessionOverride: true } : {}
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
        ? { presetId: 'read_only', ignoreWorkSessionOverride: true, ignoreOverrides: true }
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
    const presetId = options.presetId || (sessionActive ? workSession.permissionPresetId : participant.permissionPresetId)
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
  contextTurns?: number
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
    ...(laneId ? { laneId } : {}),
    provider: participant.provider,
    role: participant.role,
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
  if (participant.provider === 'codex' || participant.provider === 'claude') {
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
    ...(typeof snapshot.accent === 'string' && snapshot.accent
      ? { accent: snapshot.accent }
      : {}),
    ...(typeof snapshot.slug === 'string' && snapshot.slug ? { slug: snapshot.slug } : {}),
    ...(typeof snapshot.assetKey === 'string' && snapshot.assetKey
      ? { assetKey: snapshot.assetKey }
      : {}),
    ...(typeof snapshot.seed === 'string' && snapshot.seed ? { seed: snapshot.seed } : {})
  }
  return { pooledAgentId: agentId, pooledAgentIdentity }
}

function ensembleOllamaRunControls(participant: EnsembleParticipant): Partial<AgentRunPayload> {
  if (participant.provider !== 'ollama') return {}
  return {
    ...(participant.ollamaToolControlTier
      ? { ollamaToolControlTier: participant.ollamaToolControlTier }
      : {}),
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
    const who = `${providerLabel(participant.provider)} / ${participant.role || 'Participant'}`
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
  return `\n\nUser-approved external path grants for this Ensemble participant:\n${lines.join('\n')}\nUse only these paths outside the workspace.`
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
