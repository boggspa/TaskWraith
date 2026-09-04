import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatListItem, ChatMessage, ChatRecord } from '../../../main/store/types'
import {
  buildChatUpdateInvalidation,
  createChatUpdateInterestSnapshot,
  type ChatUpdateInvalidation
} from '../../../shared/chatUpdateInterest'
import type {
  ChatShell,
  TranscriptPage,
  TranscriptPageRequest
} from '../../../shared/transcriptPage'
import { createChatHydrationRuntime } from '../lib/chatHydrationRuntime'
import {
  buildChatUpdateInterestSurfaceSnapshot,
  ChatUpdateInterestRuntime,
  type ChatUpdateInterestBridge,
  type ChatUpdateInterestRuntimeState
} from './useChatUpdateInterestRuntime'

function fullChat(chatId: string, messageCount = 2): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: chatId,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    persistenceRevision: 2,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `${chatId}-message-${index}`,
      role: 'assistant',
      content: `content-${index}`,
      timestamp: '2026-09-04T00:00:00.000Z'
    })) as ChatMessage[],
    runs: []
  } as ChatRecord
}

function summary(chatId: string, messageCount = 2): ChatListItem {
  return {
    ...fullChat(chatId, 0),
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount,
    runCount: 0,
    sourceChatSize: messageCount * 1024 * 1024
  } as ChatListItem
}

function page(chatId: string, revision = 3): TranscriptPage {
  const message = {
    id: `${chatId}-tail`,
    role: 'assistant',
    content: 'bounded tail',
    timestamp: '2026-09-04T00:00:00.000Z'
  } as ChatMessage
  const shell = {
    ...summary(chatId, revision),
    updatedAt: revision,
    persistenceRevision: revision,
    transcriptPaged: true
  } as ChatShell
  return {
    chatId,
    messages: [message],
    runs: [],
    totalMessageCount: revision,
    windowStart: revision - 1,
    windowEnd: revision,
    estimatedBytes: 128,
    hasOlder: true,
    hasNewer: false,
    oldestMessageId: message.id,
    newestMessageId: message.id,
    updatedAt: revision,
    shell
  }
}

function stateHarness(initialChats: ChatRecord[], initialCurrent: ChatRecord | null = null) {
  let chats = initialChats
  let currentChat = initialCurrent
  const chatByIdRef = { current: new Map(initialChats.map((chat) => [chat.appChatId, chat])) }
  const activeRunChatIdRef = { current: null as string | null }
  const activeRunChatSnapshotRef = { current: null as ChatRecord | null }
  const clearedChatIdsRef = { current: new Set<string>() }
  const pendingMainChatUpdatesRef = { current: new Map<string, unknown>() }
  const pendingChatFlushRef = { current: new Set<string>() }
  const pendingChatRenderReceiptsRef = { current: new Map<string, unknown>() }
  const hydrationRuntime = createChatHydrationRuntime()
  const currentAutoFollowRef = { current: true }
  const getState = (): ChatUpdateInterestRuntimeState => ({
    chats,
    currentChat,
    setChats: (action) => {
      chats = typeof action === 'function' ? action(chats) : action
    },
    setCurrentChat: (action) => {
      currentChat = typeof action === 'function' ? action(currentChat) : action
    },
    chatByIdRef,
    activeRunChatIdRef,
    activeRunChatSnapshotRef,
    clearedChatIdsRef,
    pendingMainChatUpdatesRef,
    pendingChatFlushRef,
    pendingChatRenderReceiptsRef,
    hydrationRuntime,
    isChatPopoutWindow: false,
    chatPopoutChatId: null,
    paneChatIds: [],
    paneScrollRefs: [],
    sideChatId: null,
    currentAutoFollowRef,
    fullResidencyChatIds: []
  })
  return {
    getState,
    chatByIdRef,
    activeRunChatIdRef,
    activeRunChatSnapshotRef,
    pendingMainChatUpdatesRef,
    pendingChatFlushRef,
    pendingChatRenderReceiptsRef,
    hydrationRuntime,
    currentAutoFollowRef,
    chats: () => chats,
    currentChat: () => currentChat
  }
}

