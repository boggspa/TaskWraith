import { describe, expect, it, vi } from 'vitest'
import type { ComposerInput } from './services/ComposerService'
import type { ChatRecord, ScheduledTask } from './store/types'
import { resolveComposerRunAuthority } from './ComposerRunAuthority'

const canonicalizePath = (value: string): string => value.replace(/\/$/, '')

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-test-1',
    workspaceId: 'workspace-test-1',
    workspacePath: '/Test 1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Test 1',
    messages: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as ChatRecord
}

function scheduledTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'scheduled-test-1',
    workspaceId: 'workspace-test-1',
    workspacePath: '/Test 1',
    chatId: 'chat-test-1',
    provider: 'claude',
    prompt: 'Canonical scheduled prompt.',
    selectedModelType: 'claude-haiku-5',
    customModel: '',
    approvalMode: 'auto_edit',
    permissionPresetId: 'workspace_write',
    workflowMode: 'normal',
    sessionTrust: false,
    imageAttachments: [
      {
        persistenceVersion: 1,
        id: 'attachment-1',
        path: '/main-cas/scheduled.png',
        name: 'scheduled.png',
        sha256: 'a'.repeat(64),
        mimeType: 'image/png',
        byteLength: 42
      }
    ],
    runAt: '2026-07-13T00:00:00.000Z',
    timezone: 'Europe/London',
    status: 'running',
    createdAt: '2026-07-12T23:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    firedAt: '2026-07-13T00:00:00.000Z',
    runningSince: '2026-07-13T00:00:01.000Z',
    runId: 'run-test-1',
    ...overrides
  } as ScheduledTask
}

function input(overrides: Partial<ComposerInput> = {}): ComposerInput {
  return {
    chatId: 'chat-test-1',
    appRunId: 'run-interactive',
    workspace: '/Test 3',
    userInput: 'Renderer prompt.',
    chatSnapshot: chat({ workspaceId: 'workspace-test-3', workspacePath: '/Test 3' }),
    ...overrides
  }
}

function graphInput(overrides: Partial<ComposerInput> = {}): ComposerInput {
  return {
    chatId: 'chat-test-1',
    appRunId: 'run-graph-1',
    scope: 'workspace',
    workspace: '/Test 1',
    userInput: 'Main-owned graph prompt.',
    provider: 'claude',
    selectedModelType: 'claude-sonnet-4-7',
    customModel: 'main-model',
    overrideModel: 'main-override',
    claudeReasoningEffort: 'high',
    imageAttachments: [{ id: 'main-image', path: '/main-cas/graph.png', name: 'graph.png' }],
    attachments: [{ id: 'main-attachment', path: '/main-cas/graph.txt', name: 'graph.txt' }],
    sessionTrust: false,
    projectReferenceContextSelection: {
      schemaVersion: 1,
      projectId: 'project-main',
      referenceIds: ['reference-main']
    },
    handoffSourceRunId: 'run-main-handoff',
    ...overrides
  }
}

