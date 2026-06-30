import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { coerceLiveProvider, DEFAULT_PROVIDER } from '../../shared/retiredProviders'
import { redactSecrets } from '../../shared/secretRedaction'
import type { TaskWraithPluginResourceProvenance } from '../../shared/plugins/PluginTypes'
import type { UnattendedElevationAck } from '../UnattendedPostureGate'
import {
  AppSettings,
  WorkspaceRecord,
  ChatRecord,
  ChatRun,
  ChatListItem,
  PooledAgentStatsSummary,
  UsageRecord,
  ScheduledTask,
  RunQueueJob,
  RunQueueJobFilter,
  RunEventFilter,
  RunEventInput,
  RunEventRecord,
  RunEventArtifactRef,
  ApprovalLedgerFilter,
  ApprovalLedgerRecord,
  ApprovalLedgerRequestInput,
  AgentApprovalAction,
  ApprovalLedgerScope,
  ProviderId,
  GuestParticipantConfig,
  SideChatMode,
  SideChatLifecycleState,
  RunRecoveryFilter,
  RunRecoveryRecord,
  WorkspaceChangeFilter,
  WorkspaceChangeSet,
  WorkspaceChangeSetInput,
  WorkspaceEditorChangeInput,
  WorkspaceRunChangeInput,
  ProductCrashFilter,
  ProductCrashInput,
  ProductCrashRecord,
  RuntimeProfile,
  UserMcpServerConfig,
  HandoffCard,
  HandoffCardFilter,
  ProductUpdateChangelog,
  WorkflowDefinition,
  WorkflowExecutionRecord,
  WorkflowRunTemplate,
  WorkspaceBoardActivityEntry,
  WorkspaceBoardCard,
  WorkspaceBoardCardLink,
  WorkspaceBoardColumn,
  WorkspaceBoardColumnId,
  WorkspaceBoardDefinition,
  WorkspaceBoardProvenance,
  WorkspaceBoardProvenanceSourceKind,
  PinnedMessageGroup,
  AuditRunRecord,
  AuditFinding,
  AuditVerdict,
  AuditGateResult,
  AuditParticipant
} from './types'
import { canonicalizeExternalPathGrantMetadata } from './ExternalPathGrants'
import { createDefaultEnsembleConfig } from '../EnsembleDefaults'
import { createHash, randomUUID } from 'crypto'
import {
  capRunQueueJobs,
  createRunQueueJob,
  filterRunQueueJobs,
  recoverInterruptedRunQueueJobs as recoverInterruptedQueueJobs,
  sortRunQueueJobs,
  updateRunQueueJobRecord,
  type RunQueueJobInput
} from '../RunQueue'
import {
  createRunEventRecord,
  createRunEventReplay,
  filterRunEvents,
  lastRunEventHash,
  nextRunEventSequence,
  parseRunEventLine,
  safeRunEventFileName,
  serializeRunEventRecord
} from '../RunEventStore'
import {
  createWorkflowRunEvent,
  filterWorkflowRunEvents,
  foldWorkflowRunSummary,
  nextWorkflowRunSequence,
  parseWorkflowRunEventLine,
  reconcileStaleLedgerExecutions,
  safeWorkflowRunFileName,
  serializeWorkflowRunEvent,
  type StaleLedgerExecution,
  type WorkflowRunEvent,
  type WorkflowRunEventFilter,
  type WorkflowRunEventInput,
  type WorkflowRunSummary
} from '../WorkflowRunStore'
import {
  AGENT_STATS_FILE_CAP,
  buildAgentStatDelta,
  compactToRollup,
  countRawDeltas,
  foldAgentStats,
  isPooledAgentId,
  parseAgentStatRecordLine,
  safeAgentStatsFileName,
  seenRunIds,
  serializeAgentStatRecord,
  type AgentStatRecord
} from '../AgentStatsStore'
import { normalizeWorkflowLoopConfig } from '../WorkflowLoopModel'
import {
  findStaleAuditRuns,
  AUDIT_RESTART_INTERRUPTION_ERROR,
  type StaleAuditRun
} from '../audit/AuditReconciler'
import {
  capApprovalLedgerRecords,
  createApprovalLedgerRecord,
  expireScopedApprovalLedgerRecords,
  filterApprovalLedgerRecords,
  recoverExpiredApprovalLedgerRecords,
  resolveApprovalLedgerRecord
} from '../ApprovalLedger'
import { filterRunRecoveryRecords, recoverRunQueueJobsAfterStartup } from '../RunRecovery'
import {
  createWorkspaceChangeSet,
  createWorkspaceChangeSetFromEditorWrite,
  createWorkspaceChangeSetFromRunDiff,
  filterWorkspaceChangeSets,
  pruneWorkspaceChangeSets
} from '../WorkspaceChangeModel'
import { createProductCrashRecord, filterProductCrashRecords } from '../ProductOperations'
import { chatPathForId, isSafeChatId } from '../ChatPath'
import { compactChatForPersist } from './ChatCompaction'
import {
  isTerminalWorkflowExecutionStatus,
  nextLocalDayBoundaryIso,
  normalizeWorkflowTrigger,
  resolveNextWorkflowRunAt
} from '../workflows/WorkflowScheduler'
import { sanitizeProviderRunPauses } from '../ProviderRunPause'
import {
  DEFAULT_STALL_BACKSTOP_MS,
  findStalledScheduledTasks,
  stallReason
} from '../WorkflowStallReconciler'

function cloneEnsembleForSideChat(parent: ChatRecord, provider: ProviderId) {
  const source = parent.ensemble || createDefaultEnsembleConfig(provider)
  return {
    ...source,
    participants: (source.participants || []).map((participant) => ({
      ...participant,
      linkedProviderSessionId: null,
      tokenTotals: undefined
    })),
    activeRound: undefined,
    sessionActivityLedger: [],
    workSession: undefined,
    lastRoundSummary: undefined,
    roundSummaries: undefined,
    wakeups: undefined,
    blackboard: undefined,
    escalationSignals: undefined,
    updatedAt: new Date().toISOString()
  }
}

function normalizeSideChatLifecycleState(
  value: unknown,
  fallback: SideChatLifecycleState
): SideChatLifecycleState {
  if (value === 'active' || value === 'closed' || value === 'terminated') return value
  return fallback
}

const userDataPath = app.getPath('userData')
const settingsPath = path.join(userDataPath, 'settings.json')
const workspacesPath = path.join(userDataPath, 'workspaces.json')
const usagePath = path.join(userDataPath, 'usage.json')
const providerUsageSnapshotsPath = path.join(userDataPath, 'provider-usage-snapshots.json')
const scheduledTasksPath = path.join(userDataPath, 'scheduled-tasks.json')
const workflowsPath = path.join(userDataPath, 'workflows.json')
const workspaceBoardsPath = path.join(userDataPath, 'workspace-boards.json')
const workspaceBoardCardsPath = path.join(userDataPath, 'workspace-board-cards.json')
const runQueuePath = path.join(userDataPath, 'run-queue.json')
// Single choke point for run-queue writes: bounds retained terminal history
// (capRunQueueJobs) so the full synchronous rewrite stays small. In-flight jobs
// are always kept — see capRunQueueJobs.
const writeRunQueueJobs = (jobs: RunQueueJob[]): void =>
  writeJson(runQueuePath, sortRunQueueJobs(capRunQueueJobs(jobs)))
const runRecoveryPath = path.join(userDataPath, 'run-recovery.json')
const workspaceChangesPath = path.join(userDataPath, 'workspace-changes.json')
const approvalLedgerPath = path.join(userDataPath, 'approval-ledger.json')
// Single choke point for approval-ledger writes: cap retained non-live history
// (capApprovalLedgerRecords) so the full synchronous rewrite on every approval
// event stays bounded. Live records (pending + active session/workspace grants)
// are always kept.
const writeApprovalLedger = (records: ApprovalLedgerRecord[]): void =>
  writeJson(approvalLedgerPath, capApprovalLedgerRecords(records))
const productCrashesPath = path.join(userDataPath, 'product-crashes.json')
const runtimeProfilesPath = path.join(userDataPath, 'runtime-profiles.json')
const handoffCardsPath = path.join(userDataPath, 'handoff-cards.json')
const legacySettingsMigrationPath = path.join(userDataPath, 'legacy-settings-migration.json')
const legacyUserDataDirs = ['TaskWraith'].map((dirName) =>
  path.join(path.dirname(userDataPath), dirName)
)
const chatsDir = path.join(userDataPath, 'chats')
const chatListIndexPath = path.join(userDataPath, 'chat-list-index.json')
const auditRunsPath = path.join(userDataPath, 'audit-runs.json')
const runEventsDir = path.join(userDataPath, 'run-events')
const runArtifactsDir = path.join(userDataPath, 'run-artifacts')
const runEventSequenceCache = new Map<string, number>()
const runEventHashCache = new Map<string, string>()
// Stage 1 — durable per-execution workflow run ledger (one .jsonl per
// workflowExecutionId, append-only; the run-events model). Single writer per file.
const workflowRunsDir = path.join(userDataPath, 'workflow-runs')
const workflowRunSequenceCache = new Map<string, number>()
// Agent Pool (Phase 2) — per-Agent stats ledger (one .jsonl per pooledAgentId,
// append-only). The in-memory seen-set dedupes runIds so re-harvesting a chat
// (saveChat fires on every mutation) never double-counts; lazy-loaded per agent.
const agentStatsDir = path.join(userDataPath, 'agent-stats')
const agentStatsSeenCache = new Map<string, Set<string>>()
// Raw-delta count per agent (parallel to the seen-set) so the hot append path
// checks the compaction cap WITHOUT re-reading the file every finalized run.
const agentStatsRawCountCache = new Map<string, number>()
const deletedChatIds = new Set<string>()
const deletedRunIds = new Set<string>()
const WORKFLOW_HISTORY_LIMIT = 50
// Newest-N audit runs kept on disk. Each run holds its own findings/verdicts;
// the per-run JSONL ledger (run-events) carries the replayable detail.
const AUDIT_RUN_HISTORY_LIMIT = 100
// 1.0.6-CRUX27 — grok + cursor are first-class providers; seed their built-in
// runtime profiles too (local + global per provider, see getDefaultRuntimeProfiles)
// so their global chats have a usable runtime out of the box. Unconditional:
// unused default profiles for a force-disabled provider are harmless data.
const providerIds: ProviderId[] = ['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama']
const LEGACY_TASKWRAITH_FONT_STACK =
  '"SF Pro", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Roboto, Arial, sans-serif'
const TASKWRAITH_DEFAULT_FONT_STACK =
  '"Avenir Next", Avenir, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'

function normalizeWorkflowExecutionRecord(
  value: unknown,
  workflowId: string
): WorkflowExecutionRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkflowExecutionRecord>
  if (!input.id || typeof input.id !== 'string') return null
  const status = input.status || 'queued'
  if (
    status !== 'queued' &&
    status !== 'running' &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'cancelled' &&
    status !== 'skipped'
  ) {
    return null
  }
  const now = new Date().toISOString()
  return {
    id: input.id,
    workflowId,
    plannedFor: typeof input.plannedFor === 'string' && input.plannedFor ? input.plannedFor : now,
    status,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : now,
    ...(typeof input.scheduledTaskId === 'string'
      ? { scheduledTaskId: input.scheduledTaskId }
      : {}),
    ...(typeof input.runId === 'string' ? { runId: input.runId } : {}),
    ...(typeof input.startedAt === 'string' ? { startedAt: input.startedAt } : {}),
    ...(typeof input.completedAt === 'string' ? { completedAt: input.completedAt } : {}),
    ...(typeof input.error === 'string' ? { error: input.error } : {})
  }
}

function normalizeWorkflowTemplate(value: unknown): WorkflowRunTemplate | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkflowRunTemplate>
  if (
    !input.workspaceId ||
    !input.workspacePath ||
    !input.chatId ||
    !input.provider ||
    typeof input.prompt !== 'string'
  ) {
    return null
  }
  return {
    ...input,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    chatId: input.chatId,
    provider: input.provider,
    prompt: input.prompt,
    displayPrompt: input.displayPrompt,
    selectedModelType: input.selectedModelType || 'default',
    customModel: input.customModel || '',
    approvalMode: input.approvalMode || 'default',
    sessionTrust: Boolean(input.sessionTrust),
    imageAttachments: Array.isArray(input.imageAttachments) ? input.imageAttachments : [],
    externalPathGrants: input.externalPathGrants,
    geminiWorktree: input.geminiWorktree,
    codexReasoningEffort: input.codexReasoningEffort,
    codexServiceTier: input.codexServiceTier,
    claudeFastMode: input.claudeFastMode,
    kimiThinkingEnabled: input.kimiThinkingEnabled,
    runtimeProfileId: input.runtimeProfileId,
    geminiAuthProfileId: input.geminiAuthProfileId,
    handoffSourceRunId: input.handoffSourceRunId,
    kind: input.kind,
    ensembleSnapshot: input.ensembleSnapshot
  }
}

function normalizeWorkflowDefinitionRecord(
  value: unknown,
  nowMs: number
): WorkflowDefinition | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkflowDefinition>
  const template = normalizeWorkflowTemplate(input.template)
  if (!template) return null
  const nowIso = new Date(nowMs).toISOString()
  const id = typeof input.id === 'string' && input.id ? input.id : randomUUID()
  const trigger = normalizeWorkflowTrigger(input.trigger, nowMs)
  const history = Array.isArray(input.history)
    ? input.history
        .map((item) => normalizeWorkflowExecutionRecord(item, id))
        .filter((item): item is WorkflowExecutionRecord => Boolean(item))
        .slice(-WORKFLOW_HISTORY_LIMIT)
    : []
  const enabled = input.enabled !== false
  const nextRunAt =
    typeof input.nextRunAt === 'string' && input.nextRunAt
      ? input.nextRunAt
      : enabled
        ? resolveNextWorkflowRunAt(trigger, nowMs, nowMs)
        : undefined
  return {
    id,
    name:
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim()
        : template.prompt.slice(0, 48) || 'Workflow',
    workspaceId: template.workspaceId,
    workspacePath: template.workspacePath,
    enabled,
    trigger,
    template,
    missedRunPolicy: input.missedRunPolicy === 'skip' ? 'skip' : 'coalesce',
    concurrencyPolicy: input.concurrencyPolicy === 'enqueue' ? 'enqueue' : 'skip',
    limits: {
      ...(input.limits || {}),
      maxConsecutiveFailures:
        input.limits?.maxConsecutiveFailures && input.limits.maxConsecutiveFailures > 0
          ? Math.floor(input.limits.maxConsecutiveFailures)
          : 3
    },
    nextRunAt,
    lastRunAt: typeof input.lastRunAt === 'string' ? input.lastRunAt : undefined,
    lastCompletedAt: typeof input.lastCompletedAt === 'string' ? input.lastCompletedAt : undefined,
    lastStatus: input.lastStatus,
    lastError: typeof input.lastError === 'string' ? input.lastError : undefined,
    // Slice 7b — preserve the cached loop summary (the normalizer whitelists fields,
    // and updateWorkflowDefinition re-normalizes, so without this they'd never persist).
    lastRunIterationCount:
      typeof input.lastRunIterationCount === 'number' && Number.isFinite(input.lastRunIterationCount)
        ? Math.max(0, Math.floor(input.lastRunIterationCount))
        : undefined,
    lastRunStopReason:
      typeof input.lastRunStopReason === 'string' ? input.lastRunStopReason : undefined,
    lastRunTokens:
      typeof input.lastRunTokens === 'number' && Number.isFinite(input.lastRunTokens)
        ? Math.max(0, Math.floor(input.lastRunTokens))
        : undefined,
    failureStreak:
      typeof input.failureStreak === 'number' && Number.isFinite(input.failureStreak)
        ? Math.max(0, Math.floor(input.failureStreak))
        : 0,
    activeExecutionId:
      typeof input.activeExecutionId === 'string' ? input.activeExecutionId : undefined,
    history,
    unattendedElevation: normalizeUnattendedElevationAck(input.unattendedElevation),
    loop: normalizeWorkflowLoopConfig(input.loop),
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso
  }
}

/**
 * Structural decode for a persisted unattended-elevation ack. Keeps the blob
 * only when it is shaped like a real ack — level ∈ {safe,default,full_access}
 * and acknowledgedAt/acknowledgedApprovalMode/signature are non-empty strings.
 * The HMAC is NOT verified here (the store has no secret); cryptographic
 * verification happens at dispatch (resolveUnattendedElevation in index.ts). A
 * malformed value decodes to undefined so a hand-edited workflows.json can never
 * smuggle a partial ack past the dispatch verifier as "present".
 */
function normalizeUnattendedElevationAck(value: unknown): UnattendedElevationAck | undefined {
  if (!value || typeof value !== 'object') return undefined
  const ack = value as Partial<UnattendedElevationAck>
  if (ack.level !== 'safe' && ack.level !== 'default' && ack.level !== 'full_access') return undefined
  if (typeof ack.acknowledgedAt !== 'string' || !ack.acknowledgedAt) return undefined
  if (typeof ack.acknowledgedApprovalMode !== 'string' || !ack.acknowledgedApprovalMode) return undefined
  if (typeof ack.signature !== 'string' || !ack.signature) return undefined
  return {
    level: ack.level,
    acknowledgedAt: ack.acknowledgedAt,
    acknowledgedApprovalMode: ack.acknowledgedApprovalMode,
    signature: ack.signature
  }
}

const WORKSPACE_BOARD_DEFAULT_COLUMNS: WorkspaceBoardColumn[] = [
  { id: 'inbox', name: 'Inbox', sortOrder: 0 },
  { id: 'ready', name: 'Ready', sortOrder: 1 },
  { id: 'running', name: 'Running', sortOrder: 2 },
  { id: 'needs-input', name: 'Needs Input', sortOrder: 3 },
  { id: 'blocked', name: 'Blocked', sortOrder: 4 },
  { id: 'review-ready', name: 'Review Ready', sortOrder: 5 },
  { id: 'done', name: 'Done', sortOrder: 6 },
  { id: 'archived', name: 'Archived', sortOrder: 7 }
]

const WORKSPACE_BOARD_COLUMN_IDS = new Set<WorkspaceBoardColumnId>(
  WORKSPACE_BOARD_DEFAULT_COLUMNS.map((column) => column.id)
)
const WORKSPACE_BOARD_PROVENANCE_SOURCE_KINDS = new Set<WorkspaceBoardProvenanceSourceKind>([
  'manual',
  'capture',
  'seed',
  'duplicate',
  'thread',
  'goal',
  'plan',
  'agent'
])

function isWorkspaceBoardColumnId(value: unknown): value is WorkspaceBoardColumnId {
  return typeof value === 'string' && WORKSPACE_BOARD_COLUMN_IDS.has(value as WorkspaceBoardColumnId)
}

function normalizeWorkspaceBoardActivityEntry(
  value: unknown,
  fallbackAction: string,
  nowIso: string
): WorkspaceBoardActivityEntry | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceBoardActivityEntry>
  const action =
    typeof input.action === 'string' && input.action.trim() ? input.action.trim() : fallbackAction
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    at: typeof input.at === 'string' && input.at ? input.at : nowIso,
    actor: input.actor === 'agent' || input.actor === 'system' ? input.actor : 'user',
    action,
    detail: typeof input.detail === 'string' && input.detail.trim() ? input.detail.trim() : undefined
  }
}

function workspaceBoardActivityActorFromProvenance(
  provenance: unknown
): WorkspaceBoardActivityEntry['actor'] {
  if (!provenance || typeof provenance !== 'object') return 'user'
  const actor = (provenance as Partial<WorkspaceBoardProvenance>).actor
  return actor === 'agent' || actor === 'system' ? actor : 'user'
}

