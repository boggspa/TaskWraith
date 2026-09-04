import { describe, expect, it, vi } from 'vitest'
import {
  CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
  CHAT_UPDATE_INVALIDATION_CHANNEL,
  type ChatUpdateInterestEntry,
  type ChatUpdateInvalidation
} from '../shared/chatUpdateInterest'
import type { ChatListItem, ChatRecord, ChatRun, EnsembleConfig } from './store/types'
import {
  ChatUpdateInterestRouter,
  resolvePagedChatLiveUpdatesEnabled,
  type ChatUpdateDeliveryPort,
  type ChatUpdateProjectionStore,
  type ChatUpdateRouteTarget
} from './ChatUpdateInterestRouter'

function chat(id: string, overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: id,
    title: `title-${id}`,
    scope: 'global',
    provider: 'codex',
    createdAt: 1,
    updatedAt: 2,
    persistenceRevision: 3,
    archived: false,
    messages: [],
    runs: [],
    ...overrides
  } as ChatRecord
}

function snapshot(entries: ChatUpdateInterestEntry[]) {
  return { protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries }
}

function deliveryHarness(): ChatUpdateDeliveryPort {
  return {
    enqueue: vi.fn(),
    reseed: vi.fn(),
    clearTarget: vi.fn(),
    clearChat: vi.fn(() => true),
    clearChatEverywhere: vi.fn(() => 1),
    adoptRendererMutation: vi.fn(() => false)
  }
}

function projectionHarness(): ChatUpdateProjectionStore & {
  toChatListItem: ReturnType<typeof vi.fn<(source: ChatRecord) => ChatListItem>>
  toChatListEnsembleProjection: ReturnType<
    typeof vi.fn<(ensemble: EnsembleConfig) => EnsembleConfig>
  >
} {
  const toChatListEnsembleProjection = vi.fn((ensemble: EnsembleConfig): EnsembleConfig => {
    return {
      ...ensemble,
      participants: ensemble.participants.map((participant) => ({
        ...participant,
        instructions: ''
      }))
    }
  })
  const toChatListItem = vi.fn((source: ChatRecord): ChatListItem => {
    const { messages, runs, ensemble, ...chrome } = source
    return {
      ...chrome,
      ...(ensemble ? { ensemble: toChatListEnsembleProjection(ensemble) } : {}),
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount: messages.length,
      runCount: runs.length,
      runsSummary: [{ runId: `summary-${source.appChatId}`, diffFileCount: 0 }],
      searchText: `search-${source.appChatId}`,
      searchPreview: `preview-${source.appChatId}`,
      sourceChatMtimeMs: 40,
      sourceChatSize: 50
    } as ChatListItem
  })
  return { toChatListItem, toChatListEnsembleProjection }
}

function target(id: number, send = vi.fn()): ChatUpdateRouteTarget {
  return { id, isDestroyed: () => false, send }
}

function routerHarness(options: { enabled?: boolean; maxCompactProjections?: number } = {}): {
  router: ChatUpdateInterestRouter
  delivery: ChatUpdateDeliveryPort
  store: ReturnType<typeof projectionHarness>
} {
  const delivery = deliveryHarness()
  const store = projectionHarness()
  const router = new ChatUpdateInterestRouter({
    delivery,
    store,
    enabled: options.enabled ?? true,
    maxCompactProjections: options.maxCompactProjections
  })
  return { router, delivery, store }
}

