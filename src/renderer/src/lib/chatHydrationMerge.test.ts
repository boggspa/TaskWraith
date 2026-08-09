import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatListItem, ChatRecord } from '../../../main/store/types'
import { commitHydratedChat, resolveChatHydration } from './chatHydrationMerge'
import { ChatUpdateHydrationQueue } from './chatUpdateHydrationQueue'
import { ChatByteLru } from './chatByteLru'
import { ChatTranscriptStore } from './chatTranscriptStore'

function chat(title: string): ChatRecord {
  return {
    appChatId: 'chat-a',
    title,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
}

function summary(): ChatRecord {
  return {
    ...chat('Summary'),
    summaryOnly: true,
    messageCount: 0,
    runCount: 0
  } as ChatListItem
}

describe('resolveChatHydration', () => {
  it('preserves a full record installed after the hydration request began', () => {
    const requestStart = summary()
    const locallyUpdated = { ...chat('Hydrated'), updatedAt: 3, workspacePath: '/latest' }
    const staleIncoming = { ...chat('Hydrated'), updatedAt: 2, workspacePath: '/stale' }

    expect(
      resolveChatHydration({
        incoming: staleIncoming,
        current: locallyUpdated,
        localAtRequestStart: requestStart
      })
    ).toBe(locallyUpdated)
  })

  it('accepts hydration when the local request snapshot still owns the chat', () => {
    const requestStart = summary()
    const incoming = chat('Hydrated')

    expect(
      resolveChatHydration({
        incoming,
        current: requestStart,
        localAtRequestStart: requestStart
      })
    ).toBe(incoming)
  })

  it('keeps queued edits when selected-chat hydration resolves after the queue', async () => {
    const queue = new ChatUpdateHydrationQueue<ChatRecord>()
    const requestStart = summary()
    let current: ChatRecord = requestStart
    let resolveQueueHydration!: (value: ChatRecord | null) => void
    const queueHydration = new Promise<ChatRecord | null>((resolve) => {
      resolveQueueHydration = resolve
    })

    queue.enqueue({
      key: 'chat-a',
      updater: (value) => ({ ...value, workspacePath: '/queue-edit', updatedAt: 3 }),
      hydrate: () => queueHydration,
      resolveAvailableBase: () => null,
      resolveBase: (_key, hydrated) => hydrated,
      apply: (_key, base, updater) => {
        current = updater(base)
        return current
      }
    })
    resolveQueueHydration({ ...chat('Hydrated'), workspacePath: '/stale', updatedAt: 2 })
    await Promise.resolve()
    await Promise.resolve()

    const selectedHydrationLast = resolveChatHydration({
      incoming: { ...chat('Hydrated'), workspacePath: '/stale', updatedAt: 2 },
      current,
      localAtRequestStart: requestStart
    })

    expect(selectedHydrationLast.workspacePath).toBe('/queue-edit')
    expect(selectedHydrationLast).toBe(current)
  })

  it('guards hydration once and shares it with selected-after-paint presentation in App', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const refresh = source.slice(
      source.indexOf('const refreshSingleChat ='),
      source.indexOf('const isValidModelForProvider =')
    )
    const selected = source.slice(
      source.indexOf('const hydrateSelectedChatAfterPaint ='),
      source.indexOf('const PROVIDER_SCOPED_COMPOSER_METADATA_KEYS')
    )

    expect(refresh).toContain('const localAtRequestStart =')
    expect(refresh).toContain('applyHydratedChat(hydrated, { localAtRequestStart })')
    expect(refresh).toContain('requestPool.run(chatId, async () =>')
    expect(selected).toContain('refreshSingleChat(chat.appChatId)')
    expect(selected).not.toContain('window.api.getChat')
    expect(selected).not.toContain('applyHydratedChat')
    expect(selected).not.toContain('setCurrentChat(hydrated)')
    // applyHydratedChat owns setCurrentChat; after-paint only syncs composer chrome.
    expect(selected).not.toContain('setCurrentChat(resolved)')
  })

  it('routes hydration commits through commitHydratedChat for T7 store/LRU', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const apply = source.slice(
      source.indexOf('const applyHydratedChat ='),
      source.indexOf('const refreshSingleChat =')
    )
    expect(apply).toContain('commitHydratedChat({')
    expect(apply).toContain('chatHydrationRuntimeRef.current.transcriptStore')
    expect(apply).toContain('chatHydrationRuntimeRef.current.byteLru')
    expect(apply).not.toContain('pinReason: currentChatIdRef.current')
  })

  it('owns focused residency for exactly the focused chat lifecycle', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

    expect(source).toContain("byteLru.pin(chatId, 'focused')")
    expect(source).toContain("return () => byteLru.unpin(chatId, 'focused')")
    expect(source).toContain('}, [currentChat?.appChatId])')
  })

  it('cancels pending hydration before delete, clear-all, and reap removal', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const deleteOne = source.slice(
      source.indexOf('const handleDeleteChat ='),
      source.indexOf('const handleDeleteAllChatHistory =')
    )
    const deleteAll = source.slice(
      source.indexOf('const handleDeleteAllChatHistory ='),
      source.indexOf('const handleTogglePinWorkspace =')
    )
    const reap = source.slice(
      source.indexOf('const reapAbandonedChatsAfterCreate ='),
      source.indexOf('const handleNewChat =')
    )

    expect(deleteOne).toContain('summaryChatUpdateQueueRef.current.cancel(chatId)')
    expect(deleteOne).toContain('saveChatTimersRef.current.delete(chatId)')
    expect(deleteAll).toContain('summaryChatUpdateQueueRef.current.clear()')
    expect(reap).toContain('summaryChatUpdateQueueRef.current.cancel(id)')
    expect(reap).toContain('saveChatTimersRef.current.delete(id)')
  })
})

describe('commitHydratedChat', () => {
  it('ingests transcript into the external store and pins via the byte LRU', () => {
    const store = new ChatTranscriptStore()
    const lru = new ChatByteLru()
    const full = {
      ...chat('Hydrated'),
      messages: [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: '1' }]
    }
    commitHydratedChat({
      chat: full,
      transcriptStore: store,
      byteLru: lru,
      pinReason: 'focused'
    })
    expect(store.get('chat-a')?.messages).toHaveLength(1)
    expect(lru.isPinned('chat-a')).toBe(true)
  })
})
