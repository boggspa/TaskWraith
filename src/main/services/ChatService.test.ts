import { describe, expect, it, vi } from 'vitest'
import { ChatService, type ChatServiceDeps, type ChatServiceStore } from './ChatService'
import type {
  ChatListItem,
  ChatRecord,
  EnsembleParticipant,
  ExternalPathGrant,
  ProviderId,
  ProviderSeatGeneration,
  WorkspaceRecord
} from '../store/types'

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

function makeExternalGrant(provider: ProviderId, path: string): ExternalPathGrant {
  return {
    id: `${provider}:${path}`,
    provider,
    path,
    kind: 'directory',
    access: 'write',
    duration: 'thisThread',
    issuedBy: 'main',
    signature: 'signed-for-old-workspace',
    createdAt: '2026-07-13T00:00:00.000Z'
  }
}

function makeSeatGeneration(provider: ProviderId): ProviderSeatGeneration {
  return {
    schemaVersion: 1,
    id: `seat-${provider}-old-workspace`,
    ordinal: 4,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    config: {
      provider,
      model: `${provider}-model`,
      transport: 'cli-opaque',
      systemPromptFingerprint: 'system-old-workspace',
      toolsFingerprint: 'tools-old-workspace'
    },
    guaranteeTier: 'best-effort',
    cacheEvidence: {
      state: 'observed_hit',
      observedAt: '2026-07-13T00:00:00.000Z',
      runId: 'run-old-workspace',
      guaranteeTier: 'best-effort',
      cacheReadInputTokens: 1200,
      cacheCreationInputTokens: 0
    }
  }
}

