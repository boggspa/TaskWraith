import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  buildCloseoutSummaryUnavailableSnapshot,
  normalizeCloseoutSummaryResult,
  sanitizeCloseoutSummaryRequest
} from '../CloseoutSummarizer'
import {
  sanitizeContinuationProposalRequest,
  sanitizeContinuationTitleApplyRequest
} from '../ContinuationProposal'
import {
  createComposerContinuationProposalService,
  type ComposerContinuationProposalService
} from '../services/ComposerContinuationProposalService'
import {
  createComposerContinuationPrefetch,
  installComposerContinuationPersistObserver
} from '../services/ComposerContinuationPrefetch'
import type {
  FallbackPromotedSteerInput,
  FallbackPromotedSteerJobResult,
  LeasePromotedSteerInput,
  LeasePromotedSteerJobResult,
  PromoteQueuedJobForSteerInput,
  PromoteQueuedJobForSteerResult
} from '../services/RunLifecycleCoordinator'
import {
  type ChatRecord,
  type ProviderId,
  type RunAnalystRequest,
  type RunAnalystSnapshot,
  type RunQueueJob,
  type RunQueueJobFilter,
  type RunQueueJobStatus,
  type RunRecoveryFilter,
  type RunRecoveryRecord,
  type ToolActivityDetailRef
} from '../store/types'

type BridgeRequest = (method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>

interface BridgeDaemonLike {
  status: () => { running: boolean }
  request: BridgeRequest
}

export type RunQueueSenderScope =
  | { kind: 'main' }
  | { kind: 'chat'; chatId: string }

export interface RunQueueTargetScope {
  kind: 'run-or-job' | 'ensemble-round'
  targetId: string
}

export type RendererRunQueueMutation =
  | { operation: 'request'; job: unknown }
  | {
      operation: 'lease'
      request: { runId?: string; provider?: ProviderId; statusReason?: string }
    }
  | {
      /** Includes status writes and queued-message edit/delete cancellation. */
      operation: 'transition'
      runIdOrId: string
      status: RunQueueJobStatus
      partial: Partial<RunQueueJob>
    }
  | { operation: 'promote-steer'; input: PromoteQueuedJobForSteerInput }
  | { operation: 'lease-promoted-steer'; input: LeasePromotedSteerInput }
  | { operation: 'fallback-promoted-steer'; input: FallbackPromotedSteerInput }

export interface RendererRunQueueMutationContext {
  event: IpcMainInvokeEvent
  scope: RunQueueSenderScope
}

export interface RunQueueHandlersDeps {
  resolveSenderRunQueueScope: (event: IpcMainInvokeEvent) => RunQueueSenderScope
  resolveSenderAttachmentFilePaths: (event: IpcMainInvokeEvent) => string[]
  resolveSenderDirectoryPickerPaths: (event: IpcMainInvokeEvent) => string[]
  resolveRunQueueTargetChatId: (target: RunQueueTargetScope) => string | undefined
  /**
   * Main-owned policy hook for renderer-originated queue mutations. Throw to
   * reject before the queue store or lifecycle coordinator is touched.
   */
  authorizeRendererRunQueueMutation?: (
    mutation: RendererRunQueueMutation,
    context: RendererRunQueueMutationContext
  ) => void
  getRunQueueJobs: (filter?: RunQueueJobFilter) => RunQueueJob[]
  getRunRecoveryRecords: (filter?: RunRecoveryFilter) => RunRecoveryRecord[]
  requestRunQueueJob: (
    job: unknown,
    options?: {
      authorizedFilePaths?: string[]
      authorizedDirectoryPickerPaths?: string[]
      soloSteerTranscriptBarrier?: { ownerToken: string; queueMessageId: string }
    }
  ) => RunQueueJob
  leaseRunQueueJob: (request: {
    runId?: string
    provider?: ProviderId
    statusReason?: string
  }) => RunQueueJob | null
  transitionRunQueueJob: (
    runIdOrId: string,
    status: RunQueueJobStatus,
    partial: Partial<RunQueueJob>
  ) => RunQueueJob | null

  getRunLifecycleCoordinator: () => {
    promoteQueuedJobForSteer: (
      input: PromoteQueuedJobForSteerInput
    ) => Promise<PromoteQueuedJobForSteerResult> | PromoteQueuedJobForSteerResult
    leasePromotedSteerJob: (
      input: LeasePromotedSteerInput
    ) => Promise<LeasePromotedSteerJobResult> | LeasePromotedSteerJobResult
    fallbackPromotedSteerJob: (
      input: FallbackPromotedSteerInput
    ) => Promise<FallbackPromotedSteerJobResult> | FallbackPromotedSteerJobResult
  } | null

  getRunEvents: (filter?: Record<string, unknown>) => Promise<unknown[]>
  getToolActivityDetails: (refs: ToolActivityDetailRef[]) => Promise<unknown[]>
  getRunEventReplay: (runId: string) => unknown
  getBridgeDaemon: () => BridgeDaemonLike | null
  /** Test/embedding seam; production resolves the canonical AppStore lazily. */
  composerContinuationProposalService?: ComposerContinuationProposalService
  onContinuationTitleApplied?: (chat: ChatRecord) => void | Promise<void>

  sanitizeRunAnalystRequest: (input: unknown) => RunAnalystRequest
  normalizeRunAnalystResult: (
    request: RunAnalystRequest,
    result: unknown,
    generatedAt: string
  ) => RunAnalystSnapshot
  buildRunAnalystUnavailableSnapshot: (request: RunAnalystRequest, reason: string) => RunAnalystSnapshot

  randomUUID: () => string
}

const RUN_ANALYST_TIMEOUT_MS = 45_000
const CLOSEOUT_SUMMARY_TIMEOUT_MS = 30_000

function scopedChatFilter<T extends { chatId?: string }>(
  scope: RunQueueSenderScope,
  filter: T | undefined
): T | undefined {
  if (scope.kind === 'main') return filter
  if (filter?.chatId !== undefined && filter.chatId !== scope.chatId) {
    throw new Error('Renderer cannot access run state for another chat.')
  }
  return { ...(filter || ({} as T)), chatId: scope.chatId }
}

function assertScopedTarget(
  deps: RunQueueHandlersDeps,
  scope: RunQueueSenderScope,
  target: RunQueueTargetScope
): void {
  if (scope.kind === 'main') return
  if (!target.targetId.trim()) {
    throw new Error('Renderer run ownership could not be resolved.')
  }
  const chatId = deps.resolveRunQueueTargetChatId(target)
  if (!chatId || chatId !== scope.chatId) {
    throw new Error('Renderer cannot access run state for another chat.')
  }
}

function requestedJobChatId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const chatId = (value as Record<string, unknown>).chatId
  return typeof chatId === 'string' && chatId.trim() ? chatId.trim() : undefined
}

