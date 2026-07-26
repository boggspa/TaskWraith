import { randomUUID } from 'crypto'
import { normalizeDiscordContextSelection } from '../channels/DiscordContextService'
import { buildRunQueueDispatchReceipt } from '../RunQueueDispatchReceipt'
import type { RunQueueJobInput } from '../RunQueue'
import type { RunSession } from '../RunManager'
import { MAX_DURABLE_ATTACHMENT_REFS } from '../ScheduledAttachmentDurability'
import type {
  AgenticServiceId,
  AgenticNetworkPolicy,
  AgenticServicePolicy,
  ChatWorkflowMode,
  ChatRecord,
  ChatScope,
  ExecutionGraphQueueBinding,
  ExternalPathGrant,
  PermissionPresetId,
  PersistedAttachmentRef,
  PersistedOrLegacyAttachmentRef,
  ProviderId,
  RunPermissionPostureSnapshot,
  RunQueueJob,
  RunQueueJobFilter,
  RunQueueJobSource,
  RunQueueJobStatus,
  RunQueueRequestSnapshot,
  WorkspaceRecord
} from '../store/types'
import { parseProjectReferenceContextSelection } from '../../shared/projectReferenceContext'
import { ANTIGRAVITY_PROVIDER_ID, isLiveSelectableProvider } from '../../shared/retiredProviders'
import { isAntigravityGeminiApiKeyConfigured } from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'
import { isPersistedAttachmentRef } from './TranscriptMediaAssetStore'

const RUN_QUEUE_STATUSES = new Set<RunQueueJobStatus>([
  'queued',
  'steer_promoting',
  'starting',
  'active',
  'paused',
  'cancelling',
  'cancelled',
  'failed',
  'completed'
])
const RUN_QUEUE_SOURCES = new Set<RunQueueJobSource>([
  'manual',
  'remote',
  'scheduled',
  'retry',
  'permission_retry',
  'review',
  'host_rerun',
  'system'
])
// Known ids for persisted queue decoding. New requests apply a narrower live
// admission check in `assertRunnableProviderId`.
const PROVIDER_IDS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
])
const PERMISSION_PRESET_IDS = new Set<PermissionPresetId>([
  'read_only',
  'plan',
  'default',
  'workspace_write',
  'full_access',
  'custom'
])
const AGENTIC_SERVICE_IDS = new Set<AgenticServiceId>([
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'canvasEval',
  'crossThreadRead',
  'threadMessage',
  'mediaEditing',
  'mediaRecording'
])
const AGENTIC_SERVICE_POLICIES = new Set<AgenticServicePolicy>([
  'ask',
  'workspace',
  'allow',
  'deny'
])

export interface RunQueueStore {
  getChat: (chatId: string) => ChatRecord | null
  getRunQueueJob: (runIdOrId: string) => RunQueueJob | null
  getRunQueueJobs: (filter?: RunQueueJobFilter) => RunQueueJob[]
}

export interface RunQueueRepository {
  getRunQueueJobs: (filter?: RunQueueJobFilter) => RunQueueJob[]
  saveRunQueueJob: (input: RunQueueJobInput) => RunQueueJob
  leaseQueuedRun: (input?: {
    runId?: string
    provider?: ProviderId
    statusReason?: string
  }) => RunQueueJob | null
  promoteQueuedJobForSteer: (input: {
    runId?: string
    jobId?: string
    ownerToken: string
    provider?: ProviderId
    chatId?: string
    statusReason?: string
    queueMessageId?: string
    transitionVersion?: number
  }) => RunQueueJob | null
  leasePromotedSteerJob: (input: {
    runId: string
    ownerToken: string
    statusReason?: string
  }) => RunQueueJob | null
  fallbackPromotedSteerJob: (input: {
    runId: string
    ownerToken: string
    reason: string
    fallbackStatus?: RunQueueJobStatus
  }) => RunQueueJob | null
  transitionRunQueueJob: (
    runIdOrId: string,
    status: RunQueueJobStatus,
    partial?: Pick<Partial<RunQueueJob>, 'statusReason' | 'lastError'>
  ) => RunQueueJob | null
  persistSessionQueueState: (session: RunSession | undefined) => void
}

