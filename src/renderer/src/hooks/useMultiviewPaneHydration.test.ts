import { describe, expect, it, vi } from 'vitest'
import { MultiviewPaneHydrationCoordinator } from './useMultiviewPaneHydration'

type TestChat = { id: string; hydrated: boolean }

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('MultiviewPaneHydrationCoordinator', () => {
  it('pins and hydrates each visible thread once, independent of focus order', async () => {
    const chats = new Map<string, TestChat>([
      ['a', { id: 'a', hydrated: false }],
      ['b', { id: 'b', hydrated: false }]
    ])
    const pinChat = vi.fn()
    const unpinChat = vi.fn()
    const hydrateChat = vi.fn(async (chatId: string) => {
      const chat = { id: chatId, hydrated: true }
      chats.set(chatId, chat)
      return chat
    })
    const coordinator = new MultiviewPaneHydrationCoordinator<TestChat>({
      resolveChat: (chatId) => chats.get(chatId),
      isHydrated: (chat) => chat.hydrated,
      hydrateChat,
      pinChat,
      unpinChat
    })

    coordinator.updateVisible(['a', 'b'])
    await flushPromises()
    coordinator.updateVisible(['b', 'a'])
    await flushPromises()

    expect(pinChat.mock.calls).toEqual([['a'], ['b']])
    expect(hydrateChat.mock.calls).toEqual([['a'], ['b']])
    expect(unpinChat).not.toHaveBeenCalled()
  })

  it('deduplicates duplicate panes and concurrent hydration for the same thread', async () => {
    let resolveHydration: ((chat: TestChat) => void) | undefined
    const hydrateChat = vi.fn(
      () =>
        new Promise<TestChat>((resolve) => {
          resolveHydration = resolve
        })
    )
    const coordinator = new MultiviewPaneHydrationCoordinator<TestChat>({
      resolveChat: () => ({ id: 'a', hydrated: false }),
      isHydrated: (chat) => chat.hydrated,
      hydrateChat,
      pinChat: vi.fn(),
      unpinChat: vi.fn()
    })

    coordinator.updateVisible(['a', 'a'])
    coordinator.ensureVisibleHydrated()
    await flushPromises()
    expect(hydrateChat).toHaveBeenCalledTimes(1)
    expect(coordinator.pendingChatIds()).toEqual(['a'])

    resolveHydration?.({ id: 'a', hydrated: true })
    await flushPromises()
    expect(coordinator.pendingChatIds()).toEqual([])
  })

  it('isolates failures and permits a failed pane to retry', async () => {
    const hydrateChat = vi.fn<(chatId: string) => Promise<TestChat | null>>()
    const hydrated = new Set<string>()
    hydrateChat.mockImplementationOnce(async () => {
      throw new Error('a failed')
    })
    hydrateChat.mockImplementationOnce(async () => {
      hydrated.add('b')
      return { id: 'b', hydrated: true }
    })
    hydrateChat.mockImplementationOnce(async () => {
      hydrated.add('a')
      return { id: 'a', hydrated: true }
    })
    const coordinator = new MultiviewPaneHydrationCoordinator<TestChat>({
      resolveChat: (chatId) => ({ id: chatId, hydrated: hydrated.has(chatId) }),
      isHydrated: (chat) => chat.hydrated,
      hydrateChat,
      pinChat: vi.fn(),
      unpinChat: vi.fn()
    })

    coordinator.updateVisible(['a', 'b'])
    await flushPromises()
    expect(hydrated.has('b')).toBe(true)
    expect(coordinator.pendingChatIds()).toEqual([])

    coordinator.ensureVisibleHydrated()
    await flushPromises()
    expect(hydrated.has('a')).toBe(true)
    expect(hydrateChat.mock.calls).toEqual([['a'], ['b'], ['a']])
  })

  it('unpins only threads that stop being visible and releases all on dispose', () => {
    const pinChat = vi.fn()
    const unpinChat = vi.fn()
    const coordinator = new MultiviewPaneHydrationCoordinator<TestChat>({
      resolveChat: (chatId) => ({ id: chatId, hydrated: true }),
      isHydrated: (chat) => chat.hydrated,
      hydrateChat: vi.fn(),
      pinChat,
      unpinChat
    })

    coordinator.updateVisible(['a', 'b'])
    coordinator.updateVisible(['b', 'c'])
    coordinator.dispose()

    expect(pinChat.mock.calls).toEqual([['a'], ['b'], ['c']])
    expect(unpinChat.mock.calls).toEqual([['a'], ['b'], ['c']])
  })
})
