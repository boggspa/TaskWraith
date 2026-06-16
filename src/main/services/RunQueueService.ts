import { randomUUID } from 'crypto'
import { experimentalCursorProviderEnabled } from '../cursorGate'
import { experimentalGrokProviderEnabled } from '../grokGate'
import { normalizeDiscordContextSelection } from '../channels/DiscordContextService'
import type { RunQueueJobInput } from '../RunQueue'
import type { RunSession } from '../RunManager'
import type {
  ChatRecord,
  ChatScope,
  ExternalPathGrant,
  ProviderId,
  RunQueueJob,
  RunQueueJobFilter,
  RunQueueJobSource,
  RunQueueJobStatus,
  RunQueueRequestSnapshot,
  WorkspaceRecord
} from '../store/types'

const RUN_QUEUE_STATUSES = new Set<RunQueueJobStatus>([
  'queued',
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
  'scheduled',
  'retry',
  'permission_retry',
  'review',
  'host_rerun',
  'system'
])
const PROVIDER_IDS = new Set<ProviderId>(['gemini', 'codex', 'claude', 'kimi', 'ollama'])

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

  transitionJob(
    runIdOrId: string,
    status: RunQueueJobStatus,
    partial: Partial<RunQueueJob> = {}
  ): RunQueueJob | null {
    return this.deps
      .getRunRepository()
      .transitionRunQueueJob(runIdOrId, sanitizeRunQueueStatus(status), {
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
    const status = sanitizeRunQueueStatus(record.status, 'queued')
    return {
      id: optionalString(record.id) || runId,
      runId,
      provider,
      scope,
      workspacePath,
      workspaceId,
      chatId,
      source: sanitizeRunQueueSource(record.source),
      status: status === 'active' || status === 'cancelling' ? 'starting' : status,
      priority: optionalNumber(record.priority),
      attempt: optionalNumber(record.attempt),
      promptPreview: optionalString(record.promptPreview),
      request: this.sanitizeRunQueueRequestSnapshot(record.request),
      providerSessionId: optionalString(record.providerSessionId),
      providerRunId: optionalString(record.providerRunId),
      parentRunId: optionalString(record.parentRunId),
      runtimeProfileId: optionalString(record.runtimeProfileId),
      handoffSourceRunId: optionalString(record.handoffSourceRunId),
      statusReason: optionalString(record.statusReason),
      lastError: optionalString(record.lastError)
    }
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
    return {
      scope: value.scope === 'global' ? 'global' : 'workspace',
      prompt: typeof value.prompt === 'string' ? value.prompt : '',
      displayPrompt: optionalString(value.displayPrompt),
      selectedModelType: optionalString(value.selectedModelType) || 'cli-default',
      customModel: typeof value.customModel === 'string' ? value.customModel : '',
      approvalMode: optionalString(value.approvalMode) || 'default',
      sessionTrust: Boolean(value.sessionTrust),
      imageAttachments,
      ...(discordContextSelection ? { discordContextSelection } : {}),
      externalPathGrants: externalPathGrants.length ? externalPathGrants : undefined,
      geminiWorktree: sanitizeWorkspaceGeminiWorktree(value.geminiWorktree),
      codexNativeReview: Boolean(value.codexNativeReview) || undefined,
      codexReasoningEffort: optionalStringOrNull(value.codexReasoningEffort),
      codexServiceTier: optionalStringOrNull(value.codexServiceTier),
      claudeFastMode: typeof value.claudeFastMode === 'boolean' ? value.claudeFastMode : undefined,
      kimiThinkingEnabled:
        typeof value.kimiThinkingEnabled === 'boolean' ? value.kimiThinkingEnabled : undefined,
      scheduledTaskId: optionalString(value.scheduledTaskId),
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
  // 1.0.6-G3f — grok is accepted only when the experimental gate is on. The
  // normal run-dispatch path requests a run-queue job, so this must admit grok
  // (when gated) or the streamed assistant message has no placeholder to render
  // into, even though the run itself completes.
  if (value === 'grok' && experimentalGrokProviderEnabled()) {
    return 'grok'
  }
  // 1.0.6-CRUX20 — same gated admission for Cursor (was missing, so Cursor
  // queued / scheduled runs threw "Provider is invalid" and never rendered a
  // placeholder). Mirrors the grok arm above.
  if (value === 'cursor' && experimentalCursorProviderEnabled()) {
    return 'cursor'
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

function sanitizeRunQueueSource(value: unknown): RunQueueJobSource {
  return typeof value === 'string' && RUN_QUEUE_SOURCES.has(value as RunQueueJobSource)
    ? (value as RunQueueJobSource)
    : 'manual'
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