export interface RunQueueServiceDeps {
  appStore: RunQueueStore
  getRunRepository: () => RunQueueRepository
  normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => ExternalPathGrant[]
  requireGlobalChat: (chatId: unknown, label?: string) => ChatRecord
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  findRegisteredWorkspace: (workspacePath: string) => WorkspaceRecord | undefined
  validateChatWorkspaceIdentity: (
    chatId: string | undefined,
    workspace: WorkspaceRecord | undefined
  ) => void
  /**
   * Fresh-request-only attachment staging. Implementations must snapshot the
   * authorized source through a nofollow descriptor, persist those exact bytes
   * in TaskWraith's main-owned content-addressed store, and return only the
   * resulting durable refs. This callback is deliberately never invoked while
   * reading/recovering persisted queue rows.
   */
  stageAttachments: (input: RunQueueAttachmentStageInput) => RunQueueAttachmentStageResult
  canLeaseJob: (job: RunQueueJob) => boolean
}

export interface RunQueueAttachmentStageInput {
  runId: string
  provider: ProviderId
  source: RunQueueJobSource
  chatId?: string
  workspaceId?: string
  workspacePath?: string
  externalPathGrants: ExternalPathGrant[]
  /** Canonical attachment paths authorized for the requesting renderer. */
  authorizedFilePaths?: string[]
  attachments: PersistedOrLegacyAttachmentRef[]
}

export interface RunQueuePrepareOptions {
  readonly authorizedFilePaths?: string[]
  /** Main-only graph correlation; never read from renderer input. */
  readonly executionGraph?: ExecutionGraphQueueBinding
}

export type RunQueueAttachmentStageResult =
  | { ok: true; attachments: PersistedAttachmentRef[] }
  | { ok: false; reason: string }

const DURABLE_ATTACHMENT_QUARANTINE_REASON =
  'Queued attachments could not be recovered safely. Re-select the attachments and send again.'

/**
 * RunQueueService — Phase B5 extraction.
 *
 * Preserves the current durable-run-queue IPC contract, including the
 * existing channel names (`request-run-queue-job`, not the older brief's
 * enqueue wording), while moving request normalization and lease policy
 * out of the main process handler block.
 */
export class RunQueueService {
  constructor(private deps: RunQueueServiceDeps) {}

  getJobs(filter?: RunQueueJobFilter): RunQueueJob[] {
    const jobs = this.deps
      .getRunRepository()
      .getRunQueueJobs(filter || {})
      .map((job) => this.quarantineUnsafePersistedAttachments(job))
    if (filter?.statuses?.length) {
      return jobs.filter((job) => filter.statuses?.includes(job.status))
    }
    if (filter?.includeTerminal === false) {
      return jobs.filter((job) => !isTerminalRunQueueStatus(job.status))
    }
    return jobs
  }

  requestJob(input: unknown, options: RunQueuePrepareOptions = {}): RunQueueJob {
    return this.deps.getRunRepository().saveRunQueueJob(this.prepareJob(input, options))
  }

