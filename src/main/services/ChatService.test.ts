import { describe, expect, it, vi } from 'vitest'
import { ChatService, type ChatServiceDeps, type ChatServiceStore } from './ChatService'
import type { ChatListItem, ChatRecord, ProviderId, WorkspaceRecord } from '../store/types'

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

function makeStore(overrides: Partial<ChatServiceStore> = {}): ChatServiceStore {
  return {
    getChats: vi.fn(() => [makeChat()]),
    getChatList: vi.fn(() => [
      {
        ...makeChat(),
        messages: [],
        runs: [],
        summaryOnly: true,
        messageCount: 0,
        runCount: 0
      } satisfies ChatListItem
    ]),
    getPinnedMessages: vi.fn(() => [
      {
        workspaceId: 'workspace-1',
        workspacePath: '/repo',
        workspaceDisplayName: 'repo',
        chats: [
          {
            chatId: 'chat-1',
            chatTitle: 'Chat',
            provider: 'gemini' as ProviderId,
            updatedAt: 1,
            workspaceId: 'workspace-1',
            workspacePath: '/repo',
            workspaceDisplayName: 'repo',
            messages: [
              {
                id: 'message-1',
                role: 'assistant' as const,
                content: 'Pinned',
                timestamp: '2026-06-07T00:00:00.000Z',
                pinnedAt: 2
              }
            ]
          }
        ]
      }
    ]),
    getChat: vi.fn(() => makeChat()),
    createChat: vi.fn((workspaceId: string, workspacePath: string) =>
      makeChat({ workspaceId, workspacePath })
    ),
    createGlobalChat: vi.fn(() =>
      makeChat({ scope: 'global', workspaceId: undefined, workspacePath: undefined })
    ),
    createEnsembleChat: vi.fn((args) =>
      makeChat({
        appChatId: 'ensemble-1',
        chatKind: 'ensemble',
        title: 'New Ensemble',
        scope: args?.workspaceId ? 'workspace' : 'global',
        workspaceId: args?.workspaceId,
        workspacePath: args?.workspacePath
      })
    ),
    createSubThread: vi.fn((args) =>
      makeChat({
        appChatId: 'sub-thread-1',
        provider: args.provider,
        parentChatId: args.parentChatId,
        parentChatRelation: 'subThread',
        delegationContext: {
          createdAt: 2,
          parentProvider: 'gemini',
          delegationPrompt: args.delegationPrompt,
          returnResultToParent: args.returnResultToParent
        }
      })
    ),
    createSideChat: vi.fn((args) =>
      makeChat({
        appChatId: 'side-chat-1',
        chatKind: args.chatKind || 'single',
        provider: args.provider || 'gemini',
        title: args.title || 'Side chat',
        parentChatId: args.parentChatId,
        parentChatRelation: 'sideChat',
        sideChatContext: {
          createdAt: 2,
          mode: args.sideChatMode,
          lifecycleState: 'active',
          openedAt: 2,
          originMessageId: args.originMessageId,
          originRunId: args.originRunId,
          transcriptVisibility: 'none'
        }
      })
    ),
    getChildChats: vi.fn(() => [
      makeChat({
        appChatId: 'sub-thread-1',
        parentChatId: 'chat-1',
        parentChatRelation: 'subThread'
      })
    ]),
    getSideChats: vi.fn(() => [
      makeChat({
        appChatId: 'side-chat-1',
        parentChatId: 'chat-1',
        parentChatRelation: 'sideChat'
      })
    ]),
    saveChat: vi.fn(),
    deleteChat: vi.fn(),
    clearChats: vi.fn(),
    ...overrides
  }
}

function makeDeps(overrides: Partial<ChatServiceDeps> = {}): {
  deps: ChatServiceDeps
  store: ChatServiceStore
} {
  const store = makeStore()
  const deps: ChatServiceDeps = {
    appStore: store,
    findRegisteredWorkspace: vi.fn(() => makeWorkspace()),
    canonicalPath: vi.fn((value: string) => `/canonical${value}`),
    sanitizeChatForSave: vi.fn((chat: ChatRecord) => ({ ...chat, title: chat.title.trim() })),
    appendDurableRunEventForRoute: vi.fn(),
    ...overrides
  }
  return { deps, store: deps.appStore }
}