function authorizeRendererMutation(
  deps: RunQueueHandlersDeps,
  event: IpcMainInvokeEvent,
  scope: RunQueueSenderScope,
  mutation: RendererRunQueueMutation
): void {
  deps.authorizeRendererRunQueueMutation?.(mutation, { event, scope })
}

export function registerRunQueueHandlers(deps: RunQueueHandlersDeps): void {
  const continuationProposalService =
    deps.composerContinuationProposalService ??
    createComposerContinuationProposalService({
      getChat: async (chatId) => {
        const { AppStore } = await import('../store')
        return AppStore.getChat(chatId)
      },
      applyTitle: async (request) => {
        const { AppStore } = await import('../store')
        return AppStore.applyContinuationTitle(request)
      },
      getBridgeDaemon: deps.getBridgeDaemon
    })
  const continuationPrefetch = createComposerContinuationPrefetch({
    service: continuationProposalService,
    isEnabled: async () => {
      const { AppStore } = await import('../store')
      return AppStore.getSettings().composerContinuationAiEnabled !== false
    },
    beforePrefetch: async (chatId) => {
      const { AppStore } = await import('../store')
      await AppStore.awaitChatRecordPersisted(chatId)
    },
    afterTitleApplied: async (chat) => {
      const { AppStore } = await import('../store')
      await AppStore.awaitChatRecordPersisted(chat.appChatId)
      const canonical = AppStore.getChat(chat.appChatId)
      if (
        canonical?.threadTitle?.source === 'local-ai' &&
        canonical.threadTitle.evidenceFingerprint === chat.threadTitle?.evidenceFingerprint
      ) {
        await deps.onContinuationTitleApplied?.(canonical)
      }
    },
    onError: (chatId, error) => {
      console.error(`[composer-continuation] prefetch failed for ${chatId}`, error)
    }
  })
  installComposerContinuationPersistObserver(continuationPrefetch.observe)
  ipcMain.handle('get-run-queue-jobs', (event, filter?: RunQueueJobFilter) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    return deps.getRunQueueJobs(scopedChatFilter(scope, filter))
  })

  ipcMain.handle('get-run-recovery-records', (event, filter?: RunRecoveryFilter) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    return deps.getRunRecoveryRecords(scopedChatFilter(scope, filter) || {})
  })

  ipcMain.handle('request-run-queue-job', (event, job: unknown) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    if (scope.kind === 'chat' && requestedJobChatId(job) !== scope.chatId) {
      throw new Error('Renderer cannot create run state for another chat.')
    }
    authorizeRendererMutation(deps, event, scope, { operation: 'request', job })
    return deps.requestRunQueueJob(job, {
      authorizedFilePaths: deps.resolveSenderAttachmentFilePaths(event),
      authorizedDirectoryPickerPaths: deps.resolveSenderDirectoryPickerPaths(event)
    })
  })

  ipcMain.handle(
    'lease-run-queue-job',
    (event, request: { runId?: string; provider?: ProviderId; statusReason?: string } = {}) => {
      const scope = deps.resolveSenderRunQueueScope(event)
      if (scope.kind === 'chat' && !request.runId) {
        throw new Error('Chat renderers must lease an explicitly owned run.')
      }
      if (request.runId) {
        assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: request.runId })
      }
      authorizeRendererMutation(deps, event, scope, { operation: 'lease', request })
      return deps.leaseRunQueueJob(request)
    }
  )

  ipcMain.handle(
    'transition-run-queue-job',
    (event, runIdOrId: string, status: RunQueueJobStatus, partial: Partial<RunQueueJob> = {}) => {
      const scope = deps.resolveSenderRunQueueScope(event)
      assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: runIdOrId })
      authorizeRendererMutation(deps, event, scope, {
        operation: 'transition',
        runIdOrId,
        status,
        partial
      })
      return deps.transitionRunQueueJob(runIdOrId, status, partial)
    }
  )

  ipcMain.handle('promote-queued-job-for-steer', async (event, input: PromoteQueuedJobForSteerInput) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    const prepareJob = input?.prepareJob
    if (prepareJob) {
      const prepareChatId = requestedJobChatId(prepareJob)
      if (prepareJob.runId !== input.runId) {
        throw new Error('Prepared steer run identity does not match its promotion request.')
      }
      if (input.provider && prepareJob.provider !== input.provider) {
        throw new Error('Prepared steer provider does not match its promotion request.')
      }
      if (input.chatId && prepareChatId !== input.chatId) {
        throw new Error('Prepared steer chat does not match its promotion request.')
      }
      if (scope.kind === 'chat' && prepareChatId !== scope.chatId) {
        throw new Error('Renderer cannot prepare steer state for another chat.')
      }
    } else {
      assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: input?.runId || '' })
    }
    if (scope.kind === 'chat' && input?.chatId !== undefined && input.chatId !== scope.chatId) {
      throw new Error('Renderer cannot promote run state for another chat.')
    }
    if (input?.cancelRunId) {
      assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: input.cancelRunId })
    }
    authorizeRendererMutation(deps, event, scope, { operation: 'promote-steer', input })
    const coordinator = deps.getRunLifecycleCoordinator()
    if (!coordinator) {
      return {
        ok: false,
        kind: 'fallback',
        runId: typeof input?.runId === 'string' ? input.runId : 'unknown-run',
        provider: input?.provider || 'gemini',
        ownerToken: input?.ownerToken || deps.randomUUID(),
        jobStatus: 'queued',
        reason: 'RunLifecycleCoordinator is not initialized yet — the app may still be starting up.',
        cancelRequested: false
      } as const
    }
    // A prepared steer is a first-write authority boundary. The renderer may
    // ask main to create it, but cannot choose the owner identity that makes
    // the resulting barrier repairable after restart.
    const ownerToken = prepareJob ? deps.randomUUID() : input?.ownerToken
    if (prepareJob) {
      deps.requestRunQueueJob(prepareJob, {
        authorizedFilePaths: deps.resolveSenderAttachmentFilePaths(event),
        authorizedDirectoryPickerPaths: deps.resolveSenderDirectoryPickerPaths(event),
        soloSteerTranscriptBarrier: {
          ownerToken: ownerToken!,
          queueMessageId: input.queueMessageId || ''
        }
      })
    }
    return coordinator.promoteQueuedJobForSteer({
      ...input,
      ...(ownerToken ? { ownerToken } : {})
    })
  })

  ipcMain.handle('lease-promoted-steer-job', async (event, input: LeasePromotedSteerInput) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: input?.runId || '' })
    authorizeRendererMutation(deps, event, scope, { operation: 'lease-promoted-steer', input })
    const coordinator = deps.getRunLifecycleCoordinator()
    if (!coordinator) {
      return {
        ok: false,
        kind: 'not-available',
        runId: typeof input?.runId === 'string' ? input.runId : 'unknown-run',
        reason: 'RunLifecycleCoordinator is not initialized yet — the app may still be starting up.',
        ownerToken: input?.ownerToken || deps.randomUUID()
      } as const
    }
    return coordinator.leasePromotedSteerJob(input)
  })

  ipcMain.handle('fallback-promoted-steer-job', async (event, input: FallbackPromotedSteerInput) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: input?.runId || '' })
    authorizeRendererMutation(deps, event, scope, {
      operation: 'fallback-promoted-steer',
      input
    })
    const coordinator = deps.getRunLifecycleCoordinator()
    if (!coordinator) {
      return {
        ok: false,
        kind: 'not-found',
        runId: typeof input?.runId === 'string' ? input.runId : 'unknown-run',
        ownerToken: input?.ownerToken || deps.randomUUID(),
        reason: 'RunLifecycleCoordinator is not initialized yet — the app may still be starting up.'
      } as const
    }
    return coordinator.fallbackPromotedSteerJob(input)
  })

  // Durable transcript/event store. Writes are main-owned; renderer may only
  // read/replay. Use the ASYNC read so a filter without runId/chatId (whole-dir
  // sweep) yields the event loop instead of beachballing the main thread.
  ipcMain.handle('get-run-events', (event, filter: Record<string, unknown> = {}) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    const runId = typeof filter?.runId === 'string' ? filter.runId : undefined
    if (runId) assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: runId })
    return deps.getRunEvents(scopedChatFilter(scope, filter) || {})
  })
  ipcMain.handle('get-tool-activity-details', (event, refs: ToolActivityDetailRef[] = []) => {
    if (!Array.isArray(refs) || refs.length > 512) {
      throw new Error('Tool activity detail request exceeds the bounded batch size.')
    }
    const scope = deps.resolveSenderRunQueueScope(event)
    const runIds = new Set<string>()
    for (const ref of refs) {
      if (!ref || typeof ref.runId !== 'string' || !ref.runId.trim()) {
        throw new Error('Tool activity detail request requires a run identity.')
      }
      runIds.add(ref.runId)
    }
    for (const runId of runIds) {
      assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: runId })
    }
    return deps.getToolActivityDetails(refs)
  })
  ipcMain.handle('get-run-event-replay', (event, runId: string) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: runId })
    return deps.getRunEventReplay(runId)
  })

  ipcMain.handle('run-analyst:analyze', async (event, input: unknown) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    const request = deps.sanitizeRunAnalystRequest(input)
    assertScopedTarget(deps, scope, { kind: 'run-or-job', targetId: request.runId })
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return deps.buildRunAnalystUnavailableSnapshot(
        request,
        'TaskWraith bridge daemon is not running.'
      )
    }
    try {
      const result = await daemon.request('runAnalyst.analyze', request, {
        timeoutMs: RUN_ANALYST_TIMEOUT_MS
      })
      return deps.normalizeRunAnalystResult(request, result, new Date().toISOString())
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return deps.buildRunAnalystUnavailableSnapshot(request, reason)
    }
  })

  // On-device close-out summarization (Apple Foundation Models via the bridge
  // daemon). Unavailable is a normal outcome — the renderer keeps its
  // deterministic close-out prose — so every failure path returns an
  // 'unavailable' snapshot instead of throwing across the IPC boundary.
  ipcMain.handle('closeout:summarize', async (event, input: unknown) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    const request = sanitizeCloseoutSummaryRequest(input)
    assertScopedTarget(deps, scope, {
      kind: request.scope === 'ensembleRound' ? 'ensemble-round' : 'run-or-job',
      targetId: request.targetId
    })
    const daemon = deps.getBridgeDaemon()
    if (!daemon?.status().running) {
      return buildCloseoutSummaryUnavailableSnapshot(
        request,
        'TaskWraith bridge daemon is not running.'
      )
    }
    try {
      const result = await daemon.request('closeout.summarize', request, {
        timeoutMs: CLOSEOUT_SUMMARY_TIMEOUT_MS
      })
      return normalizeCloseoutSummaryResult(request, result, new Date().toISOString())
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return buildCloseoutSummaryUnavailableSnapshot(request, reason)
    }
  })

  // Contextual AutoDraft remains main-owned: the renderer supplies only chat
  // identity + a local invalidation key. The service re-reads the canonical
  // ChatRecord, builds bounded authority-labelled evidence, validates every
  // generated candidate, and may abstain without a deterministic fallback.
  ipcMain.handle('continuation:propose', async (event, input: unknown) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    const request = sanitizeContinuationProposalRequest(input)
    if (scope.kind === 'chat' && request.chatId !== scope.chatId) {
      throw new Error('Renderer cannot request continuation ranking for another chat.')
    }
    return continuationProposalService.propose(request)
  })
  ipcMain.handle('continuation:apply-title', async (event, input: unknown) => {
    const scope = deps.resolveSenderRunQueueScope(event)
    const request = sanitizeContinuationTitleApplyRequest(input)
    if (scope.kind === 'chat' && request.chatId !== scope.chatId) {
      throw new Error('Renderer cannot apply a continuation title for another chat.')
    }
    return continuationProposalService.applyTitle(request)
  })
}