  /**
   * Main-owned normalization without queue publication. Execution-graph
   * templates use this to snapshot the same validated request that an ordinary
   * queue job would receive, while leaving readiness to the graph coordinator.
   */
  prepareJob(
    input: unknown,
    options: RunQueuePrepareOptions = {}
  ): Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'> {
    return this.normalizeJobRequest(input, options.authorizedFilePaths, options.executionGraph)
  }

  leaseJob(
    request: { runId?: string; provider?: ProviderId; statusReason?: string } = {}
  ): RunQueueJob | null {
    const provider = request?.provider ? assertProviderId(request.provider) : undefined
    const runId = optionalString(request?.runId)
    const candidate = runId
      ? this.deps.appStore.getRunQueueJob(runId)
      : this.deps.appStore
          .getRunQueueJobs({ provider, statuses: ['queued'] })
          .find((job) => this.deps.canLeaseJob(job))
    const safeCandidate = candidate ? this.quarantineUnsafePersistedAttachments(candidate) : null
    if (!safeCandidate || safeCandidate.status !== 'queued') {
      return null
    }
    if (provider && safeCandidate.provider !== provider) {
      return null
    }
    if (runId && !this.deps.canLeaseJob(safeCandidate)) {
      return null
    }
    return this.deps.getRunRepository().leaseQueuedRun({
      runId: safeCandidate.runId,
      provider: safeCandidate.provider,
      statusReason: optionalString(request?.statusReason) || 'Leased by TaskWraith main scheduler.'
    })
  }

  leaseQueuedJob(
    request: { runId?: string; provider?: ProviderId; chatId?: string; statusReason?: string } = {}
  ): RunQueueJob | null {
    const provider = request?.provider ? assertProviderId(request.provider) : undefined
    const chatId = optionalString(request?.chatId)
    const runId = optionalString(request?.runId)
    const candidate = runId
      ? this.deps.appStore.getRunQueueJob(runId)
      : this.deps.appStore
          .getRunQueueJobs({ provider, chatId, statuses: ['queued'] })
          .find((job) => this.deps.canLeaseJob(job))
    const safeCandidate = candidate ? this.quarantineUnsafePersistedAttachments(candidate) : null
    if (!safeCandidate || safeCandidate.status !== 'queued') {
      return null
    }
    if (provider && safeCandidate.provider !== provider) {
      return null
    }
    if (chatId && safeCandidate.chatId !== chatId) {
      return null
    }
    if (runId && !this.deps.canLeaseJob(safeCandidate)) {
      return null
    }
    return this.deps.getRunRepository().leaseQueuedRun({
      runId: safeCandidate.runId,
      provider: safeCandidate.provider,
      statusReason: optionalString(request?.statusReason) || 'Leased by TaskWraith main scheduler.'
    })
  }

  promoteQueuedJobForSteer(input: {
    runId?: string
    jobId?: string
    ownerToken?: string
    provider?: ProviderId
    chatId?: string
    statusReason?: string
    queueMessageId?: string
    transitionVersion?: number
  }): RunQueueJob | null {
    const ownerToken = optionalString(input?.ownerToken)
    if (!ownerToken) return null
    const provider = input?.provider ? assertProviderId(input.provider) : undefined
    const runId = optionalString(input?.runId) || optionalString(input?.jobId)
    if (!runId) return null
    return this.deps.getRunRepository().promoteQueuedJobForSteer({
      runId,
      ownerToken,
      provider,
      chatId: optionalString(input?.chatId),
      statusReason: optionalString(input?.statusReason),
      queueMessageId: optionalString(input?.queueMessageId),
      transitionVersion: input?.transitionVersion
    })
  }

  leasePromotedSteerJob(input: {
    runId?: string
    ownerToken?: string
    statusReason?: string
  }): RunQueueJob | null {
    const runId = optionalString(input?.runId)
    const ownerToken = optionalString(input?.ownerToken)
    if (!runId || !ownerToken) return null
    const candidate = this.deps.appStore.getRunQueueJob(runId)
    const safeCandidate = candidate ? this.quarantineUnsafePersistedAttachments(candidate) : null
    if (!safeCandidate || safeCandidate.status !== 'steer_promoting') return null
    if (!this.deps.canLeaseJob(safeCandidate)) return null
    return this.deps.getRunRepository().leasePromotedSteerJob({
      runId,
      ownerToken,
      statusReason: optionalString(input?.statusReason)
    })
  }

  fallbackPromotedSteerJob(input: {
    runId?: string
    ownerToken?: string
    reason?: string
    fallbackStatus?: RunQueueJobStatus
  }): RunQueueJob | null {
    const runId = optionalString(input?.runId)
    const ownerToken = optionalString(input?.ownerToken)
    const reason = optionalString(input?.reason)
    const fallbackStatus = input?.fallbackStatus
      ? sanitizeRunQueueStatus(input.fallbackStatus, 'queued')
      : undefined
    if (!runId || !ownerToken || !reason) return null
    return this.deps.getRunRepository().fallbackPromotedSteerJob({
      runId,
      ownerToken,
      reason,
      ...(fallbackStatus ? { fallbackStatus } : {})
    })
  }

  transitionJob(
    runIdOrId: string,
    status: RunQueueJobStatus,
    partial: Partial<RunQueueJob> = {}
  ): RunQueueJob | null {
    const nextStatus = sanitizeRunQueueStatus(status)
    if (nextStatus === 'steer_promoting') return null
    return this.deps.getRunRepository().transitionRunQueueJob(runIdOrId, nextStatus, {
      statusReason: optionalString(partial?.statusReason),
      lastError: optionalString(partial?.lastError)
    })
  }

  persistSessionQueueState(session: RunSession | undefined): void {
    this.deps.getRunRepository().persistSessionQueueState(session)
  }

  private normalizeJobRequest(
    value: unknown,
    authorizedFilePaths?: string[],
    executionGraph?: ExecutionGraphQueueBinding
  ): Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'> {
    const record = requireRecord(value, 'Run queue request')
    const provider = assertRunnableProviderId(record.provider)
    const runId = optionalString(record.runId) || optionalString(record.id) || randomUUID()
    const chatId = optionalString(record.chatId)
    const chat = chatId ? this.deps.appStore.getChat(chatId) : null
    const scope: ChatScope =
      record.scope === 'global' || chatScope(chat) === 'global' ? 'global' : 'workspace'
    let workspacePath: string | undefined
    let workspaceId: string | undefined
    if (scope === 'global') {
      this.deps.requireGlobalChat(chatId, 'Run queue global chat')
    } else {
      workspacePath = this.deps.requireRegisteredWorkspace(
        requireNonEmptyString(record.workspacePath, 'Workspace')
      )
      const workspace = this.deps.findRegisteredWorkspace(workspacePath)
      workspaceId = workspace?.id || optionalString(record.workspaceId)
      this.deps.validateChatWorkspaceIdentity(chatId, workspace)
    }
    const status = sanitizePublicRunQueueStatus(record.status, 'queued')
    const source = sanitizeRunQueueSource(record.source)
    const requestResult = this.sanitizeRunQueueRequestSnapshot(record.request, {
      runId,
      provider,
      source,
      chatId,
      workspaceId,
      workspacePath,
      ...(authorizedFilePaths ? { authorizedFilePaths } : {})
    })
    const request = requestResult?.request
    const permissionPosture = sanitizePermissionPostureSnapshot(record.permissionPosture)
    const normalized: Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'> = {
      id: optionalString(record.id) || runId,
      runId,
      provider,
      ensembleParticipantId: optionalString(record.ensembleParticipantId),
      ensembleLaneId: optionalString(record.ensembleLaneId),
      ensembleRole: optionalString(record.ensembleRole),
      ensembleStageRole:
        record.ensembleStageRole === 'scout' ||
        record.ensembleStageRole === 'worker' ||
        record.ensembleStageRole === 'reviewer'
          ? record.ensembleStageRole
          : undefined,
      scope,
      workspacePath,
      workspaceId,
      chatId,
      source,
      status: requestResult?.attachmentError
        ? 'failed'
        : status === 'active' || status === 'cancelling'
          ? 'starting'
          : status,
      priority: optionalNumber(record.priority),
      attempt: optionalNumber(record.attempt),
      promptPreview: optionalString(record.promptPreview),
      request,
      ...(permissionPosture ? { permissionPosture } : {}),
      ...(executionGraph
        ? { executionGraph: validateExecutionGraphQueueBinding(executionGraph) }
        : {}),
      providerSessionId: optionalString(record.providerSessionId),
      providerRunId: optionalString(record.providerRunId),
      parentRunId: optionalString(record.parentRunId),
      runtimeProfileId: optionalString(record.runtimeProfileId),
      handoffSourceRunId: optionalString(record.handoffSourceRunId),
      statusReason: requestResult?.attachmentError || optionalString(record.statusReason),
      lastError: requestResult?.attachmentError || optionalString(record.lastError)
    }
    normalized.dispatchReceipt = buildRunQueueDispatchReceipt(normalized)
    return normalized
  }

  private sanitizeRunQueueRequestSnapshot(
    value: unknown,
    context: {
      runId: string
      provider: ProviderId
      source: RunQueueJobSource
      chatId?: string
      workspaceId?: string
      workspacePath?: string
      authorizedFilePaths?: string[]
    }
  ): { request: RunQueueRequestSnapshot; attachmentError?: string } | undefined {
    if (!isRecord(value)) return undefined
    const rawImageAttachmentValues = Array.isArray(value.imageAttachments)
      ? value.imageAttachments
      : []
    const tooManyImageAttachments = rawImageAttachmentValues.length > MAX_DURABLE_ATTACHMENT_REFS
    const rawImageAttachments = !tooManyImageAttachments
      ? rawImageAttachmentValues.filter(isRecord).map((attachment) => ({
          id: optionalString(attachment.id),
          path: requireNonEmptyString(attachment.path, 'Image attachment path'),
          name: optionalString(attachment.name),
          ...(attachment.persistenceVersion === 1
            ? {
                persistenceVersion: 1 as const,
                sha256: optionalString(attachment.sha256) || '',
                mimeType: optionalString(attachment.mimeType) || '',
                byteLength: optionalNumber(attachment.byteLength) || 0
              }
            : {})
        }))
      : []
    const rawExternalPathGrants = Array.isArray(value.externalPathGrants)
      ? (value.externalPathGrants as ExternalPathGrant[])
      : []
    const externalPathGrants = this.deps.normalizeExternalPathGrants(rawExternalPathGrants)
    const discordContextSelection = isRecord(value.discordContextSelection)
      ? normalizeDiscordContextSelection(value.discordContextSelection)
      : undefined
    const projectReferenceContextSelection = parseProjectReferenceContextSelection(
      value.projectReferenceContextSelection
    )
    if (value.projectReferenceContextSelection !== undefined && !projectReferenceContextSelection) {
      throw new Error('Queued Project reference context selection is invalid.')
    }
    if (
      rawExternalPathGrants.length &&
      externalPathGrants.length !== rawExternalPathGrants.length
    ) {
      throw new Error(
        'Queued external path grants must be issued by TaskWraith in this app session.'
      )
    }
    let imageAttachments: PersistedAttachmentRef[] = []
    let attachmentError: string | undefined = tooManyImageAttachments
      ? DURABLE_ATTACHMENT_QUARANTINE_REASON
      : undefined
    if (rawImageAttachments.length) {
      try {
        const staged = this.deps.stageAttachments({
          ...context,
          externalPathGrants,
          attachments: rawImageAttachments
        })
        if (
          !staged.ok ||
          staged.attachments.length !== rawImageAttachments.length ||
          !staged.attachments.every(isPersistedAttachmentRef)
        ) {
          attachmentError = DURABLE_ATTACHMENT_QUARANTINE_REASON
        } else {
          imageAttachments = staged.attachments.map(copyPersistedAttachmentRef)
        }
      } catch {
        attachmentError = DURABLE_ATTACHMENT_QUARANTINE_REASON
      }
    }
    const workflowMode = sanitizeWorkflowMode(value.workflowMode)
    return {
      request: {
        scope: value.scope === 'global' ? 'global' : 'workspace',
        prompt: typeof value.prompt === 'string' ? value.prompt : '',
        displayPrompt: optionalString(value.displayPrompt),
        dmTargetParticipantId: optionalString(value.dmTargetParticipantId),
        exactPickerParticipantId: optionalString(value.exactPickerParticipantId),
        selectedModelType: optionalString(value.selectedModelType) || 'cli-default',
        customModel: typeof value.customModel === 'string' ? value.customModel : '',
        approvalMode: optionalString(value.approvalMode) || 'default',
        permissionPresetId: sanitizePermissionPresetId(value.permissionPresetId),
        ...(workflowMode ? { workflowMode } : {}),
        sessionTrust: Boolean(value.sessionTrust),
        imageAttachments,
        ...(discordContextSelection ? { discordContextSelection } : {}),
        ...(projectReferenceContextSelection ? { projectReferenceContextSelection } : {}),
        externalPathGrants: externalPathGrants.length ? externalPathGrants : undefined,
        geminiWorktree: sanitizeWorkspaceGeminiWorktree(value.geminiWorktree),
        codexNativeReview: Boolean(value.codexNativeReview) || undefined,
        codexReasoningEffort: optionalStringOrNull(value.codexReasoningEffort),
        claudeReasoningEffort: optionalStringOrNull(value.claudeReasoningEffort),
        grokReasoningEffort: optionalStringOrNull(value.grokReasoningEffort),
        cursorReasoningEffort: optionalStringOrNull(value.cursorReasoningEffort),
        codexServiceTier: optionalStringOrNull(value.codexServiceTier),
        geminiAuthProfileId: optionalStringOrNull(value.geminiAuthProfileId),
        guestParentChatId: optionalString(value.guestParentChatId),
        guestRole: optionalString(value.guestRole),
        remoteComposer: isRecord(value.remoteComposer)
          ? sanitizeRemoteComposer(value.remoteComposer)
          : undefined,
        claudeFastMode:
          typeof value.claudeFastMode === 'boolean' ? value.claudeFastMode : undefined,
        kimiFastMode: typeof value.kimiFastMode === 'boolean' ? value.kimiFastMode : undefined,
        kimiReasoningEffort: optionalStringOrNull(value.kimiReasoningEffort),
        cursorFastMode:
          typeof value.cursorFastMode === 'boolean' ? value.cursorFastMode : undefined,
        kimiThinkingEnabled:
          typeof value.kimiThinkingEnabled === 'boolean' ? value.kimiThinkingEnabled : undefined,
        scheduledTaskId: optionalString(value.scheduledTaskId),
        scheduledRunAt: optionalString(value.scheduledRunAt),
        effectiveWorkspacePath: optionalString(value.effectiveWorkspacePath),
        preserveComposer: Boolean(value.preserveComposer) || undefined,
        runtimeProfileId: optionalString(value.runtimeProfileId),
        handoffSourceRunId: optionalString(value.handoffSourceRunId)
      },
      ...(attachmentError ? { attachmentError } : {})
    }
  }

  private quarantineUnsafePersistedAttachments(job: RunQueueJob): RunQueueJob {
    const sourceRequest = job.request
    const attachments = sourceRequest?.imageAttachments
    if (
      !sourceRequest ||
      !attachments?.length ||
      (attachments.length <= MAX_DURABLE_ATTACHMENT_REFS &&
        attachments.every(isPersistedAttachmentRef))
    ) {
      return job
    }

    const request: RunQueueRequestSnapshot = { ...sourceRequest, imageAttachments: [] }
    if (isTerminalRunQueueStatus(job.status)) {
      return { ...job, request }
    }
    const transitioned = this.deps.getRunRepository().transitionRunQueueJob(job.runId, 'failed', {
      statusReason: DURABLE_ATTACHMENT_QUARANTINE_REASON,
      lastError: DURABLE_ATTACHMENT_QUARANTINE_REASON
    })
    return {
      ...(transitioned || job),
      status: 'failed',
      statusReason: DURABLE_ATTACHMENT_QUARANTINE_REASON,
      lastError: DURABLE_ATTACHMENT_QUARANTINE_REASON,
      request
    }
  }
}

