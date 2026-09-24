import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createThreadTitleRepairRunner,
  MAX_THREAD_TITLE_REPAIR_SLICES_PER_PROCESS,
  threadTitleRepairModeFromEnv,
  THREAD_TITLE_REPAIR_INITIAL_DELAY_MS,
  THREAD_TITLE_REPAIR_PERSIST_BARRIER_TIMEOUT_MS,
  type ThreadTitleRepairRunnerDeps
} from './ThreadTitleRepairRunner'
import { parseThreadTitleRepairState } from './store/ThreadTitleRepair'
import type { ChatListItem, ChatMessage, ChatRecord } from './store/types'

const STATE_PATH = '/profile/thread-title-repair.json'

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    content: 'Explain the persistence barrier',
    timestamp: '2026-08-29T00:00:00.000Z',
    ...overrides
  } as ChatMessage
}

function record(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'New Chat',
    messages: [message()],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    workspaceId: 'workspace-1',
    ...overrides
  } as unknown as ChatRecord
}

function item(overrides: Partial<ChatListItem> = {}): ChatListItem {
  return {
    appChatId: 'chat-1',
    title: 'New Chat',
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: 3,
    runCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  } as unknown as ChatListItem
}

interface Harness {
  deps: ThreadTitleRepairRunnerDeps
  files: Map<string, string>
  scheduled: Array<{ run: () => void; delayMs: number }>
  listChats: ReturnType<typeof vi.fn>
  saveChat: ReturnType<typeof vi.fn>
  getChat: ReturnType<typeof vi.fn>
  broadcastChatUpdated: ReturnType<typeof vi.fn>
  broadcastThreadUpdate: ReturnType<typeof vi.fn>
  pushRemoteTaskCardDelta: ReturnType<typeof vi.fn>
  order: string[]
  state: () => ReturnType<typeof parseThreadTitleRepairState>
}

function harness(overrides: Partial<ThreadTitleRepairRunnerDeps> = {}): Harness {
  const files = new Map<string, string>()
  const scheduled: Array<{ run: () => void; delayMs: number }> = []
  const order: string[] = []
  const records = new Map<string, ChatRecord>([['chat-1', record()]])
  const listChats = vi.fn(overrides.listChats ?? (() => [item()]))

  const getChat = vi.fn((chatId: string) => {
    order.push(`getChat:${chatId}`)
    return records.get(chatId) ?? null
  })
  const saveChat = vi.fn((chat: ChatRecord) => {
    order.push(`saveChat:${chat.appChatId}`)
    records.set(chat.appChatId, chat)
    return chat
  })
  const broadcastChatUpdated = vi.fn()
  const broadcastThreadUpdate = vi.fn()
  const pushRemoteTaskCardDelta = vi.fn()

  const deps: ThreadTitleRepairRunnerDeps = {
    statePath: STATE_PATH,
    getChat,
    saveChat,
    awaitChatRecordPersisted: async (chatId: string) => {
      order.push(`persist:${chatId}`)
    },
    isChatBusy: () => false,
    broadcastChatUpdated,
    broadcastThreadUpdate,
    pushRemoteTaskCardDelta,
    readStateFile: (path) => files.get(path) ?? null,
    writeStateFile: (path, contents) => {
      files.set(path, contents)
    },
    now: () => 1_000,
    schedule: (run, delayMs) => {
      scheduled.push({ run, delayMs })
    },
    log: () => {},
    onError: () => {},
    ...overrides,
    // Always retain the probe even when a test supplies its own source.
    listChats
  }

  return {
    deps,
    files,
    scheduled,
    listChats,
    saveChat,
    getChat,
    broadcastChatUpdated,
    broadcastThreadUpdate,
    pushRemoteTaskCardDelta,
    order,
    state: () => parseThreadTitleRepairState(JSON.parse(files.get(STATE_PATH) ?? '{}'))
  }
}

