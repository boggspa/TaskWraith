import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  executionGraphRunTemplateAuthorityDigest,
  executionGraphRunTemplatePermissionCeilingDigest
} from '../executionGraph/ExecutionGraphRunTemplateAuthority'
import type { ExecutionRunProjection } from '../executionGraph/ExecutionGraphRun'
import type { RunPermissionPostureSnapshot, RunQueueJob } from '../store/types'
import type { ExecutionGraphHandlersDeps } from './executionGraphHandlers'
import { registerExecutionGraphHandlers } from './executionGraphHandlers'

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

function createDeps(): ExecutionGraphHandlersDeps {
  const current = projection()
  return {
    assertMainRendererSender: vi.fn(),
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
      return {
        id: String(record.id),
        runId: record.runId as string,
        provider: 'codex' as const,
        scope: 'workspace' as const,
        workspaceId: 'workspace-one',
        workspacePath: '/workspace',
        chatId: 'chat-one',
        source: 'system' as const,
        status: 'paused' as const,
        ...(runtimeProfileId ? { runtimeProfileId } : {}),
        request: {
          prompt: 'Inspect this change.',
          selectedModelType: 'default',
          customModel: '',
          approvalMode: 'auto',
          permissionPresetId: 'workspace_write' as const,
          sessionTrust: true,
          imageAttachments: [],
          ...(runtimeProfileId ? { runtimeProfileId } : {})
        }
      }
    }),
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
      appendStackStep: vi.fn(() => current),
      cancelExecution: vi.fn(async () => {}),
      cancelDormantStep: vi.fn(async () => current)
    },
    now: () => '2026-07-18T12:00:00.000Z',
    createId: () => 'id-one'
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
        workspaceId: 'workspace-one',
        rootChatId: 'chat-one',
        anchorRunRef: 'anchor-one',
        provider: 'codex',
        stepTitle: 'Inspect the change',
        objective: 'Inspect this change carefully.',
        request: {
          prompt: 'Untrusted renderer snapshot',
          runtimeProfileId: 'runtime-codex-one'
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
        status: 'paused',
        runtimeProfileId: 'runtime-codex-one'
      }),
      { authorizedFilePaths: ['/authorized/image.png'] }
    )
    expect(deps.repository.saveRunTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          prompt: 'Inspect this change.',
          sessionTrust: false,
          runtimeProfileId: 'runtime-codex-one'
        }),
        runtimeProfileId: 'runtime-codex-one',
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
        runtimeProfileId: 'runtime-codex-one',
        request: expect.objectContaining({ sessionTrust: false })
      })
    )
    expect(deps.coordinator.appendStackStep).toHaveBeenCalledWith(
      expect.objectContaining({
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
  })

  it('rejects malformed commands before persisting a template', () => {
    const deps = createDeps()
    registerExecutionGraphHandlers(deps)

    expect(() =>
      handlerFor('execution-runs:append-stack-step')(
        {},
        {
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

  it('rejects a prepared runtime profile that diverges from the request context', () => {
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
        status: 'paused',
        runtimeProfileId: 'runtime-codex-one',
        request: {
          prompt: 'Inspect this change.',
          selectedModelType: 'default',
          customModel: '',
          approvalMode: 'default',
          permissionPresetId: 'workspace_write',
          sessionTrust: false,
          imageAttachments: [],
          runtimeProfileId: 'runtime-codex-two'
        }
      })
    )
    registerExecutionGraphHandlers(deps)

    expect(() =>
      handlerFor('execution-runs:append-stack-step')(
        {},
        {
          workspaceId: 'workspace-one',
          rootChatId: 'chat-one',
          provider: 'codex',
          stepTitle: 'Inspect the change',
          objective: 'Inspect this change carefully.',
          request: {
            prompt: 'Inspect with a runtime profile.',
            runtimeProfileId: 'runtime-codex-one'
          }
        }
      )
    ).toThrow(/runtime profile did not preserve/i)
    expect(deps.resolvePermissionPosture).not.toHaveBeenCalled()
    expect(deps.repository.saveRunTemplate).not.toHaveBeenCalled()
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