const EXECUTION_GRAPH_BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const EXECUTION_GRAPH_TEMPLATE_REF = /^run-template-[a-f0-9]{64}$/
const SHA256_DIGEST = /^[a-f0-9]{64}$/

function validateExecutionGraphQueueBinding(
  value: ExecutionGraphQueueBinding
): ExecutionGraphQueueBinding {
  if (
    value?.schemaVersion !== 1 ||
    !EXECUTION_GRAPH_BINDING_ID.test(value.executionId) ||
    !EXECUTION_GRAPH_BINDING_ID.test(value.activationId) ||
    !EXECUTION_GRAPH_BINDING_ID.test(value.attemptId) ||
    !EXECUTION_GRAPH_TEMPLATE_REF.test(value.runTemplateRef) ||
    !SHA256_DIGEST.test(value.permissionCeilingAuthorityDigest)
  ) {
    throw new Error('Execution graph queue binding is invalid.')
  }
  return { ...value }
}

function copyPersistedAttachmentRef(value: PersistedAttachmentRef): PersistedAttachmentRef {
  return {
    persistenceVersion: 1,
    id: optionalString(value.id),
    path: value.path,
    name: optionalString(value.name),
    sha256: value.sha256,
    mimeType: value.mimeType.toLowerCase(),
    byteLength: value.byteLength
  }
}