function normalizeWorkspaceBoardProvenance(value: unknown, nowIso: string): WorkspaceBoardProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<WorkspaceBoardProvenance>
  const sourceKind = WORKSPACE_BOARD_PROVENANCE_SOURCE_KINDS.has(input.sourceKind as WorkspaceBoardProvenanceSourceKind)
    ? (input.sourceKind as WorkspaceBoardProvenanceSourceKind)
    : 'manual'
  return {
    actor: input.actor === 'agent' || input.actor === 'system' ? input.actor : 'user',
    sourceKind,
    at: typeof input.at === 'string' && input.at ? input.at : nowIso,
    trust:
      input.trust === 'agent-proposed' || input.trust === 'system-derived' || input.trust === 'user-confirmed'
        ? input.trust
        : undefined,
    sourceId: typeof input.sourceId === 'string' && input.sourceId.trim() ? input.sourceId.trim() : undefined,
    sourceTitle: typeof input.sourceTitle === 'string' && input.sourceTitle.trim() ? input.sourceTitle.trim() : undefined,
    provider: typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : undefined,
    runId: typeof input.runId === 'string' && input.runId.trim() ? input.runId.trim() : undefined,
    note: typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined
  }
}

function normalizeWorkspaceBoardColumns(value: unknown): WorkspaceBoardColumn[] {
  const provided = Array.isArray(value) ? value : []
  const byId = new Map<WorkspaceBoardColumnId, WorkspaceBoardColumn>()
  for (const item of provided) {
    if (!item || typeof item !== 'object') continue
    const input = item as Partial<WorkspaceBoardColumn>
    if (!isWorkspaceBoardColumnId(input.id)) continue
    byId.set(input.id, {
      id: input.id,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : input.id,
      sortOrder:
        typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
          ? Math.max(0, Math.floor(input.sortOrder))
          : WORKSPACE_BOARD_DEFAULT_COLUMNS.find((column) => column.id === input.id)?.sortOrder || 0,
      wipLimit:
        typeof input.wipLimit === 'number' && Number.isFinite(input.wipLimit) && input.wipLimit > 0
          ? Math.floor(input.wipLimit)
          : undefined
    })
  }
  for (const column of WORKSPACE_BOARD_DEFAULT_COLUMNS) {
    if (!byId.has(column.id)) byId.set(column.id, column)
  }
  return Array.from(byId.values()).sort((a, b) => a.sortOrder - b.sortOrder)
}

function normalizeWorkspaceBoardLink(value: unknown): WorkspaceBoardCardLink | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<WorkspaceBoardCardLink>
  if (
    input.kind !== 'chat' &&
    input.kind !== 'workflow' &&
    input.kind !== 'scheduled-task' &&
    input.kind !== 'run-queue-job' &&
    input.kind !== 'local-server'
  ) {
    return undefined
  }
  if (typeof input.id !== 'string' || !input.id.trim()) return undefined
  return { kind: input.kind, id: input.id.trim() }
}

function normalizeWorkspaceBoardDefinitionRecord(
  value: unknown,
  nowMs: number
): WorkspaceBoardDefinition | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceBoardDefinition>
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) return null
  if (typeof input.workspacePath !== 'string' || !input.workspacePath.trim()) return null
  const nowIso = new Date(nowMs).toISOString()
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Workspace Board',
    description:
      typeof input.description === 'string' && input.description.trim()
        ? input.description.trim()
        : undefined,
    columns: normalizeWorkspaceBoardColumns(input.columns),
    provenance: normalizeWorkspaceBoardProvenance(input.provenance, nowIso),
    pinned: input.pinned === true,
    archived: input.archived === true,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso,
    activity: Array.isArray(input.activity)
      ? input.activity
          .map((entry) => normalizeWorkspaceBoardActivityEntry(entry, 'updated', nowIso))
          .filter((entry): entry is WorkspaceBoardActivityEntry => Boolean(entry))
          .slice(-100)
      : []
  }
}

function normalizeWorkspaceBoardCardRecord(
  value: unknown,
  nowMs: number
): WorkspaceBoardCard | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<WorkspaceBoardCard>
  if (typeof input.boardId !== 'string' || !input.boardId.trim()) return null
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) return null
  const nowIso = new Date(nowMs).toISOString()
  const labels = Array.isArray(input.labels)
    ? input.labels
        .filter((label): label is string => typeof label === 'string')
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, 12)
    : undefined
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    boardId: input.boardId,
    workspaceId: input.workspaceId,
    columnId: isWorkspaceBoardColumnId(input.columnId) ? input.columnId : 'inbox',
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled card',
    body: typeof input.body === 'string' && input.body.trim() ? input.body.trim() : undefined,
    sortOrder:
      typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
        ? Math.max(0, Math.floor(input.sortOrder))
        : nowMs,
    humanOwner:
      typeof input.humanOwner === 'string' && input.humanOwner.trim()
        ? input.humanOwner.trim()
        : undefined,
    labels,
    link: normalizeWorkspaceBoardLink(input.link),
    blockedReason:
      typeof input.blockedReason === 'string' && input.blockedReason.trim()
        ? input.blockedReason.trim()
        : undefined,
    nextStep:
      typeof input.nextStep === 'string' && input.nextStep.trim()
        ? input.nextStep.trim()
        : undefined,
    reminderAt:
      typeof input.reminderAt === 'string' && input.reminderAt.trim()
        ? input.reminderAt.trim()
        : undefined,
    provenance: normalizeWorkspaceBoardProvenance(input.provenance, nowIso),
    archived: input.archived === true,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso,
    activity: Array.isArray(input.activity)
      ? input.activity
          .map((entry) => normalizeWorkspaceBoardActivityEntry(entry, 'updated', nowIso))
          .filter((entry): entry is WorkspaceBoardActivityEntry => Boolean(entry))
          .slice(-100)
      : []
  }
}

function scheduledTaskStatusToWorkflowStatus(
  status: ScheduledTask['status']
): WorkflowExecutionRecord['status'] | null {
  if (status === 'running') return 'running'
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  return null
}

/** Map a workflow execution status to a durable-ledger event kind (Stage 1). */
function workflowStatusToRunEventKind(
  status: WorkflowExecutionRecord['status']
): WorkflowRunEvent['kind'] | null {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'skipped':
      return 'skipped'
    case 'queued':
      return 'materialized'
    default:
      return null
  }
}

function isTerminalScheduledTaskStatus(status: ScheduledTask['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function isInvalidScheduledTaskStatusTransition(
  current: ScheduledTask['status'],
  next: ScheduledTask['status']
): boolean {
  if (isTerminalScheduledTaskStatus(current) && next !== current) return true
  if (current === 'running' && (next === 'pending' || next === 'due')) return true
  return false
}

function sameWorkflowPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return path.resolve(a) === path.resolve(b)
}

/** Defensive shape-guard for a persisted audit run. Arrays default to empty
 * and the budget/coverage substructures are tolerated-missing so records
 * written by an older build still decode. Returns null only when the record
 * is too malformed to be useful (no id). */
function normalizeAuditRunRecord(value: unknown): AuditRunRecord | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<AuditRunRecord>
  if (typeof input.id !== 'string' || !input.id) return null
  const nowIso = new Date().toISOString()
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    schemaVersion: 1,
    id: input.id,
    mode: input.mode === 'deep' || input.mode === 'release' ? input.mode : 'quick',
    chatId: typeof input.chatId === 'string' ? input.chatId : '',
    workspaceId: typeof input.workspaceId === 'string' ? input.workspaceId : undefined,
    workspacePath: typeof input.workspacePath === 'string' ? input.workspacePath : '',
    status: input.status ?? 'planning',
    phases: arr<AuditRunRecord['phases'][number]>(input.phases),
    profile: input.profile,
    dimensions: arr<string>(input.dimensions),
    roster: input.roster,
    participants: arr<AuditParticipant>(input.participants),
    findings: arr<AuditFinding>(input.findings),
    verdicts: arr<AuditVerdict>(input.verdicts),
    gates: arr<AuditGateResult>(input.gates),
    budget: input.budget ?? {
      maxAgents: 0,
      spentAgents: 0,
      spentTokens: 0,
      truncated: false
    },
    coverage: input.coverage,
    report: typeof input.report === 'string' ? input.report : undefined,
    error: typeof input.error === 'string' ? input.error : undefined,
    createdAt: typeof input.createdAt === 'string' && input.createdAt ? input.createdAt : nowIso,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : nowIso,
    startedAt: typeof input.startedAt === 'string' ? input.startedAt : undefined,
    endedAt: typeof input.endedAt === 'string' ? input.endedAt : undefined
  }
}

const defaultSettings: AppSettings = {
  activeProvider: DEFAULT_PROVIDER,
  providerRunPauses: {},
  autoFailoverEnabled: false,
  workflowBudgetKillEnabled: true,
  userName: '',
  claudeBinaryPath: '',
  kimiBinaryPath: '',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaDefaultModel: '',
  ollamaToolControlTier: 'read_only',
  ollamaDefaultRunProfile: 'local_scout',
  ollamaRunProfiles: {},
  defaultGeminiAuthProfileId: null,
  geminiAuthProfiles: [],
  geminiApiRuntime: 'auto',
  userMcpServers: [],
  storeLocalChatHistory: true,
  storeRawEvents: false,
  storePromptResponseInUsage: false,
  ensembleModeEnabled: true,
  geminiCheckpointingEnabled: false,
  chatContextTurns: 6,
  appearanceMode: 'soft_glass',
  visualEffectStyle: 'auto',
  themeAppearance: 'system',
  themeCornerStyle: 'rounded',
  themeAccentStyle: 'system',
  toolIconAccent: 'system',
  userBubbleColor: 'system',
  appIconVariant: 'regular',
  promptSurfaceStyle: 'liquid_glass',
  composerStyle: 'default',
  transcriptFontFamily: TASKWRAITH_DEFAULT_FONT_STACK,
  composerFontFamily: 'match-transcript',
  keyCommandBindings: {},
  // 1.0.5-EW25 — Display currency for cost / token-spend chips.
  // USD by default; user can switch to GBP / EUR via Settings →
  // General. Rates are static approximations (see `formatCost.ts`).
  currency: 'USD',
  // 1.0.5-EW34 — Currency sub-slice (e): conservative-overestimate
  // bias percent. Default 0 (no change). Slider in Settings →
  // General lets the user dial 0–25%. Applied in `formatCost.ts`
  // before FX conversion so the bias is currency-agnostic.
  currencyOverestimatePercent: 0,
  showRunCompleteSummary: true,
  ensembleCollapseOlderRounds: true,
  dashboardStatPrefs: {
    dashboardSize: 'small'
  },
  welcomeHeatmapPrefs: {
    layout: 'single',
    workspaceActivityEnabled: true,
    taskwraithActivityEnabled: true,
    externalActivityEnabled: true
  },
  // 1.0.5-EW26 — Kimi compatibility filter defaults. On by
  // default so Moonshot content_filter retries get the compatibility
  // pass automatically. Custom keywords stay empty until the user
  // adds any.
  kimiSanitiserEnabled: true,
  kimiSanitiserCustomKeywords: '',
  // 1.0.7-M10 — second-pass classifier stays opt-in; when unset
  // or false, the retry envelope remains keyword-only.
  kimiClassifierEnabled: false,
  reduceTransparency: false,
  reduceMotion: false,
  compactDensity: false,
  liveActivityViewport: true,
  showInspector: true,
  inspectorWidth: 380,
  sidebarWidth: 260,
  sidebarOpacity: 100,
  mainPaneOpacity: 100,
  sidebarOpacityOverride: false,
  mainPaneOpacityOverride: false,
  funFxEnabled: true,
  funFxMode: 'cinematic',
  advancedFx: {
    agentAura: true,
    livingWorkspace: true,
    dataViz: true,
    refraction: true,
    intensity: 'cinematic'
  },
  agenticServices: {
    shellCommands: 'workspace',
    fileChanges: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    crossThreadRead: 'ask',
    mediaEditing: 'ask',
    mediaRecording: 'deny',
    canvasEval: 'ask',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: [],
  nativeSubAgentRequests: 'ask',
  // Default on — the user-visible win is that delegated sub-threads
  // resume their parent agent automatically when they finish. Users
  // who prefer to nudge manually can flip this off in Settings.
  autoResumeParentOnSubThreadCompletion: true,
  geminiMcpBridgeEnabled: false,
  geminiMcpBridgeLastStatus: undefined,
  approvalModeElevationAcknowledgements: {},
  bridgeDaemonEnabled: true,
  iosRemoteEnabled: true,
  iosRemoteManualRelayUrl: '',
  messageBridgeEnabled: false,
  messageBridgePollIntervalMs: 30_000,
  codexSandboxFallback: 'ask_rerun',
  autoUpdateEnabled: true,
  updateChannel: 'stable',
  approvalTimeouts: {
    enabled: true,
    // Defaults mirror DEFAULT_APPROVAL_TIMEOUT_POLICY in
    // ApprovalTimeoutScheduler.ts. Keep them in sync — these are the
    // numbers from the original plan-file decisions.
    perProviderMs: {
      gemini: 120_000,
      codex: 30_000,
      claude: 120_000,
      kimi: 60_000
    },
    mainAuthorityMs: 60_000
  }
}

function readJson<T>(filePath: string, defaultData: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(data)
    }
  } catch (e) {
    console.error(`Failed to read ${filePath}`, e)
    try {
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, `${filePath}.corrupt-${Date.now()}`)
      }
    } catch (backupError) {
      console.error(`Failed to preserve corrupt ${filePath}`, backupError)
    }
  }
  return defaultData
}

function objectOrUndefined<T extends object>(value: T | null | undefined): T | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function normalizeKeyCommandBindings(
  value: Partial<AppSettings>['keyCommandBindings']
): AppSettings['keyCommandBindings'] {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record) return {}
  const normalized: AppSettings['keyCommandBindings'] = {}
  for (const [id, binding] of Object.entries(record)) {
    if (binding === null) {
      normalized[id] = null
      continue
    }
    const bindingRecord = objectOrUndefined(binding as Record<string, unknown> | null | undefined)
    if (!bindingRecord) continue
    const key = typeof bindingRecord.key === 'string' ? bindingRecord.key.trim() : ''
    if (!key) continue
    const modifiers = Array.isArray(bindingRecord.modifiers)
      ? bindingRecord.modifiers.filter(
          (modifier): modifier is 'primary' | 'shift' | 'alt' =>
            modifier === 'primary' || modifier === 'shift' || modifier === 'alt'
        )
      : []
    normalized[id] = { key, modifiers }
  }
  return normalized
}

function isValidUserMcpRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizePluginResourceProvenance(
  value: unknown
): TaskWraithPluginResourceProvenance | undefined {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record) return undefined
  const stringField = (key: string): string => {
    const raw = record[key]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const source =
    record.source === 'builtin' || record.source === 'local' || record.source === 'marketplace'
      ? record.source
      : undefined
  const kind =
    record.kind === 'mcpServer' ||
    record.kind === 'workflowTemplate' ||
    record.kind === 'runtimeProfile' ||
    record.kind === 'connector' ||
    record.kind === 'localService' ||
    record.kind === 'remoteProjection'
      ? record.kind
      : undefined
  const pluginId = stringField('pluginId')
  const publisher = stringField('publisher')
  const version = stringField('version')
  const namespace = stringField('namespace')
  const manifestHash = stringField('manifestHash')
  const objectId = stringField('objectId')
  const materializedAt = stringField('materializedAt')
  if (
    !pluginId ||
    !publisher ||
    !version ||
    !source ||
    !namespace ||
    !manifestHash ||
    !kind ||
    !objectId ||
    !materializedAt
  ) {
    return undefined
  }
  return {
    pluginId,
    publisher,
    version,
    source,
    namespace,
    manifestHash,
    kind,
    objectId,
    materializedAt
  }
}

function normalizeUserMcpServers(value: unknown): UserMcpServerConfig[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const servers: UserMcpServerConfig[] = []
  for (const item of value.slice(0, 64)) {
    const record = objectOrUndefined(item as Record<string, unknown> | null | undefined)
    if (!record) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    const transport =
      record.transport === 'http' || record.transport === 'sse' ? record.transport : 'stdio'
    const args = Array.isArray(record.args)
      ? record.args
          .filter((arg): arg is string => typeof arg === 'string')
          .map((arg) => arg.trim())
          .filter(Boolean)
          .slice(0, 64)
      : []
    const envRecord = objectOrUndefined(record.env as Record<string, unknown> | null | undefined)
    const env = envRecord
      ? Object.fromEntries(
          Object.entries(envRecord)
            .filter(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof val === 'string')
            .map(([key, val]) => [key, val])
            .slice(0, 64)
        )
      : {}
    const headersRecord = objectOrUndefined(
      record.headers as Record<string, unknown> | null | undefined
    )
    const headers = headersRecord
      ? Object.fromEntries(
          Object.entries(headersRecord)
            .filter(
              ([key, val]) =>
                /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof val === 'string'
            )
            .map(([key, val]) => [key, val])
            .slice(0, 64)
        )
      : {}
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    const rawUrl = typeof record.url === 'string' ? record.url.trim() : ''
    const url = rawUrl && isValidUserMcpRemoteUrl(rawUrl) ? rawUrl : ''
    const bearerTokenEnvVar =
      typeof record.bearerTokenEnvVar === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(record.bearerTokenEnvVar.trim())
        ? record.bearerTokenEnvVar.trim()
        : ''
    const pluginProvenance = normalizePluginResourceProvenance(record.pluginProvenance)
    const canEnable = transport === 'stdio' ? Boolean(command) : Boolean(url)
    const normalized: UserMcpServerConfig = {
      id,
      name,
      enabled: Boolean(record.enabled && canEnable),
      transport
    }
    if (command) normalized.command = command
    if (args.length > 0) normalized.args = args
    if (url) normalized.url = url
    if (Object.keys(env).length > 0) normalized.env = env
    if (Object.keys(headers).length > 0) normalized.headers = headers
    if (bearerTokenEnvVar) normalized.bearerTokenEnvVar = bearerTokenEnvVar
    if (typeof record.description === 'string' && record.description.trim()) {
      normalized.description = record.description.trim()
    }
    if (pluginProvenance) normalized.pluginProvenance = pluginProvenance
    if (typeof record.createdAt === 'string' && record.createdAt.trim()) {
      normalized.createdAt = record.createdAt.trim()
    }
    if (typeof record.updatedAt === 'string' && record.updatedAt.trim()) {
      normalized.updatedAt = record.updatedAt.trim()
    }
    servers.push(normalized)
  }
  return servers
}

function normalizeUpdateChangelog(value: unknown): ProductUpdateChangelog | undefined {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record || typeof record.version !== 'string' || !record.version.trim()) {
    return undefined
  }
  const releaseNotes = record.releaseNotes
  const normalized: ProductUpdateChangelog = {
    version: record.version.trim()
  }
  if (typeof record.releaseName === 'string' && record.releaseName.trim()) {
    normalized.releaseName = record.releaseName.trim()
  }
  if (typeof record.releaseDate === 'string' && record.releaseDate.trim()) {
    normalized.releaseDate = record.releaseDate.trim()
  }
  if (typeof releaseNotes === 'string') {
    normalized.releaseNotes = releaseNotes
  } else if (Array.isArray(releaseNotes)) {
    const notes = releaseNotes
      .map((item) => {
        const noteRecord = objectOrUndefined(item as Record<string, unknown> | null | undefined)
        if (!noteRecord || typeof noteRecord.version !== 'string' || !noteRecord.version.trim()) {
          return null
        }
        return {
          version: noteRecord.version.trim(),
          note: typeof noteRecord.note === 'string' ? noteRecord.note : null
        }
      })
      .filter((item): item is { version: string; note: string | null } => item !== null)
    if (notes.length > 0) {
      normalized.releaseNotes = notes
    }
  }
  return normalized
}

function normalizeSettingsFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed === LEGACY_TASKWRAITH_FONT_STACK ? TASKWRAITH_DEFAULT_FONT_STACK : trimmed
}

function writeJson<T>(filePath: string, data: T) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fd = fs.openSync(tempPath, 'w')
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf-8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tempPath, filePath)
    try {
      const dirFd = fs.openSync(path.dirname(filePath), 'r')
      fs.fsyncSync(dirFd)
      fs.closeSync(dirFd)
    } catch {
      // Directory fsync is best effort on some filesystems.
    }
  } catch (e) {
    console.error(`Failed to write ${filePath}`, e)
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best effort: preserve the original write failure.
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // Best effort: stale temp files are safer than masking the original failure.
    }
  }
}

/** Atomic raw-text write (temp + rename), for the jsonl-line compaction rewrite
 *  where writeJson's pretty-printing would corrupt the line-delimited format. */
function writeTextAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fd = fs.openSync(tempPath, 'w')
    fs.writeFileSync(fd, content, 'utf-8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tempPath, filePath)
  } catch (e) {
    console.error(`Failed to write ${filePath}`, e)
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best effort.
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // Best effort.
    }
  }
}

function previewText(value: unknown, maxLength: number): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

function summarizeLastRun(
  run: ChatRecord['runs'][number] | undefined
): ChatRecord['runs'][number] | undefined {
  if (!run) return undefined
  return {
    runId: run.runId,
    provider: run.provider,
    providerRunId: run.providerRunId,
    providerThreadId: run.providerThreadId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    requestedModel: run.requestedModel,
    actualModel: run.actualModel,
    approvalMode: run.approvalMode,
    status: run.status,
    cancelled: run.cancelled,
    exitCode: run.exitCode,
    runtimeProfileId: run.runtimeProfileId,
    geminiAuthProfileId: run.geminiAuthProfileId,
    ensembleRoundId: run.ensembleRoundId,
    ensembleParticipantId: run.ensembleParticipantId,
    ensembleRole: run.ensembleRole,
    ensembleOrder: run.ensembleOrder
  }
}

function migrateLegacySettingsIfMissing() {
  if (fs.existsSync(settingsPath)) {
    return
  }

  for (const legacyDir of legacyUserDataDirs) {
    const legacySettingsPath = path.join(legacyDir, 'settings.json')
    if (!fs.existsSync(legacySettingsPath)) {
      continue
    }

    try {
      const legacySettings = JSON.parse(
        fs.readFileSync(legacySettingsPath, 'utf-8')
      ) as Partial<AppSettings>
      writeJson(settingsPath, {
        ...legacySettings,
        geminiMcpBridgeLastStatus: undefined
      })
      writeJson(legacySettingsMigrationPath, {
        migratedAt: new Date().toISOString(),
        source: legacySettingsPath
      })
    } catch (e) {
      console.error(`Failed to migrate legacy settings from ${legacySettingsPath}`, e)
    }
    return
  }
}

function runEventFilePath(runId: string): string {
  return path.join(runEventsDir, safeRunEventFileName(runId))
}

function workflowRunFilePath(workflowExecutionId: string): string {
  return path.join(workflowRunsDir, safeWorkflowRunFileName(workflowExecutionId))
}

function agentStatsFilePath(agentId: string): string {
  return path.join(agentStatsDir, safeAgentStatsFileName(agentId))
}