describe('buildChatUpdateInterestSurfaceSnapshot', () => {
  it('aggregates current/panes, plans paging for large shells and lets side-full dominate', () => {
    const small = summary('small', 2)
    const large = summary('large', 2_000)
    const records = new Map<string, ChatRecord>([
      ['small', small],
      ['large', large]
    ])
    const snapshot = buildChatUpdateInterestSurfaceSnapshot({
      chats: [small, large],
      currentChat: small,
      resolveChat: (chatId) => records.get(chatId),
      isPaged: () => false,
      isChatPopoutWindow: false,
      chatPopoutChatId: null,
      paneChatIds: ['large'],
      sideChatId: 'large'
    })
    expect(snapshot.entries).toEqual([
      { chatId: 'large', mode: 'full' },
      { chatId: 'small', mode: 'full' }
    ])
  })

  it('bootstraps an unhydrated popout as paged but falls back to full without a pager', () => {
    const base = {
      chats: [],
      currentChat: null,
      resolveChat: () => null,
      isPaged: () => false,
      isChatPopoutWindow: true,
      chatPopoutChatId: 'popout-chat',
      paneChatIds: [],
      sideChatId: null
    }
    expect(buildChatUpdateInterestSurfaceSnapshot(base).entries).toEqual([
      { chatId: 'popout-chat', mode: 'paged' }
    ])
    expect(
      buildChatUpdateInterestSurfaceSnapshot({ ...base, pagingAvailable: false }).entries
    ).toEqual([{ chatId: 'popout-chat', mode: 'full' }])
  })

  it('keeps approval-residency chats on full delivery even while offscreen', () => {
    const approval = summary('approval-chat', 2_000)
    const snapshot = buildChatUpdateInterestSurfaceSnapshot({
      chats: [approval],
      currentChat: null,
      resolveChat: () => approval,
      isPaged: () => false,
      isChatPopoutWindow: false,
      chatPopoutChatId: null,
      paneChatIds: [],
      sideChatId: null,
      fullResidencyChatIds: ['approval-chat']
    })
    expect(snapshot.entries).toEqual([{ chatId: 'approval-chat', mode: 'full' }])
  })
})