function isTerminalRunQueueStatus(status: RunQueueJobStatus): boolean {
  return status === 'cancelled' || status === 'failed' || status === 'completed'
}

function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && PROVIDER_IDS.has(value as ProviderId)) {
    return value as ProviderId
  }
  throw new Error('Provider is invalid.')
}

/**
 * Queue admission mirrors ComposerService's interactive-dispatch stance: the
 * Gemini API-key lane admits AntiGravity on a currently configured key alone
 * (its queued sends drain through the same in-app Gemini kernel), while the
 * separate agy/CLI ban-risk lane never queues interactive runs. Without this
 * union a send on a busy AntiGravity chat was rejected at enqueue even though
 * an immediate dispatch of the identical request would have been admitted.
 */
function assertRunnableProviderId(value: unknown): ProviderId {
  const provider = assertProviderId(value)
  if (isLiveSelectableProvider(provider)) return provider
  if (provider === ANTIGRAVITY_PROVIDER_ID && isAntigravityGeminiApiKeyConfigured()) {
    return provider
  }
  throw new Error('Provider is unavailable for new runs.')
}

function sanitizeRunQueueStatus(
  value: unknown,
  fallback: RunQueueJobStatus = 'queued'
): RunQueueJobStatus {
  return typeof value === 'string' && RUN_QUEUE_STATUSES.has(value as RunQueueJobStatus)
    ? (value as RunQueueJobStatus)
    : fallback
}

