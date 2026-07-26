import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  executionGraphRunTemplateAuthorityDigest,
  executionGraphRunTemplatePermissionCeilingDigest
} from '../executionGraph/ExecutionGraphRunTemplateAuthority'
import type { ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import type {
  RunPermissionPostureSnapshot,
  RunQueueJob,
  RunQueueRequestSnapshot
} from '../store/types'
import type {
  ExecutionGraphDiagnosticsSnapshot,
  ExecutionGraphHandlersDeps
} from './executionGraphHandlers'
import {
  registerExecutionGraphDiagnosticsHandler,
  registerExecutionGraphHandlers
} from './executionGraphHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)
type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([candidate]) => candidate === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function projection(overrides: Partial<ExecutionRunProjection> = {}): ExecutionRunProjection {
  return {
    executionId: 'stack-one',
    title: 'My Stack',
    workspaceId: 'workspace-one',
    tenant: { kind: 'stack' },
    rootChatId: 'chat-one',
    state: 'waiting',
    topology: { steps: [], edges: [] },
    topologyDigest: 'a'.repeat(64),
    activations: {},
    attempts: {},
    eventCount: 1,
    lastSequence: 1,
    integrity: 'valid',
    baseRevisionMissing: false,
    diagnostics: [],
    ...overrides
  }
}

function preparedRequest(
  overrides: Partial<RunQueueRequestSnapshot> = {}
): RunQueueRequestSnapshot {
  return {
    scope: 'workspace',
    prompt: 'Inspect this change.',
    selectedModelType: 'default',
    customModel: '',
    approvalMode: 'auto',
    permissionPresetId: 'workspace_write',
    sessionTrust: true,
    imageAttachments: [],
    ...overrides
  }
}

function preparedJob(
  requestOverrides: Partial<RunQueueRequestSnapshot> = {},
  jobOverrides: Partial<RunQueueJob> = {}
): Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'> {
  return {
    id: 'graph-template-probe-test',
    runId: 'graph-template-probe-test',
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'workspace-one',
    workspacePath: '/workspace',
    chatId: 'chat-one',
    source: 'system',
    status: 'paused',
    ...jobOverrides,
    request: preparedRequest(requestOverrides)
  }
}

function appendStackStep(handler: RegisteredHandler): unknown {
  return handler(
    {},
    {
      clientRequestId: 'renderer-run-admission',
      workspaceId: 'workspace-one',
      rootChatId: 'chat-one',
      provider: 'codex',
      stepTitle: 'Inspect the change',
      objective: 'Inspect this change.',
      request: { prompt: 'Inspect this change.' }
    }
  )
}

function createDeps(): ExecutionGraphHandlersDeps {
  const current = projection()
  return {
    assertMainRendererSender: vi.fn(),
    assertLocalChatHistoryDurable: vi.fn(),
    resolveStackTarget: vi.fn(() => ({
      workspaceId: 'workspace-one',
      workspacePath: '/workspace',
      rootChatId: 'chat-one',
      anchorRunRef: 'anchor-one'
    })),
    resolveAuthorizedAttachmentPaths: vi.fn(() => ['/authorized/image.png']),
    prepareQueueJob: vi.fn((input: unknown) => {
      const record = input as Record<string, unknown>
      const runtimeProfileId =
        typeof record.runtimeProfileId === 'string' ? record.runtimeProfileId : undefined
      return preparedJob(
        {
          ...(runtimeProfileId ? { runtimeProfileId } : {})
        },
        {
          id: String(record.id),
          runId: record.runId as string,
          ...(runtimeProfileId ? { runtimeProfileId } : {})
        }
      )
    }),
    resolveRuntimeProfileAuthority: vi.fn(({ provider, runtimeProfileId }) => ({
      schemaVersion: 1,
      id: runtimeProfileId,
      provider,
      scope: 'workspace',
      workspaceMode: 'local',
      binaryPath: null,
      env: {},
      secretRefs: null,
      mcpProfileId: null,
      approvalMode: 'default',
      agenticServices: null,
      networkPolicy: 'inherit',
      persistence: 'reusable',
      containerConfig: null,
      builtin: true,
      pluginProvenance: null
    })),
    resolvePermissionPosture: vi.fn(
      (): RunPermissionPostureSnapshot => ({
        schemaVersion: 1,
        approvalMode: 'auto_edit',
        workflowMode: 'normal',
        presetId: 'workspace_write',
        readOnly: false,
        agenticServices: {
          shellCommands: 'workspace',
          fileChanges: 'workspace',
          externalPublish: 'ask',
          mcpTools: 'ask',
          subThreadDelegation: 'ask',
          canvasInteraction: 'ask',
          crossThreadRead: 'ask',
          threadMessage: 'ask',
          mediaEditing: 'workspace',
          mediaRecording: 'deny',
          canvasEval: 'ask'
        },
        networkAccess: 'allow',
        externalPathGrantCount: 0,
        workspaceGrantServiceIds: [],
        postureHash: 'c'.repeat(64),
        signature: 'signed-posture',
        signaturePresent: true
      })
    ),
    repository: {
      saveRunTemplate: vi.fn((content) => ({
        schemaVersion: 1 as const,
        templateId: `run-template-${'b'.repeat(64)}`,
        contentDigest: 'b'.repeat(64),
        content
      })),
      listRevisions: vi.fn(() => []),
      getRevision: vi.fn(() => undefined),
      saveRevision: vi.fn((revision) => revision),
      saveLayout: vi.fn((layout) => layout),
      getLayout: vi.fn(() => undefined),
      readExecutionEvents: vi.fn(() => [])
    },
    coordinator: {
      listExecutions: vi.fn(() => [current]),
      getExecution: vi.fn((id) => (id === current.executionId ? current : undefined)),
      resolveStackAppendReceipt: vi.fn(() => undefined),
      appendStackStep: vi.fn(() => current),
      cancelExecution: vi.fn(async () => {}),
      cancelDormantStep: vi.fn(async () => current)
    },
    now: () => '2026-07-18T12:00:00.000Z'
  }
}

