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
    broadcastThreadUpdate: vi.fn(),
    broadcastChatPopoutUpdate: vi.fn(),
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
})