function sanitizePublicRunQueueStatus(
  value: unknown,
  fallback: RunQueueJobStatus = 'queued'
): RunQueueJobStatus {
  const status = sanitizeRunQueueStatus(value, fallback)
  return status === 'steer_promoting' ? fallback : status
}

function sanitizeRunQueueSource(value: unknown): RunQueueJobSource {
  return typeof value === 'string' && RUN_QUEUE_SOURCES.has(value as RunQueueJobSource)
    ? (value as RunQueueJobSource)
    : 'manual'
}

function sanitizeWorkflowMode(value: unknown): ChatWorkflowMode | undefined {
  return value === 'plan' || value === 'normal' ? value : undefined
}

function sanitizePermissionPresetId(value: unknown): PermissionPresetId | undefined {
  return typeof value === 'string' && PERMISSION_PRESET_IDS.has(value as PermissionPresetId)
    ? (value as PermissionPresetId)
    : undefined
}

function sanitizeAgenticNetworkPolicy(value: unknown): AgenticNetworkPolicy | undefined {
  return value === 'allow' || value === 'deny' ? value : undefined
}

function sanitizeAgenticServices(
  value: unknown
): Record<AgenticServiceId, AgenticServicePolicy> | undefined {
  if (!isRecord(value)) return undefined
  const sanitized: Partial<Record<AgenticServiceId, AgenticServicePolicy>> = {}
  for (const [serviceId, policy] of Object.entries(value)) {
    if (
      AGENTIC_SERVICE_IDS.has(serviceId as AgenticServiceId) &&
      AGENTIC_SERVICE_POLICIES.has(policy as AgenticServicePolicy)
    ) {
      sanitized[serviceId as AgenticServiceId] = policy as AgenticServicePolicy
    }
  }
  return Object.keys(sanitized).length
    ? (sanitized as Record<AgenticServiceId, AgenticServicePolicy>)
    : undefined
}

