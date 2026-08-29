import * as fs from 'fs'
import * as path from 'path'
import { createInterface } from 'readline'
import { isDeepStrictEqual } from 'util'
import { DEFAULT_PROVIDER } from '../../shared/retiredProviders'
import { adoptSupersededMaxWaveAgents } from './maxWaveAgentsDefault'
import { attachChatUpdateProducerEnvelope } from '../../shared/chatUpdateTransport'
import {
  APPROVAL_TIMEOUT_DEFAULTS_VERSION,
  DEFAULT_APPROVAL_TIMEOUTS_MS,
  DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS,
  migrateApprovalTimeoutDefaults
} from '../../shared/interactionTimeouts'
import { redactSecrets } from '../../shared/secretRedaction'
import { DEFAULT_DIFF_STAT_COLORS, normalizeDiffStatColors } from '../../shared/diffStatColors'
import { DEFAULT_THEME_ACCENT_COLOR, resolveThemeAccentColor } from '../../shared/themeAccentColor'
import { normalizeEnsembleAuthority } from '../../shared/ensembleAuthority'
import { stripExternalProviderThreadImportContinuity } from '../../shared/externalProviderThreadImport'
import {
  normalizeSystemThemeAppearance,
  resolveSystemThemeAppearance
} from '../../shared/systemThemeAppearance'
import { isRetiredExternalChannelInboundMessage } from '../LegacyExternalChannelHistory'
import { resolveActiveGoalForEnsemble } from '../GoalState'
import { MissionFactLedgerRepository } from '../missionLedger/MissionFactLedger'
import { MissionFactShadowService } from '../missionLedger/MissionFactShadowService'
import {
  kimiAcpSeatStatePath,
  kimiAcpSeatStateRoot,
  legacyKimiAcpSeatStatePaths,
  legacyKimiAcpSeatStateRoots
} from '../kimi/KimiAcpSeatState'
import {
  UsageJournalStore,
  type UsageHistoryMutationHold,
  type UsageHistoryMutationInput,
  type UsageHistoryPurgeReport
} from './UsageJournalStore'
import { coerceProviderForPersistence } from './ProviderOfferPersistence'
import {
  beginPersistenceWrite,
  isPersistenceProbeEnabled,
  recordPersistenceWrite,
  snapshotPersistenceProbes
} from './persistenceProbes'
import { installPerfStatsHandle } from './perfStatsHandle'
import { createChatJournal, type ChatJournalStats } from './chatJournal'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import {
  createIncrementalChatPersistence,
  type IncrementalChatPersistenceBoundary,
  type IncrementalChatPersistResult,
  type IncrementalChatPersistenceStats
} from './IncrementalChatPersistence'
import {
  ChatUpdateProjectionTracker,
  type ChatUpdateProjectionObservation
} from './ChatUpdateProjectionTracker'
import {
  rebaseChatRecordUpdate,
  type AuthoredChatTranscriptMutation
} from './ChatRecordMutation'
import { createSaveCoalescer, type FlushReason, type SaveCoalescerStats } from './saveCoalescer'
import {
  runLegacyStoreWriteAdmission,
  scheduleLegacyStoreDeferredWrite,
  type LegacyStoreDeferredSettlement,
  type LegacyStoreWriteAdmissionScope
} from './LegacyStoreWriteAdmission'
import { legacyStoreWriterGate } from './LegacyStoreWriterGate'
import { readRunEventLedgerHead } from './RunEventLedgerHead'
import {
  createDesktopHostThreadRecordPersistClient,
  HostThreadRecordPersistError,
  type HostThreadRecordPersistInput,
  type HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import {
  createDesktopHostWorkspaceRecordClient,
  type HostWorkspaceRecordPort
} from '../host/HostWorkspaceRecordCommand'
import { createDirectoryFsyncQueue } from './DirectoryFsyncQueue'
import { requireConfiguredHostStoreRuntime } from '../../host-runtime/HostStoreRuntime'
export type {
  UsageHistoryMutationHold,
  UsageHistoryMutationInput,
  UsageHistoryPurgeReport
} from './UsageJournalStore'
import type { TaskWraithPluginResourceProvenance } from '../../shared/plugins/PluginTypes'
import type { UnattendedElevationAck } from '../UnattendedPostureGate'
import { workflowAuthorityDigest } from '../WorkflowAuthorityDigest'
import { publishCliPathDirectories } from '../CliPathDirectoriesPublisher'
import {
  AppSettings,
  WorkspaceRecord,
  ChatRecord,
  ChatRun,
  ChatWorkflowMode,
  FanoutWorktreeCandidate,
  ChatListItem,
  ChatListRunSummary,
  PooledAgentStatsSummary,
  UsageRecord,
  PersistedAttachmentRef,
  ScheduledTask,
  ScheduledTaskAttachmentRef,
  RunQueueJob,
  RunQueueJobFilter,
  RunEventFilter,
  RunEventInput,
  RunEventKind,
  RunEventRecord,
  RunEventReplay,
  RunEventArtifactRef,
  ToolActivityDetailRef,
  HydratedToolActivityDetail,
  ApprovalLedgerFilter,
  ApprovalLedgerRecord,
  ApprovalLedgerRequestInput,
  AgentApprovalAction,
  ApprovalLedgerScope,
  MessageFeedbackReceipt,
  ProviderId,
  ChatKind,
  EnsembleConfig,
  EnsembleParticipant,
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
  RuntimeProfileSecretRefs,
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
  WORKSPACE_BOARD_CARD_LINK_KINDS,
  PinnedMessageGroup,
  EvidencePackRecord,
  CapabilityLedgerSnapshot,
  RepoConventionIndexSnapshot,
  AuditRunRecord,
  AuditFinding,
  AuditVerdict,
  AuditGateResult,
  AuditParticipant,
  ProductAuditBundleVerificationReceipt,
  AuditRetentionPurgeReceipt,
  AuditRetentionPurgeRequest,
  AuditRetentionPurgeResult,
  AuditRetentionSettings,
  AuditRetentionSurface,
  AuditRetentionSurfacePurgeCounts,
  IntrospectionRunRecord,
  IntrospectionScheduleRecord,
  IntrospectionScheduleSettings,
  MemoryProposalPack,
  MemoryProposal,
  SubThreadJoinPolicy,
  ToolActivity
} from './types'
import { canonicalizeExternalPathGrantMetadata } from './ExternalPathGrants'
import { pickWorkflowRunTemplateFields } from './WorkflowRunTemplate'
import {
  createProjectRegistry,
  type ProjectLegacyImportMarker,
  type ProjectLegacyImportResult,
  type ProjectRegistryMutationResult,
  type ProjectRegistryState
} from './ProjectRegistry'
import type {
  Project,
  ProjectGraphEdge,
  ProjectGraphEdgeOp,
  ProjectOp,
  ProjectReference,
  ProjectReferenceOp,
  ProjectWorkProfile
} from '../../shared/projects'
import { createDefaultEnsembleConfig, withMinimumEnsembleRoster } from '../EnsembleDefaults'
import { discardForeignEnsembleTurnTransition } from '../EnsembleRuntimeIdentity'
import { isEnsembleRoundDispatchLive } from '../../shared/ensembleRoundLifecycle'
import { isCursorGrokModelId, isGrokReasoningModelId } from '../../shared/grok45Models'
import { createHash, randomUUID } from 'crypto'
import {
  buildScheduledTaskDispatchReceipt,
  canonicalScheduledOccurrenceLedgerEvent,
  decodeScheduledOccurrenceMutationIntent,
  isTerminalScheduledTaskStatus,
  LEGACY_STORE_MUTATION_VALIDATION_POLICY,
  projectWorkflowFromScheduledTask,
  scheduledTaskStatusToWorkflowStatus,
  taskMatchesOccurrenceIdentity,
  validateScheduledOccurrenceMutationIntent,
  WORKFLOW_HISTORY_LIMIT,
  workflowExecutionMatchesIdentity,
  type ScheduledOccurrenceIdentity,
  type ScheduledOccurrenceLedgerPrefix,
  type ScheduledOccurrenceMutationIntent,
  type ScheduledOccurrenceMutationKind,
  type ScheduledOccurrenceTerminalStatus
} from '../ScheduledOccurrenceMutationSemantics'
import { DEFAULT_PROMPT_CACHE_SETTINGS, normalizePromptCacheSettings } from '../PromptCachePolicy'
import { normalizeProviderHarnessPostureMap } from '../../shared/providerHarnessPosture'
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
  filterRunEvents,
  RUN_EVENT_EMPTY_HASH,
  parseRunEventLine,
  safeRunEventFileName,
  serializeRunEventRecord
} from '../RunEventStore'
import {
  getRunEventReplayAsync as getRunEventReplayCachedAsync,
  getRunEventReplaySync as getRunEventReplayCachedSync
} from '../RunEventReplayCache'
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
  toolActivityStatsForRun,
  type AgentStatRecord
} from '../AgentStatsStore'
import {
  capMessageFeedbackReceipts,
  filterMessageFeedbackReceipts,
  normalizeMessageFeedbackReceipt,
  updateMessageFeedbackLedgerForChatSave,
  type MessageFeedbackReceiptFilter
} from '../MessageFeedbackLedger'
import { normalizeWorkflowLoopConfig } from '../WorkflowLoopModel'
import {
  normalizeEvidencePackRecord,
  normalizeRepoConventionIndexSnapshot,
  projectCapabilityLedgerFromEvidencePacks
} from '../EvidencePackModel'
import {
  findStaleAuditRuns,
  AUDIT_RESTART_INTERRUPTION_ERROR,
  type StaleAuditRun
} from '../audit/AuditReconciler'
import {
  normalizeIntrospectionRunRecord,
  normalizeMemoryProposalPack
} from '../introspection/IntrospectionModel'
import {
  getNextIntrospectionScheduleRunAtMs,
  mergeIntrospectionScheduleUpdate,
  normalizeIntrospectionScheduleRecord,
  scheduleWorkspaceKey,
  toIntrospectionScheduleSettings
} from '../introspection/IntrospectionScheduler'
import {
  capApprovalLedgerRecords,
  createApprovalLedgerRecord,
  expireScopedApprovalLedgerRecords,
  filterApprovalLedgerRecords,
  isLiveApprovalLedgerRecord,
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
  MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE,
  TOOL_DETAIL_EXTERNALIZATION_GENERATION,
  authoredMutationMentionsActivityIds,
  externalizeToolActivityDetails,
  substituteToolActivitiesInAuthoredMutation
} from './ChatToolDetailExternalization'
import {
  ToolActivityDetailBatchWriter,
  hydrateToolActivityDetails,
  readToolActivityDetailSync,
  type ToolActivityDetailCheckpoint
} from './ToolActivityDetailLedger'
import {
  persistThreadWorktreeBindingPatch,
  readThreadWorktreeBinding
} from './ThreadWorktreeBindingPersistence'
import {
  patchFanoutWorktreeCandidate as patchFanoutWorktreeCandidateRecord,
  readFanoutWorktreeCandidates,
  upsertFanoutWorktreeCandidatePatch
} from './FanoutCandidatePersistence'
import { persistWatchedPrPatch } from './WatchedPrPersistence'
import { persistChatGitWorkflowPatch } from './ChatGitWorkflowPersistence'
import { ChatComposerSelectionOverlayStore } from './ChatComposerSelectionOverlayPersistence'
import {
  applyChatComposerSelectionPatch,
  type ChatComposerSelectionPatchRequest
} from '../../shared/chatComposerSelectionPatch'
import { ChatListIndexStore } from './ChatListIndexStore'
import { collectOrphanSubThreadCandidates } from './OrphanSubThreadScan'
import { ChatListRebuildMemo } from './ChatListRebuildMemo'
import type { ThreadWorktreeBinding } from '../run/ThreadWorktreeBinding'
import type { WatchedPrDescriptor } from '../../shared/watchedPrNotify'
import type { ChatGitWorkflowInput } from '../../shared/chatGitWorkflow'
import {
  emptySubThreadMailbox,
  enqueueSubThreadMailboxEvent as enqueueMailboxEvent,
  normalizeSubThreadMailboxLedger,
  type SubThreadMailbox,
  type SubThreadMailboxEventInput,
  type SubThreadMailboxLedger
} from '../SubThreadMailbox'
import {
  emptyExecutionResultMailbox,
  enqueueExecutionResultMailboxEvent as enqueueExecutionResultEvent,
  normalizeExecutionResultMailboxLedger,
  type ExecutionResultMailbox,
  type ExecutionResultMailboxEventInput,
  type ExecutionResultMailboxLedger
} from '../ExecutionResultMailbox'
import { seatFromSoloChatRun } from '../ThreadMessageSeatCapture'
import {
  acknowledgeThreadMessagesInLedger,
  enqueueThreadMessageInLedger,
  normalizeThreadMessageLedger,
  pendingThreadMessageInboxes,
  purgeThreadMessageChats,
  residualThreadMessageChats,
  threadMessageInboxFor,
  type ThreadMessageDeliveryOutcome,
  type ThreadMessageLedger
} from '../ThreadMessageLedger'
import type { ThreadMessageEvent, ThreadMessageInbox } from '../../shared/threadMessage'
import {
  appendThreadMessageTranscriptProjection,
  mergeMissingThreadMessageTranscriptProjections
} from '../ThreadMessageTranscriptProjection'
import {
  isTerminalWorkflowExecutionStatus,
  nextLocalDayBoundaryIso,
  normalizeWorkflowTrigger,
  resolveNextWorkflowRunAt
} from '../workflows/WorkflowScheduler'
import {
  copyResolvedScheduledAttachments,
  isDurableScheduledAttachmentRef,
  rejectUnconfiguredScheduledAttachmentResolution,
  SCHEDULED_ATTACHMENT_RESELECT_REASON,
  type ResolveScheduledAttachments
} from '../ScheduledAttachmentDurability'
import { sanitizeProviderRunPauses } from '../ProviderRunPause'
import { consolidateAgenticWorkspaceGrants } from '../settings/MainSanitizers'
import {
  DEFAULT_STALL_BACKSTOP_MS,
  findStalledScheduledTasks,
  stallReason
} from '../WorkflowStallReconciler'
import {
  ExtensionSecretStore,
  type ExtensionSecretMutationResult,
  type ExtensionSecretOwnerKind,
  type ExtensionSecretRef,
  type ExtensionSecretResolution,
  type ExtensionSecretStatusSnapshot
} from '../ExtensionSecretStore'
import {
  migrateRuntimeProfilePlaintextSecrets,
  migrateUserMcpServerPlaintextSecrets
} from '../ExtensionSecretMigration'

function resetEnsembleParticipantSession(participant: EnsembleParticipant): EnsembleParticipant {
  const { taskWraithMcpProfileReceipt: _dropMcpProfileReceipt, ...restParticipant } = participant
  return {
    ...restParticipant,
    linkedProviderSessionId: null
  }
}

function cloneEnsembleForSideChat(parent: ChatRecord, provider: ProviderId) {
  const source = parent.ensemble || createDefaultEnsembleConfig(provider)
  return {
    ...source,
    participants: (source.participants || []).map((participant) => ({
      ...resetEnsembleParticipantSession(participant),
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

const storeRuntime = requireConfiguredHostStoreRuntime()
const userDataPath = storeRuntime.profilePath
const settingsPath = path.join(userDataPath, 'settings.json')
const workspacesPath = path.join(userDataPath, 'workspaces.json')
const projectsPath = path.join(userDataPath, 'projects.json')
const usagePath = path.join(userDataPath, 'usage.json')
const usageJournalPath = path.join(userDataPath, 'usage-journal.jsonl')
const usageArchivePath = path.join(userDataPath, 'usage-archive.jsonl')
const legacyStoreCanWrite = (): boolean => legacyStoreWriterGate.allowsCurrentWrite()

interface HostPersistRebaseState {
  base: ChatRecord
  desired: ChatRecord
}

const hostPersistRebaseByChatId = new Map<string, HostPersistRebaseState>()
const HOST_PERSIST_REVISION_CONFLICT_RETRY_LIMIT = 3
let hostPersistConflictRecoveryListener: ((chat: ChatRecord) => void) | null = null

function noteHostPersistIntent(base: ChatRecord | null, desired: ChatRecord): void {
  const existing = hostPersistRebaseByChatId.get(desired.appChatId)
  if (existing) {
    existing.desired = desired
    return
  }
  // A create has no ancestor, but the intent is still recorded: a conflict on
  // the create (the Host reports `Thread is not found` as a revision conflict)
  // must have the accumulated Desktop record to carry forward, or the chat is
  // stranded with nothing to rebase.
  hostPersistRebaseByChatId.set(desired.appChatId, { base: base ?? desired, desired })
}

function acknowledgeHostPersisted(input: HostThreadRecordPersistInput): void {
  const state = hostPersistRebaseByChatId.get(input.chatId)
  if (!state) return
  const persistedRevision = chatPersistenceRevision(input.record)
  if (persistedRevision >= chatPersistenceRevision(state.desired)) {
    hostPersistRebaseByChatId.delete(input.chatId)
    return
  }
  if (persistedRevision >= chatPersistenceRevision(state.base)) state.base = input.record
}

/**
 * Desktop -> Host `thread.record.persist` client. Since the Host cutover the
 * legacy writer gate is Host-owned, so `AppStore.saveChat` can no longer write
 * `chats/<id>.json` itself; it enqueues the record here instead and trust
 * boundaries await `AppStore.awaitChatRecordPersisted`. Constructed lazily so a
 * test can inject a fake port before the first save.
 */
let hostThreadRecordPersistPort: HostThreadRecordPersistPort | null = null
const hostThreadRecordPersist = (): HostThreadRecordPersistPort => {
  if (!hostThreadRecordPersistPort) {
    hostThreadRecordPersistPort = createDesktopHostThreadRecordPersistClient({
      userDataPath,
      appVersion: storeRuntime.appVersion || 'unknown',
      onPersisted: (input) => acknowledgeHostPersisted(input),
      recoverConflict: (input, error) => AppStore.recoverHostPersistConflict(input, error)
    })
  }
  return hostThreadRecordPersistPort
}

/**
 * One in-flight drain per chat, shared by every awaiter (the orchestrator's
 * pre-dispatch gate and the IPC call-site barrier must observe the SAME
 * outcome; two independent drains would race to consume the lane's first
 * error). The memo entry is dropped as soon as the drain settles.
 */
const chatRecordPersistBarriers = new Map<string, Promise<void>>()
const chatRecordConflictRecoveryBarriers = new Map<string, Promise<void>>()

/**
 * Chats with Host-queue persistence work not yet confirmed durable. The
 * shutdown drain reports this count when it cannot finish, so a quit-time
 * loss is named rather than silent.
 */
const hostPersistUnconfirmedChatIds = new Set<string>()

/**
 * Chats whose dirty cache entry came from the Host-routed save branch. The
 * legacy coalescer dirty marker is transient by construction (the deferred
 * write re-anchors the stat when it lands); the Host branch has no such
 * callback, so readChatRecordCached reconciles these ids against the real
 * file instead of serving the shadow forever. That keeps Host-side writes —
 * solo run lifecycle, thread.configure — visible to desktop reads and keeps
 * the next save's expectedRevision honest (no revision-conflict loop).
 */
const hostPersistShadowChatIds = new Set<string>()

const barrierChatRecordPersist = (chatId: string): Promise<void> => {
  const existing = chatRecordPersistBarriers.get(chatId)
  if (existing) return existing
  const barrier = hostThreadRecordPersist()
    .drain(chatId)
    .then(() => {
      hostPersistUnconfirmedChatIds.delete(chatId)
    })
    .finally(() => {
      if (chatRecordPersistBarriers.get(chatId) === barrier) {
        chatRecordPersistBarriers.delete(chatId)
      }
    })
  chatRecordPersistBarriers.set(chatId, barrier)
  return barrier
}

/**
 * Explicit upper bound for the shutdown Host-queue drain. Quit is one of the
 * few places where blocking on durability is correct, but a hung or
 * unreachable Host must not hold the process open forever: when the bound
 * expires the still-queued records are abandoned at process exit (lost), and
 * that outcome is logged with the unconfirmed chat count.
 */
const HOST_PERSIST_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000

/**
 * Structural view of the client's erasure capability (thread.record.delete).
 * The contract is agreed with the client slice: delete supersedes any queued
 * persist for the chat before issuing, and a missing record is an idempotent
 * success. Accessed structurally so this file compiles while the capability
 * lands; the guard fails loudly if a build ever wires one without the other.
 */
type HostThreadRecordErasurePort = {
  deleteRecord(input: { chatId: string; expectedRevision: number }): Promise<void>
}

const hostThreadRecordErasure = (): HostThreadRecordErasurePort => {
  const client: unknown = hostThreadRecordPersist()
  const deleteRecord = (client as Partial<HostThreadRecordErasurePort>).deleteRecord
  if (typeof deleteRecord !== 'function') {
    throw new Error('Host thread-record erasure is unavailable in this build.')
  }
  return { deleteRecord: (input) => deleteRecord.call(client, input) }
}

/**
 * Desktop -> Host workspace-record client (workspaces.json — the second file
 * the cutover moved). Constructed lazily so a test can inject a fake port
 * before the first ViaHost call.
 */
let hostWorkspaceRecordPort: HostWorkspaceRecordPort | null = null
const hostWorkspaceRecord = (): HostWorkspaceRecordPort => {
  if (!hostWorkspaceRecordPort) {
    hostWorkspaceRecordPort = createDesktopHostWorkspaceRecordClient({
      userDataPath,
      appVersion: storeRuntime.appVersion || 'unknown'
    })
  }
  return hostWorkspaceRecordPort
}

async function drainHostRecordPersistQueueOnShutdown(timeoutMs?: number): Promise<void> {
  const bound =
    Number.isSafeInteger(timeoutMs) && (timeoutMs as number) > 0
      ? (timeoutMs as number)
      : HOST_PERSIST_SHUTDOWN_DRAIN_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  // The drain promise always settles through its own handlers, so a late
  // settlement after a lost race can never surface as an unhandled rejection
  // while the process is trying to exit.
  let drainFailure: unknown
  const drain = hostThreadRecordPersist()
    .drainAll()
    .then(
      () => 'drained' as const,
      (error: unknown) => {
        drainFailure = error
        return 'failed' as const
      }
    )
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), bound)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([drain, timeout])
    if (outcome === 'drained') {
      hostPersistUnconfirmedChatIds.clear()
      return
    }    console.error(
      `[persist] Host chat persistence did not fully drain before shutdown ` +
        `(${outcome}); ${hostPersistUnconfirmedChatIds.size} chat(s) may have transcript ` +
        `that was not persisted:`,
      outcome === 'failed' ? drainFailure : new Error(`drain exceeded ${bound} ms`)
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const usageJournalStore = new UsageJournalStore({
  checkpointPath: usagePath,
  journalPath: usageJournalPath,
  archivePath: usageArchivePath
})

/** Main-owned Project registry (Work surface). Constructed against the
 * hardened readJson/writeJson pair below (function declarations, so hoisting
 * makes them safe to reference here); record logic lives in shared/projects. */
const projectRegistry = createProjectRegistry({
  filePath: projectsPath,
  readJson: (filePath, defaultData) => readJson(filePath, defaultData),
  writeJson: (filePath, data) => writeJson(filePath, data)
})

// getSettings() used to re-read + re-parse + re-normalize settings.json on
// EVERY call — ~214 call sites across the main process, including per-tool-
// call permission/network gates, i.e. death by frequency. The cache is
// validated by mtime+size (one statSync instead of read+parse), so external
// writers (a second TaskWraith instance) still invalidate it; every
// in-process writer funnels through writeJson(settingsPath), which
// invalidates explicitly, keeping same-tick write-then-read correct
// regardless of filesystem mtime granularity.
//
// SHARED-REFERENCE CONTRACT: callers must never mutate the returned object.
// Audited 2026-07-10: all call sites are read-only (spread-before-merge
// discipline throughout). New code must copy before mutating.
let settingsFileCache: { value: AppSettings; mtimeMs: number; size: number } | null = null

function invalidateSettingsFileCache(): void {
  settingsFileCache = null
}

function statSettingsFile(): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(settingsPath)
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}
const providerUsageSnapshotsPath = path.join(userDataPath, 'provider-usage-snapshots.json')
const scheduledTasksPath = path.join(userDataPath, 'scheduled-tasks.json')
const workflowsPath = path.join(userDataPath, 'workflows.json')
const scheduledOccurrenceMutationsPath = path.join(
  userDataPath,
  'scheduled-occurrence-mutation.json'
)
const scheduledRunIdTombstonesPath = path.join(userDataPath, 'scheduled-run-id-tombstones.jsonl')
type ScheduledRunIdTombstoneKind = 'root' | 'loop-child' | 'ensemble-child'
interface ScheduledRunIdTombstoneRecord {
  schemaVersion: 1
  sequence: number
  runId: string
  rootRunId: string
  taskId: string
  kind: ScheduledRunIdTombstoneKind
  recordedAt: string
  prevHash: string | null
  hash: string
}
const SCHEDULED_RUN_ID_TOMBSTONE_MAX_BYTES = 128 * 1024 * 1024
const SCHEDULED_RUN_ID_TOMBSTONE_MAX_RECORDS = 500_000
const SCHEDULED_RUN_ID_TOMBSTONE_MAX_LINE_BYTES = 4 * 1024
const SCHEDULED_RUN_ID_TOMBSTONE_MAX_ID_CHARS = 512
let scheduledRunIdTombstoneCache: {
  dev: number
  ino: number
  ctimeMs: number
  mtimeMs: number
  size: number
  lastSequence: number
  lastHash: string | null
  records: Map<string, ScheduledRunIdTombstoneRecord>
} | null = null
const workspaceBoardsPath = path.join(userDataPath, 'workspace-boards.json')
const workspaceBoardCardsPath = path.join(userDataPath, 'workspace-board-cards.json')
const missionFactsPath = path.join(userDataPath, 'mission-facts')
const missionFactRepository = new MissionFactLedgerRepository({ rootPath: missionFactsPath })
const missionFactShadowService = new MissionFactShadowService(missionFactRepository)
const evidencePacksPath = path.join(userDataPath, 'evidence-packs.json')
const repoConventionIndexesPath = path.join(userDataPath, 'repo-convention-indexes.json')
const runQueuePath = path.join(userDataPath, 'run-queue.json')
// Single choke point for run-queue writes: bounds retained terminal history
// (capRunQueueJobs) so the full synchronous rewrite stays small. In-flight jobs
// are always kept — see capRunQueueJobs.
const writeRunQueueJobs = (jobs: RunQueueJob[]): void =>
  writeJson(runQueuePath, sortRunQueueJobs(capRunQueueJobs(jobs)))
const runRecoveryPath = path.join(userDataPath, 'run-recovery.json')
const workspaceChangesPath = path.join(userDataPath, 'workspace-changes.json')
const approvalLedgerPath = path.join(userDataPath, 'approval-ledger.json')
const messageFeedbackLedgerPath = path.join(userDataPath, 'thumbs-ledger.json')
const auditBundleVerificationReceiptsPath = path.join(
  userDataPath,
  'audit-bundle-verifications.json'
)
const auditRetentionPurgesPath = path.join(userDataPath, 'audit-retention-purges.json')
// Single choke point for approval-ledger writes: cap retained non-live history
// (capApprovalLedgerRecords) so the full synchronous rewrite on every approval
// event stays bounded. Live records (pending + active session/workspace grants)
// are always kept.
const writeApprovalLedger = (records: ApprovalLedgerRecord[]): void =>
  writeJson(approvalLedgerPath, capApprovalLedgerRecords(records))
const writeMessageFeedbackLedger = (records: MessageFeedbackReceipt[]): void =>
  writeJson(messageFeedbackLedgerPath, capMessageFeedbackReceipts(records))
const writeAuditBundleVerificationReceipts = (
  records: ProductAuditBundleVerificationReceipt[]
): void =>
  writeJson(auditBundleVerificationReceiptsPath, capAuditBundleVerificationReceipts(records))
const writeAuditRetentionPurgeReceipts = (records: AuditRetentionPurgeReceipt[]): void =>
  writeJson(auditRetentionPurgesPath, capAuditRetentionPurgeReceipts(records))
const productCrashesPath = path.join(userDataPath, 'product-crashes.json')
const runtimeProfilesPath = path.join(userDataPath, 'runtime-profiles.json')
const handoffCardsPath = path.join(userDataPath, 'handoff-cards.json')
const legacySettingsMigrationPath = path.join(userDataPath, 'legacy-settings-migration.json')
const legacyUserDataDirs = ['TaskWraith'].map((dirName) =>
  path.join(path.dirname(userDataPath), dirName)
)
const chatsDir = path.join(userDataPath, 'chats')
const chatComposerSelectionOverlayStore = new ChatComposerSelectionOverlayStore(chatsDir)
const chatListIndexPath = path.join(userDataPath, 'chat-list-index.jsonl')
const chatJournalDir = path.join(userDataPath, 'chat-journal')
const incrementalChatJournalDir = path.join(userDataPath, 'chat-journal-v2')
const chatListIndexStore = new ChatListIndexStore(userDataPath, { canWrite: legacyStoreCanWrite })
/** Rows already derived from the exact bytes on disk, so a chat whose index
 *  entry cannot be restamped is parsed once per process rather than once per
 *  getChatList call. See ChatListRebuildMemo for why the restamp can stall. */
const chatListRebuildMemo = new ChatListRebuildMemo<ChatListItem>()
/**
 * T3a-1: per-chat save coalescer.
 *
 * WINDOW SIZING IS MEASURED, NOT GUESSED. The T2 baseline recorded the hot
 * chat being rewritten 8-14 times per 10 s window — one save every 714-1250
 * ms. A trailing-edge debounce only merges saves that arrive INSIDE its
 * window, so the original 100 ms default expired 600-1150 ms before each
 * successor arrived: it coalesced essentially nothing and would have reported
 * a near-zero delta on the comparison run, inviting the false conclusion that
 * coalescing does not work.
 *
 * 1000 ms sits at the dense end of the measured cadence, so sustained
 * streaming keeps re-arming the trailing timer; the 3x ceiling
 * (DEFAULT_MAX_LATENCY_MULTIPLIER) then governs and forces a durable write
 * every 3 s. Expected effect during streaming: ~14 writes/10 s collapses to
 * ~3.3 (~4x), and 8 writes/10 s to ~3.3 (~2.4x).
 *
 * This window is only SAFE because the ceiling exists: without it the trailing
 * timer would re-arm forever and a continuously streaming chat would never
 * become durable. The ceiling also bounds the crash-loss window to 3 s of
 * actively-streaming transcript — and only for chats with a running run, since
 * every other save is a 'terminal' barrier that writes through synchronously.
 *
 * Env override retained: TASKWRAITH_SAVE_COALESCE_MS — 0 flushes on the next
 * tick, negative disables coalescing entirely (exactly the pre-T3a-1
 * behaviour). TASKWRAITH_SAVE_COALESCE_MAX_MS overrides the ceiling.
 */
const SAVE_COALESCE_DEFAULT_MS = 1000
const saveCoalesceMs = (() => {
  const raw = process.env.TASKWRAITH_SAVE_COALESCE_MS
  if (raw === undefined) return SAVE_COALESCE_DEFAULT_MS
  const n = Number(raw)
  return Number.isFinite(n) ? n : SAVE_COALESCE_DEFAULT_MS
})()
const saveCoalesceMaxMs = (() => {
  const raw = process.env.TASKWRAITH_SAVE_COALESCE_MAX_MS
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
})()
const saveCoalescer =
  saveCoalesceMaxMs === undefined
    ? createSaveCoalescer(saveCoalesceMs)
    : createSaveCoalescer(saveCoalesceMs, saveCoalesceMaxMs)

/**
 * T4a compatibility journal. V2 mutation replay now owns normal streaming
 * saves; `chats/{id}.json` and this legacy journal materialize initial and
 * barrier checkpoints (plus synchronous fallback when a V2 append fails).
 *
 * BYTE HONESTY: `append` writes the WHOLE record per save, so dual-write
 * roughly DOUBLES bytes-per-save rather than reducing them. That is expected
 * and Boss-accepted for this tranche: the journal's value is that it makes
 * incremental (delta) writes possible in T5, at which point the legacy
 * whole-file write is what disappears. Anyone reading the comparison report
 * must expect chat-journal bytes to ADD to chat bytes here, not replace them.
 */
const chatJournal = createChatJournal(chatJournalDir, { canWrite: legacyStoreCanWrite })
const incrementalChatPersistence = createIncrementalChatPersistence({
  journal: createIncrementalChatJournal(incrementalChatJournalDir, {
    canWrite: legacyStoreCanWrite
  }),
  canWrite: legacyStoreCanWrite
})
const chatUpdateProjectionTracker = new ChatUpdateProjectionTracker()
const incrementalChatIdleCheckpointTimer = setInterval(() => {
  if (!legacyStoreCanWrite()) return
  try {
    incrementalChatPersistence.checkpointIdle()
  } catch (error) {
    console.error('[incremental-chat] idle checkpoint timer failed', error)
  }
}, 5_000)
incrementalChatIdleCheckpointTimer.unref()

/**
 * T9a: install the harness-gated perf sampling handle. Wired here rather than
 * in `src/main/index.ts` because this is where the counters live, and because
 * a one-line call in the 2 MB main entrypoint would be wiring for wiring's
 * sake. No-ops entirely unless PERF_PRELOAD_PROBE=1, so production launches
 * assign nothing and the global does not exist.
 */
installPerfStatsHandle(() => ({
  sampledAt: Date.now(),
  coalescing: {
    coalescer: saveCoalescer.stats(),
    journal: chatJournal.stats(),
    config: { coalesceMs: saveCoalesceMs, maxLatencyMs: saveCoalesceMaxMs ?? null }
  },
  probes: snapshotPersistenceProbes()
}))

/**
 * T4c — decide whether this save may be deferred, and record WHY.
 *
 * Every name used here was verified against the live type definitions rather
 * than assumed. Two candidate signals were checked and REJECTED as fabrication:
 * `RunStatus` has no approval member (it is
 * success|success_with_warnings|failed|cancelled|running|sleeping), and
 * `waiting_for_input` does not exist anywhere in the source.
 *
 * The real approval signal is `ConcurrentLaneStatus.'awaiting-approval'` plus
 * `ConcurrentLane.approvalsQueued`, reachable at
 * `chat.ensemble.activeRound.lanes`. KNOWN LIMIT: lanes are only populated for
 * concurrent-mode rounds, so a serial-dispatch approval has no chat-record
 * signal. That is acceptable rather than a hole — approval DECISIONS are
 * durable in their own `approval-ledger.json`, written synchronously and never
 * routed through this coalescer. What this barrier protects is the transcript
 * rendering of an open approval, which would otherwise sit in a pending timer.
 *
 * NARROWED (item 5): the approval barrier fires on the save that OPENS or
 * CHANGES an open approval, not on every save for as long as one stays open.
 * It used to re-fsync the whole chat record on every save while a human sat
 * looking at the dialog — during fan-out that is the amplification this epic
 * exists to remove, and it bought nothing, because prompt rendering never came
 * from the chat file:
 *   - the renderer is pushed `agent-approval-request` directly, and remote
 *     devices get the APNs attention fanout; neither reads the record;
 *   - in-process readers cannot be stale anyway, because `saveChat` stamps
 *     `chatRecordCache` with the `mtimeMs: -1` dirty marker BEFORE scheduling
 *     and `readChatRecordCached` returns a dirty entry without stat-ing;
 *   - the decision itself is already durable in `approval-ledger.json`.
 * What remains is the transition, which is the thing a reader must not miss.
 */
const openApprovalSignatureByChatId = new Map<string, string>()

/** Stable description of every open approval on a chat; '' when there are none.
 *  Compared against the previous save to detect a transition. */
function describeOpenApprovals(chat: ChatRecord): string {
  const lanes = chat.ensemble?.activeRound?.lanes
  if (!lanes) return ''
  const open: string[] = []
  for (const [laneId, lane] of Object.entries(lanes)) {
    const queued = lane.approvalsQueued ?? 0
    if (lane.status === 'awaiting-approval' || queued > 0) {
      open.push(`${laneId}:${lane.status}:${queued}`)
    }
  }
  return open.sort().join('|')
}

function deriveSaveFlushReason(chat: ChatRecord): FlushReason {
  // A chat whose history is being destroyed must never sit in a timer: the
  // deletion transaction is running concurrently with this save. Checked
  // first, and deliberately never narrowed (NON-NEGOTIABLE #4).
  if (deletedChatIds.has(chat.appChatId)) {
    openApprovalSignatureByChatId.delete(chat.appChatId)
    return 'history-deletion'
  }

  const openApprovals = describeOpenApprovals(chat)
  if (openApprovals) {
    if (openApprovalSignatureByChatId.get(chat.appChatId) !== openApprovals) {
      openApprovalSignatureByChatId.set(chat.appChatId, openApprovals)
      return 'approval'
    }
  } else {
    // Cleared as soon as the last approval closes, so a later one re-arms the
    // barrier instead of being mistaken for the one already rendered.
    openApprovalSignatureByChatId.delete(chat.appChatId)
  }

  // Deferral is only safe while a run is actively streaming: that is both
  // where the measured 8-14 rewrites per 10 s come from, and the only window
  // in which a superseding save is guaranteed to follow. Once no run is
  // running the chat sits at a terminal/idle boundary, so the next reader —
  // bridge broadcast, iOS, crash recovery — must find it on disk.
  return (chat.runs ?? []).some((run) => run.status === 'running') ? 'normal' : 'terminal'
}

/**
 * Remove every journal artifact for a deleted chat, including the tombstone.
 *
 * `chatJournal.delete` deliberately leaves a `{chatId}.tombstone` marker so a
 * concurrent append cannot recreate the files. That marker is named after the
 * chat, so leaving it behind would make a deleted chat's id survive on disk —
 * something the legacy chat path never does, and a history-deletion
 * regression this wiring would otherwise introduce (NON-NEGOTIABLE #4).
 *
 * Dropping the marker is safe here specifically because deletion already
 * called `saveCoalescer.discard(chatId)`, so no pending timer write remains,
 * and `deletedChatIds` blocks re-saves. The journal keeps its in-process
 * tombstoned state either way.
 */
/**
 * Item 6 seam — move the durable chat write off the main thread.
 *
 * `writeJson` is a synchronous open/write/fsync/rename/dir-fsync sequence on
 * the Electron main process. Items 1-5 cut how OFTEN it runs; they did not
 * change WHERE it runs, and a V8 CPU profile cannot see fsync wait at all.
 *
 * Deliberately dark: the worker is only used when `TASKWRAITH_UTILITY_WRITE=1`
 * AND a writer has been registered. Nothing imports the worker from here — the
 * composition root registers it — so this file gains no worker dependency and
 * an absent/failed worker simply leaves the synchronous path in place.
 *
 * WHAT MAY GO ASYNC, AND WHY ONLY THAT:
 * Only `normal` saves — the deferred streaming/fan-out writes that are the
 * whole cost. Every barrier reason (`terminal`, `approval`, `history-deletion`,
 * `shutdown`) keeps writing synchronously on main, because `saveChat` returns a
 * record rather than a promise: there is no way to make callers wait for a
 * worker ACK without changing every call site. A barrier that resolved before
 * its fsync would be a durability lie, and slow-and-correct beats fast-and-lossy.
 *
 * ORDERING (the invariant that makes this safe or silently corrupts chats):
 * The queue drains strictly one job at a time and never reorders, so anything
 * routed through it is safe. The hazard is MIXING paths: a synchronous write on
 * main can overtake a job already sitting in the queue for the same chat, and an
 * out-of-order whole-file write is silent history loss. So:
 *  - Barrier with nothing outstanding for that chat -> write synchronously on
 *    main. Durable before return, and no queued job exists to overtake.
 *  - Barrier WITH something outstanding -> hand it to the queue instead, so it
 *    lands after the job already there. Durability slips by the ACK round-trip;
 *    that is a bounded crash window, whereas reordering is permanent loss. When
 *    the two invariants genuinely conflict, ordering wins.
 *    (A synchronous flush-by-chat on the queue would let this case keep both.
 *    That API belongs to PersistenceWriteWorker, not here.)
 *  - After such a barrier the chat is pinned to main, so the mixed state cannot
 *    recur for it.
 *
 * FAILURE IS NOT HANDLED HERE, DELIBERATELY. The queue performs leftover writes
 * itself, synchronously and in FIFO order, on crash / ACK timeout / saturation.
 * A local `catch -> writeJson` here would be exactly the N-independent-fallbacks
 * race its header warns about, so a rejection is logged and nothing more.
 */
export interface PersistenceWriteRequest {
  chatId: string
  /** Destination of the atomic write. */
  filePath: string
  /** The record. PersistenceWriteWorker serializes it exactly once, inside
   *  enqueueWrite, and the worker and its own sync fallback share one
   *  `writeSerializedDurably` so the bytes cannot drift. */
  data: unknown
  /** Diagnostics only — deliberately NOT a coalescing key. See the queue's
   *  header: dropping a superseded write is only safe if the survivor is
   *  provably newer, and revision is not monotonic across every caller. */
  revision?: number
}

/** Resolves only once the bytes are durable (fsync + rename completed). */
export type PersistenceWriteEnqueue = (request: PersistenceWriteRequest) => Promise<void>

let persistenceWriteEnqueue: PersistenceWriteEnqueue | null = null

/** Composition-root wiring for the item-6 utility writer. Passing null restores
 *  the synchronous path (used when the worker dies and cannot be restarted). */
export function registerPersistenceWriteEnqueue(enqueue: PersistenceWriteEnqueue | null): void {
  persistenceWriteEnqueue = enqueue
}

/** Bound on outstanding async writes. An unbounded queue in front of fsync is
 *  precisely how this layer previously produced a 44 GB artifact; saturation
 *  falls back to writing on main rather than buffering. */
const MAX_OUTSTANDING_UTILITY_WRITES = 32
const outstandingUtilityWriteChatIds = new Set<string>()
/** Chats forced back to the synchronous path — see ORDERING above. */
const utilityWritePinnedToMainChatIds = new Set<string>()

function utilityWriteEnabled(): boolean {
  return process.env.TASKWRAITH_UTILITY_WRITE === '1'
}

/** The writer for this save, or null when it must run synchronously on main. */
function utilityWriteEnqueueFor(
  chatId: string,
  reason: FlushReason
): PersistenceWriteEnqueue | null {
  if (!utilityWriteEnabled() || !persistenceWriteEnqueue) return null
  if (reason !== 'normal') {
    // Barrier. Writing on main is only safe while nothing is queued for this
    // chat; otherwise the queued job would land afterwards and revert it.
    if (!outstandingUtilityWriteChatIds.has(chatId)) return null
    utilityWritePinnedToMainChatIds.add(chatId)
    return persistenceWriteEnqueue
  }
  if (utilityWritePinnedToMainChatIds.has(chatId)) return null
  if (outstandingUtilityWriteChatIds.size >= MAX_OUTSTANDING_UTILITY_WRITES) return null
  return persistenceWriteEnqueue
}

/** Test-only reset for the item-6 seam. */
export function resetPersistenceWriteSeamForTests(): void {
  persistenceWriteEnqueue = null
  outstandingUtilityWriteChatIds.clear()
  utilityWritePinnedToMainChatIds.clear()
}

function purgeChatJournalArtifacts(chatId: string): void {
  return runLegacyStoreWriteAdmission(
    { operation: 'purge-chat-journal', pathFamily: 'chats' },
    () => purgeChatJournalArtifactsAdmitted(chatId)
  )
}

function purgeChatJournalArtifactsAdmitted(chatId: string): void {
  // V2 is a second durable history source. Unlike the legacy best-effort
  // cleanup below, failure must stop the deletion transaction so transcript
  // mutations cannot survive a reported successful delete.
  incrementalChatPersistence.purge(chatId)
  chatUpdateProjectionTracker.drop(chatId)
  try {
    chatJournal.delete(chatId)
  } catch (e) {
    console.error('Failed to tombstone chat journal', chatId, e)
  }
  const journalDir = path.join(userDataPath, 'chat-journal')
  for (const suffix of ['.tombstone', '.jsonl', '.snapshot.json']) {
    try {
      fs.rmSync(path.join(journalDir, `${chatId}${suffix}`), { force: true })
    } catch (e) {
      console.error('Failed to remove chat journal artifact', chatId, suffix, e)
    }
  }
}

/**
 * Append one save to the journal. Never throws: the journal is side-band, so
 * a journal fault must degrade to "legacy-only persistence", never to a lost
 * or failed chat save. Bytes are attributed to the `chat-journal` probe class
 * using the journal's own accounting, so legacy and journal bytes stay
 * separable on the comparison report.
 */
function appendChatJournalEntry(chatId: string, record: ChatRecord): void {
  return runLegacyStoreWriteAdmission(
    { operation: 'append-chat-journal', pathFamily: 'chats' },
    () => appendChatJournalEntryAdmitted(chatId, record)
  )
}

function appendChatJournalEntryAdmitted(chatId: string, record: ChatRecord): void {
  const probing = isPersistenceProbeEnabled()
  const before = probing ? chatJournal.stats().bytesWritten : 0
  const startedAt = probing ? Date.now() : 0
  try {
    chatJournal.append(chatId, record)
  } catch (e) {
    console.error('Chat journal append failed; legacy chat file remains authoritative', e)
    return
  }
  if (!probing) return
  recordPersistenceWrite({
    target: 'chat-journal',
    bytes: Math.max(0, chatJournal.stats().bytesWritten - before),
    // The journal owns its own syscall sequence, so only the wall time of the
    // whole append is attributable here. Splitting it further would mean
    // inventing phase numbers this call site cannot observe.
    serializeMs: 0,
    writeMs: 0,
    fsyncMs: 0,
    renameMs: 0,
    totalMs: Math.max(0, Date.now() - startedAt)
  })
}

function incrementalPersistenceBoundary(reason: FlushReason): IncrementalChatPersistenceBoundary {
  if (reason === 'normal') return 'normal'
  if (reason === 'approval') return 'approval'
  return 'terminal'
}

/**
 * V2 dual-write seam. Mutation append is independently fsynced and may lead
 * the still-authoritative legacy file during its bounded coalescing window.
 * Any V2 failure leaves the existing legacy write path untouched; parity is
 * proven at the first baseline and every approval/terminal boundary before
 * the legacy hot rewrite is eligible for removal.
 */
function persistIncrementalChat(
  previous: ChatRecord | null,
  next: ChatRecord,
  reason: FlushReason,
  authoredTranscript?: AuthoredChatTranscriptMutation
): IncrementalChatPersistResult | null {
  return runLegacyStoreWriteAdmission(
    { operation: 'persist-incremental-chat', pathFamily: 'chats' },
    () => persistIncrementalChatAdmitted(previous, next, reason, authoredTranscript)
  )
}

function persistIncrementalChatAdmitted(
  previous: ChatRecord | null,
  next: ChatRecord,
  reason: FlushReason,
  authoredTranscript?: AuthoredChatTranscriptMutation
): IncrementalChatPersistResult | null {
  try {
    return incrementalChatPersistence.persist(
      previous,
      next,
      incrementalPersistenceBoundary(reason),
      authoredTranscript
    )
  } catch {
    // Coordinator already records and logs the failure. The caller must take
    // the synchronous compatibility-checkpoint fallback for this exact save.
    return null
  }
}
const subThreadMailboxesPath = path.join(userDataPath, 'subthread-mailboxes.json')
const executionResultMailboxesPath = path.join(userDataPath, 'execution-result-mailboxes.json')
const threadMessagesPath = path.join(userDataPath, 'thread-messages.json')
// Volatile chat-list-entry churn (search preview, message/diff counters,
// per-run stats, source stat) lands on disk at most this often per chat. It
// was 2s, but the counters sat in the STABLE half of the write gate's diff, so
// a streaming task bypassed the window entirely and appended a ~160KB line
// every ~3s — chat-list-index.jsonl grew 17→66MB in ~40min (2026-08-18 live
// watch). Counters are volatile now, and 15s keeps the DISK cadence lazy while
// the list stays live: getChatList rebuilds a stale row before serving it.
const CHAT_LIST_INDEX_VOLATILE_REFRESH_INTERVAL_MS = 15_000
const auditRunsPath = path.join(userDataPath, 'audit-runs.json')
const introspectionRunsPath = path.join(userDataPath, 'introspection-runs.json')
const memoryProposalPacksPath = path.join(userDataPath, 'memory-proposal-packs.json')
const introspectionSchedulePath = path.join(userDataPath, 'introspection-schedule.json')
const runEventsDir = path.join(userDataPath, 'run-events')
const runArtifactsDir = path.join(userDataPath, 'run-artifacts')
const historyDeletionIntentPath = path.join(userDataPath, 'history-deletion-intent.json')
const runEventSequenceCache = new Map<string, number>()
const runEventHashCache = new Map<string, string>()
// Stage 1 — durable per-execution workflow run ledger (one .jsonl per
// workflowExecutionId, append-only; the run-events model). Single writer per file.
const workflowRunsDir = path.join(userDataPath, 'workflow-runs')
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
const historyDeletionFailureStepsForTests = new Set<HistoryDeletionStep>()

export type HistoryDeletionKind = 'global' | 'workspace' | 'chat' | 'truncate'
export type HistoryDeletionQuiescenceKind =
  | 'maintenance-compaction'
  | 'provider-run'
  | 'canvas'
  | 'execution-graph'
  | 'channels'
  | 'usage'
  | 'project-reference'
  | 'media'
  | 'bridge'

export interface HistoryDeletionQuiescenceTarget {
  /** Main-minted stable id, unique within one deletion intent. */
  id: string
  kind: HistoryDeletionQuiescenceKind
  runId?: string
  /** Process-local detached maintenance reservation. Absent on the scope
   * barrier target that also captures the discovery-to-prepare window. */
  maintenanceCompactionId?: string
  provider?: ProviderId
  chatId?: string
  workspaceId?: string
}

export interface HistoryDeletionPreparation {
  operationId: string
  kind: HistoryDeletionKind
  workspaceId?: string
  rootChatId?: string
  chatIds: string[]
  runIds: string[]
  quiescenceTargets: HistoryDeletionQuiescenceTarget[]
  completedQuiescenceTargetIds: string[]
}

export interface HistoryDeletionScopePreview {
  kind: HistoryDeletionKind
  workspaceId?: string
  rootChatId?: string
  chatIds: string[]
  runIds: string[]
}

export type HistoryDeletionPrepareInput = {
  kind: HistoryDeletionKind
  workspaceId?: string
  rootChatId?: string
  quiescenceTargets?: HistoryDeletionQuiescenceTarget[]
}
type HistoryDeletionStep =
  | 'scheduled-orchestration'
  | 'workflow-run-history'
  | 'run-queue'
  | 'run-recovery'
  | 'approval-ledger'
  | 'message-feedback'
  | 'sub-thread-mailboxes'
  | 'thread-messages'
  | 'mission-facts'
  | 'run-events'
  | 'run-artifacts'
  | 'kimi-seat-state'
  | 'chat-records'
  | 'chat-list-index'
  | 'project-membership'

const HISTORY_DELETION_STEPS: readonly HistoryDeletionStep[] = [
  // Resurrection sources are retired before the visible transcript commit.
  'scheduled-orchestration',
  'workflow-run-history',
  'run-queue',
  'run-recovery',
  'approval-ledger',
  'message-feedback',
  'sub-thread-mailboxes',
  // A queued peer message is a resurrection source: it would enter a live thread's
  // context after the chat that sent it was erased.
  'thread-messages',
  'mission-facts',
  'run-events',
  'run-artifacts',
  'kimi-seat-state',
  'chat-records',
  'chat-list-index',
  'project-membership'
]

interface HistoryDeletionIntent {
  schemaVersion: 1
  operationId: string
  kind: HistoryDeletionKind
  createdAt: string
  updatedAt: string
  workspaceId?: string
  rootChatId?: string
  chatIds: string[]
  runIds: string[]
  missionFactIds: string[]
  scheduledTaskIds: string[]
  retainedScheduledTaskIds: string[]
  workflowIds: string[]
  workflowExecutionIds: string[]
  kimiSeats: Array<{ chatId: string; participantId: string }>
  quiescenceTargets: HistoryDeletionQuiescenceTarget[]
  completedQuiescenceTargetIds: string[]
  completedSteps: HistoryDeletionStep[]
  failures: Array<{ step: HistoryDeletionStep | 'journal'; message: string }>
}

export class HistoryDeletionIncompleteError extends Error {
  readonly operationId: string
  readonly failures: ReadonlyArray<{ step: HistoryDeletionStep | 'journal'; message: string }>

  constructor(
    operationId: string,
    failures: ReadonlyArray<{ step: HistoryDeletionStep | 'journal'; message: string }>
  ) {
    super(
      `History deletion ${operationId} is incomplete (${failures
        .map((failure) => failure.step)
        .join(', ')}). The durable deletion intent was retained for retry.`
    )
    this.name = 'HistoryDeletionIncompleteError'
    this.operationId = operationId
    this.failures = [...failures]
  }
}

export class HistoryDeletionQuiescenceRequiredError extends Error {
  readonly operationId: string
  readonly pendingTargetIds: string[]

  constructor(operationId: string, pendingTargetIds: string[]) {
    super(
      `History deletion ${operationId} cannot commit until ${pendingTargetIds.length} quiescence target(s) complete.`
    )
    this.name = 'HistoryDeletionQuiescenceRequiredError'
    this.operationId = operationId
    this.pendingTargetIds = [...pendingTargetIds]
  }
}

export class HistoryDeletionMutationBlockedError extends Error {
  readonly operationId: string
  readonly kind: HistoryDeletionKind

  constructor(operationId: string, kind: HistoryDeletionKind, operation: string) {
    super(
      `${operation} is blocked while history deletion ${operationId} (${kind}) is pending. Retry after the deletion finishes.`
    )
    this.name = 'HistoryDeletionMutationBlockedError'
    this.operationId = operationId
    this.kind = kind
  }
}

export interface HistoryMutationAdmissionInput {
  operation: string
  chatIds?: ReadonlyArray<string | null | undefined>
  workspaceIds?: ReadonlyArray<string | null | undefined>
  runIds?: ReadonlyArray<string | null | undefined>
  missionIds?: ReadonlyArray<string | null | undefined>
}
// Newest-N audit runs kept on disk. Each run holds its own findings/verdicts;
// the per-run JSONL ledger (run-events) carries the replayable detail.
const AUDIT_RUN_HISTORY_LIMIT = 100
const INTROSPECTION_RUN_HISTORY_LIMIT = 100
const MEMORY_PROPOSAL_PACK_HISTORY_LIMIT = 200
// Structural provider ids seed default-profile records for persistence and
// historical configuration compatibility. Persistence alone never confers
// offer/run eligibility; the canonical live/conditional provider policy does.
// Cursor's user-approved live membership is independent of its current managed
// Path-B launch assurance.
const providerIds: ProviderId[] = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral',
  'muse'
]
const LEGACY_TASKWRAITH_FONT_STACK =
  '"SF Pro", "SF Pro Text", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Roboto, Arial, sans-serif'
const TASKWRAITH_DEFAULT_FONT_STACK =
  '"Avenir Next", Avenir, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif'
const RETIRED_SETTINGS_KEYS = ['messageBridgeEnabled', 'messageBridgePollIntervalMs'] as const

function chatPersistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'> | null): number {
  const revision = chat?.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}

const extensionSecretStore = new ExtensionSecretStore({
  userDataPath,
  safeStorage: storeRuntime.secureStorage
})

function stripRetiredSettingsKeys<T extends Record<string, unknown>>(input: T): T {
  const next = { ...input }
  for (const key of RETIRED_SETTINGS_KEYS) {
    delete next[key]
  }
  return next as T
}

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
  const input = value as Record<string, unknown> & Partial<WorkflowRunTemplate>
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
    ...pickWorkflowRunTemplateFields(input),
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    chatId: input.chatId,
    provider: input.provider,
    prompt: input.prompt,
    displayPrompt: input.displayPrompt,
    selectedModelType: input.selectedModelType || 'default',
    customModel: input.customModel || '',
    approvalMode: input.approvalMode || 'default',
    // Missing/legacy workflow posture is the normal product workflow, not a
    // third authority state. ScheduledTask persistence already canonicalizes
    // the same omission to `normal`; keep the durable template identical so
    // exact workflow-occurrence comparisons do not discard valid elevation.
    workflowMode: normalizeChatWorkflowMode(input.workflowMode),
    // Persisted workflows are unattended authority. Legacy renderer-authored
    // Full Access flags are discarded during every read/normalization.
    sessionTrust: false,
    imageAttachments: Array.isArray(input.imageAttachments) ? input.imageAttachments : [],
    externalPathGrants: input.externalPathGrants,
    geminiWorktree: input.geminiWorktree,
    codexReasoningEffort: input.codexReasoningEffort,
    grokReasoningEffort: input.grokReasoningEffort,
    museReasoningEffort: input.museReasoningEffort,
    ollamaReasoningEffort: input.ollamaReasoningEffort,
    cursorReasoningEffort: input.cursorReasoningEffort,
    antigravityReasoningEffort: input.antigravityReasoningEffort,
    codexServiceTier: input.codexServiceTier,
    claudeFastMode: input.claudeFastMode,
    kimiFastMode: input.kimiFastMode,
    kimiReasoningEffort: input.kimiReasoningEffort,
    cursorFastMode: input.cursorFastMode,
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
      typeof input.lastRunIterationCount === 'number' &&
      Number.isFinite(input.lastRunIterationCount)
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
  if (ack.level !== 'safe' && ack.level !== 'default' && ack.level !== 'full_access')
    return undefined
  if (typeof ack.acknowledgedAt !== 'string' || !ack.acknowledgedAt) return undefined
  if (typeof ack.acknowledgedApprovalMode !== 'string' || !ack.acknowledgedApprovalMode)
    return undefined
  if (typeof ack.authorityDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(ack.authorityDigest)) {
    return undefined
  }
  if (typeof ack.signature !== 'string' || !ack.signature) return undefined
  return {
    level: ack.level,
    acknowledgedAt: ack.acknowledgedAt,
    acknowledgedApprovalMode: ack.acknowledgedApprovalMode,
    authorityDigest: ack.authorityDigest,
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
const WORKSPACE_BOARD_CARD_LINK_KIND_SET = new Set<WorkspaceBoardCardLink['kind']>(
  WORKSPACE_BOARD_CARD_LINK_KINDS
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
  return (
    typeof value === 'string' && WORKSPACE_BOARD_COLUMN_IDS.has(value as WorkspaceBoardColumnId)
  )
}

function isWorkspaceBoardCardLinkKind(value: unknown): value is WorkspaceBoardCardLink['kind'] {
  return (
    typeof value === 'string' &&
    WORKSPACE_BOARD_CARD_LINK_KIND_SET.has(value as WorkspaceBoardCardLink['kind'])
  )
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
    detail:
      typeof input.detail === 'string' && input.detail.trim() ? input.detail.trim() : undefined
  }
}

function workspaceBoardActivityActorFromProvenance(
  provenance: unknown
): WorkspaceBoardActivityEntry['actor'] {
  if (!provenance || typeof provenance !== 'object') return 'user'
  const actor = (provenance as Partial<WorkspaceBoardProvenance>).actor
  return actor === 'agent' || actor === 'system' ? actor : 'user'
}

function normalizeWorkspaceBoardProvenance(
  value: unknown,
  nowIso: string
): WorkspaceBoardProvenance | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Partial<WorkspaceBoardProvenance>
  const sourceKind = WORKSPACE_BOARD_PROVENANCE_SOURCE_KINDS.has(
    input.sourceKind as WorkspaceBoardProvenanceSourceKind
  )
    ? (input.sourceKind as WorkspaceBoardProvenanceSourceKind)
    : 'manual'
  return {
    actor: input.actor === 'agent' || input.actor === 'system' ? input.actor : 'user',
    sourceKind,
    at: typeof input.at === 'string' && input.at ? input.at : nowIso,
    trust:
      input.trust === 'agent-proposed' ||
      input.trust === 'system-derived' ||
      input.trust === 'user-confirmed'
        ? input.trust
        : undefined,
    sourceId:
      typeof input.sourceId === 'string' && input.sourceId.trim()
        ? input.sourceId.trim()
        : undefined,
    sourceTitle:
      typeof input.sourceTitle === 'string' && input.sourceTitle.trim()
        ? input.sourceTitle.trim()
        : undefined,
    provider:
      typeof input.provider === 'string' && input.provider.trim()
        ? input.provider.trim()
        : undefined,
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
          : WORKSPACE_BOARD_DEFAULT_COLUMNS.find((column) => column.id === input.id)?.sortOrder ||
            0,
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
  if (!isWorkspaceBoardCardLinkKind(input.kind)) return undefined
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
    name:
      typeof input.name === 'string' && input.name.trim() ? input.name.trim() : 'Workspace Board',
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
    title:
      typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'Untitled card',
    body: typeof input.body === 'string' && input.body.trim() ? input.body.trim() : undefined,
    sortOrder:
      typeof input.sortOrder === 'number' && Number.isFinite(input.sortOrder)
        ? input.sortOrder
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

function isInvalidScheduledTaskStatusTransition(
  current: ScheduledTask['status'],
  next: ScheduledTask['status']
): boolean {
  if (isTerminalScheduledTaskStatus(current) && next !== current) return true
  if (current === 'running' && (next === 'pending' || next === 'due')) return true
  return false
}

const SCHEDULED_TASK_MAINTENANCE_FIELDS = new Set<keyof ScheduledTask>([
  'permissionPosture',
  'imageAttachments'
])
const SCHEDULED_TASK_CREATE_PROHIBITED_FIELDS = new Set<keyof ScheduledTask>([
  'workflowId',
  'workflowExecutionId',
  'workflowOccurrenceAt',
  'runId',
  'dispatchReceipt',
  'occurrenceSeal',
  'firedAt',
  'runningSince',
  'completedAt',
  'lastError',
  'status',
  'createdAt',
  'updatedAt'
])
type ScheduledOccurrenceMutationCrashPoint =
  | 'after-intent'
  | 'after-task'
  | 'after-workflow'
  | 'after-ledger'
export type ScheduledOccurrenceMutationReplayResult =
  | { status: 'none' }
  | {
      status: 'replayed'
      mutationId: string
      kind: ScheduledOccurrenceMutationKind
      taskId: string
    }
  | { status: 'blocked'; reason: string }

let scheduledOccurrenceMutationCrashPoint: ScheduledOccurrenceMutationCrashPoint | null = null
let scheduledOccurrenceDurabilityFailureIntent: ScheduledOccurrenceMutationIntent | null = null

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b
  return isDeepStrictEqual(cloneJsonValue(a), cloneJsonValue(b))
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function canonicalIsoTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null
  return parsed
}

function optionalCanonicalIsoTimestamp(value: unknown): boolean {
  return value === undefined || canonicalIsoTimestampMs(value) !== null
}

function maybeCrashScheduledOccurrenceMutation(point: ScheduledOccurrenceMutationCrashPoint): void {
  if (scheduledOccurrenceMutationCrashPoint !== point) return
  scheduledOccurrenceMutationCrashPoint = null
  throw new Error(`Injected scheduled occurrence mutation crash ${point}.`)
}

type ScheduledTaskWorkflowPairValidation =
  | {
      ok: true
      workflow: WorkflowDefinition
      execution: WorkflowExecutionRecord | null
      linkage: 'exact' | 'pruned-terminal'
    }
  | { ok: false; reason: string }

function readCanonicalRawWorkflowHistories(
  workflows: WorkflowDefinition[]
): Map<string, WorkflowExecutionRecord[]> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(workflowsPath, 'utf-8')) as unknown
    if (!Array.isArray(raw) || raw.length !== workflows.length) return null
    const histories = new Map<string, WorkflowExecutionRecord[]>()
    for (const workflow of workflows) {
      const matches = raw.filter(
        (candidate) =>
          Boolean(candidate) &&
          typeof candidate === 'object' &&
          (candidate as { id?: unknown }).id === workflow.id
      )
      if (matches.length !== 1 || histories.has(workflow.id)) return null
      const rawHistory = (matches[0] as { history?: unknown }).history
      if (
        !Array.isArray(rawHistory) ||
        rawHistory.length > WORKFLOW_HISTORY_LIMIT ||
        !sameJsonValue(rawHistory, workflow.history)
      ) {
        return null
      }
      histories.set(workflow.id, rawHistory as WorkflowExecutionRecord[])
    }
    return histories.size === raw.length ? histories : null
  } catch {
    return null
  }
}

function validatePrunedTerminalScheduledTaskLinkage(
  task: ScheduledTask,
  workflow: WorkflowDefinition,
  rawHistory: WorkflowExecutionRecord[]
): string | null {
  const workflowExecutionId = task.workflowExecutionId as string
  const workflowOccurrenceAt = task.workflowOccurrenceAt as string
  const expectedStatus = scheduledTaskStatusToWorkflowStatus(task.status)
  const plannedForMs = canonicalIsoTimestampMs(workflowOccurrenceAt)
  const runAtMs = canonicalIsoTimestampMs(task.runAt)
  const createdAtMs = canonicalIsoTimestampMs(task.createdAt)
  const updatedAtMs = canonicalIsoTimestampMs(task.updatedAt)
  const completedAtMs = canonicalIsoTimestampMs(task.completedAt)
  if (
    !isTerminalScheduledTaskStatus(task.status) ||
    !expectedStatus ||
    !isTerminalWorkflowExecutionStatus(expectedStatus) ||
    plannedForMs === null ||
    runAtMs === null ||
    createdAtMs === null ||
    updatedAtMs === null ||
    completedAtMs === null ||
    // Pre-WAL schema-v1 rows did not carry a discriminator and could stamp
    // createdAt after runAt. They deliberately remain fail-closed here until a
    // versioned migration can attest them; destructive validation must not
    // infer legacy provenance from loose clock ranges.
    task.runAt !== task.createdAt ||
    plannedForMs > runAtMs ||
    runAtMs > completedAtMs ||
    completedAtMs > updatedAtMs ||
    !optionalCanonicalIsoTimestamp(task.firedAt) ||
    !optionalCanonicalIsoTimestamp(task.runningSince)
  ) {
    return 'Workflow-linked scheduled task is not a canonical terminal pruned occurrence.'
  }
  const firedAtMs = task.firedAt === undefined ? undefined : canonicalIsoTimestampMs(task.firedAt)
  const runningSinceMs =
    task.runningSince === undefined ? undefined : canonicalIsoTimestampMs(task.runningSince)
  if (
    (firedAtMs !== undefined && (firedAtMs === null || firedAtMs < runAtMs)) ||
    (runningSinceMs !== undefined &&
      (runningSinceMs === null || runningSinceMs < (firedAtMs ?? runAtMs))) ||
    (runningSinceMs ?? firedAtMs ?? runAtMs) > completedAtMs ||
    (task.runId !== undefined &&
      (!isNonEmptyTrimmedString(task.runId) ||
        firedAtMs === undefined ||
        firedAtMs === null ||
        runningSinceMs === undefined ||
        runningSinceMs === null))
  ) {
    return 'Workflow-linked scheduled task has a divergent terminal run timeline.'
  }

  let ledger: StrictWorkflowRunLedgerRead
  try {
    ledger = readWorkflowRunLedgerStrict(workflowRunFilePath(workflowExecutionId))
  } catch {
    return 'Workflow-linked pruned occurrence has an invalid lifecycle ledger.'
  }
  if (
    ledger.hasTornTail ||
    ledger.events.length === 0 ||
    ledger.events.some(
      (event, index) =>
        event.sequence !== index + 1 ||
        event.workflowExecutionId !== workflowExecutionId ||
        event.workflowId !== workflow.id ||
        canonicalIsoTimestampMs(event.timestamp) === null ||
        (event.scheduledTaskId !== undefined && event.scheduledTaskId !== task.id) ||
        (event.plannedFor !== undefined && event.plannedFor !== workflowOccurrenceAt) ||
        (event.iteration === undefined && event.runId !== undefined && event.runId !== task.runId)
    )
  ) {
    return 'Workflow-linked pruned occurrence has an invalid lifecycle ledger.'
  }
  const terminalEvents = ledger.events.filter(
    (event) =>
      event.iteration === undefined &&
      (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled')
  )
  const matchingTerminalEvents = terminalEvents.filter((event) => {
    const eventAtMs = canonicalIsoTimestampMs(event.timestamp)
    const expected = canonicalScheduledOccurrenceLedgerEvent(task, event.timestamp, event.sequence)
    return (
      expected !== null &&
      sameJsonValue(expected, event) &&
      eventAtMs !== null &&
      eventAtMs >= completedAtMs &&
      eventAtMs <= updatedAtMs
    )
  })
  if (terminalEvents.length !== 1 || matchingTerminalEvents.length !== 1) {
    return 'Workflow-linked pruned occurrence terminal fields do not match its lifecycle ledger.'
  }
  const executionRunningEvents = ledger.events.filter(
    (event) => event.iteration === undefined && event.kind === 'running'
  )
  if (task.runId === undefined) {
    if (executionRunningEvents.length !== 0) {
      return 'Workflow-linked pruned occurrence has an unexpected lifecycle claim owner.'
    }
  } else {
    const matchingRunningEvents = executionRunningEvents.filter((event) => {
      const expected = canonicalScheduledOccurrenceLedgerEvent(
        {
          ...task,
          status: 'running',
          completedAt: undefined,
          lastError: undefined
        },
        task.firedAt as string,
        event.sequence
      )
      return (
        expected !== null &&
        sameJsonValue(expected, event) &&
        event.timestamp === task.firedAt &&
        event.sequence < matchingTerminalEvents[0].sequence
      )
    })
    if (executionRunningEvents.length !== 1 || matchingRunningEvents.length !== 1) {
      return 'Workflow-linked pruned occurrence has no unique canonical lifecycle claim.'
    }
  }

  // Use the unnormalized row: workflow normalization repairs missing history
  // timestamps with `now`, which must not manufacture pruning evidence during
  // a destructive operation.
  const retainedCreatedAt = rawHistory.map((execution) =>
    canonicalIsoTimestampMs(execution.createdAt)
  )
  const terminalEventAtMs = canonicalIsoTimestampMs(matchingTerminalEvents[0].timestamp) as number
  const retainedIds = rawHistory.map((execution) => execution.id)
  const retainedTaskIds = rawHistory
    .map((execution) => execution.scheduledTaskId)
    .filter((value): value is string => value !== undefined)
  const retainedRunIds = rawHistory
    .map((execution) => execution.runId)
    .filter((value): value is string => value !== undefined)
  if (
    rawHistory.length !== WORKFLOW_HISTORY_LIMIT ||
    retainedCreatedAt.some((timestamp) => timestamp === null) ||
    retainedCreatedAt.some((timestamp) => (timestamp as number) < terminalEventAtMs) ||
    retainedCreatedAt.some(
      (timestamp, index) =>
        index > 0 && (timestamp as number) < (retainedCreatedAt[index - 1] as number)
    ) ||
    new Set(retainedIds).size !== retainedIds.length ||
    new Set(retainedTaskIds).size !== retainedTaskIds.length ||
    new Set(retainedRunIds).size !== retainedRunIds.length
  ) {
    return 'Workflow-linked scheduled task execution is missing without proof of history pruning.'
  }
  return null
}

function validateScheduledTaskWorkflowPair(
  task: ScheduledTask,
  workflows: WorkflowDefinition[],
  tasks: ScheduledTask[]
): ScheduledTaskWorkflowPairValidation {
  const { workflowId, workflowExecutionId, workflowOccurrenceAt } = task
  if (!isNonEmptyTrimmedString(task.id)) {
    return { ok: false, reason: 'Workflow-linked scheduled task has an invalid task owner.' }
  }
  if (
    !isNonEmptyTrimmedString(workflowId) ||
    !isNonEmptyTrimmedString(workflowExecutionId) ||
    !isNonEmptyTrimmedString(workflowOccurrenceAt) ||
    canonicalIsoTimestampMs(workflowOccurrenceAt) === null
  ) {
    return { ok: false, reason: 'Workflow-linked scheduled task has an incomplete W/E/P tuple.' }
  }
  const workflowMatches = workflows.filter((workflow) => workflow.id === workflowId)
  if (workflowMatches.length !== 1) {
    return { ok: false, reason: 'Workflow-linked scheduled task has no unique workflow.' }
  }
  const workflow = workflowMatches[0]
  const rawHistories = readCanonicalRawWorkflowHistories(workflows)
  if (!rawHistories) {
    return {
      ok: false,
      reason: 'Workflow-linked scheduled task history is not a canonical persisted projection.'
    }
  }
  const rawHistory = rawHistories.get(workflow.id)
  if (!rawHistory) {
    return {
      ok: false,
      reason: 'Workflow-linked scheduled task history is missing its persisted projection.'
    }
  }
  const executionMatches = workflow.history.filter(
    (execution) => execution.id === workflowExecutionId
  )
  if (executionMatches.length > 1) {
    return { ok: false, reason: 'Workflow-linked scheduled task has no unique execution.' }
  }
  const prunedTerminalCandidate = executionMatches.length === 0
  const terminal = isTerminalScheduledTaskStatus(task.status)
  const currentExecutions = [...rawHistories.values()].flat()
  const taskIdOwners = tasks.filter((candidate) => candidate.id === task.id)
  const executionTaskOwners = tasks.filter(
    (candidate) => candidate.workflowExecutionId === workflowExecutionId
  )
  const historyExecutionOwners = currentExecutions.filter(
    (execution) => execution.id === workflowExecutionId
  )
  const historyTaskOwners = currentExecutions.filter(
    (execution) => execution.scheduledTaskId === task.id
  )
  const activeExecutionOwners = workflows.filter(
    (candidate) => candidate.activeExecutionId === workflowExecutionId
  )
  const expectedHistoryOwnerCount = prunedTerminalCandidate ? 0 : 1
  const expectedActiveOwnerCount = !prunedTerminalCandidate && !terminal ? 1 : 0
  if (
    taskIdOwners.length !== 1 ||
    !sameJsonValue(taskIdOwners[0], task) ||
    executionTaskOwners.length !== 1 ||
    executionTaskOwners[0].id !== task.id ||
    historyExecutionOwners.length !== expectedHistoryOwnerCount ||
    historyTaskOwners.length !== expectedHistoryOwnerCount ||
    activeExecutionOwners.length !== expectedActiveOwnerCount
  ) {
    return {
      ok: false,
      reason: 'Workflow-linked scheduled task has missing or duplicate lifecycle ownership.'
    }
  }
  if (task.runId !== undefined) {
    if (!isNonEmptyTrimmedString(task.runId)) {
      return {
        ok: false,
        reason: 'Workflow-linked scheduled task has an invalid run owner.'
      }
    }
    const taskRunOwners = tasks.filter((candidate) => candidate.runId === task.runId)
    const executionRunOwners = currentExecutions.filter(
      (execution) => execution.runId === task.runId
    )
    if (
      taskRunOwners.length !== 1 ||
      taskRunOwners[0].id !== task.id ||
      executionRunOwners.length !== expectedHistoryOwnerCount
    ) {
      return {
        ok: false,
        reason: 'Workflow-linked scheduled task has missing or duplicate run ownership.'
      }
    }
  }
  if (executionMatches.length === 0) {
    const prunedReason = validatePrunedTerminalScheduledTaskLinkage(task, workflow, rawHistory)
    return prunedReason
      ? { ok: false, reason: prunedReason }
      : { ok: true, workflow, execution: null, linkage: 'pruned-terminal' }
  }
  const execution = executionMatches[0]
  if (!isNonEmptyTrimmedString(execution.scheduledTaskId)) {
    return { ok: false, reason: 'Workflow-linked scheduled task has an invalid task owner.' }
  }
  const identity: ScheduledOccurrenceIdentity = {
    taskId: task.id,
    workflowId,
    executionId: workflowExecutionId,
    plannedFor: workflowOccurrenceAt,
    runId: task.runId
  }
  if (!workflowExecutionMatchesIdentity(execution, identity)) {
    return { ok: false, reason: 'Workflow-linked scheduled task has a divergent W/E/P tuple.' }
  }
  const expectedStatus =
    task.status === 'pending' || task.status === 'due'
      ? 'queued'
      : scheduledTaskStatusToWorkflowStatus(task.status)
  if (!expectedStatus || execution.status !== expectedStatus || execution.runId !== task.runId) {
    return {
      ok: false,
      reason: 'Workflow-linked scheduled task and execution lifecycle projections diverge.'
    }
  }
  if (
    (!terminal && workflow.activeExecutionId !== execution.id) ||
    (terminal && workflow.activeExecutionId === execution.id)
  ) {
    return {
      ok: false,
      reason: 'Workflow-linked scheduled task and workflow active projection diverge.'
    }
  }
  if (
    terminal &&
    (canonicalIsoTimestampMs(task.completedAt) === null ||
      task.completedAt !== execution.completedAt ||
      (task.lastError || undefined) !== execution.error)
  ) {
    return {
      ok: false,
      reason: 'Workflow-linked terminal task does not match its terminal execution.'
    }
  }
  if (
    task.status === 'running' &&
    (!isNonEmptyTrimmedString(task.runId) ||
      canonicalIsoTimestampMs(task.firedAt) === null ||
      task.firedAt !== execution.startedAt)
  ) {
    return { ok: false, reason: 'Workflow-linked running task does not match its execution.' }
  }
  return { ok: true, workflow, execution, linkage: 'exact' }
}

function sameWorkflowPath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return path.resolve(a) === path.resolve(b)
}

function sameWorkflowAuthority(a: WorkflowDefinition, b: WorkflowDefinition): boolean {
  try {
    const canonicalPath = (value: string): string => path.resolve(value)
    return workflowAuthorityDigest(a, canonicalPath) === workflowAuthorityDigest(b, canonicalPath)
  } catch {
    return false
  }
}

const WORKFLOW_OCCURRENCE_PROJECTION_FIELDS = [
  'history',
  'activeExecutionId',
  'lastStatus',
  'lastError',
  'lastRunAt',
  'lastCompletedAt',
  'failureStreak'
] as const

function workflowHasNonterminalOccurrence(workflow: WorkflowDefinition): boolean {
  if (workflow.activeExecutionId) {
    const active = workflow.history.find((execution) => execution.id === workflow.activeExecutionId)
    if (!active || !isTerminalWorkflowExecutionStatus(active.status)) return true
  }
  return workflow.history.some(
    (execution) =>
      Boolean(execution.scheduledTaskId) && !isTerminalWorkflowExecutionStatus(execution.status)
  )
}

function assertWorkflowOccurrenceProjectionInputUnchanged(
  source: WorkflowDefinition,
  input: object
): void {
  if (!workflowHasNonterminalOccurrence(source)) return
  const sourceRecord = source as unknown as Record<string, unknown>
  const inputRecord = input as Record<string, unknown>
  for (const field of WORKFLOW_OCCURRENCE_PROJECTION_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(inputRecord, field) &&
      !sameJsonValue(inputRecord[field], sourceRecord[field])
    ) {
      throw new Error(
        'Workflow occurrence lifecycle projections are immutable while an execution is active.'
      )
    }
  }
}

function preserveWorkflowOccurrenceProjection(
  source: WorkflowDefinition,
  target: WorkflowDefinition
): void {
  if (!workflowHasNonterminalOccurrence(source)) return
  const sourceRecord = source as unknown as Record<string, unknown>
  const targetRecord = target as unknown as Record<string, unknown>
  for (const field of WORKFLOW_OCCURRENCE_PROJECTION_FIELDS) {
    if (sourceRecord[field] === undefined) delete targetRecord[field]
    else targetRecord[field] = cloneJsonValue(sourceRecord[field])
  }
}

function scheduledAttachmentsAreDurable(
  value: unknown
): value is Array<ScheduledTaskAttachmentRef & PersistedAttachmentRef> {
  return Array.isArray(value) && value.every(isDurableScheduledAttachmentRef)
}

function resolveScheduledAttachmentRefs(
  attachments: unknown,
  context: {
    source: 'scheduled-task' | 'workflow-template'
    recordId: string
    appChatId: string
    workspaceId: string
    workspacePath: string
    externalPathGrants?: ScheduledTask['externalPathGrants']
  },
  resolveAttachments: ResolveScheduledAttachments
): ScheduledTaskAttachmentRef[] | null {
  if (!scheduledAttachmentsAreDurable(attachments)) return null
  if (attachments.length === 0) return []
  try {
    const result = resolveAttachments({
      source: context.source,
      recordId: context.recordId,
      appChatId: context.appChatId,
      workspaceId: context.workspaceId,
      workspacePath: context.workspacePath,
      externalPathGrants: context.externalPathGrants || [],
      attachments
    })
    if (!result.ok) return null
    return copyResolvedScheduledAttachments(attachments, result.attachments)
  } catch {
    return null
  }
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

const AUDIT_RETENTION_SURFACES: AuditRetentionSurface[] = [
  'approvalLedger',
  'runEvents',
  'workspaceChanges',
  'auditRuns',
  'messageFeedback',
  'externalPublish',
  'productCrashes'
]

const DEFAULT_AUDIT_RETENTION: AuditRetentionSettings = {
  enabled: false,
  maxAgeDays: {
    approvalLedger: 365,
    runEvents: 180,
    workspaceChanges: 180,
    auditRuns: 365,
    messageFeedback: 365,
    externalPublish: 365,
    productCrashes: 90
  }
}

const AUDIT_RETENTION_PURGE_RECEIPT_CAP = 250
const AUDIT_BUNDLE_VERIFICATION_RECEIPT_CAP = 250

function normalizeAuditRetentionSettings(value: unknown): AuditRetentionSettings {
  const input = value && typeof value === 'object' ? (value as Partial<AuditRetentionSettings>) : {}
  const rawMaxAge = input.maxAgeDays && typeof input.maxAgeDays === 'object' ? input.maxAgeDays : {}
  const maxAgeDays: Partial<Record<AuditRetentionSurface, number>> = {}
  for (const surface of AUDIT_RETENTION_SURFACES) {
    const value = Number((rawMaxAge as Partial<Record<AuditRetentionSurface, number>>)[surface])
    if (Number.isFinite(value) && value > 0) {
      maxAgeDays[surface] = Math.min(3650, Math.max(1, Math.floor(value)))
    }
  }
  return {
    enabled: input.enabled === true,
    maxAgeDays: {
      ...DEFAULT_AUDIT_RETENTION.maxAgeDays,
      ...maxAgeDays
    }
  }
}

function emptyAuditRetentionCounts(): Record<
  AuditRetentionSurface,
  AuditRetentionSurfacePurgeCounts
> {
  return AUDIT_RETENTION_SURFACES.reduce(
    (counts, surface) => {
      counts[surface] = { scanned: 0, retained: 0, deleted: 0 }
      return counts
    },
    {} as Record<AuditRetentionSurface, AuditRetentionSurfacePurgeCounts>
  )
}

function auditRetentionCutoffMs(
  policy: AuditRetentionSettings,
  surface: AuditRetentionSurface,
  nowMs: number
): number | null {
  const days = policy.maxAgeDays?.[surface]
  if (!Number.isFinite(days) || Number(days) <= 0) return null
  return nowMs - Math.floor(Number(days)) * 24 * 60 * 60 * 1000
}

function isBeforeAuditRetentionCutoff(value: unknown, cutoffMs: number | null): boolean {
  if (cutoffMs === null) return false
  const ms = typeof value === 'number' ? value : Date.parse(String(value || ''))
  return Number.isFinite(ms) && ms < cutoffMs
}

function capAuditRetentionPurgeReceipts(
  receipts: AuditRetentionPurgeReceipt[],
  cap = AUDIT_RETENTION_PURGE_RECEIPT_CAP
): AuditRetentionPurgeReceipt[] {
  const normalized = receipts.filter((receipt): receipt is AuditRetentionPurgeReceipt =>
    Boolean(receipt?.id && receipt.schemaVersion === 1 && receipt.generatedAt)
  )
  return normalized.length <= cap ? normalized : normalized.slice(normalized.length - cap)
}

function normalizeAuditBundleVerificationReceipt(
  receipt: unknown
): ProductAuditBundleVerificationReceipt | null {
  if (!receipt || typeof receipt !== 'object') return null
  const candidate = receipt as ProductAuditBundleVerificationReceipt
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    typeof candidate.verifiedAt !== 'string' ||
    typeof candidate.ok !== 'boolean'
  ) {
    return null
  }
  return candidate
}

function capAuditBundleVerificationReceipts(
  receipts: unknown[],
  cap = AUDIT_BUNDLE_VERIFICATION_RECEIPT_CAP
): ProductAuditBundleVerificationReceipt[] {
  const normalized = receipts
    .map(normalizeAuditBundleVerificationReceipt)
    .filter((receipt): receipt is ProductAuditBundleVerificationReceipt => Boolean(receipt))
  return normalized.length <= cap ? normalized : normalized.slice(normalized.length - cap)
}

const defaultSettings: AppSettings = {
  activeProvider: DEFAULT_PROVIDER,
  providerRunPauses: {},
  autoFailoverEnabled: false,
  workflowBudgetKillEnabled: true,
  userName: '',
  claudeBinaryPath: '',
  kimiBinaryPath: '',
  // Preserve existing Simulator Canvas behavior for upgrading users. This is
  // only a local actuation switch; per-chat approval and controller leases
  // remain required before any device input can be sent.
  simulatorControlEnabled: true,
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaDefaultModel: '',
  defaultGeminiAuthProfileId: null,
  geminiAuthProfiles: [],
  geminiApiRuntime: 'auto',
  promptCache: DEFAULT_PROMPT_CACHE_SETTINGS,
  userMcpServers: [],
  storeLocalChatHistory: true,
  storeRawEvents: false,
  storePromptResponseInUsage: false,
  customInstructionsEnabled: true,
  auditRetention: DEFAULT_AUDIT_RETENTION,
  ensembleModeEnabled: true,
  geminiCheckpointingEnabled: false,
  chatContextTurns: 6,
  appearanceMode: 'soft_glass',
  visualEffectStyle: 'auto',
  themeAppearance: 'system',
  themeCornerStyle: 'rounded',
  themeAccentStyle: 'system',
  themeAccentColor: DEFAULT_THEME_ACCENT_COLOR,
  toolIconAccent: 'system',
  userBubbleColor: 'system',
  diffStatColors: DEFAULT_DIFF_STAT_COLORS,
  appIconVariant: 'monoline',
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
  closeoutAiSummaryEnabled: true,
  hostAutoCompactEnabled: true,
  ensembleCollapseOlderRounds: true,
  /** Settings → General Max Wave Agents (clamped 2–64 on read/write).
   *  A literal because `defaultSettings` is the shipped settings shape, not a
   *  computed one; kept in step with shared/fleetWave's DEFAULT_MAX_WAVE_AGENTS
   *  by maxWaveAgentsDefault.test.ts, which reads this line back as source. */
  maxWaveAgents: 12,
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
  // Session chrome default: right dock starts closed on cold launch.
  showInspector: false,
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
    externalPublish: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    sketchCanvas: 'allow',
    crossThreadRead: 'ask',
    threadMessage: 'ask',
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
  studioCompanionEnabled: true,
  iosRemoteEnabled: true,
  iosRemoteManualRelayUrl: '',
  codexSandboxFallback: 'ask_rerun',
  autoUpdateEnabled: true,
  // Product observation is non-essential and stays network-silent until the
  // user affirmatively chooses Share during first launch or in Settings.
  activityReportingEnabled: false,
  updateChannel: 'stable',
  approvalTimeouts: {
    enabled: true,
    defaultsVersion: APPROVAL_TIMEOUT_DEFAULTS_VERSION,
    perProviderMs: { ...DEFAULT_APPROVAL_TIMEOUTS_MS },
    mainAuthorityMs: DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS
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
    // Once the standalone Host owns these durable families, a legacy AppStore
    // read may still project their valid prefix/default in memory but must not
    // create a `.corrupt-*` side artifact. Settings and schedules deliberately
    // remain outside this fence for Desktop compatibility.
    if (hostOwnedReadRepairPathFamily(filePath) && !legacyStoreCanWrite()) {
      return defaultData
    }
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

function normalizeRuntimeProfileSecretRefs(value: unknown): RuntimeProfileSecretRefs | undefined {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  const env = Array.isArray(record?.env)
    ? Array.from(
        new Set(
          record.env.filter(
            (key): key is string => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
          )
        )
      ).slice(0, 64)
    : []
  return env.length > 0 ? { env } : undefined
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
    record.kind === 'toolBundle' ||
    record.kind === 'workflowTemplate' ||
    record.kind === 'runtimeProfile' ||
    record.kind === 'connector' ||
    record.kind === 'localService' ||
    record.kind === 'providerSetup' ||
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

function normalizePluginReviewState(value: unknown): UserMcpServerConfig['pluginReview'] {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record) return undefined
  const status =
    record.status === 'pending' || record.status === 'accepted' ? record.status : undefined
  const reason =
    record.reason === 'new-plugin-resource' ||
    record.reason === 'manifest-update' ||
    record.reason === 'user-enabled-reviewed-resource'
      ? record.reason
      : undefined
  const manifestHash = typeof record.manifestHash === 'string' ? record.manifestHash.trim() : ''
  const reviewedAt = typeof record.reviewedAt === 'string' ? record.reviewedAt.trim() : ''
  if (!status || !reason || !manifestHash) return undefined
  return {
    status,
    reason,
    manifestHash,
    ...(reviewedAt ? { reviewedAt } : {})
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
              ([key, val]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof val === 'string'
            )
            .map(([key, val]) => [key, val])
            .slice(0, 64)
        )
      : {}
    const secretRefsRecord = objectOrUndefined(
      record.secretRefs as Record<string, unknown> | null | undefined
    )
    const secretEnvRefs = Array.isArray(secretRefsRecord?.env)
      ? Array.from(
          new Set(
            secretRefsRecord.env.filter(
              (key): key is string =>
                typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
            )
          )
        ).slice(0, 64)
      : []
    const secretHeaderRefs = Array.isArray(secretRefsRecord?.headers)
      ? Array.from(
          new Set(
            secretRefsRecord.headers.filter(
              (key): key is string =>
                typeof key === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)
            )
          )
        ).slice(0, 64)
      : []
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    const rawUrl = typeof record.url === 'string' ? record.url.trim() : ''
    const url = rawUrl && isValidUserMcpRemoteUrl(rawUrl) ? rawUrl : ''
    const bearerTokenEnvVar =
      typeof record.bearerTokenEnvVar === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(record.bearerTokenEnvVar.trim())
        ? record.bearerTokenEnvVar.trim()
        : ''
    const pluginProvenance = normalizePluginResourceProvenance(record.pluginProvenance)
    const pluginReview = normalizePluginReviewState(record.pluginReview)
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
    if (secretEnvRefs.length > 0 || secretHeaderRefs.length > 0) {
      normalized.secretRefs = {
        ...(secretEnvRefs.length > 0 ? { env: secretEnvRefs } : {}),
        ...(secretHeaderRefs.length > 0 ? { headers: secretHeaderRefs } : {})
      }
    }
    if (bearerTokenEnvVar) normalized.bearerTokenEnvVar = bearerTokenEnvVar
    if (typeof record.description === 'string' && record.description.trim()) {
      normalized.description = record.description.trim()
    }
    if (pluginProvenance) normalized.pluginProvenance = pluginProvenance
    if (pluginReview) normalized.pluginReview = pluginReview
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

/**
 * Directory fsyncs for every durable write, off the calling thread. Module
 * scope so writes to the same directory coalesce across all callers, which is
 * the common case for a hot store.
 */
const directoryFsyncQueue = createDirectoryFsyncQueue()

function hostOwnedJsonPathFamily(filePath: string): 'workspaces' | 'chats' | null {
  if (filePath === workspacesPath) return 'workspaces'
  if (path.dirname(filePath) === chatsDir && path.extname(filePath) === '.json') return 'chats'
  return null
}

/** Durable families the standalone Host owns once the legacy gate closes. */
function hostOwnedReadRepairPathFamily(filePath: string): boolean {
  if (filePath === workspacesPath) return true
  const chatDirectory = path.join(userDataPath, 'chats')
  if (path.dirname(filePath) === chatDirectory && path.extname(filePath) === '.json') return true
  const listIndexPath = path.join(userDataPath, 'chat-list-index.jsonl')
  const legacyListIndexPath = path.join(userDataPath, 'chat-list-index.json')
  const listSummariesDirectory = path.join(userDataPath, 'chat-list-summaries')
  if (
    filePath === listIndexPath ||
    filePath === legacyListIndexPath ||
    path.dirname(filePath) === listSummariesDirectory
  ) {
    return true
  }
  const journalDirectory = path.join(userDataPath, 'chat-journal')
  const incrementalJournalDirectory = path.join(userDataPath, 'chat-journal-v2')
  return (
    path.dirname(filePath) === journalDirectory ||
    path.dirname(filePath) === incrementalJournalDirectory
  )
}

function writeJson<T>(filePath: string, data: T): void {
  const pathFamily = hostOwnedJsonPathFamily(filePath)
  if (!pathFamily) {
    writeJsonAdmitted(filePath, data)
    return
  }
  runLegacyStoreWriteAdmission({ operation: 'write-json', pathFamily }, () => {
    writeJsonAdmitted(filePath, data)
  })
}

function writeJsonAdmitted<T>(filePath: string, data: T): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd: number | null = null
  // T3a probe: null unless PERF_PRELOAD_PROBE=1, so the production path pays a
  // null check and nothing more. Measures the wall time a V8 CPU profile
  // structurally cannot see (blocked write/fsync/rename), which is the gap the
  // T2 baseline left un-attributed.
  const probe = beginPersistenceWrite(filePath)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fd = fs.openSync(tempPath, 'w', 0o600)
    const serialized = JSON.stringify(data, null, 2)
    probe?.afterSerialize(Buffer.byteLength(serialized, 'utf-8'))
    fs.writeFileSync(fd, serialized, 'utf-8')
    probe?.afterWrite()
    fs.fsyncSync(fd)
    probe?.afterFsync()
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tempPath, filePath)
    probe?.afterRename()
    if (filePath === settingsPath) invalidateSettingsFileCache()
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
    // Off-thread, coalesced per directory. It was already best-effort here, so
    // an fsync that has not run yet and one that threw are the same outcome —
    // but it measured 4.7 ms (36%) of this function on a 2 MB payload, paid on
    // every write. See DirectoryFsyncQueue for why the FILE fsync above cannot
    // move with it.
    directoryFsyncQueue.schedule(path.dirname(filePath))
    // totalMs spans the whole durable write, so it exceeds the sum of the named
    // phases by the mkdir/open/close/chmod remainder. That remainder is real
    // durability cost and is deliberately not discarded. The directory fsync is
    // no longer part of it — that work is now queued, not blocking. A write that
    // throws never reaches end(), so failed writes contribute no sample.
    probe?.end()
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
    throw e
  }
}

function historyDeletionErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/g, ' ').slice(0, 500) || 'Unknown deletion failure.'
}

function readJsonStrictIfPresent(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
}

function normalizeHistoryDeletionIntent(value: unknown): HistoryDeletionIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('History deletion intent is not an object.')
  }
  const record = value as Partial<HistoryDeletionIntent>
  const kinds = new Set<HistoryDeletionKind>(['global', 'workspace', 'chat', 'truncate'])
  const steps = new Set<HistoryDeletionStep>(HISTORY_DELETION_STEPS)
  const safeStrings = (items: unknown, label: string, validateSafeChatId = false): string[] => {
    if (!Array.isArray(items)) throw new Error(`History deletion intent ${label} is not an array.`)
    const result = [...new Set(items)]
    if (
      result.some(
        (item) =>
          typeof item !== 'string' ||
          !item ||
          item.length > 4096 ||
          (validateSafeChatId && !isSafeChatId(item))
      )
    ) {
      throw new Error(`History deletion intent ${label} contains an unsafe identifier.`)
    }
    return result as string[]
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.operationId !== 'string' ||
    !record.operationId ||
    record.operationId.length > 128 ||
    !kinds.has(record.kind as HistoryDeletionKind) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.updatedAt))
  ) {
    throw new Error('History deletion intent header is invalid.')
  }
  const kind = record.kind as HistoryDeletionKind
  if (
    (kind === 'workspace' &&
      (typeof record.workspaceId !== 'string' || !record.workspaceId.trim())) ||
    ((kind === 'chat' || kind === 'truncate') &&
      (typeof record.rootChatId !== 'string' || !isSafeChatId(record.rootChatId)))
  ) {
    throw new Error('History deletion intent scope is invalid.')
  }
  const completedSteps = safeStrings(record.completedSteps, 'completed steps').filter((step) =>
    steps.has(step as HistoryDeletionStep)
  ) as HistoryDeletionStep[]
  if (completedSteps.length !== new Set(record.completedSteps as string[]).size) {
    throw new Error('History deletion intent contains an unknown completion step.')
  }
  if (!Array.isArray(record.kimiSeats)) {
    throw new Error('History deletion intent Kimi seats is not an array.')
  }
  const chatIds = safeStrings(record.chatIds, 'chat ids', true)
  const runIds = safeStrings(record.runIds, 'run ids')
  // Version-1 intents written before mission facts existed carry no inventory.
  // Their existing chat/workspace fences remain authoritative, while every new
  // prepare freezes the exact ids needed for deterministic recovery.
  const missionFactIds =
    record.missionFactIds === undefined
      ? []
      : safeStrings(record.missionFactIds, 'mission fact ids')
  // Never normalize a missing ownership inventory to empty: that would turn a
  // source-ahead journal upgrade into an apparently successful clear while an
  // old schedule could still recreate the transcript.
  const scheduledTaskIds = safeStrings(record.scheduledTaskIds, 'scheduled task ids')
  const retainedScheduledTaskIds = safeStrings(
    record.retainedScheduledTaskIds,
    'retained scheduled task ids'
  )
  if (retainedScheduledTaskIds.some((taskId) => !scheduledTaskIds.includes(taskId))) {
    throw new Error(
      'History deletion intent retains a scheduled task outside its frozen deletion scope.'
    )
  }
  const workflowIds = safeStrings(record.workflowIds, 'workflow ids')
  const workflowExecutionIds = safeStrings(record.workflowExecutionIds, 'workflow execution ids')
  const kimiSeats = record.kimiSeats.map((seat) => {
    if (
      !seat ||
      typeof seat !== 'object' ||
      Array.isArray(seat) ||
      !isSafeChatId((seat as { chatId?: unknown }).chatId) ||
      typeof (seat as { participantId?: unknown }).participantId !== 'string' ||
      !(seat as { participantId: string }).participantId ||
      (seat as { participantId: string }).participantId.length > 4096
    ) {
      throw new Error('History deletion intent contains an unsafe Kimi seat identity.')
    }
    return {
      chatId: (seat as { chatId: string }).chatId,
      participantId: (seat as { participantId: string }).participantId
    }
  })
  if (!Array.isArray(record.quiescenceTargets)) {
    throw new Error('History deletion intent quiescence targets is not an array.')
  }
  const quiescenceKinds = new Set<HistoryDeletionQuiescenceKind>([
    'maintenance-compaction',
    'provider-run',
    'canvas',
    'execution-graph',
    'channels',
    'usage',
    'project-reference',
    'media',
    'bridge'
  ])
  const targetIds = new Set<string>()
  const quiescenceTargets = record.quiescenceTargets.map((targetValue) => {
    const target = objectRecord(targetValue)
    if (
      !target ||
      typeof target.id !== 'string' ||
      !target.id ||
      target.id.length > 512 ||
      targetIds.has(target.id) ||
      !quiescenceKinds.has(target.kind as HistoryDeletionQuiescenceKind) ||
      (target.chatId !== undefined &&
        (typeof target.chatId !== 'string' || !isSafeChatId(target.chatId))) ||
      (target.runId !== undefined &&
        (typeof target.runId !== 'string' || !target.runId || target.runId.length > 4096)) ||
      (target.maintenanceCompactionId !== undefined &&
        (typeof target.maintenanceCompactionId !== 'string' ||
          !target.maintenanceCompactionId ||
          target.maintenanceCompactionId.length > 4096)) ||
      (target.workspaceId !== undefined &&
        (typeof target.workspaceId !== 'string' ||
          !target.workspaceId ||
          target.workspaceId.length > 4096)) ||
      (target.provider !== undefined && !providerIds.includes(target.provider as ProviderId))
    ) {
      throw new Error('History deletion intent contains an invalid quiescence target.')
    }
    targetIds.add(target.id)
    const normalizedTarget: HistoryDeletionQuiescenceTarget = {
      id: target.id,
      kind: target.kind as HistoryDeletionQuiescenceKind,
      ...(typeof target.runId === 'string' ? { runId: target.runId } : {}),
      ...(typeof target.maintenanceCompactionId === 'string'
        ? { maintenanceCompactionId: target.maintenanceCompactionId }
        : {}),
      ...(typeof target.provider === 'string' ? { provider: target.provider as ProviderId } : {}),
      ...(typeof target.chatId === 'string' ? { chatId: target.chatId } : {}),
      ...(typeof target.workspaceId === 'string' ? { workspaceId: target.workspaceId } : {})
    }
    if (
      (normalizedTarget.kind === 'provider-run' &&
        (!normalizedTarget.runId || !normalizedTarget.provider)) ||
      (normalizedTarget.kind !== 'maintenance-compaction' &&
        Boolean(normalizedTarget.maintenanceCompactionId)) ||
      (normalizedTarget.kind === 'maintenance-compaction' &&
        Boolean(normalizedTarget.maintenanceCompactionId) &&
        (!normalizedTarget.provider || !normalizedTarget.chatId)) ||
      (normalizedTarget.kind === 'usage' &&
        (normalizedTarget.runId ||
          normalizedTarget.maintenanceCompactionId ||
          normalizedTarget.provider ||
          normalizedTarget.chatId)) ||
      (normalizedTarget.kind === 'project-reference' &&
        (normalizedTarget.runId ||
          normalizedTarget.maintenanceCompactionId ||
          normalizedTarget.provider ||
          normalizedTarget.chatId ||
          (kind === 'workspace'
            ? normalizedTarget.workspaceId !== record.workspaceId
            : Boolean(normalizedTarget.workspaceId)))) ||
      (normalizedTarget.chatId && !chatIds.includes(normalizedTarget.chatId)) ||
      (kind === 'workspace' &&
        normalizedTarget.workspaceId &&
        normalizedTarget.workspaceId !== record.workspaceId) ||
      (normalizedTarget.kind === 'bridge' && kind !== 'global')
    ) {
      throw new Error('History deletion quiescence target does not belong to its deletion scope.')
    }
    return normalizedTarget
  })
  const completedQuiescenceTargetIds = safeStrings(
    record.completedQuiescenceTargetIds,
    'completed quiescence target ids'
  )
  if (completedQuiescenceTargetIds.some((id) => !targetIds.has(id))) {
    throw new Error('History deletion intent completed an unknown quiescence target.')
  }
  const failures = Array.isArray(record.failures)
    ? record.failures
        .filter((failure): failure is { step: HistoryDeletionStep | 'journal'; message: string } =>
          Boolean(
            failure &&
            typeof failure === 'object' &&
            !Array.isArray(failure) &&
            ((failure as { step?: unknown }).step === 'journal' ||
              steps.has((failure as { step?: HistoryDeletionStep }).step as HistoryDeletionStep)) &&
            typeof (failure as { message?: unknown }).message === 'string'
          )
        )
        .map((failure) => ({ step: failure.step, message: failure.message.slice(0, 500) }))
    : []
  return {
    schemaVersion: 1,
    operationId: record.operationId,
    kind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(typeof record.workspaceId === 'string' ? { workspaceId: record.workspaceId } : {}),
    ...(typeof record.rootChatId === 'string' ? { rootChatId: record.rootChatId } : {}),
    chatIds,
    runIds,
    missionFactIds,
    scheduledTaskIds,
    retainedScheduledTaskIds,
    workflowIds,
    workflowExecutionIds,
    kimiSeats,
    quiescenceTargets,
    completedQuiescenceTargetIds,
    completedSteps,
    failures
  }
}

function readHistoryDeletionIntent(): HistoryDeletionIntent | null {
  const value = readJsonStrictIfPresent(historyDeletionIntentPath)
  return value === null ? null : normalizeHistoryDeletionIntent(value)
}

async function readHistoryDeletionIntentAsync(): Promise<HistoryDeletionIntent | null> {
  try {
    const raw = await fs.promises.readFile(historyDeletionIntentPath, 'utf-8')
    return normalizeHistoryDeletionIntent(JSON.parse(raw) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
    throw error
  }
}

function assertHistoryMutationAdmission(
  input: HistoryMutationAdmissionInput,
  intent: HistoryDeletionIntent
): void {
  const chatIds = new Set(
    (input.chatIds || []).filter(
      (value): value is string => typeof value === 'string' && Boolean(value)
    )
  )
  const workspaceIds = new Set(
    (input.workspaceIds || []).filter(
      (value): value is string => typeof value === 'string' && Boolean(value)
    )
  )
  const runIds = new Set(
    (input.runIds || []).filter(
      (value): value is string => typeof value === 'string' && Boolean(value)
    )
  )
  const missionIds = new Set(
    (input.missionIds || []).filter(
      (value): value is string => typeof value === 'string' && Boolean(value)
    )
  )
  const blocked =
    intent.kind === 'global' ||
    (intent.kind === 'workspace' &&
      Boolean(intent.workspaceId && workspaceIds.has(intent.workspaceId))) ||
    intent.chatIds.some((chatId) => chatIds.has(chatId)) ||
    intent.runIds.some((runId) => runIds.has(runId)) ||
    intent.missionFactIds.some((missionId) => missionIds.has(missionId))

  if (blocked) {
    throw new HistoryDeletionMutationBlockedError(
      intent.operationId,
      intent.kind,
      input.operation || 'History mutation'
    )
  }
}

function writeHistoryDeletionIntent(intent: HistoryDeletionIntent): void {
  writeJson(historyDeletionIntentPath, normalizeHistoryDeletionIntent(intent))
}

function removePathStrict(targetPath: string, label: string): void {
  fs.rmSync(targetPath, { recursive: true, force: true })
  if (fs.existsSync(targetPath)) throw new Error(`${label} still exists after deletion.`)
}

function removePathsStrict(targets: Array<{ targetPath: string; label: string }>): void {
  const failures: Error[] = []
  for (const target of targets) {
    try {
      removePathStrict(target.targetPath, target.label)
    } catch (error) {
      failures.push(new Error(`${target.label}: ${historyDeletionErrorMessage(error)}`))
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to remove ${failures.length} history target(s).`)
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function historyRecordMatches(
  value: unknown,
  intent: HistoryDeletionIntent,
  options: { includeRunIds?: boolean } = {}
): boolean {
  if (intent.kind === 'global') return true
  const record = objectRecord(value)
  if (!record) return false
  const chatIds = new Set(intent.chatIds)
  const recordChatIds = [record.chatId, record.parentChatId, record.subThreadId].filter(
    (value): value is string => typeof value === 'string'
  )
  if (recordChatIds.length > 0) {
    // A direct chat owner is stronger than a run id. This avoids deleting a
    // sibling record when legacy/test data reused a run id across chats.
    if (recordChatIds.some((chatId) => chatIds.has(chatId))) return true
    if (
      intent.kind === 'workspace' &&
      typeof record.workspaceId === 'string' &&
      record.workspaceId === intent.workspaceId
    ) {
      return true
    }
    return false
  }
  if (
    intent.kind === 'workspace' &&
    typeof record.workspaceId === 'string' &&
    record.workspaceId === intent.workspaceId
  ) {
    return true
  }
  return Boolean(
    recordChatIds.length === 0 &&
    options.includeRunIds !== false &&
    typeof record.runId === 'string' &&
    new Set(intent.runIds).has(record.runId)
  )
}

// run-events/ is append-only and nothing prunes it, so the scoped-deletion
// reconciliation sweep below grew unbounded: measured at 75.3s across a 15.5 GB
// / 8,441-file corpus, on the main thread, for a single deleted chat. These two
// bounds cut that work without narrowing what the sweep can find — an erasure
// path may only ever get faster, never less complete.

/**
 * A run event naming a chat cannot have been written before that chat existed,
 * so a file last modified before the earliest in-scope chat was created cannot
 * reference any of them. The margin absorbs clock skew and coarse timestamps.
 */
const HISTORY_DELETION_RUN_EVENT_MTIME_MARGIN_MS = 7 * 24 * 60 * 60 * 1000

/** `JSON.stringify` escapes none of these, so such an id survives verbatim into the ledger bytes. */
const JSON_VERBATIM_IDENTITY = /^[A-Za-z0-9._:-]+$/

/**
 * Identity strings whose literal presence is a precondition for
 * {@link historyRecordMatches} to return true under `includeRunIds: false`:
 * that call can only match on `chatId`/`parentChatId`/`subThreadId` against
 * `intent.chatIds`, or on `workspaceId` for a workspace clear. A ledger file
 * containing none of these bytes therefore has no matching row.
 *
 * Returns null when the probe cannot be proven sound, which keeps the caller on
 * the exhaustive parse.
 */
function historyDeletionIdentityNeedles(intent: HistoryDeletionIntent): Buffer[] | null {
  if (intent.kind === 'global') return null
  const ids = [...intent.chatIds]
  if (intent.kind === 'workspace' && typeof intent.workspaceId === 'string' && intent.workspaceId) {
    ids.push(intent.workspaceId)
  }
  if (ids.length === 0) return null
  // A single id that JSON could escape makes the byte probe unsound for the
  // whole pass, so fall back rather than guess at the encoded form.
  if (!ids.every((id) => JSON_VERBATIM_IDENTITY.test(id))) return null
  return ids.map((id) => Buffer.from(id, 'utf8'))
}

/**
 * Earliest mtime a ledger file may have and still be able to reference the
 * deletion scope. Null disables the bound — required whenever any in-scope id
 * has no readable record (its chat file may already be gone, or the id may come
 * from the list index alone), since such a chat's age is unknown.
 */
function historyDeletionRunEventMtimeFloorMs(
  chats: ChatRecord[],
  chatIds: Set<string>
): number | null {
  const resolved = new Set<string>()
  let floorMs: number | null = null
  for (const chat of chats) {
    if (!chatIds.has(chat.appChatId)) continue
    // ChatRecord.createdAt is epoch milliseconds. Legacy records have been seen
    // holding an ISO string, and a placeholder `0`/`1` carries no real age, so
    // anything that is not a usable positive instant disables the bound.
    const raw: unknown = chat.createdAt
    const createdMs =
      typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN
    if (!Number.isFinite(createdMs) || createdMs <= 0) return null
    resolved.add(chat.appChatId)
    floorMs = floorMs === null ? createdMs : Math.min(floorMs, createdMs)
  }
  if (floorMs === null) return null
  for (const chatId of chatIds) {
    if (!resolved.has(chatId)) return null
  }
  return floorMs - HISTORY_DELETION_RUN_EVENT_MTIME_MARGIN_MS
}

/**
 * `previewHistoryDeletionScope` and `prepareHistoryDeletion` are contractually
 * invoked in the same synchronous stack, and ScopedHistoryDeletionCoordinator
 * does exactly that: resolveChatIds, listProviderRuns and prepare run back to
 * back with no await between them, so quiescence cannot land new events in the
 * gap. The ledger sweep between the two is therefore identical work over
 * identical bytes — and it is the expensive half.
 *
 * Memoise only the sweep's own contribution, never the intent, so operationId
 * and timestamps stay freshly minted. Keyed by the full identity scope and
 * expiring almost at once: any miss simply recomputes, so the worst case is the
 * behaviour this replaces.
 */
const HISTORY_DELETION_LEDGER_SWEEP_TTL_MS = 2_000
let historyDeletionLedgerSweepMemo: {
  key: string
  runIds: string[]
  atMs: number
} | null = null

function historyDeletionLedgerSweepKey(intent: HistoryDeletionIntent): string {
  return JSON.stringify({
    kind: intent.kind,
    workspaceId: intent.workspaceId ?? null,
    chatIds: [...intent.chatIds].sort()
  })
}

function readHistoryDeletionLedgerSweep(key: string): string[] | null {
  const memo = historyDeletionLedgerSweepMemo
  if (!memo || memo.key !== key) return null
  if (Date.now() - memo.atMs > HISTORY_DELETION_LEDGER_SWEEP_TTL_MS) {
    historyDeletionLedgerSweepMemo = null
    return null
  }
  return memo.runIds
}

/** Exposed for tests that need the sweep to run again from cold. */
export function resetHistoryDeletionLedgerSweepMemoForTests(): void {
  historyDeletionLedgerSweepMemo = null
}

/**
 * Byte-level probe for any of {@link historyDeletionIdentityNeedles}. Reads raw
 * Buffers in bounded chunks, carrying an overlap so a needle straddling a chunk
 * boundary still matches, and never materialises the utf8 string or per-line
 * splits that dominated the profile. Fails open: an unreadable probe returns
 * true so the caller parses the file instead of skipping it.
 */
function runEventFileContainsIdentity(filePath: string, needles: Buffer[]): boolean {
  const longest = needles.reduce((max, needle) => Math.max(max, needle.length), 0)
  if (longest === 0) return true
  const chunkBytes = 1 << 20
  const overlap = longest - 1
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const buffer = Buffer.allocUnsafe(chunkBytes + overlap)
    let carried = 0
    for (;;) {
      const read = fs.readSync(fd, buffer, carried, chunkBytes, null)
      if (read <= 0) return false
      const filled = carried + read
      const window = buffer.subarray(0, filled)
      for (const needle of needles) {
        if (window.includes(needle)) return true
      }
      carried = Math.min(overlap, filled)
      if (carried > 0) buffer.copy(buffer, 0, filled - carried, filled)
    }
  } catch {
    return true
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Already closed or gone; the probe result stands.
      }
    }
  }
}

function rewriteArrayHistoryStore(
  filePath: string,
  label: string,
  intent: HistoryDeletionIntent
): void {
  if (intent.kind === 'global') {
    removePathStrict(filePath, label)
    return
  }
  const stored = readJsonStrictIfPresent(filePath)
  if (stored === null) return
  if (!Array.isArray(stored)) throw new Error(`${label} is not an array.`)
  const retained = stored.filter((record) => !historyRecordMatches(record, intent))
  if (retained.length === 0) {
    removePathStrict(filePath, label)
  } else if (retained.length !== stored.length) {
    writeJson(filePath, retained)
  }
  const verified = readJsonStrictIfPresent(filePath)
  if (verified !== null) {
    if (
      !Array.isArray(verified) ||
      verified.some((record) => historyRecordMatches(record, intent))
    ) {
      throw new Error(`${label} still contains records owned by the deletion scope.`)
    }
  }
}

function chatContainsTruncatableHistory(chat: ChatRecord): boolean {
  const ensemble = chat.ensemble
  const delegation = chat.delegationContext
  return Boolean(
    chat.messages.length > 0 ||
    chat.runs.length > 0 ||
    chat.linkedProviderSessionId ||
    chat.linkedGeminiSessionId ||
    chat.taskWraithMcpProfileReceipt ||
    chat.seatGeneration ||
    chat.contextCompactionSummary ||
    chat.activeGoal ||
    chat.chatTodos ||
    chat.soloWakeups ||
    chat.ollamaSessionMemory ||
    chat.ollamaSessionMemories ||
    delegation ||
    ensemble?.activeRound ||
    ensemble?.workSession ||
    ensemble?.sessionActivityLedger ||
    ensemble?.bossmanControlState ||
    ensemble?.lastRoundSummary ||
    ensemble?.roundSummaries ||
    ensemble?.wakeups ||
    ensemble?.blackboard ||
    ensemble?.escalationSignals ||
    ensemble?.participants.some(
      (participant) =>
        participant.linkedProviderSessionId ||
        participant.taskWraithMcpProfileReceipt ||
        participant.seatGeneration ||
        participant.contextCompactionSummary ||
        participant.promptShellVersion ||
        participant.promptDynamicStateVersion ||
        participant.tokenTotals ||
        participant.kimiAcpNativeSession ||
        participant.kimiAcpPostureVersion
    )
  )
}

function normalizedScheduledRunIdTombstone(value: unknown): ScheduledRunIdTombstoneRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<ScheduledRunIdTombstoneRecord>
  const keys = Object.keys(value).sort()
  const expectedKeys = [
    'hash',
    'kind',
    'prevHash',
    'recordedAt',
    'rootRunId',
    'runId',
    'schemaVersion',
    'sequence',
    'taskId'
  ]
  if (!isDeepStrictEqual(keys, expectedKeys)) return null
  const runId = typeof candidate.runId === 'string' ? candidate.runId : ''
  const rootRunId = typeof candidate.rootRunId === 'string' ? candidate.rootRunId : ''
  const taskId = typeof candidate.taskId === 'string' ? candidate.taskId : ''
  const recordedAt = typeof candidate.recordedAt === 'string' ? candidate.recordedAt : ''
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.sequence) ||
    (candidate.sequence as number) < 1 ||
    !runId ||
    runId !== runId.trim() ||
    runId.length > SCHEDULED_RUN_ID_TOMBSTONE_MAX_ID_CHARS ||
    !rootRunId ||
    rootRunId !== rootRunId.trim() ||
    rootRunId.length > SCHEDULED_RUN_ID_TOMBSTONE_MAX_ID_CHARS ||
    !taskId ||
    taskId !== taskId.trim() ||
    taskId.length > SCHEDULED_RUN_ID_TOMBSTONE_MAX_ID_CHARS ||
    !Number.isFinite(Date.parse(recordedAt)) ||
    new Date(Date.parse(recordedAt)).toISOString() !== recordedAt ||
    (candidate.prevHash !== null &&
      (typeof candidate.prevHash !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.prevHash))) ||
    typeof candidate.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.hash) ||
    (candidate.kind !== 'root' &&
      candidate.kind !== 'loop-child' &&
      candidate.kind !== 'ensemble-child')
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    sequence: candidate.sequence as number,
    runId,
    rootRunId,
    taskId,
    kind: candidate.kind,
    recordedAt,
    prevHash: candidate.prevHash,
    hash: candidate.hash
  }
}

function scheduledRunIdTombstoneHash(record: Omit<ScheduledRunIdTombstoneRecord, 'hash'>): string {
  return createHash('sha256')
    .update(
      'TaskWraith:scheduled-run-id-tombstone:v1\0' +
        JSON.stringify({
          schemaVersion: record.schemaVersion,
          sequence: record.sequence,
          runId: record.runId,
          rootRunId: record.rootRunId,
          taskId: record.taskId,
          kind: record.kind,
          recordedAt: record.recordedAt,
          prevHash: record.prevHash
        })
    )
    .digest('hex')
}

function sameScheduledRunIdTombstoneIdentity(
  left: ScheduledRunIdTombstoneRecord,
  right: ScheduledRunIdTombstoneRecord
): boolean {
  return (
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.taskId === right.taskId &&
    left.kind === right.kind
  )
}

function scheduledRunIdTombstoneFileStat(): fs.Stats | null {
  try {
    const stat = fs.lstatSync(scheduledRunIdTombstonesPath)
    if (!stat.isFile()) {
      throw new Error('Scheduled run-id tombstone ledger must be a regular file.')
    }
    return stat
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function openScheduledRunIdTombstoneFile(flags: number, mode?: number): number {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  const nonBlocking = fs.constants.O_NONBLOCK ?? 0
  const descriptor = fs.openSync(scheduledRunIdTombstonesPath, flags | noFollow | nonBlocking, mode)
  const stat = fs.fstatSync(descriptor)
  if (!stat.isFile()) {
    fs.closeSync(descriptor)
    throw new Error('Scheduled run-id tombstone ledger descriptor is not a regular file.')
  }
  return descriptor
}

function readScheduledRunIdTombstones(): Map<string, ScheduledRunIdTombstoneRecord> {
  const stat = scheduledRunIdTombstoneFileStat()
  if (!stat) {
    scheduledRunIdTombstoneCache = null
    return new Map()
  }
  if (stat.size > SCHEDULED_RUN_ID_TOMBSTONE_MAX_BYTES) {
    throw new Error('Scheduled run-id tombstone ledger exceeds its safe storage boundary.')
  }
  if (
    scheduledRunIdTombstoneCache &&
    scheduledRunIdTombstoneCache.dev === stat.dev &&
    scheduledRunIdTombstoneCache.ino === stat.ino &&
    scheduledRunIdTombstoneCache.ctimeMs === stat.ctimeMs &&
    scheduledRunIdTombstoneCache.mtimeMs === stat.mtimeMs &&
    scheduledRunIdTombstoneCache.size === stat.size
  ) {
    return scheduledRunIdTombstoneCache.records
  }
  let descriptor: number | null = null
  let raw: string
  try {
    descriptor = openScheduledRunIdTombstoneFile(fs.constants.O_RDONLY)
    const openedStat = fs.fstatSync(descriptor)
    if (
      openedStat.dev !== stat.dev ||
      openedStat.ino !== stat.ino ||
      openedStat.size !== stat.size
    ) {
      throw new Error('Scheduled run-id tombstone ledger changed while it was being opened.')
    }
    raw = fs.readFileSync(descriptor, 'utf8')
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
  if (raw.length > 0 && !raw.endsWith('\n')) {
    throw new Error('Scheduled run-id tombstone ledger has an incomplete durable tail.')
  }
  const records = new Map<string, ScheduledRunIdTombstoneRecord>()
  let lastHash: string | null = null
  const lines = raw.length === 0 ? [] : raw.slice(0, -1).split('\n')
  if (lines.some((line) => line.length === 0)) {
    throw new Error('Scheduled run-id tombstone ledger contains an empty record.')
  }
  for (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > SCHEDULED_RUN_ID_TOMBSTONE_MAX_LINE_BYTES) {
      throw new Error('Scheduled run-id tombstone ledger contains an oversized record.')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('Scheduled run-id tombstone ledger contains invalid JSON.')
    }
    const record = normalizedScheduledRunIdTombstone(parsed)
    if (!record) {
      throw new Error('Scheduled run-id tombstone ledger contains an invalid record.')
    }
    if (JSON.stringify(record) !== line) {
      throw new Error('Scheduled run-id tombstone ledger contains a non-canonical record.')
    }
    if (
      record.sequence !== records.size + 1 ||
      record.prevHash !== lastHash ||
      scheduledRunIdTombstoneHash({
        schemaVersion: record.schemaVersion,
        sequence: record.sequence,
        runId: record.runId,
        rootRunId: record.rootRunId,
        taskId: record.taskId,
        kind: record.kind,
        recordedAt: record.recordedAt,
        prevHash: record.prevHash
      }) !== record.hash
    ) {
      throw new Error('Scheduled run-id tombstone ledger hash chain is invalid.')
    }
    if (records.has(record.runId)) {
      throw new Error('Scheduled run-id tombstone ledger contains a duplicate run id.')
    }
    if (record.kind === 'root') {
      if (record.runId !== record.rootRunId) {
        throw new Error('Scheduled run-id tombstone root identity is invalid.')
      }
    } else {
      const root = records.get(record.rootRunId)
      if (
        record.runId === record.rootRunId ||
        !root ||
        root.kind !== 'root' ||
        root.taskId !== record.taskId
      ) {
        throw new Error('Scheduled run-id tombstone child has no matching prior root.')
      }
    }
    if (records.size >= SCHEDULED_RUN_ID_TOMBSTONE_MAX_RECORDS) {
      throw new Error('Scheduled run-id tombstone ledger exceeds its safe record boundary.')
    }
    records.set(record.runId, record)
    lastHash = record.hash
  }
  scheduledRunIdTombstoneCache = {
    dev: stat.dev,
    ino: stat.ino,
    ctimeMs: stat.ctimeMs,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    lastSequence: records.size,
    lastHash,
    records
  }
  return records
}

function appendScheduledRunIdTombstone(record: ScheduledRunIdTombstoneRecord): void {
  const records = readScheduledRunIdTombstones()
  const existing = records.get(record.runId)
  if (existing) {
    if (!sameScheduledRunIdTombstoneIdentity(existing, record)) {
      throw new Error('Scheduled run id is already bound to another occurrence.')
    }
    return
  }
  if (records.size >= SCHEDULED_RUN_ID_TOMBSTONE_MAX_RECORDS) {
    throw new Error('Scheduled run-id tombstone ledger reached its safe record boundary.')
  }
  if (record.kind !== 'root') {
    const root = records.get(record.rootRunId)
    if (!root || root.kind !== 'root' || root.taskId !== record.taskId) {
      throw new Error('Scheduled child run id requires its durable root tombstone first.')
    }
  }
  const directoryPath = path.dirname(scheduledRunIdTombstonesPath)
  const fileExisted = scheduledRunIdTombstoneCache !== null
  fs.mkdirSync(directoryPath, { recursive: true })
  const prevHash = scheduledRunIdTombstoneCache?.lastHash ?? null
  const sequence = (scheduledRunIdTombstoneCache?.lastSequence ?? 0) + 1
  const unsigned = { ...record, sequence, prevHash }
  const durableRecord: ScheduledRunIdTombstoneRecord = {
    ...unsigned,
    hash: scheduledRunIdTombstoneHash(unsigned)
  }
  const serialized = `${JSON.stringify(durableRecord)}\n`
  const serializedBytes = Buffer.byteLength(serialized, 'utf8')
  const previousSize = scheduledRunIdTombstoneCache?.size ?? 0
  if (
    serializedBytes > SCHEDULED_RUN_ID_TOMBSTONE_MAX_LINE_BYTES ||
    previousSize + serializedBytes > SCHEDULED_RUN_ID_TOMBSTONE_MAX_BYTES
  ) {
    throw new Error('Scheduled run-id tombstone ledger reached its safe byte boundary.')
  }
  let descriptor: number | null = null
  let appendedStat: fs.Stats | null = null
  try {
    descriptor = openScheduledRunIdTombstoneFile(
      fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR,
      0o600
    )
    const openedStat = fs.fstatSync(descriptor)
    if (
      openedStat.size !== previousSize ||
      (fileExisted &&
        (openedStat.dev !== scheduledRunIdTombstoneCache?.dev ||
          openedStat.ino !== scheduledRunIdTombstoneCache?.ino))
    ) {
      throw new Error('Scheduled run-id tombstone ledger changed before append.')
    }
    fs.writeFileSync(descriptor, serialized, 'utf8')
    fs.fsyncSync(descriptor)
    try {
      fs.fchmodSync(descriptor, 0o600)
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
    appendedStat = fs.fstatSync(descriptor)
    if (appendedStat.size !== previousSize + serializedBytes) {
      throw new Error('Scheduled run-id tombstone append changed the unexpected file extent.')
    }
    const tail = Buffer.alloc(serializedBytes)
    const bytesRead = fs.readSync(
      descriptor,
      tail,
      0,
      serializedBytes,
      appendedStat.size - serializedBytes
    )
    if (bytesRead !== serializedBytes || tail.toString('utf8') !== serialized) {
      throw new Error('Scheduled run-id tombstone durable tail verification failed.')
    }
    if (!fileExisted && process.platform !== 'win32') {
      // Windows maps fsync to FlushFileBuffers, which rejects directory
      // handles with EPERM — skip the directory barrier there (matches
      // ScheduledOccurrenceAuthorityRootStore's platform guard).
      let directoryDescriptor: number | null = null
      try {
        directoryDescriptor = fs.openSync(directoryPath, 'r')
        fs.fsyncSync(directoryDescriptor)
      } finally {
        if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor)
      }
    }
    const pathStat = scheduledRunIdTombstoneFileStat()
    if (
      !pathStat ||
      pathStat.dev !== appendedStat.dev ||
      pathStat.ino !== appendedStat.ino ||
      pathStat.size !== appendedStat.size
    ) {
      throw new Error('Scheduled run-id tombstone ledger changed after append.')
    }
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
  if (!appendedStat) {
    throw new Error('Scheduled run-id tombstone ledger append was not verified.')
  }
  records.set(durableRecord.runId, durableRecord)
  scheduledRunIdTombstoneCache = {
    dev: appendedStat.dev,
    ino: appendedStat.ino,
    ctimeMs: appendedStat.ctimeMs,
    mtimeMs: appendedStat.mtimeMs,
    size: appendedStat.size,
    lastSequence: durableRecord.sequence,
    lastHash: durableRecord.hash,
    records
  }
  const persisted = scheduledRunIdTombstoneCache.records.get(record.runId)
  if (!persisted || !sameScheduledRunIdTombstoneIdentity(persisted, durableRecord)) {
    throw new Error('Scheduled run-id tombstone could not be verified durably.')
  }
}

function writeScheduledOccurrenceJsonStrict<T>(filePath: string, data: T): void {
  const directoryPath = path.dirname(filePath)
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.wal.tmp`
  let renamed = false
  fs.mkdirSync(directoryPath, { recursive: true })
  try {
    let fileDescriptor: number | null = null
    try {
      fileDescriptor = fs.openSync(tempPath, 'w', 0o600)
      fs.writeFileSync(fileDescriptor, JSON.stringify(data, null, 2), 'utf-8')
      fs.fsyncSync(fileDescriptor)
    } finally {
      if (fileDescriptor !== null) fs.closeSync(fileDescriptor)
    }
    fs.renameSync(tempPath, filePath)
    renamed = true
    try {
      fs.chmodSync(filePath, 0o600)
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
    if (process.platform !== 'win32') {
      // Directory fsync EPERMs on Windows (FlushFileBuffers rejects
      // directory handles); the rename above is the publication point there.
      let directoryDescriptor: number | null = null
      try {
        directoryDescriptor = fs.openSync(directoryPath, 'r')
        fs.fsyncSync(directoryDescriptor)
      } finally {
        if (directoryDescriptor !== null) fs.closeSync(directoryDescriptor)
      }
    }
  } catch (error) {
    if (!renamed) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
      } catch {
        // Preserve the strict write failure; a stale temp file is not authoritative.
      }
    }
    throw error
  }
}

type ScheduledOccurrenceMutationJournalRead =
  | { status: 'none' }
  | { status: 'ready'; intent: ScheduledOccurrenceMutationIntent }
  | { status: 'blocked'; reason: string }

function readScheduledOccurrenceMutationJournal(): ScheduledOccurrenceMutationJournalRead {
  if (scheduledOccurrenceDurabilityFailureIntent) {
    return {
      status: 'ready',
      intent: cloneJsonValue(scheduledOccurrenceDurabilityFailureIntent)
    }
  }
  if (!fs.existsSync(scheduledOccurrenceMutationsPath)) return { status: 'none' }
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(scheduledOccurrenceMutationsPath, 'utf-8'))
  } catch {
    return { status: 'blocked', reason: 'Scheduled occurrence mutation journal is unreadable.' }
  }
  if (value === null) return { status: 'none' }
  const intent = decodeScheduledOccurrenceMutationIntent(
    value,
    LEGACY_STORE_MUTATION_VALIDATION_POLICY
  )
  if (!intent) {
    return { status: 'blocked', reason: 'Scheduled occurrence mutation journal is invalid.' }
  }
  return { status: 'ready', intent }
}

function assertNoPendingScheduledOccurrenceMutation(): void {
  const journal = readScheduledOccurrenceMutationJournal()
  if (journal.status === 'none') return
  throw new Error(
    journal.status === 'blocked'
      ? journal.reason
      : 'Scheduled occurrence mutation recovery is pending.'
  )
}

function readScheduledTasksForHistoryDeletionStrict(): ScheduledTask[] {
  const value = readJsonStrictIfPresent(scheduledTasksPath)
  if (value === null) return []
  if (!Array.isArray(value)) throw new Error('Scheduled task store is not an array.')
  const ids = new Set<string>()
  return value.map((candidate) => {
    const task = objectRecord(candidate)
    if (
      !task ||
      !isNonEmptyTrimmedString(task.id) ||
      ids.has(task.id) ||
      !isSafeChatId(task.chatId) ||
      !isNonEmptyTrimmedString(task.workspaceId) ||
      typeof task.prompt !== 'string' ||
      !['pending', 'due', 'running', 'completed', 'failed', 'cancelled'].includes(
        String(task.status)
      )
    ) {
      throw new Error('Scheduled task store contains an invalid or duplicate record.')
    }
    ids.add(task.id)
    return candidate as ScheduledTask
  })
}

function readWorkflowsForHistoryDeletionStrict(): WorkflowDefinition[] {
  if (!fs.existsSync(workflowsPath)) return []
  const records = readScheduledOccurrenceWorkflowRecordsStrict()
  if (!records) throw new Error('Workflow definition store is not a canonical record set.')
  return records.normalized
}

function occurrenceRecordState<T extends { id: string }>(
  records: T[],
  id: string,
  before: T | null,
  after: T
): { status: 'before' | 'after'; index: number } | { status: 'blocked'; reason: string } {
  const indexes = records
    .map((record, index) => (record.id === id ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length > 1) {
    return { status: 'blocked', reason: `Scheduled occurrence record ${id} is duplicated.` }
  }
  if (indexes.length === 0) {
    return before === null
      ? { status: 'before', index: -1 }
      : { status: 'blocked', reason: `Scheduled occurrence record ${id} is missing.` }
  }
  const index = indexes[0]
  if (sameJsonValue(records[index], after)) return { status: 'after', index }
  if (before && sameJsonValue(records[index], before)) return { status: 'before', index }
  return {
    status: 'blocked',
    reason: `Scheduled occurrence record ${id} no longer matches its journal images.`
  }
}

function scheduledOccurrenceMutationWriteOrderReason(
  intent: ScheduledOccurrenceMutationIntent,
  taskState: 'before' | 'after',
  workflowState: 'before' | 'after',
  ledgerState: 'before' | 'after'
): string | null {
  const projectionState = `${taskState}/${workflowState}`
  if (intent.kind === 'materialize') {
    return projectionState === 'before/before' ||
      projectionState === 'after/before' ||
      projectionState === 'after/after'
      ? null
      : 'Scheduled occurrence WAL projections are not a valid write-order prefix.'
  }
  const lifecycleState = `${projectionState}/${ledgerState}`
  return lifecycleState === 'before/before/before' ||
    lifecycleState === 'after/before/before' ||
    lifecycleState === 'after/after/before' ||
    lifecycleState === 'after/after/after'
    ? null
    : 'Scheduled occurrence WAL projections are not a valid write-order prefix.'
}

interface ScheduledOccurrenceWorkflowRecordSet {
  raw: Array<{ id: string }>
  normalized: WorkflowDefinition[]
}

function readScheduledOccurrenceWorkflowRecordsStrict(): ScheduledOccurrenceWorkflowRecordSet | null {
  try {
    const value = JSON.parse(fs.readFileSync(workflowsPath, 'utf-8')) as unknown
    if (!Array.isArray(value)) return null
    const ids = new Set<string>()
    const raw: Array<{ id: string }> = []
    const workflows: WorkflowDefinition[] = []
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
      const input = candidate as Partial<WorkflowDefinition>
      if (
        !isNonEmptyTrimmedString(input.id) ||
        ids.has(input.id) ||
        !Array.isArray(input.history) ||
        input.history.some(
          (execution) => !execution || typeof execution !== 'object' || Array.isArray(execution)
        )
      ) {
        return null
      }
      const workflow = normalizeWorkflowDefinitionRecord(input, Date.now())
      const fullHistory = input.history
        .map((execution) => normalizeWorkflowExecutionRecord(execution, input.id as string))
        .filter((execution): execution is WorkflowExecutionRecord => Boolean(execution))
      if (
        !workflow ||
        fullHistory.length !== input.history.length ||
        fullHistory.some((execution, index) => !sameJsonValue(execution, input.history?.[index]))
      ) {
        return null
      }
      workflow.history = fullHistory
      ids.add(input.id)
      raw.push(candidate as { id: string })
      workflows.push(workflow)
    }
    return { raw, normalized: workflows }
  } catch {
    return null
  }
}

function canonicalizeScheduledOccurrenceWorkflowSource(
  expected: WorkflowDefinition
): WorkflowDefinition | null {
  try {
    const value = JSON.parse(fs.readFileSync(workflowsPath, 'utf-8')) as unknown
    if (!Array.isArray(value)) return null
    const ids = new Set<string>()
    let targetIndex = -1
    for (let index = 0; index < value.length; index += 1) {
      const candidate = value[index]
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
      const id = (candidate as { id?: unknown }).id
      if (!isNonEmptyTrimmedString(id) || ids.has(id)) return null
      ids.add(id)
      if (id === expected.id) targetIndex = index
    }
    if (targetIndex < 0) return null
    const candidate = value[targetIndex] as Partial<WorkflowDefinition>
    if (!Array.isArray(candidate.history)) return null
    const normalizationAt =
      canonicalIsoTimestampMs(expected.updatedAt) ??
      canonicalIsoTimestampMs(expected.createdAt) ??
      Date.now()
    const normalized = normalizeWorkflowDefinitionRecord(candidate, normalizationAt)
    const fullHistory = candidate.history
      .map((execution) => normalizeWorkflowExecutionRecord(execution, expected.id))
      .filter((execution): execution is WorkflowExecutionRecord => Boolean(execution))
    if (
      !normalized ||
      fullHistory.length !== candidate.history.length ||
      fullHistory.some((execution, index) => !sameJsonValue(execution, candidate.history?.[index]))
    ) {
      return null
    }
    normalized.history = fullHistory
    if (!sameJsonValue(normalized, expected)) return null
    if (!sameJsonValue(candidate, expected)) {
      value[targetIndex] = cloneJsonValue(expected)
      writeScheduledOccurrenceJsonStrict(workflowsPath, value)
    }
    return cloneJsonValue(expected)
  } catch {
    return null
  }
}

function validateCurrentRunOwnerReferences(
  intent: ScheduledOccurrenceMutationIntent,
  tasks: ScheduledTask[],
  workflows: WorkflowDefinition[]
): string | null {
  const taskIdRefs = tasks.filter((task) => task.id === intent.identity.taskId)
  const taskExecutionRefs = tasks.filter(
    (task) => task.workflowExecutionId === intent.identity.executionId
  )
  const executionIdRefs = workflows.flatMap((workflow) =>
    workflow.history
      .filter((execution) => execution.id === intent.identity.executionId)
      .map((execution) => ({ workflow, execution }))
  )
  const executionTaskRefs = workflows.flatMap((workflow) =>
    workflow.history
      .filter((execution) => execution.scheduledTaskId === intent.identity.taskId)
      .map((execution) => ({ workflow, execution }))
  )
  const activeExecutionRefs = workflows.filter(
    (workflow) => workflow.activeExecutionId === intent.identity.executionId
  )
  const expectedEstablishedCount = intent.kind === 'materialize' ? null : 1
  if (
    taskIdRefs.length > 1 ||
    taskExecutionRefs.length > 1 ||
    executionIdRefs.length > 1 ||
    executionTaskRefs.length > 1 ||
    activeExecutionRefs.length > 1 ||
    taskIdRefs.length !== taskExecutionRefs.length ||
    executionIdRefs.length !== executionTaskRefs.length ||
    (expectedEstablishedCount !== null &&
      (taskIdRefs.length !== expectedEstablishedCount ||
        executionIdRefs.length !== expectedEstablishedCount)) ||
    (intent.kind === 'materialize' && activeExecutionRefs.length !== executionIdRefs.length) ||
    (intent.kind === 'claim' && activeExecutionRefs.length !== 1) ||
    activeExecutionRefs.some((workflow) => workflow.id !== intent.identity.workflowId) ||
    taskIdRefs.some((task) => !taskMatchesOccurrenceIdentity(task, intent.identity)) ||
    taskExecutionRefs.some((task) => !taskMatchesOccurrenceIdentity(task, intent.identity)) ||
    executionIdRefs.some(
      ({ workflow, execution }) =>
        workflow.id !== intent.identity.workflowId ||
        !workflowExecutionMatchesIdentity(execution, intent.identity)
    ) ||
    executionTaskRefs.some(
      ({ workflow, execution }) =>
        workflow.id !== intent.identity.workflowId ||
        !workflowExecutionMatchesIdentity(execution, intent.identity)
    )
  ) {
    return 'Scheduled occurrence task or execution owner is duplicated or belongs to another occurrence.'
  }
  const runId = intent.identity.runId
  if (!runId) return null
  const taskRefs = tasks.filter((task) => task.runId === runId)
  const executionRefs = workflows.flatMap((workflow) =>
    workflow.history
      .filter((execution) => execution.runId === runId)
      .map((execution) => ({ workflow, execution }))
  )
  if (
    taskRefs.length > 1 ||
    executionRefs.length > 1 ||
    taskRefs.some((task) => !taskMatchesOccurrenceIdentity(task, intent.identity)) ||
    executionRefs.some(
      ({ workflow, execution }) =>
        workflow.id !== intent.identity.workflowId ||
        !workflowExecutionMatchesIdentity(execution, intent.identity)
    )
  ) {
    return `Run owner ${runId} is duplicated or belongs to another occurrence.`
  }
  if (intent.kind === 'settle' && (taskRefs.length !== 1 || executionRefs.length !== 1)) {
    return `Run owner ${runId} is not established on both occurrence projections.`
  }
  return null
}

function readSubThreadMailboxLedger(): SubThreadMailboxLedger {
  return normalizeSubThreadMailboxLedger(readJson<unknown>(subThreadMailboxesPath, {}))
}

function writeSubThreadMailboxLedger(ledger: SubThreadMailboxLedger): void {
  writeJson(subThreadMailboxesPath, normalizeSubThreadMailboxLedger(ledger))
}

function readExecutionResultMailboxLedger(): ExecutionResultMailboxLedger {
  return normalizeExecutionResultMailboxLedger(readJson<unknown>(executionResultMailboxesPath, {}))
}

function writeExecutionResultMailboxLedger(ledger: ExecutionResultMailboxLedger): void {
  writeJson(executionResultMailboxesPath, normalizeExecutionResultMailboxLedger(ledger))
}

function readThreadMessageLedger(): ThreadMessageLedger {
  return normalizeThreadMessageLedger(readJson<unknown>(threadMessagesPath, {}))
}

function writeThreadMessageLedger(ledger: ThreadMessageLedger): void {
  writeJson(threadMessagesPath, normalizeThreadMessageLedger(ledger))
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

function normalizeChatWorkflowMode(value: unknown): ChatWorkflowMode {
  return value === 'plan' ? 'plan' : 'normal'
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
    workflowMode: run.workflowMode,
    status: run.status,
    cancelled: run.cancelled,
    exitCode: run.exitCode,
    runtimeProfileId: run.runtimeProfileId,
    geminiAuthProfileId: run.geminiAuthProfileId,
    ensembleRoundId: run.ensembleRoundId,
    ensembleParticipantId: run.ensembleParticipantId,
    ensembleLaneId: run.ensembleLaneId,
    ensembleRole: run.ensembleRole,
    ensembleStageRole: run.ensembleStageRole,
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
      const legacySettings = JSON.parse(fs.readFileSync(legacySettingsPath, 'utf-8')) as
        | (Partial<AppSettings> & Record<string, unknown>)
        | null
      writeJson(
        settingsPath,
        stripRetiredSettingsKeys({
          ...(legacySettings || {}),
          geminiMcpBridgeLastStatus: undefined
        })
      )
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
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT')
      console.error(`Failed to read ${filePath}`, e)
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

interface StrictWorkflowRunLedgerRead {
  events: WorkflowRunEvent[]
  committedBytes: Buffer
  committedByteLength: number
  fileExisted: boolean
  hasTornTail: boolean
}

const WORKFLOW_RUN_LEDGER_EVENT_KINDS = new Set<WorkflowRunEvent['kind']>([
  'materialized',
  'dispatched',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'budget_breach',
  'stall_settled',
  'harvested',
  'loop_settled'
])

interface WorkflowRunLedgerExpectedIdentity {
  workflowExecutionId: string
  workflowId: string
  scheduledTaskId?: string
  plannedFor?: string
  runId?: string | null
}

function workflowRunEventInputStructureReason(input: WorkflowRunEventInput): string | null {
  if (
    !isNonEmptyTrimmedString(input.workflowExecutionId) ||
    safeWorkflowRunFileName(input.workflowExecutionId) !== `${input.workflowExecutionId}.jsonl` ||
    !isNonEmptyTrimmedString(input.workflowId) ||
    !WORKFLOW_RUN_LEDGER_EVENT_KINDS.has(input.kind) ||
    (input.timestamp !== undefined && canonicalIsoTimestampMs(input.timestamp) === null) ||
    (input.scheduledTaskId !== undefined && !isNonEmptyTrimmedString(input.scheduledTaskId)) ||
    (input.runId !== undefined && !isNonEmptyTrimmedString(input.runId)) ||
    (input.plannedFor !== undefined && canonicalIsoTimestampMs(input.plannedFor) === null) ||
    (input.iteration !== undefined &&
      (!Number.isSafeInteger(input.iteration) || input.iteration < 1))
  ) {
    return 'Workflow run ledger event input is structurally invalid.'
  }
  return null
}

function workflowRunEventStructureReason(
  event: WorkflowRunEvent,
  index: number,
  previous?: WorkflowRunEvent
): string | null {
  const eventTimestampMs = canonicalIsoTimestampMs(event.timestamp)
  const inputReason = workflowRunEventInputStructureReason(event)
  if (
    inputReason ||
    event.schemaVersion !== 1 ||
    event.sequence !== index + 1 ||
    eventTimestampMs === null ||
    (previous !== undefined &&
      (previous.workflowExecutionId !== event.workflowExecutionId ||
        previous.workflowId !== event.workflowId ||
        (previous.scheduledTaskId !== undefined &&
          event.scheduledTaskId !== undefined &&
          previous.scheduledTaskId !== event.scheduledTaskId) ||
        (previous.plannedFor !== undefined &&
          event.plannedFor !== undefined &&
          previous.plannedFor !== event.plannedFor) ||
        (canonicalIsoTimestampMs(previous.timestamp) as number) > eventTimestampMs))
  ) {
    return inputReason || 'Workflow run ledger contains a structurally invalid event sequence.'
  }
  return null
}

function workflowRunLedgerIdentityReason(
  events: WorkflowRunEvent[],
  expected: WorkflowRunLedgerExpectedIdentity
): string | null {
  if (
    events.some(
      (event) =>
        event.workflowExecutionId !== expected.workflowExecutionId ||
        event.workflowId !== expected.workflowId ||
        (expected.scheduledTaskId !== undefined &&
          event.scheduledTaskId !== undefined &&
          event.scheduledTaskId !== expected.scheduledTaskId) ||
        (expected.plannedFor !== undefined &&
          event.plannedFor !== undefined &&
          event.plannedFor !== expected.plannedFor) ||
        (expected.runId !== undefined &&
          event.iteration === undefined &&
          event.runId !== undefined &&
          event.runId !== expected.runId)
    )
  ) {
    return 'Workflow run ledger contains a cross-occurrence identity.'
  }
  return null
}

function readWorkflowRunLedgerStrict(filePath: string): StrictWorkflowRunLedgerRead {
  if (!fs.existsSync(filePath)) {
    return {
      events: [],
      committedBytes: Buffer.alloc(0),
      committedByteLength: 0,
      fileExisted: false,
      hasTornTail: false
    }
  }
  const contents = fs.readFileSync(filePath)
  const events: WorkflowRunEvent[] = []
  let lineStart = 0
  let committedByteLength = 0
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0x0a) continue
    const line = contents.subarray(lineStart, index).toString('utf-8')
    if (line.trim()) {
      const event = parseWorkflowRunEventLine(line)
      if (!event) {
        throw new Error('Workflow run ledger contains an invalid framed event.')
      }
      const structureReason = workflowRunEventStructureReason(event, events.length, events.at(-1))
      if (structureReason) throw new Error(structureReason)
      events.push(event)
    }
    lineStart = index + 1
    committedByteLength = lineStart
  }
  const scheduledTaskIds = new Set(
    events
      .map((event) => event.scheduledTaskId)
      .filter((value): value is string => value !== undefined)
  )
  const plannedForValues = new Set(
    events.map((event) => event.plannedFor).filter((value): value is string => value !== undefined)
  )
  if (scheduledTaskIds.size > 1 || plannedForValues.size > 1) {
    throw new Error('Workflow run ledger contains cross-occurrence rows.')
  }
  return {
    events,
    committedBytes: contents.subarray(0, committedByteLength),
    committedByteLength,
    fileExisted: true,
    hasTornTail: committedByteLength !== contents.length
  }
}

function scheduledOccurrenceLedgerPrefix(
  read: StrictWorkflowRunLedgerRead
): ScheduledOccurrenceLedgerPrefix {
  return {
    schemaVersion: 1,
    fileExisted: read.fileExisted,
    sha256: createHash('sha256').update(read.committedBytes).digest('hex'),
    byteLength: read.committedByteLength,
    eventCount: read.events.length,
    tailSequence: read.events.at(-1)?.sequence || 0
  }
}

function scheduledOccurrenceLedgerPrefixMatches(
  expected: ScheduledOccurrenceLedgerPrefix,
  bytes: Buffer,
  events: WorkflowRunEvent[],
  fileExisted: boolean
): boolean {
  return (
    expected.fileExisted === fileExisted &&
    expected.byteLength === bytes.length &&
    expected.eventCount === events.length &&
    expected.tailSequence === (events.at(-1)?.sequence || 0) &&
    expected.sha256 === createHash('sha256').update(bytes).digest('hex')
  )
}

function strictWorkflowLedgerTaskIds(workflowId: string): Set<string> {
  const taskIds = new Set<string>()
  if (!fs.existsSync(workflowRunsDir)) return taskIds
  for (const entry of fs.readdirSync(workflowRunsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const filePath = path.join(workflowRunsDir, entry.name)
    const looseEvents = readWorkflowRunFile(filePath)
    if (!looseEvents.some((event) => event.workflowId === workflowId)) continue
    const ledger = readWorkflowRunLedgerStrict(filePath)
    if (
      ledger.hasTornTail ||
      ledger.events.length === 0 ||
      ledger.events.some((event) => event.workflowId !== workflowId)
    ) {
      throw new Error('Workflow-linked lifecycle ledger is not a canonical complete projection.')
    }
    for (const event of ledger.events) {
      if (event.scheduledTaskId !== undefined) taskIds.add(event.scheduledTaskId)
    }
  }
  return taskIds
}

function readWorkflowRunLedgerForAppend(
  filePath: string,
  expected?: WorkflowRunLedgerExpectedIdentity
): WorkflowRunEvent[] {
  const read = readWorkflowRunLedgerStrict(filePath)
  if (expected) {
    const identityReason = workflowRunLedgerIdentityReason(read.events, expected)
    if (identityReason) throw new Error(identityReason)
  }
  if (read.hasTornTail) {
    const fd = fs.openSync(filePath, 'r+')
    try {
      fs.ftruncateSync(fd, read.committedByteLength)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }
  return read.events
}

function fsyncWorkflowRunLedger(filePath: string): void {
  // Windows FlushFileBuffers requires write access; a read-only handle
  // EPERMs. The appenders fsync their own write descriptors, so this extra
  // path-level barrier is POSIX-only.
  if (process.platform === 'win32') return
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function fsyncDirectory(directoryPath: string): void {
  // Windows rejects fsync on directory handles (EPERM) — skip the barrier
  // there, matching ScheduledOccurrenceAuthorityRootStore's platform guard.
  if (process.platform === 'win32') return
  const fd = fs.openSync(directoryPath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
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
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT')
      console.error(`Failed to read ${filePath}`, e)
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

/**
 * Cheap line prefilter for a `{kinds}` query, so an unscoped sweep can skip
 * `JSON.parse` on lines that provably cannot match.
 *
 * Records are written by `serializeRunEventRecord` = `JSON.stringify(record)`,
 * which never emits whitespace and never escapes a plain-ASCII kind, so a
 * record of kind K always serializes the literal `"kind":"K"`. Testing for
 * that substring therefore yields a strict SUPERSET of what `filterRunEvents`
 * would keep — no false negatives — while a false positive (the text appearing
 * inside some nested payload string) is harmless: the line still gets parsed
 * and the real `kindSet` check downstream rejects it.
 *
 * This matters because the sweep is wildly unselective without it. Measured
 * 2026-07-19: `provider_raw` is ~89% of all run-event lines, and the startup
 * `{kinds:['reference_context']}` reconcile matched 0 of ~4M events across
 * 5.9GB — i.e. it parsed the entire corpus to build an empty array.
 */
function runEventLinePrefilter(kinds?: RunEventKind[]): ((line: string) => boolean) | null {
  if (!kinds?.length) return null
  const needles = kinds.map((kind) => `"kind":"${kind}"`)
  return needles.length === 1
    ? (line) => line.includes(needles[0])
    : (line) => needles.some((needle) => line.includes(needle))
}

function readRunEventFile(filePath: string, kinds?: RunEventKind[]): RunEventRecord[] {
  const accepts = runEventLinePrefilter(kinds)
  try {
    if (!fs.existsSync(filePath)) return []
    const events: RunEventRecord[] = []
    for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
      if (accepts && !accepts(line)) continue
      const event = parseRunEventLine(line)
      if (event) events.push(event)
    }
    return events
  } catch (e) {
    console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

function readAllRunEventFiles(kinds?: RunEventKind[]): RunEventRecord[] {
  try {
    if (!fs.existsSync(runEventsDir)) return []
    return fs
      .readdirSync(runEventsDir)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) => readRunEventFile(path.join(runEventsDir, file), kinds))
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

async function readRunEventFileAsync(
  filePath: string,
  kinds?: RunEventKind[]
): Promise<RunEventRecord[]> {
  const accepts = runEventLinePrefilter(kinds)
  try {
    const events: RunEventRecord[] = []
    for (const line of (await fs.promises.readFile(filePath, 'utf-8')).split(/\r?\n/)) {
      if (accepts && !accepts(line)) continue
      const event = parseRunEventLine(line)
      if (event) events.push(event)
    }
    return events
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT')
      console.error(`Failed to read ${filePath}`, e)
    return []
  }
}

/** Async twin of `readRunEventFile` over many paths — sequential `await` per file
 * yields the event loop between files. */
async function readRunEventFilesAsync(
  paths: string[],
  kinds?: RunEventKind[]
): Promise<RunEventRecord[]> {
  const all: RunEventRecord[] = []
  for (const filePath of paths) {
    for (const event of await readRunEventFileAsync(filePath, kinds)) all.push(event)
  }
  return all
}

/** Async twin of `readAllRunEventFiles`.
 *
 * Reads line-by-line rather than `readFile` + `split`: run-event files are
 * unbounded (measured 2026-07-19: one 250MB file in a 5.9GB dir), and
 * materializing one as a string plus an array of every line is a single
 * uninterruptible allocation the per-file `await` cannot break up. Streaming
 * keeps the working set to one line and lets the loop breathe mid-file.
 *
 * `kinds` is pushed down to skip `JSON.parse` on non-matching lines — see
 * {@link runEventLinePrefilter}. Without it this sweep parses every event in
 * the dir just to throw nearly all of them away. */
async function readAllRunEventFilesAsync(kinds?: RunEventKind[]): Promise<RunEventRecord[]> {
  const accepts = runEventLinePrefilter(kinds)
  try {
    const files = (await fs.promises.readdir(runEventsDir)).filter((file) =>
      file.endsWith('.jsonl')
    )
    const all: RunEventRecord[] = []
    for (const file of files) {
      const filePath = path.join(runEventsDir, file)
      const input = fs.createReadStream(filePath, { encoding: 'utf-8' })
      const lines = createInterface({ input, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          if (accepts && !accepts(line)) continue
          const event = parseRunEventLine(line)
          if (event) all.push(event)
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error(`Failed to read ${filePath}`, e)
        }
      } finally {
        lines.close()
        input.destroy()
      }
    }
    return all
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT')
      console.error(`Failed to read ${runEventsDir}`, e)
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

function toolActivityDetailCheckpointInput(
  chat: ChatRecord,
  checkpoint: ToolActivityDetailCheckpoint
): RunEventInput {
  const run = chat.runs.find((candidate) => candidate.runId === checkpoint.runId)
  return {
    runId: checkpoint.runId,
    chatId: chat.appChatId,
    workspaceId: chat.workspaceId,
    workspacePath: chat.workspacePath,
    provider: run?.provider || chat.provider,
    kind: 'tool',
    phase: 'artifact',
    source: 'main',
    summary: `Checkpointed ${checkpoint.activityCount} tool activity detail${checkpoint.activityCount === 1 ? '' : 's'}`,
    payload: {
      type: 'tool_activity_detail_checkpoint',
      schemaVersion: 1,
      generation: TOOL_DETAIL_EXTERNALIZATION_GENERATION,
      activityCount: checkpoint.activityCount,
      offset: checkpoint.offset,
      byteLength: checkpoint.byteLength,
      sha256: checkpoint.sha256
    },
    artifacts: [
      {
        id: `${checkpoint.runId}:tool-activity-detail:${checkpoint.offset}`,
        kind: 'other',
        path: checkpoint.relativePath,
        sha256: checkpoint.sha256,
        sizeBytes: checkpoint.byteLength,
        metadata: {
          offset: checkpoint.offset,
          activityCount: checkpoint.activityCount,
          generation: TOOL_DETAIL_EXTERNALIZATION_GENERATION
        }
      }
    ]
  }
}

function shadowWorkspaceBoardMissionFacts(
  board: WorkspaceBoardDefinition,
  cards: readonly WorkspaceBoardCard[],
  removedCards: readonly WorkspaceBoardCard[] = [],
  previousBoard?: WorkspaceBoardDefinition
): void {
  try {
    const chatIds = new Set<string>()
    const missionIds = new Set<string>()
    const correlateChat = (chatId: string): ChatRecord | null => {
      chatIds.add(chatId)
      const chat = AppStore.getChat(chatId)
      if (chat?.activeGoal?.id) missionIds.add(chat.activeGoal.id)
      return chat
    }
    const correlateCard = (sourceBoard: WorkspaceBoardDefinition, card: WorkspaceBoardCard) => {
      if (card.provenance?.sourceKind === 'goal' && card.provenance.sourceId) {
        missionIds.add(card.provenance.sourceId)
        return
      }
      const chatId =
        card.link?.kind === 'chat'
          ? card.link.id
          : card.provenance?.sourceKind === 'thread'
            ? card.provenance.sourceId
            : sourceBoard.provenance?.sourceKind === 'thread'
              ? sourceBoard.provenance.sourceId
              : undefined
      const chat = chatId ? correlateChat(chatId) : null
      if (
        !chat?.activeGoal?.id &&
        sourceBoard.provenance?.sourceKind === 'goal' &&
        sourceBoard.provenance.sourceId
      ) {
        missionIds.add(sourceBoard.provenance.sourceId)
      }
    }
    for (const card of cards) correlateCard(board, card)
    const removalBoard = previousBoard || board
    for (const card of removedCards) correlateCard(removalBoard, card)
    if (previousBoard) {
      for (const card of cards) correlateCard(previousBoard, card)
    }
    if (chatIds.size > 0 || missionIds.size > 0) {
      AppStore.assertHistoryMutationAllowed({
        operation: 'Mission fact shadow persistence',
        chatIds: [...chatIds],
        workspaceIds: [board.workspaceId],
        missionIds: [...missionIds]
      })
    }
    missionFactShadowService.observeWorkspaceBoard({
      board,
      ...(previousBoard ? { previousBoard } : {}),
      cards,
      removedCards,
      resolveChatById: (chatId) => AppStore.getChat(chatId),
      resolveChatByMissionId: (missionId) =>
        AppStore.getChats().find((chat) => chat.activeGoal?.id === missionId)
    })
  } catch (e) {
    console.error('Failed to shadow mission facts from workspace board', e)
  }
}

export interface ChatSaveOptions {
  /** Exact message operations authored by a trusted main-process producer. */
  authoredTranscript?: AuthoredChatTranscriptMutation
}

export class AppStore {
  static resetTransientDeletionGuardsForTests(): void {
    deletedChatIds.clear()
    deletedRunIds.clear()
    runEventSequenceCache.clear()
    runEventHashCache.clear()
    // Otherwise one test's still-open approval makes the next test's identical
    // approval look like an already-rendered transition, and its barrier
    // silently stops firing.
    openApprovalSignatureByChatId.clear()
    this.chatRecordCache.clear()
    chatListIndexStore.clearCache()
    chatListRebuildMemo.clear()
    incrementalChatPersistence.clear()
    chatUpdateProjectionTracker.clear()
    this.orphanSubThreadsReaped = false
    this.orphanSubThreadReapCandidates.clear()
    this.historyDeletionRunning = false
    historyDeletionFailureStepsForTests.clear()
  }

  static clearChatRecordCacheForTests(): void {
    this.chatRecordCache.clear()
  }

  static setHistoryDeletionFailureInjectionForTests(steps: HistoryDeletionStep[]): void {
    historyDeletionFailureStepsForTests.clear()
    for (const step of steps) historyDeletionFailureStepsForTests.add(step)
  }

  static getExtensionSecretStatusSnapshot(): ExtensionSecretStatusSnapshot {
    return extensionSecretStore.getSecretStatusSnapshot()
  }

  static setExtensionSecret(ref: ExtensionSecretRef, value: string): ExtensionSecretMutationResult {
    return extensionSecretStore.setSecret(ref, value)
  }

  static clearExtensionSecret(ref: ExtensionSecretRef): ExtensionSecretMutationResult {
    return extensionSecretStore.clearSecret(ref)
  }

  static clearExtensionOwnerSecrets(ownerKind: ExtensionSecretOwnerKind, ownerId: string): number {
    return extensionSecretStore.clearOwnerSecrets(ownerKind, ownerId)
  }

  static resolveExtensionSecretValues(refs: ExtensionSecretRef[]): ExtensionSecretResolution[] {
    return extensionSecretStore.resolveSecretValues(refs)
  }

  // Settings
  static getSettings(): AppSettings {
    migrateLegacySettingsIfMissing()
    // Stat BEFORE the read (and after the migration write above): if the
    // file changes between stat and read, the cache holds newer content
    // under an older stat and self-heals with one extra parse on the next
    // call — never the reverse (stale-served-as-fresh).
    const statBefore = statSettingsFile()
    if (
      statBefore &&
      settingsFileCache &&
      settingsFileCache.mtimeMs === statBefore.mtimeMs &&
      settingsFileCache.size === statBefore.size
    ) {
      return settingsFileCache.value
    }
    let stored = stripRetiredSettingsKeys(
      readJson<Partial<AppSettings> & Record<string, unknown>>(settingsPath, {})
    )
    const userMcpSecretMigration = migrateUserMcpServerPlaintextSecrets(
      stored.userMcpServers,
      (ref, value) => extensionSecretStore.setSecret(ref, value)
    )
    if (userMcpSecretMigration.changed) {
      stored = {
        ...stored,
        userMcpServers: userMcpSecretMigration.value as UserMcpServerConfig[]
      }
      writeJson(settingsPath, stored)
    }
    const storedDashboardStatPrefs = objectOrUndefined(stored.dashboardStatPrefs)
    const storedWelcomeHeatmapPrefs = objectOrUndefined(stored.welcomeHeatmapPrefs)
    const storedApprovalModeElevationAcks = objectOrUndefined(
      stored.approvalModeElevationAcknowledgements
    )
    let storedApprovalTimeouts = objectOrUndefined(stored.approvalTimeouts)
    const approvalTimeoutMigration = migrateApprovalTimeoutDefaults(storedApprovalTimeouts)
    if (approvalTimeoutMigration.changed && approvalTimeoutMigration.value) {
      storedApprovalTimeouts =
        approvalTimeoutMigration.value as unknown as AppSettings['approvalTimeouts']
      stored = {
        ...stored,
        approvalTimeouts: storedApprovalTimeouts
      }
      writeJson(settingsPath, stored)
    }
    const storedApprovalTimeoutProviderMs = objectOrUndefined(storedApprovalTimeouts?.perProviderMs)
    const pendingUpdateChangelog = normalizeUpdateChangelog(stored.pendingUpdateChangelog)
    const themeAppearance = resolveSystemThemeAppearance(
      stored.themeAppearance,
      defaultSettings.themeAppearance
    ) as AppSettings['themeAppearance']
    const built: AppSettings = {
      ...defaultSettings,
      ...stored,
      themeAppearance,
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
      promptCache: normalizePromptCacheSettings(stored.promptCache, defaultSettings.promptCache),
      providerHarnessPosture: normalizeProviderHarnessPostureMap(stored.providerHarnessPosture),
      agenticServices: {
        ...defaultSettings.agenticServices,
        ...(stored.agenticServices || {})
      },
      themeAccentColor: resolveThemeAccentColor(
        stored.themeAccentColor,
        stored.themeAccentStyle,
        stored.userBubbleColor
      ),
      diffStatColors: normalizeDiffStatColors(stored.diffStatColors),
      auditRetention: normalizeAuditRetentionSettings(stored.auditRetention),
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
      // Normalize legacy per-provider rows into the 'agents' wildcard at the
      // read boundary so "granted for this workspace" is provider-equal from
      // the first resolve after boot, not only after the next re-grant.
      agenticWorkspaceGrants: Array.isArray(stored.agenticWorkspaceGrants)
        ? consolidateAgenticWorkspaceGrants(stored.agenticWorkspaceGrants)
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
      // Settings → General Max Wave Agents: clamp 2–64; malformed/missing
      // takes the default. A value equal to the SUPERSEDED default is lifted
      // once — see adoptSupersededMaxWaveAgents.
      maxWaveAgents: adoptSupersededMaxWaveAgents(stored.maxWaveAgents),
      autoUpdateEnabled:
        typeof stored.autoUpdateEnabled === 'boolean'
          ? stored.autoUpdateEnabled
          : defaultSettings.autoUpdateEnabled,
      activityReportingEnabled:
        typeof stored.activityReportingEnabled === 'boolean'
          ? stored.activityReportingEnabled
          : defaultSettings.activityReportingEnabled,
      autoFailoverEnabled:
        typeof stored.autoFailoverEnabled === 'boolean'
          ? stored.autoFailoverEnabled
          : defaultSettings.autoFailoverEnabled,
      workflowBudgetKillEnabled:
        typeof stored.workflowBudgetKillEnabled === 'boolean'
          ? stored.workflowBudgetKillEnabled
          : defaultSettings.workflowBudgetKillEnabled,
      simulatorControlEnabled:
        typeof stored.simulatorControlEnabled === 'boolean'
          ? stored.simulatorControlEnabled
          : defaultSettings.simulatorControlEnabled,
      approvalTimeouts: {
        ...defaultSettings.approvalTimeouts,
        ...(storedApprovalTimeouts || {}),
        perProviderMs: {
          ...defaultSettings.approvalTimeouts.perProviderMs,
          ...(storedApprovalTimeoutProviderMs || {})
        }
      }
    }
    // Keyed to the pre-read stat: if a mid-body settings migration rewrote the
    // file, that write already invalidated the cache and this
    // repopulation carries a stale stat, forcing one extra re-parse on the
    // next call — cheap and always in the safe direction.
    if (statBefore) {
      settingsFileCache = { value: built, mtimeMs: statBefore.mtimeMs, size: statBefore.size }
    }
    return built
  }

  static updateSettings(partial: Partial<AppSettings>) {
    const current = this.getSettings()
    const next = stripRetiredSettingsKeys({ ...current, ...partial } as Record<string, unknown>)
    if (typeof next.themeAppearance === 'string') {
      next.themeAppearance = normalizeSystemThemeAppearance(next.themeAppearance)
    }
    const localHistoryDisabled =
      Object.prototype.hasOwnProperty.call(partial, 'storeLocalChatHistory') &&
      current.storeLocalChatHistory !== false &&
      next.storeLocalChatHistory === false
    writeJson(settingsPath, next)
    if (Object.prototype.hasOwnProperty.call(partial, 'cliPathDirectories')) {
      // Published from the write choke-point so every settings lane (IPC patch,
      // startup managed patch, settings service) applies it identically — and
      // so the change takes effect on the next CLI resolution rather than the
      // next app launch.
      publishCliPathDirectories(next.cliPathDirectories as string[] | undefined)
    }
    if (localHistoryDisabled) {
      deletePathBestEffort(messageFeedbackLedgerPath, 'message feedback receipt ledger')
    }
    if (Object.prototype.hasOwnProperty.call(partial, 'userMcpServers')) {
      const previousIds = new Set((current.userMcpServers || []).map((server) => server.id))
      const nextIds = new Set(
        normalizeUserMcpServers(next.userMcpServers).map((server) => server.id)
      )
      for (const id of previousIds) {
        if (!nextIds.has(id)) extensionSecretStore.clearOwnerSecrets('userMcpServer', id)
      }
    }
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
    const rawCustomProfiles = readJson<RuntimeProfile[]>(runtimeProfilesPath, [])
    const runtimeSecretMigration = migrateRuntimeProfilePlaintextSecrets(
      rawCustomProfiles,
      (ref, value) => extensionSecretStore.setSecret(ref, value)
    )
    const customProfiles = Array.isArray(runtimeSecretMigration.value)
      ? (runtimeSecretMigration.value as RuntimeProfile[])
      : rawCustomProfiles
    if (runtimeSecretMigration.changed) writeJson(runtimeProfilesPath, customProfiles)
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
      secretRefs: normalizeRuntimeProfileSecretRefs(input.secretRefs),
      mcpProfileId: input.mcpProfileId,
      approvalMode: input.approvalMode,
      agenticServices: input.agenticServices,
      networkPolicy: input.networkPolicy || 'inherit',
      persistence: input.persistence || 'reusable',
      containerConfig: input.containerConfig,
      pluginProvenance: input.pluginProvenance,
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
    extensionSecretStore.clearOwnerSecrets('runtimeProfile', id)
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

  /**
   * Compare-and-set a missing main-owned real target without changing recent
   * workspace ordering. Existing pins are immutable through this repair path.
   */
  static pinWorkspaceRealPath(
    workspaceId: string,
    expectedPath: string,
    realPath: string
  ): WorkspaceRecord | null {
    const workspaces = this.getWorkspaces()
    const index = workspaces.findIndex(
      (workspace) => workspace.id === workspaceId && workspace.path === expectedPath
    )
    if (index < 0) return null
    const existing = workspaces[index]
    if (existing.realPath) return null
    const updated = { ...existing, realPath }
    workspaces[index] = updated
    writeJson(workspacesPath, workspaces)
    return updated
  }

  static removeWorkspace(workspaceId: string) {
    const workspaces = this.getWorkspaces().filter((w) => w.id !== workspaceId)
    writeJson(workspacesPath, workspaces)
  }

  static clearWorkspaces() {
    writeJson(workspacesPath, [])
  }

  /**
   * Host-owned-gate add/update: the record travels via workspace.record.upsert
   * and the Host's canonical realPath is ADOPTED via read-back — the wire
   * forbids a caller-asserted realPath and the Host canonicalizes the selected
   * path itself (on macOS /var -> /private/var), so the returned record comes
   * from the file the Host just wrote, never from a locally synthesized one.
   * Callers select this via legacyStoreWritesOpen() so the legacy entry keeps
   * its synchronous signature and merge semantics exactly.
   */
  static async addOrUpdateWorkspaceViaHost(
    workspacePath: string,
    partial: Partial<WorkspaceRecord> = {}
  ): Promise<WorkspaceRecord> {
    const workspaces = this.getWorkspaces()
    const existing = workspaces.find((workspace) => workspace.path === workspacePath)
    const workspaceId = existing?.id ?? randomUUID()
    const {
      // Never caller-asserted: the wire forbids it and the Host canonicalizes.
      realPath: _dropCallerRealPath,
      ...safePartial
    } = partial
    await hostWorkspaceRecord().upsertWorkspaceRecord({
      workspaceId,
      path: workspacePath,
      displayName:
        safePartial.displayName ??
        existing?.displayName ??
        (path.basename(workspacePath) || workspacePath),
      createdAt: existing?.createdAt ?? Date.now(),
      lastOpenedAt: Date.now(),
      pinned: safePartial.pinned ?? existing?.pinned ?? false,
      ...(safePartial.branch !== undefined ? { branch: safePartial.branch } : {}),
      ...(safePartial.geminiWorktree !== undefined
        ? { geminiWorktree: safePartial.geminiWorktree }
        : {})
    })
    const adopted = this.getWorkspaces().find((workspace) => workspace.id === workspaceId)
    if (!adopted) throw new Error('Host workspace upsert did not produce a record')
    return adopted
  }

  /**
   * Host-owned-gate compare-and-set pin: only a record matching id+path with
   * no realPath is pinned, preserving the immutable-once-set contract. The CAS
   * pre-check reads the Host-written file (single desktop writer + Host only
   * writes on command), then the upsert lets the Host compute the canonical
   * realPath itself; the returned record is the read-back of that write.
   */
  static async pinWorkspaceRealPathViaHost(
    workspaceId: string,
    expectedPath: string,
    realPath: string
  ): Promise<WorkspaceRecord | null> {
    const workspaces = this.getWorkspaces()
    const existing = workspaces.find(
      (workspace) => workspace.id === workspaceId && workspace.path === expectedPath
    )
    if (!existing || existing.realPath) return null
    await hostWorkspaceRecord().upsertWorkspaceRecord({
      workspaceId: existing.id,
      path: existing.path,
      displayName: existing.displayName,
      createdAt: existing.createdAt,
      lastOpenedAt: existing.lastOpenedAt,
      pinned: existing.pinned,
      ...(typeof existing.branch === 'string' ? { branch: existing.branch } : {}),
      ...(existing.geminiWorktree ? { geminiWorktree: existing.geminiWorktree } : {})
    })
    void realPath // the Host canonicalizes; the arg documents the expected target
    const adopted = this.getWorkspaces().find((workspace) => workspace.id === workspaceId)
    return adopted ?? null
  }

  /** Host-owned-gate remove via workspace.record.remove (idempotent). */
  static async removeWorkspaceViaHost(workspaceId: string): Promise<void> {
    await hostWorkspaceRecord().removeWorkspaceRecord(workspaceId)
  }

  /** Host-owned-gate clear via workspace.records.clear. */
  static async clearWorkspacesViaHost(): Promise<void> {
    await hostWorkspaceRecord().clearWorkspaceRecords()
  }

  /** Test seam: swap the Host workspace-record port. */
  static setHostWorkspaceRecordPortForTests(port: HostWorkspaceRecordPort | null): void {
    hostWorkspaceRecordPort = port
  }

  // Projects (Work surface). Thin delegation to the ProjectRegistry singleton;
  // all record logic lives in shared/projects so renderer optimistic applies
  // and these authoritative applies cannot drift.
  static getProjects(): Project[] {
    return projectRegistry.getProjects()
  }

  static getProjectWorkProfiles(): ProjectWorkProfile[] {
    return projectRegistry.getWorkProfiles()
  }

  static getProjectReferences(): ProjectReference[] {
    return projectRegistry.getReferences()
  }

  static getProjectGraphEdges(): ProjectGraphEdge[] {
    return projectRegistry.getGraphEdges()
  }

  static applyProjectOp(op: ProjectOp): ProjectRegistryMutationResult {
    const addedChatIds =
      op.kind === 'add-chat'
        ? [op.chatId]
        : op.kind === 'create'
          ? Array.isArray(op.input.memberChatIds)
            ? op.input.memberChatIds
            : []
          : []
    if (addedChatIds.length > 0) {
      this.assertHistoryMutationAllowed({
        operation: 'Project chat membership persistence',
        chatIds: addedChatIds,
        workspaceIds: addedChatIds.map((chatId) => this.getChat(chatId)?.workspaceId)
      })
    }
    return projectRegistry.applyOp(op)
  }

  static applyProjectReferenceOp(op: ProjectReferenceOp): ProjectRegistryMutationResult {
    return projectRegistry.applyReferenceOp(op)
  }

  static applyProjectGraphEdgeOp(op: ProjectGraphEdgeOp): ProjectRegistryMutationResult {
    return projectRegistry.applyGraphEdgeOp(op)
  }

  static setProjectHomeChat(
    projectId: string,
    chatId: string | null
  ): ProjectRegistryMutationResult {
    if (chatId) {
      this.assertHistoryMutationAllowed({
        operation: 'Project home-chat persistence',
        chatIds: [chatId],
        workspaceIds: [this.getChat(chatId)?.workspaceId]
      })
    }
    return projectRegistry.setHomeChat(projectId, chatId)
  }

  static setProjectWorkProfileFields(
    projectId: string,
    patch: { brief?: string | null; preferredWorkspaceId?: string | null }
  ): ProjectRegistryMutationResult {
    return projectRegistry.setWorkProfileFields(projectId, patch)
  }

  static importLegacyProjects(rawJson: string | null): ProjectLegacyImportResult {
    return projectRegistry.importLegacyProjects(rawJson)
  }

  static getProjectsLegacyImportMarker(): ProjectLegacyImportMarker | null {
    return projectRegistry.getLegacyImportMarker()
  }

  static setProjectsChangeListener(listener: ((state: ProjectRegistryState) => void) | null): void {
    projectRegistry.setChangeListener(listener)
  }

  // Chats
  static normalizeChatRecord(chat: ChatRecord): ChatRecord {
    chat = stripExternalProviderThreadImportContinuity(chat)
    const scope = chat.scope === 'global' ? 'global' : 'workspace'
    const chatKind = chat.chatKind === 'ensemble' ? 'ensemble' : 'single'
    const workflowMode = normalizeChatWorkflowMode(chat.workflowMode)
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
        ? (() => {
            const defaults = createDefaultEnsembleConfig(
              chat.provider || this.getSettings().activeProvider
            )
            const stored = chat.ensemble
            const participants =
              Array.isArray(stored?.participants) && stored.participants.length > 0
                ? stored.participants
                : defaults.participants
            const authority = normalizeEnsembleAuthority({
              participants,
              bossmanParticipantId: stored?.bossmanParticipantId ?? defaults.bossmanParticipantId,
              captainParticipantIds:
                stored && Object.prototype.hasOwnProperty.call(stored, 'captainParticipantIds')
                  ? stored.captainParticipantIds
                  : stored
                    ? undefined
                    : defaults.captainParticipantIds,
              secondInCommandParticipantId:
                stored?.secondInCommandParticipantId ??
                (stored ? undefined : defaults.secondInCommandParticipantId)
            })
            const activeRound = stored?.activeRound
              ? (() => {
                  const runtimeOwnedRound = discardForeignEnsembleTurnTransition(stored.activeRound)
                  const roundAuthority = normalizeEnsembleAuthority({
                    participants: runtimeOwnedRound.participants.map((participant) => ({
                      id: participant.participantId,
                      order: participant.order
                    })),
                    bossmanParticipantId: runtimeOwnedRound.bossmanParticipantId,
                    captainParticipantIds: runtimeOwnedRound.captainParticipantIds,
                    secondInCommandParticipantId: runtimeOwnedRound.secondInCommandParticipantId
                  })
                  return {
                    ...runtimeOwnedRound,
                    bossmanParticipantId: roundAuthority.bossmanParticipantId,
                    captainParticipantIds: roundAuthority.captainParticipantIds,
                    secondInCommandParticipantId: roundAuthority.secondInCommandParticipantId
                  }
                })()
              : undefined
            return {
              ...defaults,
              ...(stored || {}),
              participants,
              bossmanParticipantId: authority.bossmanParticipantId,
              captainParticipantIds: authority.captainParticipantIds,
              secondInCommandParticipantId: authority.secondInCommandParticipantId,
              ...(activeRound ? { activeRound } : {})
            }
          })()
        : undefined
    const activeGoal =
      chatKind === 'ensemble' ? resolveActiveGoalForEnsemble(chat.activeGoal) : chat.activeGoal
    if (scope === 'global') {
      const { workspaceId: _workspaceId, workspacePath: _workspacePath, ...rest } = chat
      return {
        ...rest,
        scope,
        chatKind,
        parentChatRelation,
        sideChatContext,
        workflowMode,
        ...(activeGoal ? { activeGoal } : {}),
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
      workflowMode,
      ...(activeGoal ? { activeGoal } : {}),
      ...(ensemble ? { ensemble } : {}),
      providerMetadata,
      workspaceId: chat.workspaceId || '',
      workspacePath: chat.workspacePath || ''
    }
  }

  /** Mirrors renderer modelUsageTable.runDiffFileCount — keep in sync. */
  private static runDiffFileCountForSummary(run: ChatRun): number {
    const paths = new Set<string>()
    const addFile = (filePath: unknown): void => {
      if (typeof filePath === 'string' && filePath.trim()) paths.add(filePath.trim())
    }
    const diff = (run as { runDiff?: Record<string, Array<{ path?: unknown }>> }).runDiff
    for (const key of ['createdFiles', 'modifiedFiles', 'deletedFiles', 'preExistingFiles']) {
      for (const file of diff?.[key] || []) addFile(file?.path)
    }
    const byPath = (run as { runDiffByPath?: Record<string, Array<{ path?: unknown }>> })
      .runDiffByPath
    for (const files of Object.values(byPath || {})) {
      for (const file of files || []) addFile(file?.path)
    }
    return paths.size
  }

  /** Ollama RAM stats subset for ChatListRunSummary — copies the ollamaMemory*
   * top-level keys and the hardware.ram subtree, the exact paths the renderer
   * extractors (ollamaMemoryDisplay OLLAMA_*_PATHS) read. Keep in sync. */
  private static ollamaStatsSubsetForChatList(stats: unknown): Record<string, unknown> | undefined {
    if (!stats || typeof stats !== 'object') return undefined
    const source = stats as Record<string, unknown>
    const subset: Record<string, unknown> = {}
    for (const key of Object.keys(source)) {
      if (key.startsWith('ollamaMemory')) subset[key] = source[key]
    }
    const hardware = source.hardware
    if (hardware && typeof hardware === 'object') {
      const ram = (hardware as Record<string, unknown>).ram
      if (ram && typeof ram === 'object') subset.hardware = { ram }
    }
    return Object.keys(subset).length > 0 ? subset : undefined
  }

  private static summarizeRunForChatList(run: ChatRun): ChatListRunSummary {
    const stats =
      run.provider === 'ollama' ? this.ollamaStatsSubsetForChatList(run.stats) : undefined
    return {
      runId: run.runId,
      ...(run.provider ? { provider: run.provider } : {}),
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      ...(run.requestedModel ? { requestedModel: run.requestedModel } : {}),
      ...(run.actualModel ? { actualModel: run.actualModel } : {}),
      diffFileCount: this.runDiffFileCountForSummary(run),
      ...(stats ? { stats } : {})
    }
  }

  static toChatListItem(
    chat: ChatRecord,
    sourceStat?: Pick<fs.Stats, 'mtimeMs' | 'size'>
  ): ChatListItem {
    const normalizedChat = this.normalizeChatRecord(chat)
    // A list entry is a ROW, not a record. The full ensemble blob measured
    // ~229 KB of a 234 KB entry — 98% — which is what grew
    // chat-list-index.jsonl to ~98.7 MB and made every parse of it ~485 ms.
    // The earlier T3c split moved runsSummary/lastRun and missed this field.
    // The row keeps a LEAN ensemble rather than none: the sidebar's Ensembles
    // section reads activeRound/participants for a row's subtitle and running
    // state, and sidebarTerminalOutcome reads escalationSignals for its tone —
    // and for a chat the user has not opened, the row is the only source.
    // Same class, next field (2026-08-18 live watch): per-model session
    // memories measured 133.6 KB of a ~160 KB entry (83%) and re-appended on
    // every streamed save. Nothing in the chat list renders working memory;
    // prompt building loads the full record. Drop jumbo blobs HERE, per field
    // — the spread below carries everything this destructure does not name.
    const {
      ensemble,
      ollamaSessionMemory: _dropOllamaSessionMemory,
      ollamaSessionMemories: _dropOllamaSessionMemories,
      ...listProjection
    } = normalizedChat
    const messages = Array.isArray(normalizedChat.messages)
      ? normalizedChat.messages.filter(
          (message) => !isRetiredExternalChannelInboundMessage(message)
        )
      : []
    const runs = Array.isArray(normalizedChat.runs) ? normalizedChat.runs : []
    const lastRun = summarizeLastRun(runs[runs.length - 1])
    const recentMessageSearch = messages
      .slice(-8)
      .map((message) => `${message.role} ${previewText(message.content, 180)}`)
      .filter(Boolean)
    // Backwards scan, no array copy: this now also runs on the getChatList
    // rebuild path for every throttled-stale row, where the old reverse()
    // cloned the whole messages array per list read on jumbo chats.
    let latestMessagePreview: string | undefined
    for (let i = messages.length - 1; i >= 0 && !latestMessagePreview; i--) {
      latestMessagePreview = previewText(messages[i].content, 180) || undefined
    }
    return {
      ...listProjection,
      ...(ensemble ? { ensemble: this.toChatListEnsembleProjection(ensemble) } : {}),
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount: messages.length,
      runCount: runs.length,
      runsSummary: runs.filter((run) => run?.runId).map((run) => this.summarizeRunForChatList(run)),
      ...(lastRun ? { lastRun } : {}),
      ...(sourceStat
        ? { sourceChatMtimeMs: sourceStat.mtimeMs, sourceChatSize: sourceStat.size }
        : {}),
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

  /** Marks the lean ensemble copy carried by a chat-list row.
   *
   *  Deliberately an untyped key: EnsembleConfig lives in types.ts, which this
   *  change is not scoped to edit, and the flag is an internal store concern —
   *  nothing outside this file should branch on it. */
  private static readonly CHAT_LIST_ENSEMBLE_PROJECTION_FLAG = '__chatListProjection'

  /** True when this ensemble is a list-row projection rather than the real
   *  roster. Load-bearing: `saveChat` must never persist one of these. */
  static isChatListEnsembleProjection(ensemble: EnsembleConfig | undefined): boolean {
    if (!ensemble) return false
    return (
      (ensemble as unknown as Record<string, unknown>)[this.CHAT_LIST_ENSEMBLE_PROJECTION_FLAG] ===
      true
    )
  }

  /** The lean ensemble a chat-list row carries.
   *
   *  Drops the four sub-blobs that make an entry fat and that no list surface
   *  reads — seat instructions, round summaries, the blackboard and the
   *  activity ledger — while keeping activeRound, seat roles/providers and
   *  escalationSignals so sidebar rows still render. Measured on a 15-seat
   *  round: 111 KB -> 3 KB, i.e. 97.3% of the saving of dropping it outright,
   *  without blanking the Ensembles list. */
  static toChatListEnsembleProjection(ensemble: EnsembleConfig): EnsembleConfig {
    const {
      roundSummaries: _roundSummaries,
      blackboard: _blackboard,
      blackboardTombstones: _blackboardTombstones,
      wakeups: _wakeups,
      sessionActivityLedger: _sessionActivityLedger,
      ...rest
    } = ensemble
    return {
      ...rest,
      // `instructions` is required on EnsembleParticipant, so blank it rather
      // than drop it — a row needs the seat's role and provider, never its
      // brief, and the briefs are the single largest contributor.
      participants: (rest.participants || []).map((participant) => ({
        ...participant,
        instructions: ''
      })),
      [this.CHAT_LIST_ENSEMBLE_PROJECTION_FLAG]: true
    } as EnsembleConfig
  }

  /** Strip the projection marker without restoring anything — used when a
   *  projection reaches a save with no persisted roster to fall back to. */
  private static withoutChatListEnsembleProjectionFlag(ensemble: EnsembleConfig): EnsembleConfig {
    const copy = { ...(ensemble as unknown as Record<string, unknown>) }
    delete copy[this.CHAT_LIST_ENSEMBLE_PROJECTION_FLAG]
    return copy as unknown as EnsembleConfig
  }

  static normalizeChatListItem(item: ChatListItem): ChatListItem {
    const normalized = this.normalizeChatRecord(item)
    // Project on the READ path too, and keep the marker. normalizeChatRecord
    // REBUILDS an ensemble (falling back to createDefaultEnsembleConfig's
    // participants) for any chatKind==='ensemble' record, so without this a
    // row could come back advertising a DEFAULT roster the user never
    // configured — and the renderer's mergeChatRecordValue spreads a summary's
    // fields over the live record. Re-marking is what keeps saveChat's guard
    // able to recognise a row that has been round-tripped through a merge.
    // Legacy rows written before the memories strip still carry the blobs;
    // shed them on the read round-trip too, not only at build time.
    const {
      ensemble,
      ollamaSessionMemory: _dropOllamaSessionMemory,
      ollamaSessionMemories: _dropOllamaSessionMemories,
      ...listProjection
    } = normalized
    return {
      ...listProjection,
      ...(ensemble ? { ensemble: this.toChatListEnsembleProjection(ensemble) } : {}),
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount: typeof item.messageCount === 'number' ? item.messageCount : 0,
      runCount: typeof item.runCount === 'number' ? item.runCount : 0,
      runsSummary: Array.isArray(item.runsSummary) ? item.runsSummary : [],
      ...(item.lastRun ? { lastRun: summarizeLastRun(item.lastRun) || item.lastRun } : {}),
      ...(typeof item.sourceChatMtimeMs === 'number'
        ? { sourceChatMtimeMs: item.sourceChatMtimeMs }
        : {}),
      ...(typeof item.sourceChatSize === 'number' ? { sourceChatSize: item.sourceChatSize } : {}),
      ...(typeof item.searchText === 'string' ? { searchText: item.searchText } : {}),
      ...(typeof item.searchPreview === 'string' ? { searchPreview: item.searchPreview } : {})
    }
  }

  static getChatList(workspaceId?: string): ChatListItem[] {
    if (!fs.existsSync(chatsDir)) return []
    const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json'))
    const existingIndex = chatListIndexStore.readAll()
    const nextIndex: Record<string, ChatListItem> = {}
    const items: ChatListItem[] = []
    const dirtyChatIds = new Set<string>()

    for (const file of files) {
      const chatId = path.basename(file, '.json')
      const chatPath = path.join(chatsDir, file)
      let sourceStat: fs.Stats
      try {
        sourceStat = fs.statSync(chatPath)
      } catch {
        continue
      }
      let item: ChatListItem | undefined
      const indexed = existingIndex[chatId]
      // runsSummary doubles as the index-entry freshness marker: entries
      // persisted before the field existed rebuild from the chat file once,
      // instead of silently serving items without run summaries.
      if (
        indexed?.summaryOnly === true &&
        Array.isArray(indexed.runsSummary) &&
        this.chatListItemMatchesSource(indexed, sourceStat)
      ) {
        item = this.normalizeChatListItem(indexed)
      } else {
        // A rebuild parses the WHOLE record, and the restamp below is gated on
        // legacyStoreCanWrite() — while the Host owns legacy writes the same
        // rows rebuild on every call. Serve the row this process already
        // derived from these exact bytes; correctness rides on the same
        // mtime+size identity the index entry is judged by.
        const memoised = chatListRebuildMemo.get(chatId, sourceStat)
        if (memoised) {
          item = memoised
        } else {
          const chat = readJson<ChatRecord | null>(chatPath, null)
          if (chat) {
            item = this.toChatListItem(chat, sourceStat)
            chatListRebuildMemo.set(chatId, sourceStat, item)
          }
        }
        if (item) dirtyChatIds.add(chatId)
      }
      if (!item) continue
      nextIndex[chatId] = item
      if (!workspaceId || item.workspaceId === workspaceId) {
        items.push(item)
      }
    }

    // Write only changed entries — O(delta), not O(all-chats) — and through
    // the same gate as saveChat: a streaming-stale row rebuilds fresh for the
    // caller on every read, but its disk append rides the volatile cadence.
    for (const chatId of dirtyChatIds) {
      if (!legacyStoreCanWrite()) continue
      this.writeChatListIndexEntryIfAllowed(chatId, nextIndex[chatId])
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Per-chat write throttle — still used by shouldWriteChatListIndexItem
   *  to avoid rewriting the list entry on every volatile field bump. */
  private static chatListIndexWriteAtByChatId = new Map<string, number>()

  /** THE single write seam for chat-list index entries. Every door — saveChat,
   *  the getChatList stale-row rebuild, the durable-write stat refresh — must
   *  pass the same gate, or volatile churn migrates to whichever door is not
   *  gated. The 2026-08-18 append storm was two doors at once: saveChat wrote
   *  a fat line per streamed message AND the settle callback appended a
   *  second, stale-content line per flush just to refresh two stat numbers. */
  private static writeChatListIndexEntryIfAllowed(chatId: string, next: ChatListItem): boolean {
    return runLegacyStoreWriteAdmission(
      { operation: 'write-chat-list-index', pathFamily: 'chats' },
      () => this.writeChatListIndexEntryIfAllowedAdmitted(chatId, next)
    )
  }

  private static writeChatListIndexEntryIfAllowedAdmitted(
    chatId: string,
    next: ChatListItem
  ): boolean {
    const previous = chatListIndexStore.readEntry(chatId)
    if (!this.shouldWriteChatListIndexItem(previous, next)) return false
    chatListIndexStore.writeEntry(chatId, next)
    this.chatListIndexWriteAtByChatId.set(chatId, Date.now())
    return true
  }

  private static chatListItemJson(
    item: ChatListItem | undefined,
    includeVolatile: boolean
  ): string {
    if (!item) return ''
    // Compare the projection we actually store. Entries written before the
    // ensemble split still carry the blob on disk, so without this the diff
    // would stringify ~229 KB twice on every save, and any round/seat mutation
    // (which happens constantly during fan-out) would force an index rewrite
    // for a field the row does not even persist.
    const { ensemble: _ensemble, ...projected } = item
    if (includeVolatile) return JSON.stringify(projected)
    const {
      updatedAt: _updatedAt,
      persistenceRevision: _persistenceRevision,
      searchText: _searchText,
      searchPreview: _searchPreview,
      sourceChatMtimeMs: _sourceChatMtimeMs,
      sourceChatSize: _sourceChatSize,
      // Every streamed tool row is a message, so the count changes on
      // effectively every save — in the stable half it bypassed the volatile
      // window entirely and appended a fat line per save (2026-08-18).
      messageCount: _messageCount,
      ...stable
    } = projected
    return JSON.stringify({
      ...stable,
      ...(Array.isArray(stable.runsSummary)
        ? {
            runsSummary: stable.runsSummary.map((summary) =>
              this.chatListRunSummaryStableProjection(summary)
            )
          }
        : {}),
      ...(stable.lastRun
        ? { lastRun: this.chatListRunSummaryStableProjection(stable.lastRun) }
        : {})
    })
  }

  /** Per-run fields that tick on every streaming save (diff counter, ollama
   *  stats) belong to the volatile half of the write gate. Run lifecycle —
   *  runId appearing, model resolution, startedAt/endedAt — stays in the
   *  stable half so a run starting or finishing writes its row immediately.
   *  Accepts the legacy shape too: rows written before summarizeLastRun
   *  existed still carry a whole ChatRun in `lastRun`, and stripping the same
   *  two churn fields off either shape keeps the comparison honest (the fat
   *  legacy row then differs structurally from its lean rebuild exactly once,
   *  which is the self-heal write). */
  private static chatListRunSummaryStableProjection(
    summary: ChatListRunSummary | ChatRun
  ): Record<string, unknown> {
    const {
      diffFileCount: _diffFileCount,
      stats: _stats,
      ...stable
    } = summary as ChatListRunSummary
    return stable
  }

  private static chatListItemMatchesSource(
    item: ChatListItem,
    sourceStat: Pick<fs.Stats, 'mtimeMs' | 'size'>
  ): boolean {
    return item.sourceChatMtimeMs === sourceStat.mtimeMs && item.sourceChatSize === sourceStat.size
  }

  private static shouldWriteChatListIndexItem(
    previous: ChatListItem | undefined,
    next: ChatListItem
  ): boolean {
    if (!previous) return true
    if (this.chatListItemJson(previous, true) === this.chatListItemJson(next, true)) {
      return false
    }
    if (this.chatListItemJson(previous, false) !== this.chatListItemJson(next, false)) {
      return true
    }
    const lastWriteAt = this.chatListIndexWriteAtByChatId.get(next.appChatId)
    if (lastWriteAt === undefined) return true
    return Date.now() - lastWriteAt >= CHAT_LIST_INDEX_VOLATILE_REFRESH_INTERVAL_MS
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
  /** Serializes only the async binding patch for one chat. Ordinary legacy
   * saveChat callers remain independent, so this is a narrow race guard rather
   * than a new whole-record persistence protocol. */
  private static threadWorktreeBindingWriteTails = new Map<string, Promise<ChatRecord>>()
  private static fanoutCandidateWriteTails = new Map<string, Promise<ChatRecord | null>>()

  /** Serializes only the async watched-PR patch for one chat. Ordinary legacy
   * saveChat callers remain independent, so this is a narrow race guard rather
   * than a new whole-record persistence protocol. */
  private static watchedPrWriteTails = new Map<string, Promise<ChatRecord>>()

  /** Serializes only the async git-workflow marker patch for one chat. Same
   * narrow race guard as the watched-PR tails. */
  private static chatGitWorkflowWriteTails = new Map<string, Promise<ChatRecord>>()
  /** Interactive composer selections use a transcript-free adjacent overlay.
   * Per-chat tails keep rapid model/reasoning/permission batches ordered. */
  private static chatComposerSelectionWriteTails = new Map<
    string,
    Promise<{ chat: ChatRecord; changed: boolean }>
  >()

  private static readChatRecordCached(chatId: string, chatPath: string): ChatRecord | null {
    const cached = this.chatRecordCache.get(chatId)
    // T3a-1: mtimeMs === -1 is the dirty marker — the record was saved
    // through the coalescer and hasn't been flushed to disk yet. Skip the
    // file-stat check and return the cached record directly.
    if (cached && cached.mtimeMs === -1) {
      if (hostPersistShadowChatIds.has(chatId)) {
        // Host-routed save: the dirty marker has no deferred-write callback to
        // re-anchor it, and the Host itself also writes this record (solo run
        // lifecycle, thread.configure). Reconcile against the real file: once
        // it carries a revision at or beyond ours, the durable record wins and
        // the cache re-anchors to the real stat — the shadow heals instead of
        // freezing the transcript or looping revision conflicts.
        try {
          const stat = fs.statSync(chatPath)
          const onDiskRaw = readJson<ChatRecord | null>(chatPath, null)
          if (onDiskRaw) {
            const onDisk = this.normalizeChatRecord(onDiskRaw)
            if (chatPersistenceRevision(onDisk) >= chatPersistenceRevision(cached.record)) {
              const record = chatComposerSelectionOverlayStore.apply(onDisk)
              this.chatRecordCache.set(chatId, {
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                record
              })
              hostPersistShadowChatIds.delete(chatId)
              return record
            }
          }
        } catch {
          // The Host has not created/landed the file yet — serve the shadow.
        }
      }
      const record = chatComposerSelectionOverlayStore.apply(cached.record)
      cached.record = record
      return record
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(chatPath)
    } catch {
      this.chatRecordCache.delete(chatId)
      return null
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      const record = chatComposerSelectionOverlayStore.apply(cached.record)
      cached.record = record
      return record
    }
    const chat = readJson<ChatRecord | null>(chatPath, null)
    if (!chat) return null
    const legacyRecord = this.normalizeChatRecord(chat)
    let record = legacyRecord
    try {
      const replayed = incrementalChatPersistence.replay(chatId).record
      if (replayed) {
        const incrementalRecord = this.normalizeChatRecord(replayed)
        const legacyRevision = chatPersistenceRevision(legacyRecord)
        const incrementalRevision = chatPersistenceRevision(incrementalRecord)
        if (
          incrementalRevision > legacyRevision ||
          (incrementalRevision === legacyRevision &&
            isDeepStrictEqual(incrementalRecord, legacyRecord))
        ) {
          record = incrementalRecord
        } else if (incrementalRevision === legacyRevision) {
          console.warn(
            `[incremental-chat] equal-revision replay mismatch for ${chatId}; ` +
              'using the compatibility checkpoint'
          )
        }
      }
    } catch (error) {
      console.error(
        `[incremental-chat] replay failed for ${chatId}; using the compatibility checkpoint`,
        error
      )
    }
    record = chatComposerSelectionOverlayStore.apply(record)
    this.chatRecordCache.set(chatId, { mtimeMs: stat.mtimeMs, size: stat.size, record })
    return record
  }

  private static orphanSubThreadsReaped = false
  private static orphanSubThreadReapCandidates = new Set<string>()

  /** One-time-per-process discovery of child chats (sub-threads / side-chats /
   * guests) whose parent chat FILE no longer exists. Historically `deleteChat`
   * did not cascade, so deleting a parent stranded its children on disk; those
   * orphans then surfaced on iOS as perpetual "running" tombstones and inflated
   * the remote thread count. Runs lazily on the first getChats() so it needs no
   * startup wiring. Discovery is intentionally read-only: main drains these
   * candidates through the same lifecycle-fenced deletion authority as every
   * renderer/reaper delete. Failed candidates remain queued for retry.
   * Parent existence is checked by FILE presence — never the parsed list — so a
   * transiently unparseable parent can never cause its children to be reaped.
   * Best-effort: any failure leaves data untouched. */
  private static ensureOrphanSubThreadsReaped(): void {
    if (this.orphanSubThreadsReaped) return
    this.orphanSubThreadsReaped = true
    try {
      if (!fs.existsSync(chatsDir)) return
      // Reading each ChatRecord here replays that chat's journal, so this scan
      // used to cost seconds of every boot to answer one field. The chat-list
      // index carries parentChatId with the mtime/size it was built from; a
      // stat decides whether that cheap answer is still true, and anything it
      // cannot vouch for still takes the full read below.
      const chatListIndex = chatListIndexStore.readAll()
      const { candidates } = collectOrphanSubThreadCandidates({
        listChatIds: () =>
          fs
            .readdirSync(chatsDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => path.basename(f, '.json')),
        statChatFile: (chatId) => {
          try {
            const stat = fs.statSync(path.join(chatsDir, `${chatId}.json`))
            return { mtimeMs: stat.mtimeMs, size: stat.size }
          } catch {
            return null
          }
        },
        indexEntry: (chatId) => chatListIndex[chatId],
        readChatRecord: (chatId) =>
          this.readChatRecordCached(chatId, path.join(chatsDir, `${chatId}.json`)) ?? null,
        parentChatExists: (parentChatId) => fs.existsSync(chatPathForId(chatsDir, parentChatId))
      })
      for (const candidate of candidates) {
        this.orphanSubThreadReapCandidates.add(candidate)
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
      if (
        chat &&
        !this.orphanSubThreadReapCandidates.has(chat.appChatId) &&
        (!workspaceId || chat.workspaceId === workspaceId)
      ) {
        chats.push(chat)
      }
    }
    return chats.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  static listOrphanSubThreadReapCandidates(): string[] {
    this.ensureOrphanSubThreadsReaped()
    return [...this.orphanSubThreadReapCandidates].sort()
  }

  static acknowledgeOrphanSubThreadReapCandidate(chatId: string): void {
    if (!isSafeChatId(chatId)) return
    this.orphanSubThreadReapCandidates.delete(chatId)
  }

  static getPinnedMessages(workspaceId?: string): PinnedMessageGroup[] {
    const workspacesById = new Map(
      this.getWorkspaces().map((workspace) => [workspace.id, workspace])
    )
    const groups = new Map<string, PinnedMessageGroup>()

    for (const chat of this.getChats(workspaceId)) {
      const messages = (chat.messages || [])
        .filter((message) => !isRetiredExternalChannelInboundMessage(message))
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

  static async getThreadWorktreeBinding(
    chatId: string
  ): Promise<ThreadWorktreeBinding | undefined> {
    return readThreadWorktreeBinding({ chatsDir, chatId })
  }

  /**
   * Persist only the worktree identity without routing a full chat record
   * through saveChat's synchronous writeJson path. The allocator invokes this
   * after Git has prepared a worktree, so an actionable write failure can be
   * surfaced before the run starts.
   */
  static persistThreadWorktreeBinding(
    chatId: string,
    binding: ThreadWorktreeBinding
  ): Promise<ChatRecord> {
    if (!isSafeChatId(chatId)) {
      return Promise.reject(new Error('An isolated worktree can only be bound to a saved chat.'))
    }

    const previous: Promise<ChatRecord | null> =
      this.threadWorktreeBindingWriteTails.get(chatId) || Promise.resolve(null)
    const operation = previous
      .catch(() => null)
      .then(async () => {
        if (deletedChatIds.has(chatId)) {
          throw new Error('This chat was deleted before its isolated worktree could be bound.')
        }
        const persisted = await persistThreadWorktreeBindingPatch({
          chatsDir,
          chatId,
          binding,
          admitMutation: async (chat) => {
            await this.assertHistoryMutationAllowedAsync({
              operation: 'Thread worktree binding persistence',
              chatIds: [chat.appChatId],
              workspaceIds: [chat.workspaceId]
            })
          }
        })
        // The patcher deliberately avoids synchronous stat/index maintenance.
        // Let the normal cached read validate from disk on the next consumer.
        this.chatRecordCache.delete(chatId)
        return persisted
      })
    this.threadWorktreeBindingWriteTails.set(chatId, operation)
    void operation.then(
      () => {
        if (this.threadWorktreeBindingWriteTails.get(chatId) === operation) {
          this.threadWorktreeBindingWriteTails.delete(chatId)
        }
      },
      () => {
        if (this.threadWorktreeBindingWriteTails.get(chatId) === operation) {
          this.threadWorktreeBindingWriteTails.delete(chatId)
        }
      }
    )
    return operation
  }

  static async getFanoutWorktreeCandidates(chatId: string): Promise<FanoutWorktreeCandidate[]> {
    return readFanoutWorktreeCandidates({ chatsDir, chatId })
  }

  /**
   * Record or replace one fan-out worktree candidate via the async atomic
   * patcher — the ONLY writer for this main-owned field (saveChat strips and
   * re-merges it). Per-chat tails keep upserts and patches strictly ordered.
   */
  static upsertFanoutWorktreeCandidate(
    chatId: string,
    candidate: FanoutWorktreeCandidate
  ): Promise<ChatRecord> {
    return this.enqueueFanoutCandidateWrite(chatId, () =>
      upsertFanoutWorktreeCandidatePatch({
        chatsDir,
        chatId,
        candidate,
        admitMutation: async (chat) => {
          await this.assertHistoryMutationAllowedAsync({
            operation: 'Fan-out candidate persistence',
            chatIds: [chat.appChatId],
            workspaceIds: [chat.workspaceId]
          })
        }
      })
    ) as Promise<ChatRecord>
  }

  /** Merge a partial update into one candidate; resolves null when absent. */
  static patchFanoutWorktreeCandidate(
    chatId: string,
    candidateId: string,
    patch: Partial<Omit<FanoutWorktreeCandidate, 'schemaVersion' | 'candidateId'>>
  ): Promise<ChatRecord | null> {
    return this.enqueueFanoutCandidateWrite(chatId, () =>
      patchFanoutWorktreeCandidateRecord({
        chatsDir,
        chatId,
        candidateId,
        patch,
        admitMutation: async (chat) => {
          await this.assertHistoryMutationAllowedAsync({
            operation: 'Fan-out candidate persistence',
            chatIds: [chat.appChatId],
            workspaceIds: [chat.workspaceId]
          })
        }
      })
    )
  }

  private static enqueueFanoutCandidateWrite(
    chatId: string,
    write: () => Promise<ChatRecord | null>
  ): Promise<ChatRecord | null> {
    if (!isSafeChatId(chatId)) {
      return Promise.reject(new Error('A fan-out candidate can only be recorded on a saved chat.'))
    }
    const previous: Promise<ChatRecord | null> =
      this.fanoutCandidateWriteTails.get(chatId) || Promise.resolve(null)
    const operation = previous
      .catch(() => null)
      .then(async () => {
        if (deletedChatIds.has(chatId)) {
          throw new Error('This chat was deleted before its fan-out candidate could be recorded.')
        }
        const persisted = await write()
        this.chatRecordCache.delete(chatId)
        return persisted
      })
    this.fanoutCandidateWriteTails.set(chatId, operation)
    void operation.then(
      () => {
        if (this.fanoutCandidateWriteTails.get(chatId) === operation) {
          this.fanoutCandidateWriteTails.delete(chatId)
        }
      },
      () => {
        if (this.fanoutCandidateWriteTails.get(chatId) === operation) {
          this.fanoutCandidateWriteTails.delete(chatId)
        }
      }
    )
    return operation
  }

  /**
   * Persist only the watched-PR opt-in without routing a full chat record
   * through saveChat's synchronous writeJson path. The composer toggle invokes
   * this before the watch is considered active, so an actionable write failure
   * can be surfaced while the toggle state is still recoverable. Passing null
   * clears the watch; the per-chat tails keep set/clear strictly ordered.
   */
  static persistWatchedPr(
    chatId: string,
    watchedPr: WatchedPrDescriptor | null
  ): Promise<ChatRecord> {
    if (!isSafeChatId(chatId)) {
      return Promise.reject(new Error('A pull request can only be watched from a saved chat.'))
    }

    const previous: Promise<ChatRecord | null> =
      this.watchedPrWriteTails.get(chatId) || Promise.resolve(null)
    const operation = previous
      .catch(() => null)
      .then(async () => {
        if (deletedChatIds.has(chatId)) {
          throw new Error('This chat was deleted before its PR watch could be updated.')
        }
        const persisted = await persistWatchedPrPatch({
          chatsDir,
          chatId,
          watchedPr,
          admitMutation: async (chat) => {
            await this.assertHistoryMutationAllowedAsync({
              operation: 'Watched PR persistence',
              chatIds: [chat.appChatId],
              workspaceIds: [chat.workspaceId]
            })
          }
        })
        this.chatRecordCache.delete(chatId)
        return persisted
      })
    this.watchedPrWriteTails.set(chatId, operation)
    void operation.then(
      () => {
        if (this.watchedPrWriteTails.get(chatId) === operation) {
          this.watchedPrWriteTails.delete(chatId)
        }
      },
      () => {
        if (this.watchedPrWriteTails.get(chatId) === operation) {
          this.watchedPrWriteTails.delete(chatId)
        }
      }
    )
    return operation
  }

  /**
   * Persist only the per-thread git workflow marker without routing a full
   * chat record through saveChat's synchronous writeJson path. Reporters (the
   * renderer's satellite observer, the watch-PR poller) pre-filter with
   * chatGitWorkflowDiffers, so this only runs on genuine changes. Passing null
   * clears the marker; the per-chat tails keep set/clear strictly ordered.
   */
  static persistChatGitWorkflow(
    chatId: string,
    gitWorkflow: ChatGitWorkflowInput | null
  ): Promise<ChatRecord> {
    if (!isSafeChatId(chatId)) {
      return Promise.reject(new Error('A git workflow can only be recorded on a saved chat.'))
    }

    const previous: Promise<ChatRecord | null> =
      this.chatGitWorkflowWriteTails.get(chatId) || Promise.resolve(null)
    const operation = previous
      .catch(() => null)
      .then(async () => {
        if (deletedChatIds.has(chatId)) {
          throw new Error('This chat was deleted before its git workflow could be recorded.')
        }
        const persisted = await persistChatGitWorkflowPatch({
          chatsDir,
          chatId,
          gitWorkflow,
          admitMutation: async (chat) => {
            await this.assertHistoryMutationAllowedAsync({
              operation: 'Git workflow marker persistence',
              chatIds: [chat.appChatId],
              workspaceIds: [chat.workspaceId]
            })
          }
        })
        this.chatRecordCache.delete(chatId)
        return persisted
      })
    this.chatGitWorkflowWriteTails.set(chatId, operation)
    void operation.then(
      () => {
        if (this.chatGitWorkflowWriteTails.get(chatId) === operation) {
          this.chatGitWorkflowWriteTails.delete(chatId)
        }
      },
      () => {
        if (this.chatGitWorkflowWriteTails.get(chatId) === operation) {
          this.chatGitWorkflowWriteTails.delete(chatId)
        }
      }
    )
    return operation
  }

  static persistChatComposerSelection(
    request: ChatComposerSelectionPatchRequest
  ): Promise<{ chat: ChatRecord; changed: boolean }> {
    if (!isSafeChatId(request.chatId)) {
      return Promise.reject(new Error('A composer selection can only be recorded on a saved chat.'))
    }
    const previous =
      this.chatComposerSelectionWriteTails.get(request.chatId) || Promise.resolve(null)
    const operation = previous
      .catch(() => null)
      .then(async () => {
        if (deletedChatIds.has(request.chatId)) {
          throw new Error('This chat was deleted before its composer selection could be recorded.')
        }
        const current = this.getChat(request.chatId)
        if (!current) throw new Error('Chat not found.')
        if (this.getSettings().storeLocalChatHistory === false) {
          const chat = applyChatComposerSelectionPatch(current, request)
          if (chat !== current) {
            const cached = this.chatRecordCache.get(request.chatId)
            if (cached) cached.record = chat
          }
          return { chat, changed: chat !== current }
        }
        await this.assertHistoryMutationAllowedAsync({
          operation: 'Composer selection persistence',
          chatIds: [current.appChatId],
          workspaceIds: [current.workspaceId]
        })
        const result = await chatComposerSelectionOverlayStore.persist(current, request)
        if (result.changed) {
          const cached = this.chatRecordCache.get(request.chatId)
          if (cached) cached.record = result.chat
          else {
            this.chatRecordCache.set(request.chatId, {
              mtimeMs: -1,
              size: -1,
              record: result.chat
            })
          }
        }
        return result
    })
    this.chatComposerSelectionWriteTails.set(request.chatId, operation)
    const clearTail = (): void => {
      if (this.chatComposerSelectionWriteTails.get(request.chatId) === operation) {
        this.chatComposerSelectionWriteTails.delete(request.chatId)
      }
    }
    void operation.then(clearTail, clearTail)
    return operation
  }

  private static readChatForFeedbackBaseline(chatId: string, chatPath: string): ChatRecord | null {
    const cached = this.chatRecordCache.get(chatId)?.record
    if (cached) return cached
    if (!fs.existsSync(chatPath)) return null
    const parsed = readJson<ChatRecord | null>(chatPath, null)
    return parsed ? this.normalizeChatRecord(parsed) : null
  }

  private static readMessageFeedbackLedger(): MessageFeedbackReceipt[] {
    const records = readJson<unknown[]>(messageFeedbackLedgerPath, [])
    return capMessageFeedbackReceipts(
      records
        .map(normalizeMessageFeedbackReceipt)
        .filter((record): record is MessageFeedbackReceipt => Boolean(record))
    )
  }

  static getMessageFeedbackReceipts(
    filter: MessageFeedbackReceiptFilter = {}
  ): MessageFeedbackReceipt[] {
    return filterMessageFeedbackReceipts(this.readMessageFeedbackLedger(), filter)
  }

  static createChat(workspaceId: string, workspacePath: string): ChatRecord {
    this.assertHistoryMutationAllowed({
      operation: 'Workspace chat creation',
      workspaceIds: [workspaceId]
    })
    const settings = this.getSettings()
    const chat: ChatRecord = {
      appChatId: randomUUID(),
      scope: 'workspace',
      chatKind: 'single',
      provider: coerceProviderForPersistence(settings.activeProvider, settings),
      title: 'New Chat',
      workspaceId,
      workspacePath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      workflowMode: 'normal',
      messages: [],
      runs: []
    }
    if (settings.storeLocalChatHistory) {
      this.saveChat(chat)
    }
    return chat
  }

  static createGlobalChat(): ChatRecord {
    this.assertHistoryMutationAllowed({ operation: 'Global chat creation' })
    const settings = this.getSettings()
    const chat: ChatRecord = {
      appChatId: randomUUID(),
      scope: 'global',
      chatKind: 'single',
      provider: coerceProviderForPersistence(settings.activeProvider, settings),
      title: 'New Chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      archived: false,
      workflowMode: 'normal',
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
    this.assertHistoryMutationAllowed({
      operation: 'Ensemble chat creation',
      workspaceIds: [args.workspaceId]
    })
    const settings = this.getSettings()
    const activeProvider = coerceProviderForPersistence(settings.activeProvider, settings)
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
      workflowMode: 'normal',
      messages: [],
      runs: [],
      ensemble: createDefaultEnsembleConfig(activeProvider, configuredProviders)
    }
    if (settings.storeLocalChatHistory) {
      this.saveChat(chat)
    }
    return chat
  }

  /**
   * Slice C — in-place mid-thread ensemble toggle (Q1=D locked semantics).
   * Flips `chatKind` on the SAME appChatId, preserving all messages/runs/history.
   *
   * IDLE-ONLY (running-guard LOCKED): rejects while a run streams or an ensemble
   * round is live. A chatKind flip swaps the entire runtime model (solo dispatch
   * ↔ ensemble orchestrator), so toggling mid-run would orphan the activeRound /
   * seat-locks / dispatch. The renderer also disables the toggle — this backend
   * reject is defense in depth. Guard reads record-derivable signals only; it
   * does NOT reach into EnsembleOrchestrator runtime.
   *
   * Solo→Ensemble: writes the ensemble block seeded with the ONE participant the
   * renderer passes in (built from the chat's current provider + providerMetadata
   * via `getDefaultEnsembleParticipantConfig`, which is renderer-only — same
   * pattern as Slice B's renderer-baked provider metadata), topped up to
   * `MIN_LIVE_ENSEMBLE_PARTICIPANTS` so switching the mode ON yields an actual
   * panel rather than a one-seat roster. An explicit roster MUST be written
   * before save, or `normalizeChatRecord` auto-fills the full default
   * multi-provider roster.
   *
   * Ensemble→Solo: strips the ensemble block, sets `chat.provider` to the
   * renderer-chosen canonical provider (never leave it stale), `chatKind:'single'`.
   * Transcript + runs are preserved verbatim.
   */
  static setChatKind(
    chatId: string,
    targetKind: ChatKind,
    opts: {
      /** Solo→Ensemble: the single seed participant (renderer-built). */
      seedParticipant?: EnsembleParticipant
      /** Ensemble→Solo: the canonical provider the user picked in the modal. */
      canonicalProvider?: ProviderId
      /** Ensemble→Solo: optional provider-scoped metadata for the canonical provider. */
      canonicalProviderMetadata?: Record<string, unknown>
    } = {}
  ): ChatRecord {
    const chat = this.getChat(chatId)
    if (!chat) {
      throw new Error(`Cannot change chat mode: chat ${chatId} not found`)
    }
    const currentKind: ChatKind = chat.chatKind === 'ensemble' ? 'ensemble' : 'single'
    const nextKind: ChatKind = targetKind === 'ensemble' ? 'ensemble' : 'single'
    if (currentKind === nextKind) {
      return chat // no-op — already the requested kind
    }
    // Running-guard (idle-only, LOCKED): reject while a run streams or an
    // ensemble round is live. Record-derivable signals only.
    const hasRunningRun = (chat.runs ?? []).some((run) => run.status === 'running')
    const roundLive = isEnsembleRoundDispatchLive(chat.ensemble?.activeRound)
    if (hasRunningRun || roundLive) {
      throw new Error(
        'Cannot change chat mode while a turn is active — finish the current turn first.'
      )
    }
    const now = Date.now()
    if (nextKind === 'ensemble') {
      const nowIso = new Date(now).toISOString()
      // E3 preserve-roster: if this chat was previously collapsed from an
      // Ensemble (roster stashed under providerMetadata.stashedEnsemble) AND the
      // solo provider is unchanged since that collapse, RESTORE the full stashed
      // roster instead of re-seeding a single participant — so a toggle back to
      // Ensemble does not lose the user's roster/settings. If the provider
      // changed in between, the stash is stale → fresh single-participant seed.
      const priorMetadata = chat.providerMetadata
      const stash = priorMetadata?.stashedEnsemble as
        | { config?: EnsembleConfig; provider?: ProviderId }
        | undefined
      const stashedConfig = stash?.config
      const restorable =
        !!stashedConfig &&
        stash?.provider === chat.provider &&
        Array.isArray(stashedConfig.participants) &&
        stashedConfig.participants.length > 0

      let ensemble: EnsembleConfig
      if (restorable) {
        ensemble = {
          ...(stashedConfig as EnsembleConfig),
          participants: withMinimumEnsembleRoster(
            (stashedConfig as EnsembleConfig).participants.map(resetEnsembleParticipantSession)
          ),
          updatedAt: nowIso
        }
      } else {
        // Reuse the default config scaffolding (maxParticipants / orchestration /
        // hops) but replace the roster with the seed participant, so
        // normalizeChatRecord keeps it (participants.length > 0) instead of
        // auto-filling the multi-provider default roster.
        const seed = opts.seedParticipant
        if (!seed) {
          throw new Error('Cannot convert to Ensemble without a seed participant')
        }
        // The seed crosses the renderer trust boundary. A provider-session MCP
        // profile receipt is main-owned and cannot be introduced through this
        // shape, even when the rest of the seed is valid.
        const trustedSeed = resetEnsembleParticipantSession(seed)
        const base = createDefaultEnsembleConfig(chat.provider)
        ensemble = {
          ...base,
          // Turning Ensemble ON means asking for a panel. Both callers (the
          // desktop composer toggle and the phone's) send ONE seat built from
          // the chat's current provider; the floor supplies the second so the
          // user never lands in a one-seat Ensemble they have to populate
          // before the mode does anything.
          participants: withMinimumEnsembleRoster([trustedSeed]),
          updatedAt: nowIso
        }
      }

      const updated: ChatRecord = {
        ...chat,
        chatKind: 'ensemble',
        ensemble,
        updatedAt: now
      }
      // Solo and ensemble native sessions have different ownership lanes. Do
      // not leave a top-level profile receipt detached when the solo lane is
      // replaced by participant-scoped sessions.
      delete updated.linkedProviderSessionId
      delete updated.taskWraithMcpProfileReceipt
      // Consume the stash on any expand (restored OR invalidated by a provider
      // change) so a stale roster can't resurrect on a later toggle.
      if (priorMetadata && 'stashedEnsemble' in priorMetadata) {
        const { stashedEnsemble: _consumed, ...restMetadata } = priorMetadata
        if (Object.keys(restMetadata).length > 0) {
          updated.providerMetadata = restMetadata
        } else {
          delete updated.providerMetadata
        }
      }
      this.saveChat(updated)
      return this.getChat(chatId) ?? updated
    }
    // Ensemble→Solo: strip the ensemble block, set the canonical provider.
    // E2-backend-fallback (defense-in-depth): when the renderer did NOT pass an
    // explicit canonicalProvider, derive the canonical from the ensemble's Boss
    // participant (id === bossmanParticipantId), else the lowest-order ENABLED
    // participant (first-to-speak) — the SAME rule the renderer's E2 modal uses,
    // so backend + UI agree. Only then fall back to the (possibly stale) legacy
    // chat.provider, then settings.activeProvider. The renderer normally passes
    // canonicalProvider explicitly, so this is a safety net, not the hot path.
    const pickBossDefaultParticipant = (
      config: EnsembleConfig | undefined
    ): EnsembleParticipant | undefined => {
      const participants = config?.participants
      if (!Array.isArray(participants) || participants.length === 0) return undefined
      const bossId = config?.bossmanParticipantId
      if (bossId) {
        const boss = participants.find((participant) => participant.id === bossId)
        if (boss) return boss
      }
      const enabled = participants.filter((participant) => participant.enabled !== false)
      if (enabled.length === 0) return undefined
      return enabled.reduce(
        (best, participant) => ((participant.order ?? 0) < (best.order ?? 0) ? participant : best),
        enabled[0]
      )
    }
    const buildFallbackCanonicalMetadata = (
      participant: EnsembleParticipant
    ): Record<string, unknown> => {
      const derived: Record<string, unknown> = {}
      if (participant.model) derived.selectedModelType = participant.model
      if (participant.reasoningEffort) {
        if (participant.provider === 'codex') {
          derived.codexReasoningEffort = participant.reasoningEffort
        } else if (participant.provider === 'claude') {
          derived.claudeReasoningEffort = participant.reasoningEffort
        } else if (participant.provider === 'grok' && isGrokReasoningModelId(participant.model)) {
          derived.grokReasoningEffort = participant.reasoningEffort
        } else if (participant.provider === 'muse') {
          derived.museReasoningEffort = participant.reasoningEffort
        } else if (participant.provider === 'ollama') {
          derived.ollamaReasoningEffort = participant.reasoningEffort
        } else if (participant.provider === 'cursor' && isCursorGrokModelId(participant.model)) {
          derived.cursorReasoningEffort = participant.reasoningEffort
        } else if (participant.provider === 'antigravity') {
          derived.antigravityReasoningEffort = participant.reasoningEffort
        }
      }
      if (participant.provider === 'cursor' && participant.fastModeEnabled !== undefined) {
        derived.cursorFastMode = participant.fastModeEnabled
      }
      return derived
    }
    const bossDefault = opts.canonicalProvider
      ? undefined
      : pickBossDefaultParticipant(chat.ensemble)
    const settings = this.getSettings()
    const canonicalProvider =
      opts.canonicalProvider ||
      bossDefault?.provider ||
      chat.provider ||
      coerceProviderForPersistence(settings.activeProvider, settings)
    const nowIso = new Date(now).toISOString()
    const {
      ensemble: priorEnsemble,
      linkedProviderSessionId: _dropProviderSession,
      taskWraithMcpProfileReceipt: _dropMcpProfileReceipt,
      ...withoutEnsemble
    } = chat

    let providerMetadata: Record<string, unknown> | undefined = withoutEnsemble.providerMetadata
      ? { ...withoutEnsemble.providerMetadata }
      : undefined
    // Explicit modal metadata wins; else, when we derived the Boss default
    // above, carry that participant's model/reasoning so the solo composer opens
    // on the Boss's settings (defense-in-depth — the renderer normally passes it).
    if (opts.canonicalProviderMetadata) {
      providerMetadata = { ...(providerMetadata || {}), ...opts.canonicalProviderMetadata }
    } else if (bossDefault) {
      const derived = buildFallbackCanonicalMetadata(bossDefault)
      if (Object.keys(derived).length > 0) {
        providerMetadata = { ...(providerMetadata || {}), ...derived }
      }
    }
    // E3 preserve-roster: stash the outgoing roster so a later toggle back to
    // Ensemble can restore it. Stash under providerMetadata — NOT on
    // chat.ensemble, whose mere presence keys buildRemoteEnsembleState() and
    // would leak the roster onto this now-solo chat's remote/iOS projection.
    // Drop the ephemeral activeRound (dispatch state, not roster config; the
    // idle-only guard above already bars a live round).
    if (
      priorEnsemble &&
      Array.isArray(priorEnsemble.participants) &&
      priorEnsemble.participants.length > 0
    ) {
      const { activeRound: _dropRound, ...stashableConfig } = priorEnsemble
      const stashableParticipants = stashableConfig.participants.map(
        resetEnsembleParticipantSession
      )
      providerMetadata = {
        ...(providerMetadata || {}),
        stashedEnsemble: {
          config: { ...stashableConfig, participants: stashableParticipants },
          provider: canonicalProvider,
          stashedAt: nowIso
        }
      }
    }

    const updated: ChatRecord = {
      ...withoutEnsemble,
      chatKind: 'single',
      provider: canonicalProvider,
      ...(providerMetadata ? { providerMetadata } : {}),
      updatedAt: now
    }
    this.saveChat(updated)
    return this.getChat(chatId) ?? updated
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
    grokReasoningEffort?: string | null
    museReasoningEffort?: string | null
    ollamaReasoningEffort?: string | null
    cursorReasoningEffort?: string | null
    antigravityReasoningEffort?: string | null
    cursorFastMode?: boolean
  }): ChatRecord {
    const parent = this.getChat(args.parentChatId)
    if (!parent) {
      throw new Error(`Cannot create side chat: parent chat ${args.parentChatId} not found`)
    }
    this.assertHistoryMutationAllowed({
      operation: 'Side-chat creation',
      chatIds: [args.parentChatId],
      workspaceIds: [parent.workspaceId]
    })

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
    const provider = coerceProviderForPersistence(
      args.provider || parent.provider || settings.activeProvider,
      settings
    )
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
        : {}),
      ...(args.grokReasoningEffort !== undefined
        ? { grokReasoningEffort: args.grokReasoningEffort }
        : {}),
      ...(args.museReasoningEffort !== undefined
        ? { museReasoningEffort: args.museReasoningEffort }
        : {}),
      ...(args.ollamaReasoningEffort !== undefined
        ? { ollamaReasoningEffort: args.ollamaReasoningEffort }
        : {}),
      ...(args.cursorReasoningEffort !== undefined
        ? { cursorReasoningEffort: args.cursorReasoningEffort }
        : {}),
      ...(args.antigravityReasoningEffort !== undefined
        ? { antigravityReasoningEffort: args.antigravityReasoningEffort }
        : {}),
      ...(args.cursorFastMode !== undefined ? { cursorFastMode: args.cursorFastMode } : {})
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
      workflowMode: normalizeChatWorkflowMode(parent.workflowMode),
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
    joinPolicy?: SubThreadJoinPolicy
    /** Override the workspace if the user explicitly picked a
     * different one. Defaults to inheriting the parent's workspace. */
    workspaceId?: string
    workspacePath?: string
    /** Ephemeral fleet die-on-return vs durable recallable child. */
    lifecycle?: 'ephemeral' | 'durable'
    /**
     * Agent-assigned fleet role. Parallel to EnsembleStageRole literals —
     * do not unify types.
     */
    role?: 'scout' | 'worker' | 'reviewer' | string
    label?: string
    title?: string
    /** Ensemble participant id of the calling seat; omitted on solo chats. */
    spawnedBy?: string
    /** App run id of the parent run issuing the delegation (for
     * terminalization cascade). Omitted when the caller has no run id. */
    parentAppRunId?: string
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
    this.assertHistoryMutationAllowed({
      operation: 'Sub-thread creation',
      chatIds: [args.parentChatId],
      workspaceIds: [parent.workspaceId, workspaceId]
    })
    const chat: ChatRecord = {
      appChatId: randomUUID(),
      // Scope inherited from parent — a sub-thread of a workspace
      // chat stays a workspace chat; a sub-thread of a global chat
      // stays global.
      scope: parent.scope ?? 'workspace',
      chatKind: 'single',
      provider: args.provider,
      title:
        typeof args.title === 'string' && args.title.trim()
          ? args.title.trim()
          : `Sub-thread (${args.provider})`,
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
        parentProvider: coerceProviderForPersistence(
          parent.provider ?? settings.activeProvider,
          settings
        ),
        delegationPrompt: args.delegationPrompt,
        returnResultToParent: args.returnResultToParent,
        ...(args.joinPolicy ? { joinPolicy: { ...args.joinPolicy } } : {}),
        ...(args.lifecycle === 'ephemeral' || args.lifecycle === 'durable'
          ? { lifecycle: args.lifecycle }
          : {}),
        ...(typeof args.role === 'string' && args.role.trim() ? { role: args.role.trim() } : {}),
        ...(typeof args.label === 'string' && args.label.trim() ? { label: args.label.trim() } : {}),
        ...(typeof args.spawnedBy === 'string' && args.spawnedBy.trim()
          ? { spawnedBy: args.spawnedBy.trim() }
          : {}),
        ...(typeof args.parentAppRunId === 'string' && args.parentAppRunId.trim()
          ? { parentAppRunId: args.parentAppRunId.trim() }
          : {})
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

  static saveChat(chat: ChatRecord, options: ChatSaveOptions = {}): ChatRecord {
    // When the legacy writer gate is open (or a drain is retaining this exact
    // writer), persist through the proven admitted path unchanged. Since the
    // Host cutover the gate is Host-owned and admission throws
    // LegacyStoreWriterGateClosedError — route the save through the Host
    // instead (thread.record.persist). Both branches stay synchronous for the
    // 86 existing call sites.
    if (legacyStoreCanWrite()) {
      return runLegacyStoreWriteAdmission(
        { operation: 'save-chat', pathFamily: 'chats' },
        (writerAdmission) => this.saveChatAdmitted(chat, options, writerAdmission)
      )
    }
    return this.saveChatThroughHost(chat)
  }

  /**
   * Host-owned-gate persistence path. Updates the in-memory projection
   * synchronously (cache, input-object revision stamp, broadcast envelope) and
   * enqueues the complete record for the Host's `thread.record.persist`
   * command. The enqueue never throws; durability is raised at explicit
   * barriers (`awaitChatRecordPersisted`) so a genuine persistence failure
   * still surfaces loudly at round start instead of silently at 85 call sites.
   * A revision conflict is not such a failure: the barrier rebases onto the
   * Host record and, failing that, re-anchors this optimistic revision to the
   * Host's so the NEXT save can land. The stamp below only ever advances, so
   * without that re-anchor one rejected write wedges the chat forever.
   *
   * Revision contract: the Host owns the counter (persistThreadRecord writes 0
   * on create and previous+1 on update), so the enqueued record is stamped
   * with the value this compare-and-swap will write, and expectedRevision is
   * the revision the caller last observed. Host-native lifecycle/configuration
   * writes may advance the record concurrently; the durability barrier rebases
   * this accumulated Desktop intent onto that newer source within a strict
   * retry bound.
   */
  private static saveChatThroughHost(chat: ChatRecord): ChatRecord {
    this.assertHistoryMutationAllowed({
      operation: 'Chat persistence',
      chatIds: [chat.appChatId, chat.parentChatId],
      workspaceIds: [chat.workspaceId],
      runIds: (chat.runs || []).map((run) => run.runId)
    })
    const settings = this.getSettings()
    if (!settings.storeLocalChatHistory) return chat
    if ((chat as Partial<ChatListItem>).summaryOnly === true) {
      throw new Error('Cannot save a summary-only chat record; hydrate the chat first.')
    }
    const chatPath = chatPathForId(chatsDir, chat.appChatId)
    const previousChatForFeedback = this.readChatForFeedbackBaseline(chat.appChatId, chatPath)
    // Same main-owned-field protection as the admitted path: renderer-owned
    // records can lag main's async patchers, and a lean chat-list ensemble row
    // must never erase the stored roster.
    const {
      threadWorktreeBinding: _rendererThreadWorktreeBinding,
      watchedPr: _rendererWatchedPr,
      gitWorkflow: _rendererGitWorkflow,
      fanoutWorktreeCandidates: _rendererFanoutWorktreeCandidates,
      ...rendererOwnedChat
    } = chat
    const chatWithMainOwnedFields: ChatRecord = {
      ...rendererOwnedChat,
      ...(previousChatForFeedback?.threadWorktreeBinding
        ? { threadWorktreeBinding: { ...previousChatForFeedback.threadWorktreeBinding } }
        : {}),
      ...(previousChatForFeedback?.watchedPr
        ? { watchedPr: { ...previousChatForFeedback.watchedPr } }
        : {}),
      ...(previousChatForFeedback?.gitWorkflow
        ? { gitWorkflow: { ...previousChatForFeedback.gitWorkflow } }
        : {}),
      ...(previousChatForFeedback?.fanoutWorktreeCandidates?.length
        ? {
            fanoutWorktreeCandidates: previousChatForFeedback.fanoutWorktreeCandidates.map(
              (candidate) => ({ ...candidate })
            )
          }
        : {}),
      ...(this.isChatListEnsembleProjection(chat.ensemble)
        ? previousChatForFeedback?.ensemble
          ? { ensemble: previousChatForFeedback.ensemble }
          : { ensemble: this.withoutChatListEnsembleProjectionFlag(chat.ensemble!) }
        : {})
    }
    const normalizedChat = this.normalizeChatRecord(chatWithMainOwnedFields)
    normalizedChat.updatedAt = Date.now()
    const expectedRevision = chatPersistenceRevision(previousChatForFeedback)
    normalizedChat.persistenceRevision =
      previousChatForFeedback === null ? 0 : expectedRevision + 1
    // Tombstone guard: a deleted chat must never be re-saved. The Host-routed
    // delete is an async round trip, so unlike the legacy path (where the
    // unlink is synchronous) the window cannot be narrowed by a stat — honor
    // the tombstone for the whole in-flight erasure, or a late save would
    // resurrect a chat the user just deleted.
    if (deletedChatIds.has(normalizedChat.appChatId)) {
      return previousChatForFeedback || normalizedChat
    }
    // In-memory projection: this process reads the new record immediately.
    this.chatRecordCache.set(normalizedChat.appChatId, {
      mtimeMs: -1,
      size: -1,
      record: normalizedChat
    })
    hostPersistShadowChatIds.add(normalizedChat.appChatId)
    const chatUpdateProjection: ChatUpdateProjectionObservation = {
      state: chatUpdateProjectionTracker.seed(normalizedChat),
      delta: null
    }
    attachChatUpdateProducerEnvelope(normalizedChat, chatUpdateProjection)
    attachChatUpdateProducerEnvelope(chat, chatUpdateProjection)
    chat.persistenceRevision = normalizedChat.persistenceRevision
    noteHostPersistIntent(previousChatForFeedback, normalizedChat)
    hostPersistUnconfirmedChatIds.add(normalizedChat.appChatId)
    hostThreadRecordPersist().enqueue({
      chatId: normalizedChat.appChatId,
      record: normalizedChat,
      expectedRevision
    })
    return normalizedChat
  }

  private static saveChatAdmitted(
    chat: ChatRecord,
    options: ChatSaveOptions,
    writerAdmission: LegacyStoreWriteAdmissionScope
  ): ChatRecord {
    this.assertHistoryMutationAllowed({
      operation: 'Chat persistence',
      chatIds: [chat.appChatId, chat.parentChatId],
      workspaceIds: [chat.workspaceId],
      runIds: (chat.runs || []).map((run) => run.runId)
    })
    const settings = this.getSettings()
    if (!settings.storeLocalChatHistory) return chat
    if ((chat as Partial<ChatListItem>).summaryOnly === true) {
      throw new Error('Cannot save a summary-only chat record; hydrate the chat first.')
    }

    const chatPath = chatPathForId(chatsDir, chat.appChatId)
    const previousChatForFeedback = this.readChatForFeedbackBaseline(chat.appChatId, chatPath)
    // These fields are written only by main-owned async patchers. Renderer
    // chat records can lag those writes, so a later whole-record save must not
    // erase a durable isolated-worktree binding, an explicit PR watch, or the
    // git workflow marker. The persisted record is authoritative even when a
    // field is absent.
    const {
      threadWorktreeBinding: _rendererThreadWorktreeBinding,
      watchedPr: _rendererWatchedPr,
      gitWorkflow: _rendererGitWorkflow,
      fanoutWorktreeCandidates: _rendererFanoutWorktreeCandidates,
      ...rendererOwnedChat
    } = chat
    const rendererMessages = chat.messages || []
    const reconciledMessages =
      previousChatForFeedback &&
      chatPersistenceRevision(chat) < chatPersistenceRevision(previousChatForFeedback)
        ? mergeMissingThreadMessageTranscriptProjections(
            rendererMessages,
            previousChatForFeedback.messages || []
          )
        : rendererMessages
    const chatWithMainOwnedFields: ChatRecord = {
      ...rendererOwnedChat,
      messages: reconciledMessages,
      ...(previousChatForFeedback?.threadWorktreeBinding
        ? { threadWorktreeBinding: { ...previousChatForFeedback.threadWorktreeBinding } }
        : {}),
      ...(previousChatForFeedback?.watchedPr
        ? { watchedPr: { ...previousChatForFeedback.watchedPr } }
        : {}),
      ...(previousChatForFeedback?.gitWorkflow
        ? { gitWorkflow: { ...previousChatForFeedback.gitWorkflow } }
        : {}),
      ...(previousChatForFeedback?.fanoutWorktreeCandidates?.length
        ? {
            fanoutWorktreeCandidates: previousChatForFeedback.fanoutWorktreeCandidates.map(
              (candidate) => ({ ...candidate })
            )
          }
        : {}),
      // A chat-list row carries a LEAN ensemble (no seat instructions, round
      // summaries, blackboard or activity ledger). The renderer merges a
      // refreshed row over a loaded record and that merge drops `summaryOnly`,
      // so such a record can reach saveChat looking fully hydrated. Persisting
      // it would silently erase every seat's brief. The stored roster wins.
      ...(this.isChatListEnsembleProjection(chat.ensemble)
        ? previousChatForFeedback?.ensemble
          ? { ensemble: previousChatForFeedback.ensemble }
          : { ensemble: this.withoutChatListEnsembleProjectionFlag(chat.ensemble!) }
        : {})
    }

    // Tool detail leaves the hot chat record before historical compaction:
    // whole runs at terminal, and sealed jumbo activities mid-run (T5 hot
    // case — the raw payload otherwise rides every flush of a live ensemble).
    // One append-only artifact is fsync'd per run, then a strict run-event
    // checkpoint binds the byte segment. If either durable step fails, retain
    // the original full activity rows and retry on a later save.
    let externalizedChat = chatWithMainOwnedFields
    let externalizedActivitiesById: ReadonlyMap<string, ToolActivity> = new Map()
    let externalizationOpRequiredIds: ReadonlySet<string> = new Set()
    try {
      const detailWriter = new ToolActivityDetailBatchWriter(runArtifactsDir)
      const externalization = externalizeToolActivityDetails(
        chatWithMainOwnedFields,
        (runId, activity) => detailWriter.stage(runId, activity),
        {
          previousChat: previousChatForFeedback,
          readArchivedDetail: (ref) => readToolActivityDetailSync(runArtifactsDir, ref),
          maxTerminalRunsPerPass: MAX_TERMINAL_TOOL_DETAIL_RUNS_PER_SAVE
        }
      )
      const checkpoints = detailWriter.commit()
      for (const checkpoint of checkpoints) {
        this.appendRunEvent(toolActivityDetailCheckpointInput(chatWithMainOwnedFields, checkpoint), {
          durability: 'strict'
        })
      }
      externalizedChat = externalization.chat
      externalizedActivitiesById = externalization.strippedActivitiesById
      externalizationOpRequiredIds = externalization.opRequiredActivityIds
    } catch (error) {
      console.error('Failed to externalize tool activity detail', error)
    }

    // Persisted-chat compaction (Step 4): historical runs shed remaining raw
    // tool events so chat files stay parse-fast and save-cheap.
    const compactedChat = compactChatForPersist(externalizedChat)
    // Exact producer operations are valid only while the save pipeline kept
    // the producer's transcript intact. Externalization is the one sanctioned
    // rewrite: its strips are substituted into the authored ops so journal
    // replay reproduces the stripped record, and any strip the ops cannot
    // express (a stage without an authoring op, a terminal fold) rejects the
    // authored chain instead. A stale renderer merge or a one-time historical
    // compaction still falls back to the proven diff derivation.
    const authoredCandidate =
      options.authoredTranscript &&
      reconciledMessages === rendererMessages &&
      compactedChat.messages === externalizedChat.messages &&
      authoredMutationMentionsActivityIds(options.authoredTranscript, externalizationOpRequiredIds)
        ? options.authoredTranscript
        : undefined
    const authoredTranscript = authoredCandidate
      ? substituteToolActivitiesInAuthoredMutation(authoredCandidate, externalizedActivitiesById)
      : undefined
    const normalizedChat = this.normalizeChatRecord(compactedChat)
    normalizedChat.updatedAt = Date.now()
    normalizedChat.persistenceRevision = chatPersistenceRevision(previousChatForFeedback) + 1
    if (deletedChatIds.has(normalizedChat.appChatId) && !fs.existsSync(chatPath)) {
      return previousChatForFeedback || normalizedChat
    }
    // If the file doesn't exist yet, write one synchronous compatibility
    // checkpoint so filesystem enumeration sees the chat immediately. Existing
    // running chats persist mutation batches; approval/terminal saves refresh
    // the compatibility file, as does the fail-safe path after a V2 error.
    // Stat of the bytes actually on disk, threaded into the chat-list index
    // entry below. Without it the entry carries no sourceChatMtimeMs/Size and
    // `getChatList` can never serve it from the index — every chat touched in a
    // session is then fully re-parsed on the next cold launch (measured
    // 2026-08-05: 136 MB re-parsed every launch, ~100% main CPU for 1-2 min).
    let indexSourceStat: { mtimeMs: number; size: number } | undefined
    let chatUpdateProjection: ChatUpdateProjectionObservation
    const chatFileExists = fs.existsSync(chatPath)
    const flushReason = deriveSaveFlushReason(normalizedChat)
    if (!chatFileExists) {
      writeJson(chatPath, normalizedChat)
      // Same contract ordering as the coalesced path: the journal must mirror
      // every legacy write, including the synchronous first save.
      appendChatJournalEntry(normalizedChat.appChatId, normalizedChat)
      persistIncrementalChat(null, normalizedChat, flushReason)
      chatUpdateProjection = {
        state: chatUpdateProjectionTracker.seed(normalizedChat),
        delta: null
      }
      let postStat: fs.Stats | null = null
      try {
        postStat = fs.statSync(chatPath)
      } catch {
        /* writeJson just succeeded; stat failure is a kernel race */
      }
      if (postStat) {
        this.chatRecordCache.set(normalizedChat.appChatId, {
          mtimeMs: postStat.mtimeMs,
          size: postStat.size,
          record: normalizedChat
        })
        indexSourceStat = { mtimeMs: postStat.mtimeMs, size: postStat.size }
      }
    } else {
      try {
        const sourceStat = fs.statSync(chatPath)
        indexSourceStat = { mtimeMs: sourceStat.mtimeMs, size: sourceStat.size }
      } catch {
        /* The compatibility checkpoint existed one branch decision ago. */
      }
      // Optimistic cache with mtimeMs: -1 dirty marker — readChatRecordCached
      // skips the compatibility-file stat and returns V2's current record.
      this.chatRecordCache.set(normalizedChat.appChatId, {
        mtimeMs: -1,
        size: -1,
        record: normalizedChat
      })
      const chatId = normalizedChat.appChatId
      const incrementalResult = persistIncrementalChat(
        previousChatForFeedback,
        normalizedChat,
        flushReason,
        authoredTranscript
      )
      chatUpdateProjection = incrementalResult?.derived
        ? chatUpdateProjectionTracker.observe(
            previousChatForFeedback!,
            normalizedChat,
            incrementalResult.derived
          )
        : {
            state: chatUpdateProjectionTracker.seed(normalizedChat),
            delta: null
          }
      const legacyWriteReason: FlushReason = incrementalResult ? flushReason : 'terminal'
      // Normal streaming saves are now complete once their mutation append is
      // fsynced. Keep whole-record writes only at compatibility barriers.
      if (legacyWriteReason !== 'normal') {
        const writeLegacyChat = (deferredSettlement: LegacyStoreDeferredSettlement): void => {
          const preStatActual = fs.existsSync(chatPath) ? fs.statSync(chatPath) : null
          // Everything that must happen AFTER the bytes land. Kept in one place
          // because the utility-write path runs it in the ACK continuation
          // rather than inline — running any of it early would publish a stat
          // for a file that has not been written yet.
          const settleAfterDurableWrite = (): void => {
            // Compatibility ordering: checkpoint file -> legacy journal. V2's
            // mutation/checkpoint is already durable before this callback, so a
            // crash between these two compatibility artifacts cannot lose the
            // authoritative state. The chat-list index remains derived and
            // self-heals from source metadata.
            appendChatJournalEntry(chatId, normalizedChat)
            try {
              const postStatActual = fs.statSync(chatPath)
              const wrote =
                !preStatActual ||
                postStatActual.mtimeMs !== preStatActual.mtimeMs ||
                postStatActual.size !== preStatActual.size
              if (wrote) {
                this.chatRecordCache.set(chatId, {
                  mtimeMs: postStatActual.mtimeMs,
                  size: postStatActual.size,
                  record: normalizedChat
                })
              }
              // When the write ran inline (coalescing disabled, or a barrier
              // flush) this callback executes BEFORE the index entry is built
              // below, so hand the stat forward and the entry is born correct.
              indexSourceStat = { mtimeMs: postStatActual.mtimeMs, size: postStatActual.size }
              // When the write was genuinely deferred, the entry already exists
              // and carries the pre-write stat — refresh it now that bytes land.
              const settled = chatListIndexStore.readEntry(chatId)
              if (
                settled &&
                (settled.sourceChatMtimeMs !== postStatActual.mtimeMs ||
                  settled.sourceChatSize !== postStatActual.size)
              ) {
                // Rebuild rather than patching the new stat onto `settled`:
                // under the write gate the settled entry can be several saves
                // old, and stamping a CURRENT stat onto STALE content would
                // satisfy chatListItemMatchesSource and mask exactly the
                // staleness the getChatList rebuild exists to catch. An entry
                // must always pair content and sourceStat from the same
                // snapshot — and this chat is what the flush just wrote.
                // Still gated: within the window the disk keeps the old pair
                // and getChatList serves the rebuilt row.
                this.writeChatListIndexEntryIfAllowed(
                  chatId,
                  this.toChatListItem(normalizedChat, {
                    mtimeMs: postStatActual.mtimeMs,
                    size: postStatActual.size
                  })
                )
              }
            } catch {
              // Cache was already set optimistically; a stale mtimeMs is harmless.
            }
          }

          const enqueueUtilityWrite = utilityWriteEnqueueFor(chatId, legacyWriteReason)
          if (!enqueueUtilityWrite) {
            writeJson(chatPath, normalizedChat)
            settleAfterDurableWrite()
            return
          }

          outstandingUtilityWriteChatIds.add(chatId)
          let utilityWrite: Promise<void>
          try {
            utilityWrite = enqueueUtilityWrite({
              chatId,
              filePath: chatPath,
              data: normalizedChat,
              revision: chatPersistenceRevision(normalizedChat)
            })
          } catch (error) {
            outstandingUtilityWriteChatIds.delete(chatId)
            throw error
          }
          deferredSettlement.markAsyncContinuation()
          void utilityWrite
            .then(() => {
              settleAfterDurableWrite()
            })
            .catch((error) => {
              // No fallback write here on purpose — the queue has already
              // performed it synchronously in FIFO order. Writing again from
              // this callback is the racing-fallback failure its header names.
              console.error('Durable chat write reported a failure', error)
            })
            .finally(() => {
              outstandingUtilityWriteChatIds.delete(chatId)
              deferredSettlement.asyncSettled()
            })
        }
        scheduleLegacyStoreDeferredWrite(
          writerAdmission,
          (write, onSettled) => {
            saveCoalescer.schedule(chatId, write, legacyWriteReason, onSettled)
          },
          writeLegacyChat
        )
      }
    }
    // The chat-list-index write and harvests stay synchronous — they're cheap
    // thanks to T3c (incremental JSONL) and don't benefit from coalescing.
    // The gate reads ONE entry, not the whole index: readAll() re-parses the
    // entire JSONL plus a summary file per chat (~485 ms on a large profile),
    // and it ran on every save. Under fan-out each lane arms its own flush, so
    // that cost was multiplied by the number of concurrent lanes.
    const nextItem = this.toChatListItem(normalizedChat, indexSourceStat)
    this.writeChatListIndexEntryIfAllowed(normalizedChat.appChatId, nextItem)
    try {
      this.harvestMessageFeedbackReceipts(previousChatForFeedback, normalizedChat)
    } catch (e) {
      console.error('Failed to harvest message feedback receipts', e)
    }
    // Agent Pool (Phase 2) — harvest finalized-run stats for any pooled-agent
    // participant. Best-effort: a harvest failure must never break the save.
    try {
      this.harvestChatAgentStats(normalizedChat)
    } catch (e) {
      console.error('Failed to harvest agent stats', e)
    }
    // Additive mission-ledger shadow. Streaming saves skip the transcript scan
    // unless the goal itself changed; terminal/idle barriers capture proposed
    // Plan state. Legacy Goal/Plan/Board reads remain authoritative for now.
    if (
      flushReason !== 'normal' ||
      !isDeepStrictEqual(previousChatForFeedback?.activeGoal, normalizedChat.activeGoal)
    ) {
      try {
        missionFactShadowService.observeChatTransition(previousChatForFeedback, normalizedChat)
      } catch (e) {
        console.error('Failed to shadow mission facts from chat', e)
      }
    }
    // Many main-owned mutation paths intentionally ignore the return value and
    // broadcast the object they passed in. Stamp the server-owned revision AND
    // the producer envelope onto that object too: the delivery coordinator
    // resolves the envelope from the exact object it is handed, so an
    // envelope-less input broadcast forces a full-record snapshot — and one
    // such save inside a delivery window breaks the delta chain for the whole
    // window (2026-08-19: 3,202 snapshots, 0 patches, renderer OOM at 5.25 GB).
    attachChatUpdateProducerEnvelope(normalizedChat, chatUpdateProjection)
    attachChatUpdateProducerEnvelope(chat, chatUpdateProjection)
    chat.persistenceRevision = normalizedChat.persistenceRevision
    return normalizedChat
  }

  /**
   * T3a-1: Synchronously flush any pending coalesced write for a specific chat.
   * Call this at trust boundaries (approval grants, terminal state transitions)
   * to ensure the record is durable before a downstream consumer reads it.
   */
  static flushChatSave(chatId: string): boolean {
    if (!legacyStoreCanWrite()) return false
    return saveCoalescer.flush(chatId)
  }

  /**
   * Immediate CAS-conflict recovery used by the production Host save lane.
   *
   * The Host owns `chats/<id>.json`, so whatever that file says is always a
   * revision this compare-and-swap can actually satisfy. Recovery therefore
   * never gives up: `saveChatThroughHost` derives its baseline from the
   * optimistic in-memory shadow, and that shadow only ever advances (+1 per
   * save) — this function is the ONLY thing that re-anchors it to the Host.
   * Every early return here strands the chat permanently, because the next
   * save asks for an even higher revision the Host will never hold.
   *
   * 2026-08-29 evidence from `host-runtime/command-receipts`: 496 of 731
   * `thread.record.persist` commands failed `thread_record_revision_conflict`,
   * with one ensemble thread pinned at revision 13 across 222 consecutive
   * attempts — its rebase intent had been dropped by an earlier settled
   * barrier, so recovery returned null and the shadow was never re-anchored.
   */
  static recoverHostPersistConflict(
    input: HostThreadRecordPersistInput,
    error: HostThreadRecordPersistError
  ): HostThreadRecordPersistInput | null {
    if (error.code !== 'revision_conflict') return null
    const chatId = input.chatId
    const intent = hostPersistRebaseByChatId.get(chatId)
    // The accumulated Desktop intent, or — when an earlier settled barrier
    // dropped it — the record this attempt was already carrying.
    const desired = intent?.desired ?? input.record
    const stored = readJsonStrictIfPresent(chatPathForId(chatsDir, chatId))
    // No Host record at all: `Thread is not found` is reported as a revision
    // conflict, so a CAS against any non-zero revision can never land. Re-issue
    // it as the create it actually is instead of wedging the chat forever.
    if (stored === null) {
      const created: ChatRecord = { ...desired, persistenceRevision: 0 }
      return this.adoptHostPersistRecovery(chatId, created, created, 0)
    }

    const source = chatComposerSelectionOverlayStore.apply(
      this.normalizeChatRecord(stored as ChatRecord)
    )
    const sourceRevision = chatPersistenceRevision(source)
    // A base ahead of the Host record is a stale optimistic shadow, not a real
    // ancestor, and rebasing onto it throws. Fall back to the Host record as
    // the ancestor: everything the Desktop holds is then a local change, which
    // is exactly the truth once its own writes never landed.
    const base =
      intent && chatPersistenceRevision(intent.base) <= sourceRevision ? intent.base : source
    // rebaseChatRecordUpdate requires desired to sit strictly above base.
    const rebaseTarget: ChatRecord =
      chatPersistenceRevision(desired) > chatPersistenceRevision(base)
        ? desired
        : { ...desired, persistenceRevision: chatPersistenceRevision(base) + 1 }

    let rebased: ChatRecord
    try {
      rebased = rebaseChatRecordUpdate(base, rebaseTarget, source)
    } catch {
      // Last resort: force the Desktop record onto the Host's revision. A
      // three-way merge that cannot be computed is not a reason to refuse to
      // write — the alternative is a thread that is never persisted again.
      rebased = { ...rebaseTarget, persistenceRevision: sourceRevision + 1 }
    }
    return this.adoptHostPersistRecovery(chatId, source, rebased, sourceRevision)
  }

  /** Re-anchors the shadow onto a recovered record and returns the retry. */
  private static adoptHostPersistRecovery(
    chatId: string,
    base: ChatRecord,
    rebased: ChatRecord,
    expectedRevision: number
  ): HostThreadRecordPersistInput {
    hostPersistRebaseByChatId.set(chatId, { base, desired: rebased })
    this.chatRecordCache.set(chatId, { mtimeMs: -1, size: -1, record: rebased })
    hostPersistShadowChatIds.add(chatId)
    hostPersistUnconfirmedChatIds.add(chatId)
    try {
      hostPersistConflictRecoveryListener?.(rebased)
    } catch {
      // Persistence recovery is authoritative; renderer reseeding is additive.
    }
    return { chatId, record: rebased, expectedRevision }
  }

  /**
   * Re-anchors a projection the Host never accepted. The record the user is
   * looking at is kept — dropping it would roll the transcript back to a stale
   * durable copy — but its revision is reset to the Host's, so the NEXT save
   * asks for a revision the Host can satisfy. Leaving the shadow ahead is what
   * turns a single conflict into a permanent one.
   */
  private static releaseHostPersistShadow(chatId: string): void {
    hostPersistRebaseByChatId.delete(chatId)
    const cached = this.chatRecordCache.get(chatId)
    if (!cached || cached.mtimeMs !== -1) return
    let hostRevision = 0
    try {
      hostRevision = chatPersistenceRevision(
        readJsonStrictIfPresent(chatPathForId(chatsDir, chatId)) as ChatRecord | null
      )
    } catch {
      // An unreadable record leaves the create-case revision, which the next
      // save's conflict recovery corrects against the real file.
    }
    cached.record = { ...cached.record, persistenceRevision: hostRevision }
  }

  /**
   * Durability barrier for the Host-routed persistence path: resolves once the
   * chat's queued `thread.record.persist` work has landed. Revision conflicts
   * are rebased onto the latest Host record and retried within a strict bound,
   * and an unresolved one re-anchors the record and RESOLVES: the Host copy is
   * intact, so a compare-and-swap bookkeeping fault must never be the reason an
   * ensemble round refuses to start. Every other typed failure is rethrown.
   * Awaited before ensemble participant dispatch and on ensemble-chat creation
   * so a genuine persistence failure surfaces at the exact site where the user
   * meets it. Concurrent awaiters share one in-flight drain and all observe its
   * outcome.
   */
  static awaitChatRecordPersisted(chatId: string): Promise<void> {
    const existing = chatRecordConflictRecoveryBarriers.get(chatId)
    if (existing) return existing
    const recovery = this.awaitChatRecordPersistedWithRecovery(chatId).finally(() => {
      if (chatRecordConflictRecoveryBarriers.get(chatId) === recovery) {
        chatRecordConflictRecoveryBarriers.delete(chatId)
      }
    })
    chatRecordConflictRecoveryBarriers.set(chatId, recovery)
    return recovery
  }

  private static async awaitChatRecordPersistedWithRecovery(chatId: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await barrierChatRecordPersist(chatId)
        if (hostThreadRecordPersist().pending(chatId) === 0) {
          hostPersistRebaseByChatId.delete(chatId)
        }
        return
      } catch (error) {
        if (
          !(error instanceof HostThreadRecordPersistError) ||
          error.code !== 'revision_conflict'
        ) {
          throw error
        }
        const intent = hostPersistRebaseByChatId.get(chatId)
        const pending = intent?.desired ?? this.chatRecordCache.get(chatId)?.record ?? null
        if (attempt >= HOST_PERSIST_REVISION_CONFLICT_RETRY_LIMIT || !pending) {
          // A revision conflict is a persistence-bookkeeping fault, never a
          // reason to refuse to start a round: the Host's own record is intact
          // and the next save rebases onto it. Re-anchor the shadow so the
          // conflict cannot repeat forever, report it, and let the caller run.
          this.releaseHostPersistShadow(chatId)
          console.error(
            `[host-persist] unresolved revision conflict for chat ${chatId} after ` +
              `${attempt} rebase attempt(s); re-anchored the record and continued.`
          )
          return
        }
        const recovered = this.recoverHostPersistConflict(
          {
            chatId,
            record: pending,
            expectedRevision: chatPersistenceRevision(intent?.base ?? pending)
          },
          error
        )
        if (!recovered) throw error
        hostThreadRecordPersist().enqueue(recovered)
      }
    }
  }

  static setHostPersistConflictRecoveryListener(
    listener: ((chat: ChatRecord) => void) | null
  ): void {
    hostPersistConflictRecoveryListener = listener
  }

  /** Test seam: swap the Host persist port and drop any memoized barriers. */
  static setHostThreadRecordPersistPortForTests(port: HostThreadRecordPersistPort | null): void {
    hostThreadRecordPersistPort = port
    chatRecordPersistBarriers.clear()
    chatRecordConflictRecoveryBarriers.clear()
    hostPersistRebaseByChatId.clear()
    hostPersistConflictRecoveryListener = null
  }

  /**
   * T3a-1: Flush ALL pending chat persistence at shutdown (will-quit).
   * Legacy-gate-open: synchronously flush the coalescer as before. Host-owned
   * gate: the legacy coalescer is empty by construction, but the Host persist
   * queue may still hold queued records — drain it, bounded so a hung Host
   * cannot hold the process open. A drain failure or timeout is reported
   * loudly (with the still-unconfirmed chat count) and quit proceeds; at
   * shutdown nothing else can be done, and the loss must never be silent.
   */
  static async flushAllChatSaves(options?: { hostDrainTimeoutMs?: number }): Promise<void> {
    if (legacyStoreCanWrite()) {
      saveCoalescer.flushAll()
      incrementalChatPersistence.checkpointAll()
      return
    }
    await drainHostRecordPersistQueueOnShutdown(options?.hostDrainTimeoutMs)
  }

  static getIncrementalChatPersistenceStats(): IncrementalChatPersistenceStats {
    return incrementalChatPersistence.stats()
  }

  /**
   * T4b reporting seam. The perf harness samples this through the main
   * inspector so `saveChat`-class metrics on the comparison report are
   * genuinely MEASURED rather than declared.
   *
   * Why this has to exist: the T2 baseline had to report
   * `metricsCollected: false` because the production probes did not exist,
   * and the runner contract forbids inventing values. These counters are the
   * honest source for the write-amplification claim — `coalesced` is the
   * reduction, `reasonMix` is why, `ceilingFlushes` shows the ceiling doing
   * its job, and the journal counters keep dual-write bytes separable from
   * legacy bytes. Read-only: sampling must never perturb what it measures.
   */
  static getPersistenceCoalescingStats(): {
    coalescer: SaveCoalescerStats
    journal: ChatJournalStats
    config: { coalesceMs: number; maxLatencyMs: number | null }
  } {
    return {
      coalescer: saveCoalescer.stats(),
      journal: chatJournal.stats(),
      config: {
        coalesceMs: saveCoalesceMs,
        maxLatencyMs: saveCoalesceMaxMs ?? null
      }
    }
  }

  private static historyDeletionRunning = false

  /**
   * Durable admission fence for every store-owned producer that can recreate
   * chat/run history while a prepared deletion is waiting on external joins.
   * The journal, rather than an in-memory latch, is authoritative across
   * restart. Deletion internals are the sole bypass and run only while
   * `historyDeletionRunning` owns the synchronous commit section.
   */
  static assertHistoryMutationAllowed(input: HistoryMutationAdmissionInput): void {
    if (this.historyDeletionRunning) return
    const intent = readHistoryDeletionIntent()
    if (!intent) return
    assertHistoryMutationAdmission(input, intent)
  }

  private static async assertHistoryMutationAllowedAsync(
    input: HistoryMutationAdmissionInput
  ): Promise<void> {
    if (this.historyDeletionRunning) return
    const intent = await readHistoryDeletionIntentAsync()
    if (!intent) return
    assertHistoryMutationAdmission(input, intent)
  }

  private static allReadableChatsForDeletion(): ChatRecord[] {
    if (!fs.existsSync(chatsDir)) return []
    const chats: ChatRecord[] = []
    for (const file of fs.readdirSync(chatsDir).filter((item) => item.endsWith('.json'))) {
      const chatId = path.basename(file, '.json')
      if (!isSafeChatId(chatId)) continue
      const chat = this.readChatRecordCached(chatId, path.join(chatsDir, file))
      if (chat) chats.push(chat)
    }
    return chats
  }

  private static createHistoryDeletionIntent(
    input: HistoryDeletionPrepareInput
  ): HistoryDeletionIntent {
    const now = new Date().toISOString()
    const scheduledMutation = readScheduledOccurrenceMutationJournal()
    if (scheduledMutation.status !== 'none') {
      throw new Error(
        scheduledMutation.status === 'blocked'
          ? scheduledMutation.reason
          : 'Scheduled occurrence mutation recovery must finish before history deletion can prepare.'
      )
    }
    if (input.kind === 'workspace' && fs.existsSync(chatsDir)) {
      // Workspace ownership is stored inside each chat record. If any record is
      // unreadable we cannot prove whether deleting or retaining it is correct,
      // so stop before writing an intent or touching sibling history.
      for (const file of fs.readdirSync(chatsDir).filter((item) => item.endsWith('.json'))) {
        const stored = readJsonStrictIfPresent(path.join(chatsDir, file))
        if (!objectRecord(stored)) {
          throw new Error(`Chat record ${file} is invalid; workspace deletion cannot prove scope.`)
        }
      }
    }
    const allChats = this.allReadableChatsForDeletion()
    const chatIds = new Set<string>()
    if (input.kind === 'global') {
      for (const chat of allChats) chatIds.add(chat.appChatId)
      if (fs.existsSync(chatsDir)) {
        for (const file of fs.readdirSync(chatsDir).filter((item) => item.endsWith('.json'))) {
          const id = path.basename(file, '.json')
          if (isSafeChatId(id)) chatIds.add(id)
        }
      }
      // With no chats left every project membership is stale, including ids
      // whose chat file disappeared before this transaction began.
      for (const project of this.getProjects()) {
        for (const id of project.memberChatIds) {
          if (isSafeChatId(id)) chatIds.add(id)
        }
      }
    } else if (input.kind === 'workspace') {
      for (const chat of allChats) {
        if (chat.workspaceId === input.workspaceId) chatIds.add(chat.appChatId)
      }
      const index = chatListIndexStore.readAll()
      for (const [chatId, itemValue] of Object.entries(index || {})) {
        const item = objectRecord(itemValue)
        if (item?.workspaceId === input.workspaceId && isSafeChatId(chatId)) chatIds.add(chatId)
      }
    } else if (input.rootChatId) {
      chatIds.add(input.rootChatId)
    }
    for (const target of input.quiescenceTargets || []) {
      if (target.chatId && isSafeChatId(target.chatId)) chatIds.add(target.chatId)
    }

    // Delete/clear owns descendants. Truncate keeps linked children intact.
    if (input.kind !== 'truncate') {
      let changed = true
      while (changed) {
        changed = false
        for (const chat of allChats) {
          if (chat.parentChatId && chatIds.has(chat.parentChatId) && !chatIds.has(chat.appChatId)) {
            chatIds.add(chat.appChatId)
            changed = true
          }
        }
      }
    }

    // Freeze the privacy target while every legacy provenance source is still
    // present. Commit and crash recovery delete these exact files even if a
    // later append leaves one ledger corrupt or an earlier step removes chats.
    const missionFactIds =
      input.kind === 'global'
        ? []
        : missionFactRepository.resolvePurgeMissionIds({
            chatIds: [...chatIds],
            ...(input.workspaceId ? { workspaceIds: [input.workspaceId] } : {})
          })

    const runIds = new Set<string>()
    const kimiSeats: Array<{ chatId: string; participantId: string }> = []
    for (const chat of allChats) {
      if (!chatIds.has(chat.appChatId)) continue
      const historicalSeatIds = new Set<string>()
      for (const run of chat.runs || []) {
        if (run?.runId) runIds.add(run.runId)
        if (run?.ensembleParticipantId) historicalSeatIds.add(run.ensembleParticipantId)
      }
      for (const wakeup of Object.values(chat.soloWakeups || {})) {
        if (wakeup.runId) runIds.add(wakeup.runId)
      }
      for (const participant of chat.ensemble?.activeRound?.participants || []) {
        if (participant.runId) runIds.add(participant.runId)
      }
      for (const lane of Object.values(chat.ensemble?.activeRound?.lanes || {})) {
        if (lane.runId) runIds.add(lane.runId)
      }
      for (const wakeup of Object.values(chat.ensemble?.wakeups || {})) {
        if (wakeup.runId) runIds.add(wakeup.runId)
      }
      for (const event of chat.delegationContext?.workerControl?.events || []) {
        runIds.add(event.plannedRunId)
        if (event.dispatchRunId) runIds.add(event.dispatchRunId)
        if (event.parentRunId) runIds.add(event.parentRunId)
      }
      const seatIds = new Set([
        'solo',
        ...(chat.ensemble?.participants || []).map((participant) => participant.id),
        ...historicalSeatIds
      ])
      for (const participantId of seatIds) kimiSeats.push({ chatId: chat.appChatId, participantId })
    }
    for (const target of input.quiescenceTargets || []) {
      if (target.runId) runIds.add(target.runId)
    }

    const draft: HistoryDeletionIntent = {
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: input.kind,
      createdAt: now,
      updatedAt: now,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.rootChatId ? { rootChatId: input.rootChatId } : {}),
      chatIds: [...chatIds].sort(),
      runIds: [],
      missionFactIds,
      scheduledTaskIds: [],
      retainedScheduledTaskIds: [],
      workflowIds: [],
      workflowExecutionIds: [],
      kimiSeats,
      quiescenceTargets: [...(input.quiescenceTargets || [])],
      completedQuiescenceTargetIds: [],
      completedSteps: [],
      failures: []
    }

    // A schedule can recreate a cleared transcript without any row in the
    // ordinary run queue yet. Freeze exact task/workflow/execution ownership in
    // the durable intent, including pruned execution history that survives only
    // in the per-execution workflow ledger.
    const scheduledTasks = readScheduledTasksForHistoryDeletionStrict()
    const workflows = readWorkflowsForHistoryDeletionStrict()
    const targetScheduledTaskIds = new Set<string>()
    const targetWorkflowIds = new Set<string>()
    const targetWorkflowExecutionIds = new Set<string>()
    const taskMatchesScope = (task: ScheduledTask): boolean =>
      input.kind === 'global' ||
      (input.kind === 'workspace'
        ? task.workspaceId === input.workspaceId
        : chatIds.has(task.chatId))
    const workflowMatchesScope = (workflow: WorkflowDefinition): boolean =>
      input.kind === 'global' ||
      (input.kind === 'workspace'
        ? workflow.workspaceId === input.workspaceId ||
          workflow.template.workspaceId === input.workspaceId
        : chatIds.has(workflow.template.chatId))

    for (const task of scheduledTasks) {
      if (taskMatchesScope(task)) targetScheduledTaskIds.add(task.id)
    }
    for (const workflow of workflows) {
      if (workflowMatchesScope(workflow)) targetWorkflowIds.add(workflow.id)
    }

    const workflowLedgers: Array<{ events: WorkflowRunEvent[] }> = []
    if (fs.existsSync(workflowRunsDir)) {
      for (const entry of fs.readdirSync(workflowRunsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const ledger = readWorkflowRunLedgerStrict(path.join(workflowRunsDir, entry.name))
        if (ledger.hasTornTail || ledger.events.length === 0) {
          throw new Error(
            `Workflow run ledger ${entry.name} is incomplete; history deletion cannot prove scope.`
          )
        }
        workflowLedgers.push({ events: ledger.events })
      }
    }

    let scheduleScopeChanged = true
    while (scheduleScopeChanged) {
      scheduleScopeChanged = false
      for (const task of scheduledTasks) {
        if (
          targetScheduledTaskIds.has(task.id) &&
          task.workflowId &&
          !targetWorkflowIds.has(task.workflowId)
        ) {
          targetWorkflowIds.add(task.workflowId)
          scheduleScopeChanged = true
        }
        if (
          task.workflowId &&
          targetWorkflowIds.has(task.workflowId) &&
          !targetScheduledTaskIds.has(task.id)
        ) {
          targetScheduledTaskIds.add(task.id)
          scheduleScopeChanged = true
        }
      }
      for (const workflow of workflows) {
        if (!targetWorkflowIds.has(workflow.id)) continue
        for (const execution of workflow.history) {
          if (execution.scheduledTaskId && !targetScheduledTaskIds.has(execution.scheduledTaskId)) {
            targetScheduledTaskIds.add(execution.scheduledTaskId)
            scheduleScopeChanged = true
          }
        }
      }
      for (const ledger of workflowLedgers) {
        const first = ledger.events[0]
        const ledgerTaskIds = new Set(
          ledger.events
            .map((event) => event.scheduledTaskId)
            .filter((value): value is string => Boolean(value))
        )
        if (
          input.kind !== 'global' &&
          !targetWorkflowIds.has(first.workflowId) &&
          ![...ledgerTaskIds].some((taskId) => targetScheduledTaskIds.has(taskId)) &&
          !ledger.events.some((event) => Boolean(event.runId && runIds.has(event.runId)))
        ) {
          continue
        }
        if (!targetWorkflowIds.has(first.workflowId)) {
          targetWorkflowIds.add(first.workflowId)
          scheduleScopeChanged = true
        }
        for (const taskId of ledgerTaskIds) {
          if (!targetScheduledTaskIds.has(taskId)) {
            targetScheduledTaskIds.add(taskId)
            scheduleScopeChanged = true
          }
        }
      }
    }

    for (const task of scheduledTasks) {
      if (!targetScheduledTaskIds.has(task.id)) continue
      if (task.runId) runIds.add(task.runId)
      if (task.workflowExecutionId) targetWorkflowExecutionIds.add(task.workflowExecutionId)
    }
    for (const workflow of workflows) {
      if (!targetWorkflowIds.has(workflow.id)) continue
      for (const execution of workflow.history) {
        targetWorkflowExecutionIds.add(execution.id)
        if (execution.runId) runIds.add(execution.runId)
      }
    }
    for (const ledger of workflowLedgers) {
      const first = ledger.events[0]
      if (
        input.kind !== 'global' &&
        !targetWorkflowIds.has(first.workflowId) &&
        !ledger.events.some(
          (event) =>
            (event.scheduledTaskId && targetScheduledTaskIds.has(event.scheduledTaskId)) ||
            (event.runId && runIds.has(event.runId))
        )
      ) {
        continue
      }
      targetWorkflowExecutionIds.add(first.workflowExecutionId)
      for (const event of ledger.events) {
        if (event.runId) runIds.add(event.runId)
      }
    }
    draft.scheduledTaskIds = [...targetScheduledTaskIds].sort()
    draft.retainedScheduledTaskIds = scheduledTasks
      .filter(
        (task) =>
          targetScheduledTaskIds.has(task.id) &&
          !task.workflowId &&
          !isTerminalScheduledTaskStatus(task.status)
      )
      .map((task) => task.id)
      .sort()
    draft.workflowIds = [...targetWorkflowIds].sort()
    draft.workflowExecutionIds = [...targetWorkflowExecutionIds].sort()

    // Snapshot queued/recovery/approval run ids before any store is rewritten.
    for (const [filePath, label] of [
      [runQueuePath, 'run queue'],
      [runRecoveryPath, 'run recovery'],
      [approvalLedgerPath, 'approval ledger']
    ] as const) {
      const stored = readJsonStrictIfPresent(filePath)
      if (stored === null) continue
      if (!Array.isArray(stored)) {
        if (input.kind === 'global') continue
        throw new Error(
          `${label} is not an array; scoped history deletion cannot preserve siblings.`
        )
      }
      for (const record of stored) {
        if (!historyRecordMatches(record, draft, { includeRunIds: false })) continue
        const runId = objectRecord(record)?.runId
        if (typeof runId === 'string' && runId) runIds.add(runId)
      }
    }

    const mailboxValue = readJsonStrictIfPresent(subThreadMailboxesPath)
    const mailboxLedger = objectRecord(mailboxValue)
    const mailboxes = objectRecord(mailboxLedger?.mailboxes)
    if (mailboxValue !== null && (!mailboxLedger || !mailboxes) && input.kind !== 'global') {
      throw new Error(
        'Sub-thread mailbox ledger is invalid; scoped deletion cannot preserve siblings.'
      )
    }
    for (const [parentChatId, mailboxValueForParent] of Object.entries(mailboxes || {})) {
      const mailbox = objectRecord(mailboxValueForParent)
      for (const eventValue of Array.isArray(mailbox?.events) ? mailbox.events : []) {
        const event = objectRecord(eventValue)
        const source = objectRecord(event?.source)
        const matches =
          chatIds.has(parentChatId) ||
          (typeof source?.subThreadId === 'string' && chatIds.has(source.subThreadId))
        if (!matches) continue
        if (typeof source?.sourceRunId === 'string') runIds.add(source.sourceRunId)
      }
    }

    if (input.kind === 'global') {
      try {
        if (fs.existsSync(runEventsDir)) {
          for (const file of fs
            .readdirSync(runEventsDir)
            .filter((item) => item.endsWith('.jsonl'))) {
            runIds.add(path.basename(file, '.jsonl'))
          }
        }
        if (fs.existsSync(runArtifactsDir)) {
          for (const entry of fs.readdirSync(runArtifactsDir, { withFileTypes: true })) {
            if (entry.isDirectory()) runIds.add(entry.name)
          }
        }
      } catch {
        // The strict directory-removal steps remain authoritative for global clear.
      }
    } else if (fs.existsSync(runEventsDir)) {
      // A run can reach the event ledger before it is attached to ChatRecord.
      // Inspect retained event identities so a scoped clear also catches that row.
      //
      // Both bounds below only skip files that provably cannot match, so the
      // set of runIds found here is identical to parsing every line — see
      // historyDeletionIdentityNeedles and historyDeletionRunEventMtimeFloorMs.
      const sweepKey = historyDeletionLedgerSweepKey(draft)
      const memoised = readHistoryDeletionLedgerSweep(sweepKey)
      if (memoised) {
        for (const runId of memoised) runIds.add(runId)
      } else {
        const sweptRunIds = new Set<string>()
        const identityNeedles = historyDeletionIdentityNeedles(draft)
        const mtimeFloorMs = historyDeletionRunEventMtimeFloorMs(allChats, chatIds)
        for (const file of fs.readdirSync(runEventsDir).filter((item) => item.endsWith('.jsonl'))) {
          const filePath = path.join(runEventsDir, file)
          if (mtimeFloorMs !== null) {
            try {
              if (fs.statSync(filePath).mtimeMs < mtimeFloorMs) continue
            } catch {
              // An unreadable stat must not shrink the sweep; fall through.
            }
          }
          if (identityNeedles && !runEventFileContainsIdentity(filePath, identityNeedles)) continue
          let lines: string[]
          try {
            lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/).filter(Boolean)
          } catch {
            continue
          }
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as unknown
              if (!historyRecordMatches(event, draft, { includeRunIds: false })) continue
              const runId = objectRecord(event)?.runId
              if (typeof runId === 'string' && runId) sweptRunIds.add(runId)
            } catch {
              // Another valid row in the same append-only ledger may still identify ownership.
            }
          }
        }
        historyDeletionLedgerSweepMemo = {
          key: sweepKey,
          runIds: [...sweptRunIds],
          atMs: Date.now()
        }
        for (const runId of sweptRunIds) runIds.add(runId)
      }
    }

    draft.runIds = [...runIds].sort()
    return normalizeHistoryDeletionIntent(draft)
  }

  /**
   * The truncate scrub, shared by the legacy write path and the Host-routed
   * path: history and session/orchestration state are stripped while the
   * roster and other durable non-history fields are retained. The record is
   * stamped with the next persistence revision — which the Host's
   * persistThreadRecord assigns identically (current+1), so both paths agree.
   */
  private static buildTruncatedChatRecordForErasure(
    chat: ChatRecord,
    intent: HistoryDeletionIntent
  ): ChatRecord {
    const {
      taskWraithMcpProfileReceipt: _dropReceipt,
      seatGeneration: _dropSeatGeneration,
      contextCompactionSummary: _dropContextCompaction,
      linkedGeminiSessionId: _dropGeminiSession,
      linkedProviderSessionId: _dropProviderSession,
      activeGoal: _dropGoal,
      chatTodos: _dropTodos,
      soloWakeups: _dropSoloWakeups,
      ollamaSessionMemory: _dropOllamaMemory,
      ollamaSessionMemories: _dropOllamaMemories,
      delegationContext: _dropDelegationContext,
      ...retainedChat
    } = chat
    const ensemble = chat.ensemble
      ? (() => {
          const {
            activeRound: _dropActiveRound,
            workSession: _dropWorkSession,
            sessionActivityLedger: _dropActivity,
            bossmanControlState: _dropBossControl,
            lastRoundSummary: _dropLastSummary,
            roundSummaries: _dropRoundSummaries,
            wakeups: _dropWakeups,
            blackboard: _dropBlackboard,
            escalationSignals: _dropEscalations,
            ...retainedEnsemble
          } = chat.ensemble!
          return {
            ...retainedEnsemble,
            participants: retainedEnsemble.participants.map((participant) => {
              const {
                taskWraithMcpProfileReceipt: _dropParticipantReceipt,
                seatGeneration: _dropParticipantGeneration,
                contextCompactionSummary: _dropParticipantSummary,
                promptShellVersion: _dropShell,
                promptDynamicStateVersion: _dropDynamic,
                tokenTotals: _dropTotals,
                kimiAcpNativeSession: _dropNativeMarker,
                kimiAcpPostureVersion: _dropPosture,
                ...retainedParticipant
              } = participant
              return { ...retainedParticipant, linkedProviderSessionId: null }
            }),
            updatedAt: intent.createdAt
          }
        })()
      : undefined
    return compactChatForPersist(
      this.normalizeChatRecord({
        ...retainedChat,
        ...(ensemble ? { ensemble } : {}),
        messages: [],
        runs: [],
        updatedAt: Date.parse(intent.createdAt),
        persistenceRevision: chatPersistenceRevision(chat) + 1
      })
    )
  }

  /**
   * The chat-records step when the Host owns chats/<id>.json. Only the record
   * removal/rewrite travels through the Host — delete via thread.record.delete
   * (which supersedes any queued persist for the chat, so a queued save cannot
   * resurrect a deleted chat), truncate via thread.record.persist with main's
   * already-scrubbed complete record. Sequenced per chat: erasure is rare and
   * each Host round trip must settle before the verification sweep reruns.
   */
  /**
   * Journal retirement when the Host owns the gate. The V2 and legacy journal
   * subsystems are read-only in this mode, but their pre-cutover artifacts are
   * desktop-owned legacy bytes that must not survive an erasure
   * (NON-NEGOTIABLE #4), so they are removed directly.
   */
  private static purgeChatJournalArtifactsHostOwned(chatId: string): void {
    chatUpdateProjectionTracker.drop(chatId)
    const legacyJournalDir = path.join(userDataPath, 'chat-journal')
    for (const suffix of ['.tombstone', '.jsonl', '.snapshot.json']) {
      fs.rmSync(path.join(legacyJournalDir, `${chatId}${suffix}`), { force: true })
    }
    const v2JournalDir = path.join(userDataPath, 'chat-journal-v2')
    for (const suffix of ['.checkpoint.json', '.mutations.jsonl', '.tombstone']) {
      fs.rmSync(path.join(v2JournalDir, `${chatId}${suffix}`), { force: true })
    }
  }

  private static async executeHostChatRecordErasure(
    intent: HistoryDeletionIntent
  ): Promise<void> {
    if (intent.kind === 'truncate') {
      const chatId = intent.rootChatId!
      const chatPath = chatPathForId(chatsDir, chatId)
      // Drain the per-chat queue before rewriting: a still-queued persist
      // would otherwise land AFTER the truncated record and resurrect the old
      // content. The drain also anchors the on-disk revision this persist
      // builds on.
      await hostThreadRecordPersist().drain(chatId)
      const stored = readJsonStrictIfPresent(chatPath)
      if (stored === null) return
      const chat = chatComposerSelectionOverlayStore.apply(
        this.normalizeChatRecord(stored as ChatRecord)
      )
      const truncated = this.buildTruncatedChatRecordForErasure(chat, intent)
      // The chat's journal/V2 artifacts are pure history once truncated —
      // retire them before the rewrite, mirroring the legacy step's ordering.
      this.purgeChatJournalArtifactsHostOwned(chatId)
      if (chatContainsTruncatableHistory(chat)) {
        await hostThreadRecordPersist().persist({
          chatId,
          record: truncated,
          expectedRevision: chatPersistenceRevision(chat)
        })
      }
      chatComposerSelectionOverlayStore.delete(chatId)
      this.chatRecordCache.delete(chatId)
      hostPersistShadowChatIds.delete(chatId)
      hostPersistRebaseByChatId.delete(chatId)
      const verified = readJsonStrictIfPresent(chatPath) as ChatRecord | null
      if (verified && chatContainsTruncatableHistory(this.normalizeChatRecord(verified))) {
        throw new Error(
          'Truncated chat still contains a durable history or orchestration source.'
        )
      }
      return
    }
    if (intent.kind === 'global') {
      // Same desktop-side retirement order as the legacy step, minus the
      // chatsDir removal: that directory is the Host's store root, so records
      // go one delete at a time and the directory stays for the Host. The
      // journal directories are desktop-owned legacy artifacts (the Host has
      // its own store), so their removal stays here — erased transcript must
      // not outlive a global clear in any durable copy.
      saveCoalescer.discardAll()
      chatUpdateProjectionTracker.clear()
      chatComposerSelectionOverlayStore.clearCache()
      removePathStrict(path.join(userDataPath, 'chat-journal'), 'chat journal directory')
      removePathStrict(path.join(userDataPath, 'chat-journal-v2'), 'chat journal v2 directory')
    } else {
      // Discard, never flush, and tombstone the journal before the unlink —
      // same ordering guarantees as the legacy step.
      for (const chatId of intent.chatIds) saveCoalescer.discard(chatId)
      for (const chatId of intent.chatIds) this.purgeChatJournalArtifactsHostOwned(chatId)
    }
    for (const chatId of intent.chatIds) {
      const stored = readJsonStrictIfPresent(chatPathForId(chatsDir, chatId))
      // Already absent (idempotent recovery re-run): nothing to delete.
      if (stored !== null) {
        const expectedRevision = chatPersistenceRevision((stored as ChatRecord | null) ?? null)
        await hostThreadRecordErasure().deleteRecord({ chatId, expectedRevision })
      }
      chatComposerSelectionOverlayStore.delete(chatId)
      this.chatRecordCache.delete(chatId)
      hostPersistShadowChatIds.delete(chatId)
      hostPersistRebaseByChatId.delete(chatId)
      hostPersistUnconfirmedChatIds.delete(chatId)
    }
  }

  private static executeHistoryDeletionStep(
    intent: HistoryDeletionIntent,
    step: HistoryDeletionStep
  ): void | Promise<void> {
    if (historyDeletionFailureStepsForTests.has(step)) {
      throw new Error(`Injected history deletion failure at ${step}.`)
    }
    if (step === 'scheduled-orchestration') {
      const occurrenceMutation = readScheduledOccurrenceMutationJournal()
      if (occurrenceMutation.status !== 'none') {
        throw new Error(
          occurrenceMutation.status === 'blocked'
            ? occurrenceMutation.reason
            : 'Scheduled occurrence mutation recovery is pending during history deletion.'
        )
      }
      const targetTaskIds = new Set(intent.scheduledTaskIds)
      const retainedTaskIds = new Set(intent.retainedScheduledTaskIds)
      const targetWorkflowIds = new Set(intent.workflowIds)
      const tasks = readScheduledTasksForHistoryDeletionStrict()
      const rewrittenTasks = tasks.flatMap((task): ScheduledTask[] => {
        if (!targetTaskIds.has(task.id)) return [task]
        // Freeze the retention decision at prepare time. A task that was
        // already terminal is occurrence history, while a nonterminal
        // standalone task still carries a reusable user-authored prompt. A
        // materialized workflow task is occurrence payload; the disabled
        // WorkflowDefinition below retains its reusable template instead.
        if (!retainedTaskIds.has(task.id)) return []
        const {
          runId: _dropRunId,
          handoffSourceRunId: _dropHandoffRunId,
          permissionPosture: _dropPermissionPosture,
          dispatchReceipt: _dropDispatchReceipt,
          occurrenceSeal: _dropOccurrenceSeal,
          firedAt: _dropFiredAt,
          runningSince: _dropRunningSince,
          workflowExecutionId: _dropWorkflowExecutionId,
          workflowOccurrenceAt: _dropWorkflowOccurrenceAt,
          ...configuration
        } = task
        return [
          {
            ...configuration,
            status: 'cancelled',
            completedAt: intent.createdAt,
            lastError: 'history_cleared',
            updatedAt: intent.createdAt
          }
        ]
      })
      if (!sameJsonValue(tasks, rewrittenTasks)) writeJson(scheduledTasksPath, rewrittenTasks)

      const workflows = readWorkflowsForHistoryDeletionStrict()
      const rewrittenWorkflows = workflows.map((workflow): WorkflowDefinition => {
        if (!targetWorkflowIds.has(workflow.id)) return workflow
        const {
          unattendedElevation: _dropUnattendedElevation,
          nextRunAt: _dropNextRunAt,
          lastRunAt: _dropLastRunAt,
          lastCompletedAt: _dropLastCompletedAt,
          lastRunIterationCount: _dropIterationCount,
          lastRunStopReason: _dropStopReason,
          lastRunTokens: _dropTokens,
          activeExecutionId: _dropActiveExecution,
          ...configuration
        } = workflow
        const { handoffSourceRunId: _dropTemplateHandoffRunId, ...template } =
          configuration.template
        return {
          ...configuration,
          enabled: false,
          template,
          nextRunAt: undefined,
          lastStatus: 'cancelled',
          lastError: 'history_cleared',
          failureStreak: 0,
          history: [],
          updatedAt: intent.createdAt
        }
      })
      if (!sameJsonValue(workflows, rewrittenWorkflows))
        writeJson(workflowsPath, rewrittenWorkflows)

      const verifiedTasks = readScheduledTasksForHistoryDeletionStrict()
      for (const task of verifiedTasks) {
        if (!targetTaskIds.has(task.id)) continue
        if (
          !retainedTaskIds.has(task.id) ||
          task.workflowId ||
          task.status !== 'cancelled' ||
          task.runId ||
          task.handoffSourceRunId ||
          task.permissionPosture ||
          task.dispatchReceipt ||
          task.occurrenceSeal ||
          task.firedAt ||
          task.runningSince ||
          task.workflowExecutionId ||
          task.workflowOccurrenceAt
        ) {
          throw new Error('Scheduled occurrence remains runnable or linked after history clear.')
        }
      }
      const verifiedWorkflows = readWorkflowsForHistoryDeletionStrict()
      for (const workflow of verifiedWorkflows) {
        if (!targetWorkflowIds.has(workflow.id)) continue
        if (
          workflow.enabled ||
          workflow.nextRunAt ||
          workflow.activeExecutionId ||
          workflow.history.length > 0 ||
          workflow.unattendedElevation ||
          workflow.template.handoffSourceRunId
        ) {
          throw new Error(
            'Workflow remains runnable or retains occurrence linkage after history clear.'
          )
        }
      }
      return
    }
    if (step === 'workflow-run-history') {
      if (intent.kind === 'global') {
        removePathStrict(workflowRunsDir, 'workflow run history directory')
      } else {
        removePathsStrict(
          intent.workflowExecutionIds.map((executionId) => ({
            targetPath: workflowRunFilePath(executionId),
            label: `workflow run history for ${safeWorkflowRunFileName(executionId)}`
          }))
        )
      }
      return
    }
    if (step === 'run-queue') {
      rewriteArrayHistoryStore(runQueuePath, 'run queue history', intent)
      return
    }
    if (step === 'run-recovery') {
      rewriteArrayHistoryStore(runRecoveryPath, 'run recovery history', intent)
      return
    }
    if (step === 'approval-ledger') {
      rewriteArrayHistoryStore(approvalLedgerPath, 'approval ledger history', intent)
      return
    }
    if (step === 'message-feedback') {
      rewriteArrayHistoryStore(
        messageFeedbackLedgerPath,
        'message feedback receipt history',
        intent
      )
      return
    }
    if (step === 'sub-thread-mailboxes') {
      if (intent.kind === 'global') {
        removePathStrict(subThreadMailboxesPath, 'sub-thread mailbox history')
        return
      }
      const value = readJsonStrictIfPresent(subThreadMailboxesPath)
      if (value === null) return
      const ledger = objectRecord(value)
      const mailboxes = objectRecord(ledger?.mailboxes)
      if (!ledger || !mailboxes) throw new Error('Sub-thread mailbox ledger is invalid.')
      const targetChatIds = new Set(intent.chatIds)
      let changed = false
      for (const [parentChatId, mailboxValue] of Object.entries(mailboxes)) {
        if (targetChatIds.has(parentChatId)) {
          delete mailboxes[parentChatId]
          changed = true
          continue
        }
        const mailbox = objectRecord(mailboxValue)
        if (!mailbox || !Array.isArray(mailbox.events)) continue
        const retained = mailbox.events.filter((eventValue) => {
          const event = objectRecord(eventValue)
          const source = objectRecord(event?.source)
          return !(
            (typeof source?.subThreadId === 'string' && targetChatIds.has(source.subThreadId)) ||
            (typeof source?.sourceRunId === 'string' && intent.runIds.includes(source.sourceRunId))
          )
        })
        if (retained.length !== mailbox.events.length) {
          mailbox.events = retained
          changed = true
        }
      }
      if (Object.keys(mailboxes).length === 0) {
        removePathStrict(subThreadMailboxesPath, 'sub-thread mailbox history')
      } else if (changed) {
        writeJson(subThreadMailboxesPath, ledger)
      }
      const verified = readJsonStrictIfPresent(subThreadMailboxesPath)
      if (verified !== null) {
        const verifiedMailboxes = objectRecord(objectRecord(verified)?.mailboxes)
        if (!verifiedMailboxes) throw new Error('Sub-thread mailbox verification failed.')
        for (const [parentChatId, mailboxValue] of Object.entries(verifiedMailboxes)) {
          if (targetChatIds.has(parentChatId)) {
            throw new Error('Sub-thread mailbox history still contains a target parent.')
          }
          const mailbox = objectRecord(mailboxValue)
          for (const eventValue of Array.isArray(mailbox?.events) ? mailbox.events : []) {
            const source = objectRecord(objectRecord(eventValue)?.source)
            if (
              (typeof source?.subThreadId === 'string' && targetChatIds.has(source.subThreadId)) ||
              (typeof source?.sourceRunId === 'string' &&
                intent.runIds.includes(source.sourceRunId))
            ) {
              throw new Error('Sub-thread mailbox history still contains a target event.')
            }
          }
        }
      }
      return
    }
    if (step === 'thread-messages') {
      if (intent.kind === 'global') {
        removePathStrict(threadMessagesPath, 'thread message history')
        return
      }
      const value = readJsonStrictIfPresent(threadMessagesPath)
      if (value === null) return
      const stored = objectRecord(value)
      if (!stored || !objectRecord(stored.inboxes)) {
        throw new Error('Thread message ledger is invalid.')
      }
      // Removes the inboxes OF the target chats and any queued message FROM them,
      // so an undelivered message cannot outlive the chat that sent it.
      const purged = purgeThreadMessageChats(normalizeThreadMessageLedger(value), intent.chatIds)
      if (Object.keys(purged.ledger.inboxes).length === 0) {
        removePathStrict(threadMessagesPath, 'thread message history')
      } else if (purged.changed) {
        writeThreadMessageLedger(purged.ledger)
      }
      const residual = residualThreadMessageChats(readThreadMessageLedger(), intent.chatIds)
      if (residual.length > 0) {
        throw new Error(`Thread message history still references ${residual.join(', ')}.`)
      }
      return
    }
    if (step === 'mission-facts') {
      missionFactRepository.purge(
        intent.kind === 'global' ? { all: true } : { missionIds: intent.missionFactIds }
      )
      return
    }
    if (step === 'run-events') {
      if (intent.kind === 'global') {
        removePathStrict(runEventsDir, 'run event history directory')
      } else {
        removePathsStrict(
          intent.runIds.map((runId) => ({
            targetPath: runEventFilePath(runId),
            label: `run event history for ${safeRunEventFileName(runId)}`
          }))
        )
      }
      return
    }
    if (step === 'run-artifacts') {
      if (intent.kind === 'global') {
        removePathStrict(runArtifactsDir, 'run artifact history directory')
      } else {
        removePathsStrict(
          intent.runIds.map((runId) => ({
            targetPath: runArtifactDirPath(runId),
            label: `run artifact history for ${safeRunEventFileName(runId)}`
          }))
        )
      }
      return
    }
    if (step === 'kimi-seat-state') {
      if (intent.kind === 'global') {
        removePathsStrict([
          { targetPath: kimiAcpSeatStateRoot(userDataPath), label: 'Kimi ACP seat history' },
          ...legacyKimiAcpSeatStateRoots(userDataPath).map((targetPath) => ({
            targetPath,
            label: 'legacy Kimi ACP seat history'
          }))
        ])
      } else {
        removePathsStrict(
          intent.kimiSeats.flatMap((seat) => [
            {
              targetPath: kimiAcpSeatStatePath(userDataPath, seat.chatId, seat.participantId),
              label: `Kimi ACP seat history for chat ${seat.chatId}`
            },
            ...legacyKimiAcpSeatStatePaths(userDataPath, seat.chatId, seat.participantId).map(
              (targetPath) => ({
                targetPath,
                label: `legacy Kimi ACP seat history for chat ${seat.chatId}`
              })
            )
          ])
        )
      }
      return
    }
    if (step === 'chat-records') {
      if (!legacyStoreCanWrite()) {
        // The Host owns chats/<id>.json: only the record removal/rewrite
        // travels (thread.record.delete / thread.record.persist); every other
        // erasure ledger above stays in main, exactly as Work1's 84a5d849f
        // modeling decided. This is the only async step — everything else in
        // the transaction completes synchronously, preserving the legacy
        // path's in-tick semantics.
        return this.executeHostChatRecordErasure(intent)
      }
      if (intent.kind === 'global') {
        // T3a-1: drop every deferred write BEFORE the directory goes. A
        // pending timer would otherwise recreate a chat file after deletion,
        // and getChats() enumerates this directory, so the deleted chat would
        // reappear in the list (NON-NEGOTIABLE #4).
        saveCoalescer.discardAll()
        incrementalChatPersistence.clear()
        chatUpdateProjectionTracker.clear()
        removePathStrict(chatsDir, 'chat history directory')
        chatComposerSelectionOverlayStore.clearCache()
        // T4a: the journal is a second durable copy of chat history. Deleting
        // the legacy files while leaving the journal intact would leave the
        // deleted transcript recoverable on disk (NON-NEGOTIABLE #4).
        removePathStrict(path.join(userDataPath, 'chat-journal'), 'chat journal directory')
      } else if (intent.kind === 'truncate') {
        const chatId = intent.rootChatId!
        const chatPath = chatPathForId(chatsDir, chatId)
        // T3a-1: truncation reads the record from DISK, so a deferred write
        // must land first. Discarding here would silently truncate a stale
        // record and drop the newest non-history fields; flushing keeps the
        // file authoritative before it is rewritten.
        saveCoalescer.flush(chatId)
        const stored = readJsonStrictIfPresent(chatPath)
        if (stored === null) return
        const chat = chatComposerSelectionOverlayStore.apply(
          this.normalizeChatRecord(stored as ChatRecord)
        )
        const truncated = this.buildTruncatedChatRecordForErasure(chat, intent)
        if (chatContainsTruncatableHistory(chat)) {
          writeJson(chatPath, truncated)
          incrementalChatPersistence.replaceAuthoritative(chatId, truncated)
        } else {
          // Idempotent recovery: a prior attempt may have committed the legacy
          // truncation and failed before replacing V2. Reassert the already-
          // truncated record so no old mutation/checkpoint survives the rerun.
          incrementalChatPersistence.replaceAuthoritative(chatId, chat)
        }
        chatComposerSelectionOverlayStore.delete(chatId)
        this.chatRecordCache.delete(chatId)
        const verified = readJsonStrictIfPresent(chatPath) as ChatRecord | null
        if (verified && chatContainsTruncatableHistory(this.normalizeChatRecord(verified))) {
          throw new Error(
            'Truncated chat still contains a durable history or orchestration source.'
          )
        }
      } else {
        // T3a-1: discard, never flush. A pending write for a chat being
        // deleted must be dropped before the file is unlinked, or the timer
        // recreates it and getChats() lists a deleted chat again.
        for (const chatId of intent.chatIds) saveCoalescer.discard(chatId)
        // Tombstone before unlinking: the journal must refuse late appends for
        // a chat whose history is being destroyed, and its own files must go
        // with the legacy record rather than outliving it.
        for (const chatId of intent.chatIds) purgeChatJournalArtifacts(chatId)
        removePathsStrict(
          intent.chatIds.map((chatId) => ({
            targetPath: chatPathForId(chatsDir, chatId),
            label: `chat record ${chatId}`
          }))
        )
        for (const chatId of intent.chatIds) chatComposerSelectionOverlayStore.delete(chatId)
        for (const chatId of intent.chatIds) this.chatRecordCache.delete(chatId)
      }
      return
    }
    if (step === 'chat-list-index') {
      if (!legacyStoreCanWrite()) {
        // The index store asserts writable and is gate-frozen in this mode.
        // It is a desktop-local accelerator: its rows self-heal from source
        // metadata, so once the Host has removed a record the stale row no
        // longer matches and is dropped on the next read.
        chatListIndexStore.clearCache()
        chatListRebuildMemo.clear()
        for (const chatId of intent.chatIds) this.chatListIndexWriteAtByChatId.delete(chatId)
        return
      }
      if (intent.kind === 'global') {
        removePathStrict(chatListIndexPath, 'chat list index')
        // Also remove per-chat summary directory.
        try {
          const summariesDir = path.join(userDataPath, 'chat-list-summaries')
          if (fs.existsSync(summariesDir)) {
            for (const file of fs.readdirSync(summariesDir)) {
              fs.unlinkSync(path.join(summariesDir, file))
            }
            fs.rmdirSync(summariesDir)
          }
        } catch {
          // Best effort — summary file removal is non-fatal.
        }
        chatListIndexStore.clearCache()
        chatListRebuildMemo.clear()
      } else {
        chatListIndexStore.removeEntries(intent.chatIds)
        // Verify removal.
        const verified = chatListIndexStore.readAll()
        if (intent.chatIds.some((chatId) => chatId in verified)) {
          throw new Error('Chat list index still contains a target chat.')
        }
      }
      for (const chatId of intent.chatIds) this.chatListIndexWriteAtByChatId.delete(chatId)
      return
    }
    if (step === 'project-membership') {
      if (intent.kind === 'truncate') return
      const failures: Error[] = []
      for (const chatId of intent.chatIds) {
        try {
          this.applyProjectOp({ kind: 'remove-chat-everywhere', chatId, now: Date.now() })
        } catch (error) {
          failures.push(
            new Error(`project membership ${chatId}: ${historyDeletionErrorMessage(error)}`)
          )
        }
      }
      const residual = this.getProjects().flatMap((project) =>
        project.memberChatIds.filter((chatId) => intent.chatIds.includes(chatId))
      )
      if (residual.length > 0)
        failures.push(new Error('Project membership still references a target chat.'))
      if (failures.length > 0)
        throw new AggregateError(failures, 'Project membership cleanup failed.')
    }
  }

  private static executeHistoryDeletion(intent: HistoryDeletionIntent): void | Promise<void> {
    const completedQuiescence = new Set(intent.completedQuiescenceTargetIds)
    const pendingQuiescence = intent.quiescenceTargets
      .map((target) => target.id)
      .filter((targetId) => !completedQuiescence.has(targetId))
    if (pendingQuiescence.length > 0) {
      throw new HistoryDeletionQuiescenceRequiredError(intent.operationId, pendingQuiescence)
    }
    for (const chatId of intent.chatIds) {
      if (intent.kind !== 'truncate') deletedChatIds.add(chatId)
    }
    for (const runId of intent.runIds) {
      deletedRunIds.add(runId)
      runEventSequenceCache.delete(runId)
      runEventHashCache.delete(runId)
    }
    if (intent.kind === 'global') {
      tombstoneRunEventFiles()
      tombstoneRunArtifactDirs()
    }

    const failures: Array<{ step: HistoryDeletionStep | 'journal'; message: string }> = []
    // Sync drive: only the Host-routed chat-records step returns a promise;
    // every legacy step completes in-tick, so the legacy transaction keeps
    // its synchronous completion semantics (and its synchronous throws).
    for (let index = 0; index < HISTORY_DELETION_STEPS.length; index += 1) {
      const step = HISTORY_DELETION_STEPS[index]
      if (intent.completedSteps.includes(step)) continue
      let settled: void | Promise<void>
      try {
        settled = this.executeHistoryDeletionStep(intent, step)
      } catch (error) {
        failures.push({ step, message: historyDeletionErrorMessage(error) })
        continue
      }
      if (settled) {
        return settled.then(
          () => {
            intent.completedSteps.push(step)
            intent.failures = []
            intent.updatedAt = new Date().toISOString()
            writeHistoryDeletionIntent(intent)
            return this.executeHistoryDeletionRemainder(intent, failures, index + 1)
          },
          (error: unknown) => {
            failures.push({ step, message: historyDeletionErrorMessage(error) })
            return this.executeHistoryDeletionRemainder(intent, failures, index + 1)
          }
        )
      }
      intent.completedSteps.push(step)
      intent.failures = []
      intent.updatedAt = new Date().toISOString()
      writeHistoryDeletionIntent(intent)
    }

    // Re-run every idempotent boundary once under the still-held lifecycle
    // authority. This is both final residual verification and a last sweep for
    // a late writer that raced an earlier store step.
    for (let index = 0; index < HISTORY_DELETION_STEPS.length; index += 1) {
      const step = HISTORY_DELETION_STEPS[index]
      let settled: void | Promise<void>
      try {
        settled = this.executeHistoryDeletionStep(intent, step)
      } catch (error) {
        if (!failures.some((failure) => failure.step === step)) {
          failures.push({ step, message: historyDeletionErrorMessage(error) })
        }
        continue
      }
      if (settled) {
        // Reached only on a recovery re-run where the first loop skipped the
        // Host-routed step via completedSteps.
        return settled.then(
          () => this.executeHistoryDeletionVerificationRemainder(intent, failures, index + 1),
          (error: unknown) => {
            if (!failures.some((failure) => failure.step === step)) {
              failures.push({ step, message: historyDeletionErrorMessage(error) })
            }
            return this.executeHistoryDeletionVerificationRemainder(intent, failures, index + 1)
          }
        )
      }
    }

    this.finishHistoryDeletion(intent, failures)
  }

  /** Async continuation once a step goes async mid-loop: finish the first
   * loop, the verification sweep, and the epilogue, in order. */
  private static async executeHistoryDeletionRemainder(
    intent: HistoryDeletionIntent,
    failures: Array<{ step: HistoryDeletionStep | 'journal'; message: string }>,
    firstLoopStart: number
  ): Promise<void> {
    for (let index = firstLoopStart; index < HISTORY_DELETION_STEPS.length; index += 1) {
      const step = HISTORY_DELETION_STEPS[index]
      if (intent.completedSteps.includes(step)) continue
      try {
        const settled = this.executeHistoryDeletionStep(intent, step)
        if (settled) await settled
        intent.completedSteps.push(step)
        intent.failures = []
        intent.updatedAt = new Date().toISOString()
        writeHistoryDeletionIntent(intent)
      } catch (error) {
        failures.push({ step, message: historyDeletionErrorMessage(error) })
      }
    }
    return this.executeHistoryDeletionVerificationRemainder(intent, failures, 0)
  }

  private static async executeHistoryDeletionVerificationRemainder(
    intent: HistoryDeletionIntent,
    failures: Array<{ step: HistoryDeletionStep | 'journal'; message: string }>,
    verificationStart: number
  ): Promise<void> {
    for (let index = verificationStart; index < HISTORY_DELETION_STEPS.length; index += 1) {
      const step = HISTORY_DELETION_STEPS[index]
      try {
        const settled = this.executeHistoryDeletionStep(intent, step)
        if (settled) await settled
      } catch (error) {
        if (!failures.some((failure) => failure.step === step)) {
          failures.push({ step, message: historyDeletionErrorMessage(error) })
        }
      }
    }
    this.finishHistoryDeletion(intent, failures)
  }

  private static finishHistoryDeletion(
    intent: HistoryDeletionIntent,
    failures: Array<{ step: HistoryDeletionStep | 'journal'; message: string }>
  ): void {
    if (failures.length > 0) {
      intent.failures = failures
      intent.updatedAt = new Date().toISOString()
      try {
        writeHistoryDeletionIntent(intent)
      } catch (error) {
        failures.push({ step: 'journal', message: historyDeletionErrorMessage(error) })
      }
      throw new HistoryDeletionIncompleteError(intent.operationId, failures)
    }

    try {
      removePathStrict(historyDeletionIntentPath, 'history deletion intent journal')
    } catch (error) {
      const journalFailure = {
        step: 'journal' as const,
        message: historyDeletionErrorMessage(error)
      }
      intent.failures = [journalFailure]
      intent.updatedAt = new Date().toISOString()
      writeHistoryDeletionIntent(intent)
      throw new HistoryDeletionIncompleteError(intent.operationId, [journalFailure])
    }

    chatListIndexStore.clearCache()
    chatListRebuildMemo.clear()
    if (intent.kind === 'global') {
      this.chatRecordCache.clear()
      this.chatListIndexWriteAtByChatId.clear()
      this.orphanSubThreadsReaped = false
      this.orphanSubThreadReapCandidates.clear()
      runEventSequenceCache.clear()
      runEventHashCache.clear()
    }
  }

  static recoverPendingHistoryDeletion(): void | Promise<void> {
    if (this.historyDeletionRunning) return
    const intent = readHistoryDeletionIntent()
    if (!intent) return
    const completed = new Set(intent.completedQuiescenceTargetIds)
    const pending = intent.quiescenceTargets
      .map((target) => target.id)
      .filter((targetId) => !completed.has(targetId))
    if (pending.length > 0) {
      throw new HistoryDeletionQuiescenceRequiredError(intent.operationId, pending)
    }
    this.historyDeletionRunning = true
    let settled: void | Promise<void>
    try {
      settled = this.executeHistoryDeletion(intent)
    } catch (error) {
      this.historyDeletionRunning = false
      throw error
    }
    if (settled) {
      return settled.finally(() => {
        this.historyDeletionRunning = false
      })
    }
    this.historyDeletionRunning = false
  }

  private static historyDeletionPreparation(
    intent: HistoryDeletionIntent
  ): HistoryDeletionPreparation {
    return {
      operationId: intent.operationId,
      kind: intent.kind,
      ...(intent.workspaceId ? { workspaceId: intent.workspaceId } : {}),
      ...(intent.rootChatId ? { rootChatId: intent.rootChatId } : {}),
      chatIds: [...intent.chatIds],
      runIds: [...intent.runIds],
      quiescenceTargets: intent.quiescenceTargets.map((target) => ({ ...target })),
      completedQuiescenceTargetIds: [...intent.completedQuiescenceTargetIds]
    }
  }

  static getPendingHistoryDeletion(): HistoryDeletionPreparation | null {
    const intent = readHistoryDeletionIntent()
    return intent ? this.historyDeletionPreparation(intent) : null
  }

  /**
   * Read-only canonical scope snapshot for main-owned external quiescence.
   * Callers must invoke prepareHistoryDeletion synchronously in the same stack;
   * the durable intent returned by prepare remains the commit authority.
   */
  static previewHistoryDeletionScope(
    input: Omit<HistoryDeletionPrepareInput, 'quiescenceTargets'>
  ): HistoryDeletionScopePreview {
    const intent = this.createHistoryDeletionIntent(input)
    return {
      kind: intent.kind,
      ...(intent.workspaceId ? { workspaceId: intent.workspaceId } : {}),
      ...(intent.rootChatId ? { rootChatId: intent.rootChatId } : {}),
      chatIds: [...intent.chatIds],
      runIds: [...intent.runIds]
    }
  }

  static prepareHistoryDeletion(input: HistoryDeletionPrepareInput): HistoryDeletionPreparation {
    if (this.historyDeletionRunning)
      throw new Error('A history deletion transaction is already running.')
    const existing = readHistoryDeletionIntent()
    if (existing) {
      const sameScope =
        existing.kind === input.kind &&
        existing.workspaceId === input.workspaceId &&
        existing.rootChatId === input.rootChatId
      if (!sameScope) {
        throw new Error(
          `History deletion ${existing.operationId} is still pending; complete it before starting another scope.`
        )
      }
      return this.historyDeletionPreparation(existing)
    }
    const intent = this.createHistoryDeletionIntent(input)
    // Durable prepare is the point of no return. No destructive operation may
    // precede this fsynced intent, and it remains until every sink verifies.
    writeHistoryDeletionIntent(intent)
    return this.historyDeletionPreparation(intent)
  }

  static recordHistoryDeletionQuiesced(operationId: string, targetIds: string[]): void {
    if (this.historyDeletionRunning) throw new Error('History deletion has already entered commit.')
    const intent = readHistoryDeletionIntent()
    if (!intent || intent.operationId !== operationId) {
      throw new Error('History deletion quiescence receipt does not match the pending operation.')
    }
    const known = new Set(intent.quiescenceTargets.map((target) => target.id))
    const completed = new Set(intent.completedQuiescenceTargetIds)
    for (const targetId of targetIds) {
      if (!known.has(targetId)) {
        throw new Error(`Unknown history deletion quiescence target: ${targetId}`)
      }
      completed.add(targetId)
    }
    intent.completedQuiescenceTargetIds = [...completed].sort()
    intent.updatedAt = new Date().toISOString()
    writeHistoryDeletionIntent(intent)
  }

  static commitPreparedHistoryDeletion(operationId: string): void | Promise<void> {
    if (this.historyDeletionRunning)
      throw new Error('A history deletion transaction is already running.')
    const intent = readHistoryDeletionIntent()
    if (!intent || intent.operationId !== operationId) {
      throw new Error('History deletion commit does not match the pending operation.')
    }
    this.historyDeletionRunning = true
    let settled: void | Promise<void>
    try {
      settled = this.executeHistoryDeletion(intent)
    } catch (error) {
      this.historyDeletionRunning = false
      throw error
    }
    if (settled) {
      return settled.finally(() => {
        this.historyDeletionRunning = false
      })
    }
    this.historyDeletionRunning = false
  }

  private static runHistoryDeletion(input: HistoryDeletionPrepareInput): void | Promise<void> {
    const prepared = this.prepareHistoryDeletion(input)
    return this.commitPreparedHistoryDeletion(prepared.operationId)
  }

  /** True while the legacy writer gate admits writes (open, or a retained drain admission). */
  static legacyStoreWritesOpen(): boolean {
    return legacyStoreCanWrite()
  }

  static deleteChat(chatId: string, _seen: Set<string> = new Set()): void {
    runLegacyStoreWriteAdmission({ operation: 'delete-chat', pathFamily: 'chats' }, () => {
      if (!isSafeChatId(chatId)) throw new Error('Chat id must be a safe chat id.')
      this.runHistoryDeletion({ kind: 'chat', rootChatId: chatId })
    })
  }

  /**
   * Host-owned-gate delete: the same transaction, with only the chat-record
   * removal routed through the Host (thread.record.delete). Callers select
   * this via legacyStoreWritesOpen() so the legacy entry keeps its
   * synchronous signature and semantics exactly.
   */
  static deleteChatViaHost(chatId: string): Promise<void> {
    if (!isSafeChatId(chatId)) return Promise.reject(new Error('Chat id must be a safe chat id.'))
    const settled = this.runHistoryDeletion({ kind: 'chat', rootChatId: chatId })
    return settled ? settled : Promise.resolve()
  }

  static truncateChatHistory(chatId: string): ChatRecord | null {
    return runLegacyStoreWriteAdmission(
      { operation: 'truncate-chat-history', pathFamily: 'chats' },
      () => {
        if (!isSafeChatId(chatId)) throw new Error('Chat id must be a safe chat id.')
        if (!this.getChat(chatId)) return null
        this.runHistoryDeletion({ kind: 'truncate', rootChatId: chatId })
        return this.getChat(chatId)
      }
    )
  }

  /**
   * Host-owned-gate truncate: the record is scrubbed by the same
   * buildTruncatedChatRecordForErasure and travels via thread.record.persist
   * with main's complete record (never delete), per the 84a5d849f modeling.
   */
  static truncateChatHistoryViaHost(chatId: string): Promise<ChatRecord | null> {
    if (!isSafeChatId(chatId)) {
      return Promise.reject(new Error('Chat id must be a safe chat id.'))
    }
    if (!this.getChat(chatId)) return Promise.resolve(null)
    const settled = this.runHistoryDeletion({ kind: 'truncate', rootChatId: chatId })
    return settled ? settled.then(() => this.getChat(chatId)) : Promise.resolve(this.getChat(chatId))
  }

  static clearChats(workspaceId?: string): void {
    runLegacyStoreWriteAdmission({ operation: 'clear-chats', pathFamily: 'chats' }, () => {
      this.runHistoryDeletion(workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'global' })
    })
  }

  /** Host-owned-gate clear: repeated thread.record.delete over the frozen intent.chatIds. */
  static clearChatsViaHost(workspaceId?: string): Promise<void> {
    const settled = this.runHistoryDeletion(
      workspaceId ? { kind: 'workspace', workspaceId } : { kind: 'global' }
    )
    return settled ? settled : Promise.resolve()
  }

  // Durable parent-bound sub-thread event mailbox. Kept outside ChatRecord so
  // result payloads do not inflate chat-list projections or transcript files.
  static getSubThreadMailbox(parentChatId: string): SubThreadMailbox {
    const ledger = readSubThreadMailboxLedger()
    return ledger.mailboxes[parentChatId] || emptySubThreadMailbox(parentChatId)
  }

  static enqueueSubThreadMailboxEvent(
    input: SubThreadMailboxEventInput,
    options: { now?: string } = {}
  ): ReturnType<typeof enqueueMailboxEvent> {
    this.assertHistoryMutationAllowed({
      operation: 'Sub-thread mailbox enqueue',
      chatIds: [input.parentChatId, input.subThreadId],
      workspaceIds: [
        this.getChat(input.parentChatId)?.workspaceId,
        this.getChat(input.subThreadId)?.workspaceId
      ],
      runIds: [input.sourceRunId]
    })
    const ledger = readSubThreadMailboxLedger()
    // Capture the exact child RUN here rather than at each of the six call
    // sites. Its durable requested/actual model and provider metadata are the
    // only source for a frozen return identity; reading mutable chat settings
    // later could let a recall or reconfiguration rewrite the result's seat.
    const seat = seatFromSoloChatRun(this.getChat(input.subThreadId), input.sourceRunId)
    const result = enqueueMailboxEvent(
      ledger.mailboxes[input.parentChatId],
      { ...input, ...(seat ? { subThreadSeat: seat } : {}) },
      options
    )
    if (result.inserted) {
      ledger.mailboxes[input.parentChatId] = result.mailbox
      writeSubThreadMailboxLedger(ledger)
    }
    return result
  }

  static getExecutionResultMailbox(threadId: string): ExecutionResultMailbox {
    const ledger = readExecutionResultMailboxLedger()
    return ledger.mailboxes[threadId] || emptyExecutionResultMailbox(threadId)
  }

  /**
   * Durable delivery of a graph's terminal result to its owning thread. The
   * read-modify-write below has no await in it, so it is atomic with respect to
   * concurrent in-process callers — the same property the sub-thread mailbox
   * relies on. A duplicate costs zero disk I/O.
   */
  static enqueueExecutionResultMailboxEvent(
    input: ExecutionResultMailboxEventInput,
    options: { now?: string } = {}
  ): ReturnType<typeof enqueueExecutionResultEvent> {
    this.assertHistoryMutationAllowed({
      operation: 'Execution result mailbox enqueue',
      chatIds: [input.threadId],
      workspaceIds: [this.getChat(input.threadId)?.workspaceId]
    })
    const ledger = readExecutionResultMailboxLedger()
    const result = enqueueExecutionResultEvent(ledger.mailboxes[input.threadId], input, options)
    if (result.inserted) {
      ledger.mailboxes[input.threadId] = result.mailbox
      writeExecutionResultMailboxLedger(ledger)
    }
    return result
  }

  static deleteExecutionResultMailbox(threadId: string): void {
    const ledger = readExecutionResultMailboxLedger()
    if (!ledger.mailboxes[threadId]) return
    delete ledger.mailboxes[threadId]
    if (Object.keys(ledger.mailboxes).length === 0) {
      deletePathBestEffort(executionResultMailboxesPath, 'execution result mailbox ledger')
      return
    }
    writeExecutionResultMailboxLedger(ledger)
  }

  static deleteSubThreadMailbox(parentChatId: string): void {
    const ledger = readSubThreadMailboxLedger()
    if (!ledger.mailboxes[parentChatId]) return
    delete ledger.mailboxes[parentChatId]
    if (Object.keys(ledger.mailboxes).length === 0) {
      deletePathBestEffort(subThreadMailboxesPath, 'sub-thread mailbox ledger')
      return
    }
    writeSubThreadMailboxLedger(ledger)
  }

  // Durable peer thread-to-thread inbox, keyed by RECEIVING chat. Delivery
  // authority stays outside ChatRecord like the sub-thread mailbox; an accepted
  // event also gets a projection-only ChatMessage for visible transcript history.
  static getThreadMessageInbox(chatId: string): ThreadMessageInbox {
    return threadMessageInboxFor(readThreadMessageLedger(), chatId)
  }

  static getPendingThreadMessageInboxes(): ThreadMessageInbox[] {
    return pendingThreadMessageInboxes(readThreadMessageLedger())
  }

  /**
   * Durable chokepoint for an inbound message. Permission is S3's job; what is
   * enforced HERE is that the destination exists, because a message queued for a
   * chat that never existed can never be delivered or seen and would accumulate
   * as unreachable content.
   */
  static enqueueThreadMessage(event: ThreadMessageEvent): {
    outcome: ThreadMessageDeliveryOutcome
    inbox: ThreadMessageInbox
  } {
    this.assertHistoryMutationAllowed({
      operation: 'Thread message enqueue',
      chatIds: [event.fromChatId, event.toChatId],
      workspaceIds: [
        this.getChat(event.fromChatId)?.workspaceId,
        this.getChat(event.toChatId)?.workspaceId
      ]
    })
    const ledger = readThreadMessageLedger()
    const targetChat = this.getChat(event.toChatId)
    if (!targetChat) {
      return { outcome: 'unknown-target', inbox: threadMessageInboxFor(ledger, event.toChatId) }
    }
    const result = enqueueThreadMessageInLedger(ledger, event)
    if (result.outcome === 'accepted') {
      writeThreadMessageLedger(result.ledger)
      const projection = appendThreadMessageTranscriptProjection(targetChat, event)
      if (projection.inserted) this.saveChat(projection.chat)
    }
    return { outcome: result.outcome, inbox: result.inbox }
  }

  /**
   * Called AFTER the bodies have entered the target's provider context, so a
   * crash mid-turn re-delivers rather than silently dropping.
   */
  static acknowledgeThreadMessages(
    chatId: string,
    ids: readonly string[]
  ): { acknowledgedIds: string[]; inbox: ThreadMessageInbox } {
    this.assertHistoryMutationAllowed({
      operation: 'Thread message acknowledgement',
      chatIds: [chatId],
      workspaceIds: [this.getChat(chatId)?.workspaceId]
    })
    const result = acknowledgeThreadMessagesInLedger(readThreadMessageLedger(), chatId, ids)
    if (result.acknowledgedIds.length > 0) writeThreadMessageLedger(result.ledger)
    return { acknowledgedIds: result.acknowledgedIds, inbox: result.inbox }
  }

  // Usage
  static getUsage(workspaceId?: string, chatId?: string) {
    // Reads the hot checkpoint plus uncheckpointed journal records. History
    // rotated to usage-archive.jsonl is intentionally not served here.
    const records = usageJournalStore.getRecords()
    return records.filter((record) => {
      if (workspaceId && record.workspaceId !== workspaceId) return false
      if (chatId && record.chatId !== chatId) return false
      return true
    })
  }

  static recordUsage(usage: Omit<UsageRecord, 'id' | 'timestamp'>) {
    this.assertHistoryMutationAllowed({
      operation: 'Usage history append',
      chatIds: [usage.chatId],
      workspaceIds: [usage.workspaceId],
      runIds: [usage.runId]
    })
    const settings = this.getSettings()

    const record: UsageRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      ...usage
    }

    if (!settings.storePromptResponseInUsage) {
      delete record.promptText
      delete record.responseText
    }

    usageJournalStore.append(record)
  }

  static beginUsageHistoryMutation(input: UsageHistoryMutationInput): UsageHistoryMutationHold {
    return usageJournalStore.beginHistoryMutation(input)
  }

  static purgeUsageHistoryStrict(hold: UsageHistoryMutationHold): UsageHistoryPurgeReport {
    return usageJournalStore.purgeHistoryStrict(hold)
  }

  static endUsageHistoryMutation(hold: UsageHistoryMutationHold): boolean {
    return usageJournalStore.endHistoryMutation(hold)
  }

  static recoverPendingUsageHistoryMutationStrict(): UsageHistoryPurgeReport | null {
    return usageJournalStore.recoverPendingHistoryMutationStrict()
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
    assertNoPendingScheduledOccurrenceMutation()
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
    if (!scheduledAttachmentsAreDurable(workflow.template.imageAttachments)) {
      return SCHEDULED_ATTACHMENT_RESELECT_REASON
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
    assertNoPendingScheduledOccurrenceMutation()
    if (workflow.enabled) {
      this.assertHistoryMutationAllowed({
        operation: 'Workflow schedule enablement',
        chatIds: [workflow.template.chatId],
        workspaceIds: [workflow.workspaceId, workflow.template.workspaceId]
      })
    }
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
    let saved = normalized
    if (index >= 0) {
      const prior = workflows[index]
      const next: WorkflowDefinition = { ...prior, ...normalized, updatedAt: nowIso }
      assertWorkflowOccurrenceProjectionInputUnchanged(prior, workflow)
      preserveWorkflowOccurrenceProjection(prior, next)
      // An acknowledgement authorizes the complete execution envelope, not just
      // approvalMode. Any authority-bearing change revokes it before persistence.
      if (!sameWorkflowAuthority(prior, next)) {
        delete next.unattendedElevation
      } else if (!next.unattendedElevation && prior.unattendedElevation) {
        next.unattendedElevation = prior.unattendedElevation
      }
      workflows[index] = next
      saved = next
    } else workflows.push(saved)
    writeJson(workflowsPath, workflows)
    return saved
  }

  static updateWorkflowDefinition(
    id: string,
    partial: Partial<WorkflowDefinition>
  ): WorkflowDefinition | null {
    assertNoPendingScheduledOccurrenceMutation()
    const workflows = this.getWorkflowDefinitions()
    const index = workflows.findIndex((workflow) => workflow.id === id)
    if (index < 0) return null
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const source = workflows[index]
    assertWorkflowOccurrenceProjectionInputUnchanged(source, partial)
    const merged = {
      ...source,
      ...partial,
      id,
      template: partial.template ? { ...source.template, ...partial.template } : source.template,
      trigger: partial.trigger ? normalizeWorkflowTrigger(partial.trigger, nowMs) : source.trigger,
      limits: partial.limits ? { ...source.limits, ...partial.limits } : source.limits,
      updatedAt: nowIso
    }
    const normalized = normalizeWorkflowDefinitionRecord(merged, nowMs)
    if (!normalized) return null
    if (normalized.enabled) {
      this.assertHistoryMutationAllowed({
        operation: 'Workflow schedule enablement',
        chatIds: [normalized.template.chatId],
        workspaceIds: [normalized.workspaceId, normalized.template.workspaceId]
      })
    }
    if (normalized.unattendedElevation && !sameWorkflowAuthority(source, normalized)) {
      delete normalized.unattendedElevation
    }
    // Disabling is the fail-safe escape hatch for an orphaned workflow. A
    // target chat can be archived, deleted, or moved after the workflow was
    // saved; requiring that stale target to remain runnable would make the
    // safety action itself impossible. Any transition back to enabled still
    // revalidates the complete definition before it can be persisted.
    if (normalized.enabled) this.assertWorkflowDefinitionCanRun(normalized)
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
    assertNoPendingScheduledOccurrenceMutation()
    const workflow = this.getWorkflowDefinition(id)
    if (workflow) {
      const tasks = this.getScheduledTasks()
      const nonterminalExecutions = workflow.history.filter(
        (execution) => !isTerminalWorkflowExecutionStatus(execution.status)
      )
      if (
        nonterminalExecutions.some((execution) => !execution.scheduledTaskId) ||
        (workflow.activeExecutionId &&
          nonterminalExecutions.filter((execution) => execution.id === workflow.activeExecutionId)
            .length !== 1)
      ) {
        throw new Error(
          'Workflow definition could not be deleted because a linked occurrence did not settle: active execution linkage is missing or divergent.'
        )
      }
      const requiredTaskIds = new Set(
        nonterminalExecutions
          .filter((execution) => execution.scheduledTaskId)
          .map((execution) => execution.scheduledTaskId as string)
      )
      const retainedHistoryTaskIds = workflow.history
        .filter(
          (execution) =>
            execution.scheduledTaskId && tasks.some((task) => task.id === execution.scheduledTaskId)
        )
        .map((execution) => execution.scheduledTaskId as string)
      const retainedExecutionIds = new Set(workflow.history.map((execution) => execution.id))
      const retainedRunIds = new Set(
        workflow.history
          .map((execution) => execution.runId)
          .filter((runId): runId is string => runId !== undefined)
      )
      const retainedAliasOwnerTaskIds = tasks
        .filter(
          (task) =>
            (task.workflowExecutionId && retainedExecutionIds.has(task.workflowExecutionId)) ||
            (task.runId && retainedRunIds.has(task.runId))
        )
        .map((task) => task.id)
      const ledgerLinkedTaskIds = [...strictWorkflowLedgerTaskIds(id)].filter((taskId) =>
        tasks.some((task) => task.id === taskId)
      )
      const linkedTaskIds = new Set([
        ...tasks.filter((task) => task.workflowId === id).map((task) => task.id),
        ...requiredTaskIds,
        ...retainedHistoryTaskIds,
        ...retainedAliasOwnerTaskIds,
        ...ledgerLinkedTaskIds
      ])
      const linkedTasks = [...linkedTaskIds].map((taskId) => {
        const matches = tasks.filter((task) => task.id === taskId)
        if (matches.length !== 1) {
          throw new Error(
            'Workflow definition could not be deleted because a linked occurrence did not settle: scheduled task is missing or duplicated.'
          )
        }
        return matches[0]
      })
      for (const task of linkedTasks) {
        const pair = validateScheduledTaskWorkflowPair(
          task,
          this.getWorkflowDefinitions(),
          this.getScheduledTasks()
        )
        if (!pair.ok || pair.workflow.id !== id) {
          throw new Error(
            `Workflow definition could not be deleted because a linked occurrence did not settle: ${pair.ok ? 'workflow id diverges.' : pair.reason}`
          )
        }
      }
      // Validate every candidate before terminalizing any live row. A corrupt
      // later candidate must not leave an earlier occurrence partially changed.
      for (const task of linkedTasks) {
        if (!isTerminalScheduledTaskStatus(task.status)) {
          if (task.status === 'running' || task.runId !== undefined) {
            throw new Error(
              'Workflow definition could not be deleted while a linked occurrence is live; its exact run owner must settle it first.'
            )
          }
          const terminalized = this.settleUnownedScheduledWorkflowTask(task.id, {
            status: 'cancelled',
            completedAt: new Date().toISOString(),
            lastError: 'Workflow deleted.'
          })
          if (!terminalized || !isTerminalScheduledTaskStatus(terminalized.status)) {
            throw new Error(
              'Workflow definition could not be deleted because a linked occurrence did not settle.'
            )
          }
          const terminalPair = validateScheduledTaskWorkflowPair(
            terminalized,
            this.getWorkflowDefinitions(),
            this.getScheduledTasks()
          )
          if (!terminalPair.ok || terminalPair.workflow.id !== id) {
            throw new Error(
              `Workflow definition could not be deleted because a linked occurrence did not settle: ${terminalPair.ok ? 'workflow id diverges.' : terminalPair.reason}`
            )
          }
        }
      }
      const finalTasks = this.getScheduledTasks()
      const finalWorkflows = this.getWorkflowDefinitions()
      for (const taskId of linkedTaskIds) {
        const finalMatches = finalTasks.filter((task) => task.id === taskId)
        if (finalMatches.length !== 1) {
          throw new Error(
            'Workflow definition could not be deleted because a linked occurrence did not settle: scheduled task is missing or duplicated.'
          )
        }
        const finalTask = finalMatches[0]
        const finalPair = validateScheduledTaskWorkflowPair(finalTask, finalWorkflows, finalTasks)
        if (
          !isTerminalScheduledTaskStatus(finalTask.status) ||
          !finalPair.ok ||
          finalPair.workflow.id !== id
        ) {
          throw new Error(
            `Workflow definition could not be deleted because a linked occurrence remains active or divergent: ${finalPair.ok ? 'terminal state is missing.' : finalPair.reason}`
          )
        }
      }
      const unexpectedLinkedTasks = finalTasks.filter(
        (task) => task.workflowId === id && !linkedTaskIds.has(task.id)
      )
      if (unexpectedLinkedTasks.length > 0) {
        throw new Error(
          'Workflow definition could not be deleted because a linked occurrence appeared during deletion.'
        )
      }
      // Remove terminal task projections first. If the process stops before the
      // following workflow write, the remaining workflow history is still a
      // complete durable record; the inverse order would strand task rows that
      // can no longer validate their workflow authority.
      writeJson(
        scheduledTasksPath,
        finalTasks.filter((task) => !linkedTaskIds.has(task.id))
      )
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
      Partial<Pick<WorkspaceBoardDefinition, 'id' | 'createdAt' | 'updatedAt' | 'activity'>>
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
        activity: [...(Array.isArray(board.activity) ? board.activity : []), createdActivity],
        createdAt: board.createdAt || nowIso,
        updatedAt: nowIso
      },
      nowMs
    )
    if (!normalized) throw new Error('Workspace board is invalid.')
    const index = boards.findIndex((item) => item.id === normalized.id)
    const previousBoard = index >= 0 ? boards[index] : undefined
    if (index >= 0) {
      const prior = previousBoard!
      if (
        prior.workspaceId !== normalized.workspaceId ||
        prior.workspacePath !== normalized.workspacePath
      ) {
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
        activity: [...(prior.activity || []), updatedActivity].slice(-100)
      }
    } else {
      boards.push(normalized)
    }
    writeJson(workspaceBoardsPath, boards)
    const saved = index >= 0 ? boards[index] : normalized
    shadowWorkspaceBoardMissionFacts(
      saved,
      this.getWorkspaceBoardCards(saved.id),
      [],
      previousBoard
    )
    return saved
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
      'provenance' in partial
        ? workspaceBoardActivityActorFromProvenance(partial.provenance)
        : 'user'
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
    shadowWorkspaceBoardMissionFacts(
      normalized,
      this.getWorkspaceBoardCards(normalized.id),
      [],
      source
    )
    return normalized
  }

  static deleteWorkspaceBoard(id: string): void {
    const board = this.getWorkspaceBoard(id)
    const removedCards = this.getWorkspaceBoardCards(id)
    writeJson(
      workspaceBoardsPath,
      this.getWorkspaceBoards().filter((board) => board.id !== id)
    )
    writeJson(
      workspaceBoardCardsPath,
      this.getWorkspaceBoardCards().filter((card) => card.boardId !== id)
    )
    if (board) shadowWorkspaceBoardMissionFacts(board, [], removedCards)
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
    if (!isWorkspaceBoardCardLinkKind(link.kind)) {
      throw new Error('Board card link kind is invalid.')
    }
    if (link.kind === 'chat') {
      const chat = this.getChat(link.id)
      if (
        !chat ||
        chat.archived ||
        chat.workspaceId !== board.workspaceId ||
        chat.scope === 'global'
      ) {
        throw new Error('Board card chat link must belong to the board workspace.')
      }
      return link
    }
    if (link.kind === 'pinned-message') {
      const separatorIndex = link.id.indexOf(':')
      const chatId = separatorIndex >= 0 ? link.id.slice(0, separatorIndex) : ''
      const messageId = separatorIndex >= 0 ? link.id.slice(separatorIndex + 1) : ''
      const chat = chatId ? this.getChat(chatId) : undefined
      const message = messageId ? chat?.messages?.find((item) => item.id === messageId) : undefined
      if (
        !chat ||
        !message ||
        chat.archived ||
        chat.workspaceId !== board.workspaceId ||
        chat.scope === 'global'
      ) {
        throw new Error('Board card pinned message link must belong to the board workspace.')
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
      const serverPid = link.id.trim()
      if (!/^[1-9]\d*$/.test(serverPid)) {
        throw new Error('Board card local server link must use a runtime process id.')
      }
      return { kind: link.kind, id: serverPid }
    }
    throw new Error('Board card link kind is invalid.')
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
        activity: [...(Array.isArray(card.activity) ? card.activity : []), createdActivity],
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
        activity: [...(prior.activity || []), updatedActivity].slice(-100)
      }
    } else {
      cards.push(normalized)
    }
    writeJson(workspaceBoardCardsPath, cards)
    const saved = existingIndex >= 0 ? cards[existingIndex] : normalized
    shadowWorkspaceBoardMissionFacts(
      board,
      cards.filter((candidate) => candidate.boardId === board.id),
      existingCard ? [existingCard] : []
    )
    return saved
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
      'provenance' in partial
        ? workspaceBoardActivityActorFromProvenance(partial.provenance)
        : 'user'
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
          'link' in partial ? this.assertWorkspaceBoardCardLink(board, partial.link) : source.link,
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
    shadowWorkspaceBoardMissionFacts(
      board,
      cards.filter((candidate) => candidate.boardId === board.id),
      [source]
    )
    return normalized
  }

  static deleteWorkspaceBoardCard(id: string): void {
    const cards = this.getWorkspaceBoardCards()
    const removed = cards.find((card) => card.id === id)
    const board = removed ? this.getWorkspaceBoard(removed.boardId) : null
    writeJson(
      workspaceBoardCardsPath,
      cards.filter((card) => card.id !== id)
    )
    if (board && removed) {
      shadowWorkspaceBoardMissionFacts(
        board,
        cards.filter((card) => card.boardId === board.id && card.id !== id),
        [removed]
      )
    }
  }

  // Evidence packs / capability ledger
  static getEvidencePacks(workspaceId?: string): EvidencePackRecord[] {
    return readJson<unknown[]>(evidencePacksPath, [])
      .map((item) => normalizeEvidencePackRecord(item))
      .filter((item): item is EvidencePackRecord => Boolean(item))
      .filter((pack) => !workspaceId || pack.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  static saveEvidencePack(pack: Partial<EvidencePackRecord>): EvidencePackRecord {
    const packs = this.getEvidencePacks()
    const now = new Date()
    const nowIso = now.toISOString()
    const normalized = normalizeEvidencePackRecord(
      {
        ...pack,
        id: pack.id || randomUUID(),
        createdAt: pack.createdAt || nowIso,
        updatedAt: nowIso
      },
      now
    )
    if (!normalized) throw new Error('Evidence pack is invalid.')
    const index = packs.findIndex((item) => item.id === normalized.id)
    if (index >= 0) {
      const prior = packs[index]
      if (prior.workspaceId !== normalized.workspaceId) {
        throw new Error('Evidence pack cannot move workspaces.')
      }
      packs[index] = {
        ...normalized,
        createdAt: prior.createdAt,
        updatedAt: nowIso
      }
    } else {
      packs.push(normalized)
    }
    writeJson(evidencePacksPath, packs)
    return index >= 0 ? packs[index] : normalized
  }

  static deleteEvidencePack(id: string): void {
    writeJson(
      evidencePacksPath,
      this.getEvidencePacks().filter((pack) => pack.id !== id)
    )
  }

  static getCapabilityLedgerSnapshot(workspaceId?: string): CapabilityLedgerSnapshot {
    return projectCapabilityLedgerFromEvidencePacks(this.getEvidencePacks(workspaceId), {
      workspaceId
    })
  }

  static getRepoConventionIndexes(workspaceId?: string): RepoConventionIndexSnapshot[] {
    return readJson<unknown[]>(repoConventionIndexesPath, [])
      .map((item) => normalizeRepoConventionIndexSnapshot(item))
      .filter((item): item is RepoConventionIndexSnapshot => Boolean(item))
      .filter((snapshot) => !workspaceId || snapshot.workspaceId === workspaceId)
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
  }

  static saveRepoConventionIndex(
    snapshot: Partial<RepoConventionIndexSnapshot>
  ): RepoConventionIndexSnapshot {
    const snapshots = this.getRepoConventionIndexes()
    const normalized = normalizeRepoConventionIndexSnapshot({
      ...snapshot,
      generatedAt: snapshot.generatedAt || new Date().toISOString()
    })
    if (!normalized) throw new Error('Repo convention index is invalid.')
    const index = snapshots.findIndex((item) => item.workspaceId === normalized.workspaceId)
    if (index >= 0) snapshots[index] = normalized
    else snapshots.push(normalized)
    writeJson(repoConventionIndexesPath, snapshots)
    return normalized
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

  // ── Thread introspection / memory promotion ─────────────────────────────
  // Read-only retrospective runs + reviewable proposal packs. Apply/mutation is
  // intentionally NOT implemented here — proposals stay proposed until reviewed.

  static getIntrospectionRuns(workspaceId?: string): IntrospectionRunRecord[] {
    return readJson<unknown[]>(introspectionRunsPath, [])
      .map((item) => normalizeIntrospectionRunRecord(item))
      .filter((item): item is IntrospectionRunRecord => Boolean(item))
      .filter((run) => !workspaceId || run.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  static getIntrospectionRun(id: string): IntrospectionRunRecord | null {
    return this.getIntrospectionRuns().find((run) => run.id === id) || null
  }

  static createIntrospectionRun(
    input: Omit<
      IntrospectionRunRecord,
      'schemaVersion' | 'id' | 'createdAt' | 'updatedAt' | 'evidenceItems'
    > &
      Partial<Pick<IntrospectionRunRecord, 'id' | 'evidenceItems'>>
  ): IntrospectionRunRecord {
    const nowIso = new Date().toISOString()
    const record = normalizeIntrospectionRunRecord({
      ...input,
      id: input.id || randomUUID(),
      evidenceItems: input.evidenceItems || [],
      createdAt: nowIso,
      updatedAt: nowIso
    })
    if (!record) throw new Error('Introspection run is invalid.')
    const runs = [record, ...this.getIntrospectionRuns().filter((r) => r.id !== record.id)].slice(
      0,
      INTROSPECTION_RUN_HISTORY_LIMIT
    )
    writeJson(introspectionRunsPath, runs)
    return record
  }

  static updateIntrospectionRun(
    id: string,
    partial: Partial<IntrospectionRunRecord>
  ): IntrospectionRunRecord | null {
    const runs = this.getIntrospectionRuns()
    const index = runs.findIndex((run) => run.id === id)
    if (index < 0) return null
    const merged = normalizeIntrospectionRunRecord({
      ...runs[index],
      ...partial,
      id,
      updatedAt: new Date().toISOString()
    })
    if (!merged) return null
    runs[index] = merged
    writeJson(introspectionRunsPath, runs)
    return merged
  }

  static deleteIntrospectionRun(id: string): void {
    writeJson(
      introspectionRunsPath,
      this.getIntrospectionRuns().filter((run) => run.id !== id)
    )
  }

  static getMemoryProposalPacks(workspaceId?: string): MemoryProposalPack[] {
    return readJson<unknown[]>(memoryProposalPacksPath, [])
      .map((item) => normalizeMemoryProposalPack(item))
      .filter((item): item is MemoryProposalPack => Boolean(item))
      .filter((pack) => !workspaceId || pack.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  static getMemoryProposalPack(id: string): MemoryProposalPack | null {
    return this.getMemoryProposalPacks().find((pack) => pack.id === id) || null
  }

  static saveMemoryProposalPack(pack: Partial<MemoryProposalPack>): MemoryProposalPack {
    const packs = this.getMemoryProposalPacks()
    const nowIso = new Date().toISOString()
    const normalized = normalizeMemoryProposalPack({
      ...pack,
      id: pack.id || randomUUID(),
      schemaVersion: 1,
      introspectionRunId: pack.introspectionRunId || '',
      windowStart: pack.windowStart || nowIso,
      windowEnd: pack.windowEnd || nowIso,
      proposals: pack.proposals || [],
      evidenceItemCount: pack.evidenceItemCount ?? 0,
      createdAt: pack.createdAt || nowIso,
      updatedAt: nowIso
    })
    if (!normalized) throw new Error('Memory proposal pack is invalid.')
    const next = [normalized, ...packs.filter((item) => item.id !== normalized.id)].slice(
      0,
      MEMORY_PROPOSAL_PACK_HISTORY_LIMIT
    )
    writeJson(memoryProposalPacksPath, next)
    return normalized
  }

  static updateMemoryProposal(
    packId: string,
    proposalId: string,
    partial: Partial<MemoryProposal>
  ): MemoryProposalPack | null {
    const result = this.applyMemoryProposalPatches([{ packId, proposalId, partial }])
    return result?.[0] ?? null
  }

  /** Apply multiple proposal patches in one persist — all patches must resolve or none apply. */
  static applyMemoryProposalPatches(
    patches: Array<{ packId: string; proposalId: string; partial: Partial<MemoryProposal> }>
  ): MemoryProposalPack[] | null {
    if (patches.length === 0) return []
    const packs = this.getMemoryProposalPacks()
    const packIndexById = new Map(packs.map((item, index) => [item.id, index]))
    const nextPacks = packs.map((item) => ({
      ...item,
      proposals: [...item.proposals]
    }))
    const touchedPackIds = new Set<string>()
    const nowIso = new Date().toISOString()

    for (const patch of patches) {
      const packIndex = packIndexById.get(patch.packId)
      if (packIndex === undefined) return null
      const pack = nextPacks[packIndex]!
      const proposalIndex = pack.proposals.findIndex((item) => item.id === patch.proposalId)
      if (proposalIndex < 0) return null
      pack.proposals[proposalIndex] = {
        ...pack.proposals[proposalIndex]!,
        ...patch.partial,
        id: patch.proposalId,
        updatedAt: patch.partial.updatedAt || nowIso
      }
      touchedPackIds.add(patch.packId)
    }

    const normalized = nextPacks
      .map((item) =>
        touchedPackIds.has(item.id)
          ? normalizeMemoryProposalPack({ ...item, updatedAt: nowIso })
          : item
      )
      .filter((item): item is MemoryProposalPack => Boolean(item))

    if (normalized.length !== nextPacks.length) return null

    writeJson(memoryProposalPacksPath, normalized)
    return normalized.filter((item) => touchedPackIds.has(item.id))
  }

  static deleteMemoryProposalPack(id: string): void {
    writeJson(
      memoryProposalPacksPath,
      this.getMemoryProposalPacks().filter((pack) => pack.id !== id)
    )
  }

  static getIntrospectionScheduleRecords(): IntrospectionScheduleRecord[] {
    return readJson<unknown[]>(introspectionSchedulePath, [])
      .map((item) => normalizeIntrospectionScheduleRecord(item))
      .filter((item): item is IntrospectionScheduleRecord => Boolean(item))
  }

  static getIntrospectionSchedule(workspaceId?: string): IntrospectionScheduleSettings {
    const key = scheduleWorkspaceKey(workspaceId)
    const record =
      this.getIntrospectionScheduleRecords().find((item) => item.workspaceId === key) || null
    return toIntrospectionScheduleSettings(record, workspaceId)
  }

  static updateIntrospectionSchedule(
    partial: Partial<IntrospectionScheduleSettings> & { workspaceId?: string | null }
  ): IntrospectionScheduleSettings {
    const nowIso = new Date().toISOString()
    const key = scheduleWorkspaceKey(partial.workspaceId)
    const records = this.getIntrospectionScheduleRecords()
    const index = records.findIndex((item) => item.workspaceId === key)
    const existing = index >= 0 ? records[index]! : null
    const merged = mergeIntrospectionScheduleUpdate(existing, partial, nowIso)
    const next =
      index >= 0
        ? records.map((item, itemIndex) => (itemIndex === index ? merged : item))
        : [merged, ...records]
    writeJson(introspectionSchedulePath, next)
    return toIntrospectionScheduleSettings(merged, partial.workspaceId)
  }

  static getNextIntrospectionScheduleRunAtMs(nowMs = Date.now()): number | null {
    return getNextIntrospectionScheduleRunAtMs(this.getIntrospectionScheduleRecords(), nowMs)
  }

  static getAuditRetentionPurgeReceipts(): AuditRetentionPurgeReceipt[] {
    return capAuditRetentionPurgeReceipts(
      readJson<unknown[]>(auditRetentionPurgesPath, []).filter(
        (receipt): receipt is AuditRetentionPurgeReceipt =>
          Boolean(
            receipt &&
            typeof receipt === 'object' &&
            (receipt as AuditRetentionPurgeReceipt).schemaVersion === 1 &&
            typeof (receipt as AuditRetentionPurgeReceipt).id === 'string'
          )
      )
    )
  }

  static getAuditBundleVerificationReceipts(): ProductAuditBundleVerificationReceipt[] {
    return capAuditBundleVerificationReceipts(
      readJson<unknown[]>(auditBundleVerificationReceiptsPath, [])
    )
  }

  static recordAuditBundleVerificationReceipt(
    receipt: ProductAuditBundleVerificationReceipt
  ): ProductAuditBundleVerificationReceipt {
    const records = [...this.getAuditBundleVerificationReceipts(), receipt]
    writeAuditBundleVerificationReceipts(records)
    return receipt
  }

  static purgeAuditRetentionEvidence(
    request: AuditRetentionPurgeRequest = {},
    externalCounts: Partial<Record<AuditRetentionSurface, AuditRetentionSurfacePurgeCounts>> = {}
  ): AuditRetentionPurgeResult {
    try {
      const generatedAt =
        typeof request.now === 'string' && Number.isFinite(Date.parse(request.now))
          ? new Date(Date.parse(request.now)).toISOString()
          : new Date().toISOString()
      const nowMs = Date.parse(generatedAt)
      const storedPolicy = this.getSettings().auditRetention
      const policy = normalizeAuditRetentionSettings(request.policy || storedPolicy)
      const enabled = policy.enabled === true
      const dryRun = request.dryRun !== false || !enabled
      const counts = emptyAuditRetentionCounts()
      const isExpired = (surface: AuditRetentionSurface, timestamp: unknown): boolean =>
        enabled &&
        isBeforeAuditRetentionCutoff(timestamp, auditRetentionCutoffMs(policy, surface, nowMs))
      const recordScan = (
        surface: AuditRetentionSurface,
        scanned: number,
        retained: number
      ): void => {
        counts[surface] = {
          scanned,
          retained,
          deleted: Math.max(0, scanned - retained)
        }
      }

      const approvalRecords = this.recoverExpiredApprovalLedger()
      const retainedApprovals = approvalRecords.filter((record) => {
        if (isLiveApprovalLedgerRecord(record)) return true
        return !isExpired('approvalLedger', record.respondedAt || record.requestedAt)
      })
      recordScan('approvalLedger', approvalRecords.length, retainedApprovals.length)
      if (!dryRun && retainedApprovals.length !== approvalRecords.length) {
        writeApprovalLedger(retainedApprovals)
      }

      const workspaceChanges = this.readWorkspaceChangeSetsCached()
      const retainedWorkspaceChanges = workspaceChanges.filter(
        (record) => !isExpired('workspaceChanges', record.updatedAt)
      )
      recordScan('workspaceChanges', workspaceChanges.length, retainedWorkspaceChanges.length)
      if (!dryRun && retainedWorkspaceChanges.length !== workspaceChanges.length) {
        writeJson(workspaceChangesPath, retainedWorkspaceChanges)
        this.workspaceChangeCache = null
      }

      const auditRuns = this.getAuditRuns()
      const retainedAuditRuns = auditRuns.filter(
        (run) => !isExpired('auditRuns', run.endedAt || run.updatedAt || run.createdAt)
      )
      recordScan('auditRuns', auditRuns.length, retainedAuditRuns.length)
      if (!dryRun && retainedAuditRuns.length !== auditRuns.length) {
        writeJson(auditRunsPath, retainedAuditRuns)
      }

      const feedbackReceipts = this.readMessageFeedbackLedger()
      const retainedFeedbackReceipts = feedbackReceipts.filter(
        (receipt) => !isExpired('messageFeedback', receipt.recordedAt || receipt.at)
      )
      recordScan('messageFeedback', feedbackReceipts.length, retainedFeedbackReceipts.length)
      if (!dryRun && retainedFeedbackReceipts.length !== feedbackReceipts.length) {
        writeMessageFeedbackLedger(retainedFeedbackReceipts)
      }

      const crashes = readJson<ProductCrashRecord[] | unknown>(productCrashesPath, [])
      const crashRecords = Array.isArray(crashes) ? crashes : []
      const retainedCrashes = crashRecords.filter(
        (record) => !isExpired('productCrashes', record.occurredAt)
      )
      recordScan('productCrashes', crashRecords.length, retainedCrashes.length)
      if (!dryRun && retainedCrashes.length !== crashRecords.length) {
        writeJson(productCrashesPath, retainedCrashes)
      }

      if (externalCounts.externalPublish) {
        counts.externalPublish = externalCounts.externalPublish
      }

      let runEventScanned = 0
      let runEventRetained = 0
      if (fs.existsSync(runEventsDir)) {
        for (const entry of fs.readdirSync(runEventsDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
          runEventScanned += 1
          const eventPath = path.join(runEventsDir, entry.name)
          const stat = fs.statSync(eventPath)
          if (isExpired('runEvents', stat.mtimeMs)) {
            const safeRunId = entry.name.replace(/\.jsonl$/, '')
            if (!dryRun) deleteRunForensicFiles(safeRunId)
          } else {
            runEventRetained += 1
          }
        }
      }
      recordScan('runEvents', runEventScanned, runEventRetained)

      const receipt: AuditRetentionPurgeReceipt = {
        schemaVersion: 1,
        id: `audit-retention-${Date.now()}-${randomUUID()}`,
        generatedAt,
        dryRun,
        enabled,
        policy,
        counts
      }
      writeAuditRetentionPurgeReceipts([...this.getAuditRetentionPurgeReceipts(), receipt])
      return { ok: true, receipt }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  static setScheduledOccurrenceMutationCrashPointForTests(
    point: ScheduledOccurrenceMutationCrashPoint | null
  ): void {
    scheduledOccurrenceMutationCrashPoint = point
    if (point === null) scheduledOccurrenceDurabilityFailureIntent = null
  }

  private static createScheduledOccurrenceLedgerTransition(
    task: ScheduledTask,
    timestamp: string
  ): {
    ledgerBefore: ScheduledOccurrenceLedgerPrefix
    ledgerAfter: WorkflowRunEvent
  } {
    if (!task.workflowExecutionId || !task.workflowId || !task.workflowOccurrenceAt) {
      throw new Error('Scheduled occurrence lifecycle ledger is missing its W/E/P identity.')
    }
    const ledgerPath = workflowRunFilePath(task.workflowExecutionId)
    const events = readWorkflowRunLedgerForAppend(ledgerPath, {
      workflowExecutionId: task.workflowExecutionId,
      workflowId: task.workflowId,
      scheduledTaskId: task.id,
      plannedFor: task.workflowOccurrenceAt,
      runId: task.runId ?? null
    })
    const read = readWorkflowRunLedgerStrict(ledgerPath)
    if (!sameJsonValue(read.events, events) || read.hasTornTail) {
      throw new Error('Scheduled occurrence lifecycle ledger predecessor is not durable.')
    }
    const event = canonicalScheduledOccurrenceLedgerEvent(
      task,
      timestamp,
      nextWorkflowRunSequence(events)
    )
    if (!event) {
      throw new Error('Scheduled occurrence lifecycle ledger post-image could not be created.')
    }
    return {
      ledgerBefore: scheduledOccurrenceLedgerPrefix(read),
      ledgerAfter: event
    }
  }

  private static scheduledOccurrenceLedgerState(
    intent: ScheduledOccurrenceMutationIntent
  ): 'before' | 'after' | { blocked: string } {
    const expected = intent.ledgerAfter
    const prefix = intent.ledgerBefore
    if (!expected || !prefix) {
      return intent.kind === 'materialize'
        ? 'after'
        : { blocked: 'Scheduled occurrence lifecycle ledger evidence is missing.' }
    }
    const ledgerPath = workflowRunFilePath(expected.workflowExecutionId)
    const read = readWorkflowRunLedgerStrict(ledgerPath)
    const identityReason = workflowRunLedgerIdentityReason(read.events, {
      workflowExecutionId: expected.workflowExecutionId,
      workflowId: expected.workflowId,
      scheduledTaskId: expected.scheduledTaskId,
      plannedFor: expected.plannedFor,
      runId: intent.identity.runId ?? null
    })
    if (identityReason) return { blocked: identityReason }

    const predecessorReason = (events: WorkflowRunEvent[]): string | null => {
      const priorExecutionTerminals = events.filter(
        (event) =>
          event.iteration === undefined &&
          (event.kind === 'completed' ||
            event.kind === 'failed' ||
            event.kind === 'cancelled' ||
            event.kind === 'skipped' ||
            event.kind === 'stall_settled' ||
            event.kind === 'loop_settled')
      )
      if (priorExecutionTerminals.length !== 0) {
        return 'Scheduled occurrence lifecycle ledger already contains a terminal transition.'
      }
      const priorExecutionClaims = events.filter(
        (event) => event.iteration === undefined && event.kind === 'running'
      )
      if (intent.kind === 'claim' && priorExecutionClaims.length !== 0) {
        return 'Scheduled occurrence lifecycle ledger already contains a claim transition.'
      }
      if (intent.kind !== 'settle' || !intent.taskBefore) return null
      if (intent.identity.runId === undefined) {
        if (intent.taskBefore.status !== 'running') {
          return priorExecutionClaims.length === 0
            ? null
            : 'Scheduled occurrence queued settlement has an unexpected claim predecessor.'
        }
        return events.length === 0
          ? null
          : 'Scheduled occurrence legacy ownerless settlement has a non-empty ledger predecessor.'
      }
      if (priorExecutionClaims.length !== 1) {
        return 'Scheduled occurrence lifecycle ledger has no unique claim predecessor.'
      }
      const claim = priorExecutionClaims[0]
      const expectedClaim = canonicalScheduledOccurrenceLedgerEvent(
        intent.taskBefore,
        claim.timestamp,
        claim.sequence
      )
      return expectedClaim &&
        claim.timestamp === intent.taskBefore.firedAt &&
        sameJsonValue(expectedClaim, claim)
        ? null
        : 'Scheduled occurrence lifecycle ledger claim predecessor is not canonical.'
    }

    if (
      scheduledOccurrenceLedgerPrefixMatches(
        prefix,
        read.committedBytes,
        read.events,
        read.fileExisted
      )
    ) {
      const reason = predecessorReason(read.events)
      return reason ? { blocked: reason } : 'before'
    }

    const serializedPostImage = Buffer.from(serializeWorkflowRunEvent(expected), 'utf-8')
    const predecessorBytes = read.committedBytes.subarray(0, prefix.byteLength)
    const predecessorEvents = read.events.slice(0, prefix.eventCount)
    const appendedEvents = read.events.slice(prefix.eventCount)
    if (
      read.fileExisted &&
      read.committedBytes.length === prefix.byteLength + serializedPostImage.length &&
      scheduledOccurrenceLedgerPrefixMatches(
        prefix,
        predecessorBytes,
        predecessorEvents,
        prefix.fileExisted
      ) &&
      read.committedBytes.subarray(prefix.byteLength).equals(serializedPostImage) &&
      appendedEvents.length === 1 &&
      sameJsonValue(appendedEvents[0], expected)
    ) {
      const reason = predecessorReason(predecessorEvents)
      return reason ? { blocked: reason } : 'after'
    }

    const transition = read.events.filter(
      (event) =>
        event.workflowExecutionId === expected.workflowExecutionId &&
        event.workflowId === expected.workflowId &&
        event.kind === expected.kind &&
        event.scheduledTaskId === expected.scheduledTaskId
    )
    if (transition.length > 1) {
      return { blocked: 'Workflow run ledger contains a duplicate occurrence transition.' }
    }
    if (
      transition.length !== 0 ||
      read.events.some((event) => event.sequence === expected.sequence)
    ) {
      return { blocked: 'Workflow run ledger contains a conflicting occurrence post-image.' }
    }
    return { blocked: 'Workflow run ledger no longer matches its exact WAL prefix.' }
  }

  private static appendScheduledOccurrenceMutationLedgerEvent(
    intent: ScheduledOccurrenceMutationIntent
  ): void {
    if (intent.kind === 'materialize') return
    const expected = intent.ledgerAfter
    if (!expected) {
      throw new Error('Scheduled occurrence lifecycle ledger post-image is missing.')
    }
    const ledgerPath = workflowRunFilePath(expected.workflowExecutionId)
    const state = this.scheduledOccurrenceLedgerState(intent)
    if (typeof state === 'object') throw new Error(state.blocked)
    const preRepair = readWorkflowRunLedgerStrict(ledgerPath)
    if (preRepair.hasTornTail) {
      readWorkflowRunLedgerForAppend(ledgerPath, {
        workflowExecutionId: expected.workflowExecutionId,
        workflowId: expected.workflowId,
        scheduledTaskId: expected.scheduledTaskId,
        plannedFor: expected.plannedFor,
        runId: intent.identity.runId ?? null
      })
      const repairedState = this.scheduledOccurrenceLedgerState(intent)
      if (typeof repairedState === 'object' || repairedState !== state) {
        throw new Error(
          typeof repairedState === 'object'
            ? repairedState.blocked
            : 'Workflow run ledger changed while repairing its torn tail.'
        )
      }
    }
    if (state === 'after') {
      fsyncWorkflowRunLedger(ledgerPath)
      fsyncDirectory(path.dirname(ledgerPath))
      return
    }
    const directoryPath = path.dirname(ledgerPath)
    const directoryExisted = fs.existsSync(directoryPath)
    const fileExisted = fs.existsSync(ledgerPath)
    fs.mkdirSync(directoryPath, { recursive: true })
    if (!directoryExisted) fsyncDirectory(path.dirname(directoryPath))
    const descriptor = fs.openSync(ledgerPath, 'a')
    try {
      fs.writeFileSync(descriptor, serializeWorkflowRunEvent(expected), 'utf-8')
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    if (!fileExisted) fsyncDirectory(directoryPath)
    const verified = readWorkflowRunLedgerStrict(ledgerPath)
    const verifiedState = this.scheduledOccurrenceLedgerState(intent)
    if (verified.hasTornTail || verifiedState !== 'after') {
      throw new Error('Workflow run ledger WAL post-image could not be verified durably.')
    }
  }

  private static applyScheduledOccurrenceMutationIntent(
    intent: ScheduledOccurrenceMutationIntent,
    injectCrashPoints: boolean
  ): string | null {
    const invalidReason = validateScheduledOccurrenceMutationIntent(
      intent,
      LEGACY_STORE_MUTATION_VALIDATION_POLICY
    )
    if (invalidReason) return invalidReason

    const tasks = this.getScheduledTasks()
    const workflowRecords = readScheduledOccurrenceWorkflowRecordsStrict()
    if (!workflowRecords) {
      return 'Scheduled occurrence workflow projection is not a canonical raw record set.'
    }
    const taskState = occurrenceRecordState(
      tasks,
      intent.identity.taskId,
      intent.taskBefore,
      intent.taskAfter
    )
    if (taskState.status === 'blocked') return taskState.reason
    const workflowState = occurrenceRecordState(
      workflowRecords.raw,
      intent.identity.workflowId,
      intent.workflowBefore,
      intent.workflowAfter
    )
    if (workflowState.status === 'blocked') return workflowState.reason
    const ledgerState = this.scheduledOccurrenceLedgerState(intent)
    if (typeof ledgerState === 'object') return ledgerState.blocked
    const writeOrderReason = scheduledOccurrenceMutationWriteOrderReason(
      intent,
      taskState.status,
      workflowState.status,
      ledgerState
    )
    if (writeOrderReason) return writeOrderReason
    const ownerReason = validateCurrentRunOwnerReferences(intent, tasks, workflowRecords.normalized)
    if (ownerReason) return ownerReason

    if (taskState.status === 'before') {
      if (taskState.index < 0) tasks.push(cloneJsonValue(intent.taskAfter))
      else tasks[taskState.index] = cloneJsonValue(intent.taskAfter)
      writeScheduledOccurrenceJsonStrict(scheduledTasksPath, tasks)
    }
    if (injectCrashPoints) maybeCrashScheduledOccurrenceMutation('after-task')

    const tasksAfter = this.getScheduledTasks()
    const ownerAfterTaskReason = validateCurrentRunOwnerReferences(
      intent,
      tasksAfter,
      workflowRecords.normalized
    )
    if (ownerAfterTaskReason) return ownerAfterTaskReason
    if (workflowState.status === 'before') {
      workflowRecords.raw[workflowState.index] = cloneJsonValue(intent.workflowAfter)
      writeScheduledOccurrenceJsonStrict(workflowsPath, workflowRecords.raw)
    }
    if (injectCrashPoints) maybeCrashScheduledOccurrenceMutation('after-workflow')

    this.appendScheduledOccurrenceMutationLedgerEvent(intent)
    if (injectCrashPoints) maybeCrashScheduledOccurrenceMutation('after-ledger')
    try {
      writeScheduledOccurrenceJsonStrict(scheduledOccurrenceMutationsPath, null)
      scheduledOccurrenceDurabilityFailureIntent = null
    } catch (error) {
      scheduledOccurrenceDurabilityFailureIntent = cloneJsonValue(intent)
      throw error
    }
    return null
  }

  private static commitScheduledOccurrenceMutation(
    intent: ScheduledOccurrenceMutationIntent
  ): void {
    const invalidReason = validateScheduledOccurrenceMutationIntent(
      intent,
      LEGACY_STORE_MUTATION_VALIDATION_POLICY
    )
    if (invalidReason) throw new Error(invalidReason)
    const pending = readScheduledOccurrenceMutationJournal()
    if (pending.status !== 'none') {
      throw new Error(
        pending.status === 'blocked'
          ? pending.reason
          : 'Scheduled occurrence mutation recovery is pending.'
      )
    }

    const tasks = this.getScheduledTasks()
    const workflowRecords = readScheduledOccurrenceWorkflowRecordsStrict()
    if (!workflowRecords) {
      throw new Error('Scheduled occurrence workflow projection is not a canonical raw record set.')
    }
    const taskState = occurrenceRecordState(
      tasks,
      intent.identity.taskId,
      intent.taskBefore,
      intent.taskAfter
    )
    const workflowState = occurrenceRecordState(
      workflowRecords.raw,
      intent.identity.workflowId,
      intent.workflowBefore,
      intent.workflowAfter
    )
    const ownerReason = validateCurrentRunOwnerReferences(intent, tasks, workflowRecords.normalized)
    const ledgerState = this.scheduledOccurrenceLedgerState(intent)
    if (
      taskState.status !== 'before' ||
      workflowState.status !== 'before' ||
      ownerReason ||
      (intent.kind !== 'materialize' && ledgerState !== 'before') ||
      typeof ledgerState === 'object'
    ) {
      const reason =
        taskState.status === 'blocked'
          ? taskState.reason
          : workflowState.status === 'blocked'
            ? workflowState.reason
            : typeof ledgerState === 'object'
              ? ledgerState.blocked
              : ownerReason || 'Scheduled occurrence mutation compare-and-swap failed.'
      throw new Error(reason)
    }

    writeScheduledOccurrenceJsonStrict(scheduledOccurrenceMutationsPath, intent)
    maybeCrashScheduledOccurrenceMutation('after-intent')
    const applyError = this.applyScheduledOccurrenceMutationIntent(intent, true)
    if (applyError) throw new Error(applyError)
  }

  static replayScheduledOccurrenceMutations(): ScheduledOccurrenceMutationReplayResult {
    const journal = readScheduledOccurrenceMutationJournal()
    if (journal.status === 'none') return { status: 'none' }
    if (journal.status === 'blocked') return journal
    try {
      const applyError = this.applyScheduledOccurrenceMutationIntent(journal.intent, false)
      if (applyError) return { status: 'blocked', reason: applyError }
      return {
        status: 'replayed',
        mutationId: journal.intent.id,
        kind: journal.intent.kind,
        taskId: journal.intent.identity.taskId
      }
    } catch (error) {
      return {
        status: 'blocked',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  static getNextWorkflowRunAtMs(): number | null {
    let next: number | null = null
    for (const workflow of this.getWorkflowDefinitions()) {
      if (!workflow.enabled || !workflow.nextRunAt) continue
      try {
        this.assertHistoryMutationAllowed({
          operation: 'Workflow scheduling',
          chatIds: [workflow.template.chatId],
          workspaceIds: [workflow.workspaceId, workflow.template.workspaceId]
        })
      } catch (error) {
        if (error instanceof HistoryDeletionMutationBlockedError) continue
        throw error
      }
      const runAtMs = new Date(workflow.nextRunAt).getTime()
      if (!Number.isFinite(runAtMs)) continue
      if (next === null || runAtMs < next) next = runAtMs
    }
    return next
  }

  static materializeDueWorkflows(
    nowMs: number = Date.now(),
    resolveAttachments: ResolveScheduledAttachments = rejectUnconfiguredScheduledAttachmentResolution
  ): ScheduledTask[] {
    assertNoPendingScheduledOccurrenceMutation()
    const workflows = this.getWorkflowDefinitions()
    const materialized: ScheduledTask[] = []
    let changed = false
    for (const workflow of workflows) {
      if (!workflow.enabled || !workflow.nextRunAt) continue
      try {
        this.assertHistoryMutationAllowed({
          operation: 'Workflow occurrence materialization',
          chatIds: [workflow.template.chatId],
          workspaceIds: [workflow.workspaceId, workflow.template.workspaceId]
        })
      } catch (error) {
        if (error instanceof HistoryDeletionMutationBlockedError) continue
        throw error
      }
      const nextRunAtMs = new Date(workflow.nextRunAt).getTime()
      if (!Number.isFinite(nextRunAtMs) || nextRunAtMs > nowMs) continue
      const before = JSON.stringify(workflow)
      const task = this.materializeWorkflowTask(
        workflow,
        workflow.nextRunAt,
        nowMs,
        false,
        resolveAttachments
      )
      if (task) {
        materialized.push(task)
      }
      if (!task && JSON.stringify(workflow) !== before) changed = true
    }
    if (changed) writeJson(workflowsPath, workflows)
    return materialized
  }

  static materializeWorkflowNow(
    id: string,
    nowMs: number = Date.now(),
    resolveAttachments: ResolveScheduledAttachments = rejectUnconfiguredScheduledAttachmentResolution
  ): ScheduledTask | null {
    assertNoPendingScheduledOccurrenceMutation()
    const workflows = this.getWorkflowDefinitions()
    const workflow = workflows.find((item) => item.id === id)
    if (!workflow) return null
    this.assertHistoryMutationAllowed({
      operation: 'Manual workflow occurrence materialization',
      chatIds: [workflow.template.chatId],
      workspaceIds: [workflow.workspaceId, workflow.template.workspaceId]
    })
    const before = JSON.stringify(workflow)
    const task = this.materializeWorkflowTask(
      workflow,
      new Date(nowMs).toISOString(),
      nowMs,
      true,
      resolveAttachments
    )
    if (!task && JSON.stringify(workflow) !== before) writeJson(workflowsPath, workflows)
    return task
  }

  private static materializeWorkflowTask(
    workflow: WorkflowDefinition,
    plannedFor: string,
    nowMs: number,
    manual: boolean,
    resolveAttachments: ResolveScheduledAttachments
  ): ScheduledTask | null {
    const nowIso = new Date(nowMs).toISOString()
    const invalidReason = this.workflowDefinitionInvalidReason(workflow)
    if (invalidReason) {
      return this.failWorkflowMaterialization(workflow, plannedFor, nowIso, invalidReason)
    }
    const imageAttachments = resolveScheduledAttachmentRefs(
      workflow.template.imageAttachments,
      {
        source: 'workflow-template',
        recordId: workflow.id,
        appChatId: workflow.template.chatId,
        workspaceId: workflow.workspaceId,
        workspacePath: workflow.workspacePath,
        externalPathGrants: workflow.template.externalPathGrants
      },
      resolveAttachments
    )
    if (!imageAttachments) {
      return this.failWorkflowMaterialization(
        workflow,
        plannedFor,
        nowIso,
        SCHEDULED_ATTACHMENT_RESELECT_REASON
      )
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

    const canonicalWorkflow = canonicalizeScheduledOccurrenceWorkflowSource(workflow)
    if (!canonicalWorkflow) {
      throw new Error(
        'Scheduled occurrence workflow source could not be canonicalized before materialization.'
      )
    }
    const workflowBefore = cloneJsonValue(canonicalWorkflow)
    const executionId = randomUUID()
    const task: ScheduledTask = {
      ...workflow.template,
      imageAttachments,
      // No `[workflow: …]` text prefix — workflows are identified by the
      // Workflows sidebar section + glyph, not a baked-in title/transcript
      // string (the prefix used to leak into the chat title everywhere).
      displayPrompt: workflow.template.displayPrompt || workflow.template.prompt,
      runAt: nowIso,
      timezone:
        workflow.trigger.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      id: randomUUID(),
      status: 'due',
      createdAt: nowIso,
      updatedAt: nowIso,
      workflowId: workflow.id,
      workflowExecutionId: executionId,
      workflowOccurrenceAt: plannedFor
    }
    task.workflowMode = normalizeChatWorkflowMode(task.workflowMode)
    task.dispatchReceipt = buildScheduledTaskDispatchReceipt(task, nowIso)
    const execution: WorkflowExecutionRecord = {
      id: executionId,
      workflowId: workflow.id,
      scheduledTaskId: task.id,
      plannedFor,
      status: 'queued',
      createdAt: nowIso,
      updatedAt: nowIso
    }
    const workflowAfter: WorkflowDefinition = {
      ...workflowBefore,
      history: [...workflowBefore.history, execution].slice(-WORKFLOW_HISTORY_LIMIT),
      activeExecutionId: executionId,
      lastRunAt: nowIso,
      lastStatus: 'queued',
      lastError: undefined,
      nextRunAt: resolveNextWorkflowRunAt(workflowBefore.trigger, nowMs, nowMs),
      updatedAt: nowIso
    }
    if (manual && workflowAfter.trigger.kind === 'manual') workflowAfter.nextRunAt = undefined
    this.commitScheduledOccurrenceMutation({
      schemaVersion: 1,
      id: randomUUID(),
      kind: 'materialize',
      createdAt: nowIso,
      identity: {
        taskId: task.id,
        workflowId: workflow.id,
        executionId,
        plannedFor
      },
      taskBefore: null,
      taskAfter: cloneJsonValue(task),
      workflowBefore,
      workflowAfter,
      ledgerBefore: null,
      ledgerAfter: null
    })
    Object.assign(workflow, cloneJsonValue(workflowAfter))
    workflow.lastError = workflowAfter.lastError
    workflow.nextRunAt = workflowAfter.nextRunAt
    return task
  }

  private static failWorkflowMaterialization(
    workflow: WorkflowDefinition,
    plannedFor: string,
    nowIso: string,
    reason: string
  ): null {
    const execution: WorkflowExecutionRecord = {
      id: randomUUID(),
      workflowId: workflow.id,
      plannedFor,
      status: 'failed',
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: nowIso,
      error: reason
    }
    workflow.history = [...workflow.history, execution].slice(-WORKFLOW_HISTORY_LIMIT)
    workflow.activeExecutionId = undefined
    workflow.lastStatus = 'failed'
    workflow.lastError = reason
    workflow.failureStreak += 1
    workflow.enabled = false
    workflow.nextRunAt = undefined
    workflow.updatedAt = nowIso
    return null
  }

  static syncWorkflowFromScheduledTask(task: ScheduledTask): WorkflowDefinition | null {
    assertNoPendingScheduledOccurrenceMutation()
    if (!task.workflowId || !task.workflowExecutionId) return null
    const persistedTasks = this.getScheduledTasks().filter((item) => item.id === task.id)
    if (persistedTasks.length !== 1 || !sameJsonValue(persistedTasks[0], task)) return null
    const workflows = this.getWorkflowDefinitions()
    const index = workflows.findIndex((workflow) => workflow.id === task.workflowId)
    if (index < 0) return null
    const workflow = workflows[index]
    const nowIso = new Date().toISOString()
    const projection = projectWorkflowFromScheduledTask(workflow, task, nowIso)
    if (!projection) return workflow
    // Lifecycle projection changes must enter through the occurrence journal.
    // This legacy compatibility surface may confirm an already-aligned record,
    // but it must never repair one side by writing only the workflow projection.
    return null
  }

  // Scheduled tasks
  static recordScheduledRunIdTombstone(input: {
    runId: string
    rootRunId: string
    taskId: string
    kind: ScheduledRunIdTombstoneKind
  }): void {
    const record = normalizedScheduledRunIdTombstone({
      schemaVersion: 1,
      sequence: 1,
      ...input,
      recordedAt: new Date().toISOString(),
      prevHash: null,
      hash: '0'.repeat(64)
    })
    if (
      !record ||
      (record.kind === 'root' && record.runId !== record.rootRunId) ||
      (record.kind !== 'root' && record.runId === record.rootRunId)
    ) {
      throw new Error('Scheduled run-id tombstone identity is invalid.')
    }
    appendScheduledRunIdTombstone(record)
  }

  static hasScheduledRunIdTombstone(runId: string): boolean {
    if (
      typeof runId !== 'string' ||
      !runId ||
      runId !== runId.trim() ||
      runId.length > SCHEDULED_RUN_ID_TOMBSTONE_MAX_ID_CHARS
    ) {
      return false
    }
    return readScheduledRunIdTombstones().has(runId)
  }

  static validateScheduledRunIdTombstoneLedger(): void {
    readScheduledRunIdTombstones()
  }

  static getScheduledTasks(workspaceId?: string): ScheduledTask[] {
    const tasks = readJson<ScheduledTask[]>(scheduledTasksPath, [])
    return tasks
      .filter((task) => !workspaceId || task.workspaceId === workspaceId)
      .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime())
  }

  /** Scheduler-only view. UI/history queries keep seeing paused records, while
   * a prepared deletion removes affected occurrences from timer admission. */
  static getDispatchableScheduledTasks(workspaceId?: string): ScheduledTask[] {
    return this.getScheduledTasks(workspaceId).filter((task) => {
      try {
        this.assertHistoryMutationAllowed({
          operation: 'Scheduled task timer admission',
          chatIds: [task.chatId],
          workspaceIds: [task.workspaceId],
          runIds: [task.runId, task.handoffSourceRunId]
        })
        return true
      } catch (error) {
        if (error instanceof HistoryDeletionMutationBlockedError) return false
        throw error
      }
    })
  }

  static saveScheduledTask(
    task: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'> &
      Partial<Pick<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status'>>
  ): ScheduledTask {
    assertNoPendingScheduledOccurrenceMutation()
    this.assertHistoryMutationAllowed({
      operation: 'Scheduled task creation',
      chatIds: [task.chatId],
      workspaceIds: [task.workspaceId],
      runIds: [task.handoffSourceRunId]
    })
    const tasks = this.getScheduledTasks()
    if (task.id && tasks.some((item) => item.id === task.id)) {
      throw new Error('Scheduled task already exists. Use the lifecycle update APIs.')
    }
    const inputFields = Object.keys(task) as Array<keyof ScheduledTask>
    if (inputFields.some((field) => SCHEDULED_TASK_CREATE_PROHIBITED_FIELDS.has(field))) {
      throw new Error(
        'Scheduled task creation cannot pre-own workflow linkage, run identity, lifecycle state, or an occurrence seal.'
      )
    }
    if (!scheduledAttachmentsAreDurable(task.imageAttachments)) {
      throw new Error(SCHEDULED_ATTACHMENT_RESELECT_REASON)
    }
    const now = new Date().toISOString()
    const record: ScheduledTask = {
      ...task,
      id: task.id || randomUUID(),
      status: task.status || 'pending',
      createdAt: task.createdAt || now,
      updatedAt: now
    }
    record.workflowMode = normalizeChatWorkflowMode(record.workflowMode)
    record.dispatchReceipt = task.dispatchReceipt || buildScheduledTaskDispatchReceipt(record)
    tasks.push(record)
    writeJson(scheduledTasksPath, tasks)
    return record
  }

  static updateScheduledTask(id: string, partial: Partial<ScheduledTask>): ScheduledTask | null {
    assertNoPendingScheduledOccurrenceMutation()
    const tasks = this.getScheduledTasks()
    const index = tasks.findIndex((task) => task.id === id)
    if (index < 0) return null
    const current = tasks[index]
    const terminalOnly =
      partial.status === 'completed' ||
      partial.status === 'failed' ||
      partial.status === 'cancelled'
    if (!terminalOnly) {
      this.assertHistoryMutationAllowed({
        operation: 'Scheduled task mutation',
        chatIds: [current.chatId],
        workspaceIds: [current.workspaceId],
        runIds: [current.runId, current.handoffSourceRunId]
      })
    }
    const partialFields = Object.keys(partial) as Array<keyof ScheduledTask>
    if (!partial.status && partialFields.length === 0) return current
    if (
      !partial.status &&
      partialFields.some((field) => !SCHEDULED_TASK_MAINTENANCE_FIELDS.has(field))
    ) {
      return current
    }
    if (
      Object.prototype.hasOwnProperty.call(partial, 'imageAttachments') &&
      !scheduledAttachmentsAreDurable(partial.imageAttachments)
    ) {
      throw new Error(SCHEDULED_ATTACHMENT_RESELECT_REASON)
    }
    if (partial.status && isInvalidScheduledTaskStatusTransition(current.status, partial.status)) {
      return current
    }
    // Run ownership is established exclusively by claimDueScheduledTaskForRun.
    // A task-id-only caller can neither establish nor infer that owner. In
    // particular, renderer/status callbacks must use settleScheduledTaskForRun
    // with the exact run + occurrence tuple instead of borrowing the persisted
    // owner from a stale task id.
    if (partial.status === 'running' && current.status !== 'running') return current
    if (Object.prototype.hasOwnProperty.call(partial, 'runId') && partial.runId !== current.runId) {
      return current
    }
    const exactTerminalFields = new Set(['status', 'runId', 'completedAt', 'lastError'])
    const hasOnlyExactTerminalFields = Object.keys(partial).every((field) =>
      exactTerminalFields.has(field)
    )
    const hasWorkflowLink = Boolean(
      current.workflowId || current.workflowExecutionId || current.workflowOccurrenceAt
    )
    if (
      partial.status &&
      isTerminalScheduledTaskStatus(partial.status) &&
      current.status === 'running'
    ) {
      return current
    }
    if (
      (partial.status === 'failed' || partial.status === 'cancelled') &&
      (current.status === 'due' || current.status === 'pending') &&
      current.runId === undefined &&
      hasOnlyExactTerminalFields
    ) {
      const terminalOptions = {
        status: partial.status,
        completedAt: partial.completedAt,
        lastError: partial.lastError
      }
      if (hasWorkflowLink) {
        if (!current.workflowId || !current.workflowExecutionId || !current.workflowOccurrenceAt) {
          return current
        }
        return this.settleUnownedScheduledWorkflowTask(id, terminalOptions)
      }
      return this.settleUnownedStandaloneScheduledTask(id, terminalOptions)
    }
    if (
      partial.status &&
      isTerminalScheduledTaskStatus(partial.status) &&
      (current.status === 'due' || current.status === 'pending')
    ) {
      return current
    }
    // Every workflow-linked status projection is paired with its workflow
    // execution through the occurrence journal. Unsupported lifecycle shapes
    // fail closed here rather than direct-writing one side of the pair.
    if (partial.status && hasWorkflowLink) return current
    const updated = { ...current, ...partial, id, updatedAt: new Date().toISOString() }
    if ('permissionPosture' in partial || 'runId' in partial || 'workflowMode' in partial) {
      updated.dispatchReceipt = buildScheduledTaskDispatchReceipt(updated)
    }
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
    if (!hasWorkflowLink) this.syncWorkflowFromScheduledTask(updated)
    return updated
  }

  /**
   * Synchronously claim one arrived scheduled occurrence for exactly one run.
   *
   * The in-process read/validate/write sequence is synchronous inside MAIN, so
   * a second caller observes `running` and loses the claim. Workflow tasks
   * additionally require the exact pre-materialized queued execution tuple;
   * standalone tasks deliberately omit it.
   */
  static claimDueScheduledTaskForRun(
    id: string,
    options: {
      nowMs?: number
      runId?: string
      expectedWorkflowOccurrence?: {
        workflowId: string
        executionId: string
        plannedFor: string
        taskId: string
      }
    } = {}
  ): ScheduledTask | null {
    const nowMs = options.nowMs ?? Date.now()
    const nowDate = new Date(nowMs)
    if (!Number.isFinite(nowMs) || !Number.isFinite(nowDate.getTime())) return null
    if (readScheduledOccurrenceMutationJournal().status !== 'none') return null

    const tasks = this.getScheduledTasks()
    const taskIndexes = tasks
      .map((task, index) => (task.id === id ? index : -1))
      .filter((index) => index >= 0)
    if (taskIndexes.length !== 1) return null
    const index = taskIndexes[0]
    const current = tasks[index]
    this.assertHistoryMutationAllowed({
      operation: 'Scheduled task claim',
      chatIds: [current.chatId],
      workspaceIds: [current.workspaceId],
      runIds: [current.runId, options.runId, current.handoffSourceRunId]
    })
    const runAtMs =
      typeof current.runAt === 'string' && current.runAt.trim()
        ? Date.parse(current.runAt)
        : Number.NaN
    if (
      current.status !== 'due' ||
      current.runId !== undefined ||
      !Number.isFinite(runAtMs) ||
      runAtMs > nowMs
    ) {
      return null
    }

    const expected = options.expectedWorkflowOccurrence
    const workflows = this.getWorkflowDefinitions()
    let linkedWorkflow: WorkflowDefinition | null = null
    const hasWorkflowLink = Boolean(
      current.workflowId || current.workflowExecutionId || current.workflowOccurrenceAt
    )
    if (hasWorkflowLink) {
      if (
        !expected ||
        current.workflowId !== expected.workflowId ||
        current.workflowExecutionId !== expected.executionId ||
        current.workflowOccurrenceAt !== expected.plannedFor ||
        current.id !== expected.taskId
      ) {
        return null
      }
      const workflowMatches = workflows.filter((workflow) => workflow.id === expected.workflowId)
      if (workflowMatches.length !== 1) return null
      const workflow = workflowMatches[0]
      const executionMatches = workflow.history.filter((item) => item.id === expected.executionId)
      if (executionMatches.length !== 1) return null
      const execution = executionMatches[0]
      if (
        workflow.activeExecutionId !== expected.executionId ||
        execution.workflowId !== expected.workflowId ||
        execution.scheduledTaskId !== expected.taskId ||
        execution.plannedFor !== expected.plannedFor ||
        execution.status !== 'queued' ||
        execution.runId !== undefined
      ) {
        return null
      }
      linkedWorkflow = workflow
    } else if (expected) {
      return null
    }

    const occupiedRunIds = new Set<string>()
    for (const task of tasks) {
      if (task.runId) occupiedRunIds.add(task.runId)
    }
    for (const workflow of workflows) {
      for (const execution of workflow.history) {
        if (execution.runId) occupiedRunIds.add(execution.runId)
      }
    }

    let runId = options.runId
    if (runId !== undefined) {
      if (
        typeof runId !== 'string' ||
        !runId ||
        runId.trim() !== runId ||
        occupiedRunIds.has(runId)
      ) {
        return null
      }
    } else {
      do {
        runId = randomUUID()
      } while (occupiedRunIds.has(runId))
    }
    const claimedRunId = runId
    if (!claimedRunId) return null

    const nowIso = nowDate.toISOString()
    const updated: ScheduledTask = {
      ...current,
      status: 'running',
      runId: claimedRunId,
      firedAt: nowIso,
      runningSince: nowIso,
      updatedAt: nowIso
    }
    updated.dispatchReceipt = buildScheduledTaskDispatchReceipt(updated, nowIso)
    if (linkedWorkflow && expected) {
      const canonicalWorkflow = canonicalizeScheduledOccurrenceWorkflowSource(linkedWorkflow)
      if (!canonicalWorkflow) return null
      linkedWorkflow = canonicalWorkflow
      const projection = projectWorkflowFromScheduledTask(linkedWorkflow, updated, nowIso)
      if (!projection || projection.nextStatus !== 'running') return null
      const { ledgerBefore, ledgerAfter } = this.createScheduledOccurrenceLedgerTransition(
        updated,
        nowIso
      )
      this.commitScheduledOccurrenceMutation({
        schemaVersion: 1,
        id: randomUUID(),
        kind: 'claim',
        createdAt: nowIso,
        identity: {
          taskId: expected.taskId,
          workflowId: expected.workflowId,
          executionId: expected.executionId,
          plannedFor: expected.plannedFor,
          runId: claimedRunId
        },
        taskBefore: cloneJsonValue(current),
        taskAfter: cloneJsonValue(updated),
        workflowBefore: cloneJsonValue(linkedWorkflow),
        workflowAfter: projection.workflow,
        ledgerBefore,
        ledgerAfter
      })
    } else {
      tasks[index] = updated
      writeJson(scheduledTasksPath, tasks)
    }
    return updated
  }

  /**
   * Refresh the stall backstop for exactly one already-established run owner.
   * This is task-only liveness state, not a workflow lifecycle transition, so
   * it does not enter the occurrence WAL; the exact task/execution owner CAS is
   * nevertheless required before the heartbeat can advance.
   */
  static heartbeatScheduledTaskForRun(
    id: string,
    options: {
      runId: string
      at?: string
      expectedWorkflowOccurrence?: {
        workflowId: string
        executionId: string
        plannedFor: string
        taskId: string
      }
    }
  ): ScheduledTask | null {
    if (!isNonEmptyTrimmedString(options.runId)) return null
    if (readScheduledOccurrenceMutationJournal().status !== 'none') return null
    const heartbeatAt = options.at || new Date().toISOString()
    const heartbeatMs = canonicalIsoTimestampMs(heartbeatAt)
    if (heartbeatMs === null || heartbeatMs > Date.now()) return null

    const tasks = this.getScheduledTasks()
    const indexes = tasks
      .map((task, index) => (task.id === id ? index : -1))
      .filter((index) => index >= 0)
    if (indexes.length !== 1) return null
    const index = indexes[0]
    const current = tasks[index]
    const firedAtMs = canonicalIsoTimestampMs(current.firedAt)
    const priorHeartbeatMs = canonicalIsoTimestampMs(current.runningSince)
    const updatedAtMs = canonicalIsoTimestampMs(current.updatedAt)
    if (
      current.status !== 'running' ||
      current.runId !== options.runId ||
      firedAtMs === null ||
      priorHeartbeatMs === null ||
      updatedAtMs === null ||
      heartbeatMs < firedAtMs ||
      heartbeatMs < priorHeartbeatMs ||
      heartbeatMs < updatedAtMs ||
      tasks.filter((task) => task.runId === options.runId).length !== 1
    ) {
      return null
    }

    const expected = options.expectedWorkflowOccurrence
    const hasWorkflowLink = Boolean(
      current.workflowId || current.workflowExecutionId || current.workflowOccurrenceAt
    )
    const workflows = this.getWorkflowDefinitions()
    if (hasWorkflowLink) {
      if (
        !expected ||
        expected.taskId !== current.id ||
        expected.workflowId !== current.workflowId ||
        expected.executionId !== current.workflowExecutionId ||
        expected.plannedFor !== current.workflowOccurrenceAt
      ) {
        return null
      }
      const pair = validateScheduledTaskWorkflowPair(current, workflows, tasks)
      if (
        !pair.ok ||
        !pair.execution ||
        pair.execution.status !== 'running' ||
        pair.execution.runId !== options.runId
      ) {
        return null
      }
    } else {
      if (expected) return null
      if (
        workflows.some((workflow) =>
          workflow.history.some((execution) => execution.runId === options.runId)
        )
      ) {
        return null
      }
    }

    if (current.runningSince === heartbeatAt && current.updatedAt === heartbeatAt) return current
    const updated: ScheduledTask = {
      ...current,
      runningSince: heartbeatAt,
      updatedAt: heartbeatAt
    }
    tasks[index] = updated
    writeJson(scheduledTasksPath, tasks)
    return updated
  }

  private static settleUnownedScheduledWorkflowTask(
    id: string,
    options: {
      status: ScheduledOccurrenceTerminalStatus
      completedAt?: string
      lastError?: string
    }
  ): ScheduledTask | null {
    return this.settleUnownedScheduledWorkflowTaskForProjection(id, options, 'queued')
  }

  private static recoverLegacyOwnerlessRunningScheduledWorkflowTask(
    id: string,
    options: {
      status: ScheduledOccurrenceTerminalStatus
      completedAt?: string
      lastError?: string
    }
  ): ScheduledTask | null {
    return this.settleUnownedScheduledWorkflowTaskForProjection(id, options, 'running')
  }

  private static settleUnownedScheduledWorkflowTaskForProjection(
    id: string,
    options: {
      status: ScheduledOccurrenceTerminalStatus
      completedAt?: string
      lastError?: string
    },
    expectedProjection: 'queued' | 'running'
  ): ScheduledTask | null {
    if (readScheduledOccurrenceMutationJournal().status !== 'none') return null
    const mutationAt = new Date().toISOString()
    const completedAt = options.completedAt || mutationAt
    if (!Number.isFinite(Date.parse(completedAt))) return null
    const tasks = this.getScheduledTasks()
    const taskIndexes = tasks
      .map((task, index) => (task.id === id ? index : -1))
      .filter((index) => index >= 0)
    if (taskIndexes.length !== 1) return null
    const current = tasks[taskIndexes[0]]
    const queuedTerminal =
      (current.status === 'due' || current.status === 'pending') &&
      (options.status === 'failed' || options.status === 'cancelled')
    const legacyRunningTerminal = expectedProjection === 'running' && current.status === 'running'
    if (
      (expectedProjection === 'queued' ? !queuedTerminal : !legacyRunningTerminal) ||
      current.runId !== undefined ||
      !current.workflowId ||
      !current.workflowExecutionId ||
      !current.workflowOccurrenceAt
    ) {
      return null
    }

    const workflows = this.getWorkflowDefinitions()
    const workflowMatches = workflows.filter((workflow) => workflow.id === current.workflowId)
    if (workflowMatches.length !== 1) return null
    const workflow = workflowMatches[0]
    const executionMatches = workflow.history.filter(
      (execution) => execution.id === current.workflowExecutionId
    )
    if (executionMatches.length !== 1) return null
    const execution = executionMatches[0]
    const identity: ScheduledOccurrenceIdentity = {
      taskId: current.id,
      workflowId: current.workflowId,
      executionId: current.workflowExecutionId,
      plannedFor: current.workflowOccurrenceAt
    }
    if (
      !workflowExecutionMatchesIdentity(execution, identity) ||
      execution.status !== expectedProjection ||
      execution.runId !== undefined ||
      workflow.activeExecutionId !== execution.id ||
      (legacyRunningTerminal &&
        (canonicalIsoTimestampMs(current.firedAt) === null ||
          canonicalIsoTimestampMs(current.runningSince) === null ||
          execution.startedAt !== current.firedAt))
    ) {
      return null
    }

    const updated: ScheduledTask = {
      ...current,
      status: options.status,
      completedAt,
      ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
      updatedAt: mutationAt
    }
    const canonicalWorkflow = canonicalizeScheduledOccurrenceWorkflowSource(workflow)
    if (!canonicalWorkflow) return null
    const projection = projectWorkflowFromScheduledTask(canonicalWorkflow, updated, mutationAt)
    if (!projection || projection.nextStatus !== options.status) return null
    const { ledgerBefore, ledgerAfter } = this.createScheduledOccurrenceLedgerTransition(
      updated,
      mutationAt
    )
    this.commitScheduledOccurrenceMutation({
      schemaVersion: 1,
      id: randomUUID(),
      kind: 'settle',
      createdAt: mutationAt,
      identity,
      taskBefore: cloneJsonValue(current),
      taskAfter: cloneJsonValue(updated),
      workflowBefore: cloneJsonValue(canonicalWorkflow),
      workflowAfter: projection.workflow,
      ledgerBefore,
      ledgerAfter
    })
    return updated
  }

  private static settleUnownedStandaloneScheduledTask(
    id: string,
    options: {
      status: ScheduledOccurrenceTerminalStatus
      completedAt?: string
      lastError?: string
    }
  ): ScheduledTask | null {
    if (
      (options.status !== 'failed' && options.status !== 'cancelled') ||
      readScheduledOccurrenceMutationJournal().status !== 'none'
    ) {
      return null
    }
    const mutationAt = new Date().toISOString()
    const completedAt = options.completedAt || mutationAt
    if (canonicalIsoTimestampMs(completedAt) === null) return null
    const tasks = this.getScheduledTasks()
    const indexes = tasks
      .map((task, index) => (task.id === id ? index : -1))
      .filter((index) => index >= 0)
    if (indexes.length !== 1) return null
    const index = indexes[0]
    const current = tasks[index]
    if (
      (current.status !== 'due' && current.status !== 'pending') ||
      current.runId !== undefined ||
      current.workflowId !== undefined ||
      current.workflowExecutionId !== undefined ||
      current.workflowOccurrenceAt !== undefined ||
      this.getWorkflowDefinitions().some((workflow) =>
        workflow.history.some((execution) => execution.scheduledTaskId === current.id)
      )
    ) {
      return null
    }
    const updated: ScheduledTask = {
      ...current,
      status: options.status,
      completedAt,
      ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
      updatedAt: mutationAt
    }
    tasks[index] = updated
    writeJson(scheduledTasksPath, tasks)
    return updated
  }

  private static recoverLegacyOwnerlessRunningStandaloneScheduledTask(
    id: string,
    options: {
      status: ScheduledOccurrenceTerminalStatus
      completedAt?: string
      lastError?: string
    }
  ): ScheduledTask | null {
    if (
      (options.status !== 'failed' && options.status !== 'cancelled') ||
      readScheduledOccurrenceMutationJournal().status !== 'none'
    ) {
      return null
    }
    const mutationAt = new Date().toISOString()
    const completedAt = options.completedAt || mutationAt
    if (canonicalIsoTimestampMs(completedAt) === null) return null
    const tasks = this.getScheduledTasks()
    const indexes = tasks
      .map((task, index) => (task.id === id ? index : -1))
      .filter((index) => index >= 0)
    if (indexes.length !== 1) return null
    const index = indexes[0]
    const current = tasks[index]
    if (
      current.status !== 'running' ||
      current.runId !== undefined ||
      canonicalIsoTimestampMs(current.firedAt) === null ||
      canonicalIsoTimestampMs(current.runningSince) === null ||
      current.workflowId !== undefined ||
      current.workflowExecutionId !== undefined ||
      current.workflowOccurrenceAt !== undefined ||
      this.getWorkflowDefinitions().some((workflow) =>
        workflow.history.some((execution) => execution.scheduledTaskId === current.id)
      )
    ) {
      return null
    }
    const updated: ScheduledTask = {
      ...current,
      status: options.status,
      completedAt,
      ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
      updatedAt: mutationAt
    }
    tasks[index] = updated
    writeJson(scheduledTasksPath, tasks)
    return updated
  }

  /**
   * Settle a running occurrence only while the task, workflow execution, and
   * caller all name the same immutable run owner. The paired post-images are
   * journaled before either projection is replaced.
   */
  static settleScheduledTaskForRun(
    id: string,
    options: {
      runId: string
      status: ScheduledOccurrenceTerminalStatus
      completedAt?: string
      lastError?: string
      expectedWorkflowOccurrence?: {
        workflowId: string
        executionId: string
        plannedFor: string
        taskId: string
      }
    }
  ): ScheduledTask | null {
    if (!isNonEmptyTrimmedString(options.runId) || !isTerminalScheduledTaskStatus(options.status)) {
      return null
    }
    if (readScheduledOccurrenceMutationJournal().status !== 'none') return null
    const completedAt = options.completedAt || new Date().toISOString()
    if (!Number.isFinite(Date.parse(completedAt))) return null
    const mutationAt = new Date().toISOString()

    const tasks = this.getScheduledTasks()
    const taskIndexes = tasks
      .map((task, index) => (task.id === id ? index : -1))
      .filter((index) => index >= 0)
    if (taskIndexes.length !== 1) return null
    const index = taskIndexes[0]
    const current = tasks[index]
    if (current.status !== 'running' || current.runId !== options.runId) return null

    const updated: ScheduledTask = {
      ...current,
      status: options.status,
      completedAt,
      ...(options.lastError !== undefined ? { lastError: options.lastError } : {}),
      updatedAt: mutationAt
    }
    const expected = options.expectedWorkflowOccurrence
    const hasWorkflowLink = Boolean(
      current.workflowId || current.workflowExecutionId || current.workflowOccurrenceAt
    )
    const workflows = this.getWorkflowDefinitions()
    if (!hasWorkflowLink) {
      if (expected) return null
      const taskOwners = tasks.filter((task) => task.runId === options.runId)
      const workflowOwners = workflows.flatMap((workflow) =>
        workflow.history.filter((execution) => execution.runId === options.runId)
      )
      if (taskOwners.length !== 1 || workflowOwners.length !== 0) return null
      tasks[index] = updated
      writeJson(scheduledTasksPath, tasks)
      return updated
    }
    if (
      !expected ||
      expected.taskId !== current.id ||
      expected.workflowId !== current.workflowId ||
      expected.executionId !== current.workflowExecutionId ||
      expected.plannedFor !== current.workflowOccurrenceAt
    ) {
      return null
    }

    const workflowMatches = workflows.filter((workflow) => workflow.id === expected.workflowId)
    if (workflowMatches.length !== 1) return null
    const workflow = workflowMatches[0]
    const executionMatches = workflow.history.filter(
      (execution) => execution.id === expected.executionId
    )
    if (executionMatches.length !== 1) return null
    const execution = executionMatches[0]
    if (
      !workflowExecutionMatchesIdentity(execution, {
        ...expected,
        runId: options.runId
      }) ||
      execution.status !== 'running' ||
      execution.runId !== options.runId
    ) {
      return null
    }
    const canonicalWorkflow = canonicalizeScheduledOccurrenceWorkflowSource(workflow)
    if (!canonicalWorkflow) return null
    const projection = projectWorkflowFromScheduledTask(canonicalWorkflow, updated, mutationAt)
    if (!projection || !isTerminalWorkflowExecutionStatus(projection.nextStatus)) return null
    const { ledgerBefore, ledgerAfter } = this.createScheduledOccurrenceLedgerTransition(
      updated,
      mutationAt
    )
    const intent: ScheduledOccurrenceMutationIntent = {
      schemaVersion: 1,
      id: randomUUID(),
      kind: 'settle',
      createdAt: mutationAt,
      identity: {
        taskId: expected.taskId,
        workflowId: expected.workflowId,
        executionId: expected.executionId,
        plannedFor: expected.plannedFor,
        runId: options.runId
      },
      taskBefore: cloneJsonValue(current),
      taskAfter: cloneJsonValue(updated),
      workflowBefore: cloneJsonValue(canonicalWorkflow),
      workflowAfter: projection.workflow,
      ledgerBefore,
      ledgerAfter
    }
    if (validateCurrentRunOwnerReferences(intent, tasks, workflows)) return null
    this.commitScheduledOccurrenceMutation(intent)
    return updated
  }

  static deleteScheduledTask(id: string) {
    assertNoPendingScheduledOccurrenceMutation()
    const matches = this.getScheduledTasks().filter((task) => task.id === id)
    if (matches.length === 0) return
    if (matches.length !== 1) {
      throw new Error('Scheduled task deletion is ambiguous.')
    }
    let current = matches[0]
    const hasWorkflowLink = Boolean(
      current.workflowId || current.workflowExecutionId || current.workflowOccurrenceAt
    )
    if (
      current.status === 'running' ||
      (!isTerminalScheduledTaskStatus(current.status) && current.runId !== undefined)
    ) {
      throw new Error(
        'Scheduled task could not be deleted while its occurrence is live; its exact run owner must settle it first.'
      )
    }
    if (hasWorkflowLink) {
      const pair = validateScheduledTaskWorkflowPair(
        current,
        this.getWorkflowDefinitions(),
        this.getScheduledTasks()
      )
      if (!pair.ok) {
        throw new Error(
          `Workflow-linked scheduled task could not be terminalized before deletion: ${pair.reason}`
        )
      }
    }
    if (hasWorkflowLink && !isTerminalScheduledTaskStatus(current.status)) {
      const terminalized = this.settleUnownedScheduledWorkflowTask(id, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        lastError: 'Scheduled task deleted.'
      })
      if (!terminalized || !isTerminalScheduledTaskStatus(terminalized.status)) {
        throw new Error('Workflow-linked scheduled task could not be terminalized before deletion.')
      }
      current = terminalized
    } else if (!hasWorkflowLink && !isTerminalScheduledTaskStatus(current.status)) {
      const terminalized = this.settleUnownedStandaloneScheduledTask(id, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        lastError: 'Scheduled task deleted.'
      })
      if (!terminalized || !isTerminalScheduledTaskStatus(terminalized.status)) {
        throw new Error('Scheduled task could not be terminalized before deletion.')
      }
      current = terminalized
    }
    if (hasWorkflowLink) {
      const terminalPair = validateScheduledTaskWorkflowPair(
        current,
        this.getWorkflowDefinitions(),
        this.getScheduledTasks()
      )
      if (!isTerminalScheduledTaskStatus(current.status) || !terminalPair.ok) {
        throw new Error(
          `Workflow-linked scheduled task deletion requires an exact terminal occurrence${terminalPair.ok ? '.' : `: ${terminalPair.reason}`}`
        )
      }
    }
    writeJson(
      scheduledTasksPath,
      this.getScheduledTasks().filter((task) => task.id !== id)
    )
  }

  static getDueScheduledTasks(
    nowMs: number = Date.now(),
    resolveAttachments: ResolveScheduledAttachments = rejectUnconfiguredScheduledAttachmentResolution
  ): ScheduledTask[] {
    assertNoPendingScheduledOccurrenceMutation()
    const due: ScheduledTask[] = []
    for (const task of this.getScheduledTasks()) {
      try {
        this.assertHistoryMutationAllowed({
          operation: 'Scheduled task dispatch',
          chatIds: [task.chatId],
          workspaceIds: [task.workspaceId],
          runIds: [task.runId, task.handoffSourceRunId]
        })
      } catch (error) {
        if (error instanceof HistoryDeletionMutationBlockedError) continue
        throw error
      }
      const runAtMs = typeof task.runAt === 'string' ? Date.parse(task.runAt) : Number.NaN
      const eligible =
        (task.status === 'due' || task.status === 'pending') &&
        Number.isFinite(runAtMs) &&
        runAtMs <= nowMs
      if (!eligible) continue
      const imageAttachments = resolveScheduledAttachmentRefs(
        task.imageAttachments,
        {
          source: 'scheduled-task',
          recordId: task.id,
          appChatId: task.chatId,
          workspaceId: task.workspaceId,
          workspacePath: task.workspacePath,
          externalPathGrants: task.externalPathGrants
        },
        resolveAttachments
      )
      if (!imageAttachments) {
        this.updateScheduledTask(task.id, {
          status: 'failed',
          completedAt: new Date(nowMs).toISOString(),
          lastError: SCHEDULED_ATTACHMENT_RESELECT_REASON
        })
        continue
      }
      if (JSON.stringify(imageAttachments) !== JSON.stringify(task.imageAttachments)) {
        const updated = this.updateScheduledTask(task.id, { imageAttachments })
        if (updated) due.push(updated)
      } else {
        due.push(task)
      }
    }
    return due
  }

  static recoverInterruptedScheduledTasksAfterStartup(nowMs: number = Date.now()): ScheduledTask[] {
    const recoveredAt = new Date(nowMs).toISOString()
    const recovered: ScheduledTask[] = []
    for (const snapshot of this.getScheduledTasks()) {
      if (snapshot.status !== 'running') continue
      const matches = this.getScheduledTasks().filter((task) => task.id === snapshot.id)
      if (matches.length !== 1 || matches[0].status !== 'running') continue
      const current = matches[0]
      const terminalOptions = {
        status: 'failed' as const,
        completedAt: current.completedAt || recoveredAt,
        lastError: current.lastError || 'TaskWraith restarted before this scheduled run completed.'
      }
      const hasWorkflowLink = Boolean(
        current.workflowId || current.workflowExecutionId || current.workflowOccurrenceAt
      )
      let updated: ScheduledTask | null = null
      if (isNonEmptyTrimmedString(current.runId)) {
        const expectedWorkflowOccurrence = hasWorkflowLink
          ? current.workflowId && current.workflowExecutionId && current.workflowOccurrenceAt
            ? {
                taskId: current.id,
                workflowId: current.workflowId,
                executionId: current.workflowExecutionId,
                plannedFor: current.workflowOccurrenceAt
              }
            : null
          : undefined
        if (expectedWorkflowOccurrence !== null) {
          updated = this.settleScheduledTaskForRun(current.id, {
            runId: current.runId,
            ...terminalOptions,
            expectedWorkflowOccurrence
          })
        }
      } else if (
        current.runId === undefined &&
        current.workflowId &&
        current.workflowExecutionId &&
        current.workflowOccurrenceAt
      ) {
        // Explicit migration-only recovery for the legacy shape that could mark
        // both projections running before durable run ownership was introduced.
        updated = this.recoverLegacyOwnerlessRunningScheduledWorkflowTask(
          current.id,
          terminalOptions
        )
      } else if (current.runId === undefined && !hasWorkflowLink) {
        updated = this.recoverLegacyOwnerlessRunningStandaloneScheduledTask(
          current.id,
          terminalOptions
        )
      }
      if (updated?.status === 'failed' && updated.completedAt) recovered.push(updated)
    }
    return recovered
  }

  /**
   * Universal BACKSTOP for wedged scheduled-workflow occurrences. A scheduled
   * workflow stamps `activeExecutionId` at materialize time and skips the next
   * occurrence while that execution is non-terminal; a stuck occurrence
   * ('due'/'running'/overdue 'pending') silently disables the workflow forever.
   * Settles any occurrence aged past `backstopMs` with no live run to 'failed'.
   * Running rows are re-read, rechecked for liveness, and settled only through
   * their exact run + occurrence owner API. Queued ownerless rows use the
   * isolated unowned recovery path. Returns only tasks actually settled this
   * call so the caller can de-dupe the loud event per real settle.
   */
  static settleStalledScheduledTasks(
    isRunLive: (runId: string) => boolean,
    nowMs: number = Date.now(),
    backstopMs: number = DEFAULT_STALL_BACKSTOP_MS
  ): ScheduledTask[] {
    const snapshots = this.getScheduledTasks()
    if (snapshots.length === 0) return []
    const completedAt = new Date(nowMs).toISOString()
    const settled: ScheduledTask[] = []
    for (const snapshot of snapshots) {
      try {
        const [candidate] = findStalledScheduledTasks([snapshot], isRunLive, nowMs, backstopMs)
        if (!candidate) continue
        const matches = this.getScheduledTasks().filter((task) => task.id === snapshot.id)
        if (matches.length !== 1) continue
        const [revalidated] = findStalledScheduledTasks([matches[0]], isRunLive, nowMs, backstopMs)
        if (!revalidated) continue
        const current = revalidated.task
        const terminalOptions = {
          status: 'failed' as const,
          completedAt,
          lastError: stallReason(current, revalidated.basis, revalidated.ageMs, backstopMs)
        }
        const hasWorkflowLink = Boolean(
          current.workflowId || current.workflowExecutionId || current.workflowOccurrenceAt
        )
        let updated: ScheduledTask | null = null
        if (current.status === 'running') {
          if (!isNonEmptyTrimmedString(current.runId) || isRunLive(current.runId)) continue
          const expectedWorkflowOccurrence = hasWorkflowLink
            ? current.workflowId && current.workflowExecutionId && current.workflowOccurrenceAt
              ? {
                  taskId: current.id,
                  workflowId: current.workflowId,
                  executionId: current.workflowExecutionId,
                  plannedFor: current.workflowOccurrenceAt
                }
              : null
            : undefined
          if (expectedWorkflowOccurrence === null) continue
          updated = this.settleScheduledTaskForRun(current.id, {
            runId: current.runId,
            ...terminalOptions,
            expectedWorkflowOccurrence
          })
        } else if (
          (current.status === 'due' || current.status === 'pending') &&
          current.runId === undefined
        ) {
          if (hasWorkflowLink) {
            if (
              !current.workflowId ||
              !current.workflowExecutionId ||
              !current.workflowOccurrenceAt
            ) {
              continue
            }
            updated = this.settleUnownedScheduledWorkflowTask(current.id, terminalOptions)
          } else {
            updated = this.settleUnownedStandaloneScheduledTask(current.id, terminalOptions)
          }
        }
        if (updated && updated.status === 'failed' && updated.completedAt === completedAt) {
          settled.push(updated)
        }
      } catch {
        // One malformed row or failed liveness probe must not starve later candidates.
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
    // Terminal transitions route through here as inserts (RunRepository
    // .transition → saveRunQueueJob), so a cancel/complete racer settling after
    // a history deletion committed would otherwise resurrect a job record for
    // the erased chat/run. Mirror saveChat's tombstone rule: refuse while the
    // erased chat file is still absent, but let a legitimately re-created chat
    // (import/restore) queue again.
    if (
      (typeof input.runId === 'string' && deletedRunIds.has(input.runId)) ||
      (typeof input.chatId === 'string' &&
        deletedChatIds.has(input.chatId) &&
        !fs.existsSync(chatPathForId(chatsDir, input.chatId)))
    ) {
      return createRunQueueJob(input, new Date().toISOString())
    }
    if (
      typeof input.status === 'string' &&
      ['queued', 'steer_promoting', 'starting', 'active'].includes(input.status)
    ) {
      this.assertHistoryMutationAllowed({
        operation: 'Run-queue enqueue or lease',
        chatIds: [input.chatId],
        workspaceIds: [input.workspaceId],
        runIds: [input.runId]
      })
    }
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
    if (['queued', 'steer_promoting', 'starting', 'active'].includes(updated.status)) {
      this.assertHistoryMutationAllowed({
        operation: 'Run-queue enqueue or lease',
        chatIds: [updated.chatId],
        workspaceIds: [updated.workspaceId],
        runIds: [updated.runId]
      })
    }
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
  static appendRunEvent(
    input: RunEventInput,
    options: { durability?: 'batched' | 'strict' } = {}
  ): RunEventRecord {
    if (deletedRunIds.has(input.runId)) {
      if (options.durability === 'strict') {
        throw new Error('Strict run-event append was rejected for deleted history.')
      }
      return createRunEventRecord(input, 1, { storeRawPayload: false })
    }
    // A prepared (fsynced) deletion intent freezes its run scope before the
    // store commit populates deletedRunIds. Refuse late appends for the frozen
    // scope with the same semantics as the post-commit tombstones above, so a
    // racer settling during quiescence cannot write bytes the run-events step
    // must then re-erase.
    const pendingIntent = readHistoryDeletionIntent()
    if (
      pendingIntent &&
      (pendingIntent.kind === 'global' ||
        pendingIntent.runIds.includes(input.runId) ||
        (typeof input.chatId === 'string' && pendingIntent.chatIds.includes(input.chatId)))
    ) {
      if (options.durability === 'strict') {
        throw new HistoryDeletionMutationBlockedError(
          pendingIntent.operationId,
          pendingIntent.kind,
          'Strict run-event append'
        )
      }
      return createRunEventRecord(input, 1, { storeRawPayload: false })
    }
    const filePath = runEventFilePath(input.runId)
    const cachedSequence = runEventSequenceCache.get(input.runId)
    const cachedHash = runEventHashCache.get(input.runId)
    // Seek the ledger's head rather than reading it: an append needs two
    // scalars, and these files reach a gigabyte. See RunEventLedgerHead.
    const ledgerHead =
      cachedSequence !== undefined && cachedHash !== undefined
        ? null
        : readRunEventLedgerHead(filePath)
    const sequence =
      cachedSequence !== undefined ? cachedSequence + 1 : (ledgerHead?.sequence ?? 0) + 1
    const previousHash = cachedHash || ledgerHead?.hash || RUN_EVENT_EMPTY_HASH
    const settings = this.getSettings()
    const artifacts = settings.storeRawEvents ? appendRunStreamArtifact(input, sequence) : undefined
    const record = createRunEventRecord(input, sequence, {
      storeRawPayload: settings.storeRawEvents,
      previousHash,
      artifacts
    })
    const directoryPath = path.dirname(filePath)
    const directoryExisted = fs.existsSync(directoryPath)
    const fileExisted = fs.existsSync(filePath)
    fs.mkdirSync(directoryPath, { recursive: true })
    if (options.durability === 'strict' && !directoryExisted) {
      fsyncDirectory(path.dirname(directoryPath))
    }
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeFileSync(fd, serializeRunEventRecord(record), 'utf-8')
      if (options.durability === 'strict' || input.kind === 'lifecycle' || sequence % 25 === 0) {
        fs.fsyncSync(fd)
      }
    } finally {
      fs.closeSync(fd)
    }
    if (options.durability === 'strict' && !fileExisted) {
      fsyncDirectory(directoryPath)
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
    assertNoPendingScheduledOccurrenceMutation()
    return this.appendWorkflowRunEventFromOccurrenceMutation(input)
  }

  private static appendWorkflowRunEventFromOccurrenceMutation(
    input: WorkflowRunEventInput
  ): WorkflowRunEvent {
    const inputStructureReason = workflowRunEventInputStructureReason(input)
    if (inputStructureReason) throw new Error(inputStructureReason)
    const filePath = workflowRunFilePath(input.workflowExecutionId)
    const existingEvents = readWorkflowRunLedgerForAppend(filePath, input)
    const sequence = nextWorkflowRunSequence(existingEvents)
    const event = createWorkflowRunEvent(input, sequence)
    const eventStructureReason = workflowRunEventStructureReason(
      event,
      existingEvents.length,
      existingEvents.at(-1)
    )
    if (eventStructureReason) throw new Error(eventStructureReason)
    const directoryPath = path.dirname(filePath)
    const directoryExisted = fs.existsSync(directoryPath)
    const fileExisted = fs.existsSync(filePath)
    fs.mkdirSync(directoryPath, { recursive: true })
    if (!directoryExisted) fsyncDirectory(path.dirname(directoryPath))
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeFileSync(fd, serializeWorkflowRunEvent(event), 'utf-8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (!fileExisted) fsyncDirectory(directoryPath)
    const verified = readWorkflowRunLedgerStrict(filePath)
    if (
      verified.hasTornTail ||
      !verified.events.some((candidate) => sameJsonValue(candidate, event))
    ) {
      throw new Error('Workflow run ledger append could not be verified durably.')
    }
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
  private static recordAgentRunDelta(
    agentId: string,
    chatId: string,
    run: ChatRun,
    messages: ChatRecord['messages']
  ): void {
    if (!isPooledAgentId(agentId) || typeof run.runId !== 'string' || !run.runId) return
    this.ensureAgentStatsLoaded(agentId)
    const seen = agentStatsSeenCache.get(agentId) as Set<string>
    if (seen.has(run.runId)) return
    const delta = buildAgentStatDelta(
      chatId,
      run,
      Date.now(),
      toolActivityStatsForRun(run.runId, messages)
    )
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
    const runs = Array.isArray(chat.runs) ? chat.runs : []
    const hasDirectAgentRuns = runs.some((run) => isPooledAgentId(run?.pooledAgentId))
    if (agentByParticipant.size === 0 && !hasDirectAgentRuns) return
    const chatId = chat.appChatId
    for (const run of runs) {
      const directAgentId = isPooledAgentId(run?.pooledAgentId)
        ? (run.pooledAgentId as string)
        : undefined
      const agentId =
        directAgentId ||
        (run?.ensembleParticipantId ? agentByParticipant.get(run.ensembleParticipantId) : undefined)
      if (agentId) this.recordAgentRunDelta(agentId, chatId, run, chat.messages)
    }
  }

  /**
   * saveChat hook — harvest assistant thumbs feedback into a bounded durable
   * receipt ledger. This records the attributed human signal behind the
   * renderer-only `message.metadata.feedback` pressed state. Scoped to THIS
   * chat save; never scans the chat corpus.
   */
  private static harvestMessageFeedbackReceipts(
    previousChat: ChatRecord | null,
    nextChat: ChatRecord
  ): void {
    const existingLedger = this.readMessageFeedbackLedger()
    const update = updateMessageFeedbackLedgerForChatSave(previousChat, nextChat, existingLedger, {
      now: () => Date.now(),
      idFactory: () => randomUUID()
    })
    if (!update.changed) return
    writeMessageFeedbackLedger(update.records)
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
   * settled through the occurrence journal are terminal → no-ops here. Returns
   * the executions actually settled.
   */
  static reconcileStaleWorkflowRunLedgers(nowMs: number = Date.now()): StaleLedgerExecution[] {
    assertNoPendingScheduledOccurrenceMutation()
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
        console.error(
          'Failed to settle stale workflow run ledger',
          execution.workflowExecutionId,
          e
        )
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
      paths === null
        ? readAllRunEventFiles(filter.kinds)
        : paths.flatMap((p) => readRunEventFile(p, filter.kinds))
    return filterRunEvents(events, filter)
  }

  /** Async twin of {@link getRunEvents}. The renderer's `get-run-events` IPC uses
   * THIS so that even a future filter with no runId/chatId (→ whole-dir read) yields
   * the event loop instead of beachballing the MAIN thread. Same result as the sync
   * version for the same filter. */
  static async getRunEventsAsync(filter: RunEventFilter = {}): Promise<RunEventRecord[]> {
    const paths = this.runEventFilePathsForFilter(filter)
    const events =
      paths === null
        ? await readAllRunEventFilesAsync(filter.kinds)
        : await readRunEventFilesAsync(paths, filter.kinds)
    return filterRunEvents(events, filter)
  }

  /** Exact byte-range hydration for virtualized transcript tool rows. */
  static getToolActivityDetails(
    refs: readonly ToolActivityDetailRef[]
  ): Promise<HydratedToolActivityDetail[]> {
    return hydrateToolActivityDetails(runArtifactsDir, refs)
  }

  static getRunEventReplay(runId: string) {
    return getRunEventReplayCachedSync(runId, runEventFilePath(runId), readRunEventFile)
  }

  /** Async cached twin used by the renderer's `get-run-event-replay` IPC so
   * N active run cards polling every 2s do not re-read and re-parse unchanged
   * run-event files on the main event loop. The cache is keyed by mtime+size,
   * matching the workspace-change cache precedent. */
  static async getRunEventReplayAsync(runId: string): Promise<RunEventReplay> {
    return getRunEventReplayCachedAsync(runId, runEventFilePath(runId), readRunEventFileAsync)
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
    // A renderer/phone response is valid only while the durable row is still
    // pending. Recovery above converts timed-out rows to `expired`; terminal or
    // already-resolved rows must never be rewritten into a fresh approval.
    if (index < 0 || records[index].status !== 'pending') return null
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
      appVersion: storeRuntime.appVersion || 'unknown',
      platform: process.platform,
      arch: process.arch
    })
    current.push(record)
    writeJson(productCrashesPath, filterProductCrashRecords(current, { limit: 200 }))
    return record
  }
}