beforeEach(() => {
  mockedHandle.mockReset()
})

describe('registerExecutionGraphHandlers', () => {
  it('registers the bounded main-window graph surface', () => {
    registerExecutionGraphHandlers(createDeps())

    expect(mockedHandle.mock.calls.map(([channel]) => channel)).toEqual([
      'execution-graphs:list',
      'execution-graphs:get',
      'execution-graphs:get-layout',
      'execution-runs:list',
      'execution-runs:get',
      'execution-runs:events',
      'execution-runs:append-stack-step',
      'execution-runs:cancel',
      'execution-runs:cancel-step',
      'execution-runs:formalize',
      'execution-graphs:save-layout'
    ])
  })

  it('asserts main-renderer authority before every read or mutation', () => {
    const deps = createDeps()
    deps.assertMainRendererSender = vi.fn(() => {
      throw new Error('main renderer only')
    })
    registerExecutionGraphHandlers(deps)

    expect(() => handlerFor('execution-runs:list')({})).toThrow('main renderer only')
    expect(() => handlerFor('execution-runs:append-stack-step')({}, {})).toThrow(
      'main renderer only'
    )
    expect(deps.coordinator.listExecutions).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
  })

  it('prepares and freezes an authoritative Stack request before appending', () => {
    const deps = createDeps()
    registerExecutionGraphHandlers(deps)

    handlerFor('execution-runs:append-stack-step')(
      {},
      {
        clientRequestId: 'renderer-run-one',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        anchorRunRef: 'anchor-one',
        provider: 'codex',
        stepTitle: 'Inspect the change',
        objective: 'Inspect this change.',
        request: {
          prompt: 'Untrusted renderer snapshot'
        }
      }
    )

    expect(deps.resolveStackTarget).toHaveBeenCalledWith({
      workspaceId: 'workspace-one',
      rootChatId: 'chat-one',
      anchorRunRef: 'anchor-one'
    })
    expect(deps.prepareQueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        workspaceId: 'workspace-one',
        workspacePath: '/workspace',
        chatId: 'chat-one',
        status: 'paused'
      }),
      { authorizedFilePaths: ['/authorized/image.png'] }
    )
    expect(deps.repository.saveRunTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: 'Inspect this change.',
          sessionTrust: false
        }),
        permissionPosture: expect.objectContaining({
          presetId: 'workspace_write',
          postureHash: 'c'.repeat(64),
          signaturePresent: true
        })
      })
    )
    expect(deps.resolvePermissionPosture).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        workspacePath: '/workspace',
        rootChatId: 'chat-one',
        request: expect.objectContaining({ sessionTrust: false })
      })
    )
    expect(deps.coordinator.appendStackStep).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: 'renderer-run-one',
        clientSubmissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        anchorRunRef: 'anchor-one',
        provider: 'codex',
        effect: 'workspace_write',
        runTemplateRef: `run-template-${'b'.repeat(64)}`,
        permissionCeilingRef: expect.objectContaining({
          workspaceId: 'workspace-one',
          authorityDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    )
    const savedContent = vi.mocked(deps.repository.saveRunTemplate).mock.calls[0]?.[0]
    const appendInput = vi.mocked(deps.coordinator.appendStackStep).mock.calls[0]?.[0]
    expect(savedContent).toBeDefined()
    expect(appendInput?.permissionCeilingRef.authorityDigest).toBe(
      executionGraphRunTemplatePermissionCeilingDigest(savedContent!)
    )
    expect(appendInput?.permissionCeilingRef.authorityDigest).not.toBe(
      executionGraphRunTemplateAuthorityDigest(savedContent!)
    )
    expect(appendInput?.objective).toBe(
      (savedContent?.request as { prompt?: unknown } | undefined)?.prompt
    )
  })

  it('rejects an objective that diverges from the canonical prepared prompt', () => {
    const deps = createDeps()
    deps.prepareQueueJob = vi.fn(() => preparedJob({ prompt: 'Canonical frozen provider prompt.' }))
    registerExecutionGraphHandlers(deps)

    expect(() => appendStackStep(handlerFor('execution-runs:append-stack-step'))).toThrow(
      /objective must match its canonical prepared prompt/i
    )
    expect(deps.resolvePermissionPosture).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it('stores the trimmed prepared prompt as the exact durable objective', () => {
    const deps = createDeps()
    deps.prepareQueueJob = vi.fn(() => preparedJob({ prompt: '  Inspect this change.\n' }))
    registerExecutionGraphHandlers(deps)

    appendStackStep(handlerFor('execution-runs:append-stack-step'))

    const savedContent = vi.mocked(deps.repository.saveRunTemplate).mock.calls[0]?.[0]
    const appendInput = vi.mocked(deps.coordinator.appendStackStep).mock.calls[0]?.[0]
    expect((savedContent?.request as { prompt?: unknown } | undefined)?.prompt).toBe(
      'Inspect this change.'
    )
    expect(appendInput?.objective).toBe('Inspect this change.')
  })

  it('truncates an overlong display title instead of rejecting the Stack append', () => {
    const deps = createDeps()
    registerExecutionGraphHandlers(deps)
    const longTitle = `${'A'.repeat(160)} Stack`

    handlerFor('execution-runs:append-stack-step')(
      {},
      {
        clientRequestId: 'renderer-run-one',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        title: longTitle,
        stepTitle: 'Inspect the change',
        objective: 'Inspect this change.',
        provider: 'codex',
        request: { prompt: 'Inspect this change.' }
      }
    )

    const appendInput = vi.mocked(deps.coordinator.appendStackStep).mock.calls[0]?.[0]
    expect(appendInput?.title).toHaveLength(160)
    expect(appendInput?.title).toBe(longTitle.slice(0, 160))
  })

  it('returns an exact committed receipt before resolving a stale live target', () => {
    const deps = createDeps()
    const committed = projection({
      executionId: 'stack-committed',
      anchorRunRef: 'anchor-one'
    })
    deps.coordinator.resolveStackAppendReceipt = vi.fn(() => committed)
    deps.resolveStackTarget = vi.fn(() => {
      throw new Error('stale anchor must not be consulted')
    })
    deps.resolveAuthorizedAttachmentPaths = vi.fn(() => {
      throw new Error('attachment authority must not be consulted')
    })
    deps.resolvePermissionPosture = vi.fn(() => {
      throw new Error('current permission policy must not be consulted')
    })
    deps.assertLocalChatHistoryDurable = vi.fn(() => {
      throw new Error('current history setting must not be consulted')
    })
    registerExecutionGraphHandlers(deps)

    const result = handlerFor('execution-runs:append-stack-step')(
      {},
      {
        clientRequestId: 'renderer-run-retry',
        // These volatile routing hints may legitimately change after a lost
        // reply; the durable receipt still owns the original target.
        executionId: 'stack-now-preferred',
        anchorRunRef: 'anchor-now-active',
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        provider: 'codex',
        stepTitle: 'Inspect the change',
        objective: 'Inspect this change carefully.',
        request: { prompt: 'Inspect this change.' }
      }
    )

    expect(result).toBe(committed)
    expect(deps.coordinator.resolveStackAppendReceipt).toHaveBeenCalledWith({
      clientRequestId: 'renderer-run-retry',
      workspaceId: 'workspace-one',
      rootChatId: 'chat-one',
      clientSubmissionDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(deps.resolveStackTarget).not.toHaveBeenCalled()
    expect(deps.assertLocalChatHistoryDurable).not.toHaveBeenCalled()
    expect(deps.resolveAuthorizedAttachmentPaths).not.toHaveBeenCalled()
    expect(deps.prepareQueueJob).not.toHaveBeenCalled()
    expect(deps.resolvePermissionPosture).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it('checks a committed receipt before failing a new append without durable history', () => {
    const deps = createDeps()
    const calls: string[] = []
    deps.coordinator.resolveStackAppendReceipt = vi.fn(() => {
      calls.push('receipt')
      return undefined
    })
    deps.assertLocalChatHistoryDurable = vi.fn(() => {
      calls.push('durability')
      throw new Error('Local chat history is disabled.')
    })
    deps.resolveStackTarget = vi.fn(() => {
      calls.push('target')
      throw new Error('target must not be resolved')
    })
    registerExecutionGraphHandlers(deps)

    expect(() => appendStackStep(handlerFor('execution-runs:append-stack-step'))).toThrow(
      /Local chat history is disabled/i
    )
    expect(calls).toEqual(['receipt', 'durability'])
    expect(deps.resolveStackTarget).not.toHaveBeenCalled()
    expect(deps.resolveAuthorizedAttachmentPaths).not.toHaveBeenCalled()
    expect(deps.prepareQueueJob).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it('rejects malformed commands before persisting a template', () => {
    const deps = createDeps()
    registerExecutionGraphHandlers(deps)

    expect(() =>
      handlerFor('execution-runs:append-stack-step')(
        {},
        {
          clientRequestId: 'renderer-run-malformed',
          workspaceId: 'workspace-one',
          rootChatId: 'chat-one',
          provider: 'codex',
          stepTitle: 'Missing objective',
          request: { prompt: 'No mutation should happen.' }
        }
      )
    ).toThrow('Step objective is required')
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it('rejects a non-canonical client request id before preparing a template', () => {
    const deps = createDeps()
    registerExecutionGraphHandlers(deps)

    expect(() =>
      handlerFor('execution-runs:append-stack-step')(
        {},
        {
          clientRequestId: 'not/a/canonical/id',
          workspaceId: 'workspace-one',
          rootChatId: 'chat-one',
          provider: 'codex',
          stepTitle: 'Inspect the change',
          objective: 'Inspect this change carefully.',
          request: { prompt: 'No mutation should happen.' }
        }
      )
    ).toThrow(/client request id is not canonical/i)
    expect(deps.prepareQueueJob).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it('rejects quarantined attachments instead of running without them', () => {
    const deps = createDeps()
    deps.prepareQueueJob = vi.fn(
      (
        input: unknown
      ): Partial<RunQueueJob> & Pick<RunQueueJob, 'runId' | 'provider' | 'source'> => ({
        id: String((input as Record<string, unknown>).id),
        runId: String((input as Record<string, unknown>).runId),
        provider: 'codex',
        scope: 'workspace',
        workspaceId: 'workspace-one',
        workspacePath: '/workspace',
        chatId: 'chat-one',
        source: 'system',
        status: 'failed',
        lastError: 'Queued attachments could not be recovered safely.',
        request: {
          prompt: 'Inspect this change.',
          selectedModelType: 'default',
          customModel: '',
          approvalMode: 'default',
          permissionPresetId: 'workspace_write',
          sessionTrust: false,
          imageAttachments: []
        }
      })
    )
    registerExecutionGraphHandlers(deps)

    expect(() =>
      handlerFor('execution-runs:append-stack-step')(
        {},
        {
          clientRequestId: 'renderer-run-attachment',
          workspaceId: 'workspace-one',
          rootChatId: 'chat-one',
          provider: 'codex',
          stepTitle: 'Inspect the change',
          objective: 'Inspect this change carefully.',
          request: { prompt: 'Inspect with the attachment.' }
        }
      )
    ).toThrow(/attachments could not be recovered safely/i)
    expect(deps.resolvePermissionPosture).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it('freezes the built-in workspace runtime profile into a Stack template', () => {
    const deps = createDeps()
    registerExecutionGraphHandlers(deps)

    expect(() =>
      handlerFor('execution-runs:append-stack-step')(
        {},
        {
          clientRequestId: 'renderer-run-profile',
          workspaceId: 'workspace-one',
          rootChatId: 'chat-one',
          provider: 'codex',
          stepTitle: 'Inspect the change',
          objective: 'Inspect this change.',
          request: {
            prompt: 'Inspect this change.',
            runtimeProfileId: 'builtin:codex:local'
          }
        }
      )
    ).not.toThrow()
    expect(deps.prepareQueueJob).toHaveBeenCalledOnce()
    expect(deps.resolvePermissionPosture).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeProfileId: 'builtin:codex:local' })
    )
    expect(deps.repository.saveRunTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeProfileId: 'builtin:codex:local',
        runtimeProfileAuthority: expect.objectContaining({
          id: 'builtin:codex:local',
          provider: 'codex',
          scope: 'workspace',
          builtin: true
        })
      })
    )
    expect(deps.coordinator.appendStackStep).toHaveBeenCalledOnce()
  })

  it('rejects mutable runtime profiles before queue preparation', () => {
    const deps = createDeps()
    deps.resolveRuntimeProfileAuthority = vi.fn(() => {
      throw new Error('Stack steps require an immutable built-in workspace runtime profile.')
    })
    registerExecutionGraphHandlers(deps)

    expect(() =>
      handlerFor('execution-runs:append-stack-step')(
        {},
        {
          clientRequestId: 'runtime-profile-custom',
          workspaceId: 'workspace-one',
          rootChatId: 'chat-one',
          provider: 'codex',
          stepTitle: 'Inspect the change',
          objective: 'Inspect this change.',
          request: {
            prompt: 'Inspect this change.',
            runtimeProfileId: 'runtime-codex-custom'
          }
        }
      )
    ).toThrow(/immutable built-in workspace runtime profile/i)
    expect(deps.prepareQueueJob).not.toHaveBeenCalled()
    expect(deps.resolvePermissionPosture).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'scheduled provenance',
      request: { scheduledTaskId: 'scheduled-one' },
      error: /scheduled, remote, guest, or Ensemble provenance/i
    },
    {
      name: 'an Ensemble direct-message target',
      request: { dmTargetParticipantId: 'participant-one' },
      error: /scheduled, remote, guest, or Ensemble provenance/i
    },
    {
      name: 'Discord context',
      request: {
        discordContextSelection: {
          guildId: 'guild-one',
          channelId: 'channel-one',
          limit: 25 as const
        }
      },
      error: /Discord context/i
    },
    {
      name: 'mutable project-reference context',
      request: {
        projectReferenceContextSelection: {
          schemaVersion: 1 as const,
          projectId: 'project-one',
          referenceIds: ['reference-one']
        }
      },
      error: /mutable project-reference context/i
    },
    {
      name: 'Codex native review',
      request: { codexNativeReview: true },
      error: /Codex native review/i
    },
    {
      name: 'a handoff source',
      request: { handoffSourceRunId: 'source-run-one' },
      error: /handoff source run/i
    },
    {
      name: 'composer preservation',
      request: { preserveComposer: true },
      error: /originating composer/i
    },
    {
      name: 'a Gemini worktree',
      request: { geminiWorktree: { enabled: true, name: 'feature-one' } },
      error: /worktree-bound execution context/i
    },
    {
      name: 'an effective worktree path',
      request: { effectiveWorkspacePath: '/workspace-worktree' },
      error: /worktree-bound execution context/i
    },
    {
      name: 'a this-run external path grant',
      request: {
        externalPathGrants: [
          {
            id: 'grant-one',
            provider: 'codex' as const,
            bindingVersion: 2 as const,
            workspaceId: 'workspace-one',
            chatId: 'chat-one',
            appRunId: 'renderer-run-one',
            path: '/external/file.txt',
            kind: 'file' as const,
            access: 'read' as const,
            duration: 'thisRun' as const,
            issuedBy: 'main' as const,
            signature: 'signed-grant',
            createdAt: '2026-07-18T12:00:00.000Z'
          }
        ]
      },
      error: /run-scoped external path grants/i
    }
  ])('rejects $name from a bound Stack request', ({ request, error }) => {
    const deps = createDeps()
    deps.prepareQueueJob = vi.fn(() => preparedJob(request))
    registerExecutionGraphHandlers(deps)

    expect(() => appendStackStep(handlerFor('execution-runs:append-stack-step'))).toThrow(error)
    expect(deps.resolvePermissionPosture).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'the prepared queue job',
      request: {},
      job: { scope: 'global' as const },
      error: /workspace-scoped request/i
    },
    {
      name: 'the prepared request snapshot',
      request: { scope: 'global' as const },
      job: {},
      error: /workspace-scoped request/i
    },
    {
      name: 'the prepared queue job handoff binding',
      request: {},
      job: { handoffSourceRunId: 'source-run-one' },
      error: /handoff source run/i
    }
  ])('rejects unsupported runtime authority on $name', ({ request, job, error }) => {
    const deps = createDeps()
    deps.prepareQueueJob = vi.fn(() => preparedJob(request, job))
    registerExecutionGraphHandlers(deps)

    expect(() => appendStackStep(handlerFor('execution-runs:append-stack-step'))).toThrow(error)
    expect(deps.resolvePermissionPosture).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
    expect(deps.coordinator.appendStackStep).not.toHaveBeenCalled()
  })

  it('keeps durable external path grants admissible for future Stack attempts', () => {
    const deps = createDeps()
    deps.prepareQueueJob = vi.fn(() =>
      preparedJob({
        externalPathGrants: [
          {
            id: 'grant-thread-one',
            provider: 'codex',
            bindingVersion: 2,
            workspaceId: 'workspace-one',
            chatId: 'chat-one',
            path: '/external/directory',
            kind: 'directory',
            access: 'read',
            duration: 'thisThread',
            issuedBy: 'main',
            signature: 'signed-grant',
            createdAt: '2026-07-18T12:00:00.000Z'
          }
        ]
      })
    )
    registerExecutionGraphHandlers(deps)

    expect(() => appendStackStep(handlerFor('execution-runs:append-stack-step'))).not.toThrow()
    expect(deps.coordinator.appendStackStep).toHaveBeenCalledWith(
      expect.objectContaining({ effect: 'external_side_effect' })
    )
  })

  it('formalizes only the verified effective topology as a new immutable revision', () => {
    const deps = createDeps()
    const step = {
      id: 'step-one',
      kind: 'output' as const,
      title: 'Result',
      objective: 'Expose the result.',
      effect: 'read_only' as const,
      retry: { maxAttempts: 1 },
      output: { projectReference: 'none' as const }
    }
    deps.coordinator.getExecution = vi.fn(() =>
      projection({ topology: { steps: [step], edges: [] } })
    )
    registerExecutionGraphHandlers(deps)

    const saved = handlerFor('execution-runs:formalize')(
      {},
      { executionId: 'stack-one', name: 'Reusable workflow' }
    )

    expect(saved).toMatchObject({
      graphId: 'stack-stack-one',
      revision: 1,
      name: 'Reusable workflow',
      workspaceId: 'workspace-one',
      steps: [step]
    })
    expect(deps.repository.saveRevision).toHaveBeenCalledTimes(1)
  })

  it('requires an existing execution before cancelling a dormant step', async () => {
    const deps = createDeps()
    registerExecutionGraphHandlers(deps)

    await expect(
      handlerFor('execution-runs:cancel-step')(
        {},
        { executionId: 'missing-stack', activationId: 'activation-one' }
      )
    ).rejects.toThrow('Execution is unavailable')
    expect(deps.coordinator.cancelDormantStep).not.toHaveBeenCalled()
  })
})

describe('registerExecutionGraphDiagnosticsHandler', () => {
  it('keeps diagnostics readable through a main-renderer-only handler', () => {
    const snapshot: ExecutionGraphDiagnosticsSnapshot = {
      schemaVersion: 1,
      repositoryDiagnostics: [
        {
          code: 'execution_ledger_corrupt',
          executionId: 'stack-broken',
          fileName: 'stack-broken.jsonl',
          message: 'Ledger checksum mismatch.'
        }
      ],
      recoveryDiagnostics: [
        { executionId: 'stack-recovery', message: 'Recovery could not read the queue row.' }
      ],
      serviceDiagnostics: []
    }
    const assertMainRendererSender = vi.fn()
    const getSnapshot = vi.fn(() => snapshot)

    registerExecutionGraphDiagnosticsHandler({ assertMainRendererSender, getSnapshot })

    expect(handlerFor('execution-graphs:diagnostics')({ sender: 'main' })).toBe(snapshot)
    expect(assertMainRendererSender).toHaveBeenCalledWith({ sender: 'main' })
    expect(getSnapshot).toHaveBeenCalledOnce()
  })

  it('checks renderer authority before reading diagnostics', () => {
    const getSnapshot = vi.fn()
    registerExecutionGraphDiagnosticsHandler({
      assertMainRendererSender: () => {
        throw new Error('main renderer only')
      },
      getSnapshot
    })

    expect(() => handlerFor('execution-graphs:diagnostics')({})).toThrow('main renderer only')
    expect(getSnapshot).not.toHaveBeenCalled()
  })
})
