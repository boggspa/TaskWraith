import { describe, expect, it } from 'vitest'
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
      canonicalizePath
    })

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
