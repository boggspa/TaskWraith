import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  CHAT_UPDATE_INTEREST_CHANNEL,
  CHAT_UPDATE_INTEREST_PROTOCOL_VERSION,
  CHAT_UPDATE_INVALIDATION_CHANNEL,
  type ChatUpdateInterestEntry
} from '../../shared/chatUpdateInterest'
import type { ChatListItem, ChatRecord, EnsembleConfig } from '../store/types'
import {
  ChatUpdateInterestRouter,
  type ChatUpdateDeliveryPort,
  type ChatUpdateProjectionStore
} from '../ChatUpdateInterestRouter'
import {
  createChatUpdateInterestHandler,
  registerChatUpdateInterestHandlers,
  type ChatUpdateInterestHandlersDeps,
  type ChatUpdateInterestSenderEvent
} from './chatUpdateInterestHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn()
  }
}))

const mockedOn = vi.mocked(ipcMain.on)

beforeEach(() => {
  mockedOn.mockReset()
})

function snapshot(entries: ChatUpdateInterestEntry[]) {
  return { protocolVersion: CHAT_UPDATE_INTEREST_PROTOCOL_VERSION, entries }
}

function chat(id: string): ChatRecord {
  return {
    appChatId: id,
    title: id,
    scope: 'global',
    provider: 'codex',
    createdAt: 1,
    updatedAt: 2,
    persistenceRevision: 3,
    archived: false,
    messages: [],
    runs: []
  } as ChatRecord
}

function event(senderId: number, destroyed = false): ChatUpdateInterestSenderEvent {
  return {
    sender: {
      id: senderId,
      isDestroyed: () => destroyed
    }
  } as ChatUpdateInterestSenderEvent
}

interface Harness {
  router: ChatUpdateInterestRouter
  delivery: ChatUpdateDeliveryPort
  deps: ChatUpdateInterestHandlersDeps
  handler: ReturnType<typeof createChatUpdateInterestHandler>
}

function harness(
  options: {
    enabled?: boolean
    mainSenderIds?: number[]
    owners?: Record<number, { kind: 'chat' | 'workbench'; chatId?: string }>
  } = {}
): Harness {
  const delivery: ChatUpdateDeliveryPort = {
    enqueue: vi.fn(),
    reseed: vi.fn(),
    clearTarget: vi.fn(),
    clearChat: vi.fn(() => true),
    clearChatEverywhere: vi.fn(() => 0),
    adoptRendererMutation: vi.fn(() => true)
  }
  const store: ChatUpdateProjectionStore = {
    toChatListItem: vi.fn((source: ChatRecord) => {
      return {
        ...source,
        messages: [],
        runs: [],
        summaryOnly: true,
        messageCount: source.messages.length,
        runCount: source.runs.length
      } as ChatListItem
    }),
    toChatListEnsembleProjection: vi.fn((ensemble: EnsembleConfig) => ensemble)
  }
  const router = new ChatUpdateInterestRouter({
    delivery,
    store,
    enabled: options.enabled ?? true
  })
  const mainSenderIds = new Set(options.mainSenderIds ?? [7])
  const deps: ChatUpdateInterestHandlersDeps = {
    router,
    isMainRendererSender: vi.fn((candidate) => mainSenderIds.has(candidate.sender.id)),
    workspacePopoutOwnerForSender: vi.fn((senderId) => options.owners?.[senderId])
  }
  return {
    router,
    delivery,
    deps,
    handler: createChatUpdateInterestHandler(deps)
  }
}

