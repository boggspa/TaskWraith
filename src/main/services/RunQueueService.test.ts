import { describe, expect, it, vi } from 'vitest'
import {
  RunQueueService,
  type RunQueueRepository,
  type RunQueueServiceDeps,
  type RunQueueStore
} from './RunQueueService'
import type { RunSession } from '../RunManager'
import type {
  ChatRecord,
  ExternalPathGrant,
  RunQueueJob,
  RunQueueJobFilter,
  WorkspaceRecord
} from '../store/types'

function makeChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    provider: 'gemini',
    title: 'Chat',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function makeWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 'workspace-1',
    path: '/repo',
    displayName: 'repo',
    createdAt: 1,
    lastOpenedAt: 1,
    pinned: false,
    ...overrides
  }
}

function makeJob(overrides: Partial<RunQueueJob> = {}): RunQueueJob {
  return {
    id: 'run-1',
    runId: 'run-1',
    provider: 'gemini',
    scope: 'workspace',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    chatId: 'chat-1',
    source: 'manual',
    status: 'queued',
    priority: 0,
    attempt: 0,
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
    ...overrides
  }
}

function makeRepository(overrides: Partial<RunQueueRepository> = {}): RunQueueRepository {
  return {
    getRunQueueJobs: vi.fn(() => [makeJob()]),
    saveRunQueueJob: vi.fn((input) => makeJob(input)),
    leaseQueuedRun: vi.fn((input) =>
      makeJob({
        runId: input?.runId,
        provider: input?.provider ?? 'gemini',
        status: 'starting',
        statusReason: input?.statusReason
      })
    ),
    promoteQueuedJobForSteer: vi.fn((input) =>
      makeJob({
        runId: input?.runId || 'run-1',
        status: 'queued',
        statusReason: 'Steer promotion status updated.'
      })
    ),
    leasePromotedSteerJob: vi.fn((input) =>
      makeJob({
        runId: input?.runId,
        provider: 'gemini',
        status: 'starting',
        statusReason: input?.statusReason
      })
    ),
    fallbackPromotedSteerJob: vi.fn((input) =>
      makeJob({
        runId: input?.runId,
        provider: 'gemini',
        status: 'queued',
        statusReason: input?.reason
      })
    ),
    transitionRunQueueJob: vi.fn((runIdOrId, status, partial) =>
      makeJob({ id: runIdOrId, runId: runIdOrId, status, ...partial })
    ),
    persistSessionQueueState: vi.fn(),
    ...overrides
  }
}

function makeStore(overrides: Partial<RunQueueStore> = {}): RunQueueStore {
  return {
    getChat: vi.fn(() => makeChat()),
    getRunQueueJob: vi.fn(() => makeJob()),
    getRunQueueJobs: vi.fn(() => [makeJob()]),
    ...overrides
  }
}

function makeDeps(overrides: Partial<RunQueueServiceDeps> = {}): {
  deps: RunQueueServiceDeps
  repository: RunQueueRepository
  store: RunQueueStore
} {
  const repository = makeRepository()
  const store = makeStore()
  const deps: RunQueueServiceDeps = {
    appStore: store,
    getRunRepository: vi.fn(() => repository),
    normalizeExternalPathGrants: vi.fn((grants: ExternalPathGrant[]) => grants),
    requireGlobalChat: vi.fn(() =>
      makeChat({ scope: 'global', workspaceId: undefined, workspacePath: undefined })
    ),
    requireRegisteredWorkspace: vi.fn(() => '/repo'),
    findRegisteredWorkspace: vi.fn(() => makeWorkspace()),
    validateChatWorkspaceIdentity: vi.fn(),
    canLeaseJob: vi.fn(() => true),
    ...overrides
  }
  return {
    deps,
    repository: deps.getRunRepository(),
    store: deps.appStore
  }
}