describe('resolveComposerRunAuthority', () => {
  it('replaces an interactive renderer snapshot and workspace with the durable chat', () => {
    const durable = chat()
    const result = resolveComposerRunAuthority({
      input: input(),
      chat: durable,
      isMainRenderer: true,
      canonicalizePath
    })

    expect(result.input.workspace).toBe('/Test 1')
    expect(result.input.chatSnapshot).toBe(durable)
    expect(result.input.scope).toBe('workspace')
  })

  it('uses only the complete main-owned input for a graph-owned appRunId', () => {
    const durable = chat()
    const result = resolveComposerRunAuthority({
      input: input({
        appRunId: 'run-graph-1',
        userInput: 'Forged renderer user input.',
        prompt: 'Forged renderer prompt.',
        provider: 'grok',
        selectedModelType: 'grok-4',
        customModel: 'renderer-model',
        overrideModel: 'renderer-override',
        codexReasoningEffort: 'xhigh',
        claudeReasoningEffort: 'low',
        imageAttachments: [
          { id: 'renderer-image', path: '/renderer/secret.png', name: 'secret.png' }
        ],
        attachments: [
          { id: 'renderer-attachment', path: '/renderer/secret.txt', name: 'secret.txt' }
        ],
        sessionTrust: true,
        projectReferenceContextSelection: {
          schemaVersion: 1,
          projectId: 'project-renderer',
          referenceIds: ['reference-renderer']
        },
        handoffSourceRunId: 'run-renderer-handoff'
      }),
      chat: durable,
      isMainRenderer: true,
      resolveGraphOwnedComposerInput: (appRunId) => ({
        input: graphInput({
          appRunId,
          workspace: '/Test 1/',
          chatSnapshot: chat({
            workspaceId: 'stale-workspace',
            workspacePath: '/stale-workspace'
          })
        }),
        mainOwnedAttachments: true
      }),
      canonicalizePath
    })

    expect(result.mainOwnedAttachments).toBe(true)
    expect(result.input).toMatchObject({
      appRunId: 'run-graph-1',
      chatId: 'chat-test-1',
      scope: 'workspace',
      workspace: '/Test 1',
      userInput: 'Main-owned graph prompt.',
      provider: 'claude',
      selectedModelType: 'claude-sonnet-4-7',
      customModel: 'main-model',
      overrideModel: 'main-override',
      claudeReasoningEffort: 'high',
      imageAttachments: [{ id: 'main-image', path: '/main-cas/graph.png', name: 'graph.png' }],
      attachments: [{ id: 'main-attachment', path: '/main-cas/graph.txt', name: 'graph.txt' }],
      sessionTrust: false,
      projectReferenceContextSelection: {
        schemaVersion: 1,
        projectId: 'project-main',
        referenceIds: ['reference-main']
      },
      handoffSourceRunId: 'run-main-handoff',
      chatSnapshot: durable
    })
    expect(result.input.prompt).toBeUndefined()
    expect(result.input.codexReasoningEffort).toBeUndefined()
  })

  it('leaves an ordinary run unchanged when the graph resolver returns null', () => {
    const rendererInput = input({
      provider: 'grok',
      selectedModelType: 'grok-renderer-model',
      sessionTrust: true,
      handoffSourceRunId: 'renderer-handoff'
    })
    let resolvedRunId: string | undefined
    const result = resolveComposerRunAuthority({
      input: rendererInput,
      chat: chat(),
      isMainRenderer: true,
      resolveGraphOwnedComposerInput: (appRunId) => {
        resolvedRunId = appRunId
        return null
      },
      canonicalizePath
    })

    expect(resolvedRunId).toBe('run-interactive')
    expect(result.mainOwnedAttachments).toBeUndefined()
    expect(result.input).toMatchObject({
      provider: 'grok',
      selectedModelType: 'grok-renderer-model',
      userInput: 'Renderer prompt.',
      sessionTrust: true,
      handoffSourceRunId: 'renderer-handoff'
    })
  })

  it('replaces renderer attachment paths with exact main-owned queued snapshots', () => {
    const durable = chat()
    const resolveQueuedComposerAttachments = vi.fn(() => ({
      imageAttachments: [
        {
          id: 'queued-image',
          path: '/main-cas/queued.png',
          name: 'queued.png'
        }
      ]
    }))
    const result = resolveComposerRunAuthority({
      input: input({
        provider: 'pi',
        imageAttachments: [{ id: 'forged', path: '/renderer/secret.png' }],
        attachments: [{ id: 'forged-file', path: '/renderer/secret.txt' }]
      }),
      chat: durable,
      isMainRenderer: true,
      resolveQueuedComposerAttachments,
      canonicalizePath
    })

    expect(resolveQueuedComposerAttachments).toHaveBeenCalledWith({
      appRunId: 'run-interactive',
      appChatId: 'chat-test-1',
      provider: 'pi'
    })
    expect(result.mainOwnedAttachments).toBe(true)
    expect(result.input.imageAttachments).toEqual([
      { id: 'queued-image', path: '/main-cas/queued.png', name: 'queued.png' }
    ])
    expect(result.input.attachments).toBeUndefined()
    expect(result.input.userInput).toBe('Renderer prompt.')
  })

  it('rejects graph authority that does not match the exact run and durable target', () => {
    const resolve = (overrides: Partial<ComposerInput>) =>
      resolveComposerRunAuthority({
        input: input({ appRunId: 'run-graph-1' }),
        chat: chat(),
        isMainRenderer: true,
        resolveGraphOwnedComposerInput: () => ({
          input: graphInput(overrides),
          mainOwnedAttachments: true
        }),
        canonicalizePath
      })

    expect(() => resolve({ appRunId: 'run-other' })).toThrow(
      'Execution graph compose authority is stale'
    )
    expect(() => resolve({ chatId: 'chat-other' })).toThrow(
      'Execution graph compose authority is stale'
    )
    expect(() => resolve({ workspace: '/Other' })).toThrow(
      'Execution graph compose authority is stale'
    )
    expect(() => resolve({ scope: 'global' })).toThrow('Execution graph compose authority is stale')
    expect(() => resolve({ scheduledTaskId: 'scheduled-other' })).toThrow(
      'Execution graph compose authority is stale'
    )
  })

  it('requires a secondary renderer frozen to the same chat workspace', () => {
    expect(() =>
      resolveComposerRunAuthority({
        input: input(),
        chat: chat(),
        isMainRenderer: false,
        owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 3' },
        canonicalizePath
      })
    ).toThrow('Renderer compose authority is stale')

    expect(
      resolveComposerRunAuthority({
        input: input(),
        chat: chat(),
        isMainRenderer: false,
        owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 1/' },
        canonicalizePath
      }).input.workspace
    ).toBe('/Test 1')
  })

  it('removes renderer workspace authority from a global chat', () => {
    const result = resolveComposerRunAuthority({
      input: input(),
      chat: chat({ scope: 'global', workspaceId: undefined, workspacePath: undefined }),
      isMainRenderer: true,
      canonicalizePath
    })
    expect(result.input.scope).toBe('global')
    expect(result.input.workspace).toBeUndefined()
  })

  it('rejects scheduled dispatch from a secondary renderer', () => {
    expect(() =>
      resolveComposerRunAuthority({
        input: input({ scheduledTaskId: 'scheduled-test-1' }),
        chat: chat(),
        isMainRenderer: false,
        owner: { kind: 'chat', chatId: 'chat-test-1', workspacePath: '/Test 1' },
        scheduledTask: scheduledTask(),
        canonicalizePath
      })
    ).toThrow('Scheduled occurrences may only be dispatched by the main renderer.')
  })

  it('rebuilds a scheduled compose from the exact durable occurrence', () => {
    const durable = chat()
    const task = scheduledTask()
    let graphResolverCalled = false
    const result = resolveComposerRunAuthority({
      input: input({
        appRunId: 'run-test-1',
        scheduledTaskId: task.id,
        provider: 'grok',
        approvalMode: 'plan',
        imageAttachments: [{ path: '/forged/secret.png' }]
      }),
      chat: durable,
      isMainRenderer: true,
      scheduledTask: task,
      resolveGraphOwnedComposerInput: () => {
        graphResolverCalled = true
        return { input: graphInput(), mainOwnedAttachments: true }
      },
      canonicalizePath
    })

    expect(graphResolverCalled).toBe(false)
    expect(result.mainOwnedAttachments).toBe(true)
    expect(result.input).toMatchObject({
      appRunId: 'run-test-1',
      scheduledTaskId: 'scheduled-test-1',
      provider: 'claude',
      workspace: '/Test 1',
      userInput: 'Canonical scheduled prompt.',
      approvalMode: 'auto_edit',
      selectedModelType: 'claude-haiku-5',
      imageAttachments: [{ path: '/main-cas/scheduled.png', name: 'scheduled.png' }],
      chatSnapshot: durable
    })
  })

  it('rejects a stale or replayed scheduled occurrence', () => {
    expect(() =>
      resolveComposerRunAuthority({
        input: input({ appRunId: 'run-replayed', scheduledTaskId: 'scheduled-test-1' }),
        chat: chat(),
        isMainRenderer: true,
        scheduledTask: scheduledTask(),
        canonicalizePath
      })
    ).toThrow('Scheduled occurrence does not match')
  })
})