describe('chatUpdateInterestHandlers', () => {
  it('registers the bounded snapshot listener on the canonical channel', () => {
    const { deps } = harness()
    registerChatUpdateInterestHandlers(deps)
    expect(mockedOn).toHaveBeenCalledOnce()
    expect(mockedOn).toHaveBeenCalledWith(CHAT_UPDATE_INTEREST_CHANNEL, expect.any(Function))
  })

  it('ignores disabled, destroyed, and malformed senders without ending legacy delivery', () => {
    const disabled = harness({ enabled: false })
    disabled.handler(event(7), snapshot([]))
    expect(disabled.router.hasHandshake(7)).toBe(false)
    expect(disabled.delivery.clearTarget).not.toHaveBeenCalled()

    const active = harness()
    active.handler(event(7, true), snapshot([]))
    active.handler(event(7), { entries: [] })
    active.handler(event(7), null)
    expect(active.router.hasHandshake(7)).toBe(false)
    expect(active.router.modeFor(7, 'chat-a')).toBe('full')
    expect(active.delivery.clearTarget).not.toHaveBeenCalled()
  })

  it('normalizes a main renderer replacement and clears all legacy baselines once', () => {
    const { router, delivery, handler } = harness()
    handler(
      event(7),
      snapshot([
        { chatId: 'chat-a', mode: 'paged' },
        { chatId: 'chat-a', mode: 'full' },
        { chatId: '\n', mode: 'full' }
      ])
    )

    expect(router.snapshotForTarget(7)).toEqual(snapshot([{ chatId: 'chat-a', mode: 'full' }]))
    expect(delivery.clearTarget).toHaveBeenCalledOnce()
    expect(delivery.clearTarget).toHaveBeenCalledWith(7)

    handler(event(7), snapshot([{ chatId: 'chat-a', mode: 'full' }]))
    expect(delivery.clearTarget).toHaveBeenCalledOnce()
    expect(delivery.clearChat).not.toHaveBeenCalled()
  })

  it('clears only full baselines whose explicit interest changed or disappeared', () => {
    const { delivery, handler } = harness()
    handler(
      event(7),
      snapshot([
        { chatId: 'chat-a', mode: 'full' },
        { chatId: 'chat-b', mode: 'full' },
        { chatId: 'chat-c', mode: 'paged' }
      ])
    )
    vi.mocked(delivery.clearTarget).mockClear()

    handler(
      event(7),
      snapshot([
        { chatId: 'chat-a', mode: 'full' },
        { chatId: 'chat-b', mode: 'paged' }
      ])
    )
    expect(delivery.clearTarget).not.toHaveBeenCalled()
    expect(delivery.clearChat).toHaveBeenCalledTimes(1)
    expect(delivery.clearChat).toHaveBeenLastCalledWith(7, 'chat-b')

    handler(event(7), snapshot([]))
    expect(delivery.clearChat).toHaveBeenCalledTimes(2)
    expect(delivery.clearChat).toHaveBeenLastCalledWith(7, 'chat-a')
  })

  it('filters a chat popout to its exact main-owned chat authority', () => {
    const { router, delivery, deps, handler } = harness({
      mainSenderIds: [],
      owners: { 11: { kind: 'chat', chatId: 'chat-a' } }
    })
    handler(
      event(11),
      snapshot([
        { chatId: 'chat-a', mode: 'paged' },
        { chatId: 'chat-b', mode: 'full' }
      ])
    )

    expect(router.snapshotForTarget(11)).toEqual(snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    expect(deps.workspacePopoutOwnerForSender).toHaveBeenCalledWith(11)
    expect(delivery.clearTarget).toHaveBeenCalledWith(11)
  })

  it('rejects secondary renderers without exact chat authority and preserves legacy mode', () => {
    const noOwner = harness({ mainSenderIds: [] })
    noOwner.handler(event(11), snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    expect(noOwner.router.hasHandshake(11)).toBe(false)
    expect(noOwner.router.modeFor(11, 'chat-a')).toBe('full')
    expect(noOwner.delivery.clearTarget).not.toHaveBeenCalled()

    const broadOwner = harness({
      mainSenderIds: [],
      owners: { 12: { kind: 'workbench' } }
    })
    broadOwner.handler(event(12), snapshot([{ chatId: 'chat-a', mode: 'paged' }]))
    expect(broadOwner.router.hasHandshake(12)).toBe(false)
    expect(broadOwner.delivery.clearTarget).not.toHaveBeenCalled()
  })

  it('accepts an empty filtered popout handshake without granting another chat', () => {
    const { router, delivery, handler } = harness({
      mainSenderIds: [],
      owners: { 11: { kind: 'chat', chatId: 'chat-a' } }
    })
    handler(event(11), snapshot([{ chatId: 'chat-b', mode: 'full' }]))

    expect(router.snapshotForTarget(11)).toEqual(snapshot([]))
    expect(router.modeFor(11, 'chat-a')).toBeUndefined()
    expect(router.modeFor(11, 'chat-b')).toBeUndefined()
    expect(delivery.clearTarget).toHaveBeenCalledWith(11)
  })

  it('keeps absent chats live through compact invalidation after the first handshake', () => {
    const { router, handler } = harness()
    handler(event(7), snapshot([]))
    const send = vi.fn()

    expect(router.enqueue({ id: 7, isDestroyed: () => false, send }, chat('chat-a'))).toBe(
      'compact'
    )
    expect(send).toHaveBeenCalledWith(
      CHAT_UPDATE_INVALIDATION_CHANNEL,
      expect.objectContaining({ chatId: 'chat-a', kind: 'invalidation' })
    )
  })

  it('does not mutate an established snapshot after a malformed replacement', () => {
    const { router, delivery, handler } = harness()
    handler(event(7), snapshot([{ chatId: 'chat-a', mode: 'full' }]))
    vi.mocked(delivery.clearTarget).mockClear()
    handler(event(7), { protocolVersion: 999, entries: [] })

    expect(router.snapshotForTarget(7)).toEqual(snapshot([{ chatId: 'chat-a', mode: 'full' }]))
    expect(delivery.clearTarget).not.toHaveBeenCalled()
    expect(delivery.clearChat).not.toHaveBeenCalled()
  })
})
