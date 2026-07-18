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
    resolveSenderRunQueueScope: vi.fn(() => ({ kind: 'main' as const })),
    resolveSenderAttachmentFilePaths: vi.fn(() => []),
    resolveRunQueueTargetChatId: vi.fn(() => 'chat-1'),
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
    expect(handlerFor('closeout:summarize')).toBeTypeOf('function')
  })

  it('keeps a chat popout scoped to its own jobs, recovery, events, and run actions', async () => {
    const deps = createDeps()
    deps.resolveSenderRunQueueScope = vi.fn(() => ({
      kind: 'chat' as const,
      chatId: 'chat-1'
    }))
    deps.resolveRunQueueTargetChatId = vi.fn(() => 'chat-1')
    registerRunQueueHandlers(deps)
    const event = { sender: { id: 42 } }

    handlerFor('get-run-queue-jobs')(event, { status: 'queued' })
    expect(deps.getRunQueueJobs).toHaveBeenCalledWith({ status: 'queued', chatId: 'chat-1' })

    handlerFor('get-run-recovery-records')(event, { provider: 'gemini' })
    expect(deps.getRunRecoveryRecords).toHaveBeenCalledWith({
      provider: 'gemini',
      chatId: 'chat-1'
    })

    handlerFor('request-run-queue-job')(event, { runId: 'run-1', chatId: 'chat-1' })
    expect(deps.requestRunQueueJob).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        chatId: 'chat-1'
      },
      { authorizedFilePaths: [] }
    )

    handlerFor('transition-run-queue-job')(event, 'run-1', 'queued', {})
    expect(deps.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'queued', {})

    await handlerFor('get-run-events')(event, { runId: 'run-1' })
    expect(deps.getRunEvents).toHaveBeenCalledWith({ runId: 'run-1', chatId: 'chat-1' })

    handlerFor('get-run-event-replay')(event, 'run-1')
    expect(deps.getRunEventReplay).toHaveBeenCalledWith('run-1')

    await handlerFor('run-analyst:analyze')(event, { runId: 'run-1' })
    expect(deps.sanitizeRunAnalystRequest).toHaveBeenCalledWith({ runId: 'run-1' })

    await handlerFor('closeout:summarize')(event, { targetId: 'round-1', scope: 'ensembleRound' })
    expect(deps.resolveRunQueueTargetChatId).toHaveBeenCalledWith({
      kind: 'ensemble-round',
      targetId: 'round-1'
    })
  })

  it('rejects Test 1 popout access to Test 3 run state before side effects', async () => {
    const deps = createDeps()
    deps.resolveSenderRunQueueScope = vi.fn(() => ({
      kind: 'chat' as const,
      chatId: 'chat-1'
    }))
    deps.resolveRunQueueTargetChatId = vi.fn((target) =>
      target.targetId.includes('3') ? 'chat-3' : 'chat-1'
    )
    deps.sanitizeRunAnalystRequest = vi.fn((input) => ({
      runId: (input as { runId: string }).runId
    }))
    registerRunQueueHandlers(deps)
    const event = { sender: { id: 42 } }
    const attempts = [
      () => handlerFor('get-run-queue-jobs')(event, { chatId: 'chat-3' }),
      () => handlerFor('get-run-recovery-records')(event, { chatId: 'chat-3' }),
      () => handlerFor('request-run-queue-job')(event, { runId: 'run-3', chatId: 'chat-3' }),
      () => handlerFor('lease-run-queue-job')(event, { runId: 'run-3' }),
      () => handlerFor('transition-run-queue-job')(event, 'run-3', 'queued', {}),
      () => handlerFor('promote-queued-job-for-steer')(event, { runId: 'run-3' }),
      () => handlerFor('promote-queued-job-for-steer')(event, {
        runId: 'run-1',
        cancelRunId: 'run-3'
      }),
      () => handlerFor('lease-promoted-steer-job')(event, {
        runId: 'run-3',
        ownerToken: 'owner'
      }),
      () => handlerFor('fallback-promoted-steer-job')(event, {
        runId: 'run-3',
        ownerToken: 'owner'
      }),
      () => handlerFor('get-run-events')(event, { runId: 'run-3' }),
      () => handlerFor('get-run-event-replay')(event, 'run-3'),
      () => handlerFor('run-analyst:analyze')(event, { runId: 'run-3' }),
      () => handlerFor('closeout:summarize')(event, {
        targetId: 'round-3',
        scope: 'ensembleRound'
      })
    ]

    for (const attempt of attempts) {
      await expect(Promise.resolve().then(attempt)).rejects.toThrow(/another chat/)
    }
    expect(deps.transitionRunQueueJob).not.toHaveBeenCalled()
    expect(deps.getRunLifecycleCoordinator).not.toHaveBeenCalled()
    expect(deps.getBridgeDaemon).not.toHaveBeenCalled()
  })

  it('passes only the requesting renderer attachment receipts into queue staging', () => {
    const deps = createDeps()
    deps.resolveSenderRunQueueScope = vi.fn((event) => ({
      kind: 'chat' as const,
      chatId: (event as { sender: { id: number } }).sender.id === 101 ? 'chat-1' : 'chat-3'
    }))
    deps.resolveSenderAttachmentFilePaths = vi.fn((event) =>
      (event as { sender: { id: number } }).sender.id === 101
        ? ['/tmp/Test 1/one.png']
        : ['/tmp/Test 3/three.png']
    )
    registerRunQueueHandlers(deps)

    handlerFor('request-run-queue-job')(
      { sender: { id: 101 } },
      { runId: 'run-1', chatId: 'chat-1' }
    )

    expect(deps.requestRunQueueJob).toHaveBeenCalledWith(
      { runId: 'run-1', chatId: 'chat-1' },
      { authorizedFilePaths: ['/tmp/Test 1/one.png'] }
    )
    expect(deps.requestRunQueueJob).not.toHaveBeenCalledWith(
      expect.anything(),
      { authorizedFilePaths: expect.arrayContaining(['/tmp/Test 3/three.png']) }
    )
  })

  it('requires an explicit owned run when a chat popout leases queue work', () => {
    const deps = createDeps()
    deps.resolveSenderRunQueueScope = vi.fn(() => ({
      kind: 'chat' as const,
      chatId: 'chat-1'
    }))
    registerRunQueueHandlers(deps)

    expect(() => handlerFor('lease-run-queue-job')({ sender: { id: 42 } }, {})).toThrow(
      'Chat renderers must lease an explicitly owned run.'
    )
    expect(deps.leaseRunQueueJob).not.toHaveBeenCalled()
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
    expect(deps.requestRunQueueJob).toHaveBeenCalledWith(
      { runId: 'run-1' },
      { authorizedFilePaths: [] }
    )
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

  it('offers main authority every renderer queue mutation before its side effect', async () => {
    const deps = createDeps()
    const authorize = vi.fn()
    deps.authorizeRendererRunQueueMutation = authorize
    registerRunQueueHandlers(deps)
    const event = { sender: { id: 42 } }

    handlerFor('request-run-queue-job')(event, { runId: 'run-1', chatId: 'chat-1' })
    handlerFor('lease-run-queue-job')(event, {
      runId: 'run-1',
      provider: 'gemini',
      statusReason: 'dispatch'
    })
    handlerFor('transition-run-queue-job')(event, 'run-1', 'cancelled', {
      statusReason: 'Edited; returned to composer for revision.'
    })
    await handlerFor('promote-queued-job-for-steer')(event, {
      runId: 'run-1',
      cancelRunId: 'run-2',
      provider: 'gemini'
    })
    await handlerFor('lease-promoted-steer-job')(event, {
      runId: 'run-1',
      ownerToken: 'owner'
    })
    await handlerFor('fallback-promoted-steer-job')(event, {
      runId: 'run-1',
      ownerToken: 'owner',
      reason: 'fallback'
    })

    expect(authorize.mock.calls.map(([mutation]) => mutation)).toEqual([
      {
        operation: 'request',
        job: { runId: 'run-1', chatId: 'chat-1' }
      },
      {
        operation: 'lease',
        request: { runId: 'run-1', provider: 'gemini', statusReason: 'dispatch' }
      },
      {
        operation: 'transition',
        runIdOrId: 'run-1',
        status: 'cancelled',
        partial: { statusReason: 'Edited; returned to composer for revision.' }
      },
      {
        operation: 'promote-steer',
        input: { runId: 'run-1', cancelRunId: 'run-2', provider: 'gemini' }
      },
      {
        operation: 'lease-promoted-steer',
        input: { runId: 'run-1', ownerToken: 'owner' }
      },
      {
        operation: 'fallback-promoted-steer',
        input: { runId: 'run-1', ownerToken: 'owner', reason: 'fallback' }
      }
    ])
    expect(authorize).toHaveBeenCalledWith(expect.anything(), {
      event,
      scope: { kind: 'main' }
    })
  })

  it('lets main authority reject graph-owned mutations before queue or steer services run', async () => {
    const deps = createDeps()
    deps.authorizeRendererRunQueueMutation = vi.fn((mutation) => {
      const targetIds =
        mutation.operation === 'request'
          ? [
              (mutation.job as { runId?: string }).runId,
              (mutation.job as { executionGraph?: unknown }).executionGraph
                ? 'graph-owned'
                : undefined
            ]
          : mutation.operation === 'lease'
            ? [mutation.request.runId]
            : mutation.operation === 'transition'
              ? [mutation.runIdOrId]
              : mutation.operation === 'promote-steer'
                ? [mutation.input.runId, mutation.input.cancelRunId]
                : [mutation.input.runId]
      if (targetIds.some((targetId) => targetId === 'graph-run' || targetId === 'graph-owned')) {
        throw new Error('Execution graph queue mutations require main authority.')
      }
    })
    registerRunQueueHandlers(deps)
    const event = { sender: { id: 42 } }

    expect(() =>
      handlerFor('request-run-queue-job')(event, {
        runId: 'graph-run',
        executionGraph: { executionId: 'execution-1' }
      })
    ).toThrow(/main authority/)
    expect(() => handlerFor('lease-run-queue-job')(event, { runId: 'graph-run' })).toThrow(
      /main authority/
    )
    expect(() =>
      handlerFor('transition-run-queue-job')(event, 'graph-run', 'cancelled', {
        statusReason: 'Edited; returned to composer for revision.'
      })
    ).toThrow(/main authority/)
    expect(() =>
      handlerFor('transition-run-queue-job')(event, 'graph-run', 'cancelled', {
        statusReason: 'Cancelled from the queued-messages above-row.'
      })
    ).toThrow(/main authority/)
    await expect(
      handlerFor('promote-queued-job-for-steer')(event, {
        runId: 'run-1',
        cancelRunId: 'graph-run'
      })
    ).rejects.toThrow(/main authority/)
    await expect(
      handlerFor('lease-promoted-steer-job')(event, {
        runId: 'graph-run',
        ownerToken: 'owner'
      })
    ).rejects.toThrow(/main authority/)
    await expect(
      handlerFor('fallback-promoted-steer-job')(event, {
        runId: 'graph-run',
        ownerToken: 'owner',
        reason: 'fallback'
      })
    ).rejects.toThrow(/main authority/)

    expect(deps.requestRunQueueJob).not.toHaveBeenCalled()
    expect(deps.leaseRunQueueJob).not.toHaveBeenCalled()
    expect(deps.transitionRunQueueJob).not.toHaveBeenCalled()
    expect(deps.getRunLifecycleCoordinator).not.toHaveBeenCalled()

    expect(handlerFor('lease-run-queue-job')(event, { runId: 'run-1' })).toMatchObject({
      runId: 'run-1'
    })
    expect(deps.leaseRunQueueJob).toHaveBeenCalledTimes(1)
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
