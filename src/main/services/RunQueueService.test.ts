import { describe, expect, it, vi } from 'vitest'
import {
  RunQueueService,
  type RunQueueRepository,
  type RunQueueServiceDeps,
  type RunQueueStore
} from './RunQueueService'
import type { RunSession } from '../RunManager'
import { MAX_DURABLE_ATTACHMENT_REFS } from '../ScheduledAttachmentDurability'
import {
  signRunPermissionPosture,
  verifyRunPermissionPosture
} from '../RunPermissionPosture'
import {
  buildExecutionGraphPermissionPosture,
  mintExecutionGraphAttemptPermissionPosture
} from '../executionGraph/ExecutionGraphPermissionAuthority'
import { executionGraphRunTemplatePermissionCeilingDigest } from '../executionGraph/ExecutionGraphRunTemplateAuthority'
import type { JsonObject } from '../executionGraph/ExecutionGraphModel'
import type {
  AppSettings,
  ChatRecord,
  ExternalPathGrant,
  RunQueueJob,
  RunQueueJobFilter,
  RunQueueRequestSnapshot,
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

function oversizedDurableAttachments() {
  return Array.from({ length: MAX_DURABLE_ATTACHMENT_REFS + 1 }, (_, index) => ({
    persistenceVersion: 1 as const,
    id: `durable-${index}`,
    path: `/main-owned/transcript-media/aa/${'a'.repeat(43)}.png`,
    name: `durable-${index}.png`,
    sha256: 'a'.repeat(43),
    mimeType: 'image/png',
    byteLength: 68
  }))
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
    stageAttachments: vi.fn((input) => ({
      ok: true as const,
      attachments: input.attachments.map((attachment, index) => ({
        persistenceVersion: 1 as const,
        id: attachment.id,
        path: `/main-owned/transcript-media/ab/abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ-${index}.png`,
        name: attachment.name,
        sha256: 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
        mimeType: 'image/png',
        byteLength: 68
      }))
    })),
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
  it('prepares a validated request snapshot without publishing a queue job', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)

    const prepared = service.prepareJob({
      runId: 'graph-template-probe',
      provider: 'codex',
      workspacePath: '/repo',
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      source: 'system',
      status: 'paused',
      request: {
        prompt: 'Continue with the next Stack step',
        selectedModelType: 'default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: []
      }
    })

    expect(prepared).toMatchObject({
      runId: 'graph-template-probe',
      provider: 'codex',
      source: 'system',
      status: 'paused',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      request: { prompt: 'Continue with the next Stack step' }
    })
    expect(prepared.dispatchReceipt?.receiptHash).toBeTruthy()
    expect(repository.saveRunQueueJob).not.toHaveBeenCalled()
  })

  it('accepts execution-graph correlation only through the main-owned options channel', () => {
    const { deps } = makeDeps()
    const service = new RunQueueService(deps)
    const input = {
      runId: 'graph-run-one',
      provider: 'codex',
      workspacePath: '/repo',
      workspaceId: 'workspace-1',
      chatId: 'chat-1',
      source: 'system',
      status: 'paused',
      request: {
        prompt: 'Run the claimed graph step.',
        selectedModelType: 'default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: []
      },
      executionGraph: {
        schemaVersion: 1,
        executionId: 'forged-execution',
        activationId: 'forged-activation',
        attemptId: 'forged-attempt',
        runTemplateRef: `run-template-${'f'.repeat(64)}`,
        permissionCeilingAuthorityDigest: 'f'.repeat(64)
      }
    }
    const binding = {
      schemaVersion: 1 as const,
      executionId: 'execution-one',
      activationId: 'activation-one',
      attemptId: 'attempt-one',
      runTemplateRef: `run-template-${'a'.repeat(64)}`,
      permissionCeilingAuthorityDigest: 'b'.repeat(64)
    }

    expect(service.prepareJob(input).executionGraph).toBeUndefined()
    expect(service.prepareJob(input, { executionGraph: binding }).executionGraph).toEqual(binding)
    expect(() =>
      service.prepareJob(input, {
        executionGraph: { ...binding, permissionCeilingAuthorityDigest: 'not-a-digest' }
      })
    ).toThrow(/queue binding is invalid/i)
  })

  it('preserves the frozen permission ceiling while normalizing a run-bound graph posture', () => {
    const { deps } = makeDeps()
    const service = new RunQueueService(deps)
    const secret = 'run-queue-graph-ceiling-test-secret'
    const request: RunQueueRequestSnapshot = {
      scope: 'workspace',
      prompt: 'Run the claimed graph step.',
      selectedModelType: 'default',
      customModel: '',
      approvalMode: 'default',
      permissionPresetId: 'workspace_write',
      sessionTrust: false,
      imageAttachments: []
    }
    const settings = {
      agenticServices: {
        shellCommands: 'ask',
        fileChanges: 'ask',
        externalPublish: 'ask',
        mcpTools: 'ask',
        subThreadDelegation: 'ask',
        canvasInteraction: 'ask',
        crossThreadRead: 'ask',
        mediaEditing: 'ask',
        mediaRecording: 'deny',
        canvasEval: 'ask',
        networkAccess: 'allow'
      },
      agenticWorkspaceGrants: []
    } as Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
    const sign = (approvalMode: string, permissions: Parameters<typeof signRunPermissionPosture>[2], context: Parameters<typeof signRunPermissionPosture>[3]) =>
      signRunPermissionPosture(secret, approvalMode, permissions, context)
    const verify = (
      approvalMode: string,
      permissions: Parameters<typeof verifyRunPermissionPosture>[2],
      signature: string,
      context: Parameters<typeof verifyRunPermissionPosture>[4]
    ) => verifyRunPermissionPosture(secret, approvalMode, permissions, signature, context)
    const templatePosture = buildExecutionGraphPermissionPosture({
      provider: 'codex',
      workspacePath: '/repo',
      chatId: 'chat-1',
      request,
      settings,
      sign
    })
    const templateContent = {
      schemaVersion: 1,
      provider: 'codex',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      chatId: 'chat-1',
      request,
      permissionPosture: templatePosture
    } as unknown as JsonObject
    const frozenCeiling = executionGraphRunTemplatePermissionCeilingDigest(templateContent)
    const attemptPosture = mintExecutionGraphAttemptPermissionPosture({
      appRunId: 'graph-run-one',
      provider: 'codex',
      workspacePath: '/repo',
      chatId: 'chat-1',
      request,
      templatePosture,
      sign,
      verifyTemplate: verify
    })

    const prepared = service.prepareJob(
      {
        runId: 'graph-run-one',
        provider: 'codex',
        workspacePath: '/repo',
        workspaceId: 'workspace-1',
        chatId: 'chat-1',
        source: 'system',
        status: 'paused',
        request,
        permissionPosture: attemptPosture
      },
      {
        executionGraph: {
          schemaVersion: 1,
          executionId: 'execution-one',
          activationId: 'activation-one',
          attemptId: 'attempt-one',
          runTemplateRef: `run-template-${'a'.repeat(64)}`,
          permissionCeilingAuthorityDigest: frozenCeiling
        }
      }
    )

    expect(
      executionGraphRunTemplatePermissionCeilingDigest({
        ...templateContent,
        request: prepared.request!,
        permissionPosture: prepared.permissionPosture!
      } as unknown as JsonObject)
    ).toBe(frozenCeiling)
  })

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
        dmTargetParticipantId: 'participant-codex',
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
        effectiveWorkspacePath: '/repo-worktrees/queued-feature',
        geminiAuthProfileId: 'gauth-1',
        codexReasoningEffort: 'minimal',
        kimiFastMode: true,
        kimiThinkingEnabled: false,
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
          dmTargetParticipantId: 'participant-codex',
          selectedModelType: 'cli-default',
          customModel: '',
          approvalMode: 'default',
          sessionTrust: false,
          imageAttachments: [
            {
              persistenceVersion: 1,
              id: 'img-1',
              path: '/main-owned/transcript-media/ab/abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ-0.png',
              name: 'a.png',
              sha256: 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
              mimeType: 'image/png',
              byteLength: 68
            }
          ],
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
          effectiveWorkspacePath: '/repo-worktrees/queued-feature',
          geminiAuthProfileId: 'gauth-1',
          codexReasoningEffort: 'minimal',
          kimiFastMode: true,
          kimiThinkingEnabled: false,
          geminiWorktree: { enabled: true, name: 'feature' }
        })
      })
    )
    expect(deps.stageAttachments).toHaveBeenCalledWith({
      runId: 'run-1',
      provider: 'codex',
      source: 'scheduled',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      externalPathGrants: [grant],
      attachments: [{ id: 'img-1', path: '/tmp/a.png', name: 'a.png' }]
    })
  })

  it('persists a visible failed row without raw paths when fresh attachment staging fails', () => {
    const { deps, repository } = makeDeps({
      stageAttachments: vi.fn(() => ({
        ok: false as const,
        reason: 'Selected attachment changed.'
      }))
    })
    const service = new RunQueueService(deps)

    service.requestJob({
      runId: 'run-attachment-failed',
      provider: 'codex',
      workspacePath: '/repo',
      chatId: 'chat-1',
      request: {
        prompt: 'Use this image',
        imageAttachments: [{ id: 'img-1', path: '/tmp/replaceable.png', name: 'image.png' }]
      }
    })

    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-attachment-failed',
        status: 'failed',
        statusReason: expect.stringContaining('Re-select the attachments'),
        lastError: expect.stringContaining('Re-select the attachments'),
        request: expect.objectContaining({ imageAttachments: [] })
      })
    )
    expect(JSON.stringify(vi.mocked(repository.saveRunQueueJob).mock.calls[0][0])).not.toContain(
      '/tmp/replaceable.png'
    )
  })

  it('quarantines attachment arrays above the main-authority ceiling before staging', () => {
    const stageAttachments = vi.fn(() => ({ ok: true as const, attachments: [] }))
    const { deps, repository } = makeDeps({ stageAttachments })
    const service = new RunQueueService(deps)

    service.requestJob({
      runId: 'run-attachment-overflow',
      provider: 'codex',
      workspacePath: '/repo',
      chatId: 'chat-1',
      request: {
        prompt: 'Use too many images',
        imageAttachments: Array.from({ length: MAX_DURABLE_ATTACHMENT_REFS + 1 }, (_, index) => ({
          id: `img-${index}`,
          path: `/tmp/private-${index}.png`,
          name: `image-${index}.png`
        }))
      }
    })

    expect(stageAttachments).not.toHaveBeenCalled()
    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-attachment-overflow',
        status: 'failed',
        request: expect.objectContaining({ imageAttachments: [] })
      })
    )
    expect(JSON.stringify(vi.mocked(repository.saveRunQueueJob).mock.calls[0][0])).not.toContain(
      '/tmp/private-'
    )
  })

  it('stages fresh attachments with only the requesting renderer capability paths', () => {
    const stageAttachments = vi.fn(() => ({ ok: false as const, reason: 'not authorized' }))
    const { deps } = makeDeps({ stageAttachments })
    const service = new RunQueueService(deps)

    service.requestJob(
      {
        runId: 'run-renderer-capability',
        provider: 'codex',
        workspacePath: '/repo',
        chatId: 'chat-1',
        request: {
          prompt: 'Use this image',
          imageAttachments: [{ path: '/tmp/Test 1/one.png', name: 'one.png' }]
        }
      },
      { authorizedFilePaths: ['/tmp/Test 1/one.png'] }
    )

    expect(stageAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        authorizedFilePaths: ['/tmp/Test 1/one.png']
      })
    )
    expect(stageAttachments).not.toHaveBeenCalledWith(
      expect.objectContaining({
        authorizedFilePaths: expect.arrayContaining(['/tmp/Test 3/three.png'])
      })
    )
  })

  it('passes durable identity fields to staging so re-queued assets can be revalidated, not reopened as raw paths', () => {
    const stageAttachments = vi.fn((input) => ({
      ok: true as const,
      attachments: input.attachments.filter(
        (attachment): attachment is Extract<typeof attachment, { persistenceVersion: 1 }> =>
          attachment.persistenceVersion === 1
      )
    }))
    const { deps } = makeDeps({ stageAttachments })
    const service = new RunQueueService(deps)
    const durable = {
      persistenceVersion: 1 as const,
      id: 'img-1',
      path: '/main-owned/transcript-media/ab/abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ.png',
      name: 'image.png',
      sha256: 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
      mimeType: 'image/png',
      byteLength: 68
    }

    service.requestJob({
      runId: 'run-durable',
      provider: 'codex',
      workspacePath: '/repo',
      chatId: 'chat-1',
      request: { prompt: 'again', imageAttachments: [durable] }
    })

    expect(stageAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [durable] })
    )
  })

  it('quarantines legacy raw-path queue rows on read without staging replacement bytes', () => {
    const legacy = makeJob({
      request: {
        prompt: 'legacy',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: [{ id: 'old', path: '/tmp/replaced.png', name: 'old.png' }]
      } as unknown as RunQueueJob['request']
    })
    const repository = makeRepository({ getRunQueueJobs: vi.fn(() => [legacy]) })
    const stageAttachments = vi.fn(() => ({ ok: true as const, attachments: [] }))
    const { deps } = makeDeps({
      getRunRepository: vi.fn(() => repository),
      stageAttachments
    })
    const service = new RunQueueService(deps)

    const [quarantined] = service.getJobs()
    expect(quarantined).toMatchObject({
      status: 'failed',
      request: { imageAttachments: [] },
      lastError: expect.stringContaining('Re-select the attachments')
    })
    expect(repository.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'failed', {
      statusReason: expect.stringContaining('Re-select the attachments'),
      lastError: expect.stringContaining('Re-select the attachments')
    })
    expect(stageAttachments).not.toHaveBeenCalled()

    expect(service.getJobs({ statuses: ['queued'] })).toEqual([])
  })

  it('refuses to lease a legacy raw-path row and never re-stages it', () => {
    const legacy = makeJob({
      request: {
        prompt: 'legacy',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: [{ id: 'old', path: '/tmp/replaced.png', name: 'old.png' }]
      } as unknown as RunQueueJob['request']
    })
    const store = makeStore({ getRunQueueJob: vi.fn(() => legacy) })
    const stageAttachments = vi.fn(() => ({ ok: true as const, attachments: [] }))
    const { deps, repository } = makeDeps({ appStore: store, stageAttachments })
    const service = new RunQueueService(deps)

    expect(service.leaseJob({ runId: 'run-1' })).toBeNull()
    expect(repository.leaseQueuedRun).not.toHaveBeenCalled()
    expect(repository.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'failed', {
      statusReason: expect.stringContaining('Re-select the attachments'),
      lastError: expect.stringContaining('Re-select the attachments')
    })
    expect(stageAttachments).not.toHaveBeenCalled()
  })

  it('quarantines an oversized all-durable queue row when listing jobs', () => {
    const oversized = makeJob({
      request: {
        prompt: 'oversized durable row',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: oversizedDurableAttachments()
      }
    })
    const repository = makeRepository({ getRunQueueJobs: vi.fn(() => [oversized]) })
    const { deps } = makeDeps({ getRunRepository: vi.fn(() => repository) })
    const service = new RunQueueService(deps)

    expect(service.getJobs()).toEqual([
      expect.objectContaining({
        status: 'failed',
        request: expect.objectContaining({ imageAttachments: [] })
      })
    ])
    expect(repository.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'failed', {
      statusReason: expect.stringContaining('Re-select the attachments'),
      lastError: expect.stringContaining('Re-select the attachments')
    })
  })

  it('refuses to lease an oversized all-durable queue row', () => {
    const oversized = makeJob({
      request: {
        prompt: 'oversized durable row',
        selectedModelType: 'cli-default',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: oversizedDurableAttachments()
      }
    })
    const store = makeStore({ getRunQueueJob: vi.fn(() => oversized) })
    const { deps, repository } = makeDeps({ appStore: store })
    const service = new RunQueueService(deps)

    expect(service.leaseJob({ runId: 'run-1' })).toBeNull()
    expect(repository.leaseQueuedRun).not.toHaveBeenCalled()
    expect(repository.transitionRunQueueJob).toHaveBeenCalledWith('run-1', 'failed', {
      statusReason: expect.stringContaining('Re-select the attachments'),
      lastError: expect.stringContaining('Re-select the attachments')
    })
  })

  it('normalizes global queue requests through the saved global chat guard', () => {
    const { deps, repository } = makeDeps({
      appStore: makeStore({ getChat: vi.fn(() => makeChat({ scope: 'global' })) })
    })
    const service = new RunQueueService(deps)
    service.requestJob({
      runId: 'global-run',
      provider: 'codex',
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

  it('does not allow generic queue requests to create steer promotion rows', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    service.requestJob({
      runId: 'run-1',
      provider: 'codex',
      workspacePath: '/input',
      chatId: 'chat-1',
      status: 'steer_promoting'
    })
    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'queued'
      })
    )
  })

  it('preserves ensemble lane and stage metadata on generic queue requests', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    const permissionPosture = {
      schemaVersion: 1,
      approvalMode: 'plan',
      workflowMode: 'plan',
      presetId: 'plan',
      readOnly: true,
      networkAccess: 'deny',
      externalPathGrantCount: 0,
      postureHash: 'posture-hash',
      signature: 'signed-posture',
      signaturePresent: true
    } as const
    service.requestJob({
      runId: 'ensemble-run',
      provider: 'codex',
      workspacePath: '/input',
      chatId: 'chat-1',
      source: 'scheduled',
      ensembleParticipantId: 'participant-codex',
      ensembleLaneId: 'lane-round-1-participant-codex-1',
      ensembleRole: 'Worker',
      ensembleStageRole: 'worker',
      request: {
        prompt: 'Review the worker patch',
        approvalMode: 'plan',
        workflowMode: 'plan'
      },
      permissionPosture
    })
    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'ensemble-run',
        ensembleParticipantId: 'participant-codex',
        ensembleLaneId: 'lane-round-1-participant-codex-1',
        ensembleRole: 'Worker',
        ensembleStageRole: 'worker',
        permissionPosture: expect.objectContaining({
          postureHash: 'posture-hash',
          workflowMode: 'plan',
          presetId: 'plan',
          signaturePresent: true
        }),
        dispatchReceipt: expect.objectContaining({
          schemaVersion: 1,
          runId: 'ensemble-run',
          provider: 'codex',
          source: 'scheduled',
          workspaceId: 'workspace-1',
          chatId: 'chat-1',
          ensembleParticipantId: 'participant-codex',
          ensembleLaneId: 'lane-round-1-participant-codex-1',
          ensembleRole: 'Worker',
          ensembleStageRole: 'worker',
          approvalMode: 'plan',
          workflowMode: 'plan',
          permissionPresetId: 'plan',
          readOnly: true,
          permissionPostureHash: 'posture-hash',
          permissionPostureSignaturePresent: true,
          receiptHash: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
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
        workflowMode: 'plan',
        remoteComposer: {
          workspaceId: 'workspace-1',
          threadId: 'thread-2',
          provider: 'codex',
          text: 'From paired device',
          approvalMode: 'default',
          workflowMode: 'plan',
          permissionPresetId: 'full_access',
          model: 'opus',
          scheduledRunAt: '2026-07-08T21:15:00.000Z'
        },
        scheduledRunAt: '2026-07-08T21:15:00.000Z'
      }
    })
    expect(repository.saveRunQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'remote-run',
        source: 'remote',
        request: expect.objectContaining({
          workflowMode: 'plan',
          remoteComposer: {
            workspaceId: 'workspace-1',
            threadId: 'thread-2',
            provider: 'codex',
            text: 'From paired device',
            approvalMode: 'default',
            workflowMode: 'plan',
            permissionPresetId: 'full_access',
            model: 'opus',
            scheduledRunAt: '2026-07-08T21:15:00.000Z'
          },
          scheduledRunAt: '2026-07-08T21:15:00.000Z'
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

  it('rejects Cursor before a new queue job is persisted', () => {
    const { deps, repository } = makeDeps()
    const service = new RunQueueService(deps)
    expect(() => service.requestJob({ provider: 'cursor' })).toThrow(
      'Provider is unavailable for new runs.'
    )
    expect(repository.saveRunQueueJob).not.toHaveBeenCalled()
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

  it('leases queued jobs with optional chat + provider filters for lifecycle dispatch', () => {
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
    expect(service.leaseQueuedJob({ provider: 'codex', chatId: 'chat-idle' })).toEqual(
      makeJob({
        runId: 'run-idle',
        provider: 'codex',
        status: 'starting',
        statusReason: 'Leased by TaskWraith main scheduler.'
      })
    )
    expect(store.getRunQueueJobs).toHaveBeenCalledWith({
      provider: 'codex',
      chatId: 'chat-idle',
      statuses: ['queued']
    })
    expect(repository.leaseQueuedRun).toHaveBeenCalledWith({
      runId: 'run-idle',
      provider: 'codex',
      statusReason: 'Leased by TaskWraith main scheduler.'
    })
    expect(canLeaseJob).toHaveBeenCalledWith(busyJob)
    expect(canLeaseJob).toHaveBeenCalledWith(idleJob)
  })

  it('returns null when a queued job candidate is not in the queued status', () => {
    const store = makeStore({
      getRunQueueJobs: vi.fn(() => [makeJob({ status: 'steer_promoting' })])
    })
    const { deps, repository } = makeDeps({ appStore: store })
    const service = new RunQueueService(deps)
    expect(service.leaseQueuedJob({ provider: 'gemini' })).toBeNull()
    expect(repository.leaseQueuedRun).not.toHaveBeenCalled()
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
      service.fallbackPromotedSteerJob({
        runId: 'run-1',
        ownerToken: 'owner-1',
        reason: 'retry-queued'
      })
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
    const promoted = service.transitionJob('run-1', 'steer_promoting', {
      statusReason: ' steer '
    })
    expect(promoted).toBeNull()
    expect(repository.transitionRunQueueJob).not.toHaveBeenCalled()

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
