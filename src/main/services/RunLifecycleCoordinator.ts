import { randomUUID } from 'crypto'
import type { ProviderId, RunQueueJob, RunQueueJobStatus, RunQueueRequestSnapshot } from '../store/types'
import { parseProjectReferenceContextSelection } from '../../shared/projectReferenceContext'

interface PromoteQueuedJobForSteerRequest {
  runId: string
  ownerToken: string
  provider?: ProviderId
  chatId?: string
  statusReason?: string
  queueMessageId?: string
  transitionVersion?: number
}

interface LeasePromotedSteerJobRequest {
  runId: string
  ownerToken: string
  statusReason?: string
}

interface LeaseQueuedLifecycleJobRequest {
  runId?: string
  provider?: ProviderId
  chatId?: string
  ownerToken?: string
  statusReason?: string
}

interface FallbackPromotedSteerJobRequest {
  runId: string
  ownerToken: string
  reason?: string
  fallbackStatus?: RunQueueJobStatus
}

interface MaybeAsyncBoolean {
  (provider: ProviderId, runId?: string): boolean | Promise<boolean>
}

type AsyncOrSync<T> = T | Promise<T>

interface QueuePort {
  getRunQueueJob: (runIdOrId: string) => RunQueueJob | null
  promoteQueuedJobForSteer?: (input: PromoteQueuedJobForSteerRequest) => AsyncOrSync<RunQueueJob | null>
  leasePromotedSteerJob?: (input: LeasePromotedSteerJobRequest) => AsyncOrSync<RunQueueJob | null>
  leaseQueuedJob?: (input: LeaseQueuedLifecycleJobRequest) => AsyncOrSync<RunQueueJob | null>
  leaseJob?: (input: LeaseQueuedLifecycleJobRequest) => AsyncOrSync<RunQueueJob | null>
  fallbackPromotedSteerJob?: (
    input: FallbackPromotedSteerJobRequest
  ) => AsyncOrSync<RunQueueJob | null>
  transitionJob?: (
    runIdOrId: string,
    status: RunQueueJobStatus,
    partial?: {
      statusReason?: string
      lastError?: string
    }
  ) => AsyncOrSync<RunQueueJob | null>
}

export interface RunLifecycleCoordinatorDeps {
  queue: QueuePort
  cancelProviderRun: MaybeAsyncBoolean
  nowIso?: () => string
  createOwnerToken?: () => string
}

export interface PromoteQueuedJobForSteerInput {
  runId: string
  /** Dedicated first-write payload; only the promote-steer IPC may honor it. */
  prepareJob?: Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'>
  ownerToken?: string
  provider?: ProviderId
  chatId?: string
  statusReason?: string
  queueMessageId?: string
  transitionVersion?: number
  /** Optional active run-id to cancel before a coordinated steer dispatch begins. */
  cancelRunId?: string
  /** Provider for an optional intentional cancel. */
  cancelProvider?: ProviderId
}

export interface LeasePromotedSteerInput {
  runId: string
  ownerToken: string
  statusReason?: string
}

export interface FallbackPromotedSteerInput {
  runId: string
  ownerToken: string
  reason?: string
  /** If present, force this fallback status instead of the default `queued`. */
  fallbackStatus?: 'queued' | 'cancelled' | 'failed'
}

export interface ClaimNextLifecycleJobInput {
  provider?: ProviderId
  chatId?: string
  ownerToken?: string
  statusReason?: string
}

export interface LifecycleDispatchTicket {
  kind: 'lifecycle-dispatch-ticket'
  dispatchMode: 'renderer-legacy'
  runId: string
  jobId: string
  provider: ProviderId
  chatId?: string
  source: RunQueueJob['source']
  ownerToken: string
  request: RunQueueRequestSnapshot
  dispatchReceipt?: RunQueueJob['dispatchReceipt']
}

export interface RunLifecyclePromoteDispatchPermission {
  ok: true
  kind: 'dispatch-permission'
  runId: string
  provider: ProviderId
  ownerToken: string
  promotionToken: string
  jobStatus: Exclude<RunQueueJobStatus, 'starting' | 'active' | 'paused' | 'cancelling' | 'failed' | 'cancelled' | 'completed'>
  request: RunQueueRequestSnapshot
  dispatchReceipt?: RunQueueJob['dispatchReceipt']
  cancelRequested: boolean
}