function readAgentStatsFile(filePath: string): AgentStatRecord[] {
  try {
    if (!fs.existsSync(filePath)) return []
    return fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map(parseAgentStatRecordLine)
      .filter((record): record is AgentStatRecord => Boolean(record))
  } catch (e) {
    console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

/** Async twin — the per-file await yields the event loop so a renderer pool-open
 *  summaries query can't beachball MAIN (mirrors readWorkflowRunFileAsync). */
async function readAgentStatsFileAsync(filePath: string): Promise<AgentStatRecord[]> {
  try {
    return (await fs.promises.readFile(filePath, 'utf-8'))
      .split(/\r?\n/)
      .map(parseAgentStatRecordLine)
      .filter((record): record is AgentStatRecord => Boolean(record))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

function readWorkflowRunFile(filePath: string): WorkflowRunEvent[] {
  try {
    if (!fs.existsSync(filePath)) return []
    return fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map(parseWorkflowRunEventLine)
      .filter((event): event is WorkflowRunEvent => Boolean(event))
  } catch (e) {
    console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

/** Async twin of readWorkflowRunFile — the per-file await yields the event loop so
 * a renderer summaries query (slice 4) can't beachball MAIN (mirrors
 * readRunEventFileAsync). */
async function readWorkflowRunFileAsync(filePath: string): Promise<WorkflowRunEvent[]> {
  try {
    return (await fs.promises.readFile(filePath, 'utf-8'))
      .split(/\r?\n/)
      .map(parseWorkflowRunEventLine)
      .filter((event): event is WorkflowRunEvent => Boolean(event))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

/** Newest-first sort key for a run-execution summary: the latest meaningful
 * timestamp it has (completed > started > dispatched > planned). 0 when none parse. */
function workflowRunSummarySortKey(summary: WorkflowRunSummary): number {
  const ts = summary.completedAt || summary.startedAt || summary.dispatchedAt || summary.plannedFor
  const ms = ts ? Date.parse(ts) : Number.NaN
  return Number.isFinite(ms) ? ms : 0
}

// Per-run artifact directory. Mirrors the path derivation in
// appendRunStreamArtifact (the `.jsonl`-stripped run file name is used as a
// dedicated directory holding stdout/stderr/stdin .log files for the run), so
// every artifact for a given runId lives under exactly this path. Deriving it
// from `safeRunEventFileName` keeps deletion in lockstep with creation.
function runArtifactDirPath(runId: string): string {
  return path.join(runArtifactsDir, safeRunEventFileName(runId).replace(/\.jsonl$/, ''))
}

// Best-effort, non-fatal cleanup of one run's on-disk forensic data: its
// run-event `.jsonl` ledger and its artifact directory. Each removal is mapped
// from a KNOWN runId via the deterministic safeRunEventFileName transform — we
// never readdir-and-match-by-prefix, so a sibling run whose id is a prefix of
// this one (e.g. `run-1` vs `run-1-extra`) can never be caught: the targets are
// exact file/dir names (`run-1.jsonl` ≠ `run-1-extra.jsonl`). Missing files are
// ignored so a partially-written run cannot abort the chat deletion.
function deleteRunForensicFiles(runId: string): void {
  if (!runId) return
  deletedRunIds.add(runId)
  runEventSequenceCache.delete(runId)
  runEventHashCache.delete(runId)
  try {
    fs.rmSync(runEventFilePath(runId), { force: true })
  } catch (e) {
    console.error(`Failed to delete run-event file for run ${runId}`, e)
  }
  try {
    fs.rmSync(runArtifactDirPath(runId), { recursive: true, force: true })
  } catch (e) {
    console.error(`Failed to delete run artifacts for run ${runId}`, e)
  }
}

function deletePathBestEffort(targetPath: string, label: string): void {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true })
  } catch (e) {
    console.error(`Failed to delete ${label}`, e)
  }
}

function tombstoneRunEventFiles(): void {
  try {
    if (!fs.existsSync(runEventsDir)) return
    for (const file of fs.readdirSync(runEventsDir).filter((item) => item.endsWith('.jsonl'))) {
      const runId = path.basename(file, '.jsonl')
      if (!runId) continue
      deletedRunIds.add(runId)
      runEventSequenceCache.delete(runId)
      runEventHashCache.delete(runId)
    }
  } catch {
    // Best-effort; direct directory deletion below is still authoritative.
  }
}

function tombstoneRunArtifactDirs(): void {
  try {
    if (!fs.existsSync(runArtifactsDir)) return
    for (const entry of fs.readdirSync(runArtifactsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      deletedRunIds.add(entry.name)
      runEventSequenceCache.delete(entry.name)
      runEventHashCache.delete(entry.name)
    }
  } catch {
    // Best-effort; direct directory deletion below is still authoritative.
  }
}

function readRunEventFile(filePath: string): RunEventRecord[] {
  try {
    if (!fs.existsSync(filePath)) return []
    return fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map(parseRunEventLine)
      .filter((event): event is RunEventRecord => Boolean(event))
  } catch (e) {
    console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

function readAllRunEventFiles(): RunEventRecord[] {
  try {
    if (!fs.existsSync(runEventsDir)) return []
    return fs
      .readdirSync(runEventsDir)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) => readRunEventFile(path.join(runEventsDir, file)))
  } catch (e) {
    console.error(`Failed to read ${runEventsDir}`, e)
    return []
  }
}

/** Upper bound on per-chat run-event files scanned for a `{chatId}` query, so a
 * pathologically long thread can't re-introduce a (smaller) sweep. Newest runs
 * are read first, so the cap only ever drops the oldest runs — well beyond any
 * realistic `limit`. */
const RUN_EVENT_CHAT_FILE_CAP = 120

async function readRunEventFileAsync(filePath: string): Promise<RunEventRecord[]> {
  try {
    return (await fs.promises.readFile(filePath, 'utf-8'))
      .split(/\r?\n/)
      .map(parseRunEventLine)
      .filter((event): event is RunEventRecord => Boolean(event))
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

/** Async twin of `readRunEventFile` over many paths — sequential `await` per file
 * yields the event loop between files. */
async function readRunEventFilesAsync(paths: string[]): Promise<RunEventRecord[]> {
  const all: RunEventRecord[] = []
  for (const filePath of paths) {
    for (const event of await readRunEventFileAsync(filePath)) all.push(event)
  }
  return all
}

/** Async twin of `readAllRunEventFiles`. The per-file `await` yields the event
 * loop, so even a (rare, no-filter) multi-GB forensics sweep can't beachball the
 * MAIN thread the way the sync version did. */
async function readAllRunEventFilesAsync(): Promise<RunEventRecord[]> {
  try {
    const files = (await fs.promises.readdir(runEventsDir)).filter((file) =>
      file.endsWith('.jsonl')
    )
    const all: RunEventRecord[] = []
    for (const file of files) {
      for (const event of await readRunEventFileAsync(path.join(runEventsDir, file))) {
        all.push(event)
      }
    }
    return all
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.error(`Failed to read ${runEventsDir}`, e)
    return []
  }
}

function extractRunStreamText(
  input: RunEventInput
): { stream: 'stdout' | 'stderr' | 'stdin'; text: string } | null {
  if (input.kind === 'provider_raw') {
    const payload = input.payload as { data?: unknown } | string | undefined
    const text =
      typeof payload === 'string' ? payload : typeof payload?.data === 'string' ? payload.data : ''
    return text ? { stream: 'stdout', text } : null
  }
  if (input.kind === 'provider_error') {
    const payload = input.payload as { error?: unknown } | string | undefined
    const text =
      typeof payload === 'string'
        ? payload
        : typeof payload?.error === 'string'
          ? payload.error
          : ''
    return text ? { stream: 'stderr', text } : null
  }
  return null
}

function appendRunStreamArtifact(
  input: RunEventInput,
  sequence: number
): RunEventArtifactRef[] | undefined {
  const stream = extractRunStreamText(input)
  if (!stream) return undefined
  const runFileName = safeRunEventFileName(input.runId).replace(/\.jsonl$/, '')
  const artifactRelativePath = path.join(
    safeRunEventFileName(input.runId).replace(/\.jsonl$/, ''),
    `${stream.stream}.log`
  )
  const artifactPath = path.join(runArtifactsDir, artifactRelativePath)
  const bytes = Buffer.from(redactSecrets(stream.text), 'utf8')
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
  fs.appendFileSync(artifactPath, bytes)
  return [
    {
      id: `${runFileName}:${stream.stream}:${sequence}`,
      kind: stream.stream,
      path: artifactRelativePath.split(path.sep).join('/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.byteLength,
      sequence
    }
  ]
}

export class AppStore {
  static resetTransientDeletionGuardsForTests(): void {
    deletedChatIds.clear()
    deletedRunIds.clear()
    runEventSequenceCache.clear()
    runEventHashCache.clear()
    this.chatRecordCache.clear()
    this.orphanSubThreadsReaped = false
  }

  // Settings
  static getSettings(): AppSettings {
    migrateLegacySettingsIfMissing()
    const stored = readJson<Partial<AppSettings>>(settingsPath, {})
    const storedDashboardStatPrefs = objectOrUndefined(stored.dashboardStatPrefs)
    const storedWelcomeHeatmapPrefs = objectOrUndefined(stored.welcomeHeatmapPrefs)
    const storedApprovalModeElevationAcks = objectOrUndefined(
      stored.approvalModeElevationAcknowledgements
    )
    const storedOllamaProviderParityWorkspaceGrants = objectOrUndefined(
      stored.ollamaProviderParityWorkspaceGrants
    )
    const storedApprovalTimeouts = objectOrUndefined(stored.approvalTimeouts)
    const storedApprovalTimeoutProviderMs = objectOrUndefined(storedApprovalTimeouts?.perProviderMs)
    const pendingUpdateChangelog = normalizeUpdateChangelog(stored.pendingUpdateChangelog)
    return {
      ...defaultSettings,
      ...stored,
      providerRunPauses: sanitizeProviderRunPauses(stored.providerRunPauses),
      advancedFx: {
        ...defaultSettings.advancedFx,
        ...(stored.advancedFx || {})
      },
      defaultGeminiAuthProfileId:
        typeof stored.defaultGeminiAuthProfileId === 'string'
          ? stored.defaultGeminiAuthProfileId
          : stored.defaultGeminiAuthProfileId === null
            ? null
            : defaultSettings.defaultGeminiAuthProfileId,
      geminiAuthProfiles: Array.isArray(stored.geminiAuthProfiles) ? stored.geminiAuthProfiles : [],
      userMcpServers: normalizeUserMcpServers(stored.userMcpServers),
      transcriptFontFamily: normalizeSettingsFontFamily(
        stored.transcriptFontFamily,
        defaultSettings.transcriptFontFamily || TASKWRAITH_DEFAULT_FONT_STACK
      ),
      composerFontFamily: normalizeSettingsFontFamily(
        stored.composerFontFamily,
        defaultSettings.composerFontFamily || 'match-transcript'
      ),
      keyCommandBindings: normalizeKeyCommandBindings(stored.keyCommandBindings),
      // Phase M1 — coerce any non-enum value (missing, typo'd, legacy)
      // back to the safe default so the eventual API-vs-CLI dispatch
      // logic never sees an unexpected mode.
      geminiApiRuntime:
        stored.geminiApiRuntime === 'auto' ||
        stored.geminiApiRuntime === 'always' ||
        stored.geminiApiRuntime === 'never'
          ? stored.geminiApiRuntime
          : defaultSettings.geminiApiRuntime,
      ollamaToolControlTier:
        stored.ollamaToolControlTier === 'approved_edits' ||
        stored.ollamaToolControlTier === 'approved_shell' ||
        stored.ollamaToolControlTier === 'provider_parity'
          ? stored.ollamaToolControlTier
          : defaultSettings.ollamaToolControlTier,
      ollamaDefaultRunProfile:
        stored.ollamaDefaultRunProfile === 'local_scout' ||
        stored.ollamaDefaultRunProfile === 'approved_patcher' ||
        stored.ollamaDefaultRunProfile === 'verify_with_shell' ||
        stored.ollamaDefaultRunProfile === 'provider_parity' ||
        stored.ollamaDefaultRunProfile === 'custom'
          ? stored.ollamaDefaultRunProfile
          : defaultSettings.ollamaDefaultRunProfile,
      ollamaRunProfiles: objectOrUndefined(stored.ollamaRunProfiles) || {},
      ollamaProviderParityAcknowledgedAt:
        typeof stored.ollamaProviderParityAcknowledgedAt === 'string' &&
        stored.ollamaProviderParityAcknowledgedAt.trim()
          ? stored.ollamaProviderParityAcknowledgedAt.trim()
          : undefined,
      ollamaProviderParityWorkspaceGrants: Object.fromEntries(
        Object.entries(storedOllamaProviderParityWorkspaceGrants || {}).filter(
          (entry): entry is [string, string] =>
            typeof entry[0] === 'string' &&
            entry[0].trim().length > 0 &&
            typeof entry[1] === 'string' &&
            entry[1].trim().length > 0
        )
      ),
      agenticServices: {
        ...defaultSettings.agenticServices,
        ...(stored.agenticServices || {})
      },
      dashboardStatPrefs: {
        ...(defaultSettings.dashboardStatPrefs || {}),
        ...(storedDashboardStatPrefs || {})
      },
      approvalModeElevationAcknowledgements: {
        ...(defaultSettings.approvalModeElevationAcknowledgements || {}),
        ...(storedApprovalModeElevationAcks || {})
      },
      welcomeHeatmapPrefs: {
        ...defaultSettings.welcomeHeatmapPrefs,
        ...(storedWelcomeHeatmapPrefs || {})
      },
      agenticWorkspaceGrants: Array.isArray(stored.agenticWorkspaceGrants)
        ? stored.agenticWorkspaceGrants
        : [],
      nativeSubAgentRequests:
        stored.nativeSubAgentRequests === 'provider' ||
        stored.nativeSubAgentRequests === 'taskwraith'
          ? stored.nativeSubAgentRequests
          : 'ask',
      lastSeenChangelogVersion:
        typeof stored.lastSeenChangelogVersion === 'string' &&
        stored.lastSeenChangelogVersion.trim()
          ? stored.lastSeenChangelogVersion.trim()
          : undefined,
      pendingUpdateChangelog,
      // Normalize: a stored non-boolean (e.g. an older settings file
      // where the field is missing) falls back to the default (true)
      // so the auto-resume behaviour is on for upgrading users.
      autoResumeParentOnSubThreadCompletion:
        typeof stored.autoResumeParentOnSubThreadCompletion === 'boolean'
          ? stored.autoResumeParentOnSubThreadCompletion
          : defaultSettings.autoResumeParentOnSubThreadCompletion,
      messageBridgeEnabled:
        typeof stored.messageBridgeEnabled === 'boolean'
          ? stored.messageBridgeEnabled
          : defaultSettings.messageBridgeEnabled,
      messageBridgePollIntervalMs:
        typeof stored.messageBridgePollIntervalMs === 'number' &&
        Number.isFinite(stored.messageBridgePollIntervalMs)
          ? Math.max(5_000, Math.trunc(stored.messageBridgePollIntervalMs))
          : defaultSettings.messageBridgePollIntervalMs,
      autoUpdateEnabled:
        typeof stored.autoUpdateEnabled === 'boolean'
          ? stored.autoUpdateEnabled
          : defaultSettings.autoUpdateEnabled,
      autoFailoverEnabled:
        typeof stored.autoFailoverEnabled === 'boolean'
          ? stored.autoFailoverEnabled
          : defaultSettings.autoFailoverEnabled,
      workflowBudgetKillEnabled:
        typeof stored.workflowBudgetKillEnabled === 'boolean'
          ? stored.workflowBudgetKillEnabled
          : defaultSettings.workflowBudgetKillEnabled,
      approvalTimeouts: {
        ...defaultSettings.approvalTimeouts,
        ...(storedApprovalTimeouts || {}),
        perProviderMs: {
          ...defaultSettings.approvalTimeouts.perProviderMs,
          ...(storedApprovalTimeoutProviderMs || {})
        }
      }
    }
  }

  static updateSettings(partial: Partial<AppSettings>) {
    const current = this.getSettings()
    writeJson(settingsPath, { ...current, ...partial })
  }

  static getDefaultRuntimeProfiles(): RuntimeProfile[] {
    const now = new Date(0).toISOString()
    // Two built-in profiles per provider: `{provider} local` (workspace-scoped,
    // the historical default) and `{provider} global` (scope=global) so a
    // freshly-installed TaskWraith can run a Global chat without the user having
    // to create a custom profile first. The guard in
    // `resolveRuntimeProfileForPayload` rejected workspace-scoped profiles in
    // global chats, leaving global chats with no usable runtime out of the box.
    return providerIds.flatMap((provider) => {
      const label = `${provider[0].toUpperCase()}${provider.slice(1)}`
      return [
        {
          id: `builtin:${provider}:local`,
          name: `${label} local`,
          provider,
          scope: 'workspace' as const,
          workspaceMode: provider === 'gemini' ? ('worktree' as const) : ('local' as const),
          env: {},
          approvalMode: 'default' as const,
          networkPolicy: 'inherit' as const,
          persistence: 'reusable' as const,
          builtin: true,
          createdAt: now,
          updatedAt: now
        },
        {
          id: `builtin:${provider}:global`,
          name: `${label} global`,
          provider,
          scope: 'global' as const,
          // Global chats have no workspace cwd to bind a worktree against, so
          // every provider's global variant runs in plain local mode.
          workspaceMode: 'local' as const,
          env: {},
          approvalMode: 'default' as const,
          networkPolicy: 'inherit' as const,
          persistence: 'reusable' as const,
          builtin: true,
          createdAt: now,
          updatedAt: now
        }
      ]
    })
  }

  static getRuntimeProfiles(provider?: ProviderId): RuntimeProfile[] {
    const customProfiles = readJson<RuntimeProfile[]>(runtimeProfilesPath, [])
    const profiles = [...this.getDefaultRuntimeProfiles(), ...customProfiles]
    return profiles
      .filter((profile) => !provider || profile.provider === provider)
      .sort(
        (a, b) =>
          Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)) || a.name.localeCompare(b.name)
      )
  }

  static saveRuntimeProfile(
    input: Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>
  ): RuntimeProfile {
    const profiles = readJson<RuntimeProfile[]>(runtimeProfilesPath, [])
    const now = new Date().toISOString()
    const existing = input.id ? profiles.find((profile) => profile.id === input.id) : undefined
    const record: RuntimeProfile = {
      id: input.id && !input.id.startsWith('builtin:') ? input.id : randomUUID(),
      name: input.name.trim() || 'Runtime profile',
      provider: input.provider,
      scope: input.scope === 'global' ? 'global' : 'workspace',
      workspaceMode: input.workspaceMode || 'local',
      binaryPath: input.binaryPath,
      env: input.env && typeof input.env === 'object' ? input.env : {},
      mcpProfileId: input.mcpProfileId,
      approvalMode: input.approvalMode,
      agenticServices: input.agenticServices,
      networkPolicy: input.networkPolicy || 'inherit',
      persistence: input.persistence || 'reusable',
      containerConfig: input.containerConfig,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }
    const index = profiles.findIndex((profile) => profile.id === record.id)
    if (index >= 0) {
      profiles[index] = record
    } else {
      profiles.push(record)
    }
    writeJson(runtimeProfilesPath, profiles)
    return record
  }

  static deleteRuntimeProfile(id: string) {
    if (id.startsWith('builtin:')) return
    writeJson(
      runtimeProfilesPath,
      readJson<RuntimeProfile[]>(runtimeProfilesPath, []).filter((profile) => profile.id !== id)
    )
  }

  static getHandoffCards(filter: HandoffCardFilter = {}): HandoffCard[] {
    const cards = readJson<HandoffCard[]>(handoffCardsPath, [])
    return cards
      .filter((card) => !filter.sourceChatId || card.sourceChatId === filter.sourceChatId)
      .filter((card) => !filter.sourceRunId || card.sourceRunId === filter.sourceRunId)
      .filter((card) => !filter.status || card.status === filter.status)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  }

  static saveHandoffCard(
    input: Partial<HandoffCard> &
      Pick<HandoffCard, 'sourceChatId' | 'sourceProvider' | 'summary' | 'finalPrompt'>
  ): HandoffCard {
    const cards = readJson<HandoffCard[]>(handoffCardsPath, [])
    const now = new Date().toISOString()
    const existing = input.id ? cards.find((card) => card.id === input.id) : undefined
    const record: HandoffCard = {
      id: input.id || randomUUID(),
      status: input.status || 'draft',
      sourceChatId: input.sourceChatId,
      sourceRunId: input.sourceRunId,
      sourceProvider: input.sourceProvider,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      summary: input.summary,
      selectedFiles: Array.isArray(input.selectedFiles) ? input.selectedFiles : [],
      workspaceChangeSetIds: Array.isArray(input.workspaceChangeSetIds)
        ? input.workspaceChangeSetIds
        : [],
      rawEventRunIds: Array.isArray(input.rawEventRunIds) ? input.rawEventRunIds : [],
      recommendedProvider: input.recommendedProvider,
      recommendedModel: input.recommendedModel,
      recommendedApprovalMode: input.recommendedApprovalMode,
      targetChatId: input.targetChatId,
      dispatchedRunId: input.dispatchedRunId,
      finalPrompt: input.finalPrompt,
      createdAt: existing?.createdAt || input.createdAt || now,
      updatedAt: now,
      dispatchedAt: input.dispatchedAt
    }
    const index = cards.findIndex((card) => card.id === record.id)
    if (index >= 0) {
      cards[index] = record
    } else {
      cards.push(record)
    }
    writeJson(handoffCardsPath, cards)
    return record
  }

  static updateHandoffCard(id: string, partial: Partial<HandoffCard>): HandoffCard | null {
    const existing = this.getHandoffCards().find((card) => card.id === id)
    if (!existing) return null
    return this.saveHandoffCard({ ...existing, ...partial, id })
  }

  static deleteHandoffCard(id: string) {
    writeJson(
      handoffCardsPath,
      readJson<HandoffCard[]>(handoffCardsPath, []).filter((card) => card.id !== id)
    )
  }

  // Workspaces
  static getWorkspaces(): WorkspaceRecord[] {
    return readJson<WorkspaceRecord[]>(workspacesPath, [])
  }

  static addOrUpdateWorkspace(
    workspacePath: string,
    partial: Partial<WorkspaceRecord> = {}
  ): WorkspaceRecord {
    const workspaces = this.getWorkspaces()
    let ws = workspaces.find((w) => w.path === workspacePath)
    if (!ws) {
      ws = {
        id: randomUUID(),
        path: workspacePath,
        displayName: path.basename(workspacePath) || workspacePath,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
        pinned: false,
        ...partial
      }
      workspaces.push(ws)
    } else {
      ws = { ...ws, ...partial, lastOpenedAt: Date.now() }
      const index = workspaces.findIndex((w) => w.path === workspacePath)
      workspaces[index] = ws
    }
    writeJson(workspacesPath, workspaces)
    return ws
  }

  static removeWorkspace(workspaceId: string) {
    const workspaces = this.getWorkspaces().filter((w) => w.id !== workspaceId)
    writeJson(workspacesPath, workspaces)
  }

  static clearWorkspaces() {
    writeJson(workspacesPath, [])
  }

  // Chats
  static normalizeChatRecord(chat: ChatRecord): ChatRecord {
    const scope = chat.scope === 'global' ? 'global' : 'workspace'
    const chatKind = chat.chatKind === 'ensemble' ? 'ensemble' : 'single'
    const parentChatRelation = chat.parentChatId
      ? chat.parentChatRelation === 'sideChat'
        ? 'sideChat'
        : 'subThread'
      : undefined
    const providerMetadata = chat.providerMetadata
      ? canonicalizeExternalPathGrantMetadata(chat.providerMetadata)
      : chat.providerMetadata
    const sideChatContext =
      parentChatRelation === 'sideChat'
        ? {
            createdAt:
              typeof chat.sideChatContext?.createdAt === 'number'
                ? chat.sideChatContext.createdAt
                : chat.createdAt || Date.now(),
            ...(chat.sideChatContext || {}),
            lifecycleState: normalizeSideChatLifecycleState(
              chat.sideChatContext?.lifecycleState,
              chat.archived ? 'terminated' : 'active'
            )
          }
        : chat.sideChatContext
    const ensemble =
      chatKind === 'ensemble'
        ? {
            ...createDefaultEnsembleConfig(chat.provider || this.getSettings().activeProvider),
            ...(chat.ensemble || {}),
            participants:
              Array.isArray(chat.ensemble?.participants) && chat.ensemble.participants.length > 0
                ? chat.ensemble.participants
                : createDefaultEnsembleConfig(chat.provider || this.getSettings().activeProvider)
                    .participants
          }
        : undefined
    if (scope === 'global') {
      const { workspaceId: _workspaceId, workspacePath: _workspacePath, ...rest } = chat
      return {
        ...rest,
        scope,
        chatKind,
        parentChatRelation,
        sideChatContext,
        ...(ensemble ? { ensemble } : {}),
        providerMetadata
      }
    }
    return {
      ...chat,
      scope,
      chatKind,
      parentChatRelation,
      sideChatContext,
      ...(ensemble ? { ensemble } : {}),
      providerMetadata,
      workspaceId: chat.workspaceId || '',
      workspacePath: chat.workspacePath || ''
    }
  }

  static toChatListItem(chat: ChatRecord): ChatListItem {
    const normalizedChat = this.normalizeChatRecord(chat)
    const messages = Array.isArray(normalizedChat.messages) ? normalizedChat.messages : []
    const runs = Array.isArray(normalizedChat.runs) ? normalizedChat.runs : []
    const lastRun = summarizeLastRun(runs[runs.length - 1])
    const recentMessageSearch = messages
      .slice(-8)
      .map((message) => `${message.role} ${previewText(message.content, 180)}`)
      .filter(Boolean)
    const latestMessagePreview = [...messages]
      .reverse()
      .map((message) => previewText(message.content, 180))
      .find(Boolean)
    return {
      ...normalizedChat,
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount: messages.length,
      runCount: runs.length,
      ...(lastRun ? { lastRun } : {}),
      searchText: [
        normalizedChat.title,
        normalizedChat.provider,
        normalizedChat.appChatId,
        normalizedChat.linkedGeminiSessionId,
        normalizedChat.linkedProviderSessionId,
        ...recentMessageSearch
      ]
        .filter(Boolean)
        .join(' '),
      ...(latestMessagePreview ? { searchPreview: latestMessagePreview } : {})
    }
  }

  static normalizeChatListItem(item: ChatListItem): ChatListItem {
    const normalized = this.normalizeChatRecord(item)
    return {
      ...normalized,
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount: typeof item.messageCount === 'number' ? item.messageCount : 0,
      runCount: typeof item.runCount === 'number' ? item.runCount : 0,
      ...(item.lastRun ? { lastRun: summarizeLastRun(item.lastRun) || item.lastRun } : {}),
      ...(typeof item.searchText === 'string' ? { searchText: item.searchText } : {}),
      ...(typeof item.searchPreview === 'string' ? { searchPreview: item.searchPreview } : {})
    }
  }

  static getChatList(workspaceId?: string): ChatListItem[] {
    if (!fs.existsSync(chatsDir)) return []
    const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json'))
    const existingIndex = readJson<Record<string, ChatListItem>>(chatListIndexPath, {})
    const nextIndex: Record<string, ChatListItem> = {}
    const items: ChatListItem[] = []
    let dirty = false

    for (const file of files) {
      const chatId = path.basename(file, '.json')
      let item: ChatListItem | undefined
      const indexed = existingIndex[chatId]
      if (indexed?.summaryOnly === true) {
        item = this.normalizeChatListItem(indexed)
      } else {
        const chat = readJson<ChatRecord | null>(path.join(chatsDir, file), null)
        if (chat) {
          item = this.toChatListItem(chat)
          dirty = true
        }
      }
      if (!item) continue
      nextIndex[chatId] = item
      if (!workspaceId || item.workspaceId === workspaceId) {
        items.push(item)
      }
    }

    if (Object.keys(existingIndex).length !== Object.keys(nextIndex).length) {
      dirty = true
    }
    if (dirty) {
      writeJson(chatListIndexPath, nextIndex)
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Parsed+normalized chat records keyed by chatId, validated against the
   * file's mtime+size on every read. Chat JSON grows to tens of MB and
   * `getChats` sweeps ALL of it synchronously on the main process — without
   * a cache every bridge broadcast, projection rebuild, and `get-chats` IPC
   * re-parsed ~60MB and blocked the renderer for hundreds of ms (the 1-2s
   * UI hang). All writes flow through `saveChat`/`deleteChat` in this one
   * process (writeJson is atomic), so mtime+size validation makes the cache
   * exact; an out-of-band file change simply misses and re-parses.
   *
   * Callers receive the SAME record instance until the file changes — the
   * read paths (projections, broadcasts, IPC serialization) treat records
   * as immutable; mutate-then-save flows go through `saveChat`, which
   * re-normalizes and refreshes the cached instance. */
  private static chatRecordCache = new Map<
    string,
    { mtimeMs: number; size: number; record: ChatRecord }
  >()

  private static readChatRecordCached(chatId: string, chatPath: string): ChatRecord | null {
    let stat: fs.Stats
    try {
      stat = fs.statSync(chatPath)
    } catch {
      this.chatRecordCache.delete(chatId)
      return null
    }
    const cached = this.chatRecordCache.get(chatId)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.record
    }
    const chat = readJson<ChatRecord | null>(chatPath, null)
    if (!chat) return null
    const record = this.normalizeChatRecord(chat)
    this.chatRecordCache.set(chatId, { mtimeMs: stat.mtimeMs, size: stat.size, record })
    return record
  }

  private static orphanSubThreadsReaped = false

  /** One-time-per-process reap of child chats (sub-threads / side-chats /
   * guests) whose parent chat FILE no longer exists. Historically `deleteChat`
   * did not cascade, so deleting a parent stranded its children on disk; those
   * orphans then surfaced on iOS as perpetual "running" tombstones and inflated
   * the remote thread count. Runs lazily on the first getChats() so it needs no
   * startup wiring (keeps the fix out of the concurrently-edited index.ts).
   * Parent existence is checked by FILE presence — never the parsed list — so a
   * transiently unparseable parent can never cause its children to be reaped.
   * Best-effort: any failure leaves data untouched. */
  private static ensureOrphanSubThreadsReaped(): void {
    if (this.orphanSubThreadsReaped) return
    this.orphanSubThreadsReaped = true
    try {
      if (!fs.existsSync(chatsDir)) return
      for (const file of fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json'))) {
        const chatId = path.basename(file, '.json')
        const chat = this.readChatRecordCached(chatId, path.join(chatsDir, file))
        if (!chat?.parentChatId) continue
        if (!fs.existsSync(chatPathForId(chatsDir, chat.parentChatId))) {
          this.deleteChat(chat.appChatId)
        }
      }
    } catch {
      // best-effort cleanup; never block reads
    }
  }

  static getChats(workspaceId?: string): ChatRecord[] {
    this.ensureOrphanSubThreadsReaped()
    if (!fs.existsSync(chatsDir)) return []
    const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json'))
    const chats: ChatRecord[] = []
    for (const file of files) {
      const chatId = path.basename(file, '.json')
      const chat = this.readChatRecordCached(chatId, path.join(chatsDir, file))
      if (chat && (!workspaceId || chat.workspaceId === workspaceId)) {
        chats.push(chat)
      }
    }
    return chats.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  static getPinnedMessages(workspaceId?: string): PinnedMessageGroup[] {
    const workspacesById = new Map(
      this.getWorkspaces().map((workspace) => [workspace.id, workspace])
    )
    const groups = new Map<string, PinnedMessageGroup>()

    for (const chat of this.getChats(workspaceId)) {
      const messages = (chat.messages || [])
        .map((message) => {
          const pinnedAt = message.metadata?.pinnedAt
          if (typeof pinnedAt !== 'number' || !Number.isFinite(pinnedAt)) return null
          return {
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
            ...(message.runId ? { runId: message.runId } : {}),
            pinnedAt
          }
        })
        .filter((message): message is NonNullable<typeof message> => Boolean(message))
        .sort((a, b) => b.pinnedAt - a.pinnedAt)

      if (messages.length === 0 && !chat.pinnedNotes?.trim()) continue

      const workspace = chat.workspaceId ? workspacesById.get(chat.workspaceId) : undefined
      const workspacePath = chat.workspacePath || workspace?.path
      const workspaceDisplayName =
        chat.scope === 'global'
          ? 'Global chats'
          : workspace?.displayName ||
            (workspacePath ? path.basename(workspacePath) || workspacePath : 'Unknown workspace')
      const groupKey =
        chat.scope === 'global' ? 'global' : chat.workspaceId || workspacePath || 'unknown'
      const group =
        groups.get(groupKey) ||
        ({
          ...(chat.scope !== 'global' && chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
          ...(workspacePath ? { workspacePath } : {}),
          workspaceDisplayName,
          chats: []
        } satisfies PinnedMessageGroup)

      group.chats.push({
        chatId: chat.appChatId,
        chatTitle: chat.title,
        chatKind: chat.chatKind,
        provider: chat.provider,
        updatedAt: chat.updatedAt,
        ...(chat.scope !== 'global' && chat.workspaceId ? { workspaceId: chat.workspaceId } : {}),
        ...(workspacePath ? { workspacePath } : {}),
        workspaceDisplayName,
        ...(chat.pinnedNotes ? { pinnedNotes: chat.pinnedNotes } : {}),
        messages
      })
      groups.set(groupKey, group)
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        chats: group.chats.sort((a, b) => b.updatedAt - a.updatedAt)
      }))
      .sort((a, b) => {
        if (a.workspaceDisplayName === 'Global chats') return -1
        if (b.workspaceDisplayName === 'Global chats') return 1
        return a.workspaceDisplayName.localeCompare(b.workspaceDisplayName)
      })
  }

  static getChat(chatId: string): ChatRecord | null {
    if (!isSafeChatId(chatId)) return null
    return this.readChatRecordCached(chatId, chatPathForId(chatsDir, chatId))
  }

  static getChatRecordPath(chatId: string): string | null {
    if (!isSafeChatId(chatId)) return null
    return chatPathForId(chatsDir, chatId)
  }

  static createChat(workspaceId: string, workspacePath: string): ChatRecord {
    const settings = this.getSettings()
    const chat: ChatRecord = {
      appChatId: randomUUID(),
      scope: 'workspace',
      chatKind: 'single',
      provider: coerceLiveProvider(settings.activeProvider),
      title: 'New Chat',
      workspaceId,
      workspacePath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      messages: [],
      runs: []
    }
    if (settings.storeLocalChatHistory) {
      this.saveChat(chat)
    }
    return chat
  }

  static createGlobalChat(): ChatRecord {
    const settings = this.getSettings()
    const chat: ChatRecord = {
      appChatId: randomUUID(),
      scope: 'global',
      chatKind: 'single',
      provider: coerceLiveProvider(settings.activeProvider),
      title: 'New Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      messages: [],
      runs: []
    }
    if (settings.storeLocalChatHistory) {
      this.saveChat(chat)
    }
    return chat
  }

  static createEnsembleChat(
    args: { workspaceId?: string; workspacePath?: string } = {},
    configuredProviders?: Set<ProviderId>
  ): ChatRecord {
    const settings = this.getSettings()
    const activeProvider = coerceLiveProvider(settings.activeProvider)
    const scope: ChatRecord['scope'] =
      args.workspaceId && args.workspacePath ? 'workspace' : 'global'
    const chat: ChatRecord = {
      appChatId: randomUUID(),
      scope,
      chatKind: 'ensemble',
      provider: activeProvider,
      title: 'New Ensemble',
      ...(scope === 'workspace'
        ? { workspaceId: args.workspaceId, workspacePath: args.workspacePath }
        : {}),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      messages: [],
      runs: [],
      ensemble: createDefaultEnsembleConfig(activeProvider, configuredProviders)
    }
    if (settings.storeLocalChatHistory) {
      this.saveChat(chat)
    }
    return chat
  }

  static createSideChat(args: {
    parentChatId: string
    chatKind?: ChatRecord['chatKind']
    provider?: ProviderId
    title?: string
    originMessageId?: string
    originRunId?: string
    sideChatMode?: SideChatMode
    selectedModelType?: string
    codexReasoningEffort?: string | null
    claudeReasoningEffort?: string | null
  }): ChatRecord {
    const parent = this.getChat(args.parentChatId)
    if (!parent) {
      throw new Error(`Cannot create side chat: parent chat ${args.parentChatId} not found`)
    }

    const settings = this.getSettings()
    const now = Date.now()
    const sideChatMode: SideChatMode =
      args.sideChatMode ||
      (args.chatKind === 'single'
        ? 'singleProvider'
        : parent.chatKind === 'ensemble' || args.chatKind === 'ensemble'
          ? 'ensembleClone'
          : 'singleProvider')
    const chatKind =
      args.chatKind === 'ensemble' || sideChatMode === 'ensembleClone' || sideChatMode === 'fanOut'
        ? 'ensemble'
        : 'single'
    const provider = coerceLiveProvider(args.provider || parent.provider || settings.activeProvider)
    const scope = parent.scope ?? 'workspace'
    const title =
      args.title?.trim() ||
      `Isolated side chat${
        parent.title && parent.title !== 'New Chat' ? ` from ${parent.title}` : ''
      }`

    const inheritedProviderMetadata = parent.providerMetadata
      ? canonicalizeExternalPathGrantMetadata({ ...parent.providerMetadata })
      : undefined
    const providerMetadata = {
      ...(inheritedProviderMetadata || {}),
      ...(args.selectedModelType ? { selectedModelType: args.selectedModelType } : {}),
      ...(args.codexReasoningEffort !== undefined
        ? { codexReasoningEffort: args.codexReasoningEffort }
        : {}),
      ...(args.claudeReasoningEffort !== undefined
        ? { claudeReasoningEffort: args.claudeReasoningEffort }
        : {})
    }

    const base: ChatRecord = {
      appChatId: randomUUID(),
      scope,
      chatKind,
      provider,
      title,
      ...(scope === 'workspace'
        ? { workspaceId: parent.workspaceId, workspacePath: parent.workspacePath }
        : {}),
      createdAt: now,
      updatedAt: now,
      archived: false,
      messages: [],
      runs: [],
      parentChatId: parent.appChatId,
      parentChatRelation: 'sideChat',
      sideChatContext: {
        createdAt: now,
        mode: sideChatMode,
        lifecycleState: 'active',
        openedAt: now,
        ...(args.originMessageId ? { originMessageId: args.originMessageId } : {}),
        ...(args.originRunId ? { originRunId: args.originRunId } : {}),
        transcriptVisibility: 'none'
      },
      providerMetadata: Object.keys(providerMetadata).length > 0 ? providerMetadata : undefined
    }

    const chat: ChatRecord =
      chatKind === 'ensemble'
        ? {
            ...base,
            title:
              args.title?.trim() ||
              (sideChatMode === 'fanOut'
                ? `Fan-out side chat from ${parent.title || 'chat'}`
                : `Side ensemble from ${parent.title || 'chat'}`),
            ensemble: {
              ...cloneEnsembleForSideChat(parent, provider),
              ...(sideChatMode === 'fanOut'
                ? { fanoutPolicy: 'read_only', concurrentModeEnabled: true }
                : {})
            }
          }
        : base

    if (settings.storeLocalChatHistory) {
      this.saveChat(chat)
    }
    return chat
  }

  static setGuestParticipant(args: {
    parentChatId: string
    provider: ProviderId
    selectedModelType?: string
    customModel?: string
    codexReasoningEffort?: string | null
    codexServiceTier?: string | null
    claudeReasoningEffort?: string | null
    claudeFastMode?: boolean | null
    kimiThinkingEnabled?: boolean
  }): { parent: ChatRecord; guest: ChatRecord } {
    const parent = this.getChat(args.parentChatId)
    if (!parent) {
      throw new Error(`Cannot set guest participant: parent chat ${args.parentChatId} not found`)
    }
    if (parent.chatKind === 'ensemble') {
      throw new Error('Guest participants are only available for standard chats.')
    }

    const now = Date.now()
    const scope = parent.scope ?? 'workspace'
    const selectedModelType =
      typeof args.selectedModelType === 'string' && args.selectedModelType.trim()
        ? args.selectedModelType
        : 'default'
    const existingGuestId = parent.guestParticipant?.childChatId
    const existingGuest = existingGuestId ? this.getChat(existingGuestId) : null
    const reusableGuest =
      existingGuest &&
      existingGuest.parentChatId === parent.appChatId &&
      existingGuest.parentChatRelation === 'sideChat' &&
      existingGuest.sideChatContext?.mode === 'guestParticipant' &&
      existingGuest.provider === args.provider &&
      !existingGuest.archived &&
      normalizeSideChatLifecycleState(existingGuest.sideChatContext?.lifecycleState, 'active') !==
        'terminated'
        ? existingGuest
        : this.getSideChats(parent.appChatId).find(
            (chat) =>
              chat.sideChatContext?.mode === 'guestParticipant' &&
              chat.provider === args.provider &&
              !chat.archived &&
              normalizeSideChatLifecycleState(chat.sideChatContext?.lifecycleState, 'active') !==
                'terminated'
          ) || null

    const closeGuestChild = (chat: ChatRecord): ChatRecord => ({
      ...chat,
      sideChatContext: {
        ...(chat.sideChatContext || { createdAt: chat.createdAt }),
        mode: 'guestParticipant',
        lifecycleState: 'closed',
        closedAt: now
      },
      updatedAt: now
    })

    for (const chat of this.getSideChats(parent.appChatId)) {
      if (
        chat.sideChatContext?.mode === 'guestParticipant' &&
        chat.appChatId !== reusableGuest?.appChatId &&
        normalizeSideChatLifecycleState(chat.sideChatContext?.lifecycleState, 'active') === 'active'
      ) {
        this.saveChat(closeGuestChild(chat))
      }
    }

    const childChat =
      reusableGuest ||
      ({
        appChatId: randomUUID(),
        scope,
        chatKind: 'single',
        provider: args.provider,
        title: `Guest participant (${args.provider})`,
        ...(scope === 'workspace'
          ? { workspaceId: parent.workspaceId, workspacePath: parent.workspacePath }
          : {}),
        createdAt: now,
        updatedAt: now,
        archived: false,
        messages: [],
        runs: [],
        parentChatId: parent.appChatId,
        parentChatRelation: 'sideChat',
        sideChatContext: {
          createdAt: now,
          mode: 'guestParticipant',
          lifecycleState: 'active',
          openedAt: now,
          transcriptVisibility: 'none'
        },
        providerMetadata: parent.providerMetadata
          ? canonicalizeExternalPathGrantMetadata({ ...parent.providerMetadata })
          : undefined
      } satisfies ChatRecord)

    const activeChild: ChatRecord = {
      ...childChat,
      provider: args.provider,
      providerMetadata: {
        ...(childChat.providerMetadata || {}),
        selectedModelType,
        customModel: typeof args.customModel === 'string' ? args.customModel : '',
        ...(args.codexReasoningEffort !== undefined
          ? { codexReasoningEffort: args.codexReasoningEffort }
          : {}),
        ...(args.codexServiceTier !== undefined ? { codexServiceTier: args.codexServiceTier } : {}),
        ...(args.claudeReasoningEffort !== undefined
          ? { claudeReasoningEffort: args.claudeReasoningEffort }
          : {}),
        ...(args.claudeFastMode !== undefined ? { claudeFastMode: args.claudeFastMode } : {}),
        ...(args.kimiThinkingEnabled !== undefined
          ? { kimiThinkingEnabled: args.kimiThinkingEnabled }
          : {})
      },
      sideChatContext: {
        ...(childChat.sideChatContext || { createdAt: childChat.createdAt }),
        mode: 'guestParticipant',
        lifecycleState: 'active',
        openedAt: now
      },
      updatedAt: now
    }

    const guestParticipant: GuestParticipantConfig = {
      childChatId: activeChild.appChatId,
      provider: args.provider,
      selectedModelType,
      customModel: typeof args.customModel === 'string' ? args.customModel : '',
      codexReasoningEffort: args.codexReasoningEffort,
      codexServiceTier: args.codexServiceTier,
      claudeReasoningEffort: args.claudeReasoningEffort,
      claudeFastMode: args.claudeFastMode,
      kimiThinkingEnabled: args.kimiThinkingEnabled,
      createdAt: parent.guestParticipant?.createdAt || now,
      updatedAt: now,
      persistent: true
    }

    const updatedParent: ChatRecord = {
      ...parent,
      guestParticipant,
      updatedAt: now
    }

    this.saveChat(activeChild)
    this.saveChat(updatedParent)
    return { parent: updatedParent, guest: activeChild }
  }

  static removeGuestParticipant(parentChatId: string): { parent: ChatRecord; guest?: ChatRecord } {
    const parent = this.getChat(parentChatId)
    if (!parent) {
      throw new Error(`Cannot remove guest participant: parent chat ${parentChatId} not found`)
    }
    const now = Date.now()
    let closedGuest: ChatRecord | undefined
    const childId = parent.guestParticipant?.childChatId
    if (childId) {
      const child = this.getChat(childId)
      if (child?.parentChatRelation === 'sideChat') {
        closedGuest = {
          ...child,
          sideChatContext: {
            ...(child.sideChatContext || { createdAt: child.createdAt }),
            mode: 'guestParticipant',
            lifecycleState: 'closed',
            closedAt: now
          },
          updatedAt: now
        }
        this.saveChat(closedGuest)
      }
    }
    const { guestParticipant: _guestParticipant, ...parentWithoutGuest } = parent
    const updatedParent: ChatRecord = {
      ...parentWithoutGuest,
      updatedAt: now
    }
    this.saveChat(updatedParent)
    return closedGuest ? { parent: updatedParent, guest: closedGuest } : { parent: updatedParent }
  }

  /** Phase F1: spawn a sub-thread under an existing parent chat.
   *
   * The sub-thread inherits the parent's workspace by default (the
   * "parent's workspace" interpretation is the safe one — we don't
   * want a delegation to silently jump to a different workspace). The
   * caller picks the provider — that's the whole point of the
   * feature. The delegation prompt is recorded for audit + future
   * auto-propagation; v1 doesn't auto-send it (renderer pre-fills the
   * composer and lets the user confirm before submitting).
   *
   * v1 constraint: rejects creation when `parentChat.parentChatId` is
   * itself set, enforcing the max-depth-1 invariant.
   */
  static createSubThread(args: {
    parentChatId: string
    provider: ProviderId
    delegationPrompt: string
    returnResultToParent: boolean
    /** Override the workspace if the user explicitly picked a
     * different one. Defaults to inheriting the parent's workspace. */
    workspaceId?: string
    workspacePath?: string
  }): ChatRecord {
    const parent = this.getChat(args.parentChatId)
    if (!parent) {
      throw new Error(`Cannot create sub-thread: parent chat ${args.parentChatId} not found`)
    }
    if (this.isSubThreadChat(parent)) {
      throw new Error(
        `Cannot create sub-thread: parent ${args.parentChatId} is itself a sub-thread (max depth 1 in v1)`
      )
    }
    const settings = this.getSettings()
    const inheritWorkspace = args.workspaceId === undefined && args.workspacePath === undefined
    const workspaceId = inheritWorkspace ? parent.workspaceId : args.workspaceId
    const workspacePath = inheritWorkspace ? parent.workspacePath : args.workspacePath
    const chat: ChatRecord = {
      appChatId: randomUUID(),
      // Scope inherited from parent — a sub-thread of a workspace
      // chat stays a workspace chat; a sub-thread of a global chat
      // stays global.
      scope: parent.scope ?? 'workspace',
      chatKind: 'single',
      provider: args.provider,
      title: `Sub-thread (${args.provider})`,
      workspaceId,
      workspacePath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      messages: [],
      runs: [],
      parentChatId: parent.appChatId,
      parentChatRelation: 'subThread',
      delegationContext: {
        createdAt: Date.now(),
        parentProvider: coerceLiveProvider(parent.provider ?? settings.activeProvider),
        delegationPrompt: args.delegationPrompt,
        returnResultToParent: args.returnResultToParent
      }
    }
    if (settings.storeLocalChatHistory) {
      this.saveChat(chat)
    }
    return chat
  }

  /** Phase F1: every chat whose `parentChatId` is `parentChatId`,
   * sorted by createdAt ascending (oldest first). Reads the full
   * chats directory and filters — fine for typical workloads (small
   * fanout per parent), no index needed yet. */
  static getChildChats(parentChatId: string): ChatRecord[] {
    return this.getChats()
      .filter((chat) => chat.parentChatId === parentChatId && this.isSubThreadChat(chat))
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  static getSideChats(parentChatId: string): ChatRecord[] {
    return this.getChats()
      .filter(
        (chat) => chat.parentChatId === parentChatId && chat.parentChatRelation === 'sideChat'
      )
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Phase F1: walk up to the topmost ancestor of a chat. Used by the
   * sidebar to group sub-threads under their root and by audit code
   * that needs the "thread family" of a delegation. Returns the input
   * chat if it has no parent. */
  static getRootChat(chatId: string): ChatRecord | null {
    let current = this.getChat(chatId)
    const visited = new Set<string>()
    while (current?.parentChatId && this.isSubThreadChat(current)) {
      if (visited.has(current.appChatId)) {
        // Defensive: malformed data with a cycle. Treat as root.
        return current
      }
      visited.add(current.appChatId)
      const parent = this.getChat(current.parentChatId)
      if (!parent) return current
      current = parent
    }
    return current
  }

  static isSubThreadChat(chat: ChatRecord | null | undefined): boolean {
    return Boolean(
      chat?.parentChatId &&
      (chat.parentChatRelation === undefined || chat.parentChatRelation === 'subThread')
    )
  }

  static saveChat(chat: ChatRecord) {
    const settings = this.getSettings()
    if (!settings.storeLocalChatHistory) return
    if ((chat as Partial<ChatListItem>).summaryOnly === true) {
      throw new Error('Cannot save a summary-only chat record; hydrate the chat first.')
    }

    // Persisted-chat compaction (Step 4): historical runs shed raw tool
    // events (inline screenshots become thumbnails, text raw drops) so chat
    // files stay parse-fast and save-cheap. The latest/running runs keep
    // full fidelity for live debugging.
    const normalizedChat = this.normalizeChatRecord(compactChatForPersist(chat))
    normalizedChat.updatedAt = Date.now()
    const chatPath = chatPathForId(chatsDir, normalizedChat.appChatId)
    if (deletedChatIds.has(normalizedChat.appChatId) && !fs.existsSync(chatPath)) {
      return
    }
    const preStat = fs.existsSync(chatPath) ? fs.statSync(chatPath) : null
    writeJson(chatPath, normalizedChat)
    // Write-through: the next read (bridge broadcast fires right after most
    // saves) must not re-parse what we just serialized. writeJson swallows
    // failures, so only trust the cache when the file visibly changed —
    // otherwise invalidate and let disk be the truth.
    try {
      const postStat = fs.statSync(chatPath)
      const wrote =
        !preStat || postStat.mtimeMs !== preStat.mtimeMs || postStat.size !== preStat.size
      if (wrote) {
        this.chatRecordCache.set(normalizedChat.appChatId, {
          mtimeMs: postStat.mtimeMs,
          size: postStat.size,
          record: normalizedChat
        })
      } else {
        this.chatRecordCache.delete(normalizedChat.appChatId)
      }
    } catch {
      this.chatRecordCache.delete(normalizedChat.appChatId)
    }
    const index = readJson<Record<string, ChatListItem>>(chatListIndexPath, {})
    index[normalizedChat.appChatId] = this.toChatListItem(normalizedChat)
    writeJson(chatListIndexPath, index)
    // Agent Pool (Phase 2) — harvest finalized-run stats for any pooled-agent
    // participant. Best-effort: a harvest failure must never break the save.
    try {
      this.harvestChatAgentStats(normalizedChat)
    } catch (e) {
      console.error('Failed to harvest agent stats', e)
    }
  }

  static deleteChat(chatId: string, seen: Set<string> = new Set()): void {
    // Cascade to linked children FIRST. A parent owns its sub-threads,
    // side-chats and guest child chats (any chat whose parentChatId is this
    // chat). Without this cascade those children survive on disk as orphans and
    // surface on iOS as perpetual "running" tombstones (the remote feed has no
    // parent-existence gate). `seen` guards against malformed parent cycles.
    if (seen.has(chatId)) return
    seen.add(chatId)
    deletedChatIds.add(chatId)
    for (const child of this.getChats().filter((candidate) => candidate.parentChatId === chatId)) {
      this.deleteChat(child.appChatId, seen)
    }

    // Read the chat's KNOWN runs before unlinking so we can clean up its
    // per-run forensic files (run-event ledger + artifacts) that would
    // otherwise be orphaned on disk forever. Derived purely from this chat's
    // own runIds (never a directory scan), so a sibling chat's similar/prefixed
    // run files are guaranteed untouched. All cleanup is best-effort.
    const chat = this.getChat(chatId)
    const runs = Array.isArray(chat?.runs) ? chat.runs : []
    for (const run of runs) {
      if (run && typeof run.runId === 'string') {
        deleteRunForensicFiles(run.runId)
      }
    }

    const chatPath = chatPathForId(chatsDir, chatId)
    if (fs.existsSync(chatPath)) {
      fs.unlinkSync(chatPath)
    }
    this.chatRecordCache.delete(chatId)
    const index = readJson<Record<string, ChatListItem>>(chatListIndexPath, {})
    if (index[chatId]) {
      delete index[chatId]
      writeJson(chatListIndexPath, index)
    }
  }

  static clearChats(workspaceId?: string) {
    if (!workspaceId) {
      try {
        if (fs.existsSync(chatsDir)) {
          for (const file of fs.readdirSync(chatsDir).filter((item) => item.endsWith('.json'))) {
            deletedChatIds.add(path.basename(file, '.json'))
          }
        }
        for (const chat of this.getChats()) {
          deletedChatIds.add(chat.appChatId)
          for (const run of chat.runs || []) {
            if (run?.runId) deleteRunForensicFiles(run.runId)
          }
        }
      } catch {
        // The direct directory removal below still clears best-effort history.
      }
      tombstoneRunEventFiles()
      tombstoneRunArtifactDirs()
      deletePathBestEffort(chatsDir, 'chat history directory')
      deletePathBestEffort(chatListIndexPath, 'chat list index')
      deletePathBestEffort(runEventsDir, 'run event history directory')
      deletePathBestEffort(runArtifactsDir, 'run artifact history directory')
      deletePathBestEffort(runQueuePath, 'run queue history')
      deletePathBestEffort(runRecoveryPath, 'run recovery history')
      this.chatRecordCache.clear()
      this.orphanSubThreadsReaped = false
      runEventSequenceCache.clear()
      runEventHashCache.clear()
      return
    }
    const chats = this.getChats(workspaceId)
    for (const chat of chats) {
      this.deleteChat(chat.appChatId)
    }
  }

  // Usage
  static getUsage(workspaceId?: string, chatId?: string) {
    const records = readJson<UsageRecord[]>(usagePath, [])
    return records.filter((record) => {
      if (workspaceId && record.workspaceId !== workspaceId) return false
      if (chatId && record.chatId !== chatId) return false
      return true
    })
  }

  static recordUsage(usage: Omit<UsageRecord, 'id' | 'timestamp'>) {
    const settings = this.getSettings()
    const records = readJson<UsageRecord[]>(usagePath, [])

    const record: UsageRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...usage
    }

    if (!settings.storePromptResponseInUsage) {
      delete record.promptText
      delete record.responseText
    }

    records.push(record)
    writeJson(usagePath, records)
  }

  static getProviderUsageSnapshot(provider: ProviderId) {
    const snapshots = readJson<Record<string, any>>(providerUsageSnapshotsPath, {})
    return snapshots[provider] || null
  }

  static storeProviderUsageSnapshot(provider: ProviderId, snapshot: any) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return
    const snapshots = readJson<Record<string, any>>(providerUsageSnapshotsPath, {})
    snapshots[provider] = {
      ...snapshot,
      provider,
      cachedAt: new Date().toISOString()
    }
    writeJson(providerUsageSnapshotsPath, snapshots)
  }

  // Workflows
  static getWorkflowDefinitions(workspaceId?: string): WorkflowDefinition[] {
    const nowMs = Date.now()
    return readJson<unknown[]>(workflowsPath, [])
      .map((item) => normalizeWorkflowDefinitionRecord(item, nowMs))
      .filter((item): item is WorkflowDefinition => Boolean(item))
      .filter((workflow) => !workspaceId || workflow.workspaceId === workspaceId)
      .sort((a, b) => {
        const aMs = a.nextRunAt ? new Date(a.nextRunAt).getTime() : Number.POSITIVE_INFINITY
        const bMs = b.nextRunAt ? new Date(b.nextRunAt).getTime() : Number.POSITIVE_INFINITY
        return aMs - bMs || b.updatedAt.localeCompare(a.updatedAt)
      })
  }

  static getWorkflowDefinition(id: string): WorkflowDefinition | null {
    return this.getWorkflowDefinitions().find((workflow) => workflow.id === id) || null
  }

  /**
   * P2 — write (or clear) the verified unattended-elevation ack on a workflow.
   * The ack is minted server-side (the set-workflow-unattended-elevation IPC
   * builds + HMAC-signs it); this only persists it. Pass `undefined` to revoke.
   * No broadcast here — the IPC fans out workflow-definitions-changed after.
   */
  static setWorkflowUnattendedElevation(
    id: string,
    ack: UnattendedElevationAck | undefined
  ): WorkflowDefinition | null {
    const workflows = this.getWorkflowDefinitions()
    const index = workflows.findIndex((workflow) => workflow.id === id)
    if (index < 0) return null
    const next: WorkflowDefinition = { ...workflows[index] }
    if (ack) next.unattendedElevation = ack
    else delete next.unattendedElevation
    next.updatedAt = new Date().toISOString()
    workflows[index] = next
    writeJson(workflowsPath, workflows)
    return next
  }

  private static workflowDefinitionInvalidReason(workflow: WorkflowDefinition): string | null {
    if (workflow.trigger.kind === 'cron') {
      return 'Cron workflow triggers are not supported yet.'
    }
    if (workflow.concurrencyPolicy === 'enqueue') {
      return 'Workflow enqueue concurrency is not supported yet.'
    }
    const unsafeGrant = workflow.template.externalPathGrants?.find(
      (grant) => grant.duration !== 'workspace'
    )
    if (unsafeGrant) {
      return 'Workflow external path grants must be workspace-scoped.'
    }
    const chat = this.getChat(workflow.template.chatId)
    if (!chat) {
      return 'Workflow chat could not be loaded.'
    }
    if (chat.archived) {
      return 'Workflow chat is archived.'
    }
    if (chat.scope === 'global' || !chat.workspaceId || !chat.workspacePath) {
      return 'Workflow chat must belong to a workspace.'
    }
    if (
      chat.workspaceId !== workflow.workspaceId ||
      chat.workspaceId !== workflow.template.workspaceId ||
      !sameWorkflowPath(chat.workspacePath, workflow.workspacePath) ||
      !sameWorkflowPath(chat.workspacePath, workflow.template.workspacePath)
    ) {
      return 'Workflow chat does not belong to the selected workspace.'
    }
    return null
  }

  private static assertWorkflowDefinitionCanRun(workflow: WorkflowDefinition): void {
    const reason = this.workflowDefinitionInvalidReason(workflow)
    if (reason) throw new Error(reason)
  }

  static saveWorkflowDefinition(
    workflow: Omit<
      WorkflowDefinition,
      'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'
    > &
      Partial<
        Pick<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt' | 'history' | 'failureStreak'>
      >
  ): WorkflowDefinition {
    const workflows = this.getWorkflowDefinitions()
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const normalized = normalizeWorkflowDefinitionRecord(
      {
        ...workflow,
        id: workflow.id || randomUUID(),
        history: workflow.history || [],
        failureStreak: workflow.failureStreak || 0,
        createdAt: workflow.createdAt || nowIso,
        updatedAt: nowIso
      },
      nowMs
    )
    if (!normalized) {
      throw new Error('Workflow definition is invalid.')
    }
    this.assertWorkflowDefinitionCanRun(normalized)
    if (!normalized.enabled) {
      normalized.nextRunAt = undefined
    } else if (!normalized.nextRunAt) {
      normalized.nextRunAt = resolveNextWorkflowRunAt(normalized.trigger, nowMs, nowMs)
    }
    const index = workflows.findIndex((item) => item.id === normalized.id)
    if (index >= 0) {
      const prior = workflows[index]
      // P2 — preserve a prior stored ack across a re-save that did NOT supply one
      // (the save sanitizer strips a renderer-supplied ack), but ONLY while
      // template.approvalMode is unchanged; a mode change invalidates it. Without
      // this, a benign re-save would silently wipe a valid ack via the spread below.
      if (!normalized.unattendedElevation && prior.unattendedElevation) {
        normalized.unattendedElevation =
          prior.template?.approvalMode === normalized.template?.approvalMode
            ? prior.unattendedElevation
            : undefined
      }
      workflows[index] = { ...prior, ...normalized, updatedAt: nowIso }
    } else workflows.push(normalized)
    writeJson(workflowsPath, workflows)
    return normalized
  }

  static updateWorkflowDefinition(
    id: string,
    partial: Partial<WorkflowDefinition>
  ): WorkflowDefinition | null {
    const workflows = this.getWorkflowDefinitions()
    const index = workflows.findIndex((workflow) => workflow.id === id)
    if (index < 0) return null
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const source = workflows[index]
    const merged = {
      ...source,
      ...partial,
      id,
      template: partial.template ? { ...source.template, ...partial.template } : source.template,
      trigger: partial.trigger ? normalizeWorkflowTrigger(partial.trigger, nowMs) : source.trigger,
      limits: partial.limits ? { ...source.limits, ...partial.limits } : source.limits,
      updatedAt: nowIso
    }
    // P2 eager invalidation: a template.approvalMode change makes any existing
    // elevation ack stale (it was confirmed against the old mode). Drop it now so
    // the persisted record never carries a mode-mismatched ack. Defense-in-depth:
    // the dispatch verifier (isUnattendedElevationAckCurrent) rejects it anyway,
    // and the HMAC binds acknowledgedApprovalMode so it can't be re-pointed.
    if (
      merged.unattendedElevation &&
      merged.template?.approvalMode !== source.template?.approvalMode
    ) {
      delete merged.unattendedElevation
    }
    const normalized = normalizeWorkflowDefinitionRecord(merged, nowMs)
    if (!normalized) return null
    this.assertWorkflowDefinitionCanRun(normalized)
    if (normalized.enabled) {
      if ('trigger' in partial || 'enabled' in partial) {
        normalized.nextRunAt = resolveNextWorkflowRunAt(normalized.trigger, nowMs, nowMs)
      }
    } else {
      normalized.nextRunAt = undefined
    }
    workflows[index] = normalized
    writeJson(workflowsPath, workflows)
    return normalized
  }

  static deleteWorkflowDefinition(id: string) {
    const workflow = this.getWorkflowDefinition(id)
    if (workflow) {
      const linkedTasks = this.getScheduledTasks().filter(
        (task) =>
          task.workflowId === id &&
          (task.status === 'pending' || task.status === 'due' || task.status === 'running')
      )
      for (const task of linkedTasks) {
        this.updateScheduledTask(task.id, {
          status: 'cancelled',
          lastError: 'Workflow deleted.'
        })
      }
    }
    writeJson(
      workflowsPath,
      this.getWorkflowDefinitions().filter((item) => item.id !== id)
    )
  }

  // Workspace boards
  static getWorkspaceBoards(workspaceId?: string): WorkspaceBoardDefinition[] {
    const nowMs = Date.now()
    return readJson<unknown[]>(workspaceBoardsPath, [])
      .map((item) => normalizeWorkspaceBoardDefinitionRecord(item, nowMs))
      .filter((item): item is WorkspaceBoardDefinition => Boolean(item))
      .filter((board) => !workspaceId || board.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  static getWorkspaceBoard(id: string): WorkspaceBoardDefinition | null {
    return this.getWorkspaceBoards().find((board) => board.id === id) || null
  }

  static saveWorkspaceBoard(
    board: Omit<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
      Partial<
        Pick<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'>
      >
  ): WorkspaceBoardDefinition {
    const boards = this.getWorkspaceBoards()
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const activityActor = workspaceBoardActivityActorFromProvenance(board.provenance)
    const createdActivity: WorkspaceBoardActivityEntry = {
      id: randomUUID(),
      at: nowIso,
      actor: activityActor,
      action: 'created'
    }
    const normalized = normalizeWorkspaceBoardDefinitionRecord(
      {
        ...board,
        id: board.id || randomUUID(),
        columns: board.columns || WORKSPACE_BOARD_DEFAULT_COLUMNS,
        activity: [
          ...(Array.isArray(board.activity) ? board.activity : []),
          createdActivity
        ],
        createdAt: board.createdAt || nowIso,
        updatedAt: nowIso
      },
      nowMs
    )
    if (!normalized) throw new Error('Workspace board is invalid.')
    const index = boards.findIndex((item) => item.id === normalized.id)
    if (index >= 0) {
      const prior = boards[index]
      if (prior.workspaceId !== normalized.workspaceId || prior.workspacePath !== normalized.workspacePath) {
        throw new Error('Workspace board cannot move workspaces.')
      }
      const updatedActivity: WorkspaceBoardActivityEntry = {
        id: randomUUID(),
        at: nowIso,
        actor: activityActor,
        action: 'updated'
      }
      boards[index] = {
        ...prior,
        ...normalized,
        createdAt: prior.createdAt,
        updatedAt: nowIso,
        activity: [
          ...(prior.activity || []),
          updatedActivity
        ].slice(-100)
      }
    } else {
      boards.push(normalized)
    }
    writeJson(workspaceBoardsPath, boards)
    return index >= 0 ? boards[index] : normalized
  }

  static updateWorkspaceBoard(
    id: string,
    partial: Partial<WorkspaceBoardDefinition>
  ): WorkspaceBoardDefinition | null {
    const boards = this.getWorkspaceBoards()
    const index = boards.findIndex((board) => board.id === id)
    if (index < 0) return null
    const source = boards[index]
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const activityActor =
      'provenance' in partial ? workspaceBoardActivityActorFromProvenance(partial.provenance) : 'user'
    const normalized = normalizeWorkspaceBoardDefinitionRecord(
      {
        ...source,
        name: partial.name ?? source.name,
        description: 'description' in partial ? partial.description : source.description,
        columns: partial.columns ?? source.columns,
        provenance: 'provenance' in partial ? partial.provenance : source.provenance,
        pinned: partial.pinned ?? source.pinned,
        archived: partial.archived ?? source.archived,
        workspaceId: source.workspaceId,
        workspacePath: source.workspacePath,
        updatedAt: nowIso,
        activity: [
          ...(source.activity || []),
          { id: randomUUID(), at: nowIso, actor: activityActor, action: 'updated' }
        ].slice(-100)
      },
      nowMs
    )
    if (!normalized) return null
    boards[index] = normalized
    writeJson(workspaceBoardsPath, boards)
    return normalized
  }

  static deleteWorkspaceBoard(id: string): void {
    writeJson(
      workspaceBoardsPath,
      this.getWorkspaceBoards().filter((board) => board.id !== id)
    )
    writeJson(
      workspaceBoardCardsPath,
      this.getWorkspaceBoardCards().filter((card) => card.boardId !== id)
    )
  }

  static getWorkspaceBoardCards(boardId?: string): WorkspaceBoardCard[] {
    const nowMs = Date.now()
    return readJson<unknown[]>(workspaceBoardCardsPath, [])
      .map((item) => normalizeWorkspaceBoardCardRecord(item, nowMs))
      .filter((item): item is WorkspaceBoardCard => Boolean(item))
      .filter((card) => !boardId || card.boardId === boardId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt))
  }

  static getWorkspaceBoardCard(id: string): WorkspaceBoardCard | null {
    return this.getWorkspaceBoardCards().find((card) => card.id === id) || null
  }

  private static assertWorkspaceBoardCardLink(
    board: WorkspaceBoardDefinition,
    link?: WorkspaceBoardCardLink
  ): WorkspaceBoardCardLink | undefined {
    if (!link) return undefined
    if (link.kind === 'chat') {
      const chat = this.getChat(link.id)
      if (!chat || chat.archived || chat.workspaceId !== board.workspaceId || chat.scope === 'global') {
        throw new Error('Board card chat link must belong to the board workspace.')
      }
      return link
    }
    if (link.kind === 'workflow') {
      const workflow = this.getWorkflowDefinition(link.id)
      if (!workflow || workflow.workspaceId !== board.workspaceId) {
        throw new Error('Board card workflow link must belong to the board workspace.')
      }
      return link
    }
    if (link.kind === 'scheduled-task') {
      const task = this.getScheduledTasks().find((item) => item.id === link.id)
      if (!task || task.workspaceId !== board.workspaceId) {
        throw new Error('Board card scheduled task link must belong to the board workspace.')
      }
      return link
    }
    if (link.kind === 'run-queue-job') {
      const job = this.getRunQueueJob(link.id)
      if (!job || job.workspaceId !== board.workspaceId) {
        throw new Error('Board card run queue link must belong to the board workspace.')
      }
      return link
    }
    if (link.kind === 'local-server') {
      return link
    }
    return undefined
  }

  static saveWorkspaceBoardCard(
    card: Omit<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'> &
      Partial<Pick<WorkspaceBoardCard, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>
  ): WorkspaceBoardCard {
    const cards = this.getWorkspaceBoardCards()
    const existingIndex = card.id ? cards.findIndex((item) => item.id === card.id) : -1
    const existingCard = existingIndex >= 0 ? cards[existingIndex] : null
    if (existingCard && existingCard.boardId !== card.boardId) {
      throw new Error('Workspace board card cannot move boards.')
    }
    const board = this.getWorkspaceBoard(existingCard?.boardId || card.boardId)
    if (!board) throw new Error('Workspace board could not be loaded.')
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const activityActor = workspaceBoardActivityActorFromProvenance(card.provenance)
    const createdActivity: WorkspaceBoardActivityEntry = {
      id: randomUUID(),
      at: nowIso,
      actor: activityActor,
      action: 'created'
    }
    const normalized = normalizeWorkspaceBoardCardRecord(
      {
        ...card,
        id: card.id || randomUUID(),
        boardId: board.id,
        workspaceId: board.workspaceId,
        link: this.assertWorkspaceBoardCardLink(board, card.link),
        activity: [
          ...(Array.isArray(card.activity) ? card.activity : []),
          createdActivity
        ],
        createdAt: card.createdAt || nowIso,
        updatedAt: nowIso
      },
      nowMs
    )
    if (!normalized) throw new Error('Workspace board card is invalid.')
    if (existingIndex >= 0) {
      const prior = cards[existingIndex]
      const updatedActivity: WorkspaceBoardActivityEntry = {
        id: randomUUID(),
        at: nowIso,
        actor: activityActor,
        action: 'updated'
      }
      cards[existingIndex] = {
        ...prior,
        ...normalized,
        boardId: prior.boardId,
        workspaceId: prior.workspaceId,
        createdAt: prior.createdAt,
        updatedAt: nowIso,
        activity: [
          ...(prior.activity || []),
          updatedActivity
        ].slice(-100)
      }
    } else {
      cards.push(normalized)
    }
    writeJson(workspaceBoardCardsPath, cards)
    return existingIndex >= 0 ? cards[existingIndex] : normalized
  }

  static updateWorkspaceBoardCard(
    id: string,
    partial: Partial<WorkspaceBoardCard>
  ): WorkspaceBoardCard | null {
    const cards = this.getWorkspaceBoardCards()
    const index = cards.findIndex((card) => card.id === id)
    if (index < 0) return null
    const source = cards[index]
    const board = this.getWorkspaceBoard(source.boardId)
    if (!board) return null
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const activityActor =
      'provenance' in partial ? workspaceBoardActivityActorFromProvenance(partial.provenance) : 'user'
    const normalized = normalizeWorkspaceBoardCardRecord(
      {
        ...source,
        title: partial.title ?? source.title,
        body: 'body' in partial ? partial.body : source.body,
        columnId: partial.columnId ?? source.columnId,
        sortOrder: partial.sortOrder ?? source.sortOrder,
        humanOwner: 'humanOwner' in partial ? partial.humanOwner : source.humanOwner,
        labels: 'labels' in partial ? partial.labels : source.labels,
        link:
          'link' in partial
            ? this.assertWorkspaceBoardCardLink(board, partial.link)
            : source.link,
        blockedReason: 'blockedReason' in partial ? partial.blockedReason : source.blockedReason,
        nextStep: 'nextStep' in partial ? partial.nextStep : source.nextStep,
        reminderAt: 'reminderAt' in partial ? partial.reminderAt : source.reminderAt,
        provenance: 'provenance' in partial ? partial.provenance : source.provenance,
        archived: 'archived' in partial ? partial.archived : source.archived,
        boardId: source.boardId,
        workspaceId: source.workspaceId,
        updatedAt: nowIso,
        activity: [
          ...(source.activity || []),
          { id: randomUUID(), at: nowIso, actor: activityActor, action: 'updated' }
        ].slice(-100)
      },
      nowMs
    )
    if (!normalized) return null
    cards[index] = normalized
    writeJson(workspaceBoardCardsPath, cards)
    return normalized
  }

  static deleteWorkspaceBoardCard(id: string): void {
    writeJson(
      workspaceBoardCardsPath,
      this.getWorkspaceBoardCards().filter((card) => card.id !== id)
    )
  }

  // ── Audit runs ──────────────────────────────────────────────────────────
  // Durable run objects for the audit orchestration workflow. Stored newest-
  // first in audit-runs.json, capped at AUDIT_RUN_HISTORY_LIMIT. The
  // orchestrator owns lifecycle; the store is dumb persistence + shape-guard.

  static getAuditRuns(workspaceId?: string): AuditRunRecord[] {
    return readJson<unknown[]>(auditRunsPath, [])
      .map((item) => normalizeAuditRunRecord(item))
      .filter((item): item is AuditRunRecord => Boolean(item))
      .filter((run) => !workspaceId || run.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  static getAuditRun(id: string): AuditRunRecord | null {
    return this.getAuditRuns().find((run) => run.id === id) || null
  }

  static createAuditRun(
    input: Omit<
      AuditRunRecord,
      | 'schemaVersion'
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'phases'
      | 'participants'
      | 'findings'
      | 'verdicts'
      | 'gates'
    > &
      Partial<
        Pick<AuditRunRecord, 'id' | 'phases' | 'participants' | 'findings' | 'verdicts' | 'gates'>
      >
  ): AuditRunRecord {
    const nowIso = new Date().toISOString()
    const record = normalizeAuditRunRecord({
      ...input,
      id: input.id || randomUUID(),
      phases: input.phases || [],
      participants: input.participants || [],
      findings: input.findings || [],
      verdicts: input.verdicts || [],
      gates: input.gates || [],
      createdAt: nowIso,
      updatedAt: nowIso
    })
    if (!record) throw new Error('Audit run is invalid.')
    // Newest-first, trimmed to the cap.
    const runs = [record, ...this.getAuditRuns().filter((r) => r.id !== record.id)].slice(
      0,
      AUDIT_RUN_HISTORY_LIMIT
    )
    writeJson(auditRunsPath, runs)
    return record
  }

  static updateAuditRun(id: string, partial: Partial<AuditRunRecord>): AuditRunRecord | null {
    const runs = this.getAuditRuns()
    const index = runs.findIndex((run) => run.id === id)
    if (index < 0) return null
    const merged = normalizeAuditRunRecord({
      ...runs[index],
      ...partial,
      id,
      updatedAt: new Date().toISOString()
    })
    if (!merged) return null
    runs[index] = merged
    writeJson(auditRunsPath, runs)
    return merged
  }

  /** Append a finding (idempotent on finding id). */
  static appendAuditFinding(id: string, finding: AuditFinding): AuditRunRecord | null {
    const run = this.getAuditRun(id)
    if (!run) return null
    const findings = [...run.findings.filter((f) => f.id !== finding.id), finding]
    return this.updateAuditRun(id, { findings })
  }

  /** Append a verdict (idempotent on verdict id). */
  static appendAuditVerdict(id: string, verdict: AuditVerdict): AuditRunRecord | null {
    const run = this.getAuditRun(id)
    if (!run) return null
    const verdicts = [...run.verdicts.filter((v) => v.id !== verdict.id), verdict]
    return this.updateAuditRun(id, { verdicts })
  }

  /** Append a gate result (idempotent on gate id). */
  static appendAuditGateResult(id: string, gate: AuditGateResult): AuditRunRecord | null {
    const run = this.getAuditRun(id)
    if (!run) return null
    const gates = [...run.gates.filter((g) => g.id !== gate.id), gate]
    return this.updateAuditRun(id, { gates })
  }

  /** Upsert a participant by runId (status/cost/token updates as the run flows). */
  static upsertAuditParticipant(id: string, participant: AuditParticipant): AuditRunRecord | null {
    const run = this.getAuditRun(id)
    if (!run) return null
    const participants = [
      ...run.participants.filter((p) => p.runId !== participant.runId),
      participant
    ]
    return this.updateAuditRun(id, { participants })
  }

  static deleteAuditRun(id: string): void {
    writeJson(
      auditRunsPath,
      this.getAuditRuns().filter((run) => run.id !== id)
    )
  }

  /**
   * Slice 6 — settle audit runs left non-terminal by a crash/quit. Boot-only: audit
   * is a hard singleton with no resume, so a non-terminal run at startup is orphaned
   * by definition (its process is gone). Mirrors reconcileStaleWorkflowRunLedgers;
   * idempotent (terminal runs are skipped). Returns the settled runs for logging.
   */
  static reconcileStaleAuditRuns(nowIso: string = new Date().toISOString()): StaleAuditRun[] {
    const stale = findStaleAuditRuns(this.getAuditRuns())
    for (const run of stale) {
      this.updateAuditRun(run.id, {
        status: 'failed',
        error: AUDIT_RESTART_INTERRUPTION_ERROR,
        endedAt: nowIso
      })
    }
    return stale
  }

  static getNextWorkflowRunAtMs(): number | null {
    let next: number | null = null
    for (const workflow of this.getWorkflowDefinitions()) {
      if (!workflow.enabled || !workflow.nextRunAt) continue
      const runAtMs = new Date(workflow.nextRunAt).getTime()
      if (!Number.isFinite(runAtMs)) continue
      if (next === null || runAtMs < next) next = runAtMs
    }
    return next
  }

  static materializeDueWorkflows(nowMs: number = Date.now()): ScheduledTask[] {
    const workflows = this.getWorkflowDefinitions()
    const materialized: ScheduledTask[] = []
    let changed = false
    for (const workflow of workflows) {
      if (!workflow.enabled || !workflow.nextRunAt) continue
      const nextRunAtMs = new Date(workflow.nextRunAt).getTime()
      if (!Number.isFinite(nextRunAtMs) || nextRunAtMs > nowMs) continue
      const before = JSON.stringify(workflow)
      const task = this.materializeWorkflowTask(workflow, workflow.nextRunAt, nowMs)
      if (task) {
        materialized.push(task)
      }
      if (task || JSON.stringify(workflow) !== before) changed = true
    }
    if (changed) writeJson(workflowsPath, workflows)
    return materialized
  }

  static materializeWorkflowNow(id: string, nowMs: number = Date.now()): ScheduledTask | null {
    const workflows = this.getWorkflowDefinitions()
    const workflow = workflows.find((item) => item.id === id)
    if (!workflow) return null
    const before = JSON.stringify(workflow)
    const task = this.materializeWorkflowTask(workflow, new Date(nowMs).toISOString(), nowMs, true)
    if (task || JSON.stringify(workflow) !== before) writeJson(workflowsPath, workflows)
    return task
  }

  private static materializeWorkflowTask(
    workflow: WorkflowDefinition,
    plannedFor: string,
    nowMs: number,
    manual = false
  ): ScheduledTask | null {
    const nowIso = new Date(nowMs).toISOString()
    const invalidReason = this.workflowDefinitionInvalidReason(workflow)
    if (invalidReason) {
      const execution: WorkflowExecutionRecord = {
        id: randomUUID(),
        workflowId: workflow.id,
        plannedFor,
        status: 'failed',
        createdAt: nowIso,
        updatedAt: nowIso,
        completedAt: nowIso,
        error: invalidReason
      }
      workflow.history = [...workflow.history, execution].slice(-WORKFLOW_HISTORY_LIMIT)
      workflow.activeExecutionId = undefined
      workflow.lastStatus = 'failed'
      workflow.lastError = invalidReason
      workflow.failureStreak += 1
      workflow.enabled = false
      workflow.nextRunAt = undefined
      workflow.updatedAt = nowIso
      return null
    }
    const activeExecution = workflow.activeExecutionId
      ? workflow.history.find((execution) => execution.id === workflow.activeExecutionId)
      : null
    if (
      activeExecution &&
      !isTerminalWorkflowExecutionStatus(activeExecution.status) &&
      workflow.concurrencyPolicy !== 'enqueue'
    ) {
      workflow.nextRunAt = resolveNextWorkflowRunAt(workflow.trigger, nowMs, nowMs)
      workflow.updatedAt = nowIso
      if (workflow.missedRunPolicy === 'skip') {
        const execution: WorkflowExecutionRecord = {
          id: randomUUID(),
          workflowId: workflow.id,
          plannedFor,
          status: 'skipped',
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: nowIso,
          error: 'Skipped because a previous workflow execution is still active.'
        }
        workflow.history = [...workflow.history, execution].slice(-WORKFLOW_HISTORY_LIMIT)
        workflow.lastStatus = 'skipped'
        workflow.lastError = execution.error
      }
      return null
    }

    const maxRunsPerDay = workflow.limits.maxRunsPerDay
    if (maxRunsPerDay && maxRunsPerDay > 0) {
      const dayStart = new Date(nowMs)
      dayStart.setHours(0, 0, 0, 0)
      const runsToday = workflow.history.filter((execution) => {
        const createdMs = new Date(execution.createdAt).getTime()
        return (
          Number.isFinite(createdMs) &&
          createdMs >= dayStart.getTime() &&
          execution.status !== 'skipped'
        )
      }).length
      if (runsToday >= maxRunsPerDay) {
        const execution: WorkflowExecutionRecord = {
          id: randomUUID(),
          workflowId: workflow.id,
          plannedFor,
          status: 'skipped',
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: nowIso,
          error: `Daily workflow run limit reached (${maxRunsPerDay}).`
        }
        workflow.history = [...workflow.history, execution].slice(-WORKFLOW_HISTORY_LIMIT)
        workflow.lastStatus = 'skipped'
        workflow.lastError = execution.error
        workflow.nextRunAt =
          workflow.trigger.kind === 'manual' || workflow.trigger.kind === 'once'
            ? undefined
            : nextLocalDayBoundaryIso(nowMs)
        workflow.updatedAt = nowIso
        return null
      }
    }

    const executionId = randomUUID()
    const task = this.saveScheduledTask({
      ...workflow.template,
      // No `[workflow: …]` text prefix — workflows are identified by the
      // Workflows sidebar section + glyph, not a baked-in title/transcript
      // string (the prefix used to leak into the chat title everywhere).
      displayPrompt: workflow.template.displayPrompt || workflow.template.prompt,
      runAt: nowIso,
      timezone:
        workflow.trigger.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      status: 'due',
      workflowId: workflow.id,
      workflowExecutionId: executionId,
      workflowOccurrenceAt: plannedFor
    })
    const execution: WorkflowExecutionRecord = {
      id: executionId,
      workflowId: workflow.id,
      scheduledTaskId: task.id,
      plannedFor,
      status: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso
    }
    workflow.history = [...workflow.history, execution].slice(-WORKFLOW_HISTORY_LIMIT)
    workflow.activeExecutionId = executionId
    workflow.lastRunAt = nowIso
    workflow.lastStatus = 'queued'
    workflow.lastError = undefined
    workflow.nextRunAt = resolveNextWorkflowRunAt(workflow.trigger, nowMs, nowMs)
    workflow.updatedAt = nowIso
    if (manual && workflow.trigger.kind === 'manual') {
      workflow.nextRunAt = undefined
    }
    return task
  }

  static syncWorkflowFromScheduledTask(task: ScheduledTask): WorkflowDefinition | null {
    if (!task.workflowId || !task.workflowExecutionId) return null
    const workflows = this.getWorkflowDefinitions()
    const index = workflows.findIndex((workflow) => workflow.id === task.workflowId)
    if (index < 0) return null
    const workflow = workflows[index]
    const nextStatus = scheduledTaskStatusToWorkflowStatus(task.status)
    if (!nextStatus) return workflow
    const nowIso = new Date().toISOString()
    const history = [...workflow.history]
    let executionIndex = history.findIndex((execution) => execution.id === task.workflowExecutionId)
    // Stage 1 — the prior recorded status, captured BEFORE the history mutation,
    // so the durable ledger only gets an event on an ACTUAL status transition.
    const priorExecStatus = executionIndex >= 0 ? history[executionIndex].status : null
    if (executionIndex < 0) {
      history.push({
        id: task.workflowExecutionId,
        workflowId: workflow.id,
        scheduledTaskId: task.id,
        plannedFor: task.workflowOccurrenceAt || task.runAt,
        status: nextStatus,
        createdAt: task.createdAt || nowIso,
        updatedAt: nowIso
      })
      executionIndex = history.length - 1
    }
    const previous = history[executionIndex]
    const terminal = isTerminalWorkflowExecutionStatus(nextStatus)
    const wasTerminal = isTerminalWorkflowExecutionStatus(previous.status)
    history[executionIndex] = {
      ...previous,
      scheduledTaskId: task.id,
      runId: task.runId || previous.runId,
      status: nextStatus,
      updatedAt: nowIso,
      ...(nextStatus === 'running' && !previous.startedAt
        ? { startedAt: task.firedAt || nowIso }
        : {}),
      ...(terminal ? { completedAt: task.completedAt || nowIso } : {}),
      ...(task.lastError ? { error: task.lastError } : {})
    }

    workflow.history = history.slice(-WORKFLOW_HISTORY_LIMIT)
    workflow.lastStatus = nextStatus
    workflow.lastError = task.lastError
    workflow.updatedAt = nowIso
    if (nextStatus === 'running') {
      workflow.activeExecutionId = task.workflowExecutionId
    }
    if (terminal) {
      workflow.lastCompletedAt = task.completedAt || nowIso
      if (workflow.activeExecutionId === task.workflowExecutionId) {
        workflow.activeExecutionId = undefined
      }
      if (!wasTerminal) {
        workflow.failureStreak = nextStatus === 'failed' ? workflow.failureStreak + 1 : 0
        const maxFailures = workflow.limits.maxConsecutiveFailures || 3
        if (nextStatus === 'failed' && workflow.failureStreak >= maxFailures) {
          workflow.enabled = false
          workflow.nextRunAt = undefined
          workflow.lastError =
            task.lastError || `Workflow auto-disabled after ${workflow.failureStreak} failures.`
        } else if (workflow.enabled) {
          const completedAtMs = task.completedAt ? Date.parse(task.completedAt) : Number.NaN
          const nowMs = Number.isFinite(completedAtMs) ? completedAtMs : Date.now()
          const existingNextRunAtMs = workflow.nextRunAt
            ? Date.parse(workflow.nextRunAt)
            : Number.NaN
          workflow.nextRunAt =
            Number.isFinite(existingNextRunAtMs) && existingNextRunAtMs > nowMs
              ? workflow.nextRunAt
              : resolveNextWorkflowRunAt(workflow.trigger, nowMs, nowMs)
        } else {
          workflow.nextRunAt = undefined
        }
      }
    }
    // Stage 1 — append a durable ledger event on a real status transition
    // (running/completed/failed/cancelled — the values sync produces). Best-effort:
    // a ledger write failure must NEVER break the workflow sync.
    if (priorExecStatus !== nextStatus) {
      const ledgerKind = workflowStatusToRunEventKind(nextStatus)
      if (ledgerKind) {
        try {
          this.appendWorkflowRunEvent({
            workflowExecutionId: task.workflowExecutionId,
            workflowId: workflow.id,
            kind: ledgerKind,
            scheduledTaskId: task.id,
            runId: task.runId,
            plannedFor: task.workflowOccurrenceAt || task.runAt,
            ...(task.lastError ? { error: task.lastError } : {})
          })
        } catch (e) {
          console.error('Failed to append workflow run event', e)
        }
      }
    }
    workflows[index] = workflow
    writeJson(workflowsPath, workflows)
    return workflow
  }

  // Scheduled tasks
  static getScheduledTasks(workspaceId?: string): ScheduledTask[] {
    const tasks = readJson<ScheduledTask[]>(scheduledTasksPath, [])
    return tasks
      .filter((task) => !workspaceId || task.workspaceId === workspaceId)
      .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime())
  }

  static saveScheduledTask(
    task: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'> &
      Partial<Pick<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>>
  ): ScheduledTask {
    const tasks = this.getScheduledTasks()
    const now = new Date().toISOString()
    const record: ScheduledTask = {
      ...task,
      id: task.id || randomUUID(),
      status: task.status || 'pending',
      createdAt: task.createdAt || now,
      updatedAt: now
    }
    const index = tasks.findIndex((item) => item.id === record.id)
    if (index >= 0) {
      tasks[index] = { ...tasks[index], ...record, updatedAt: now }
    } else {
      tasks.push(record)
    }
    writeJson(scheduledTasksPath, tasks)
    return record
  }

  static updateScheduledTask(id: string, partial: Partial<ScheduledTask>): ScheduledTask | null {
    const tasks = this.getScheduledTasks()
    const index = tasks.findIndex((task) => task.id === id)
    if (index < 0) return null
    const current = tasks[index]
    if (partial.status && isInvalidScheduledTaskStatusTransition(current.status, partial.status)) {
      return current
    }
    const updated = { ...current, ...partial, id, updatedAt: new Date().toISOString() }
    // Stamp `runningSince` ONLY on the transition INTO 'running'. Self-contained
    // wall-clock — NOT bound to updatedAt, and NOT reset on benign re-patches of an
    // already-running task, so the stall reconciler can age a wedge out. Honour an
    // explicit caller-supplied runningSince.
    if (
      updated.status === 'running' &&
      current.status !== 'running' &&
      partial.runningSince === undefined
    ) {
      updated.runningSince = new Date().toISOString()
    }
    tasks[index] = updated
    writeJson(scheduledTasksPath, tasks)
    this.syncWorkflowFromScheduledTask(updated)
    return updated
  }

  static deleteScheduledTask(id: string) {
    writeJson(
      scheduledTasksPath,
      this.getScheduledTasks().filter((task) => task.id !== id)
    )
  }

  static getDueScheduledTasks(nowMs: number = Date.now()): ScheduledTask[] {
    return this.getScheduledTasks().filter((task) => {
      if (task.status === 'due') return true
      if (task.status !== 'pending') return false
      const runAtMs = new Date(task.runAt).getTime()
      return Number.isFinite(runAtMs) && runAtMs <= nowMs
    })
  }

  static recoverInterruptedScheduledTasksAfterStartup(nowMs: number = Date.now()): ScheduledTask[] {
    const tasks = this.getScheduledTasks()
    const recoveredAt = new Date(nowMs).toISOString()
    const recovered: ScheduledTask[] = []
    const nextTasks = tasks.map((task) => {
      if (task.status !== 'running') return task
      const updated: ScheduledTask = {
        ...task,
        status: 'failed',
        completedAt: task.completedAt || recoveredAt,
        lastError: task.lastError || 'TaskWraith restarted before this scheduled run completed.',
        updatedAt: recoveredAt
      }
      recovered.push(updated)
      return updated
    })
    if (recovered.length === 0) return []
    writeJson(scheduledTasksPath, nextTasks)
    for (const task of recovered) {
      this.syncWorkflowFromScheduledTask(task)
    }
    return recovered
  }

  /**
   * Universal BACKSTOP for wedged scheduled-workflow occurrences. A scheduled
   * workflow stamps `activeExecutionId` at materialize time and skips the next
   * occurrence while that execution is non-terminal; a stuck occurrence
   * ('due'/'running'/overdue 'pending') silently disables the workflow forever.
   * Settles any occurrence aged past `backstopMs` with no live run to 'failed' via
   * the normal `updateScheduledTask` path — which (through
   * `syncWorkflowFromScheduledTask`) clears `activeExecutionId`, bumps
   * `failureStreak`, and engages `maxConsecutiveFailures`. Idempotent (the
   * transition guard makes already-terminal tasks no-ops), so a genuinely-alive
   * run's real terminal write is never stolen. Returns only the tasks actually
   * settled this call so the caller can de-dupe the loud event per real settle.
   */
  static settleStalledScheduledTasks(
    isRunLive: (runId: string) => boolean,
    nowMs: number = Date.now(),
    backstopMs: number = DEFAULT_STALL_BACKSTOP_MS
  ): ScheduledTask[] {
    const candidates = findStalledScheduledTasks(
      this.getScheduledTasks(),
      isRunLive,
      nowMs,
      backstopMs
    )
    if (candidates.length === 0) return []
    const completedAt = new Date(nowMs).toISOString()
    const settled: ScheduledTask[] = []
    for (const { task, basis, ageMs } of candidates) {
      const updated = this.updateScheduledTask(task.id, {
        status: 'failed',
        completedAt,
        lastError: stallReason(task, basis, ageMs, backstopMs)
      })
      // Count as settled ONLY if the write actually flipped it to failed (the
      // guard returns the unchanged record if it was concurrently advanced).
      if (updated && updated.status === 'failed' && updated.completedAt === completedAt) {
        settled.push(updated)
      }
    }
    return settled
  }

  // Run queue
  static getRunQueueJobs(filter: RunQueueJobFilter = {}): RunQueueJob[] {
    const jobs = readJson<RunQueueJob[]>(runQueuePath, [])
    return sortRunQueueJobs(filterRunQueueJobs(jobs, filter))
  }

  static getRunQueueJob(runIdOrId: string): RunQueueJob | null {
    const jobs = readJson<RunQueueJob[]>(runQueuePath, [])
    return jobs.find((job) => job.id === runIdOrId || job.runId === runIdOrId) || null
  }

  static saveRunQueueJob(input: RunQueueJobInput): RunQueueJob {
    const jobs = readJson<RunQueueJob[]>(runQueuePath, [])
    const index = jobs.findIndex((job) => job.id === input.id || job.runId === input.runId)
    const now = new Date().toISOString()
    const record =
      index >= 0 ? updateRunQueueJobRecord(jobs[index], input, now) : createRunQueueJob(input, now)

    if (index >= 0) {
      jobs[index] = record
    } else {
      jobs.push(record)
    }
    writeRunQueueJobs(jobs)
    return record
  }

  static updateRunQueueJob(runIdOrId: string, partial: Partial<RunQueueJob>): RunQueueJob | null {
    const jobs = readJson<RunQueueJob[]>(runQueuePath, [])
    const index = jobs.findIndex((job) => job.id === runIdOrId || job.runId === runIdOrId)
    if (index < 0) return null
    const updated = updateRunQueueJobRecord(jobs[index], partial)
    jobs[index] = updated
    writeRunQueueJobs(jobs)
    return updated
  }

  static deleteRunQueueJob(runIdOrId: string) {
    const jobs = readJson<RunQueueJob[]>(runQueuePath, [])
    writeRunQueueJobs(jobs.filter((job) => job.id !== runIdOrId && job.runId !== runIdOrId))
  }

  static recoverInterruptedRunQueueJobs(): RunQueueJob[] {
    const jobs = readJson<RunQueueJob[]>(runQueuePath, [])
    const recovered = recoverInterruptedQueueJobs(jobs)
    writeRunQueueJobs(recovered)
    return recovered
  }

  static recoverRunQueueAfterStartup(): RunRecoveryRecord[] {
    const jobs = readJson<RunQueueJob[]>(runQueuePath, [])
    const recovered = recoverRunQueueJobsAfterStartup(jobs)
    writeRunQueueJobs(recovered.jobs)
    if (recovered.records.length > 0) {
      const records = readJson<RunRecoveryRecord[]>(runRecoveryPath, [])
      writeJson(runRecoveryPath, [...records, ...recovered.records])
    }
    return recovered.records
  }

  static getRunRecoveryRecords(filter: RunRecoveryFilter = {}): RunRecoveryRecord[] {
    const records = readJson<RunRecoveryRecord[]>(runRecoveryPath, [])
    return filterRunRecoveryRecords(Array.isArray(records) ? records : [], filter)
  }

  // Run transcript/event store
  static appendRunEvent(input: RunEventInput): RunEventRecord {
    if (deletedRunIds.has(input.runId)) {
      return createRunEventRecord(input, 1, { storeRawPayload: false })
    }
    const filePath = runEventFilePath(input.runId)
    const cachedSequence = runEventSequenceCache.get(input.runId)
    const cachedHash = runEventHashCache.get(input.runId)
    const existingEvents =
      cachedSequence !== undefined && cachedHash !== undefined ? [] : readRunEventFile(filePath)
    const sequence =
      cachedSequence !== undefined ? cachedSequence + 1 : nextRunEventSequence(existingEvents)
    const previousHash = cachedHash || lastRunEventHash(existingEvents)
    const settings = this.getSettings()
    const artifacts = settings.storeRawEvents ? appendRunStreamArtifact(input, sequence) : undefined
    const record = createRunEventRecord(input, sequence, {
      storeRawPayload: settings.storeRawEvents,
      previousHash,
      artifacts
    })
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeFileSync(fd, serializeRunEventRecord(record), 'utf-8')
      if (input.kind === 'lifecycle' || sequence % 25 === 0) {
        fs.fsyncSync(fd)
      }
    } finally {
      fs.closeSync(fd)
    }
    runEventSequenceCache.set(input.runId, record.sequence)
    runEventHashCache.set(input.runId, record.hash || previousHash)
    return record
  }

  /**
   * Stage 1 — append a lifecycle event to a workflow EXECUTION's durable ledger
   * (workflow-runs/<executionId>.jsonl). Per-execution file = single writer (no
   * cross-writer clobber). Mirrors appendRunEvent's per-file append; always
   * fsync'd (the ledger is low-frequency — a handful of events per occurrence).
   */
  static appendWorkflowRunEvent(input: WorkflowRunEventInput): WorkflowRunEvent {
    const filePath = workflowRunFilePath(input.workflowExecutionId)
    const cached = workflowRunSequenceCache.get(input.workflowExecutionId)
    const sequence =
      cached !== undefined ? cached + 1 : nextWorkflowRunSequence(readWorkflowRunFile(filePath))
    const event = createWorkflowRunEvent(input, sequence)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeFileSync(fd, serializeWorkflowRunEvent(event), 'utf-8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    workflowRunSequenceCache.set(input.workflowExecutionId, event.sequence)
    return event
  }

  // ── Agent Pool stats ledger (Phase 2) ─────────────────────────────────────

  /** Lazy-load (once per process) the seen-runId set + raw-delta count for an
   *  Agent from its file — one read populates both caches. The seen-set spans the
   *  rollup so dedup survives a restart + compaction; the count gates compaction
   *  without re-reading the file on the hot append path. */
  private static ensureAgentStatsLoaded(agentId: string): void {
    if (agentStatsSeenCache.has(agentId)) return
    const records = readAgentStatsFile(agentStatsFilePath(agentId))
    agentStatsSeenCache.set(agentId, seenRunIds(records))
    agentStatsRawCountCache.set(agentId, countRawDeltas(records))
  }

  /**
   * Append a finalized run's delta to an Agent's ledger — idempotent on runId
   * (the in-memory seen-set skips a re-harvested run). Compacts the file into a
   * single rollup once raw deltas cross AGENT_STATS_FILE_CAP. The normal append
   * path does NO file read (the raw-count cache gates compaction). Best-effort: a
   * write failure must never break the saveChat that triggered it.
   */
  private static recordAgentRunDelta(agentId: string, chatId: string, run: ChatRun): void {
    if (!isPooledAgentId(agentId) || typeof run.runId !== 'string' || !run.runId) return
    this.ensureAgentStatsLoaded(agentId)
    const seen = agentStatsSeenCache.get(agentId) as Set<string>
    if (seen.has(run.runId)) return
    const delta = buildAgentStatDelta(chatId, run, Date.now())
    if (!delta) return
    const filePath = agentStatsFilePath(agentId)
    const rawCount = agentStatsRawCountCache.get(agentId) ?? 0
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      if (rawCount + 1 > AGENT_STATS_FILE_CAP) {
        // Rare — only at the cap. Re-read to fold existing + this delta into one
        // rollup, then reset the raw count to 0 (the file now holds only a rollup).
        const rollup = compactToRollup(agentId, [...readAgentStatsFile(filePath), delta])
        writeTextAtomic(filePath, serializeAgentStatRecord(rollup))
        agentStatsRawCountCache.set(agentId, 0)
      } else {
        const fd = fs.openSync(filePath, 'a')
        try {
          fs.writeFileSync(fd, serializeAgentStatRecord(delta), 'utf-8')
          fs.fsyncSync(fd)
        } finally {
          fs.closeSync(fd)
        }
        agentStatsRawCountCache.set(agentId, rawCount + 1)
      }
      seen.add(run.runId)
    } catch (e) {
      console.error(`Failed to record agent stats for ${agentId}`, e)
    }
  }

  /**
   * saveChat hook — harvest any finalized run whose participant is linked to a
   * pooled Agent. Early-outs unless the chat is an ensemble carrying at least one
   * pooled participant (the common chat has none → near-zero cost). Scoped to
   * THIS chat's own runs — never a corpus sweep.
   */
  private static harvestChatAgentStats(chat: ChatRecord): void {
    const participants = chat.ensemble?.participants
    if (!Array.isArray(participants) || participants.length === 0) return
    const agentByParticipant = new Map<string, string>()
    for (const participant of participants) {
      if (participant && isPooledAgentId(participant.pooledAgentId)) {
        agentByParticipant.set(participant.id, participant.pooledAgentId as string)
      }
    }
    if (agentByParticipant.size === 0) return
    const runs = Array.isArray(chat.runs) ? chat.runs : []
    const chatId = chat.appChatId
    for (const run of runs) {
      const agentId = run?.ensembleParticipantId
        ? agentByParticipant.get(run.ensembleParticipantId)
        : undefined
      if (agentId) this.recordAgentRunDelta(agentId, chatId, run)
    }
  }

  /**
   * Fold the per-Agent ledgers for the requested ids into summaries. ASYNC +
   * per-file await so a pool-open query can't beachball MAIN. REQUIRES a
   * non-empty id list — empty is never interpreted as "all" (the documented
   * run-events full-sweep hazard). Unknown ids fold to an all-zero summary.
   */
  static async getAgentStatsSummaries(agentIds: string[]): Promise<PooledAgentStatsSummary[]> {
    if (!Array.isArray(agentIds) || agentIds.length === 0) return []
    const unique = [...new Set(agentIds.filter(isPooledAgentId))]
    const summaries: PooledAgentStatsSummary[] = []
    for (const agentId of unique) {
      const records = await readAgentStatsFileAsync(agentStatsFilePath(agentId))
      summaries.push(foldAgentStats(agentId, records))
    }
    return summaries
  }

  /** Read a workflow execution's durable lifecycle ledger (all events, in sequence order). */
  static getWorkflowRunEvents(workflowExecutionId: string): WorkflowRunEvent[] {
    return readWorkflowRunFile(workflowRunFilePath(workflowExecutionId)).sort(
      (a, b) => a.sequence - b.sequence
    )
  }

  /**
   * Enumerate every workflow-runs ledger file → its folded summary. SYNC: called
   * once at BOOT (before the window shows), and the ledger is low-volume (a handful
   * of short events per occurrence, one file per execution), so a sync sweep is
   * fine — unlike the run-events dir (see readAllRunEventFilesAsync). The execId is
   * taken from the events (authoritative; safeWorkflowRunFileName is lossy), not the
   * filename. Best-effort: a single unreadable file yields [] for that file only.
   */
  private static foldAllWorkflowRunLedgers(): WorkflowRunSummary[] {
    try {
      if (!fs.existsSync(workflowRunsDir)) return []
      return fs
        .readdirSync(workflowRunsDir)
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => {
          const events = readWorkflowRunFile(path.join(workflowRunsDir, file))
          const execId = events.find((e) => e.workflowExecutionId)?.workflowExecutionId || ''
          return foldWorkflowRunSummary(execId, events)
        })
        .filter((summary) => Boolean(summary.workflowExecutionId))
    } catch (e) {
      console.error(`Failed to enumerate ${workflowRunsDir}`, e)
      return []
    }
  }

  /**
   * Stage 1 slice 2 — at BOOT, close any workflow-runs ledger left NON-terminal by
   * a crash/quit mid-run (last event materialized/dispatched/running, no terminal)
   * with a terminal `stall_settled` event, so the durable ledger is never
   * permanently open. Idempotent: stall_settled IS terminal, so an already-settled
   * (or normally-completed) execution is skipped on every later boot. Best-effort
   * per file. Runs AFTER the ScheduledTask recoveries, so executions they already
   * settled (via syncWorkflowFromScheduledTask) are terminal → no-ops here. Returns
   * the executions actually settled.
   */
  static reconcileStaleWorkflowRunLedgers(nowMs: number = Date.now()): StaleLedgerExecution[] {
    const stale = reconcileStaleLedgerExecutions(this.foldAllWorkflowRunLedgers())
    const settled: StaleLedgerExecution[] = []
    const timestamp = new Date(nowMs).toISOString()
    for (const execution of stale) {
      try {
        this.appendWorkflowRunEvent({
          workflowExecutionId: execution.workflowExecutionId,
          workflowId: execution.workflowId,
          kind: 'stall_settled',
          timestamp,
          error: 'TaskWraith restarted before this workflow execution reached a terminal state.'
        })
        settled.push(execution)
      } catch (e) {
        console.error('Failed to settle stale workflow run ledger', execution.workflowExecutionId, e)
      }
    }
    return settled
  }

  /** List every workflow-runs ledger file path. ASYNC readdir (slice 4 query path). */
  private static async listWorkflowRunFilesAsync(): Promise<string[]> {
    try {
      return (await fs.promises.readdir(workflowRunsDir))
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => path.join(workflowRunsDir, file))
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error(`Failed to read ${workflowRunsDir}`, e)
      }
      return []
    }
  }

  /**
   * Stage 1 slice 4 — every workflow execution's folded summary (uncapped, unlike
   * the 50-cap WorkflowDefinition.history), newest-first. Optionally scoped to one
   * workflowId. ASYNC + per-file await so a renderer query can't beachball MAIN.
   */
  static async getWorkflowRunSummaries(workflowId?: string): Promise<WorkflowRunSummary[]> {
    const files = await this.listWorkflowRunFilesAsync()
    const summaries: WorkflowRunSummary[] = []
    for (const file of files) {
      const events = await readWorkflowRunFileAsync(file)
      // execId from the events (authoritative; safeWorkflowRunFileName is lossy).
      const execId = events.find((e) => e.workflowExecutionId)?.workflowExecutionId || ''
      if (!execId) continue
      const summary = foldWorkflowRunSummary(execId, events)
      if (!workflowId || summary.workflowId === workflowId) summaries.push(summary)
    }
    return summaries.sort((a, b) => workflowRunSummarySortKey(b) - workflowRunSummarySortKey(a))
  }

  /**
   * Stage 1 slice 4 — a filtered slice of run-ledger EVENTS. A workflowExecutionId
   * scopes to one execution's file (cheap single read — the drill-in case);
   * otherwise enumerates (async) and applies the filter. filterWorkflowRunEvents
   * defends limit/fromTimestamp, so an untrusted renderer filter is safe to pass.
   */
  static async getWorkflowRunEventsFiltered(
    filter: WorkflowRunEventFilter = {}
  ): Promise<WorkflowRunEvent[]> {
    if (filter.workflowExecutionId) {
      return filterWorkflowRunEvents(this.getWorkflowRunEvents(filter.workflowExecutionId), filter)
    }
    const files = await this.listWorkflowRunFilesAsync()
    const all: WorkflowRunEvent[] = []
    for (const file of files) {
      for (const event of await readWorkflowRunFileAsync(file)) all.push(event)
    }
    return filterWorkflowRunEvents(all, filter)
  }

  static appendRunEvents(inputs: RunEventInput[]): RunEventRecord[] {
    return inputs.map((input) => this.appendRunEvent(input))
  }

  /**
   * Resolve the run-event FILE PATHS a filter needs (cheap + sync: a getChat cache
   * hit + array math). Returns `null` to mean "no scoping → whole-dir sweep", which
   * happens ONLY when neither runId nor chatId is given (rare forensics).
   *
   * Scoping a {chatId} query to THIS chat's own `<runId>.jsonl` files is what kills
   * the first-open beachball: the run-events dir grows to GIGABYTES across all
   * chats, and reading + parsing all of it on the MAIN process blocks for SECONDS.
   * filterRunEvents still applies chatId + limit downstream, so the result is the
   * same set the old sweep yielded for this chat (minus orphan events whose run is
   * no longer in `chat.runs`). Newest runs first, capped — but NOT limit-truncated:
   * ensemble rounds run participants CONCURRENTLY under one chatId with INTERLEAVED
   * timestamps, so a sibling run must still be read even past `limit` (the
   * timestamp sort in filterRunEvents picks the true newest). Unpersisted chats
   * (storeLocalChatHistory off) have no chat record → getChat null → [] (raw-log
   * hydration falls back to the renderer's live ref; acceptable vs. the GB sweep).
   */
  private static runEventFilePathsForFilter(filter: RunEventFilter): string[] | null {
    if (filter.runId) return [runEventFilePath(filter.runId)]
    if (filter.chatId) {
      const chat = this.getChat(filter.chatId)
      const runIds = (chat?.runs ?? [])
        .map((run) => run.runId)
        .filter((id): id is string => Boolean(id))
        .reverse()
        .slice(0, RUN_EVENT_CHAT_FILE_CAP)
      return runIds.map((runId) => runEventFilePath(runId))
    }
    return null
  }

  static getRunEvents(filter: RunEventFilter = {}): RunEventRecord[] {
    const paths = this.runEventFilePathsForFilter(filter)
    const events =
      paths === null ? readAllRunEventFiles() : paths.flatMap((p) => readRunEventFile(p))
    return filterRunEvents(events, filter)
  }

  /** Async twin of {@link getRunEvents}. The renderer's `get-run-events` IPC uses
   * THIS so that even a future filter with no runId/chatId (→ whole-dir read) yields
   * the event loop instead of beachballing the MAIN thread. Same result as the sync
   * version for the same filter. */
  static async getRunEventsAsync(filter: RunEventFilter = {}): Promise<RunEventRecord[]> {
    const paths = this.runEventFilePathsForFilter(filter)
    const events =
      paths === null ? await readAllRunEventFilesAsync() : await readRunEventFilesAsync(paths)
    return filterRunEvents(events, filter)
  }

  static getRunEventReplay(runId: string) {
    return createRunEventReplay(runId, readRunEventFile(runEventFilePath(runId)))
  }

  /** Cheap forensics-availability check for cross-thread recall: false when a
   * run's durable event file was deleted/tombstoned, so recall excludes it
   * rather than returning an empty-but-plausible shell (the #1 confabulation
   * trap). `existsSync` stays correct across restarts — the file is rm'd on
   * delete — while the in-memory `deletedRunIds` set is the same-session fast
   * path (a deleted run keeps its RunQueueJob, so it would otherwise rank). */
  static hasRunForensics(runId: string): boolean {
    if (!runId || deletedRunIds.has(runId)) return false
    try {
      return fs.existsSync(runEventFilePath(runId))
    } catch {
      return false
    }
  }

  // Workspace change model
  /** Same mtime+size-validated caching as chat records: the change ledger
   * reached 19MB on disk and was re-parsed on the main process per read. */
  private static workspaceChangeCache: {
    mtimeMs: number
    size: number
    records: WorkspaceChangeSet[]
  } | null = null

  private static readWorkspaceChangeSetsCached(): WorkspaceChangeSet[] {
    let stat: fs.Stats
    try {
      stat = fs.statSync(workspaceChangesPath)
    } catch {
      this.workspaceChangeCache = null
      return []
    }
    const cached = this.workspaceChangeCache
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.records
    }
    const parsed = readJson<WorkspaceChangeSet[]>(workspaceChangesPath, [])
    const records = Array.isArray(parsed) ? parsed : []
    this.workspaceChangeCache = { mtimeMs: stat.mtimeMs, size: stat.size, records }
    return records
  }

  static getWorkspaceChangeSets(filter: WorkspaceChangeFilter = {}): WorkspaceChangeSet[] {
    return filterWorkspaceChangeSets(this.readWorkspaceChangeSetsCached(), filter)
  }

  static saveWorkspaceChangeSet(input: WorkspaceChangeSetInput): WorkspaceChangeSet {
    const records = [...this.readWorkspaceChangeSetsCached()]
    const record = createWorkspaceChangeSet(input)
    const index = records.findIndex((item) => item.id === record.id)
    if (index >= 0) {
      records[index] = {
        ...records[index],
        ...record,
        id: records[index].id,
        createdAt: records[index].createdAt
      }
    } else {
      records.push(record)
    }
    // Retention on every persist — count + age caps plus per-record diff
    // compaction, so the ledger can't grow unbounded again.
    const pruned = pruneWorkspaceChangeSets(records)
    const preStat = fs.existsSync(workspaceChangesPath) ? fs.statSync(workspaceChangesPath) : null
    writeJson(workspaceChangesPath, pruned)
    try {
      const postStat = fs.statSync(workspaceChangesPath)
      const wrote =
        !preStat || postStat.mtimeMs !== preStat.mtimeMs || postStat.size !== preStat.size
      this.workspaceChangeCache = wrote
        ? { mtimeMs: postStat.mtimeMs, size: postStat.size, records: pruned }
        : null
    } catch {
      this.workspaceChangeCache = null
    }
    return index >= 0 ? records[index] : record
  }

  static recordWorkspaceRunChange(input: WorkspaceRunChangeInput): WorkspaceChangeSet {
    return this.saveWorkspaceChangeSet(createWorkspaceChangeSetFromRunDiff(input))
  }

  static recordWorkspaceEditorChange(input: WorkspaceEditorChangeInput): WorkspaceChangeSet {
    return this.saveWorkspaceChangeSet(createWorkspaceChangeSetFromEditorWrite(input))
  }

  // Approval ledger
  static getApprovalLedger(filter: ApprovalLedgerFilter = {}): ApprovalLedgerRecord[] {
    const records = this.recoverExpiredApprovalLedger()
    return filterApprovalLedgerRecords(records, filter)
  }

  static recordApprovalRequest(input: ApprovalLedgerRequestInput): ApprovalLedgerRecord {
    const records = this.recoverExpiredApprovalLedger()
    const record = createApprovalLedgerRecord(input)
    const index = records.findIndex((item) => item.approvalId === record.approvalId)
    if (index >= 0) {
      records[index] = {
        ...records[index],
        ...record,
        id: records[index].id,
        requestedAt: records[index].requestedAt
      }
    } else {
      records.push(record)
    }
    writeApprovalLedger(records)
    return index >= 0 ? records[index] : record
  }

  static resolveApprovalRequest(
    approvalId: string,
    action: AgentApprovalAction,
    decisionSource: 'user' | 'system' = 'user',
    extraMetadata: Record<string, unknown> = {}
  ): ApprovalLedgerRecord | null {
    const records = this.recoverExpiredApprovalLedger()
    const index = records.findIndex((record) => record.approvalId === approvalId)
    if (index < 0) return null
    const updated = resolveApprovalLedgerRecord(
      records[index],
      action,
      undefined,
      decisionSource,
      extraMetadata
    )
    records[index] = updated
    writeApprovalLedger(records)
    return updated
  }

  static expireApprovalLedgerScope(filter: {
    runId?: string
    provider?: ProviderId
    workspacePath?: string
    scopes: ApprovalLedgerScope[]
    reason: string
  }): ApprovalLedgerRecord[] {
    const records = this.recoverExpiredApprovalLedger()
    const updated = expireScopedApprovalLedgerRecords(records, filter)
    writeApprovalLedger(updated)
    return updated
  }

  static recoverExpiredApprovalLedger(): ApprovalLedgerRecord[] {
    const stored = readJson<ApprovalLedgerRecord[] | unknown>(approvalLedgerPath, [])
    const records = Array.isArray(stored) ? stored : []
    const recovered = recoverExpiredApprovalLedgerRecords(records)
    // Compact on read too, so an already-bloated ledger self-heals at the first
    // access after launch (not only on the next approval write).
    const capped = capApprovalLedgerRecords(recovered)
    const changed =
      !Array.isArray(stored) ||
      capped.length !== records.length ||
      capped.some((record, index) => record !== records[index])
    if (changed) {
      writeApprovalLedger(capped)
    }
    return capped
  }

  // Product operations
  static getProductCrashes(filter: ProductCrashFilter = {}): ProductCrashRecord[] {
    const records = readJson<ProductCrashRecord[] | unknown>(productCrashesPath, [])
    return filterProductCrashRecords(Array.isArray(records) ? records : [], filter)
  }

  static recordProductCrash(input: ProductCrashInput): ProductCrashRecord {
    const records = readJson<ProductCrashRecord[] | unknown>(productCrashesPath, [])
    const current = Array.isArray(records) ? records : []
    const record = createProductCrashRecord(input, {
      appVersion: app.getVersion() || 'unknown',
      platform: process.platform,
      arch: process.arch
    })
    current.push(record)
    writeJson(productCrashesPath, filterProductCrashRecords(current, { limit: 200 }))
    return record
  }
}
