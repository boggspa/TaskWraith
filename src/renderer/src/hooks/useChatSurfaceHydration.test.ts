import { describe, expect, it, vi } from 'vitest'
import { ChatSurfaceHydrationCoordinator } from './useChatSurfaceHydration'

type TestChat = { id: string; hydrated: boolean }

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('ChatSurfaceHydrationCoordinator', () => {
  it('gives a side surface independent hydration and residency ownership', async () => {
    const chats = new Map<string, TestChat>([['side-chat', { id: 'side-chat', hydrated: false }]])
    const pinChat = vi.fn()
    const unpinChat = vi.fn()
    const hydrateChat = vi.fn(async (chatId: string) => {
      const chat = { id: chatId, hydrated: true }
      chats.set(chatId, chat)
      return chat
    })
    const coordinator = new ChatSurfaceHydrationCoordinator<TestChat>({
      resolveChat: (chatId) => chats.get(chatId),
      isHydrated: (chat) => chat.hydrated,
      hydrateChat,
      pinChat,
      unpinChat
    })

    coordinator.updateVisible(['side-chat'])
    await flushPromises()

    expect(pinChat).toHaveBeenCalledWith('side-chat')
    expect(hydrateChat).toHaveBeenCalledWith('side-chat')

    coordinator.updateVisible([])
    expect(unpinChat).toHaveBeenCalledWith('side-chat')
  })

  it('does not let another surface or focus order restart an in-flight read', async () => {
    let resolveHydration: ((chat: TestChat) => void) | undefined
    const hydrateChat = vi.fn(
      () =>
        new Promise<TestChat>((resolve) => {
          resolveHydration = resolve
        })
    )
    const coordinator = new ChatSurfaceHydrationCoordinator<TestChat>({
      resolveChat: () => ({ id: 'shared', hydrated: false }),
      isHydrated: (chat) => chat.hydrated,
      hydrateChat,
      pinChat: vi.fn(),
      unpinChat: vi.fn()
    })

    coordinator.updateVisible(['shared'])
    coordinator.updateVisible(['shared'])
    coordinator.ensureVisibleHydrated()
    await flushPromises()

    expect(hydrateChat).toHaveBeenCalledTimes(1)
    resolveHydration?.({ id: 'shared', hydrated: true })
    await flushPromises()
    expect(coordinator.pendingChatIds()).toEqual([])
  })
})
