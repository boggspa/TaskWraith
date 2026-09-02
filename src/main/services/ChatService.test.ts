import { afterEach, describe, expect, it, vi } from 'vitest'
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
import {
  resetAntigravityGeminiApiKeyConfiguredProbeForTests,
  setAntigravityGeminiApiKeyConfiguredProbe
} from '../antigravity/AntigravityGeminiApiKeyConfiguredSignal'
import {
  resetAntigravityAgyOptInEnabledProbeForTests,
  setAntigravityAgyOptInEnabledProbe
} from '../antigravity/AntigravityAgyOptInEnabledSignal'

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
    persistChatComposerSelection: vi.fn(async (request) => ({
      chat: makeChat({ appChatId: request.chatId }),
      changed: true
    })),
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
    prepareForkMessages: vi.fn(({ copiedMessages }) => copiedMessages),
    sanitizeChatForSave: vi.fn((chat: ChatRecord) => ({ ...chat, title: chat.title.trim() })),
    appendDurableRunEventForRoute: vi.fn(),
    ...overrides
  }
  return { deps, store: deps.appStore }
}

describe('ChatService Host setup methods', () => {
  it('creates only canonical global or registered-workspace single threads', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)

    expect(service.createSingleThread({ scope: 'global' }).scope).toBe('global')
    expect(
      service.createSingleThread({
        scope: 'workspace',
        workspaceId: 'workspace-1',
        workspacePath: '/repo'
      }).workspacePath
    ).toBe('/canonical/repo')
    expect(store.createGlobalChat).toHaveBeenCalledTimes(1)
    expect(store.createChat).toHaveBeenCalledWith('workspace-1', '/canonical/repo')
  })

  it('configures a canonical idle thread through offer validation and provider-change hygiene', () => {
    const current = makeChat({
      provider: 'gemini',
      linkedProviderSessionId: 'old-provider-session',
      linkedGeminiSessionId: 'old-gemini-session'
    })
    const store = makeStatefulStore(current)
    const assertProviderOfferedForThread = vi.fn()
    const { deps } = makeDeps({ appStore: store, assertProviderOfferedForThread })
    const result = new ChatService(deps).configureThread({
      chatId: 'chat-1',
      provider: 'claude',
      selectedModelType: ' claude-sonnet '
    })

    expect(assertProviderOfferedForThread).toHaveBeenCalledWith('claude', current)
    expect(result).toMatchObject({ provider: 'claude' })
    expect(result.providerMetadata).toMatchObject({ selectedModelType: 'claude-sonnet' })
    expect(result.linkedProviderSessionId).toBeUndefined()
    expect(result.linkedGeminiSessionId).toBeUndefined()
  })

  it('persists bounded Host title/reasoning/posture and permits explicit unarchive while idle', () => {
    const store = makeStatefulStore(makeChat({ archived: true, provider: 'codex' }))
    const { deps } = makeDeps({ appStore: store })
    const service = new ChatService(deps)
    const restored = service.archiveThread({ chatId: 'chat-1', archived: false })
    expect(restored.archived).toBe(false)
    const configured = service.configureThread({
      chatId: 'chat-1',
      provider: 'codex',
      selectedModelType: 'gpt-5.6',
      reasoningId: 'high',
      postureId: 'workspace_write',
      title: 'Configured thread'
    })
    expect(configured).toMatchObject({
      title: 'Configured thread',
      workflowMode: 'normal',
      providerMetadata: {
        selectedModelType: 'gpt-5.6',
        reasoningEffort: 'high',
        approvalMode: 'default',
        permissionPresetId: 'workspace_write'
      }
    })
  })

  it('routes exact Host chat-kind configuration through the guarded setChatKind mutation', () => {
    const current = makeChat({
      provider: 'codex',
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 18,
        orchestrationMode: 'turn_bound',
        maxContinuationHops: 6,
        participants: [
          {
            id: 'kimi-seat',
            provider: 'kimi',
            enabled: true,
            role: 'Kimi',
            instructions: '',
            order: 1
          }
        ],
        updatedAt: '2026-08-27T00:00:00.000Z'
      }
    })
    const setChatKind = vi.fn((chatId: string, targetKind: 'single' | 'ensemble') =>
      makeChat({ appChatId: chatId, provider: 'kimi', chatKind: targetKind })
    )
    const store = makeStore({ getChat: vi.fn(() => current), setChatKind })
    const { deps } = makeDeps({ appStore: store })
    const service = new ChatService(deps)

    expect(
      service.configureThread({
        chatId: 'chat-1',
        chatKind: 'single',
        canonicalProvider: 'kimi'
      })
    ).toMatchObject({ chatKind: 'single', provider: 'kimi' })
    expect(setChatKind).toHaveBeenCalledWith('chat-1', 'single', {
      seedParticipant: undefined,
      canonicalProvider: 'kimi',
      canonicalProviderMetadata: undefined
    })

    vi.mocked(store.getChat).mockReturnValue(makeChat({ provider: 'codex', chatKind: 'single' }))
    service.configureThread({ chatId: 'chat-1', chatKind: 'ensemble' })
    expect(setChatKind).toHaveBeenLastCalledWith(
      'chat-1',
      'ensemble',
      expect.objectContaining({
        seedParticipant: expect.objectContaining({ provider: 'codex', enabled: true })
      })
    )
  })

  it('refuses configure/archive while a run or round is active', () => {
    const active = makeChat({
      runs: [{ runId: 'run-1', status: 'running' }] as ChatRecord['runs'],
      ensemble: { activeRound: { roundId: 'round-1' } } as ChatRecord['ensemble']
    })
    const store = makeStatefulStore(active)
    const { deps } = makeDeps({ appStore: store })
    const service = new ChatService(deps)

    expect(() => service.configureThread({ chatId: 'chat-1', provider: 'claude' })).toThrow(
      /run or round is active/i
    )
    expect(() => service.archiveThread({ chatId: 'chat-1' })).toThrow(/run or round is active/i)
    expect(store.saveChat).not.toHaveBeenCalled()
  })

  it('archives only the canonical thread record', () => {
    const store = makeStatefulStore(makeChat())
    const { deps } = makeDeps({ appStore: store })
    const result = new ChatService(deps).archiveThread({ chatId: 'chat-1' })

    expect(result.archived).toBe(true)
    expect(store.saveChat).toHaveBeenCalledWith(expect.objectContaining({ archived: true }))
  })
})

