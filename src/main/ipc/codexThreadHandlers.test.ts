import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  authorizeAgentReview,
  registerCodexThreadHandlers,
  type AgentThreadSenderScope,
  type CodexThreadHandlersDeps
} from './codexThreadHandlers'

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

function createDeps() {
  const calls: string[] = []
  const client = {
    ensureStarted: vi.fn(async (version: string) => {
      calls.push(`ensure:${version}`)
    }),
    request: vi.fn(async (method: string, payload: unknown, timeoutMs: number) => {
      calls.push(`request:${method}:${timeoutMs}`)
      return { method, payload, timeoutMs }
    })
  }
  const deps = {
    getCodexClient: vi.fn(() => client),
    listCodexThreads: vi.fn(async (payload: unknown, timeoutMs: number) => {
      calls.push(`list:${timeoutMs}`)
      return { method: 'thread/list', payload, timeoutMs }
    }),
    getAppVersion: vi.fn(() => '1.2.3'),
    providerDisplayName: vi.fn((provider: string) => provider.toUpperCase()),
    resolveSenderAgentThreadScope: vi.fn(
      (_event: unknown): AgentThreadSenderScope => ({ kind: 'main' })
    ),
    createEmulatedFork: undefined as CodexThreadHandlersDeps['createEmulatedFork']
  } satisfies CodexThreadHandlersDeps
  return { deps, calls, client }
}

