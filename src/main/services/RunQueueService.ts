import { randomUUID } from 'crypto'
import { normalizeDiscordContextSelection } from '../channels/DiscordContextService'
import { buildRunQueueDispatchReceipt } from '../RunQueueDispatchReceipt'
import type { RunQueueJobInput } from '../RunQueue'
import type { RunSession } from '../RunManager'
import type {
  AgenticServiceId,
  AgenticNetworkPolicy,
  AgenticServicePolicy,
  ChatWorkflowMode,
  ChatRecord,
  ChatScope,
  ExternalPathGrant,
  PermissionPresetId,
  ProviderId,
  RunPermissionPostureSnapshot,
  RunQueueJob,
  RunQueueJobFilter,
  RunQueueJobSource,
  RunQueueJobStatus,
  RunQueueRequestSnapshot,
  WorkspaceRecord
} from '../store/types'

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
// Grok + Cursor are first-class providers; no eligibility gate (see ProviderId).
const PROVIDER_IDS = new Set<ProviderId>(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
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
  'mediaEditing',
  'mediaRecording'
])
const AGENTIC_SERVICE_POLICIES = new Set<AgenticServicePolicy>(['ask', 'workspace', 'allow', 'deny'])

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
  canLeaseJob: (job: RunQueueJob) => boolean
}

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
    return this.deps.getRunRepository().getRunQueueJobs(filter || {})
  }

  requestJob(input: unknown): RunQueueJob {
    return this.deps.getRunRepository().saveRunQueueJob(this.normalizeJobRequest(input))
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
    if (!candidate || candidate.status !== 'queued') {
      return null
    }
    if (provider && candidate.provider !== provider) {
      return null
    }
    if (runId && !this.deps.canLeaseJob(candidate)) {
      return null
    }
    return this.deps.getRunRepository().leaseQueuedRun({
      runId: candidate.runId,
      provider: candidate.provider,
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
    if (!candidate || candidate.status !== 'queued') {
      return null
    }
    if (provider && candidate.provider !== provider) {
      return null
    }
    if (chatId && candidate.chatId !== chatId) {
      return null
    }
    if (runId && !this.deps.canLeaseJob(candidate)) {
      return null
    }
    return this.deps.getRunRepository().leaseQueuedRun({
      runId: candidate.runId,
      provider: candidate.provider,
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
    if (!candidate || candidate.status !== 'steer_promoting') return null
    if (!this.deps.canLeaseJob(candidate)) return null
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
    return this.deps
      .getRunRepository()
      .transitionRunQueueJob(runIdOrId, nextStatus, {
        statusReason: optionalString(partial?.statusReason),
        lastError: optionalString(partial?.lastError)
      })
  }

  persistSessionQueueState(session: RunSession | undefined): void {
    this.deps.getRunRepository().persistSessionQueueState(session)
  }

  private normalizeJobRequest(
    value: unknown
  ): Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'> {
    const record = requireRecord(value, 'Run queue request')
    const provider = assertProviderId(record.provider)
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
    const request = this.sanitizeRunQueueRequestSnapshot(record.request)
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
      status: status === 'active' || status === 'cancelling' ? 'starting' : status,
      priority: optionalNumber(record.priority),
      attempt: optionalNumber(record.attempt),
      promptPreview: optionalString(record.promptPreview),
      request,
      ...(permissionPosture ? { permissionPosture } : {}),
      providerSessionId: optionalString(record.providerSessionId),
      providerRunId: optionalString(record.providerRunId),
      parentRunId: optionalString(record.parentRunId),
      runtimeProfileId: optionalString(record.runtimeProfileId),
      handoffSourceRunId: optionalString(record.handoffSourceRunId),
      statusReason: optionalString(record.statusReason),
      lastError: optionalString(record.lastError)
    }
    normalized.dispatchReceipt = buildRunQueueDispatchReceipt(normalized)
    return normalized
  }

  private sanitizeRunQueueRequestSnapshot(value: unknown): RunQueueRequestSnapshot | undefined {
    if (!isRecord(value)) return undefined
    const imageAttachments = Array.isArray(value.imageAttachments)
      ? value.imageAttachments.filter(isRecord).map((attachment) => ({
          id: optionalString(attachment.id),
          path: requireNonEmptyString(attachment.path, 'Image attachment path'),
          name: optionalString(attachment.name)
        }))
      : []
    const rawExternalPathGrants = Array.isArray(value.externalPathGrants)
      ? (value.externalPathGrants as ExternalPathGrant[])
      : []
    const externalPathGrants = this.deps.normalizeExternalPathGrants(rawExternalPathGrants)
    const discordContextSelection = isRecord(value.discordContextSelection)
      ? normalizeDiscordContextSelection(value.discordContextSelection)
      : undefined
    if (
      rawExternalPathGrants.length &&
      externalPathGrants.length !== rawExternalPathGrants.length
    ) {
      throw new Error('Queued external path grants must be issued by TaskWraith in this app session.')
    }
    const workflowMode = sanitizeWorkflowMode(value.workflowMode)
    return {
      scope: value.scope === 'global' ? 'global' : 'workspace',
      prompt: typeof value.prompt === 'string' ? value.prompt : '',
      displayPrompt: optionalString(value.displayPrompt),
      selectedModelType: optionalString(value.selectedModelType) || 'cli-default',
      customModel: typeof value.customModel === 'string' ? value.customModel : '',
      approvalMode: optionalString(value.approvalMode) || 'default',
      ...(workflowMode ? { workflowMode } : {}),
      sessionTrust: Boolean(value.sessionTrust),
      imageAttachments,
      ...(discordContextSelection ? { discordContextSelection } : {}),
      externalPathGrants: externalPathGrants.length ? externalPathGrants : undefined,
      geminiWorktree: sanitizeWorkspaceGeminiWorktree(value.geminiWorktree),
      codexNativeReview: Boolean(value.codexNativeReview) || undefined,
      codexReasoningEffort: optionalStringOrNull(value.codexReasoningEffort),
      claudeReasoningEffort: optionalStringOrNull(value.claudeReasoningEffort),
      codexServiceTier: optionalStringOrNull(value.codexServiceTier),
      geminiAuthProfileId: optionalStringOrNull(value.geminiAuthProfileId),
      guestParentChatId: optionalString(value.guestParentChatId),
      guestRole: optionalString(value.guestRole),
      remoteComposer: isRecord(value.remoteComposer)
        ? sanitizeRemoteComposer(value.remoteComposer)
        : undefined,
      claudeFastMode: typeof value.claudeFastMode === 'boolean' ? value.claudeFastMode : undefined,
      kimiThinkingEnabled:
        typeof value.kimiThinkingEnabled === 'boolean' ? value.kimiThinkingEnabled : undefined,
      scheduledTaskId: optionalString(value.scheduledTaskId),
      scheduledRunAt: optionalString(value.scheduledRunAt),
      preserveComposer: Boolean(value.preserveComposer) || undefined,
      runtimeProfileId: optionalString(value.runtimeProfileId),
      handoffSourceRunId: optionalString(value.handoffSourceRunId)
    }
  }
}

function assertProviderId(value: unknown): ProviderId {
  if (typeof value === 'string' && PROVIDER_IDS.has(value as ProviderId)) {
    return value as ProviderId
  }
  throw new Error('Provider is invalid.')
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
    promptHash: optionalString(value.promptHash)
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

function sanitizeRemoteComposer(value: unknown): RunQueueRequestSnapshot['remoteComposer'] | undefined {
  if (!isRecord(value)) return undefined
  const approvalMode = optionalString(value.approvalMode)
  const workflowMode = sanitizeWorkflowMode(value.workflowMode)
  const model = optionalString(value.model)
  const reasoningEffort = optionalStringOrNull(value.reasoningEffort)
  const claudeReasoningEffort = optionalStringOrNull(value.claudeReasoningEffort)
  return {
    workspaceId: optionalString(value.workspaceId) || '',
    threadId: optionalString(value.threadId) || '',
    provider: optionalString(value.provider) || 'gemini',
    text: optionalString(value.text) || '',
    ...(approvalMode ? { approvalMode } : {}),
    ...(workflowMode ? { workflowMode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(claudeReasoningEffort !== undefined ? { claudeReasoningEffort } : {}),
    ...(typeof value.contextTurns === 'number' ? { contextTurns: value.contextTurns } : {}),
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