describe('ChatUpdateInterestRuntime', () => {
  let invalidationHandler: ((value: ChatUpdateInvalidation) => void) | null

  beforeEach(() => {
    invalidationHandler = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('installs the listener before the handshake and survives setup-cleanup-setup', () => {
    const order: string[] = []
    const sent: ReturnType<typeof createChatUpdateInterestSnapshot>[] = []
    const bridge: ChatUpdateInterestBridge = {
      onChatUpdateInvalidated: (handler) => {
        order.push('listen')
        invalidationHandler = handler
        return () => order.push('unlisten')
      },
      setChatUpdateInterests: (snapshot) => {
        order.push('send')
        sent.push(snapshot)
      },
      getChatTranscriptPage: async () => null
    }
    const harness = stateHarness([])
    const runtime = new ChatUpdateInterestRuntime(bridge, harness.getState)
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot([{ chatId: 'visible', mode: 'full' }])
    )

    runtime.start()
    expect(order.slice(0, 2)).toEqual(['listen', 'send'])
    expect(runtime.shouldRejectFullDelivery('visible')).toBe(false)
    expect(runtime.shouldRejectFullDelivery('background')).toBe(true)
    runtime.stop()
    runtime.start()
    expect(order.filter((entry) => entry === 'listen')).toHaveLength(2)
    expect(sent.at(-1)?.entries).toEqual([{ chatId: 'visible', mode: 'full' }])
  })

  it('keeps legacy full delivery active when main exposes the environment escape hatch as off', () => {
    const listen = vi.fn(() => () => undefined)
    const send = vi.fn()
    const harness = stateHarness([])
    const runtime = new ChatUpdateInterestRuntime(
      {
        pagedChatLiveUpdatesEnabled: false,
        onChatUpdateInvalidated: listen,
        setChatUpdateInterests: send,
        getChatTranscriptPage: async () => null
      },
      harness.getState
    )
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot([{ chatId: 'visible', mode: 'paged' }])
    )

    runtime.start()
    expect(listen).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(runtime.shouldRejectFullDelivery('visible')).toBe(false)
  })

  it('replaces an offscreen full record with a lean projection and drops every retention alias', () => {
    const full = fullChat('background', 20)
    const harness = stateHarness([full])
    harness.activeRunChatIdRef.current = full.appChatId
    harness.activeRunChatSnapshotRef.current = full
    harness.pendingMainChatUpdatesRef.current.set(full.appChatId, {})
    harness.pendingChatFlushRef.current.add(full.appChatId)
    harness.pendingChatRenderReceiptsRef.current.set(full.appChatId, {})
    harness.hydrationRuntime.transcriptStore.ingest(full)
    const bridge: ChatUpdateInterestBridge = {
      onChatUpdateInvalidated: (handler) => {
        invalidationHandler = handler
        return () => undefined
      },
      setChatUpdateInterests: () => undefined,
      getChatTranscriptPage: async () => null
    }
    const runtime = new ChatUpdateInterestRuntime(bridge, harness.getState)
    runtime.start()

    invalidationHandler!(buildChatUpdateInvalidation(summary('background', 20))!)
    const retained = harness.chatByIdRef.current.get('background') as ChatListItem
    expect(retained.summaryOnly).toBe(true)
    expect(retained.messages).toEqual([])
    expect(harness.activeRunChatSnapshotRef.current).toBe(retained)
    expect(harness.hydrationRuntime.transcriptStore.has('background')).toBe(false)
    expect(harness.pendingMainChatUpdatesRef.current.has('background')).toBe(false)
    expect(harness.pendingChatFlushRef.current.has('background')).toBe(false)
    expect(harness.pendingChatRenderReceiptsRef.current.has('background')).toBe(false)
  })

  it('fetches and commits only a bounded tail page plus an empty marked shell', async () => {
    const initial = summary('large', 2_000)
    const harness = stateHarness([initial], initial)
    const requests: TranscriptPageRequest[] = []
    const bridge: ChatUpdateInterestBridge = {
      onChatUpdateInvalidated: (handler) => {
        invalidationHandler = handler
        return () => undefined
      },
      setChatUpdateInterests: () => undefined,
      getChatTranscriptPage: async (request) => {
        requests.push(request)
        return page(request.chatId)
      }
    }
    const runtime = new ChatUpdateInterestRuntime(bridge, harness.getState)
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot([{ chatId: 'large', mode: 'paged' }])
    )
    runtime.start()
    invalidationHandler!(buildChatUpdateInvalidation(initial)!)

    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()
    expect(requests).toEqual([
      expect.objectContaining({
        chatId: 'large',
        includeShell: true,
        maxMessages: 500,
        maxBytes: 8 * 1024 * 1024
      })
    ])
    const committed = harness.chatByIdRef.current.get('large') as ChatShell
    expect(committed.transcriptPaged).toBe(true)
    expect(committed.messages).toEqual([])
    expect(harness.hydrationRuntime.transcriptStore.isPaged('large')).toBe(true)
    expect(harness.hydrationRuntime.transcriptStore.get('large')?.messages[0]?.id).toBe(
      'large-tail'
    )
  })

  it('retains the latest invalidation while manual scroll blocks refresh and retries at latest', async () => {
    const initialPage = page('large', 2)
    const shell = initialPage.shell!
    const harness = stateHarness([shell], shell)
    harness.hydrationRuntime.transcriptStore.ingestPage(initialPage)
    harness.currentAutoFollowRef.current = false
    const fetchPage = vi.fn(async (request: TranscriptPageRequest) => page(request.chatId, 3))
    const bridge: ChatUpdateInterestBridge = {
      onChatUpdateInvalidated: (handler) => {
        invalidationHandler = handler
        return () => undefined
      },
      setChatUpdateInterests: () => undefined,
      getChatTranscriptPage: fetchPage
    }
    const runtime = new ChatUpdateInterestRuntime(bridge, harness.getState)
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot([{ chatId: 'large', mode: 'paged' }])
    )
    runtime.start()
    invalidationHandler!(buildChatUpdateInvalidation(summary('large', 3))!)
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchPage).not.toHaveBeenCalled()

    harness.currentAutoFollowRef.current = true
    runtime.retryDeferredPagedInvalidations()
    await vi.advanceTimersByTimeAsync(50)
    expect(fetchPage).toHaveBeenCalledOnce()
  })
})