describe('ChatService.clearChats external history', () => {
  it('prepares and releases the matching global or workspace history-clear scope', async () => {
    const clearExternalChatHistory = vi.fn()
    const finishExternalChatHistoryClear = vi.fn()
    const { deps, store } = makeDeps({
      clearExternalChatHistory,
      finishExternalChatHistoryClear
    })
    const service = new ChatService(deps)

    await service.clearChats('workspace-1')
    expect(store.clearChats).toHaveBeenCalledWith('workspace-1')
    expect(clearExternalChatHistory).toHaveBeenCalledWith('workspace-1')
    expect(finishExternalChatHistoryClear).toHaveBeenCalledWith('workspace-1')

    await service.clearChats()
    expect(store.clearChats).toHaveBeenCalledWith(undefined)
    expect(clearExternalChatHistory).toHaveBeenCalledWith(undefined)
    expect(finishExternalChatHistoryClear).toHaveBeenCalledWith(undefined)
  })

  it('awaits external history teardown before the durable chat clear', async () => {
    let release!: () => void
    const externalClear = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps, store } = makeDeps({
      clearExternalChatHistory: vi.fn(() => externalClear)
    })
    const service = new ChatService(deps)

    const clearing = service.clearChats()
    await Promise.resolve()
    expect(store.clearChats).not.toHaveBeenCalled()
    release()
    await clearing
    expect(store.clearChats).toHaveBeenCalledOnce()
  })

  it('supports a separate prepare/commit clear transaction without repeating teardown', async () => {
    const clearExternalChatHistory = vi.fn()
    const finishExternalChatHistoryClear = vi.fn()
    const { deps, store } = makeDeps({
      clearExternalChatHistory,
      finishExternalChatHistoryClear
    })
    const service = new ChatService(deps)

    await service.prepareClearChats()
    expect(clearExternalChatHistory).toHaveBeenCalledOnce()
    expect(store.clearChats).not.toHaveBeenCalled()

    service.commitClearChats()
    service.finishClearChats()
    expect(store.clearChats).toHaveBeenCalledWith(undefined)
    expect(clearExternalChatHistory).toHaveBeenCalledOnce()
    expect(finishExternalChatHistoryClear).toHaveBeenCalledOnce()
  })
})

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

  it('forwards an exact authored transcript mutation when sanitization preserves messages', () => {
    const { deps, store } = makeDeps()
    const service = new ChatService(deps)
    const record = makeChat({ title: ' Chat ' })
    const authoredTranscript = {
      operations: [],
      transcriptOps: [],
      changedMessageCount: 0
    }

    service.saveChat(record, { authoredTranscript })

    expect(store.saveChat).toHaveBeenCalledWith(
      makeChat({ title: 'Chat' }),
      { authoredTranscript }
    )
  })

  it('preserves imported transcript provenance across renderer whole-record saves', () => {
    const importedMetadata = {
      schemaVersion: 1 as const,
      provider: 'claude' as const,
      trust: 'external_untrusted' as const,
      sourceFileName: 'thread.jsonl',
      sourceFingerprintSha256: 'a'.repeat(64),
      sourceMessageCount: 1,
      importedMessageCount: 1,
      omittedRecordCount: 0,
      invalidRecordCount: 0,
      importedAt: '2026-08-20T00:00:00.000Z',
      truncated: false,
      promptBridgeEnabled: false as const,
      nativeResumeAllowed: false as const
    }
    const importedMessage = {
      id: 'imported-1',
      role: 'assistant' as const,
      content: 'external imported answer',
      timestamp: '2026-08-20T00:00:00.000Z',
      metadata: {
        kind: 'externalProviderThreadImport',
        sourceTrust: 'external_untrusted'
      }
    }
    const current = makeChat({
      externalProviderThreadImport: importedMetadata,
      messages: [importedMessage]
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({
      ...current,
      externalProviderThreadImport: undefined,
      linkedProviderSessionId: 'forged-source-session',
      linkedGeminiSessionId: 'forged-gemini-session',
      taskWraithMcpProfileReceipt: { sessionId: 'forged-source-session' } as never,
      forkContext: {
        kind: 'native',
        createdAt: 1,
        sourceProviderThreadId: 'forged-source-thread'
      },
      chatKind: 'ensemble',
      ensemble: {
        participants: [
          {
            id: 'forged-seat',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: '',
            order: 0,
            linkedProviderSessionId: 'forged-seat-session',
            kimiAcpNativeSession: true,
            kimiAcpPostureVersion: 'forged-posture',
            promptShellVersion: 'forged-shell',
            promptDynamicStateVersion: 'forged-dynamic'
          }
        ]
      } as never,
      runs: [
        {
          runId: 'run-forged',
          providerThreadId: 'forged-provider-thread',
          startedAt: '2026-08-20T00:00:00.000Z'
        }
      ],
      messages: [
        { ...importedMessage, content: 'metadata-stripped rewrite', metadata: undefined },
        {
          id: 'new-host-row',
          role: 'user',
          content: 'new host prompt',
          timestamp: '2026-08-20T00:01:00.000Z'
        }
      ]
    })

    expect(saved.externalProviderThreadImport).toEqual(importedMetadata)
    expect(saved.messages).toEqual([
      importedMessage,
      expect.objectContaining({ id: 'new-host-row', content: 'new host prompt' })
    ])
    expect(JSON.stringify(saved)).not.toContain('metadata-stripped rewrite')
    expect(JSON.stringify(saved)).not.toContain('forged-source-session')
    expect(JSON.stringify(saved)).not.toContain('forged-gemini-session')
    expect(JSON.stringify(saved)).not.toContain('forged-source-thread')
    expect(JSON.stringify(saved)).not.toContain('forged-provider-thread')
    expect(JSON.stringify(saved)).not.toContain('forged-seat-session')
    expect(JSON.stringify(saved)).not.toContain('forged-posture')
    expect(JSON.stringify(saved)).not.toContain('forged-shell')
    expect(JSON.stringify(saved)).not.toContain('forged-dynamic')
  })

  it('allows changing a live chat to Cursor through saveChat', () => {
    const current = makeChat({ provider: 'claude' })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({
      ...current,
      provider: 'cursor'
    })
    expect(saved).toMatchObject({ provider: 'cursor' })
    expect(store.saveChat).toHaveBeenCalledWith(saved)
  })

  it('allows an unchanged historical provider record to round-trip for decode and display', () => {
    const current = makeChat({ provider: 'cursor', title: 'Historical Cursor chat' })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({
      ...current,
      title: '  Renamed historical chat  '
    })

    expect(saved).toMatchObject({ provider: 'cursor', title: 'Renamed historical chat' })
    expect(store.saveChat).toHaveBeenCalledWith(saved)
  })

  it('allows adding Cursor to an existing ensemble roster', () => {
    const current = makeChat({
      provider: 'claude',
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 20,
        participants: [
          {
            id: 'seat-claude',
            provider: 'claude',
            enabled: true,
            role: 'Lead',
            instructions: '',
            order: 0
          }
        ]
      }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({
      ...current,
      ensemble: {
        ...current.ensemble!,
        participants: [
          ...current.ensemble!.participants,
          {
            id: 'seat-cursor',
            provider: 'cursor',
            enabled: true,
            role: 'Reviewer',
            instructions: '',
            order: 1
          }
        ]
      }
    })
    expect(saved.ensemble?.participants.some((p) => p.provider === 'cursor')).toBe(true)
    expect(store.saveChat).toHaveBeenCalledWith(saved)
  })

  it('allows newly queued provider changes to Cursor', () => {
    const current = makeChat({ provider: 'claude', providerMetadata: {} })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({
      ...current,
      providerMetadata: {
        pendingProviderChange: {
          provider: 'cursor',
          queuedAt: '2026-07-19T00:00:00.000Z'
        }
      }
    })
    expect(saved.providerMetadata?.pendingProviderChange).toMatchObject({ provider: 'cursor' })
    expect(store.saveChat).toHaveBeenCalledWith(saved)
  })

  it('preserves a newly queued AntiGravity change only after dynamic API-key admission', () => {
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    const current = makeChat({ provider: 'claude', providerMetadata: {} })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })
    const incoming = {
      ...current,
      providerMetadata: {
        pendingProviderChange: {
          provider: 'antigravity' as const,
          queuedAt: '2026-07-19T00:00:00.000Z'
        }
      }
    }

    expect(() => new ChatService(deps).saveChat(incoming)).toThrow(
      'antigravity is unavailable for new chats or delegated runs.'
    )
    expect(store.saveChat).not.toHaveBeenCalled()

    setAntigravityGeminiApiKeyConfiguredProbe(() => true)
    try {
      const saved = new ChatService(deps).saveChat(incoming)
      expect(saved.providerMetadata?.pendingProviderChange).toMatchObject({
        provider: 'antigravity'
      })
      expect(store.saveChat).toHaveBeenCalledWith(saved)
    } finally {
      resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    }
  })

  it('admits a queued AntiGravity change on the agy opt-in alone, with NO API key', () => {
    // Subthreads, forks, side chats and ensemble seats all admit through this
    // same predicate, so keying it only on the Gemini API key stranded every
    // agy-lane seat for a consented user who had never saved a key.
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    resetAntigravityAgyOptInEnabledProbeForTests()
    const current = makeChat({ provider: 'claude', providerMetadata: {} })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })
    const incoming = {
      ...current,
      providerMetadata: {
        pendingProviderChange: {
          provider: 'antigravity' as const,
          queuedAt: '2026-07-19T00:00:00.000Z'
        }
      }
    }

    // Neither lane -> refused.
    expect(() => new ChatService(deps).saveChat(incoming)).toThrow(
      'antigravity is unavailable for new chats or delegated runs.'
    )
    expect(store.saveChat).not.toHaveBeenCalled()

    // agy opt-in alone -> admitted, key still absent.
    setAntigravityAgyOptInEnabledProbe(() => true)
    setAntigravityGeminiApiKeyConfiguredProbe(() => false)
    try {
      const saved = new ChatService(deps).saveChat(incoming)
      expect(saved.providerMetadata?.pendingProviderChange).toMatchObject({
        provider: 'antigravity'
      })
      expect(store.saveChat).toHaveBeenCalledWith(saved)
    } finally {
      resetAntigravityAgyOptInEnabledProbeForTests()
      resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    }
  })

  it('preserves an already-admitted canonical AntiGravity queue entry if credentials later change', () => {
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    const current = makeChat({
      provider: 'claude',
      providerMetadata: {
        pendingProviderChange: {
          provider: 'antigravity',
          queuedAt: '2026-07-19T00:00:00.000Z'
        }
      }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({
      ...current,
      title: 'Queue remains visible'
    })

    expect(saved.providerMetadata?.pendingProviderChange).toEqual(
      current.providerMetadata?.pendingProviderChange
    )
    expect(store.saveChat).toHaveBeenCalledWith(saved)
  })

  it('clears canonical historical pending-provider control state on save', () => {
    const current = makeChat({
      provider: 'claude',
      providerMetadata: {
        retainedSetting: true,
        pendingProviderChange: {
          provider: 'gemini',
          queuedAt: '2026-07-18T00:00:00.000Z'
        }
      }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({ appStore: store })

    const saved = new ChatService(deps).saveChat({ ...current, title: 'Still live' })

    expect(saved.provider).toBe('claude')
    expect(saved.providerMetadata).toEqual({ retainedSetting: true })
    expect(store.saveChat).toHaveBeenCalledWith(saved)
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

  describe('explicit chat mode remains the host choice during collaboration', () => {
    function makeSharedDeps(
      chat: ChatRecord,
      shares: Array<{ enabled: boolean; participants?: Array<{ status: string }> }>
    ) {
      const setChatKind = vi.fn((chatId: string, targetKind: 'single' | 'ensemble') =>
        makeChat({ appChatId: chatId, chatKind: targetKind })
      )
      const { deps } = makeDeps({
        appStore: makeStore({ setChatKind, getChat: vi.fn(() => chat) }),
        humanCollaborationStore: {
          listShares: vi.fn(() => shares)
        } as unknown as ChatServiceDeps['humanCollaborationStore']
      })
      return { deps, setChatKind }
    }

    it('allows a collapse while external seats remain active in the collaboration store', () => {
      const { deps, setChatKind } = makeSharedDeps(makeChat({ chatKind: 'ensemble' }), [
        { enabled: true, participants: [{ status: 'active' }] }
      ])

      new ChatService(deps).setChatKind({ chatId: 'chat-1', targetKind: 'single' })
      expect(setChatKind).toHaveBeenCalledWith('chat-1', 'single', {
        seedParticipant: undefined,
        canonicalProvider: undefined,
        canonicalProviderMetadata: undefined
      })
      expect(deps.humanCollaborationStore?.listShares).not.toHaveBeenCalled()
    })

    it('allows the collapse when the share record survives but nobody is admitted', () => {
      // The discriminating case, and the reason the predicate changed. Both
      // revoke paths leave the share record behind, so "any enabled share"
      // refused the very revert the guard exists to make safe.
      const { deps, setChatKind } = makeSharedDeps(makeChat({ chatKind: 'ensemble' }), [
        { enabled: true, participants: [{ status: 'revoked' }] }
      ])

      new ChatService(deps).setChatKind({ chatId: 'chat-1', targetKind: 'single' })
      expect(setChatKind).toHaveBeenCalled()
    })

    it('allows the collapse once every share is disabled', () => {
      // A revoked share leaves the record behind with nobody admitted — the
      // case the old "any enabled share" predicate got wrong.
      const { deps, setChatKind } = makeSharedDeps(makeChat({ chatKind: 'ensemble' }), [
        { enabled: false, participants: [{ status: 'revoked' }] }
      ])

      new ChatService(deps).setChatKind({ chatId: 'chat-1', targetKind: 'single' })
      expect(setChatKind).toHaveBeenCalled()
    })

    it('never blocks turning panel mode ON, shared or not', () => {
      const { deps, setChatKind } = makeSharedDeps(makeChat({ chatKind: 'single' }), [
        { enabled: true, participants: [{ status: 'active' }] }
      ])

      new ChatService(deps).setChatKind({ chatId: 'chat-1', targetKind: 'ensemble' })
      expect(setChatKind).toHaveBeenCalled()
    })

    it('does not fail a plain solo conversion when no collaboration store is configured', () => {
      // No store means no shares can exist, so there is nothing to protect —
      // the accessor that throws on an absent store must not be on this path.
      const setChatKind = vi.fn((chatId: string, targetKind: 'single' | 'ensemble') =>
        makeChat({ appChatId: chatId, chatKind: targetKind })
      )
      const { deps } = makeDeps({
        appStore: makeStore({ setChatKind, getChat: vi.fn(() => makeChat({ chatKind: 'ensemble' })) })
      })

      new ChatService(deps).setChatKind({ chatId: 'chat-1', targetKind: 'single' })
      expect(setChatKind).toHaveBeenCalled()
    })
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

  /**
   * `save-chat` takes a whole renderer-authored record, so before this fence it
   * could flip `chatKind` without meeting a single one of setChatKind's
   * conditions — the idle-only running guard, the roster seed/strip, or the
   * refusal to collapse a SHARED chat out of panel mode.
   */
  describe('chatKind is main-owned and cannot be changed through saveChat', () => {
    /** A plan that actually parses — parsePendingEnsembleRosterPresetApply
     *  rejects anything missing schemaVersion, presetName or queuedAt, and a
     *  fixture it rejects would make these tests pass for the wrong reason. */
    function pendingPresetPlan(presetId: string) {
      return {
        schemaVersion: 1 as const,
        presetId,
        presetName: 'Fixture preset',
        queuedAt: '2026-07-30T00:00:00.000Z',
        authority: 'user' as const,
        participants: [
          {
            id: 'seat-1',
            provider: 'claude' as const,
            enabled: true,
            role: 'Boss',
            instructions: '',
            order: 0
          }
        ],
        bossmanParticipantId: 'seat-1',
        orchestrationMode: 'turn_bound' as const,
        maxParticipants: 20,
        maxContinuationHops: 3,
        ensembleContextChars: 4000
      }
    }

    function ensembleChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
      return makeChat({
        chatKind: 'ensemble',
        ensemble: {
          enabled: true,
          maxParticipants: 20,
          participants: [
            {
              id: 'seat-claude',
              provider: 'claude',
              enabled: true,
              role: 'Lead',
              instructions: '',
              order: 0
            }
          ]
        },
        ...overrides
      })
    }

    it('pins the stored ensemble kind when a save tries to collapse to solo', () => {
      const current = ensembleChat()
      const store = makeStatefulStore(current)
      const { deps } = makeDeps({ appStore: store })

      const { ensemble: _dropped, ...withoutRoster } = current
      const saved = new ChatService(deps).saveChat({
        ...withoutRoster,
        chatKind: 'single',
        title: 'Renamed while collapsing'
      })

      expect(saved.chatKind).toBe('ensemble')
      // The roster comes back with the kind. Leaving it dropped would let
      // normalizeChatRecord seed a DEFAULT multi-provider roster over the
      // user's seats — a worse outcome than the collapse we just refused.
      expect(saved.ensemble?.participants).toEqual(current.ensemble?.participants)
      // Everything else in the save still lands: this is a one-field fence, not
      // a rejection of the record.
      expect(saved.title).toBe('Renamed while collapsing')
    })

    it('pins the stored solo kind when a save tries to open panel mode', () => {
      const current = makeChat({ chatKind: 'single' })
      const store = makeStatefulStore(current)
      const { deps } = makeDeps({ appStore: store })

      const saved = new ChatService(deps).saveChat({ ...current, chatKind: 'ensemble' })

      expect(saved.chatKind).toBe('single')
    })

    it('honours the incoming kind when there is no stored record to defend', () => {
      // Creation — fork, side chat, sub-thread. The incoming kind is the only
      // one that exists.
      const { deps } = makeDeps({ appStore: makeStore({ getChat: vi.fn(() => null) }) })

      // A live provider: with no stored record the provider fence has nothing
      // to compare against and refuses retired ids outright.
      const saved = new ChatService(deps).saveChat(
        makeChat({ chatKind: 'ensemble', provider: 'claude' })
      )

      expect(saved.chatKind).toBe('ensemble')
    })

    it('allows single→ensemble when the STORED record carries a pending roster preset', () => {
      // The queued preset-apply path legitimately promotes a solo chat at a
      // turn boundary. The authorisation is main-verifiable — it lives on the
      // stored record, written by preset-apply — rather than being asserted by
      // the incoming snapshot, and it can only ever turn panel mode ON.
      const current = makeChat({
        chatKind: 'single',
        providerMetadata: {
          pendingEnsembleRosterPresetApply: pendingPresetPlan('preset-1')
        }
      })
      const store = makeStatefulStore(current)
      const { deps } = makeDeps({ appStore: store })

      const saved = new ChatService(deps).saveChat({
        ...current,
        chatKind: 'ensemble',
        providerMetadata: undefined
      })

      expect(saved.chatKind).toBe('ensemble')
    })

    it('allows single→ensemble when the STORED record carries a queued external-join conversion', () => {
      // The other authorised transition. An external who joined during a live
      // run leaves this marker; the boundary drain then converts, and that save
      // must survive the fence or the conversion is silently undone and the
      // person keeps a seat that can never take a turn.
      const current = makeChat({
        chatKind: 'single',
        providerMetadata: {
          pendingExternalJoinConversion: {
            schemaVersion: 1,
            collaboratorId: 'collab-1',
            shareId: 'share-1',
            queuedAt: '2026-07-31T00:00:00.000Z',
            seedParticipant: {
              id: 'seat-1',
              provider: 'claude',
              enabled: true,
              role: 'Lead',
              instructions: '',
              order: 1
            }
          }
        }
      })
      const store = makeStatefulStore(current)
      const { deps } = makeDeps({ appStore: store })

      const saved = new ChatService(deps).saveChat({
        ...current,
        chatKind: 'ensemble',
        providerMetadata: undefined
      })

      expect(saved.chatKind).toBe('ensemble')
    })

    it('does not let an INCOMING pending preset authorise its own promotion', () => {
      // The renderer writes the snapshot, so a plan that only appears on the
      // incoming record proves nothing.
      const current = makeChat({ chatKind: 'single' })
      const store = makeStatefulStore(current)
      const { deps } = makeDeps({ appStore: store })

      const saved = new ChatService(deps).saveChat({
        ...current,
        chatKind: 'ensemble',
        providerMetadata: {
          pendingEnsembleRosterPresetApply: pendingPresetPlan('forged')
        }
      })

      expect(saved.chatKind).toBe('single')
    })

    it('never lets a pending preset launder a collapse out of panel mode', () => {
      // The carve-out is direction-specific: ensemble→single is refused even
      // with a plan present, so it can never be used to strip a shared roster.
      const current = ensembleChat({
        providerMetadata: {
          pendingEnsembleRosterPresetApply: pendingPresetPlan('preset-1')
        }
      })
      const store = makeStatefulStore(current)
      const { deps } = makeDeps({ appStore: store })

      const saved = new ChatService(deps).saveChat({ ...current, chatKind: 'single' })

      expect(saved.chatKind).toBe('ensemble')
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

  it('queues a validated workspace target without changing the active binding, then clears it on rebind', () => {
    const current = makeChat({
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1',
      providerMetadata: { selectedModelType: 'gpt-5.6' }
    })
    const store = makeStatefulStore(current)
    const { deps } = makeDeps({
      appStore: store,
      findRegisteredWorkspace: vi.fn((path: string) =>
        path.endsWith('Test 1')
          ? makeWorkspace({
              id: 'test-1',
              path: '/Users/chrisizatt/Documents/Test 1',
              displayName: 'Test 1'
            })
          : makeWorkspace({
              id: 'test-3',
              path: '/Users/chrisizatt/Documents/Test 3',
              displayName: 'Test 3'
            })
      ),
      canonicalPath: vi.fn((path: string) => path)
    })
    const service = new ChatService(deps)
    const target = {
      chatId: current.appChatId,
      scope: 'workspace' as const,
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3'
    }

    const queued = service.queueChatWorkspaceRebind(target, { now: 1234 })

    expect(queued).toMatchObject({
      workspaceId: 'test-1',
      workspacePath: '/Users/chrisizatt/Documents/Test 1',
      updatedAt: 1234,
      providerMetadata: {
        selectedModelType: 'gpt-5.6',
        pendingWorkspaceRebind: {
          schemaVersion: 1,
          scope: 'workspace',
          workspaceId: 'test-3',
          workspacePath: '/Users/chrisizatt/Documents/Test 3',
          queuedAt: new Date(1234).toISOString()
        }
      }
    })
    expect(queued.linkedProviderSessionId).toBe(current.linkedProviderSessionId)

    const cancelled = service.queueChatWorkspaceRebind(
      {
        chatId: current.appChatId,
        scope: 'workspace',
        workspaceId: 'test-1',
        workspacePath: '/Users/chrisizatt/Documents/Test 1'
      },
      { now: 2000 }
    )
    expect(cancelled.workspaceId).toBe('test-1')
    expect(cancelled.providerMetadata).not.toHaveProperty('pendingWorkspaceRebind')

    service.queueChatWorkspaceRebind(target, { now: 2100 })
    const rebound = service.rebindChatWorkspace(target, { now: 2345 })

    expect(rebound).toMatchObject({
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3',
      updatedAt: 2345,
      providerMetadata: { selectedModelType: 'gpt-5.6' }
    })
    expect(rebound.providerMetadata).not.toHaveProperty('pendingWorkspaceRebind')
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

  it('prepares detached fork messages after shell creation and before the copied transcript is saved', () => {
    const events: string[] = []
    const parent = makeChat({
      appChatId: 'chat-1',
      provider: 'claude',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Original answer',
          timestamp: '2026-07-05T12:00:00.000Z',
          metadata: {
            mediaRefs: [
              {
                id: 'media-1',
                kind: 'image',
                format: 'raster',
                source: 'generated',
                name: 'result.png',
                mimeType: 'image/png',
                sha256: 'source-owned-hash',
                assetId: 'asset:source-owned-hash',
                status: 'available'
              }
            ]
          }
        }
      ]
    })
    const parentBefore = structuredClone(parent)
    const sideChat = makeChat({
      appChatId: 'side-chat-1',
      parentChatId: 'chat-1',
      parentChatRelation: 'sideChat',
      messages: []
    })
    const saveChat = vi.fn((chat: ChatRecord) => {
      events.push('save')
      return chat
    })
    const store = makeStore({
      getChat: vi.fn((chatId) => (chatId === parent.appChatId ? parent : sideChat)),
      createSideChat: vi.fn(() => {
        events.push('createSideChat')
        return sideChat
      }),
      saveChat
    })
    const prepareForkMessages = vi.fn(({ sourceChat, targetFork, copiedMessages }) => {
      events.push('prepare')
      expect(sourceChat).toBe(parent)
      expect(targetFork.messages).toEqual([])
      expect(targetFork.forkContext).toMatchObject({
        kind: 'emulated',
        sourceChatId: parent.appChatId
      })
      copiedMessages[0].content = 'Prepared answer'
      const copiedRef = copiedMessages[0].metadata?.mediaRefs?.[0]
      if (copiedRef) copiedRef.status = 'denied'
      return copiedMessages
    })
    const { deps } = makeDeps({ appStore: store, prepareForkMessages })

    const fork = new ChatService(deps).createForkChat({ parentChatId: parent.appChatId })

    expect(events).toEqual(['createSideChat', 'prepare', 'save'])
    expect(prepareForkMessages).toHaveBeenCalledTimes(1)
    expect(saveChat).toHaveBeenCalledTimes(1)
    expect(fork.messages[0]).toMatchObject({
      content: 'Prepared answer',
      metadata: { mediaRefs: [expect.objectContaining({ status: 'denied' })] }
    })
    expect(parent).toEqual(parentBefore)
  })

  it('shares the parent transcript by reference when the v2 fork-prefix gate is on', () => {
    const parent = makeChat({
      appChatId: 'chat-1',
      provider: 'codex',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'No deep copy on the v2 prefix path',
          timestamp: '2026-09-01T00:00:00.000Z'
        }
      ]
    })
    const sideChat = makeChat({
      appChatId: 'side-chat-1',
      parentChatId: parent.appChatId,
      parentChatRelation: 'sideChat',
      messages: []
    })
    const store = makeStore({
      getChat: vi.fn((chatId) => (chatId === parent.appChatId ? parent : sideChat)),
      createSideChat: vi.fn(() => sideChat),
      saveChat: vi.fn((chat: ChatRecord) => chat)
    })
    // Mirror the production seam: transferTranscriptMediaMessagesBatch is pure
    // and returns a fresh array of shallow-copied messages.
    const prepareForkMessages = vi.fn(({ copiedMessages }) =>
      (copiedMessages as ChatRecord['messages']).map((entry) => ({ ...entry }))
    )
    const canShareForkTranscript = vi.fn(() => true)
    const { deps } = makeDeps({ appStore: store, prepareForkMessages, canShareForkTranscript })

    const fork = new ChatService(deps).createForkChat({ parentChatId: parent.appChatId })

    expect(canShareForkTranscript).toHaveBeenCalledWith(parent.appChatId)
    // The pure preparation seam received the live parent array (no clone) and
    // the fork still gets its own array container.
    expect(prepareForkMessages.mock.calls[0][0].copiedMessages).toBe(parent.messages)
    expect(fork.messages).not.toBe(parent.messages)
    expect(fork.messages).toEqual(parent.messages)
  })

  it('keeps the defensive structuredClone when the v2 fork-prefix gate is off or absent', () => {
    const parent = makeChat({
      appChatId: 'chat-1',
      provider: 'codex',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Clone me',
          timestamp: '2026-09-01T00:00:00.000Z'
        }
      ]
    })
    const parentBefore = structuredClone(parent)
    const sideChat = makeChat({
      appChatId: 'side-chat-1',
      parentChatId: parent.appChatId,
      parentChatRelation: 'sideChat',
      messages: []
    })
    const store = makeStore({
      getChat: vi.fn((chatId) => (chatId === parent.appChatId ? parent : sideChat)),
      createSideChat: vi.fn(() => sideChat),
      saveChat: vi.fn((chat: ChatRecord) => chat)
    })
    const prepareForkMessages = vi.fn(({ copiedMessages }) => {
      copiedMessages[0].content = 'Mutated copy'
      return copiedMessages
    })
    const { deps } = makeDeps({
      appStore: store,
      prepareForkMessages,
      canShareForkTranscript: vi.fn(() => false)
    })

    const fork = new ChatService(deps).createForkChat({ parentChatId: parent.appChatId })

    expect(prepareForkMessages.mock.calls[0][0].copiedMessages).not.toBe(parent.messages)
    expect(fork.messages[0].content).toBe('Mutated copy')
    // The parent record is untouched by preparation-side mutation of the copy.
    expect(parent).toEqual(parentBefore)
  })

  it('leaves only the empty fork shell when transcript preparation throws', () => {
    const events: string[] = []
    const parent = makeChat({
      appChatId: 'chat-1',
      provider: 'codex',
      messages: [
        {
          id: 'msg-1',
          role: 'user',
          content: 'Do not persist this copy',
          timestamp: '2026-07-05T12:00:00.000Z'
        }
      ]
    })
    const sideChat = makeChat({
      appChatId: 'side-chat-1',
      parentChatId: parent.appChatId,
      parentChatRelation: 'sideChat',
      messages: []
    })
    const saveChat = vi.fn((chat: ChatRecord) => {
      events.push('save')
      return chat
    })
    const store = makeStore({
      getChat: vi.fn(() => parent),
      createSideChat: vi.fn(() => {
        events.push('createSideChat')
        return sideChat
      }),
      saveChat
    })
    const { deps } = makeDeps({
      appStore: store,
      prepareForkMessages: vi.fn(() => {
        events.push('prepare')
        throw new Error('ownership persistence failed')
      })
    })

    expect(() =>
      new ChatService(deps).createForkChat({ parentChatId: parent.appChatId })
    ).toThrow('ownership persistence failed')
    expect(events).toEqual(['createSideChat', 'prepare'])
    expect(store.createSideChat).toHaveBeenCalledTimes(1)
    expect(saveChat).not.toHaveBeenCalled()
    expect(sideChat.messages).toEqual([])
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

  describe('antigravity sub-thread admission (Gemini API-key lane, independent of AGY opt-in)', () => {
    afterEach(() => {
      resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    })

    it('rejects an antigravity sub-thread when no Gemini API key is configured', () => {
      const { deps, store } = makeDeps()
      const service = new ChatService(deps)
      expect(() =>
        service.createSubThread({
          parentChatId: 'chat-1',
          provider: 'antigravity',
          delegationPrompt: 'Prompt',
          returnResultToParent: false
        })
      ).toThrow('antigravity is unavailable for new chats or delegated runs.')
      expect(store.createSubThread).not.toHaveBeenCalled()
    })

    it('admits an antigravity sub-thread once a Gemini API key is configured', () => {
      setAntigravityGeminiApiKeyConfiguredProbe(() => true)
      const { deps } = makeDeps()
      const service = new ChatService(deps)
      const subThread = service.createSubThread({
        parentChatId: 'chat-1',
        provider: 'antigravity',
        delegationPrompt: 'Prompt',
        returnResultToParent: false
      })
      expect(subThread.provider).toBe('antigravity')
    })
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