export interface RunLifecyclePromoteFallback {
  ok: false
  kind: 'fallback'
  runId: string
  provider: ProviderId
  ownerToken: string
  jobStatus: RunQueueJobStatus
  reason: string
  requeuedTo?: RunQueueJobStatus
  request?: RunQueueRequestSnapshot
  dispatchReceipt?: RunQueueJob['dispatchReceipt']
  cancelRequested: boolean
}

export type PromoteQueuedJobForSteerResult =
  | RunLifecyclePromoteDispatchPermission
  | RunLifecyclePromoteFallback

export interface LeasePromotedSteerResult {
  ok: true
  kind: 'leased'
  job: RunQueueJob
  request: RunQueueRequestSnapshot
  dispatchReceipt?: RunQueueJob['dispatchReceipt']
  ownerToken: string
}

export interface LeasePromotedSteerFallback {
  ok: false
  kind: 'not-available'
  runId: string
  reason: string
  ownerToken: string
  request?: RunQueueRequestSnapshot
  dispatchReceipt?: RunQueueJob['dispatchReceipt']
}

export type LeasePromotedSteerJobResult = LeasePromotedSteerResult | LeasePromotedSteerFallback

export interface FallbackPromotedSteerResult {
  ok: true
  kind: 'fallback'
  runId: string
  ownerToken: string
  jobStatus: RunQueueJobStatus
  finalReason: string
  request?: RunQueueRequestSnapshot
  dispatchReceipt?: RunQueueJob['dispatchReceipt']
  cancelRequested: boolean
}

export interface FallbackPromotedSteerFailure {
  ok: false
  kind: 'not-found'
  runId: string
  ownerToken: string
  reason: string
}

export type FallbackPromotedSteerJobResult = FallbackPromotedSteerResult | FallbackPromotedSteerFailure

export class RunLifecycleCoordinator {
  constructor(private readonly deps: RunLifecycleCoordinatorDeps) {}

  async claimNextLifecycleJob(
    input: ClaimNextLifecycleJobInput = {}
  ): Promise<LifecycleDispatchTicket | null> {
    const ownerToken = (input.ownerToken && input.ownerToken.trim()) || this.createOwnerToken()
    const leased = await this.tryLeaseQueued({
      provider: input.provider,
      chatId: input.chatId,
      ownerToken,
      statusReason: this.statusReason(
        input.statusReason,
        'Queued run leased from main lifecycle coordinator.'
      )
    })
    if (!leased) {
      return null
    }

    return {
      kind: 'lifecycle-dispatch-ticket',
      dispatchMode: 'renderer-legacy',
      runId: leased.runId,
      jobId: leased.id,
      provider: leased.provider,
      ...(leased.chatId ? { chatId: leased.chatId } : {}),
      source: leased.source,
      ownerToken,
      request: this.sanitizeRequestSnapshot(leased.request),
      ...(leased.dispatchReceipt ? { dispatchReceipt: leased.dispatchReceipt } : {})
    }
  }

  async promoteQueuedJobForSteer(input: PromoteQueuedJobForSteerInput): Promise<PromoteQueuedJobForSteerResult> {
    const runId = input.runId
    const ownerToken = (input.ownerToken && input.ownerToken.trim()) || this.createOwnerToken()
    const job = this.deps.queue.getRunQueueJob(runId)
    if (!job) {
      return {
        ok: false,
        kind: 'fallback',
        runId,
        provider: input.provider || 'gemini',
        ownerToken,
        jobStatus: 'queued',
        reason: `Run queue job ${runId} was not found.`,
        cancelRequested: false
      }
    }

    const provider = input.provider || job.provider
    const promotion = await this.tryPromote(runId, {
      ownerToken,
      provider,
      chatId: input.chatId,
      statusReason: this.statusReason(
        input.statusReason,
        'Promoted from queue for steer with main coordinator.'
      ),
      queueMessageId: input.queueMessageId,
      transitionVersion: input.transitionVersion
    })

    if (!promotion) {
      const fallback = await this.tryFallback(runId, {
        ownerToken,
        reason: this.statusReason(input.statusReason, 'Steer promotion could not be reserved; keeping job queued.')
      })
      return {
        ok: false,
        kind: 'fallback',
        runId,
        provider,
        ownerToken,
        jobStatus: fallback?.status || job.status,
        reason:
          fallback?.status === 'queued'
            ? 'Steer promotion could not be reserved; job remains queued for fallback.'
            : 'Steer promotion could not be reserved.',
        request: this.sanitizeRequestSnapshot(job.request),
        ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {}),
        requeuedTo: fallback?.status === 'queued' ? 'queued' : undefined,
        cancelRequested: false
      }
    }