describe('ChatUpdateInterestRouter', () => {
  it('resolves the environment escape hatch and keeps legacy targets on full delivery', () => {
    expect(resolvePagedChatLiveUpdatesEnabled(undefined)).toBe(true)
    expect(resolvePagedChatLiveUpdatesEnabled(' 0 ')).toBe(false)
    expect(resolvePagedChatLiveUpdatesEnabled('false')).toBe(true)

    const { router, delivery } = routerHarness()
    const current = chat('chat-a')
    expect(router.enqueue(target(7), current)).toBe('full')
    expect(delivery.enqueue).toHaveBeenCalledOnce()
    expect(delivery.enqueue).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), current)
  })

  it('forces full delivery when paged live updates are disabled', () => {
    const { router, delivery } = routerHarness({ enabled: false })
    expect(
      router.replaceTargetSnapshot(7, snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    ).toBeNull()
    expect(router.enqueue(target(7), chat('chat-a'))).toBe('full')
    expect(delivery.enqueue).toHaveBeenCalledOnce()
  })

  it('routes paged and absent-after-handshake chats to one reused compact projection', () => {
    const { router, delivery, store } = routerHarness()
    router.replaceTargetSnapshot(7, snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    router.replaceTargetSnapshot(8, snapshot([]))
    const sendPaged = vi.fn()
    const sendAbsent = vi.fn()
    const current = chat('chat-a', {
      messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: '2026-09-04T00:00:00Z' }]
    })
    const resolveProjection = router.createBroadcastProjectionResolver(current)

    expect(router.enqueue(target(7, sendPaged), current, resolveProjection)).toBe('compact')
    expect(router.enqueue(target(8, sendAbsent), current, resolveProjection)).toBe('compact')
    expect(store.toChatListItem).toHaveBeenCalledOnce()
    expect(delivery.clearChat).toHaveBeenCalledTimes(2)

    const pagedPayload = sendPaged.mock.calls[0]?.[1] as ChatUpdateInvalidation
    const absentPayload = sendAbsent.mock.calls[0]?.[1] as ChatUpdateInvalidation
    expect(sendPaged).toHaveBeenCalledWith(CHAT_UPDATE_INVALIDATION_CHANNEL, expect.any(Object))
    expect(pagedPayload).toMatchObject({
      kind: 'invalidation',
      chatId: 'chat-a',
      revision: 3,
      summary: { summaryOnly: true, messages: [], runs: [] }
    })
    expect(absentPayload.summary).toBe(pagedPayload.summary)
  })

  it('uses only top-level chrome, counts, the last run, and participants after the cold seed', () => {
    const { router, store } = routerHarness()
    const initial = chat('chat-a', {
      messages: [{ id: 'old', role: 'user', content: 'old', timestamp: '2026-09-04T00:00:00Z' }]
    })
    router.projectCompactChat(initial)

    const lastRun = {
      runId: 'run-2',
      provider: 'codex',
      startedAt: '2026-09-04T00:00:00Z',
      status: 'running',
      providerMetadata: { deliberately: 'large-and-not-for-the-list-row' }
    } as ChatRun
    const updated = chat('chat-a', {
      title: 'live title',
      updatedAt: 9,
      messages: new Array(10_000).fill(initial.messages[0]),
      runs: [{ runId: 'run-1', startedAt: '2026-09-04T00:00:00Z' }, lastRun] as ChatRun[],
      ensemble: {
        enabled: true,
        maxParticipants: 2,
        participants: [
          { id: 'seat-a', role: 'Reviewer', instructions: 'large brief' },
          { id: 'seat-b', role: 'Scout', instructions: 'another brief' }
        ]
      } as EnsembleConfig
    })
    const projected = router.projectCompactChat(updated)

    expect(store.toChatListItem).toHaveBeenCalledOnce()
    expect(store.toChatListEnsembleProjection).toHaveBeenCalledTimes(1)
    expect(projected).toMatchObject({
      appChatId: 'chat-a',
      title: 'live title',
      updatedAt: 9,
      messageCount: 10_000,
      runCount: 2,
      searchText: 'search-chat-a',
      searchPreview: 'preview-chat-a',
      sourceChatMtimeMs: 40,
      sourceChatSize: 50,
      lastRun: { runId: 'run-2', provider: 'codex', status: 'running' }
    })
    expect(projected.messages).toEqual([])
    expect(projected.runs).toEqual([])
    expect(projected.runsSummary).toEqual([{ runId: 'summary-chat-a', diffFileCount: 0 }])
    expect(projected.lastRun).not.toHaveProperty('providerMetadata')
    expect(projected.ensemble?.participants.map((participant) => participant.instructions)).toEqual(
      ['', '']
    )
  })

  it('honours summary-shell counts without scanning its empty transcript arrays', () => {
    const { router } = routerHarness()
    router.projectCompactChat(chat('chat-a'))
    const projected = router.projectCompactChat({
      ...chat('chat-a'),
      summaryOnly: true,
      messages: [],
      runs: [],
      messageCount: 321,
      runCount: 17,
      lastRun: { runId: 'run-17', startedAt: '2026-09-04T00:00:00Z' }
    } as ChatListItem)
    expect(projected).toMatchObject({
      messageCount: 321,
      runCount: 17,
      lastRun: { runId: 'run-17' }
    })
  })

  it('bounds the projection LRU on cold inserts and reseeds an evicted chat once', () => {
    const { router, store } = routerHarness({ maxCompactProjections: 2 })
    router.projectCompactChat(chat('chat-a'))
    router.projectCompactChat(chat('chat-b'))
    router.projectCompactChat(chat('chat-c'))
    expect(router.cachedProjectionCount()).toBe(2)
    expect(store.toChatListItem).toHaveBeenCalledTimes(3)

    router.projectCompactChat(chat('chat-a'))
    expect(store.toChatListItem).toHaveBeenCalledTimes(4)
    expect(router.cachedProjectionCount()).toBe(2)
  })

  it('cleans exact target and chat state without disturbing unrelated handshakes', () => {
    const { router, delivery } = routerHarness()
    router.replaceTargetSnapshot(
      7,
      snapshot([
        { chatId: 'chat-a', mode: 'full' },
        { chatId: 'chat-b', mode: 'paged' }
      ])
    )
    router.replaceTargetSnapshot(8, snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    router.projectCompactChat(chat('chat-a'))

    expect(router.clearChat('chat-a')).toEqual({
      projection: true,
      interestTargets: 2,
      deliveryTargets: 1
    })
    expect(delivery.clearChatEverywhere).toHaveBeenCalledWith('chat-a')
    expect(router.modeFor(7, 'chat-a')).toBeUndefined()
    expect(router.modeFor(7, 'chat-b')).toBe('paged')
    expect(router.modeFor(8, 'chat-a')).toBeUndefined()

    expect(router.clearTarget(7)).toBe(true)
    expect(delivery.clearTarget).toHaveBeenCalledWith(7)
    expect(router.modeFor(7, 'chat-b')).toBe('full')
    expect(router.hasHandshake(8)).toBe(true)
  })

  it('reseed and renderer-mutation adoption follow the same interest decision', () => {
    const { router, delivery } = routerHarness()
    const current = chat('chat-a')
    expect(router.reseed(target(7), current)).toBe('full')
    expect(delivery.reseed).toHaveBeenCalledOnce()

    router.replaceTargetSnapshot(8, snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    expect(router.reseed(target(8), current)).toBe('compact')
    expect(delivery.reseed).toHaveBeenCalledTimes(1)
    expect(router.adoptRendererMutation(8, current, 2)).toBe(true)
    expect(delivery.adoptRendererMutation).not.toHaveBeenCalled()

    expect(router.adoptRendererMutation(7, current, 2)).toBe(false)
    expect(delivery.adoptRendererMutation).toHaveBeenCalledWith(7, current, 2)
  })

  it('drops exact target state when compact invalidation delivery throws', () => {
    const { router, delivery } = routerHarness()
    router.replaceTargetSnapshot(7, snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    const brokenTarget = target(
      7,
      vi.fn(() => {
        throw new Error('renderer gone')
      })
    )

    expect(router.enqueue(brokenTarget, chat('chat-a'))).toBe('ignored')
    expect(delivery.clearTarget).toHaveBeenCalledWith(7)
    expect(router.modeFor(7, 'chat-a')).toBe('full')
  })

  it('accepts a BrowserWindow-shaped target without leaking Electron into callers', () => {
    const { router, delivery } = routerHarness()
    const send = vi.fn()
    const windowTarget = {
      isDestroyed: () => false,
      webContents: { id: 11, isDestroyed: () => false, send }
    }
    expect(router.enqueue(windowTarget, chat('chat-a'))).toBe('full')
    expect(delivery.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ id: 11 }),
      expect.anything()
    )
  })
})