function sanitizeAgenticServiceIds(value: unknown): AgenticServiceId[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sanitized = value.filter(
    (serviceId): serviceId is AgenticServiceId =>
      typeof serviceId === 'string' && AGENTIC_SERVICE_IDS.has(serviceId as AgenticServiceId)
  )
  return sanitized.length ? sanitized : undefined
}

function sanitizePermissionPostureContext(
  value: unknown
): RunPermissionPostureSnapshot['context'] | undefined {
  if (!isRecord(value)) return undefined
  const context: RunPermissionPostureSnapshot['context'] = {
    provider: optionalString(value.provider),
    scope: optionalString(value.scope),
    appRunId: optionalString(value.appRunId),
    appChatId: optionalString(value.appChatId),
    workflowMode: optionalString(value.workflowMode),
    runtimeProfileId: optionalString(value.runtimeProfileId),
    ensembleParticipantId: optionalString(value.ensembleParticipantId),
    ensembleLaneId: optionalString(value.ensembleLaneId),
    projectReferenceContextHash: optionalString(value.projectReferenceContextHash),
    promptHash: optionalString(value.promptHash),
    resumeFallbackPromptHash: optionalString(value.resumeFallbackPromptHash)
  }
  return Object.values(context).some(Boolean) ? context : undefined
}

function sanitizePermissionPostureSnapshot(
  value: unknown
): RunPermissionPostureSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined
  const postureHash = optionalString(value.postureHash)
  if (!postureHash) return undefined
  const externalPathGrantCount =
    typeof value.externalPathGrantCount === 'number' &&
    Number.isFinite(value.externalPathGrantCount) &&
    value.externalPathGrantCount >= 0
      ? Math.floor(value.externalPathGrantCount)
      : 0
  const workflowMode = sanitizeWorkflowMode(value.workflowMode)
  const presetId = sanitizePermissionPresetId(value.presetId)
  const agenticServices = sanitizeAgenticServices(value.agenticServices)
  const networkAccess = sanitizeAgenticNetworkPolicy(value.networkAccess)
  const workspaceGrantServiceIds = sanitizeAgenticServiceIds(value.workspaceGrantServiceIds)
  const signature = optionalString(value.signature)
  const context = sanitizePermissionPostureContext(value.context)
  return {
    schemaVersion: 1,
    approvalMode: optionalString(value.approvalMode),
    ...(workflowMode ? { workflowMode } : {}),
    ...(presetId ? { presetId } : {}),
    ...(typeof value.readOnly === 'boolean' ? { readOnly: value.readOnly } : {}),
    ...(agenticServices ? { agenticServices } : {}),
    ...(networkAccess ? { networkAccess } : {}),
    externalPathGrantCount,
    externalPathGrantHash: optionalString(value.externalPathGrantHash),
    ...(workspaceGrantServiceIds ? { workspaceGrantServiceIds } : {}),
    postureHash,
    ...(signature ? { signature } : {}),
    signaturePresent:
      typeof value.signaturePresent === 'boolean' ? value.signaturePresent : Boolean(signature),
    ...(context ? { context } : {})
  }
}

