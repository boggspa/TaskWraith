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
import { isChatSummaryRecord } from '../lib/chatRecordMerge'
import {
  buildTranscriptTailUpdate,
  type TranscriptTailFrame
} from '../../../shared/transcriptTailStream'
import {
  getTranscriptStallSnapshot,
  resetTranscriptStallStoreForTests
} from '../lib/transcriptStallStore'
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
  let setChatsCalls = 0
  let setCurrentChatCalls = 0
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
      setChatsCalls += 1
      chats = typeof action === 'function' ? action(chats) : action
    },
    setCurrentChat: (action) => {
      setCurrentChatCalls += 1
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
    currentChat: () => currentChat,
    setChatsCallCount: () => setChatsCalls,
    setCurrentChatCallCount: () => setCurrentChatCalls,
    resetPublicationCounts: () => {
      setChatsCalls = 0
      setCurrentChatCalls = 0
    }
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

describe('coalesced paged presentation publication', () => {
  let invalidationHandler: ((value: ChatUpdateInvalidation) => void) | null

  beforeEach(() => {
    invalidationHandler = null
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function pagedBridge(
    fetch: (request: TranscriptPageRequest) => TranscriptPage | null
  ): ChatUpdateInterestBridge {
    return {
      onChatUpdateInvalidated: (handler) => {
        invalidationHandler = handler
        return () => undefined
      },
      setChatUpdateInterests: () => undefined,
      getChatTranscriptPage: async (request) => fetch(request)
    }
  }

  /** Shell whose chrome stays byte-identical across revisions unless overridden. */
  function stableShell(
    chatId: string,
    revision: number,
    overrides: Partial<ChatShell> = {}
  ): ChatShell {
    return {
      ...summary(chatId, 2_000),
      runsSummary: [{ runId: `${chatId}-run-1`, provider: 'codex', diffFileCount: 0 }],
      updatedAt: revision,
      persistenceRevision: revision,
      transcriptPaged: true,
      ...overrides
    } as ChatShell
  }

  function stablePage(
    chatId: string,
    revision: number,
    overrides?: Partial<ChatShell>
  ): TranscriptPage {
    return { ...page(chatId, revision), shell: stableShell(chatId, revision, overrides) }
  }

  async function settleDebouncedFetch(): Promise<void> {
    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()
  }

  it('coalesces a paged burst across chats into one publication while refs stay current', async () => {
    const ids = ['alpha', 'beta', 'gamma']
    const initialPages = ids.map((chatId) => stablePage(chatId, 2))
    const shells = initialPages.map((initialPage) => initialPage.shell!)
    const harness = stateHarness([...shells], shells[0])
    for (const initialPage of initialPages) {
      harness.hydrationRuntime.transcriptStore.ingestPage(initialPage)
    }
    const runtime = new ChatUpdateInterestRuntime(
      pagedBridge((request) =>
        stablePage(request.chatId, 5, {
          runsSummary: [
            {
              runId: `${request.chatId}-run-1`,
              provider: 'codex',
              diffFileCount: 0,
              endedAt: '2026-09-05T00:00:00.000Z'
            }
          ]
        })
      ),
      harness.getState
    )
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot(ids.map((chatId) => ({ chatId, mode: 'paged' as const })))
    )
    runtime.start()
    harness.resetPublicationCounts()

    for (const chatId of ids) {
      invalidationHandler!(buildChatUpdateInvalidation(summary(chatId, 2_000))!)
    }
    await settleDebouncedFetch()

    // Canonical refs and the transcript store are byte-exact current immediately…
    for (const chatId of ids) {
      expect((harness.chatByIdRef.current.get(chatId) as ChatShell).persistenceRevision).toBe(5)
      expect(harness.hydrationRuntime.transcriptStore.get(chatId)?.messages[0]?.id).toBe(
        `${chatId}-tail`
      )
    }
    // …while presentation publishes once for the whole burst, not once per page.
    expect(harness.setChatsCallCount()).toBe(0)
    expect(harness.setCurrentChatCallCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(16)
    expect(harness.setChatsCallCount()).toBe(1)
    expect(harness.setCurrentChatCallCount()).toBe(1)
    expect(harness.chats()).toHaveLength(3)
    for (const chatId of ids) {
      const published = harness.chats().find((chat) => chat.appChatId === chatId) as ChatShell
      expect(published.persistenceRevision).toBe(5)
      expect(published.runsSummary?.[0]?.endedAt).toBe('2026-09-05T00:00:00.000Z')
    }
    expect((harness.currentChat() as ChatShell).persistenceRevision).toBe(5)
  })

  it('retains list and current identity on volatile-only churn yet publishes real changes', async () => {
    const first = stablePage('large', 3)
    const initialChats = [first.shell!]
    const harness = stateHarness(initialChats, first.shell!)
    harness.hydrationRuntime.transcriptStore.ingestPage(first)
    let nextShell = (): TranscriptPage => stablePage('large', 4)
    const runtime = new ChatUpdateInterestRuntime(
      pagedBridge(() => nextShell()),
      harness.getState
    )
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot([{ chatId: 'large', mode: 'paged' }])
    )
    runtime.start()
    harness.resetPublicationCounts()

    // Cycle 1: only updatedAt/persistenceRevision change (fresh IPC objects).
    invalidationHandler!(buildChatUpdateInvalidation(summary('large', 2_000))!)
    await settleDebouncedFetch()
    await vi.advanceTimersByTimeAsync(16)
    expect(harness.setChatsCallCount()).toBe(1)
    // Canonical ref advanced; React identity retained for unchanged chrome.
    expect((harness.chatByIdRef.current.get('large') as ChatShell).persistenceRevision).toBe(4)
    expect(harness.chats()).toBe(initialChats)
    expect(harness.chats()[0]).toBe(first.shell)
    expect(harness.currentChat()).toBe(first.shell)

    // Cycle 2: run status flips — chrome must publish a fresh identity.
    nextShell = () =>
      stablePage('large', 5, {
        runsSummary: [
          {
            runId: 'large-run-1',
            provider: 'codex',
            diffFileCount: 0,
            endedAt: '2026-09-05T00:00:00.000Z'
          }
        ]
      })
    invalidationHandler!(buildChatUpdateInvalidation(summary('large', 2_000))!)
    await settleDebouncedFetch()
    await vi.advanceTimersByTimeAsync(16)
    const afterStatus = harness.chats()[0] as ChatShell
    expect(afterStatus).not.toBe(first.shell)
    expect(afterStatus.persistenceRevision).toBe(5)
    expect(afterStatus.runsSummary?.[0]?.endedAt).toBe('2026-09-05T00:00:00.000Z')
    expect((harness.currentChat() as ChatShell).persistenceRevision).toBe(5)

    // Cycle 3: an ensemble queue appears — queue changes must publish too.
    nextShell = () =>
      stablePage('large', 6, {
        runsSummary: [
          {
            runId: 'large-run-1',
            provider: 'codex',
            diffFileCount: 0,
            endedAt: '2026-09-05T00:00:00.000Z'
          }
        ],
        chatKind: 'ensemble',
        ensemble: {
          participants: [],
          activeRound: { roundId: 'round-1', status: 'running', queuedPrompts: ['queued later'] }
        } as unknown as ChatRecord['ensemble']
      } as Partial<ChatShell>)
    invalidationHandler!(buildChatUpdateInvalidation(summary('large', 2_000))!)
    await settleDebouncedFetch()
    await vi.advanceTimersByTimeAsync(16)
    const afterQueue = harness.chats()[0] as ChatRecord
    expect(afterQueue).not.toBe(afterStatus)
    expect(afterQueue.ensemble?.activeRound?.queuedPrompts).toEqual(['queued later'])
  })

  it('does not resurrect a chat deleted between commit and presentation flush', async () => {
    const first = stablePage('doomed', 3)
    const harness = stateHarness([first.shell!], first.shell!)
    harness.hydrationRuntime.transcriptStore.ingestPage(first)
    const runtime = new ChatUpdateInterestRuntime(
      pagedBridge(() =>
        stablePage('doomed', 4, {
          runsSummary: [
            {
              runId: 'doomed-run-1',
              provider: 'codex',
              diffFileCount: 0,
              endedAt: '2026-09-05T00:00:00.000Z'
            }
          ]
        })
      ),
      harness.getState
    )
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot([{ chatId: 'doomed', mode: 'paged' }])
    )
    runtime.start()

    invalidationHandler!(buildChatUpdateInvalidation(summary('doomed', 2_000))!)
    await settleDebouncedFetch()
    // Simulate App's deletion path landing between commit and flush.
    harness.chatByIdRef.current.delete('doomed')
    harness.getState().setChats(() => [])
    harness.getState().setCurrentChat(() => null)
    harness.resetPublicationCounts()

    await vi.advanceTimersByTimeAsync(200)
    expect(harness.chats()).toEqual([])
    expect(harness.currentChat()).toBeNull()
  })

  it('publishes pending presentation exactly once on stop and leaves no armed timers', async () => {
    const first = stablePage('large', 3)
    const harness = stateHarness([first.shell!], first.shell!)
    harness.hydrationRuntime.transcriptStore.ingestPage(first)
    const runtime = new ChatUpdateInterestRuntime(
      pagedBridge(() =>
        stablePage('large', 4, {
          runsSummary: [
            {
              runId: 'large-run-1',
              provider: 'codex',
              diffFileCount: 0,
              endedAt: '2026-09-05T00:00:00.000Z'
            }
          ]
        })
      ),
      harness.getState
    )
    runtime.setPendingSnapshot(
      createChatUpdateInterestSnapshot([{ chatId: 'large', mode: 'paged' }])
    )
    runtime.start()

    invalidationHandler!(buildChatUpdateInvalidation(summary('large', 2_000))!)
    await settleDebouncedFetch()
    harness.resetPublicationCounts()

    runtime.stop()
    expect(harness.setChatsCallCount()).toBe(1)
    expect((harness.chats()[0] as ChatShell).persistenceRevision).toBe(4)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.setChatsCallCount()).toBe(1)
    expect(harness.setCurrentChatCallCount()).toBe(1)
  })

  it('coalesces background summary invalidations while refs project immediately', async () => {
    const a = fullChat('bg-a', 4)
    const b = fullChat('bg-b', 4)
    const harness = stateHarness([a, b])
    const runtime = new ChatUpdateInterestRuntime(
      pagedBridge(() => null),
      harness.getState
    )
    runtime.start()
    harness.resetPublicationCounts()

    invalidationHandler!(buildChatUpdateInvalidation(summary('bg-a', 5))!)
    invalidationHandler!(buildChatUpdateInvalidation(summary('bg-b', 5))!)

    // Canonical refs hold lean projections immediately…
    expect(isChatSummaryRecord(harness.chatByIdRef.current.get('bg-a'))).toBe(true)
    expect(isChatSummaryRecord(harness.chatByIdRef.current.get('bg-b'))).toBe(true)
    // …and the burst publishes once, not once per summary.
    expect(harness.setChatsCallCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(16)
    expect(harness.setChatsCallCount()).toBe(1)
    expect(harness.chats()).toHaveLength(2)
    expect(harness.chats().every((chat) => isChatSummaryRecord(chat))).toBe(true)
  })
})

describe('ChatUpdateInterestRuntime — tail-lane recency guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTranscriptStallStoreForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function tailUpdate(
    chatId: string,
    sequence: number,
    index: number,
    row: ChatMessage,
    messageCount: number
  ) {
    const frame = buildTranscriptTailUpdate({
      chatId,
      sequence,
      messageCount,
      rows: [{ index, message: row }],
      appendedAtMs: 1
    })
    if (!frame) throw new Error('fixture built an invalid update frame')
    return frame
  }

  /** A runtime over one paged chat, wired to the pushed tail lane. */
  function tailRuntime(chatId: string, revision = 2_000) {
    const initialPage = page(chatId, revision)
    const shell = initialPage.shell!
    const harness = stateHarness([shell], shell)
    harness.hydrationRuntime.transcriptStore.ingestPage(initialPage)
    let tailHandler: ((frame: TranscriptTailFrame) => void) | null = null
    const receipts: number[] = []
    const bridge: ChatUpdateInterestBridge = {
      onChatUpdateInvalidated: () => () => undefined,
      setChatUpdateInterests: () => undefined,
      getChatTranscriptPage: async () => null,
      onTranscriptTailAppended: (handler) => {
        tailHandler = handler
        return () => undefined
      },
      reportTranscriptTailCommitted: (_chatId, sequence) => {
        receipts.push(sequence)
      }
    }
    const runtime = new ChatUpdateInterestRuntime(bridge, harness.getState)
    runtime.setPendingSnapshot(createChatUpdateInterestSnapshot([{ chatId, mode: 'paged' }]))
    runtime.start()
    const deliver = (frame: TranscriptTailFrame): void => {
      if (!tailHandler) throw new Error('tail lane not subscribed')
      tailHandler(frame)
    }
    return { harness, runtime, receipts, deliver }
  }

  it('refuses a regressed update instead of truncating the visible row — and says so', () => {
    const chatId = 'large'
    const { harness, runtime, receipts, deliver } = tailRuntime(chatId)
    const store = harness.hydrationRuntime.transcriptStore
    const row = store.get(chatId)!.messages[0]

    const streamed = { ...row, content: 'bounded tail and then the stream kept going' }
    deliver(tailUpdate(chatId, 1, 1_999, streamed, 2_000))
    expect(store.get(chatId)?.messages[0]).toBe(streamed)
    expect(receipts).toEqual([1])

    // The canonical record regresses and the producer re-ships the row as it
    // was mid-stream. The visible row must NOT follow it down.
    const regressed = { ...row, content: 'bounded' }
    deliver(tailUpdate(chatId, 2, 1_999, regressed, 2_000))
    expect(store.get(chatId)?.messages[0]).toBe(streamed)
    expect(receipts).toEqual([1])

    // The refusal is visible, not silent: announced is ahead of settled…
    expect(runtime.stallStatus(chatId, Date.now())).toMatchObject({
      announcedSequence: 2,
      settledSequence: 1
    })
    // …and once the gap has stood long enough, the published surface says so.
    vi.advanceTimersByTime(2_000)
    expect(getTranscriptStallSnapshot(chatId).level).toBe('catching-up')

    // The record recovers; streaming resumes on the same lane.
    const recovered = { ...row, content: 'bounded tail and then the stream kept going, done' }
    deliver(tailUpdate(chatId, 3, 1_999, recovered, 2_000))
    expect(store.get(chatId)?.messages[0]).toBe(recovered)
    expect(receipts).toEqual([1, 3])
    expect(runtime.stallStatus(chatId, Date.now()).level).toBe('current')
  })

  it('refuses a frame older than the newest already shown, and reports no phantom gap', () => {
    const chatId = 'large'
    const { harness, runtime, receipts, deliver } = tailRuntime(chatId)
    const store = harness.hydrationRuntime.transcriptStore
    const row = store.get(chatId)!.messages[0]

    const streamed = { ...row, content: 'bounded tail, much longer now' }
    deliver(tailUpdate(chatId, 5, 1_999, streamed, 2_000))
    expect(store.get(chatId)?.messages[0]).toBe(streamed)

    // Even a plausible growth is refused when it predates what is on screen.
    const late = { ...row, content: 'bounded tail, much longer now, and more' }
    deliver(tailUpdate(chatId, 2, 1_999, late, 2_000))
    expect(store.get(chatId)?.messages[0]).toBe(streamed)
    expect(receipts).toEqual([5])
    // Announcing an older sequence than the settled one opens no gap.
    expect(runtime.stallStatus(chatId, Date.now())).toMatchObject({
      announcedSequence: 5,
      settledSequence: 5,
      level: 'current'
    })
  })

  it('forgets the lane watermark when the chat leaves paged mode, so a restart cannot wedge', () => {
    const chatId = 'large'
    const { harness, runtime, receipts, deliver } = tailRuntime(chatId)
    const store = harness.hydrationRuntime.transcriptStore
    const row = store.get(chatId)!.messages[0]

    const streamed = { ...row, content: 'bounded tail, streamed much further' }
    deliver(tailUpdate(chatId, 50, 1_999, streamed, 2_000))
    expect(receipts).toEqual([50])

    // The chat leaves paged mode (switched away)…
    runtime.setPendingSnapshot(createChatUpdateInterestSnapshot([]))
    runtime.publishPending()
    // …and returns. A producer that restarted and re-sequenced from 1 must
    // not be refused behind the old 50.
    runtime.setPendingSnapshot(createChatUpdateInterestSnapshot([{ chatId, mode: 'paged' }]))
    runtime.publishPending()
    const resumed = { ...row, content: 'bounded tail, streamed much further still' }
    deliver(tailUpdate(chatId, 1, 1_999, resumed, 2_000))
    expect(store.get(chatId)?.messages[0]).toBe(resumed)
    expect(receipts).toEqual([50, 1])
  })
})
