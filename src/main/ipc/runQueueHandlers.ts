import { ipcMain } from 'electron'
import type {
  FallbackPromotedSteerInput,
  FallbackPromotedSteerJobResult,
  LeasePromotedSteerInput,
  LeasePromotedSteerJobResult,
  PromoteQueuedJobForSteerInput,
  PromoteQueuedJobForSteerResult
} from '../services/RunLifecycleCoordinator'
import {
  type ProviderId,
  type RunAnalystRequest,
  type RunAnalystSnapshot,
  type RunQueueJob,
  type RunQueueJobFilter,
  type RunQueueJobStatus,
  type RunRecoveryFilter,
  type RunRecoveryRecord
} from '../store/types'

type BridgeRequest = (method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>

interface BridgeDaemonLike {
  status: () => { running: boolean }
  request: BridgeRequest
}

export interface RunQueueHandlersDeps {
  getRunQueueJobs: (filter?: RunQueueJobFilter) => RunQueueJob[]
  getRunRecoveryRecords: (filter?: RunRecoveryFilter) => RunRecoveryRecord[]
  requestRunQueueJob: (job: unknown) => RunQueueJob
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
  getRunEventReplay: (runId: string) => unknown
  getBridgeDaemon: () => BridgeDaemonLike | null

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

export function registerRunQueueHandlers(deps: RunQueueHandlersDeps): void {
  ipcMain.handle('get-run-queue-jobs', (_, filter?: RunQueueJobFilter) => deps.getRunQueueJobs(filter))

  ipcMain.handle('get-run-recovery-records', (_, filter?: RunRecoveryFilter) =>
    deps.getRunRecoveryRecords(filter || {})
  )

  ipcMain.handle('request-run-queue-job', (_, job: unknown) => deps.requestRunQueueJob(job))

  ipcMain.handle(
    'lease-run-queue-job',
    (_, request: { runId?: string; provider?: ProviderId; statusReason?: string } = {}) =>
      deps.leaseRunQueueJob(request)
  )

  ipcMain.handle(
    'transition-run-queue-job',
    (_, runIdOrId: string, status: RunQueueJobStatus, partial: Partial<RunQueueJob> = {}) =>
      deps.transitionRunQueueJob(runIdOrId, status, partial)
  )

  ipcMain.handle('promote-queued-job-for-steer', async (_, input: PromoteQueuedJobForSteerInput) => {
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
    return coordinator.promoteQueuedJobForSteer(input)
  })

  ipcMain.handle('lease-promoted-steer-job', async (_, input: LeasePromotedSteerInput) => {
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

  ipcMain.handle('fallback-promoted-steer-job', async (_, input: FallbackPromotedSteerInput) => {
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
  ipcMain.handle('get-run-events', (_, filter: Record<string, unknown> = {}) =>
    deps.getRunEvents(filter || {})
  )
  ipcMain.handle('get-run-event-replay', (_, runId: string) => deps.getRunEventReplay(runId))

  ipcMain.handle('run-analyst:analyze', async (_, input: unknown) => {
    const request = deps.sanitizeRunAnalystRequest(input)
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
}
