import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerRunQueueHandlers,
  type RunQueueHandlersDeps
} from './runQueueHandlers'
import type {
  RunAnalystSnapshot,
  RunQueueJob,
  RunRecoveryRecord
} from '../store/types'
import type {
  FallbackPromotedSteerJobResult,
  LeasePromotedSteerJobResult,
  PromoteQueuedJobForSteerResult
} from '../services/RunLifecycleCoordinator'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

const createDeps = () => {
  const defaultJob: RunQueueJob = {
    id: 'job-1',
    runId: 'run-1',
    provider: 'gemini',
    status: 'queued',
    source: 'manual',
    priority: 0,
    attempt: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  const recoveryRecord: RunRecoveryRecord = {
    schemaVersion: 1,
    id: 'recovery-1',
    runId: 'run-1',
    jobId: 'job-1',
    provider: 'gemini',
    previousStatus: 'active',
    recoveredStatus: 'failed',
    action: 'marked_failed',
    reason: 'test recovery',
    recoveredAt: '2026-01-01T00:00:00.000Z',
    resumeAvailable: false,
    resumeHint: '',
    jobSnapshot: {}
  }
  const analyzerRequest = { runId: 'run-1' }
  const analyzerSnapshot: RunAnalystSnapshot = {
    runId: 'run-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: 'local',
    status: 'ready',
    summary: 'ok',
    risks: [],
    nextSteps: [],
    signals: []
  }
  const deps: RunQueueHandlersDeps = {
    getRunQueueJobs: vi.fn(() => [defaultJob]),
    getRunRecoveryRecords: vi.fn(() => [recoveryRecord]),
    requestRunQueueJob: vi.fn(() => defaultJob),
    leaseRunQueueJob: vi.fn(() => defaultJob),
    transitionRunQueueJob: vi.fn(() => defaultJob),
    getRunLifecycleCoordinator: vi.fn(() => null),
    getRunEvents: vi.fn(async () => [{ runId: 'run-1' }]),
    getRunEventReplay: vi.fn(() => ({ runId: 'run-1', events: [] })),
    getBridgeDaemon: vi.fn(() => null),
    sanitizeRunAnalystRequest: vi.fn(() => analyzerRequest),
    normalizeRunAnalystResult: vi.fn(() => analyzerSnapshot),
    buildRunAnalystUnavailableSnapshot: vi.fn((request, reason) => ({
      ...request,
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'local',
      status: 'unavailable',
      summary: reason,
      risks: [],
      nextSteps: [],
      signals: []
    })),
    randomUUID: vi.fn(() => 'fallback-token')
  }
  return deps
}

const defaultRequest = {
  prompt: 'Run it',
  selectedModelType: 'default',
  customModel: '',
  approvalMode: 'default',
  sessionTrust: false,
  imageAttachments: []
}

describe('registerRunQueueHandlers', () => {
  it('registers the full run queue + run event + analyst channels', () => {
    const deps = createDeps()
    registerRunQueueHandlers(deps)
    expect(handlerFor('get-run-queue-jobs')).toBeTypeOf('function')
    expect(handlerFor('get-run-recovery-records')).toBeTypeOf('function')
    expect(handlerFor('request-run-queue-job')).toBeTypeOf('function')
    expect(handlerFor('lease-run-queue-job')).toBeTypeOf('function')
    expect(handlerFor('transition-run-queue-job')).toBeTypeOf('function')
    expect(handlerFor('promote-queued-job-for-steer')).toBeTypeOf('function')
    expect(handlerFor('lease-promoted-steer-job')).toBeTypeOf('function')
    expect(handlerFor('fallback-promoted-steer-job')).toBeTypeOf('function')
    expect(handlerFor('get-run-events')).toBeTypeOf('function')
    expect(handlerFor('get-run-event-replay')).toBeTypeOf('function')
    expect(handlerFor('run-analyst:analyze')).toBeTypeOf('function')
  })

  it('routes queue CRUD/read channels through injected deps', async () => {
    const deps = createDeps()
    registerRunQueueHandlers(deps)

    expect(handlerFor('get-run-queue-jobs')({}, { status: 'queued' })).toMatchObject([{
      runId: 'run-1',
      provider: 'gemini',
      status: 'queued',
      source: 'manual'
    }])
    expect(deps.getRunQueueJobs).toHaveBeenCalledWith({ status: 'queued' })

    expect(handlerFor('get-run-recovery-records')({}, { runId: 'run-1' })).toMatchObject([
      { runId: 'run-1' }
    ])
    expect(deps.getRunRecoveryRecords).toHaveBeenCalledWith({ runId: 'run-1' })

    expect(handlerFor('request-run-queue-job')({}, { runId: 'run-1' })).toMatchObject({
      runId: 'run-1',
      provider: 'gemini',
      status: 'queued',
      source: 'manual'
    })
    expect(deps.requestRunQueueJob).toHaveBeenCalledWith({ runId: 'run-1' })
  })

  it('passes lease and transition requests through to the queue service', () => {
    const deps = createDeps()
    registerRunQueueHandlers(deps)

    expect(handlerFor('lease-run-queue-job')({}, { runId: 'run-1', provider: 'gemini' })).toMatchObject(
      {
        runId: 'run-1',
        provider: 'gemini',
        status: 'queued',
        source: 'manual'
      }
    )
    expect(deps.leaseRunQueueJob).toHaveBeenCalledWith({
      runId: 'run-1',
      provider: 'gemini'
    })

    expect(handlerFor('transition-run-queue-job')({}, 'run-1', 'queued', {})).toMatchObject({
      runId: 'run-1',
      provider: 'gemini',
      status: 'queued',
      source: 'manual'
    })
    expect(deps.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'queued', {})
  })

  it('falls back when the run lifecycle coordinator is not initialized', async () => {
    const deps = createDeps()
    registerRunQueueHandlers(deps)

    expect(
      await handlerFor('promote-queued-job-for-steer')({}, { runId: 'run-1', provider: 'gemini' })
    ).toMatchObject({
      ok: false,
      kind: 'fallback',
      runId: 'run-1',
      provider: 'gemini',
      ownerToken: 'fallback-token',
      jobStatus: 'queued'
    })

    expect(await handlerFor('lease-promoted-steer-job')({}, { runId: 'run-1' })).toMatchObject({
      ok: false,
      kind: 'not-available',
      runId: 'run-1',
      reason: 'RunLifecycleCoordinator is not initialized yet — the app may still be starting up.',
      ownerToken: 'fallback-token'
    })

    expect(await handlerFor('fallback-promoted-steer-job')({}, { runId: 'run-1', ownerToken: 'token' })).toMatchObject({
      ok: false,
      kind: 'not-found',
      runId: 'run-1',
      ownerToken: 'token'
    })
  })

  it('routes steer requests to the run lifecycle coordinator when initialized', async () => {
    const coordinator = {
      promoteQueuedJobForSteer: vi.fn(async (): Promise<PromoteQueuedJobForSteerResult> => ({
        ok: true,
        kind: 'dispatch-permission' as const,
        runId: 'run-1',
        provider: 'gemini' as const,
        ownerToken: 'owner-token',
        promotionToken: 'promotion-token',
        jobStatus: 'queued' as const,
        request: defaultRequest,
        cancelRequested: false
      })),
      leasePromotedSteerJob: vi.fn(async (): Promise<LeasePromotedSteerJobResult> => ({
        ok: true,
        kind: 'leased' as const,
        job: {
          id: 'job-1',
          runId: 'run-1',
          provider: 'gemini' as const,
          status: 'queued' as const,
          source: 'manual' as const,
          priority: 0,
          attempt: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        request: defaultRequest,
        ownerToken: 'lease-token'
      })),
      fallbackPromotedSteerJob: vi.fn(async (): Promise<FallbackPromotedSteerJobResult> => ({
        ok: false,
        kind: 'not-found' as const,
        runId: 'run-1',
        ownerToken: 'fallback-token',
        reason: 'not found'
      }))
    }
    const deps = createDeps()
    deps.getRunLifecycleCoordinator = vi.fn(() => coordinator)

    registerRunQueueHandlers(deps)

    const promoteResult = await handlerFor('promote-queued-job-for-steer')({}, {
      runId: 'run-1',
      provider: 'gemini'
    })
    expect(promoteResult).toMatchObject({
      ok: true,
      kind: 'dispatch-permission'
    })
    expect(coordinator.promoteQueuedJobForSteer).toHaveBeenCalledWith({
      runId: 'run-1',
      provider: 'gemini'
    })

    const leaseResult = await handlerFor('lease-promoted-steer-job')({}, {
      runId: 'run-1',
      ownerToken: 'lease-token'
    })
    expect(leaseResult).toMatchObject({
      ok: true,
      kind: 'leased'
    })
    expect(coordinator.leasePromotedSteerJob).toHaveBeenCalledWith({
      runId: 'run-1',
      ownerToken: 'lease-token'
    })

    const fallbackResult = await handlerFor('fallback-promoted-steer-job')({}, {
      runId: 'run-1',
      ownerToken: 'fallback-token'
    })
    expect(fallbackResult).toMatchObject({
      ok: false,
      kind: 'not-found'
    })
    expect(coordinator.fallbackPromotedSteerJob).toHaveBeenCalledWith({
      runId: 'run-1',
      ownerToken: 'fallback-token'
    })
  })

  it('delegates run analyst requests to the bridge daemon when running and normalizes result', async () => {
    const deps = createDeps()
    const snapshot: RunAnalystSnapshot = {
      runId: 'run-1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'local',
      status: 'ready',
      summary: 'ok',
      risks: [],
      nextSteps: [],
      signals: []
    }
    const coordinatorRequest = vi.fn(async () => ({ summary: 'ok' }))
    deps.sanitizeRunAnalystRequest = vi.fn(() => ({ runId: 'run-1' }))
    deps.normalizeRunAnalystResult = vi.fn(() => snapshot)
    deps.getBridgeDaemon = vi.fn(() => ({
      status: () => ({ running: true }),
      request: coordinatorRequest
    }))

    registerRunQueueHandlers(deps)

    expect(await handlerFor('run-analyst:analyze')({}, { runId: 'run-1' })).toEqual(snapshot)
    expect(deps.sanitizeRunAnalystRequest).toHaveBeenCalledWith({ runId: 'run-1' })
    expect(coordinatorRequest).toHaveBeenCalledWith(
      'runAnalyst.analyze',
      { runId: 'run-1' },
      { timeoutMs: 45_000 }
    )
    expect(deps.normalizeRunAnalystResult).toHaveBeenCalledWith(
      { runId: 'run-1' },
      { summary: 'ok' },
      expect.any(String)
    )
  })

  it('returns an unavailable snapshot when daemon is unavailable or errors', async () => {
    const deps = createDeps()
    deps.getBridgeDaemon = vi.fn(() => ({
      status: () => ({ running: false }),
      request: vi.fn()
    }))
    registerRunQueueHandlers(deps)

    expect(await handlerFor('run-analyst:analyze')({}, { runId: 'run-1' })).toMatchObject({
      status: 'unavailable',
      summary: 'TaskWraith bridge daemon is not running.'
    })
    expect(deps.buildRunAnalystUnavailableSnapshot).toHaveBeenCalledWith(
      { runId: 'run-1' },
      'TaskWraith bridge daemon is not running.'
    )

    const errorDeps = createDeps()
    const request = vi.fn(async () => {
      throw new Error('daemon failure')
    })
    errorDeps.getBridgeDaemon = vi.fn(() => ({
      status: () => ({ running: true }),
      request
    }))
    mockedHandle.mockReset()
    registerRunQueueHandlers(errorDeps)

    expect(await handlerFor('run-analyst:analyze')({}, { runId: 'run-1' })).toMatchObject({
      status: 'unavailable',
      summary: 'daemon failure'
    })
    expect(errorDeps.buildRunAnalystUnavailableSnapshot).toHaveBeenCalledWith(
      { runId: 'run-1' },
      'daemon failure'
    )
  })

  it('delegates run events and replay through injected read APIs', async () => {
    const deps = createDeps()
    registerRunQueueHandlers(deps)

    expect(await handlerFor('get-run-events')({}, { runId: 'run-1' })).toEqual([{ runId: 'run-1' }])
    expect(deps.getRunEvents).toHaveBeenCalledWith({ runId: 'run-1' })

    expect(await handlerFor('get-run-event-replay')({}, 'run-1')).toEqual({ runId: 'run-1', events: [] })
    expect(deps.getRunEventReplay).toHaveBeenCalledWith('run-1')
  })
})