    const request = this.sanitizeRequestSnapshot(promotion.request)
    if (!request || !request.prompt || request.prompt.length === 0) {
      const fallback = await this.tryFallback(runId, {
        ownerToken,
        reason: 'Queued job missing a runnable request payload.',
        fallbackStatus: 'failed'
      })
      return {
        ok: false,
        kind: 'fallback',
        runId,
        provider,
        ownerToken,
        jobStatus: fallback?.status || promotion.status,
        reason:
          fallback?.status === 'failed'
            ? 'Missing queued request payload; marked failed.'
            : 'Missing queued request payload.',
        request: this.sanitizeRequestSnapshot(job.request),
        ...(promotion.dispatchReceipt ? { dispatchReceipt: promotion.dispatchReceipt } : {}),
        cancelRequested: false
      }
    }

    if (promotion.status !== 'steer_promoting') {
      return {
        ok: false,
        kind: 'fallback',
        runId,
        provider,
        ownerToken,
        jobStatus: promotion.status,
        reason: 'Steer promotion returned an unexpected queue state.',
        request,
        ...(promotion.dispatchReceipt ? { dispatchReceipt: promotion.dispatchReceipt } : {}),
        cancelRequested: false
      }
    }

    const cancelRequested = await this.requestIntentionalCancel(
      input.cancelProvider || provider,
      input.cancelRunId
    )