function sanitizeWorkspaceGeminiWorktree(
  value: unknown
): WorkspaceRecord['geminiWorktree'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const sanitized: WorkspaceRecord['geminiWorktree'] = {
    enabled: Boolean(record.enabled)
  }
  if (typeof record.name === 'string' && record.name.trim()) {
    sanitized.name = record.name.trim()
  }
  return sanitized
}

function sanitizeRemoteComposer(
  value: unknown
): RunQueueRequestSnapshot['remoteComposer'] | undefined {
  if (!isRecord(value)) return undefined
  const approvalMode = optionalString(value.approvalMode)
  const workflowMode = sanitizeWorkflowMode(value.workflowMode)
  const permissionPresetId = optionalString(value.permissionPresetId)
  const model = optionalString(value.model)
  const reasoningEffort = optionalStringOrNull(value.reasoningEffort)
  const claudeReasoningEffort = optionalStringOrNull(value.claudeReasoningEffort)
  const grokReasoningEffort = optionalStringOrNull(value.grokReasoningEffort)
  const cursorReasoningEffort = optionalStringOrNull(value.cursorReasoningEffort)
  // Preserve an explicit "" (codex Fast-OFF sentinel) — optionalStringOrNull would
  // trim it to undefined and drop it, resurrecting a stale 'fast' on rehydration.
  const codexServiceTier =
    typeof value.codexServiceTier === 'string' ? value.codexServiceTier : undefined
  const scheduledRunAt = optionalString(value.scheduledRunAt)
  return {
    workspaceId: optionalString(value.workspaceId) || '',
    threadId: optionalString(value.threadId) || '',
    provider: optionalString(value.provider) || 'gemini',
    text: optionalString(value.text) || '',
    ...(approvalMode ? { approvalMode } : {}),
    ...(workflowMode ? { workflowMode } : {}),
    ...(permissionPresetId ? { permissionPresetId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(claudeReasoningEffort !== undefined ? { claudeReasoningEffort } : {}),
    ...(grokReasoningEffort !== undefined ? { grokReasoningEffort } : {}),
    ...(cursorReasoningEffort !== undefined ? { cursorReasoningEffort } : {}),
    ...(typeof value.cursorFastMode === 'boolean' ? { cursorFastMode: value.cursorFastMode } : {}),
    ...(codexServiceTier !== undefined ? { codexServiceTier } : {}),
    ...(typeof value.claudeFastMode === 'boolean' ? { claudeFastMode: value.claudeFastMode } : {}),
    ...(typeof value.kimiFastMode === 'boolean' ? { kimiFastMode: value.kimiFastMode } : {}),
    ...(optionalStringOrNull(value.kimiReasoningEffort) !== undefined
      ? { kimiReasoningEffort: optionalStringOrNull(value.kimiReasoningEffort) }
      : {}),
    ...(typeof value.kimiThinkingEnabled === 'boolean'
      ? { kimiThinkingEnabled: value.kimiThinkingEnabled }
      : {}),
    ...(typeof value.contextTurns === 'number' ? { contextTurns: value.contextTurns } : {}),
    ...(scheduledRunAt ? { scheduledRunAt } : {}),
    ...(Array.isArray(value.extraWorkspaceIds)
      ? { extraWorkspaceIds: value.extraWorkspaceIds.filter((id) => typeof id === 'string') }
      : {})
  }
}

function chatScope(chat: Pick<ChatRecord, 'scope'> | null | undefined): ChatScope {
  return chat?.scope === 'global' ? 'global' : 'workspace'
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return optionalString(value)
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