describe('RunQueueService', () => {
  it('forwards getJobs filters to the run repository', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    const filter: RunQueueJobFilter = { provider: 'gemini', statuses: ['queued'] }
    expect(service.getJobs(filter)).toEqual([makeJob()])
    expect(repository.getRunQueueJobs).toHaveBeenCalledWith(filter)
  })

  it('normalizes and saves workspace run queue requests', () => {
    const grant: ExternalPathGrant = {
      id: 'grant-1',
      provider: 'codex',
      path: '/outside',
      kind: 'directory',
      access: 'read',
      duration: 'thisThread',
      createdAt: '2026-05-16T00:00:00.000Z',
      issuedBy: 'main',
      signature: 'sig'
    }
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    service.requestJob({
      id: 'queue-id',
      runId: 'run-1',
      provider: 'codex',
      workspacePath: '/input',
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      source: 'scheduled',
      status: 'active',
      priority: 4,
      request: {
        prompt: 'Ship it',
        imageAttachments: [{ id: 'img-1', path: '/tmp/a.png', name: 'a.png' }],
        discordContextSelection: {
          guildId: '456789012345678901',
          guildName: 'Task Team',
          channelId: '123456789012345678',
          channelName: 'build-help',
          limit: 50
        },
        externalPathGrants: [grant],
        remoteComposer: {
          workspaceId: 'workspace-1',
          threadId: 'thread-1',
          provider: 'codex',
          text: 'Ship it from remote',
          approvalMode: 'default',
          model: 'opus',
          reasoningEffort: 'low',
          contextTurns: 3
        },
        guestParentChatId: 'guest-thread-1',
        guestRole: 'assistant',
        geminiAuthProfileId: 'gauth-1',
        codexReasoningEffort: 'minimal',
        geminiWorktree: { enabled: true, name: 'feature' }
      }
    })
    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/input')
    expect(deps.validateChatWorkspaceIdentity).toHaveBeenCalledWith('chat-1', makeWorkspace())
    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'queue-id',
        runId: 'run-1',
        provider: 'codex',
        scope: 'workspace',
        workspacePath: '/repo',
        workspaceId: 'workspace-1',
        source: 'scheduled',
        status: 'starting',
        priority: 4,
        request: expect.objectContaining({
          prompt: 'Ship it',
          selectedModelType: 'cli-default',
          customModel: '',
          approvalMode: 'default',
          sessionTrust: false,
          imageAttachments: [{ id: 'img-1', path: '/tmp/a.png', name: 'a.png' }],
          discordContextSelection: {
            guildId: '456789012345678901',
            guildName: 'Task Team',
            channelId: '123456789012345678',
            channelName: 'build-help',
            limit: 50
          },
          remoteComposer: {
            workspaceId: 'workspace-1',
            threadId: 'thread-1',
            provider: 'codex',
            text: 'Ship it from remote',
            approvalMode: 'default',
            model: 'opus',
            reasoningEffort: 'low',
            contextTurns: 3
          },
          externalPathGrants: [grant],
          guestParentChatId: 'guest-thread-1',
          guestRole: 'assistant',
          geminiAuthProfileId: 'gauth-1',
          codexReasoningEffort: 'minimal',
          geminiWorktree: { enabled: true, name: 'feature' }
        })
      })
    )
  })

  it('normalizes global queue requests through the saved global chat guard', () => {
    const { deps, repository } = makeDeps({
      appStore: makeStore({ getChat: vi.fn(() => makeChat({ scope: 'global' })) })
    })
    const service = new RunQueueService(deps)
    service.requestJob({
      runId: 'global-run',
      provider: 'gemini',
      scope: 'global',
      chatId: 'global-chat'
    })
    expect(deps.requireGlobalChat).toHaveBeenCalledWith('global-chat', 'Run queue global chat')
    expect(deps.requireRegisteredWorkspace).not.toHaveBeenCalled()
    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'global-run',
        scope: 'global',
        workspacePath: undefined,
        workspaceId: undefined
      })
    )
  })

  it('preserves remote source and remoteComposer snapshot fields', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    service.requestJob({
      runId: 'remote-run',
      provider: 'codex',
      workspacePath: '/input',
      chatId: 'chat-1',
      source: 'remote',
      request: {
        prompt: 'From device',
        remoteComposer: {
          workspaceId: 'workspace-1',
          threadId: 'thread-2',
          provider: 'codex',
          text: 'From paired device',
          approvalMode: 'default',
          model: 'opus'
        }
      }
    })
    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'remote-run',
        source: 'remote',
        request: expect.objectContaining({
          remoteComposer: {
            workspaceId: 'workspace-1',
            threadId: 'thread-2',
            provider: 'codex',
            text: 'From paired device',
            approvalMode: 'default',
            model: 'opus'
          }
        })
      })
    )
  })

  it('rejects invalid request objects before persisting', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    expect(() => service.requestJob(null)).toThrow('Run queue request must be an object.')
    expect(() => service.requestJob({ provider: 'bad' })).toThrow('Provider is invalid.')
    expect(repository.saveRunQueueJob).not.toHaveBeenCalled()
  })

  it('admits cursor as a provider (gate on by default) so queued/scheduled runs work', () => {
    const { deps } = makeDeps()
    const service = new RunQueueService(deps)
    // Cursor passes provider validation (it may still fail later validation for
    // other missing fields, but never with the provider error). Mirrors grok.
    expect(() => service.requestJob({ provider: 'cursor' })).not.toThrow('Provider is invalid.')
  })

  it('preserves external grant validation failures', () => {
    const { deps, repository } = makeDeps({
      normalizeExternalPathGrants: vi.fn(() => [])
    })
    const service = new RunQueueService(deps)
    expect(() =>
      service.requestJob({
        provider: 'codex',
        workspacePath: '/input',
        request: {
          externalPathGrants: [{ id: 'grant-1' }]
        }
      })
    ).toThrow('Queued external path grants must be issued by TaskWraith in this app session.')
    expect(repository.saveRunQueueJob).not.toHaveBeenCalled()
  })

  it('leases queued jobs only when provider and chat-capacity gates pass', () => {
    const { deps, repository, store } = makeDeps()
    const service = new RunQueueService(deps)
    expect(service.leaseJob({ provider: 'gemini' })).toEqual(
      makeJob({
        status: 'starting',
        statusReason: 'Leased by TaskWraith main scheduler.'
      })
    )
    expect(store.getRunQueueJobs).toHaveBeenCalledWith({ provider: 'gemini', statuses: ['queued'] })
    expect(repository.leaseQueuedRun).toHaveBeenCalledWith({
      runId: 'run-1',
      provider: 'gemini',
      statusReason: 'Leased by TaskWraith main scheduler.'
    })
  })

  it('skips busy same-provider chats when leasing the next queued job', () => {
    const busyJob = makeJob({
      id: 'run-busy',
      runId: 'run-busy',
      provider: 'codex',
      chatId: 'chat-busy'
    })
    const idleJob = makeJob({
      id: 'run-idle',
      runId: 'run-idle',
      provider: 'codex',
      chatId: 'chat-idle'
    })
    const store = makeStore({
      getRunQueueJobs: vi.fn(() => [busyJob, idleJob])
    })
    const canLeaseJob = vi.fn((job: RunQueueJob) => job.chatId !== 'chat-busy')
    const { deps, repository } = makeDeps({ appStore: store, canLeaseJob })
    const service = new RunQueueService(deps)

    expect(service.leaseJob({ provider: 'codex' })).toEqual(
      makeJob({
        runId: 'run-idle',
        provider: 'codex',
        status: 'starting',
        statusReason: 'Leased by TaskWraith main scheduler.'
      })
    )
    expect(canLeaseJob).toHaveBeenCalledWith(busyJob)
    expect(canLeaseJob).toHaveBeenCalledWith(idleJob)
    expect(repository.leaseQueuedRun).toHaveBeenCalledWith({
      runId: 'run-idle',
      provider: 'codex',
      statusReason: 'Leased by TaskWraith main scheduler.'
    })
  })

  it('returns null from leaseJob for non-queued, provider mismatch, or busy target chat cases', () => {
    const nonQueuedStore = makeStore({ getRunQueueJob: vi.fn(() => makeJob({ status: 'active' })) })
    const nonQueuedDeps = makeDeps({ appStore: nonQueuedStore })
    expect(new RunQueueService(nonQueuedDeps.deps).leaseJob({ runId: 'run-1' })).toBeNull()

    const mismatchStore = makeStore({ getRunQueueJob: vi.fn(() => makeJob({ provider: 'codex' })) })
    const mismatchDeps = makeDeps({ appStore: mismatchStore })
    expect(
      new RunQueueService(mismatchDeps.deps).leaseJob({ runId: 'run-1', provider: 'gemini' })
    ).toBeNull()

    const activeDeps = makeDeps({ canLeaseJob: vi.fn(() => false) })
    expect(new RunQueueService(activeDeps.deps).leaseJob({ runId: 'run-1' })).toBeNull()
    expect(activeDeps.repository.leaseQueuedRun).not.toHaveBeenCalled()
  })

  it('delegates steer promotion lease/fallback calls through repository API boundaries', () => {
    const store = makeStore({ getRunQueueJob: vi.fn(() => makeJob({ status: 'steer_promoting' })) })
    const { deps, repository } = makeDeps({ appStore: store })
    const service = new RunQueueService(deps)
    expect(service.promoteQueuedJobForSteer({ runId: 'run-1', ownerToken: 'owner-1' })).toEqual(
      makeJob({
        status: 'queued',
        statusReason: 'Steer promotion status updated.'
      })
    )
    expect(repository.promoteQueuedJobForSteer).toHaveBeenCalledWith({
      runId: 'run-1',
      ownerToken: 'owner-1'
    })

    expect(service.leasePromotedSteerJob({ runId: 'run-1', ownerToken: 'owner-1' })).toEqual(
      makeJob({ status: 'starting', runId: 'run-1' })
    )
    expect(repository.leasePromotedSteerJob).toHaveBeenCalledWith({
      runId: 'run-1',
      ownerToken: 'owner-1',
      statusReason: undefined
    })

    expect(
      service.fallbackPromotedSteerJob({ runId: 'run-1', ownerToken: 'owner-1', reason: 'retry-queued' })
    ).toEqual(makeJob({ status: 'queued', runId: 'run-1', statusReason: 'retry-queued' }))
    expect(repository.fallbackPromotedSteerJob).toHaveBeenCalledWith({
      runId: 'run-1',
      ownerToken: 'owner-1',
      reason: 'retry-queued'
    })

    service.fallbackPromotedSteerJob({
      runId: 'run-1',
      ownerToken: 'owner-1',
      reason: 'lease failed',
      fallbackStatus: 'queued'
    })
    expect(repository.fallbackPromotedSteerJob).toHaveBeenLastCalledWith({
      runId: 'run-1',
      ownerToken: 'owner-1',
      reason: 'lease failed',
      fallbackStatus: 'queued'
    })
  })

  it('rejects promoted steer leases when the target chat is still busy', () => {
    const promoted = makeJob({ status: 'steer_promoting', chatId: 'chat-busy' })
    const store = makeStore({ getRunQueueJob: vi.fn(() => promoted) })
    const canLeaseJob = vi.fn(() => false)
    const { deps, repository } = makeDeps({ appStore: store, canLeaseJob })
    const service = new RunQueueService(deps)

    expect(service.leasePromotedSteerJob({ runId: 'run-1', ownerToken: 'owner-1' })).toBeNull()
    expect(canLeaseJob).toHaveBeenCalledWith(promoted)
    expect(repository.leasePromotedSteerJob).not.toHaveBeenCalled()
  })

  it('sanitizes transition status and partial fields before delegating', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    service.transitionJob('run-1', 'steer_promoting', {
      statusReason: ' steer '
    })
    expect(repository.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'steer_promoting', {
      statusReason: ' steer ',
      lastError: undefined
    })

    service.transitionJob('run-1', 'not-a-status' as RunQueueJob['status'], {
      statusReason: ' reason ',
      lastError: 'boom',
      promptPreview: 'ignored'
    })
    expect(repository.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'queued', {
      statusReason: ' reason ',
      lastError: 'boom'
    })
  })

  it('delegates session queue persistence to the repository', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    const session = {
      runId: 'run-1',
      provider: 'gemini',
      status: 'running'
    } as RunSession
    service.persistSessionQueueState(session)
    expect(repository.persistSessionQueueState).toHaveBeenCalledWith(session)
  })
})