    return {
      ok: true,
      kind: 'dispatch-permission',
      runId,
      provider,
      ownerToken,
      promotionToken: promotion.promotionToken || ownerToken,
      jobStatus: 'steer_promoting',
      request,
      ...(promotion.dispatchReceipt ? { dispatchReceipt: promotion.dispatchReceipt } : {}),
      cancelRequested
    }
  }

  async leasePromotedSteerJob(input: LeasePromotedSteerInput): Promise<LeasePromotedSteerJobResult> {
    const runId = input.runId
    const job = this.deps.queue.getRunQueueJob(runId)
    if (!job) {
      return {
        ok: false,
        kind: 'not-available',
        runId,
        ownerToken: input.ownerToken,
        reason: `Run queue job ${runId} was not found.`
      }
    }
    if (job.status !== 'steer_promoting') {
      return {
        ok: false,
        kind: 'not-available',
        runId,
        ownerToken: input.ownerToken,
        reason: `Run queue job ${runId} is not waiting for steer lease.`,
        request: this.sanitizeRequestSnapshot(job.request),
        ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {})
      }
    }

    const leased = await this.tryLease(runId, {
      ownerToken: input.ownerToken,
      statusReason: this.statusReason(input.statusReason, 'Leased for steered queued run execution.')
    })
    if (!leased) {
      return {
        ok: false,
        kind: 'not-available',
        runId,
        ownerToken: input.ownerToken,
        reason: 'Steer lease did not succeed.',
        request: this.sanitizeRequestSnapshot(job.request),
        ...(job.dispatchReceipt ? { dispatchReceipt: job.dispatchReceipt } : {})
      }
    }

    const request = this.sanitizeRequestSnapshot(leased.request)
    if (!request || !request.prompt) {
      return {
        ok: false,
        kind: 'not-available',
        runId,
        ownerToken: input.ownerToken,
        reason: 'Steered queued run has no runnable request snapshot.',
        request: this.sanitizeRequestSnapshot(job.request)
      }
    }

    return {
      ok: true,
      kind: 'leased',
      job: leased,
      request,
      ...(leased.dispatchReceipt ? { dispatchReceipt: leased.dispatchReceipt } : {}),
      ownerToken: input.ownerToken
    }
  }

  async fallbackPromotedSteerJob(
    input: FallbackPromotedSteerInput
  ): Promise<FallbackPromotedSteerJobResult> {
    const runId = input.runId
    const ownerToken = input.ownerToken
    const job = this.deps.queue.getRunQueueJob(runId)
    if (!job) {
      return {
        ok: false,
        kind: 'not-found',
        runId,
        ownerToken,
        reason: `Run queue job ${runId} was not found.`
      }
    }

    const reason = this.statusReason(input.reason, 'Steer promotion was not completed before timeout.')
    const fallback = await this.tryFallback(runId, { ownerToken, reason, fallbackStatus: input.fallbackStatus })
    if (!fallback) {
      return {
        ok: false,
        kind: 'not-found',
        runId,
        ownerToken,
        reason: `Could not transition run ${runId} out of steer promotion.`,
      }
    }

    return {
      ok: true,
      kind: 'fallback',
      runId,
      ownerToken,
      jobStatus: fallback.status,
      finalReason: reason,
      request: this.sanitizeRequestSnapshot(fallback.request),
      ...(fallback.dispatchReceipt ? { dispatchReceipt: fallback.dispatchReceipt } : {}),
      cancelRequested: false
    }
  }

  private createOwnerToken(): string {
    return this.deps.createOwnerToken ? this.deps.createOwnerToken() : randomUUID()
  }

  private async requestIntentionalCancel(provider: ProviderId, runId?: string): Promise<boolean> {
    if (!runId) return false
    try {
      return await Promise.resolve(this.deps.cancelProviderRun(provider, runId))
    } catch {
      return false
    }
  }

  private async tryPromote(
    runId: string,
    input: Omit<PromoteQueuedJobForSteerRequest, 'runId'>
  ): Promise<RunQueueJob | null> {
    if (this.deps.queue.promoteQueuedJobForSteer) {
      return Promise.resolve(this.deps.queue.promoteQueuedJobForSteer({ runId, ...input }))
    }

    return null
  }

  private async tryLease(
    runId: string,
    input: Omit<LeasePromotedSteerJobRequest, 'runId'>
  ): Promise<RunQueueJob | null> {
    if (this.deps.queue.leasePromotedSteerJob) {
      return Promise.resolve(this.deps.queue.leasePromotedSteerJob({ runId, ...input }))
    }

    const job = this.deps.queue.getRunQueueJob(runId)
    if (!job || job.status !== 'steer_promoting') {
      return null
    }

    return null
  }

  private async tryLeaseQueued(
    input: Omit<LeaseQueuedLifecycleJobRequest, 'runId'>
  ): Promise<RunQueueJob | null> {
    if (this.deps.queue.leaseQueuedJob) {
      return Promise.resolve(this.deps.queue.leaseQueuedJob(input))
    }
    if (this.deps.queue.leaseJob) {
      return Promise.resolve(this.deps.queue.leaseJob(input))
    }
    return null
  }

  private async tryFallback(
    runId: string,
    input: {
      ownerToken: string
      reason: string
      fallbackStatus?: RunQueueJobStatus
    }
  ): Promise<RunQueueJob | null> {
    if (this.deps.queue.fallbackPromotedSteerJob) {
      return Promise.resolve(
        this.deps.queue.fallbackPromotedSteerJob({
          runId,
          ownerToken: input.ownerToken,
          reason: input.reason,
          fallbackStatus: input.fallbackStatus
        })
      )
    }

    return null
  }

  private statusReason(primary: string | undefined, fallback: string): string {
    return typeof primary === 'string' && primary.trim().length > 0 ? primary.trim() : fallback
  }

  private sanitizeRequestSnapshot(request: RunQueueJob['request']): RunQueueRequestSnapshot {
    const snapshot: RunQueueRequestSnapshot = {
      scope: request?.scope === 'global' || request?.scope === 'workspace' ? request.scope : undefined,
      prompt: typeof request?.prompt === 'string' ? request.prompt : '',
      displayPrompt:
        typeof request?.displayPrompt === 'string' && request.displayPrompt.trim().length > 0
          ? request.displayPrompt
          : undefined,
      dmTargetParticipantId: this.normalizeOptionalString(request?.dmTargetParticipantId),
      exactPickerParticipantId: this.normalizeOptionalString(request?.exactPickerParticipantId),
      selectedModelType: this.normalizeString(request?.selectedModelType, 'cli-default'),
      customModel: this.normalizeOptionalString(request?.customModel) || '',
      approvalMode: this.normalizeString(request?.approvalMode, 'default'),
      permissionPresetId: this.normalizePermissionPresetId(request?.permissionPresetId),
      workflowMode: this.normalizeWorkflowMode(request?.workflowMode),
      sessionTrust: typeof request?.sessionTrust === 'boolean' ? request.sessionTrust : false,
      imageAttachments: Array.isArray(request?.imageAttachments)
        ? request.imageAttachments
            .map((entry) => {
              const path =
                typeof (entry as { path?: unknown }).path === 'string'
                  ? (entry as { path?: string }).path
                  : ''
              if (!path) return null
              const name =
                typeof (entry as { name?: unknown }).name === 'string'
                  ? (entry as { name?: string }).name
                  : undefined
              const id =
                typeof (entry as { id?: unknown }).id === 'string'
                  ? (entry as { id?: string }).id
                  : undefined
              return {
                ...(id ? { id } : {}),
                path,
                ...(name ? { name } : {})
              }
            })
            .filter((entry): entry is RunQueueRequestSnapshot['imageAttachments'][number] => Boolean(entry))
        : [],
      discordContextSelection: this.normalizeDiscordSelection(request?.discordContextSelection),
      projectReferenceContextSelection:
        parseProjectReferenceContextSelection(request?.projectReferenceContextSelection) ?? undefined,
      externalPathGrants: request?.externalPathGrants,
      geminiWorktree: request?.geminiWorktree,
      codexNativeReview: request?.codexNativeReview,
      codexReasoningEffort: request?.codexReasoningEffort,
      codexServiceTier: request?.codexServiceTier,
      claudeReasoningEffort: request?.claudeReasoningEffort,
      claudeFastMode: request?.claudeFastMode,
      kimiFastMode: request?.kimiFastMode,
      kimiReasoningEffort: request?.kimiReasoningEffort,
      kimiThinkingEnabled: request?.kimiThinkingEnabled,
      scheduledTaskId: this.normalizeOptionalString(request?.scheduledTaskId),
      scheduledRunAt: this.normalizeOptionalString(request?.scheduledRunAt),
      preserveComposer: request?.preserveComposer,
      runtimeProfileId: this.normalizeOptionalString(request?.runtimeProfileId),
      geminiAuthProfileId: this.normalizeNullableString(request?.geminiAuthProfileId),
      handoffSourceRunId: this.normalizeOptionalString(request?.handoffSourceRunId),
      guestParentChatId: this.normalizeOptionalString(request?.guestParentChatId),
      guestRole: this.normalizeOptionalString(request?.guestRole)
    }

    if (request?.remoteComposer) {
      snapshot.remoteComposer = request.remoteComposer
    }

    return snapshot
  }

  private normalizeString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.length > 0 ? value : fallback
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  private normalizeNullableString(value: unknown): string | null | undefined {
    if (value === null) return null
    return this.normalizeOptionalString(value)
  }

  private normalizeWorkflowMode(value: unknown): RunQueueRequestSnapshot['workflowMode'] {
    return value === 'plan' || value === 'normal' ? value : undefined
  }

  private normalizePermissionPresetId(value: unknown): RunQueueRequestSnapshot['permissionPresetId'] {
    return value === 'read_only' ||
      value === 'plan' ||
      value === 'default' ||
      value === 'workspace_write' ||
      value === 'full_access' ||
      value === 'custom'
      ? value
      : undefined
  }

  private normalizeDiscordSelection(
    selection: RunQueueRequestSnapshot['discordContextSelection']
  ): RunQueueRequestSnapshot['discordContextSelection'] {
    if (!selection) return undefined
    return {
      guildId: this.normalizeOptionalString(selection.guildId),
      guildName: this.normalizeOptionalString(selection.guildName),
      channelId: this.normalizeString(selection.channelId, ''),
      channelName: this.normalizeString(selection.channelName, ''),
      limit:
        selection.limit === 10 || selection.limit === 25 || selection.limit === 50 || selection.limit === 100
          ? selection.limit
          : 25
    }
  }
}
