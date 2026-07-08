import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerChatHandlers } from './chatHandlers'
import type { AppSettings, ChatRecord } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

function chat(id: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: id,
    provider: 'codex',
    title: id,
    scope: 'global',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  }
}

function createDeps(overrides: Partial<Parameters<typeof registerChatHandlers>[0]> = {}) {
  const settings = { ensembleModeEnabled: true } as AppSettings
  return {
    chatService: {
      getChats: vi.fn(() => [chat('chat-1')]),
      getChatList: vi.fn(() => []),
      getPinnedMessages: vi.fn(() => []),
      getChat: vi.fn((chatId: string) => chat(chatId)),
      saveChat: vi.fn((record: ChatRecord) => record),
      deleteChat: vi.fn(),
      clearChats: vi.fn(),
      createChat: vi.fn(() => chat('created')),
      createGlobalChat: vi.fn(() => chat('global')),
      createEnsembleChat: vi.fn(() => chat('ensemble', { chatKind: 'ensemble' })),
      createSubThread: vi.fn(() => chat('sub-thread')),
      getSubThreads: vi.fn(() => [chat('sub-thread')]),
      createSideChat: vi.fn(() => chat('side-chat', { parentChatRelation: 'sideChat' })),
      getSideChats: vi.fn(() => [chat('side-chat')]),
      setChatKind: vi.fn((args: { chatId: string; targetKind: 'single' | 'ensemble' }) =>
        chat(args.chatId, { chatKind: args.targetKind })
      )
    },
    getSettings: vi.fn(() => settings),
    detectConfiguredProviders: vi.fn(async () => new Set(['codex'] as const)),
    normalizeTranscriptMarkdownMediaForChat: vi.fn((record: ChatRecord) => record),
    maybeScheduleCodexNativeGoalSync: vi.fn(),
    broadcastThreadUpdate: vi.fn(),
    broadcastThreadList: vi.fn(),
    broadcastChatUpdated: vi.fn(),
    broadcastChatPopoutUpdate: vi.fn(),
    pushRemoteTaskCardDelta: vi.fn(),
    pushRemoteThreadSnapshot: vi.fn(),
    canonicalRemoteWorkspaceId: vi.fn((workspaceId?: string | null) => workspaceId ?? null),
    globalRemoteScope: 'global',
    reapAbandonedChats: vi.fn(() => []),
    getWorkflowChatIds: vi.fn(() => new Set(['workflow-chat'])),
    getScheduledChatIds: vi.fn(() => new Set(['scheduled-chat'])),
    ...overrides
  }
}

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