describe('ChatService', () => {
  it('forwards getChats workspace filters to the store', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    expect(service.getChats('workspace-1')).toEqual([makeChat()])
    expect(store.getChats).toHaveBeenCalledWith('workspace-1')
  })

  it('forwards getChatList workspace filters to the store', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    expect(service.getChatList('workspace-1')[0]).toMatchObject({
      appChatId: 'chat-1',
      summaryOnly: true
    })
    expect(store.getChatList).toHaveBeenCalledWith('workspace-1')
  })

  it('forwards pinned message workspace filters to the store', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    expect(service.getPinnedMessages('workspace-1')[0]).toMatchObject({
      workspaceId: 'workspace-1',
      chats: [expect.objectContaining({ chatId: 'chat-1' })]
    })
    expect(store.getPinnedMessages).toHaveBeenCalledWith('workspace-1')
  })

  it('creates workspace chats only for a matching registered workspace', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    const chat = service.createChat('workspace-1', '/repo')
    expect(chat.workspacePath).toBe('/canonical/repo')
    expect(deps.findRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(deps.canonicalPath).toHaveBeenCalledWith('/repo')
    expect(store.createChat).toHaveBeenCalledWith('workspace-1', '/canonical/repo')
  })

  it('throws the original validation error for unregistered chat workspaces', () => {
    const { deps, store } = makeDeps({
      findRegisteredWorkspace: vi.fn(() => undefined)
    })
    const service = new ChatService(deps)
    expect(() => service.createChat('workspace-1', '/missing')).toThrow(
      'Chat workspace must be a registered TaskWraith workspace.'
    )
    expect(store.createChat).not.toHaveBeenCalled()
  })

  it('sanitizes chats before saving', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    service.saveChat(makeChat({ title: '  Needs trim  ' }))
    expect(deps.sanitizeChatForSave).toHaveBeenCalledTimes(1)
    expect(store.saveChat).toHaveBeenCalledWith(makeChat({ title: 'Needs trim' }))
  })

  it('rejects unsafe chat ids before reading, saving, or deleting', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    expect(() => service.getChat('../settings')).toThrow(/safe chat id/)
    expect(() => service.deleteChat('../settings')).toThrow(/safe chat id/)
    expect(() => service.saveChat(makeChat({ appChatId: '../settings' }))).toThrow(
      /safe chat id/
    )
    expect(store.getChat).not.toHaveBeenCalled()
    expect(store.deleteChat).not.toHaveBeenCalled()
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('creates sub-threads and writes the same best-effort audit event', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    const subThread = service.createSubThread({
      parentChatId: 'chat-1',
      provider: 'codex',
      delegationPrompt: 'Investigate this',
      returnResultToParent: true
    })
    expect(subThread.appChatId).toBe('sub-thread-1')
    expect(store.createSubThread).toHaveBeenCalledWith({
      parentChatId: 'chat-1',
      provider: 'codex',
      delegationPrompt: 'Investigate this',
      returnResultToParent: true,
      workspaceId: undefined,
      workspacePath: undefined
    })
    expect(deps.appendDurableRunEventForRoute).toHaveBeenCalledWith(
      'gemini',
      { appChatId: 'chat-1' },
      'subthread_spawned',
      'control',
      'Delegated to codex sub-thread',
      {
        subThreadId: 'sub-thread-1',
        provider: 'codex',
        delegationPrompt: 'Investigate this',
        returnResultToParent: true
      }
    )
  })

  it('creates workspace ensemble chats only for a matching registered workspace', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    const chat = service.createEnsembleChat({ workspaceId: 'workspace-1', workspacePath: '/repo' })
    expect(chat.chatKind).toBe('ensemble')
    expect(store.createEnsembleChat).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace-1',
        workspacePath: '/canonical/repo'
      },
      undefined
    )
  })

  it('creates side chats and writes a side-chat audit event', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    const sideChat = service.createSideChat({
      parentChatId: 'chat-1',
      chatKind: 'ensemble',
      provider: 'codex',
      title: 'Scratch beside main',
      originMessageId: 'msg-1',
      sideChatMode: 'ensembleClone'
    })
    expect(sideChat.appChatId).toBe('side-chat-1')
    expect(sideChat.parentChatRelation).toBe('sideChat')
    expect(sideChat.sideChatContext?.lifecycleState).toBe('active')
    expect(store.createSideChat).toHaveBeenCalledWith({
      parentChatId: 'chat-1',
      chatKind: 'ensemble',
      provider: 'codex',
      title: 'Scratch beside main',
      originMessageId: 'msg-1',
      originRunId: undefined,
      sideChatMode: 'ensembleClone'
    })
    expect(deps.appendDurableRunEventForRoute).toHaveBeenCalledWith(
      'gemini',
      { appChatId: 'chat-1' },
      'side_chat_created',
      'control',
      'Opened side chat',
      {
        sideChatId: 'side-chat-1',
        chatKind: 'ensemble',
        provider: 'codex'
      }
    )
  })

  it('forwards single-provider side-chat shape for ensemble parents', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    const sideChat = service.createSideChat({
      parentChatId: 'chat-1',
      chatKind: 'single',
      provider: 'claude',
      sideChatMode: 'singleProvider'
    })
    expect(sideChat.chatKind).toBe('single')
    expect(sideChat.sideChatContext?.mode).toBe('singleProvider')
    expect(store.createSideChat).toHaveBeenCalledWith({
      parentChatId: 'chat-1',
      chatKind: 'single',
      provider: 'claude',
      title: undefined,
      originMessageId: undefined,
      originRunId: undefined,
      sideChatMode: 'singleProvider'
    })
  })

  it('lets AppStore max-depth validation errors propagate without auditing', () => {
    const maxDepthError = new Error(
      'Cannot create sub-thread: parent chat-1 is itself a sub-thread (max depth 1 in v1)'
    )
    const store = makeStore({
      createSubThread: vi.fn(() => {
        throw maxDepthError
      })
    })
    const { deps } = makeDeps({ appStore: store })
    const service = new ChatService(deps)
    expect(() =>
      service.createSubThread({
        parentChatId: 'chat-1',
        provider: 'claude',
        delegationPrompt: 'Delegate',
        returnResultToParent: false
      })
    ).toThrow(maxDepthError)
    expect(deps.appendDurableRunEventForRoute).not.toHaveBeenCalled()
  })

  it('keeps sub-thread creation successful when the audit write fails', () => {
    const { deps } = makeDeps({
      appendDurableRunEventForRoute: vi.fn(() => {
        throw new Error('no active run')
      })
    })
    const service = new ChatService(deps)
    expect(
      service.createSubThread({
        parentChatId: 'chat-1',
        provider: 'kimi',
        delegationPrompt: 'Delegate',
        returnResultToParent: false
      }).appChatId
    ).toBe('sub-thread-1')
  })

  it('validates sub-thread provider and parent id like the original handler', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    expect(() =>
      service.createSubThread({
        parentChatId: '',
        provider: 'codex',
        delegationPrompt: 'Prompt',
        returnResultToParent: false
      })
    ).toThrow('Parent chat id is required.')
    expect(() =>
      service.createSubThread({
        parentChatId: 'chat-1',
        provider: 'bad-provider' as ProviderId,
        delegationPrompt: 'Prompt',
        returnResultToParent: false
      })
    ).toThrow('Provider is invalid.')
    expect(() =>
      service.createSubThread({
        parentChatId: '../settings',
        provider: 'codex',
        delegationPrompt: 'Prompt',
        returnResultToParent: false
      })
    ).toThrow(/safe chat id/)
    expect(store.createSubThread).not.toHaveBeenCalled()
  })

  it('validates getSubThreads parent id before reading children', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    expect(() => service.getSubThreads('')).toThrow('Parent chat id is required.')
    expect(store.getChildChats).not.toHaveBeenCalled()
    service.getSubThreads('chat-1')
    expect(store.getChildChats).toHaveBeenCalledWith('chat-1')
  })

  it('validates getSideChats parent id before reading linked side chats', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    expect(() => service.getSideChats('')).toThrow('Parent chat id is required.')
    expect(store.getSideChats).not.toHaveBeenCalled()
    service.getSideChats('chat-1')
    expect(store.getSideChats).toHaveBeenCalledWith('chat-1')
  })
})