describe('registerCodexThreadHandlers', () => {
  it('registers codex thread IPC channels', () => {
    registerCodexThreadHandlers(createDeps().deps)

    expect(handlerFor('list-agent-threads')).toBeTypeOf('function')
    expect(handlerFor('fork:get-capability')).toBeTypeOf('function')
    expect(handlerFor('fork-agent-thread')).toBeTypeOf('function')
    expect(handlerFor('rollback-agent-thread')).toBeTypeOf('function')
  })

  it('reports native, emulated, and unsupported fork capabilities', async () => {
    const { deps } = createDeps()
    registerCodexThreadHandlers(deps)

    await expect(handlerFor('fork:get-capability')({}, 'codex')).resolves.toMatchObject({
      provider: 'codex',
      kind: 'native',
      requiresLinkedSession: true
    })
    await expect(handlerFor('fork:get-capability')({}, 'claude')).resolves.toMatchObject({
      provider: 'claude',
      kind: 'emulated',
      requiresLinkedSession: false
    })
    await expect(handlerFor('fork:get-capability')({}, 'antigravity')).resolves.toMatchObject({
      provider: 'antigravity',
      kind: 'emulated',
      requiresLinkedSession: false
    })
    await expect(handlerFor('fork:get-capability')({}, 'gemini')).resolves.toMatchObject({
      provider: 'gemini',
      kind: 'unsupported'
    })
  })

  it('returns an empty page for non-codex list requests without touching the client', async () => {
    const { deps } = createDeps()
    registerCodexThreadHandlers(deps)

    await expect(handlerFor('list-agent-threads')({}, 'claude')).resolves.toEqual({
      data: [],
      nextCursor: null
    })
    expect(deps.getCodexClient).not.toHaveBeenCalled()
    expect(deps.listCodexThreads).not.toHaveBeenCalled()
  })

  it('routes thread list through the read-only dependency with exact defaults and timeout', async () => {
    const { deps, calls } = createDeps()
    registerCodexThreadHandlers(deps)

    await expect(handlerFor('list-agent-threads')({}, 'codex', {})).resolves.toEqual({
      method: 'thread/list',
      payload: {
        limit: 40,
        cursor: null,
        cwd: null,
        archived: false,
        searchTerm: null,
        sortKey: 'updated_at',
        sortDirection: 'desc'
      },
      timeoutMs: 20_000
    })
    expect(calls).toEqual(['list:20000'])
    expect(deps.getCodexClient).not.toHaveBeenCalled()
  })

  it('locks detached thread listing to the durable chat workspace', async () => {
    const { deps } = createDeps()
    deps.resolveSenderAgentThreadScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-test-1',
      workspacePath: '/Test 1',
      linkedProviderThreads: []
    })
    registerCodexThreadHandlers(deps)

    await handlerFor('list-agent-threads')({ sender: { id: 42 } }, 'codex', {})

    expect(deps.listCodexThreads).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/Test 1' }),
      20_000
    )
    await expect(
      handlerFor('list-agent-threads')({ sender: { id: 42 } }, 'codex', { cwd: '/Test 2' })
    ).rejects.toThrow('Renderer cannot list provider threads for another workspace.')
    await expect(
      handlerFor('list-agent-threads')({ sender: { id: 42 } }, 'codex', {
        cursor: 'cursor-from-another-view'
      })
    ).rejects.toThrow('Provider thread pagination is unavailable in detached chat windows.')
    expect(deps.listCodexThreads).toHaveBeenCalledTimes(1)
  })

  it('does not expose the global provider thread catalogue to a detached chat', async () => {
    const { deps, client } = createDeps()
    deps.resolveSenderAgentThreadScope.mockReturnValue({
      kind: 'chat',
      chatId: 'global-chat',
      workspacePath: null,
      linkedProviderThreads: [{ provider: 'codex', threadId: 'thread-1' }]
    })
    registerCodexThreadHandlers(deps)

    await expect(
      handlerFor('list-agent-threads')({ sender: { id: 42 } }, 'codex', {})
    ).rejects.toThrow('Detached provider thread listing requires a workspace-scoped chat.')
    expect(client.request).not.toHaveBeenCalled()
    expect(deps.listCodexThreads).not.toHaveBeenCalled()
  })

  it('fork reports emulated fallback requirements while rollback stays codex-only', async () => {
    const { deps } = createDeps()
    registerCodexThreadHandlers(deps)

    await expect(handlerFor('fork-agent-thread')({}, 'kimi', 'thread-1')).rejects.toThrow(
      'No provider-native fork is available on this transport.'
    )
    await expect(handlerFor('rollback-agent-thread')({}, 'kimi', 'thread-1')).rejects.toThrow(
      'Thread rollback is not available for KIMI in this version. File rollback still belongs to Diff Studio/git workflow.'
    )
  })

  it('creates an emulated fork through the injected chat fallback for non-codex providers', async () => {
    const { deps } = createDeps()
    deps.createEmulatedFork = vi.fn(() => ({
      appChatId: 'fork-chat-1',
      title: 'Forked',
      parentChatId: 'chat-1'
    }) as any)
    registerCodexThreadHandlers(deps)

    await expect(
      handlerFor('fork-agent-thread')({}, 'claude', 'provider-thread-1', {
        chatId: 'chat-1',
        model: 'sonnet'
      })
    ).resolves.toEqual({
      ok: true,
      provider: 'claude',
      kind: 'emulated',
      chatId: 'fork-chat-1',
      forkedChatId: 'fork-chat-1',
      title: 'Forked',
      parentChatId: 'chat-1',
      caveats: [
        'CLAUDE does not expose a TaskWraith-native thread/fork primitive; TaskWraith copies the transcript into an isolated sibling chat.'
      ]
    })
    expect(deps.createEmulatedFork).toHaveBeenCalledWith({
      provider: 'claude',
      chatId: 'chat-1',
      sourceProviderThreadId: 'provider-thread-1',
      sourceModel: 'sonnet'
    })
  })

  it('lets the authoritative chat-creation boundary admit an AntiGravity emulated fork', async () => {
    const { deps } = createDeps()
    deps.createEmulatedFork = vi.fn(
      () =>
        ({
          appChatId: 'antigravity-fork-1',
          title: 'AntiGravity fork',
          parentChatId: 'chat-1'
        }) as any
    )
    registerCodexThreadHandlers(deps)

    await expect(
      handlerFor('fork-agent-thread')({}, 'antigravity', 'chat-1', {
        chatId: 'chat-1',
        model: 'gemini-2.5-pro'
      })
    ).resolves.toMatchObject({
      ok: true,
      provider: 'antigravity',
      kind: 'emulated',
      chatId: 'antigravity-fork-1'
    })
    expect(deps.createEmulatedFork).toHaveBeenCalledWith({
      provider: 'antigravity',
      chatId: 'chat-1',
      sourceProviderThreadId: undefined,
      sourceModel: 'gemini-2.5-pro'
    })
  })

  it('propagates AntiGravity admission rejection from the authoritative chat boundary', async () => {
    const { deps } = createDeps()
    deps.createEmulatedFork = vi.fn(() => {
      throw new Error('antigravity is unavailable for new chats or delegated runs')
    })
    registerCodexThreadHandlers(deps)

    await expect(
      handlerFor('fork-agent-thread')({}, 'antigravity', 'chat-1', {
        chatId: 'chat-1'
      })
    ).rejects.toThrow('antigravity is unavailable for new chats or delegated runs')
  })

  it('binds detached emulated forks to the owned chat and linked provider session', async () => {
    const { deps } = createDeps()
    deps.createEmulatedFork = vi.fn(
      () =>
        ({
          appChatId: 'fork-chat-1',
          title: 'Forked',
          parentChatId: 'chat-test-1'
        }) as any
    )
    deps.resolveSenderAgentThreadScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-test-1',
      workspacePath: '/Test 1',
      linkedProviderThreads: [{ provider: 'claude', threadId: 'claude-session-1' }]
    })
    registerCodexThreadHandlers(deps)
    const handler = handlerFor('fork-agent-thread')
    const event = { sender: { id: 42 } }

    await expect(
      handler(event, 'claude', 'claude-session-1', {
        chatId: 'chat-test-2',
        cwd: '/Test 1'
      })
    ).rejects.toThrow('Renderer cannot manage provider threads for another chat.')
    await expect(
      handler(event, 'claude', 'claude-session-2', {
        chatId: 'chat-test-1',
        cwd: '/Test 1'
      })
    ).rejects.toThrow('Renderer cannot manage an unlinked provider thread.')
    await expect(
      handler(event, 'claude', 'claude-session-1', {
        chatId: 'chat-test-1',
        cwd: '/Test 2'
      })
    ).rejects.toThrow('Renderer cannot fork a provider thread into another workspace.')
    expect(deps.createEmulatedFork).not.toHaveBeenCalled()

    await expect(
      handler(event, 'claude', 'claude-session-1', {
        chatId: 'chat-test-1',
        cwd: '/Test 1'
      })
    ).resolves.toMatchObject({ ok: true, kind: 'emulated' })
    expect(deps.createEmulatedFork).toHaveBeenCalledTimes(1)
  })

  it('fork preserves payload shape, excludeTurns coercion, optional cwd/model, and timeout', async () => {
    const { deps, calls } = createDeps()
    registerCodexThreadHandlers(deps)

    await expect(
      handlerFor('fork-agent-thread')({}, 'codex', 'thread-1', {
        excludeTurns: 1,
        cwd: '/repo',
        model: 'gpt-5'
      })
    ).resolves.toMatchObject({
      method: 'thread/fork',
      ok: true,
      provider: 'codex',
      kind: 'native',
      payload: {
        threadId: 'thread-1',
        excludeTurns: true,
        persistExtendedHistory: true,
        cwd: '/repo',
        model: 'gpt-5'
      },
      timeoutMs: 30_000
    })
    expect(calls).toEqual(['ensure:1.2.3', 'request:thread/fork:30000'])
  })

  it('fork omits optional cwd/model when absent', async () => {
    const { deps, calls } = createDeps()
    registerCodexThreadHandlers(deps)

    await expect(
      handlerFor('fork-agent-thread')({}, 'codex', 'thread-1', {
        excludeTurns: 0
      })
    ).resolves.toMatchObject({
      method: 'thread/fork',
      ok: true,
      provider: 'codex',
      kind: 'native',
      payload: {
        threadId: 'thread-1',
        excludeTurns: false,
        persistExtendedHistory: true
      },
      timeoutMs: 30_000
    })
    expect(calls).toEqual(['ensure:1.2.3', 'request:thread/fork:30000'])
  })

  it('allows detached native fork only for the owned linked thread and forces owned cwd', async () => {
    const { deps, client } = createDeps()
    deps.resolveSenderAgentThreadScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-test-1',
      workspacePath: '/Test 1',
      linkedProviderThreads: [{ provider: 'codex', threadId: 'thread-owned' }]
    })
    registerCodexThreadHandlers(deps)
    const handler = handlerFor('fork-agent-thread')
    const event = { sender: { id: 42 } }

    await expect(
      handler(event, 'codex', 'thread-other', { chatId: 'chat-test-1' })
    ).rejects.toThrow('Renderer cannot manage an unlinked provider thread.')
    await expect(
      handler(event, 'codex', 'thread-owned', { chatId: 'chat-test-2' })
    ).rejects.toThrow('Renderer cannot manage provider threads for another chat.')
    expect(client.request).not.toHaveBeenCalled()

    await expect(
      handler(event, 'codex', 'thread-owned', { chatId: 'chat-test-1' })
    ).resolves.toMatchObject({
      ok: true,
      kind: 'native',
      payload: expect.objectContaining({
        threadId: 'thread-owned',
        cwd: '/Test 1'
      })
    })
  })

  it('allows detached rollback only for the owned linked Codex thread', async () => {
    const { deps, client } = createDeps()
    deps.resolveSenderAgentThreadScope.mockReturnValue({
      kind: 'chat',
      chatId: 'chat-test-1',
      workspacePath: '/Test 1',
      linkedProviderThreads: [{ provider: 'codex', threadId: 'thread-owned' }]
    })
    registerCodexThreadHandlers(deps)
    const handler = handlerFor('rollback-agent-thread')
    const event = { sender: { id: 42 } }

    await expect(handler(event, 'codex', 'thread-other', 1)).rejects.toThrow(
      'Renderer cannot manage an unlinked provider thread.'
    )
    expect(client.request).not.toHaveBeenCalled()
    await expect(handler(event, 'codex', 'thread-owned', 2)).resolves.toMatchObject({
      method: 'thread/rollback',
      payload: { threadId: 'thread-owned', numTurns: 2 }
    })
  })

  it('binds detached native review to the owned chat, linked thread, and workspace', () => {
    const scope: AgentThreadSenderScope = {
      kind: 'chat',
      chatId: 'chat-test-1',
      workspacePath: '/Test 1',
      linkedProviderThreads: [{ provider: 'codex', threadId: 'thread-owned' }]
    }
    const pathsEqual = (left: string, right: string) => left === right

    expect(() =>
      authorizeAgentReview(
        scope,
        'codex',
        'thread-owned',
        { appChatId: 'chat-test-3' },
        pathsEqual
      )
    ).toThrow('Renderer cannot manage provider threads for another chat.')
    expect(() =>
      authorizeAgentReview(
        scope,
        'codex',
        'thread-other',
        { appChatId: 'chat-test-1' },
        pathsEqual
      )
    ).toThrow('Renderer cannot manage an unlinked provider thread.')
    expect(() =>
      authorizeAgentReview(
        scope,
        'codex',
        'thread-owned',
        { appChatId: 'chat-test-1', cwd: '/Test 3' },
        pathsEqual
      )
    ).toThrow('Renderer cannot start a review in another workspace.')
    expect(
      authorizeAgentReview(
        scope,
        'codex',
        'thread-owned',
        { appChatId: 'chat-test-1' },
        pathsEqual
      )
    ).toEqual({ workspacePath: '/Test 1' })
  })

  it('requires a workspace for main-renderer native review', () => {
    expect(() =>
      authorizeAgentReview({ kind: 'main' }, 'codex', 'thread-1', {}, () => true)
    ).toThrow('Native review requires a workspace.')
    expect(
      authorizeAgentReview(
        { kind: 'main' },
        'codex',
        'thread-1',
        { cwd: '/Test 1' },
        () => true
      )
    ).toEqual({ workspacePath: '/Test 1' })
  })

  it.each([
    [0.9, 1],
    [0, 1],
    [-5, 1],
    [Number.NaN, 1],
    ['not-a-number', 1],
    [2.8, 2]
  ])('rollback coerces numTurns %s to %s and keeps timeout', async (input, expected) => {
    const { deps, calls } = createDeps()
    registerCodexThreadHandlers(deps)

    await expect(
      handlerFor('rollback-agent-thread')({}, 'codex', 'thread-1', input)
    ).resolves.toEqual({
      method: 'thread/rollback',
      payload: {
        threadId: 'thread-1',
        numTurns: expected
      },
      timeoutMs: 30_000
    })
    expect(calls).toEqual(['ensure:1.2.3', 'request:thread/rollback:30000'])
  })
})