describe('registerChatHandlers', () => {
  it('registers residual chat CRUD handlers', () => {
    registerChatHandlers(createDeps())

    expect(handlerFor('save-chat')).toBeTypeOf('function')
    expect(handlerFor('delete-chat')).toBeTypeOf('function')
    expect(handlerFor('reap-abandoned-chats')).toBeTypeOf('function')
    expect(handlerFor('truncate-chat')).toBeTypeOf('function')
    expect(handlerFor('clear-chats')).toBeTypeOf('function')
  })

  it('registers chat read handlers against the injected chat service', () => {
    const deps = createDeps()
    registerChatHandlers(deps)

    expect(handlerFor('get-chats')({} as any, 'workspace-1')).toEqual([chat('chat-1')])
    expect(deps.chatService.getChats).toHaveBeenCalledWith('workspace-1')

    expect(handlerFor('get-chat')({} as any, 'chat-1')).toEqual(chat('chat-1'))
    expect(deps.chatService.getChat).toHaveBeenCalledWith('chat-1')
  })

  it('broadcasts thread updates for created chat records', async () => {
    const deps = createDeps()
    registerChatHandlers(deps)

    expect(handlerFor('create-chat')({} as any, 'workspace-1', '/repo')).toEqual(chat('created'))
    expect(deps.chatService.createChat).toHaveBeenCalledWith('workspace-1', '/repo')
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('created')

    await expect(handlerFor('create-ensemble-chat')({} as any, undefined)).resolves.toEqual(
      chat('ensemble', { chatKind: 'ensemble' })
    )
    expect(deps.detectConfiguredProviders).toHaveBeenCalledWith(deps.getSettings())
    expect(deps.chatService.createEnsembleChat).toHaveBeenCalledWith(
      undefined,
      new Set(['codex'])
    )
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('ensemble')
  })

  it('preserves the ensemble disabled guard before provider detection', async () => {
    const deps = createDeps({
      getSettings: vi.fn(() => ({ ensembleModeEnabled: false }) as AppSettings)
    })
    registerChatHandlers(deps)

    await expect(handlerFor('create-ensemble-chat')({} as any, undefined)).rejects.toThrow(
      'Ensemble Mode is disabled.'
    )
    expect(deps.detectConfiguredProviders).not.toHaveBeenCalled()
  })

  it('routes set-chat-kind through the chat service and broadcasts the result', () => {
    const deps = createDeps()
    registerChatHandlers(deps)

    const result = handlerFor('set-chat-kind')({} as any, {
      chatId: 'chat-1',
      targetKind: 'ensemble'
    })
    expect(result).toEqual(chat('chat-1', { chatKind: 'ensemble' }))
    expect(deps.chatService.setChatKind).toHaveBeenCalledWith({
      chatId: 'chat-1',
      targetKind: 'ensemble'
    })
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1')
  })

  it('blocks a solo→ensemble conversion when ensemble mode is disabled', () => {
    const deps = createDeps({
      getSettings: vi.fn(() => ({ ensembleModeEnabled: false }) as AppSettings)
    })
    registerChatHandlers(deps)

    expect(() =>
      handlerFor('set-chat-kind')({} as any, { chatId: 'chat-1', targetKind: 'ensemble' })
    ).toThrow('Ensemble Mode is disabled.')
    expect(deps.chatService.setChatKind).not.toHaveBeenCalled()
  })

  it('allows an ensemble→solo conversion even when ensemble mode is disabled', () => {
    const deps = createDeps({
      getSettings: vi.fn(() => ({ ensembleModeEnabled: false }) as AppSettings)
    })
    registerChatHandlers(deps)

    const result = handlerFor('set-chat-kind')({} as any, {
      chatId: 'chat-1',
      targetKind: 'single'
    })
    expect(result).toEqual(chat('chat-1', { chatKind: 'single' }))
    expect(deps.chatService.setChatKind).toHaveBeenCalledWith({
      chatId: 'chat-1',
      targetKind: 'single'
    })
  })

  it('saves chats with the renderer-save side effects preserved', () => {
    const previous = chat('chat-1', {
      title: 'Old title',
      workspaceId: 'workspace-1',
      runs: [{ runId: 'run-1', provider: 'codex', startedAt: '2026-01-01T00:00:00.000Z' }]
    })
    const next = chat('chat-1', {
      title: 'New title',
      workspaceId: 'workspace-1',
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          runDiffByPath: { 'src/file.ts': { filePath: 'src/file.ts' } as any }
        }
      ]
    })
    const deps = createDeps()
    vi.mocked(deps.chatService.getChat).mockReturnValue(previous)
    vi.mocked(deps.chatService.saveChat).mockImplementation((record: ChatRecord) => ({
      ...record,
      title: 'New title'
    }))
    registerChatHandlers(deps)

    handlerFor('save-chat')({} as any, next)

    expect(deps.normalizeTranscriptMarkdownMediaForChat).toHaveBeenCalledWith(next)
    expect(deps.chatService.saveChat).toHaveBeenCalledWith(next)
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(expect.objectContaining({
      appChatId: 'chat-1',
      title: 'New title'
    }))
    expect(deps.maybeScheduleCodexNativeGoalSync).toHaveBeenCalledWith(
      previous,
      expect.objectContaining({ appChatId: 'chat-1' }),
      'renderer-save-chat'
    )
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1')
    expect(deps.pushRemoteTaskCardDelta).toHaveBeenCalledWith('chat-1')
    expect(deps.pushRemoteThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ appChatId: 'chat-1' }),
      'workspace-1'
    )
  })

  it('routes delete, truncate, and clear chat channels through the injected service', () => {
    const deps = createDeps()
    vi.mocked(deps.chatService.getChat).mockReturnValue(chat('chat-1', {
      messages: [{ id: 'message-1', role: 'user', content: 'hello', timestamp: 'now' }],
      runs: [{ runId: 'run-1', provider: 'codex', startedAt: '2026-01-01T00:00:00.000Z' }]
    }))
    registerChatHandlers(deps)

    handlerFor('delete-chat')({} as any, 'chat-1')
    expect(deps.chatService.deleteChat).toHaveBeenCalledWith('chat-1')
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)

    const truncated = handlerFor('truncate-chat')({} as any, 'chat-1')
    expect(truncated).toMatchObject({ appChatId: 'chat-1', messages: [], runs: [] })
    expect(deps.chatService.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({ appChatId: 'chat-1', messages: [], runs: [] })
    )
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1')

    handlerFor('clear-chats')({} as any, 'workspace-1')
    expect(deps.chatService.clearChats).toHaveBeenCalledWith('workspace-1')
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(2)
  })

  it('reaps abandoned chats with delete-only store guards and broadcasts only on changes', () => {
    const reapAbandonedChats =
      vi.fn<Parameters<typeof registerChatHandlers>[0]['reapAbandonedChats']>(() => ['old-chat'])
    const deps = createDeps({
      reapAbandonedChats
    })
    registerChatHandlers(deps)

    expect(handlerFor('reap-abandoned-chats')({} as any, {
      protectedChatIds: ['active-chat'],
      draftChatIds: ['draft-chat'],
      keepChatId: 'created-chat'
    })).toEqual({ ok: true, reaped: ['old-chat'] })

    expect(reapAbandonedChats).toHaveBeenCalledWith(
      expect.objectContaining({
        getChats: expect.any(Function),
        getWorkflowChatIds: deps.getWorkflowChatIds,
        getScheduledChatIds: deps.getScheduledChatIds,
        deleteChat: expect.any(Function)
      }),
      {
        protectedChatIds: ['active-chat'],
        draftChatIds: ['draft-chat'],
        keepChatId: 'created-chat'
      }
    )
    const reaperDeps = reapAbandonedChats.mock.calls[0]![0]
    expect(reaperDeps.getChats()).toEqual([chat('chat-1')])
    reaperDeps.deleteChat('old-chat')
    expect(deps.chatService.deleteChat).toHaveBeenCalledWith('old-chat')
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)

    reapAbandonedChats.mockReturnValueOnce([])
    expect(handlerFor('reap-abandoned-chats')({} as any, {})).toEqual({
      ok: true,
      reaped: []
    })
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)
  })
})
