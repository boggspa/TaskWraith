import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { deleteChatCascadeWithLifecycle, registerChatHandlers } from './chatHandlers'
import type { AppSettings, ChatListItem, ChatRecord } from '../store/types'
import type { RebindChatWorkspaceInput, RebindChatWorkspaceOptions } from '../services/ChatService'

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

function chatListItem(record: ChatRecord): ChatListItem {
  return {
    ...record,
    summaryOnly: true,
    messageCount: record.messages.length,
    runCount: record.runs.length
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
      truncateChatHistory: vi.fn((chatId: string) => chat(chatId, { messages: [], runs: [] })),
      clearChats: vi.fn(),
      prepareClearChats: vi.fn(async () => undefined),
      commitClearChats: vi.fn(),
      finishClearChats: vi.fn(),
      createChat: vi.fn(() => chat('created')),
      createGlobalChat: vi.fn(() => chat('global')),
      createEnsembleChat: vi.fn(() => chat('ensemble', { chatKind: 'ensemble' })),
      createSubThread: vi.fn(() => chat('sub-thread')),
      getSubThreads: vi.fn(() => [chat('sub-thread')]),
      createSideChat: vi.fn(() => chat('side-chat', { parentChatRelation: 'sideChat' })),
      getSideChats: vi.fn(() => [chat('side-chat')]),
      setChatKind: vi.fn((args: { chatId: string; targetKind: 'single' | 'ensemble' }) =>
        chat(args.chatId, { chatKind: args.targetKind })
      ),
      rebindChatWorkspace: vi.fn(
        (args: RebindChatWorkspaceInput | undefined, options?: RebindChatWorkspaceOptions) => {
          if (!args) throw new Error('Missing rebind args')
          const current = chat(args.chatId, {
            scope: 'workspace',
            workspaceId: 'test-1',
            workspacePath: '/Users/chrisizatt/Documents/Test 1'
          })
          options?.assertIdle?.(current)
          return chat(args.chatId, {
            scope: args.scope,
            workspaceId: args.scope === 'workspace' ? args.workspaceId : undefined,
            workspacePath: args.scope === 'workspace' ? args.workspacePath : undefined
          })
        }
      )
    },
    deleteExecutionGraphHistoryForChat: vi.fn(async () => undefined),
    revokeApprovalsForChat: vi.fn(),
    beginChatHistoryMutation: vi.fn(),
    finishChatHistoryMutation: vi.fn(),
    deleteChatWithLifecycle: vi.fn(async () => undefined),
    truncateChatWithLifecycle: vi.fn(async (chatId: string) =>
      chat(chatId, { messages: [], runs: [], persistenceRevision: 4 })
    ),
    assertParentChatCreationAllowed: vi.fn(),
    clearExecutionGraphHistory: vi.fn(async () => undefined),
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
    getOpenChatPopoutIds: vi.fn(() => new Set<string>()),
    getOpenCanvasChatIds: vi.fn(() => new Set<string>()),
    resolveSenderChatReadScope: vi.fn(() => ({ kind: 'all' as const })),
    assertSenderCanManageChatCollection: vi.fn(),
    assertSenderChatScope: vi.fn(),
    assertSenderCanRebindChatWorkspace: vi.fn(),
    getChatWorkspaceRebindBlocker: vi.fn(() => null),
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
    expect(handlerFor('rebind-chat-workspace')).toBeTypeOf('function')
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

  it('filters a chat popout to its exact Test1 chat and excludes Test3 records', () => {
    const test1 = chat('test-1-chat', {
      scope: 'workspace',
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1'
    })
    const test3 = chat('test-3-chat', {
      scope: 'workspace',
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3'
    })
    const test1ListItem = chatListItem(test1)
    const test3ListItem = chatListItem(test3)
    const getChat = vi.fn((chatId: string) =>
      chatId === test1.appChatId ? test1 : chatId === test3.appChatId ? test3 : null
    )
    const deps = createDeps({
      chatService: {
        ...createDeps().chatService,
        getChats: vi.fn(() => [test1, test3]),
        getChatList: vi.fn(() => [test1ListItem, test3ListItem]),
        getPinnedMessages: vi.fn(() => [
          {
            workspaceId: 'test-1',
            workspaceDisplayName: 'Test 1',
            chats: [
              {
                chatId: test1.appChatId,
                chatTitle: 'Test 1 chat',
                updatedAt: 1,
                workspaceId: 'test-1',
                workspaceDisplayName: 'Test 1',
                messages: []
              },
              {
                chatId: test3.appChatId,
                chatTitle: 'Test 3 chat',
                updatedAt: 1,
                workspaceId: 'test-3',
                workspaceDisplayName: 'Test 3',
                messages: []
              }
            ]
          }
        ]),
        getChat
      },
      resolveSenderChatReadScope: vi.fn(() => ({
        kind: 'chat' as const,
        chatId: test1.appChatId,
        workspaceId: 'test-1'
      }))
    })
    registerChatHandlers(deps)
    const event = { sender: { id: 41 } }

    expect(handlerFor('get-chats')(event)).toEqual([test1])
    expect(handlerFor('get-chat-list')(event)).toEqual([test1ListItem])
    expect(handlerFor('get-pinned-messages')(event)).toEqual([
      expect.objectContaining({
        chats: [expect.objectContaining({ chatId: test1.appChatId })]
      })
    ])
    expect(handlerFor('get-chat')(event, test1.appChatId)).toEqual(test1)
    expect(handlerFor('get-sub-threads')(event, test1.appChatId)).toEqual([])
    expect(handlerFor('get-side-chats')(event, test1.appChatId)).toEqual([])
    expect(deps.chatService.getSubThreads).not.toHaveBeenCalled()
    expect(deps.chatService.getSideChats).not.toHaveBeenCalled()
  })

  it('denies a Test1 chat popout before reading a Test3 chat or collection', () => {
    const deps = createDeps({
      resolveSenderChatReadScope: vi.fn(() => ({
        kind: 'chat' as const,
        chatId: 'test-1-chat',
        workspaceId: 'test-1'
      }))
    })
    registerChatHandlers(deps)
    const event = { sender: { id: 41 } }

    expect(() => handlerFor('get-chat')(event, 'test-3-chat')).toThrow(
      'Renderer does not own this chat read.'
    )
    expect(() => handlerFor('get-chats')(event, 'test-3')).toThrow(
      'Renderer does not own this workspace chat collection.'
    )
    expect(deps.chatService.getChat).not.toHaveBeenCalled()
    expect(deps.chatService.getChats).not.toHaveBeenCalled()
  })

  it('denies non-chat secondary renderers before reading any chat record', () => {
    const deps = createDeps({
      resolveSenderChatReadScope: vi.fn(() => {
        throw new Error('Only chat popouts may read chat records.')
      })
    })
    registerChatHandlers(deps)

    expect(() => handlerFor('get-chat')({ sender: { id: 52 } }, 'test-1-chat')).toThrow(
      'Only chat popouts may read chat records.'
    )
    expect(deps.chatService.getChat).not.toHaveBeenCalled()
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
    expect(deps.chatService.createEnsembleChat).toHaveBeenCalledWith(undefined, new Set(['codex']))
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

  it.each([
    {
      channel: 'create-chat',
      args: ['workspace-1', '/repo'],
      capability: 'create-chat',
      service: 'createChat'
    },
    {
      channel: 'create-global-chat',
      args: [],
      capability: 'create-global-chat',
      service: 'createGlobalChat'
    },
    {
      channel: 'create-ensemble-chat',
      args: [undefined],
      capability: 'create-ensemble-chat',
      service: 'createEnsembleChat'
    },
    {
      channel: 'clear-chats',
      args: ['workspace-1'],
      capability: 'clear-chats',
      service: 'clearChats'
    },
    {
      channel: 'reap-abandoned-chats',
      args: [{}],
      capability: 'reap-abandoned-chats',
      service: null
    }
  ] as const)(
    'rejects a secondary renderer attempting collection mutation $capability before effects',
    async ({ channel, args, capability, service }) => {
      const assertSenderCanManageChatCollection = vi.fn(() => {
        throw new Error('Only the main renderer may manage the chat collection.')
      })
      const deps = createDeps({ assertSenderCanManageChatCollection })
      registerChatHandlers(deps)
      const event = { sender: { id: 99 } }

      await expect(
        Promise.resolve().then(() => handlerFor(channel)(event, ...args))
      ).rejects.toThrow('Only the main renderer may manage the chat collection.')

      expect(assertSenderCanManageChatCollection).toHaveBeenCalledWith(event, capability)
      if (service) {
        expect(deps.chatService[service]).not.toHaveBeenCalled()
      }
      expect(deps.reapAbandonedChats).not.toHaveBeenCalled()
      expect(deps.detectConfiguredProviders).not.toHaveBeenCalled()
      expect(deps.broadcastThreadUpdate).not.toHaveBeenCalled()
      expect(deps.broadcastThreadList).not.toHaveBeenCalled()
    }
  )

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

  it.each([
    {
      channel: 'set-chat-kind',
      args: [{ chatId: 'other-chat', targetKind: 'single' }],
      capability: 'set-chat-kind',
      service: 'setChatKind'
    },
    {
      channel: 'create-side-chat',
      args: [{ parentChatId: 'other-chat', title: 'Hostile side chat' }],
      capability: 'create-side-chat',
      service: 'createSideChat'
    },
    {
      channel: 'delete-chat',
      args: ['other-chat'],
      capability: 'delete-chat',
      service: 'deleteChat'
    }
  ] as const)(
    'rejects a secondary renderer attempting cross-chat $capability before service or broadcast effects',
    ({ channel, args, capability, service }) => {
      const assertSenderChatScope = vi.fn(() => {
        throw new Error('Renderer chat ownership does not match this request.')
      })
      const deps = createDeps({ assertSenderChatScope })
      registerChatHandlers(deps)
      const event = { sender: { id: 99 } }

      expect(() => handlerFor(channel)(event, ...args)).toThrow(
        'Renderer chat ownership does not match this request.'
      )

      expect(assertSenderChatScope).toHaveBeenCalledWith(event, 'other-chat', capability)
      expect(deps.chatService[service]).not.toHaveBeenCalled()
      expect(deps.broadcastThreadUpdate).not.toHaveBeenCalled()
      expect(deps.broadcastThreadList).not.toHaveBeenCalled()
      expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()
    }
  )

  it('atomically rebinds a canonical chat and broadcasts its new workspace grouping', () => {
    const deps = createDeps()
    registerChatHandlers(deps)
    const event = { sender: { id: 42 } }

    const result = handlerFor('rebind-chat-workspace')(event, {
      chatId: 'chat-1',
      scope: 'workspace',
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3'
    })

    expect(deps.assertSenderCanRebindChatWorkspace).toHaveBeenCalledWith(event, 'chat-1')
    expect(result).toMatchObject({
      changed: true,
      chat: {
        appChatId: 'chat-1',
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      }
    })
    expect(deps.getChatWorkspaceRebindBlocker).toHaveBeenCalledWith('chat-1')
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith((result as any).chat)
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1')
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)
  })

  it('rejects an unauthorized secondary renderer before any workspace rebind side effect', () => {
    const deps = createDeps({
      assertSenderCanRebindChatWorkspace: vi.fn(() => {
        throw new Error('Renderer chat ownership does not match this request.')
      })
    })
    registerChatHandlers(deps)
    const event = { sender: { id: 99 } }

    expect(() =>
      handlerFor('rebind-chat-workspace')(event, {
        chatId: 'other-chat',
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      })
    ).toThrow('Renderer chat ownership does not match this request.')

    expect(deps.assertSenderCanRebindChatWorkspace).toHaveBeenCalledWith(event, 'other-chat')
    expect(deps.chatService.getChat).not.toHaveBeenCalled()
    expect(deps.chatService.rebindChatWorkspace).not.toHaveBeenCalled()
    expect(deps.getChatWorkspaceRebindBlocker).not.toHaveBeenCalled()
    expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(deps.broadcastThreadUpdate).not.toHaveBeenCalled()
    expect(deps.broadcastThreadList).not.toHaveBeenCalled()
  })

  it('returns a canonical no-op without broadcasting workspace churn', () => {
    const canonical = chat('chat-1', {
      scope: 'workspace',
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3'
    })
    const deps = createDeps({
      chatService: {
        ...createDeps().chatService,
        getChat: vi.fn(() => canonical),
        rebindChatWorkspace: vi.fn(() => canonical)
      }
    })
    registerChatHandlers(deps)

    expect(
      handlerFor('rebind-chat-workspace')({} as any, {
        chatId: 'chat-1',
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      })
    ).toEqual({ chat: canonical, changed: false })
    expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(deps.broadcastThreadUpdate).not.toHaveBeenCalled()
    expect(deps.broadcastThreadList).not.toHaveBeenCalled()
  })

  it.each(['active', 'queued'] as const)(
    'rejects a workspace rebind while main reports %s turn ownership',
    (blocker) => {
      const deps = createDeps({
        getChatWorkspaceRebindBlocker: vi.fn(() => blocker)
      })
      registerChatHandlers(deps)

      expect(() =>
        handlerFor('rebind-chat-workspace')({} as any, {
          chatId: 'chat-1',
          scope: 'workspace',
          workspaceId: 'test-3',
          workspacePath: '/Users/chrisizatt/Documents/Test 3'
        })
      ).toThrow(`turn is ${blocker}`)
      expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()
      expect(deps.broadcastThreadUpdate).not.toHaveBeenCalled()
      expect(deps.broadcastThreadList).not.toHaveBeenCalled()
    }
  )

  it('fails closed when the main lifecycle ownership guard is not wired', () => {
    const deps = createDeps({ getChatWorkspaceRebindBlocker: undefined })
    registerChatHandlers(deps)

    expect(() =>
      handlerFor('rebind-chat-workspace')({} as any, {
        chatId: 'chat-1',
        scope: 'global'
      })
    ).toThrow('lifecycle guard is unavailable')
    expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()
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
      title: 'New title',
      persistenceRevision: 8
    }))
    registerChatHandlers(deps)

    const saved = handlerFor('save-chat')({} as any, next)

    expect(saved).toMatchObject({
      accepted: true,
      previous,
      chat: {
        appChatId: 'chat-1',
        title: 'New title',
        persistenceRevision: 8
      }
    })

    expect(deps.normalizeTranscriptMarkdownMediaForChat).toHaveBeenCalledWith(next)
    expect(deps.chatService.saveChat).toHaveBeenCalledWith(next)
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        appChatId: 'chat-1',
        title: 'New title'
      })
    )
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

  it('reports a stale save rejection without lending the canonical revision to queued writes', () => {
    const canonical = chat('chat-1', {
      title: 'Main-process mutation',
      persistenceRevision: 8
    })
    const stale = chat('chat-1', {
      title: 'Stale renderer mutation',
      persistenceRevision: 7
    })
    const deps = createDeps()
    vi.mocked(deps.chatService.getChat).mockReturnValue(canonical)
    vi.mocked(deps.chatService.saveChat).mockReturnValue(canonical)
    registerChatHandlers(deps)

    expect(handlerFor('save-chat')({} as any, stale)).toEqual({
      chat: canonical,
      previous: canonical,
      accepted: false
    })
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(canonical)
  })

  it('preserves main-owned graph transcript evidence across renderer saves', () => {
    const durable = chat('chat-1', {
      messages: [
        {
          id: 'graph-output',
          role: 'assistant',
          content: 'Durable result',
          timestamp: 'now',
          runId: 'graph-run',
          metadata: { kind: 'executionGraphAttemptOutput' }
        }
      ],
      runs: [
        {
          runId: 'graph-run',
          provider: 'codex',
          startedAt: '2026-01-01T00:00:00.000Z',
          providerMetadata: { executionGraphAttempt: { schemaVersion: 1 } }
        }
      ]
    })
    const renderer = chat('chat-1', { messages: [], runs: [] })
    const deps = createDeps()
    vi.mocked(deps.chatService.getChat).mockReturnValue(durable)
    vi.mocked(deps.chatService.saveChat).mockImplementation((record) => record)
    registerChatHandlers(deps)

    handlerFor('save-chat')({} as any, renderer)

    expect(deps.chatService.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ id: 'graph-output', content: 'Durable result' })],
        runs: [expect.objectContaining({ runId: 'graph-run' })]
      })
    )
  })

  it('drops renderer-forged graph transcript rows when no durable graph run owns them', () => {
    const durable = chat('chat-1', { messages: [], runs: [] })
    const renderer = chat('chat-1', {
      messages: [
        {
          id: 'forged-output',
          role: 'assistant',
          content: 'Counterfeit result',
          timestamp: 'now',
          runId: 'forged-run',
          metadata: { kind: 'executionGraphAttemptOutput' }
        }
      ],
      runs: [
        {
          runId: 'forged-run',
          provider: 'codex',
          startedAt: '2026-01-01T00:00:00.000Z',
          providerMetadata: { executionGraphAttempt: { schemaVersion: 1 } }
        }
      ]
    })
    const deps = createDeps()
    vi.mocked(deps.chatService.getChat).mockReturnValue(durable)
    vi.mocked(deps.chatService.saveChat).mockImplementation((record) => record)
    registerChatHandlers(deps)

    handlerFor('save-chat')({} as any, renderer)

    expect(deps.chatService.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [], runs: [] })
    )
  })

  it('authorizes save-chat from the payload appChatId before normalization or service effects', () => {
    const assertSenderChatScope = vi.fn(() => {
      throw new Error('Renderer chat ownership does not match this request.')
    })
    const deps = createDeps({ assertSenderChatScope })
    registerChatHandlers(deps)
    const event = { sender: { id: 99 } }
    const hostileRecord = chat('other-chat', { title: 'Cross-chat overwrite' })

    expect(() => handlerFor('save-chat')(event, hostileRecord)).toThrow(
      'Renderer chat ownership does not match this request.'
    )

    expect(assertSenderChatScope).toHaveBeenCalledWith(event, 'other-chat', 'save-chat')
    expect(deps.normalizeTranscriptMarkdownMediaForChat).not.toHaveBeenCalled()
    expect(deps.chatService.getChat).not.toHaveBeenCalled()
    expect(deps.chatService.saveChat).not.toHaveBeenCalled()
    expect(deps.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(deps.maybeScheduleCodexNativeGoalSync).not.toHaveBeenCalled()
    expect(deps.broadcastThreadUpdate).not.toHaveBeenCalled()
    expect(deps.pushRemoteTaskCardDelta).not.toHaveBeenCalled()
    expect(deps.pushRemoteThreadSnapshot).not.toHaveBeenCalled()
  })

  it('routes delete, truncate, and clear chat channels through the injected service', async () => {
    const deps = createDeps()
    vi.mocked(deps.chatService.getChat).mockReturnValue(
      chat('chat-1', {
        messages: [{ id: 'message-1', role: 'user', content: 'hello', timestamp: 'now' }],
        runs: [{ runId: 'run-1', provider: 'codex', startedAt: '2026-01-01T00:00:00.000Z' }]
      })
    )
    vi.mocked(deps.chatService.saveChat).mockImplementation((record: ChatRecord) => ({
      ...record,
      persistenceRevision: 4
    }))
    registerChatHandlers(deps)

    await handlerFor('delete-chat')({} as any, 'chat-1')
    expect(deps.deleteChatWithLifecycle).toHaveBeenCalledWith('chat-1')
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)

    const truncated = await handlerFor('truncate-chat')({} as any, 'chat-1')
    expect(deps.truncateChatWithLifecycle).toHaveBeenCalledWith('chat-1')
    expect(truncated).toMatchObject({
      appChatId: 'chat-1',
      messages: [],
      runs: [],
      persistenceRevision: 4
    })
    expect(deps.broadcastChatUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ appChatId: 'chat-1', persistenceRevision: 4 })
    )
    expect(deps.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1')

    await handlerFor('clear-chats')({} as any, 'workspace-1')
    expect(deps.chatService.clearChats).toHaveBeenCalledWith('workspace-1')
    expect(deps.chatService.prepareClearChats).not.toHaveBeenCalled()
    expect(deps.clearExecutionGraphHistory).not.toHaveBeenCalled()
    expect(deps.chatService.commitClearChats).not.toHaveBeenCalled()
    expect(deps.chatService.finishClearChats).not.toHaveBeenCalled()
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(2)
  })

  it('propagates failures from each shared history lifecycle without broadcasting', async () => {
    const baseline = createDeps()
    const deps = createDeps({
      chatService: {
        ...baseline.chatService,
        clearChats: vi.fn(async () => {
          throw new Error('graph clear unresolved')
        })
      },
      deleteChatWithLifecycle: vi.fn(async () => {
        throw new Error('graph cleanup unresolved')
      }),
      truncateChatWithLifecycle: vi.fn(async () => {
        throw new Error('graph cleanup unresolved')
      })
    })
    registerChatHandlers(deps)

    await expect(handlerFor('delete-chat')({} as any, 'chat-1')).rejects.toThrow(
      'graph cleanup unresolved'
    )
    expect(deps.chatService.deleteChat).not.toHaveBeenCalled()
    expect(deps.broadcastThreadList).not.toHaveBeenCalled()

    vi.mocked(deps.chatService.getChat).mockReturnValue(chat('chat-1'))
    await expect(handlerFor('truncate-chat')({} as any, 'chat-1')).rejects.toThrow(
      'graph cleanup unresolved'
    )
    expect(deps.chatService.saveChat).not.toHaveBeenCalled()

    await expect(handlerFor('clear-chats')({} as any)).rejects.toThrow('graph clear unresolved')
    expect(deps.chatService.clearChats).toHaveBeenCalledWith(undefined)
    expect(deps.chatService.prepareClearChats).not.toHaveBeenCalled()
    expect(deps.clearExecutionGraphHistory).not.toHaveBeenCalled()
    expect(deps.chatService.commitClearChats).not.toHaveBeenCalled()
    expect(deps.chatService.finishClearChats).not.toHaveBeenCalled()
    expect(deps.broadcastThreadList).not.toHaveBeenCalled()
  })

  it('passes strict shared-clear failures through without attempting local cleanup', async () => {
    const baseline = createDeps()
    const deps = createDeps({
      chatService: {
        ...baseline.chatService,
        clearChats: vi.fn(async () => {
          throw new Error('strict bridge purge fsync failed')
        })
      }
    })
    registerChatHandlers(deps)

    await expect(handlerFor('clear-chats')({} as any)).rejects.toThrow(
      'strict bridge purge fsync failed'
    )
    expect(deps.chatService.clearChats).toHaveBeenCalledWith(undefined)
    expect(deps.chatService.prepareClearChats).not.toHaveBeenCalled()
    expect(deps.clearExecutionGraphHistory).not.toHaveBeenCalled()
    expect(deps.chatService.commitClearChats).not.toHaveBeenCalled()
    expect(deps.chatService.finishClearChats).not.toHaveBeenCalled()
    expect(deps.broadcastThreadList).not.toHaveBeenCalled()
  })

  it('awaits the shared clear lifecycle before broadcasting completion', async () => {
    let releaseClear!: () => void
    const clear = new Promise<void>((resolve) => {
      releaseClear = resolve
    })
    const baseline = createDeps()
    const deps = createDeps({
      chatService: {
        ...baseline.chatService,
        clearChats: vi.fn(() => clear)
      }
    })
    registerChatHandlers(deps)

    const clearing = handlerFor('clear-chats')({} as any, 'workspace-a')
    await Promise.resolve()

    expect(deps.chatService.clearChats).toHaveBeenCalledWith('workspace-a')
    expect(deps.broadcastThreadList).not.toHaveBeenCalled()

    releaseClear()
    await clearing
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)
  })

  it('delete-chat revokes chat authority before awaiting graph cleanup', async () => {
      let releaseGraph!: () => void
      const graphClear = new Promise<void>((resolve) => {
        releaseGraph = resolve
      })
      const order: string[] = []
      const deps = createDeps({
        beginChatHistoryMutation: vi.fn(() => {
          order.push('begin')
        }),
        revokeApprovalsForChat: vi.fn(() => order.push('revoke')),
        deleteExecutionGraphHistoryForChat: vi.fn(() => {
          order.push('graph')
          return graphClear
        }),
        finishChatHistoryMutation: vi.fn(() => order.push('finish'))
      })
      deps.deleteChatWithLifecycle = vi.fn((chatId: string) =>
        deleteChatCascadeWithLifecycle(
          {
            getChats: deps.chatService.getChats,
            deleteChat: deps.chatService.deleteChat,
            beginChatHistoryMutation: deps.beginChatHistoryMutation,
            finishChatHistoryMutation: deps.finishChatHistoryMutation,
            revokeApprovalsForChat: deps.revokeApprovalsForChat,
            deleteExecutionGraphHistoryForChat: deps.deleteExecutionGraphHistoryForChat
          },
          chatId
        )
      )
      vi.mocked(deps.chatService.getChat).mockReturnValue(chat('chat-1'))
      registerChatHandlers(deps)

      const deleting = handlerFor('delete-chat')({} as any, 'chat-1')
      await vi.waitFor(() => expect(order).toEqual(['begin', 'revoke', 'graph']))
      expect(deps.chatService.deleteChat).not.toHaveBeenCalled()
      expect(deps.chatService.saveChat).not.toHaveBeenCalled()

      releaseGraph()
      await deleting
      expect(order.at(-1)).toBe('finish')
  })

  it('reaps abandoned chats with delete-only store guards and broadcasts only on changes', async () => {
    const reapAbandonedChats = vi.fn<
      Parameters<typeof registerChatHandlers>[0]['reapAbandonedChats']
    >((reaperDeps) => {
      reaperDeps.deleteChat('old-chat')
      return ['old-chat']
    })
    const deps = createDeps({
      reapAbandonedChats
    })
    registerChatHandlers(deps)

    await expect(
      handlerFor('reap-abandoned-chats')({} as any, {
        protectedChatIds: ['active-chat'],
        draftChatIds: ['draft-chat'],
        keepChatId: 'created-chat'
      })
    ).resolves.toEqual({ ok: true, reaped: ['old-chat'] })

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
    expect(deps.deleteChatWithLifecycle).toHaveBeenCalledWith('old-chat')
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)

    reapAbandonedChats.mockReturnValueOnce([])
    await expect(handlerFor('reap-abandoned-chats')({} as any, {})).resolves.toEqual({
      ok: true,
      reaped: []
    })
    expect(deps.broadcastThreadList).toHaveBeenCalledTimes(1)
  })

  it('authoritatively protects live chat popouts after their handoff payload is consumed', async () => {
    const reapAbandonedChats = vi.fn<
      Parameters<typeof registerChatHandlers>[0]['reapAbandonedChats']
    >(() => [])
    const deps = createDeps({
      reapAbandonedChats,
      getOpenChatPopoutIds: vi.fn(() => new Set(['open-popout', 'already-protected']))
    })
    registerChatHandlers(deps)

    await expect(
      handlerFor('reap-abandoned-chats')({} as any, {
        protectedChatIds: ['active-chat', 'already-protected'],
        draftChatIds: ['draft-chat'],
        keepChatId: 'created-chat'
      })
    ).resolves.toEqual({ ok: true, reaped: [] })

    expect(reapAbandonedChats).toHaveBeenCalledWith(expect.any(Object), {
      protectedChatIds: ['active-chat', 'already-protected', 'open-popout'],
      draftChatIds: ['draft-chat'],
      keepChatId: 'created-chat'
    })
  })
})