function makeContextSummary(
  provider: ProviderId
): NonNullable<ChatRecord['contextCompactionSummary']> {
  return {
    text: 'Old workspace compacted context.',
    createdAt: '2026-07-13T00:00:00.000Z',
    provider
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
    setChatKind: vi.fn((chatId: string, targetKind: 'single' | 'ensemble') =>
      makeChat({ appChatId: chatId, chatKind: targetKind })
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
    saveChat: vi.fn((chat: ChatRecord) => chat),
    deleteChat: vi.fn(),
    clearChats: vi.fn(),
    ...overrides
  }
}

function makeStatefulStore(initial: ChatRecord): ChatServiceStore {
  let stored = initial
  return makeStore({
    getChat: vi.fn(() => stored),
    saveChat: vi.fn((chat: ChatRecord) => {
      stored = chat
      return chat
    })
  })
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

  it('rejects a stale full-record save after canonical transcript, run, and config advances', () => {
    const initial = makeChat({
      persistenceRevision: 7,
      requestedModel: 'codex-old-model',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Initial prompt',
          timestamp: '2026-07-13T20:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          startedAt: '2026-07-13T20:00:00.000Z'
        }
      ]
    })
    const snapshotA = {
      ...initial,
      messages: [...initial.messages],
      runs: [...initial.runs]
    }
    const staleSnapshotB = {
      ...initial,
      messages: [...initial.messages],
      runs: [...initial.runs]
    }
    const canonical = {
      ...snapshotA,
      persistenceRevision: 8,
      requestedModel: 'codex-new-model',
      messages: [
        ...snapshotA.messages,
        {
          id: 'message-2',
          role: 'assistant' as const,
          content: 'Canonical append',
          timestamp: '2026-07-13T20:00:01.000Z'
        }
      ],
      runs: [
        ...snapshotA.runs,
        {
          runId: 'run-2',
          provider: 'codex' as const,
          startedAt: '2026-07-13T20:00:01.000Z'
        }
      ]
    }
    const store = makeStore({ getChat: vi.fn(() => canonical) })
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({
      ...staleSnapshotB,
      title: 'Stale popout title'
    })

    expect(saved).toBe(canonical)
    expect(saved.persistenceRevision).toBe(8)
    expect(saved.messages.map((message) => message.id)).toEqual(['message-1', 'message-2'])
    expect(saved.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2'])
    expect(saved.requestedModel).toBe('codex-new-model')
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('fences canonical grants from stale renderer saves while accepting display order', () => {
    const revoked = {
      ...makeExternalGrant('claude', '/revoked'),
      id: 'revoked',
      signature: 'revoked-signature',
      order: 0
    }
    const canonical = {
      ...makeExternalGrant('codex', '/canonical'),
      id: 'canonical',
      signature: 'canonical-signature',
      access: 'read' as const,
      order: 1
    }
    const current = makeChat({
      providerMetadata: {
        rendererSetting: 'current',
        externalPathGrants: [canonical]
      }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat(
      makeChat({
        providerMetadata: {
          rendererSetting: 'next',
          externalPathGrants: [
            revoked,
            {
              ...canonical,
              path: '/renderer-forged-path',
              access: 'write',
              order: 0
            }
          ]
        }
      })
    )

    expect(saved.providerMetadata).toEqual({
      rendererSetting: 'next',
      externalPathGrants: [{ ...canonical, order: 0 }]
    })
    expect(store.saveChat).toHaveBeenCalledWith(saved)
  })

  it('strips renderer-authored grants when main has no canonical grant metadata', () => {
    const current = makeChat({ providerMetadata: { rendererSetting: 'current' } })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat(
      makeChat({
        providerMetadata: {
          rendererSetting: 'next',
          externalPathGrants: [makeExternalGrant('codex', '/forged')]
        }
      })
    )

    expect(saved.providerMetadata).toEqual({ rendererSetting: 'next' })
  })

  it('strips renderer grant authority from chat-kind conversion inputs', () => {
    const setChatKind = vi.fn((chatId: string, targetKind: 'single' | 'ensemble') =>
      makeChat({ appChatId: chatId, chatKind: targetKind })
    )
    const { deps } = makeDeps({ appStore: makeStore({ setChatKind }) })
    const service = new ChatService(deps)
    const forgedGrant = makeExternalGrant('codex', '/revoked')

    service.setChatKind({
      chatId: 'chat-1',
      targetKind: 'single',
      canonicalProvider: 'codex',
      canonicalProviderMetadata: {
        selectedModelType: 'gpt-safe',
        externalPathGrants: [forgedGrant],
        codexExternalPathGrants: [forgedGrant]
      }
    })

    expect(setChatKind).toHaveBeenLastCalledWith('chat-1', 'single', {
      seedParticipant: undefined,
      canonicalProvider: 'codex',
      canonicalProviderMetadata: { selectedModelType: 'gpt-safe' }
    })

    const seedParticipant: EnsembleParticipant = {
      id: 'seed',
      provider: 'codex',
      enabled: true,
      role: 'Boss',
      instructions: '',
      order: 0,
      permissionOverrides: {
        networkAccess: 'deny',
        externalPathGrants: [forgedGrant]
      }
    }
    service.setChatKind({ chatId: 'chat-1', targetKind: 'ensemble', seedParticipant })

    expect(setChatKind).toHaveBeenLastCalledWith('chat-1', 'ensemble', {
      seedParticipant: {
        ...seedParticipant,
        permissionOverrides: { networkAccess: 'deny' }
      },
      canonicalProvider: undefined,
      canonicalProviderMetadata: undefined
    })
  })

  it('atomically rebinds a solo Claude chat from Test 1 to Test 3 with fresh continuity', () => {
    const receipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-test-1-session',
      pinnedAt: '2026-07-13T00:00:00.000Z'
    }
    const current = makeChat({
      provider: 'claude',
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1',
      linkedProviderSessionId: 'claude-test-1-session',
      linkedGeminiSessionId: 'legacy-test-1-session',
      taskWraithMcpProfileReceipt: receipt,
      seatGeneration: makeSeatGeneration('claude'),
      contextCompactionSummary: makeContextSummary('claude'),
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Keep this history.',
          timestamp: '2026-07-13T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: 'run-1',
          provider: 'claude',
          startedAt: '2026-07-13T00:00:00.000Z',
          status: 'completed'
        }
      ],
      providerMetadata: {
        customSetting: 'preserved',
        externalPathGrants: [makeExternalGrant('claude', '/Users/chrisizatt/Documents/Test 2')],
        codexExternalPathGrants: [makeExternalGrant('codex', '/Users/chrisizatt/Documents/Test 4')]
      }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({
      appStore: store,
      findRegisteredWorkspace: vi.fn((path: string) =>
        path === '/Users/chrisizatt/Documents/Test 3'
          ? makeWorkspace({
              id: 'test-3',
              path: '/Users/chrisizatt/Documents/Test 3',
              displayName: 'Test 3'
            })
          : undefined
      ),
      canonicalPath: vi.fn((path: string) => path)
    })
    const service = new ChatService(deps)
    const assertIdle = vi.fn()

    const rebound = service.rebindChatWorkspace(
      {
        chatId: current.appChatId,
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      },
      { assertIdle, now: 1234 }
    )

    expect(assertIdle).toHaveBeenCalledWith(current)
    expect(rebound).toMatchObject({
      appChatId: 'chat-1',
      scope: 'workspace',
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3',
      updatedAt: 1234,
      messages: current.messages,
      runs: current.runs,
      providerMetadata: { customSetting: 'preserved' }
    })
    expect(rebound.linkedProviderSessionId).toBeUndefined()
    expect(rebound.linkedGeminiSessionId).toBeUndefined()
    expect(rebound.taskWraithMcpProfileReceipt).toBeUndefined()
    expect(rebound.seatGeneration).toBeUndefined()
    expect(rebound.contextCompactionSummary).toBeUndefined()
    expect(rebound.providerMetadata).toEqual({ customSetting: 'preserved' })
    expect(store.saveChat).toHaveBeenCalledWith(rebound)
  })

  it('rebinds an Ensemble from Test 1 to Test 3 without leaking any seat receipts', () => {
    const claudeReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-test-1-session',
      pinnedAt: '2026-07-13T00:00:00.000Z'
    }
    const codexReceipt = {
      ...claudeReceipt,
      provider: 'codex' as const,
      providerSessionId: 'codex-test-1-session'
    }
    const current = makeChat({
      chatKind: 'ensemble',
      provider: 'claude',
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1',
      linkedProviderSessionId: 'claude-top-level-session',
      linkedGeminiSessionId: 'legacy-ensemble-test-1-session',
      taskWraithMcpProfileReceipt: {
        ...claudeReceipt,
        providerSessionId: 'claude-top-level-session'
      },
      seatGeneration: makeSeatGeneration('claude'),
      contextCompactionSummary: makeContextSummary('claude'),
      providerMetadata: {
        rosterSetting: 'preserved',
        externalPathGrants: [makeExternalGrant('claude', '/Users/chrisizatt/Documents/Test 2')],
        kimiExternalPathGrants: [makeExternalGrant('kimi', '/Users/chrisizatt/Documents/Test 4')]
      },
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Existing transcript',
          timestamp: '2026-07-13T00:00:00.000Z'
        }
      ],
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        orchestrationMode: 'continuous',
        maxContinuationHops: 12,
        participants: [
          {
            id: 'boss',
            provider: 'claude',
            enabled: true,
            role: 'Boss',
            instructions: 'Coordinate.',
            order: 1,
            permissionPresetId: 'workspace_write',
            permissionOverrides: {
              approvalMode: 'plan',
              externalPathGrants: [
                makeExternalGrant('claude', '/Users/chrisizatt/Documents/Test 2')
              ]
            },
            linkedProviderSessionId: 'claude-test-1-session',
            taskWraithMcpProfileReceipt: claudeReceipt,
            promptShellVersion: 'ensemble-shell-v1:test-1',
            promptDynamicStateVersion: 'ensemble-dynamic-v1:test-1',
            seatGeneration: makeSeatGeneration('claude'),
            contextCompactionSummary: makeContextSummary('claude')
          },
          {
            id: 'reviewer',
            provider: 'codex',
            enabled: true,
            role: 'Reviewer',
            instructions: 'Review only.',
            order: 2,
            permissionPresetId: 'read_only',
            permissionOverrides: {
              externalPathGrants: [makeExternalGrant('codex', '/Users/chrisizatt/Documents/Test 4')]
            },
            linkedProviderSessionId: 'codex-test-1-session',
            taskWraithMcpProfileReceipt: codexReceipt,
            promptShellVersion: 'ensemble-shell-v1:test-1-reviewer',
            promptDynamicStateVersion: 'ensemble-dynamic-v1:test-1-reviewer',
            seatGeneration: makeSeatGeneration('codex'),
            contextCompactionSummary: makeContextSummary('codex')
          }
        ]
      }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({
      appStore: store,
      findRegisteredWorkspace: vi.fn(() =>
        makeWorkspace({
          id: 'test-3',
          path: '/Users/chrisizatt/Documents/Test 3',
          displayName: 'Test 3'
        })
      ),
      canonicalPath: vi.fn((path: string) => path)
    })
    const service = new ChatService(deps)

    const rebound = service.rebindChatWorkspace(
      {
        chatId: current.appChatId,
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      },
      { now: 4321 }
    )

    expect(rebound.messages).toEqual(current.messages)
    expect(rebound.ensemble).toMatchObject({
      enabled: true,
      orchestrationMode: 'continuous',
      maxContinuationHops: 12,
      updatedAt: new Date(4321).toISOString(),
      participants: [
        expect.objectContaining({
          id: 'boss',
          role: 'Boss',
          instructions: 'Coordinate.',
          permissionPresetId: 'workspace_write'
        }),
        expect.objectContaining({
          id: 'reviewer',
          role: 'Reviewer',
          instructions: 'Review only.',
          permissionPresetId: 'read_only'
        })
      ]
    })
    expect(rebound.linkedProviderSessionId).toBeUndefined()
    expect(rebound.linkedGeminiSessionId).toBeUndefined()
    expect(rebound.taskWraithMcpProfileReceipt).toBeUndefined()
    expect(rebound.seatGeneration).toBeUndefined()
    expect(rebound.contextCompactionSummary).toBeUndefined()
    expect(rebound.providerMetadata).toEqual({ rosterSetting: 'preserved' })
    for (const participant of rebound.ensemble?.participants || []) {
      expect(participant.linkedProviderSessionId).toBeUndefined()
      expect(participant.taskWraithMcpProfileReceipt).toBeUndefined()
      expect(participant.promptShellVersion).toBeUndefined()
      expect(participant.promptDynamicStateVersion).toBeUndefined()
      expect(participant.seatGeneration).toBeUndefined()
      expect(participant.contextCompactionSummary).toBeUndefined()
      expect(participant.permissionOverrides?.externalPathGrants).toBeUndefined()
    }
    expect(rebound.ensemble?.participants[0].permissionOverrides).toEqual({ approvalMode: 'plan' })
    expect(rebound.ensemble?.participants[1].permissionOverrides).toBeUndefined()
  })

  it('rejects an active workspace rebind before saving the validated target', () => {
    const current = makeChat({
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1'
    })
    const store = makeStore({ getChat: vi.fn(() => current) })
    const { deps } = makeDeps({
      appStore: store,
      findRegisteredWorkspace: vi.fn(() =>
        makeWorkspace({
          id: 'test-3',
          path: '/Users/chrisizatt/Documents/Test 3',
          displayName: 'Test 3'
        })
      )
    })
    const service = new ChatService(deps)

    expect(() =>
      service.rebindChatWorkspace(
        {
          chatId: current.appChatId,
          scope: 'workspace',
          workspaceId: 'test-3',
          workspacePath: '/Users/chrisizatt/Documents/Test 3'
        },
        {
          assertIdle: () => {
            throw new Error('Cannot change chat workspace while a turn is active.')
          }
        }
      )
    ).toThrow('turn is active')
    expect(deps.findRegisteredWorkspace).toHaveBeenCalledWith('/Users/chrisizatt/Documents/Test 3')
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('rejects an unregistered rebind target without mutating the canonical chat', () => {
    const current = makeChat()
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({
      appStore: store,
      findRegisteredWorkspace: vi.fn(() => undefined)
    })
    const service = new ChatService(deps)

    expect(() =>
      service.rebindChatWorkspace({
        chatId: current.appChatId,
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      })
    ).toThrow('registered TaskWraith workspace')
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('rebinds a workspace chat to global scope and clears linked sessions', () => {
    const current = makeChat({
      provider: 'claude',
      linkedProviderSessionId: 'claude-workspace-session',
      linkedGeminiSessionId: 'legacy-gemini-session',
      seatGeneration: makeSeatGeneration('claude'),
      contextCompactionSummary: makeContextSummary('claude'),
      providerMetadata: {
        externalPathGrants: [makeExternalGrant('claude', '/Users/chrisizatt/Documents/Test 2')]
      }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })
    const service = new ChatService(deps)

    const rebound = service.rebindChatWorkspace(
      { chatId: current.appChatId, scope: 'global' },
      { now: 9999 }
    )

    expect(rebound).toMatchObject({ scope: 'global', updatedAt: 9999 })
    expect(rebound.workspaceId).toBeUndefined()
    expect(rebound.workspacePath).toBeUndefined()
    expect(rebound.linkedProviderSessionId).toBeUndefined()
    expect(rebound.linkedGeminiSessionId).toBeUndefined()
    expect(rebound.seatGeneration).toBeUndefined()
    expect(rebound.contextCompactionSummary).toBeUndefined()
    expect(rebound.providerMetadata).toBeUndefined()
  })

  it('canonicalizes a global chat with leftover workspace fields instead of treating it as a no-op', () => {
    const current = makeChat({
      scope: 'global',
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1',
      linkedProviderSessionId: 'old-workspace-session'
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })
    const assertIdle = vi.fn()

    const rebound = new ChatService(deps).rebindChatWorkspace(
      { chatId: current.appChatId, scope: 'global' },
      { assertIdle, now: 10_000 }
    )

    expect(assertIdle).toHaveBeenCalledWith(current)
    expect(rebound.scope).toBe('global')
    expect(rebound.workspaceId).toBeUndefined()
    expect(rebound.workspacePath).toBeUndefined()
    expect(rebound.linkedProviderSessionId).toBeUndefined()
    expect(store.saveChat).toHaveBeenCalledWith(rebound)
  })

  it('returns the canonical chat unchanged when the target workspace is already bound', () => {
    const current = makeChat({
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3',
      linkedProviderSessionId: 'still-valid-test-3-session'
    })
    const store = makeStore({ getChat: vi.fn(() => current) })
    const { deps } = makeDeps({
      appStore: store,
      findRegisteredWorkspace: vi.fn(() =>
        makeWorkspace({
          id: 'test-3',
          path: '/Users/chrisizatt/Documents/Test 3',
          displayName: 'Test 3'
        })
      ),
      canonicalPath: vi.fn((path: string) => path)
    })
    const service = new ChatService(deps)
    const assertIdle = vi.fn()

    const rebound = service.rebindChatWorkspace(
      {
        chatId: current.appChatId,
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      },
      { assertIdle }
    )

    expect(rebound).toBe(current)
    expect(rebound.linkedProviderSessionId).toBe('still-valid-test-3-session')
    expect(assertIdle).not.toHaveBeenCalled()
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('treats an absent legacy scope as a same-workspace no-op', () => {
    const current = makeChat({
      scope: undefined,
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3',
      linkedProviderSessionId: 'legacy-still-valid-test-3-session',
      seatGeneration: makeSeatGeneration('gemini')
    })
    const store = makeStore({ getChat: vi.fn(() => current) })
    const { deps } = makeDeps({
      appStore: store,
      findRegisteredWorkspace: vi.fn(() =>
        makeWorkspace({
          id: 'test-3',
          path: '/Users/chrisizatt/Documents/Test 3',
          displayName: 'Test 3'
        })
      ),
      canonicalPath: vi.fn((path: string) => path)
    })
    const assertIdle = vi.fn()

    const rebound = new ChatService(deps).rebindChatWorkspace(
      {
        chatId: current.appChatId,
        scope: 'workspace',
        workspaceId: 'test-3',
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      },
      { assertIdle }
    )

    expect(rebound).toBe(current)
    expect(rebound.linkedProviderSessionId).toBe('legacy-still-valid-test-3-session')
    expect(rebound.seatGeneration).toBe(current.seatGeneration)
    expect(assertIdle).not.toHaveBeenCalled()
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('rejects a stale non-Claude solo renderer clone after a main-owned rebind', () => {
    const canonicalReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'codex' as const,
      providerSessionId: 'codex-test-3-session',
      pinnedAt: '2026-07-13T00:00:00.000Z'
    }
    const current = makeChat({
      provider: 'codex',
      title: 'Canonical Test 3 chat',
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3',
      linkedProviderSessionId: 'codex-test-3-session',
      linkedGeminiSessionId: 'legacy-test-3-session',
      taskWraithMcpProfileReceipt: canonicalReceipt,
      seatGeneration: makeSeatGeneration('codex'),
      contextCompactionSummary: makeContextSummary('codex'),
      providerMetadata: { canonicalOnly: true },
      messages: [
        {
          id: 'canonical-message',
          role: 'assistant',
          content: 'Canonical Test 3 state.',
          timestamp: '2026-07-13T00:00:00.000Z'
        }
      ]
    })
    const store = makeStore({ getChat: vi.fn(() => current) })
    const { deps } = makeDeps({ appStore: store })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        provider: 'codex',
        title: 'Stale Test 1 clone',
        workspaceId: 'test-1',
        workspacePath: '/Users/chrisizatt/Documents/Test 1',
        linkedProviderSessionId: 'stale-codex-test-1-session',
        linkedGeminiSessionId: 'stale-legacy-test-1-session',
        seatGeneration: makeSeatGeneration('codex'),
        contextCompactionSummary: makeContextSummary('codex'),
        providerMetadata: {
          externalPathGrants: [makeExternalGrant('codex', '/Users/chrisizatt/Documents/Test 2')]
        },
        messages: []
      })
    )

    expect(saved).toBe(current)
    expect(saved.linkedProviderSessionId).toBe('codex-test-3-session')
    expect(saved.linkedGeminiSessionId).toBe('legacy-test-3-session')
    expect(saved.taskWraithMcpProfileReceipt).toBe(canonicalReceipt)
    expect(saved.seatGeneration).toBe(current.seatGeneration)
    expect(saved.contextCompactionSummary).toBe(current.contextCompactionSummary)
    expect(saved.providerMetadata).toEqual({ canonicalOnly: true })
    expect(saved.messages).toEqual(current.messages)
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('rejects a stale non-Claude Ensemble clone including seat prompt and cache state', () => {
    const currentParticipant = {
      id: 'worker',
      provider: 'kimi' as const,
      enabled: true,
      role: 'Worker',
      instructions: 'Canonical Test 3 brief.',
      order: 1,
      linkedProviderSessionId: 'kimi-test-3-session',
      promptShellVersion: 'shell-test-3',
      promptDynamicStateVersion: 'dynamic-test-3',
      seatGeneration: makeSeatGeneration('kimi'),
      contextCompactionSummary: makeContextSummary('kimi'),
      permissionOverrides: { networkAccess: 'deny' as const }
    }
    const current = makeChat({
      chatKind: 'ensemble',
      provider: 'kimi',
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3',
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        participants: [currentParticipant]
      }
    })
    const store = makeStore({ getChat: vi.fn(() => current) })
    const { deps } = makeDeps({ appStore: store })
    const staleParticipant = {
      ...currentParticipant,
      instructions: 'Stale Test 1 brief.',
      linkedProviderSessionId: 'kimi-test-1-session',
      promptShellVersion: 'shell-test-1',
      promptDynamicStateVersion: 'dynamic-test-1',
      permissionOverrides: {
        externalPathGrants: [makeExternalGrant('kimi', '/Users/chrisizatt/Documents/Test 2')]
      }
    }

    const saved = new ChatService(deps).saveChat(
      makeChat({
        chatKind: 'ensemble',
        provider: 'kimi',
        workspaceId: 'test-1',
        workspacePath: '/Users/chrisizatt/Documents/Test 1',
        ensemble: {
          enabled: true,
          maxParticipants: 20,
          participants: [staleParticipant]
        }
      })
    )

    expect(saved).toBe(current)
    expect(saved.ensemble?.participants[0]).toBe(currentParticipant)
    expect(saved.ensemble?.participants[0].linkedProviderSessionId).toBe('kimi-test-3-session')
    expect(saved.ensemble?.participants[0].promptShellVersion).toBe('shell-test-3')
    expect(saved.ensemble?.participants[0].promptDynamicStateVersion).toBe('dynamic-test-3')
    expect(saved.ensemble?.participants[0].seatGeneration).toBe(currentParticipant.seatGeneration)
    expect(saved.ensemble?.participants[0].contextCompactionSummary).toBe(
      currentParticipant.contextCompactionSummary
    )
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('preserves a main-owned solo MCP profile receipt when provider and session still match', () => {
    const receipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-session-1',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const current = makeChat({
      provider: 'claude',
      linkedProviderSessionId: 'claude-session-1',
      taskWraithMcpProfileReceipt: receipt
    })
    const { deps, store } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({ provider: 'claude', linkedProviderSessionId: 'claude-session-1' })
    )

    expect(saved.taskWraithMcpProfileReceipt).toBe(receipt)
    expect(store.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskWraithMcpProfileReceipt: receipt })
    )
  })

  it('preserves a canonical session/receipt pair against a stale renderer relink', () => {
    const canonicalReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-session-1',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const forgedReceipt = {
      ...canonicalReceipt,
      profileId: 'taskwraith-full-v1' as const,
      providerSessionId: 'claude-session-forged'
    }
    const current = makeChat({
      provider: 'claude',
      linkedProviderSessionId: 'claude-session-1',
      taskWraithMcpProfileReceipt: canonicalReceipt
    })
    const { deps, store } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        provider: 'claude',
        linkedProviderSessionId: 'claude-session-2',
        taskWraithMcpProfileReceipt: forgedReceipt
      })
    )

    expect(saved.linkedProviderSessionId).toBe('claude-session-1')
    expect(saved.taskWraithMcpProfileReceipt).toBe(canonicalReceipt)
    expect(store.saveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedProviderSessionId: 'claude-session-1',
        taskWraithMcpProfileReceipt: canonicalReceipt
      })
    )
  })

  it('strips a forged renderer receipt when main has no canonical receipt', () => {
    const forgedReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'renderer-session',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const current = makeChat({
      provider: 'claude',
      linkedProviderSessionId: 'main-unreceipted-session'
    })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        provider: 'claude',
        linkedProviderSessionId: 'renderer-session',
        taskWraithMcpProfileReceipt: forgedReceipt
      })
    )

    expect(saved.linkedProviderSessionId).toBe('main-unreceipted-session')
    expect(saved.taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('does not resurrect a cleared Claude session from a stale renderer save', () => {
    const current = makeChat({ provider: 'claude', linkedProviderSessionId: undefined })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({ provider: 'claude', linkedProviderSessionId: 'stale-session-a' })
    )

    expect(saved.linkedProviderSessionId).toBeUndefined()
    expect(saved.taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('strips a renderer-authored session from a new Claude chat record', () => {
    const { deps } = makeDeps({
      appStore: makeStore({ getChat: vi.fn(() => null) })
    })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({ provider: 'claude', linkedProviderSessionId: 'renderer-session' })
    )

    expect(saved.linkedProviderSessionId).toBeUndefined()
    expect(saved.taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('keeps an unreceipted legacy Claude session authoritative over stale input', () => {
    const current = makeChat({ provider: 'claude', linkedProviderSessionId: 'legacy-b' })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({ provider: 'claude', linkedProviderSessionId: 'stale-a' })
    )

    expect(saved.linkedProviderSessionId).toBe('legacy-b')
    expect(saved.taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('rejects a renderer-saved target session from an ephemeral solo reroute', () => {
    const current = makeChat({
      provider: 'codex',
      linkedProviderSessionId: 'codex-session-a'
    })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        provider: 'codex',
        linkedProviderSessionId: 'kimi-session-b',
        runs: [
          {
            runId: 'rerouted-run',
            provider: 'kimi',
            providerReroute: {
              from: 'codex',
              to: 'kimi',
              reason: 'provider-paused'
            },
            providerThreadId: 'kimi-session-b',
            startedAt: '2026-07-11T10:00:00.000Z',
            status: 'completed'
          }
        ]
      })
    )

    expect(saved.linkedProviderSessionId).toBe('codex-session-a')
    expect(saved.runs[0].providerThreadId).toBe('kimi-session-b')
  })

  it('drops the stale session and receipt when a renderer save crosses providers', () => {
    const canonicalReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-session-1',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const current = makeChat({
      provider: 'claude',
      linkedProviderSessionId: 'claude-session-1',
      taskWraithMcpProfileReceipt: canonicalReceipt
    })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        provider: 'codex',
        linkedProviderSessionId: 'stale-claude-session',
        taskWraithMcpProfileReceipt: canonicalReceipt
      })
    )

    expect(saved.provider).toBe('codex')
    expect(saved.linkedProviderSessionId).toBeUndefined()
    expect(saved.taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('overwrites a forged renderer replacement with the matching main-owned receipt', () => {
    const canonicalReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-session-1',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const current = makeChat({
      provider: 'claude',
      linkedProviderSessionId: 'claude-session-1',
      taskWraithMcpProfileReceipt: canonicalReceipt
    })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        provider: 'claude',
        linkedProviderSessionId: 'claude-session-1',
        taskWraithMcpProfileReceipt: {
          ...canonicalReceipt,
          profileId: 'taskwraith-full-v1',
          pinnedAt: 'forged-by-renderer'
        }
      })
    )

    expect(saved.taskWraithMcpProfileReceipt).toBe(canonicalReceipt)
  })

  it('preserves only canonical per-seat receipts across ensemble renderer saves', () => {
    const canonicalReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-session-1',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const current = makeChat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        participants: [
          {
            id: 'claude-seat',
            provider: 'claude',
            enabled: true,
            role: 'Planner',
            instructions: '',
            order: 1,
            linkedProviderSessionId: 'claude-session-1',
            taskWraithMcpProfileReceipt: canonicalReceipt
          }
        ]
      }
    })
    const forgedReceipt = {
      ...canonicalReceipt,
      profileId: 'taskwraith-full-v1' as const
    }
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        chatKind: 'ensemble',
        ensemble: {
          enabled: true,
          maxParticipants: 20,
          participants: [
            {
              id: 'claude-seat',
              provider: 'claude',
              enabled: true,
              role: 'Planner',
              instructions: '',
              order: 1,
              linkedProviderSessionId: 'stale-claude-session'
            },
            {
              id: 'forged-seat',
              provider: 'claude',
              enabled: true,
              role: 'Forged',
              instructions: '',
              order: 2,
              linkedProviderSessionId: 'claude-session-1',
              taskWraithMcpProfileReceipt: forgedReceipt
            }
          ]
        }
      })
    )

    expect(saved.ensemble?.participants[0].taskWraithMcpProfileReceipt).toBe(canonicalReceipt)
    expect(saved.ensemble?.participants[0].linkedProviderSessionId).toBe('claude-session-1')
    expect(saved.ensemble?.participants[1].taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('drops a stale receipted seat session when the renderer changes its provider', () => {
    const canonicalReceipt = {
      schemaVersion: 1 as const,
      profileId: 'taskwraith-core-v1' as const,
      provider: 'claude' as const,
      providerSessionId: 'claude-session-1',
      pinnedAt: '2026-07-11T00:00:00.000Z'
    }
    const current = makeChat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        participants: [
          {
            id: 'seat-1',
            provider: 'claude',
            enabled: true,
            role: 'Planner',
            instructions: '',
            order: 1,
            linkedProviderSessionId: 'claude-session-1',
            taskWraithMcpProfileReceipt: canonicalReceipt
          }
        ]
      }
    })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        chatKind: 'ensemble',
        ensemble: {
          enabled: true,
          maxParticipants: 20,
          participants: [
            {
              id: 'seat-1',
              provider: 'codex',
              enabled: true,
              role: 'Planner',
              instructions: '',
              order: 1,
              linkedProviderSessionId: 'stale-claude-session',
              taskWraithMcpProfileReceipt: canonicalReceipt
            }
          ]
        }
      })
    )

    expect(saved.ensemble?.participants[0].provider).toBe('codex')
    expect(saved.ensemble?.participants[0].linkedProviderSessionId).toBeUndefined()
    expect(saved.ensemble?.participants[0].taskWraithMcpProfileReceipt).toBeUndefined()
  })

  it('keeps a legacy Claude ensemble session authoritative without a receipt', () => {
    const current = makeChat({
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        participants: [
          {
            id: 'seat-1',
            provider: 'claude',
            enabled: true,
            role: 'Planner',
            instructions: '',
            order: 1,
            linkedProviderSessionId: 'legacy-b'
          }
        ]
      }
    })
    const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => current) }) })
    const service = new ChatService(deps)

    const saved = service.saveChat(
      makeChat({
        chatKind: 'ensemble',
        ensemble: {
          enabled: true,
          maxParticipants: 20,
          participants: [
            {
              id: 'seat-1',
              provider: 'claude',
              enabled: true,
              role: 'Planner',
              instructions: '',
              order: 1,
              linkedProviderSessionId: 'stale-a'
            }
          ]
        }
      })
    )

    expect(saved.ensemble?.participants[0].linkedProviderSessionId).toBe('legacy-b')
    expect(saved.ensemble?.participants[0].taskWraithMcpProfileReceipt).toBeUndefined()
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

  it('creates emulated fork chats with copied transcript and fork metadata', () => {
    const parentMessage = {
      id: 'msg-1',
      role: 'user' as const,
      content: 'Original prompt',
      timestamp: '2026-07-05T12:00:00.000Z'
    }
    const { deps, store } = makeDeps({
      appStore: makeStore({
        getChat: vi.fn(() =>
          makeChat({
            appChatId: 'chat-1',
            provider: 'claude',
            title: 'Main task',
            messages: [parentMessage],
            linkedProviderSessionId: 'session-1'
          })
        )
      })
    })
    const service = new ChatService(deps)

    const fork = service.createForkChat({
      parentChatId: 'chat-1',
      provider: 'kimi',
      sourceProviderThreadId: 'provider-thread-1',
      sourceModel: 'kimi-k2'
    })

    expect(store.createSideChat).toHaveBeenCalledWith(
      expect.objectContaining({
        parentChatId: 'chat-1',
        provider: 'kimi',
        sideChatMode: 'singleProvider'
      })
    )
    expect(fork.messages).toEqual([parentMessage])
    expect(fork.runs).toEqual([])
    expect(fork.linkedProviderSessionId).toBeUndefined()
    expect(fork.forkContext).toMatchObject({
      kind: 'emulated',
      sourceChatId: 'chat-1',
      sourceProvider: 'claude',
      sourceProviderThreadId: 'provider-thread-1',
      sourceModel: 'kimi-k2'
    })
    expect(store.saveChat).toHaveBeenCalledWith(expect.objectContaining({
      appChatId: 'side-chat-1',
      forkContext: expect.objectContaining({ kind: 'emulated' })
    }))
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