describe('thread title repair runner', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('derives a title and rewrites nothing else on the record', async () => {
    const h = harness()
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.saveChat).toHaveBeenCalledTimes(1)
    const saved = h.saveChat.mock.calls[0][0] as ChatRecord
    expect(saved.title).toBe('Explain the persistence barrier')
    // Everything but the title must be byte-identical to the record that was
    // read microseconds earlier — a batched snapshot would carry stale
    // messages back over a concurrent append.
    const { title: _savedTitle, ...savedRest } = saved
    const { title: _sourceTitle, ...sourceRest } = record()
    expect(savedRest).toEqual(sourceRest)
    consoleError.mockRestore()
  })

  it('reads each record late, immediately before its own write', async () => {
    const h = harness({
      listChats: () => [item({ appChatId: 'chat-1' }), item({ appChatId: 'chat-2' })],
      getChat: vi.fn((chatId: string) => record({ appChatId: chatId }))
    })
    // Re-wire the ordering probe around the overridden getChat.
    const reads: string[] = []
    const inner = h.deps.getChat
    h.deps.getChat = (chatId: string) => {
      reads.push(`getChat:${chatId}`)
      return inner(chatId)
    }
    const saves: string[] = []
    const innerSave = h.deps.saveChat
    h.deps.saveChat = (chat: ChatRecord) => {
      saves.push(`saveChat:${chat.appChatId}`)
      return innerSave(chat)
    }

    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(reads).toEqual(['getChat:chat-1', 'getChat:chat-2'])
    expect(saves).toEqual(['saveChat:chat-1', 'saveChat:chat-2'])
    consoleError.mockRestore()
  })

  it('skips a record whose title stopped being a placeholder before the write', async () => {
    const h = harness({
      listChats: () => [item({ appChatId: 'renamed' }), item({ appChatId: 'still-placeholder' })],
      getChat: (chatId: string) =>
        record({
          appChatId: chatId,
          title: chatId === 'renamed' ? 'A title the user typed' : 'New Chat'
        })
    })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    // Positive first: a bare "not called with renamed" would pass over an
    // empty call list.
    expect(h.saveChat).toHaveBeenCalledTimes(1)
    expect((h.saveChat.mock.calls[0][0] as ChatRecord).appChatId).toBe('still-placeholder')
    consoleError.mockRestore()
  })

  it('defers a busy chat without counting it as a failure', async () => {
    const h = harness({ isChatBusy: (chatId: string) => chatId === 'chat-1' })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.saveChat).not.toHaveBeenCalled()
    expect(h.state().failures).toEqual({})
    consoleError.mockRestore()
  })

  it('repairs a thread carrying months-old ensemble round residue', async () => {
    // 14 of 28 real candidates carry a persisted activeRound on records last
    // written weeks ago. Gating on the record instead of the live run manager
    // would refuse every one of them.
    const h = harness({
      getChat: () =>
        record({
          ensemble: { activeRound: { id: 'round-1' } },
          runs: [{ id: 'run-1', status: 'running' }]
        } as unknown as Partial<ChatRecord>),
      isChatBusy: () => false
    })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.saveChat).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('never writes a title it could not derive', async () => {
    // An attachment-only first prompt reaches disk with empty content. Deriving
    // from it would write an empty title, which no rename could restore.
    const h = harness({
      getChat: () => record({ messages: [message({ content: '   ' })] })
    })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.saveChat).not.toHaveBeenCalled()
    expect(h.state().entries).toHaveLength(0)
    // Counted as a failure so it quarantines instead of being re-read forever.
    expect(h.state().failures['chat-1']).toBe(1)
    consoleError.mockRestore()
  })

  it('broadcasts to every surface, because nothing watches the chat directory', async () => {
    const h = harness()
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.broadcastChatUpdated).toHaveBeenCalledTimes(1)
    expect(h.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1')
    expect(h.pushRemoteTaskCardDelta).toHaveBeenCalledWith('chat-1')
    consoleError.mockRestore()
  })

  it('awaits the persistence barrier before claiming or broadcasting a repair', async () => {
    let confirmPersist!: () => void
    const h = harness({
      awaitChatRecordPersisted: () =>
        new Promise<void>((resolve) => {
          confirmPersist = resolve
        })
    })
    const draining = createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.order).toEqual(['getChat:chat-1', 'saveChat:chat-1'])
    expect(h.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(h.broadcastThreadUpdate).not.toHaveBeenCalled()
    expect(h.pushRemoteTaskCardDelta).not.toHaveBeenCalled()
    expect(h.state().entries).toHaveLength(0)

    confirmPersist()
    await draining

    expect(h.broadcastChatUpdated).toHaveBeenCalledTimes(1)
    expect(h.broadcastThreadUpdate).toHaveBeenCalledWith('chat-1')
    expect(h.pushRemoteTaskCardDelta).toHaveBeenCalledWith('chat-1')
    expect(h.state().entries).toHaveLength(1)
    consoleError.mockRestore()
  })

  it('stands down after a rejected persistence barrier without claiming success', async () => {
    const listChats = () => [item({ appChatId: 'chat-1' }), item({ appChatId: 'chat-2' })]
    const onError = vi.fn()
    const h = harness({
      listChats,
      getChat: (chatId: string) => record({ appChatId: chatId }),
      awaitChatRecordPersisted: async () => {
        throw new Error('Host unavailable')
      },
      onError
    })
    const runner = createThreadTitleRepairRunner(h.deps)

    await runner.drainNow()

    expect(h.listChats).toHaveBeenCalledTimes(1)
    expect(h.saveChat).toHaveBeenCalledTimes(1)
    expect((h.saveChat.mock.calls[0][0] as ChatRecord).appChatId).toBe('chat-1')
    expect(h.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(h.broadcastThreadUpdate).not.toHaveBeenCalled()
    expect(h.pushRemoteTaskCardDelta).not.toHaveBeenCalled()
    expect(h.state().repaired).toBe(0)
    expect(h.state().entries).toHaveLength(0)
    expect(h.state().failures).toEqual({})
    expect(h.scheduled).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('standing down without recording the repair'),
      expect.any(Error)
    )

    // Persistence availability is process-wide. A direct retry in the same
    // session must not rediscover the corpus and start the 12-slice storm.
    await runner.drainNow()
    expect(h.listChats).toHaveBeenCalledTimes(1)
    expect(h.saveChat).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('stands down after a persistence timeout and handles a late rejection', async () => {
    vi.useFakeTimers()
    let rejectPersist!: (error: Error) => void
    const onError = vi.fn()
    const h = harness({
      awaitChatRecordPersisted: () =>
        new Promise<void>((_resolve, reject) => {
          rejectPersist = reject
        }),
      onError
    })
    const runner = createThreadTitleRepairRunner(h.deps)
    const draining = runner.drainNow()

    await vi.advanceTimersByTimeAsync(THREAD_TITLE_REPAIR_PERSIST_BARRIER_TIMEOUT_MS)
    await draining

    expect(h.listChats).toHaveBeenCalledTimes(1)
    expect(h.saveChat).toHaveBeenCalledTimes(1)
    expect(h.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(h.broadcastThreadUpdate).not.toHaveBeenCalled()
    expect(h.pushRemoteTaskCardDelta).not.toHaveBeenCalled()
    expect(h.state().repaired).toBe(0)
    expect(h.state().entries).toHaveLength(0)
    expect(h.state().failures).toEqual({})
    expect(h.scheduled).toHaveLength(0)
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('did not confirm'),
      expect.any(Error)
    )

    // The losing branch remains handled after the race, so a late Host failure
    // is diagnostic rather than an unhandled rejection.
    rejectPersist(new Error('late Host failure'))
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining('Host record persist failed'),
      expect.any(Error)
    )

    await runner.drainNow()
    expect(h.listChats).toHaveBeenCalledTimes(1)
    expect(h.saveChat).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('treats a silently refused save as a failure rather than a repair', async () => {
    // saveChat returns the current record unchanged on a workspace or revision
    // mismatch, so a returned record is not proof that anything was written.
    const h = harness({ saveChat: vi.fn((chat: ChatRecord) => ({ ...chat, title: 'New Chat' })) })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.broadcastChatUpdated).not.toHaveBeenCalled()
    expect(h.state().failures['chat-1']).toBe(1)
    expect(h.state().entries).toHaveLength(0)
    consoleError.mockRestore()
  })

  it('contains a throwing save and keeps repairing the rest of the slice', async () => {
    const saveChat = vi.fn((chat: ChatRecord) => {
      if (chat.appChatId === 'poison') throw new Error('workspace is not registered')
      return chat
    })
    const h = harness({
      listChats: () => [item({ appChatId: 'poison' }), item({ appChatId: 'healthy' })],
      getChat: (chatId: string) => record({ appChatId: chatId }),
      saveChat
    })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(saveChat).toHaveBeenCalledTimes(2)
    expect(h.state().failures['poison']).toBe(1)
    expect(h.state().entries.map((entry) => entry.chatId)).toEqual(['healthy'])
    consoleError.mockRestore()
  })

  it('records the overwritten placeholder so a wrong title can be undone by hand', async () => {
    const h = harness()
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.state().entries).toEqual([
      {
        chatId: 'chat-1',
        previousTitle: 'New Chat',
        derivedTitle: 'Explain the persistence barrier',
        at: 1_000
      }
    ])
    expect(h.state().repaired).toBe(1)
    consoleError.mockRestore()
  })

  it('stamps the attempt before any write and stands down if it does not persist', async () => {
    const h = harness({ writeStateFile: () => {} })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.saveChat).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('arms the deferred drain at most once per process', async () => {
    const h = harness()
    const runner = createThreadTitleRepairRunner(h.deps)
    runner.observe()
    runner.observe()
    runner.observe()

    expect(h.scheduled).toHaveLength(1)
    expect(h.scheduled[0].delayMs).toBe(THREAD_TITLE_REPAIR_INITIAL_DELAY_MS)
    consoleError.mockRestore()
  })

  it('joins an in-flight drain instead of starting a second one', async () => {
    // getChat must keep returning the unrepaired record, so a second drain
    // entering while the first is awaiting its persistence barrier would
    // genuinely re-select and re-save the same chat. A harness that served the
    // saved record back would hide a missing join behind its own bookkeeping.
    const h = harness({
      getChat: () => record(),
      awaitChatRecordPersisted: () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    })
    const runner = createThreadTitleRepairRunner(h.deps)
    await Promise.all([runner.drainNow(), runner.drainNow()])

    expect(h.saveChat).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('re-arms while candidates remain and stops once the corpus is clean', async () => {
    let remaining = 3
    const h = harness({
      listChats: () =>
        Array.from({ length: remaining }, (_unused, index) => item({ appChatId: `chat-${index}` })),
      getChat: (chatId: string) => record({ appChatId: chatId }),
      saveChat: vi.fn((chat: ChatRecord) => {
        remaining = 0
        return chat
      })
    })
    const runner = createThreadTitleRepairRunner(h.deps)
    await runner.drainNow()

    // The slice cleared the corpus, so no follow-up slice is scheduled.
    expect(h.listChats).toHaveBeenCalledTimes(1)
    expect(h.scheduled).toHaveLength(0)
    consoleError.mockRestore()
  })

  it('schedules a follow-up slice when candidates outlast the slice bound', async () => {
    const h = harness({
      listChats: () =>
        Array.from({ length: 20 }, (_unused, index) => item({ appChatId: `chat-${index}` })),
      getChat: (chatId: string) => record({ appChatId: chatId })
    })
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.listChats).toHaveBeenCalledTimes(1)
    expect(h.saveChat).toHaveBeenCalledTimes(8)
    expect(h.scheduled).toHaveLength(1)
    consoleError.mockRestore()
  })

  it('uses one list snapshot per slice and advances past completed rows', async () => {
    const h = harness({
      listChats: () =>
        Array.from({ length: 20 }, (_unused, index) => item({ appChatId: `chat-${index}` })),
      // Deliberately keep returning a placeholder. The session completion set,
      // not this harness's optimistic cache, must advance the second slice.
      getChat: (chatId: string) => record({ appChatId: chatId })
    })
    const runner = createThreadTitleRepairRunner(h.deps)

    await runner.drainNow()
    await runner.drainNow()

    expect(h.listChats).toHaveBeenCalledTimes(2)
    const savedIds = h.saveChat.mock.calls.map(([chat]) => (chat as ChatRecord).appChatId)
    expect(savedIds).toEqual(Array.from({ length: 16 }, (_unused, index) => `chat-${index}`))
    expect(new Set(savedIds).size).toBe(16)
    consoleError.mockRestore()
  })

  it('stops re-arming after the per-process slice ceiling', async () => {
    const h = harness({
      // A permanently busy corpus never drains, so only the ceiling can stop it.
      listChats: () =>
        Array.from({ length: 20 }, (_unused, index) => item({ appChatId: `chat-${index}` })),
      getChat: (chatId: string) => record({ appChatId: chatId }),
      isChatBusy: () => true
    })
    const runner = createThreadTitleRepairRunner(h.deps)
    for (let slice = 0; slice < MAX_THREAD_TITLE_REPAIR_SLICES_PER_PROCESS + 2; slice += 1) {
      await runner.drainNow()
    }

    expect(h.scheduled).toHaveLength(MAX_THREAD_TITLE_REPAIR_SLICES_PER_PROCESS - 1)
    consoleError.mockRestore()
  })

  it('keeps quarantining a chat that fails, then stops selecting it', async () => {
    const h = harness({ saveChat: vi.fn((chat: ChatRecord) => ({ ...chat, title: 'New Chat' })) })
    const runner = createThreadTitleRepairRunner(h.deps)
    await runner.drainNow()
    await runner.drainNow()
    await runner.drainNow()
    expect(h.state().failures['chat-1']).toBe(3)

    h.saveChat.mockClear()
    await runner.drainNow()
    expect(h.saveChat).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('writes nothing in dry mode and does not arm at all when off', async () => {
    const dry = harness({ mode: 'dry' })
    await createThreadTitleRepairRunner(dry.deps).drainNow()
    expect(dry.saveChat).not.toHaveBeenCalled()
    expect(dry.broadcastChatUpdated).not.toHaveBeenCalled()

    const off = harness({ mode: 'off' })
    const runner = createThreadTitleRepairRunner(off.deps)
    runner.observe()
    await runner.drainNow()
    expect(off.scheduled).toHaveLength(0)
    expect(off.saveChat).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('stops applying rather than evicting the oldest ledger entry', async () => {
    const h = harness()
    h.files.set(
      STATE_PATH,
      JSON.stringify({
        version: 1,
        attempts: 1,
        repaired: 500,
        lastDrainAt: 1,
        failures: {},
        entries: Array.from({ length: 500 }, (_unused, index) => ({
          chatId: `old-${index}`,
          previousTitle: 'New Chat',
          derivedTitle: `title ${index}`,
          at: index
        }))
      })
    )
    await createThreadTitleRepairRunner(h.deps).drainNow()

    expect(h.saveChat).not.toHaveBeenCalled()
    expect(h.state().entries[0].chatId).toBe('old-0')
    consoleError.mockRestore()
  })
})

describe('thread title repair mode', () => {
  it('reads the kill switch from the environment', () => {
    expect(threadTitleRepairModeFromEnv(undefined)).toBe('apply')
    expect(threadTitleRepairModeFromEnv('')).toBe('apply')
    expect(threadTitleRepairModeFromEnv('off')).toBe('off')
    expect(threadTitleRepairModeFromEnv('0')).toBe('off')
    expect(threadTitleRepairModeFromEnv(' DRY ')).toBe('dry')
  })
})
