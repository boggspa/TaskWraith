import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  registerCodexThreadHandlers,
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
    getAppVersion: vi.fn(() => '1.2.3'),
    providerDisplayName: vi.fn((provider: string) => provider.toUpperCase()),
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
  })

  it('ensures codex client startup before thread list with exact defaults and timeout', async () => {
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
    expect(calls).toEqual(['ensure:1.2.3', 'request:thread/list:20000'])
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
