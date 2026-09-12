import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatListItem, ChatMessage } from '../../../main/store/types'
import { buildChatUpdateInvalidation } from '../../../shared/chatUpdateInterest'
import type { TranscriptPage, TranscriptPageRequest } from '../../../shared/transcriptPage'
import {
  MAX_LIVE_TAIL_PAGE_BYTES,
  MAX_LIVE_TAIL_PAGE_MESSAGES,
  PagedChatUpdateRefreshCoordinator,
  type PagedChatUpdateRefreshCommit
} from './PagedChatUpdateRefreshCoordinator'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function summary(chatId: string, revision: number): ChatListItem {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: `revision-${revision}`,
    archived: false,
    createdAt: 1,
    updatedAt: revision,
    persistenceRevision: revision,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: revision,
    runCount: 0
  } as ChatListItem
}

function invalidation(chatId: string, revision: number) {
  return buildChatUpdateInvalidation(summary(chatId, revision))!
}

function page(chatId: string, revision: number): TranscriptPage {
  const message = {
    id: `message-${revision}`,
    role: 'assistant',
    content: `revision-${revision}`,
    timestamp: '2026-09-04T00:00:00.000Z'
  } as ChatMessage
  return {
    chatId,
    messages: [message],
    runs: [],
    totalMessageCount: revision,
    windowStart: Math.max(0, revision - 1),
    windowEnd: revision,
    estimatedBytes: 100,
    hasOlder: revision > 1,
    hasNewer: false,
    oldestMessageId: message.id,
    newestMessageId: message.id,
    updatedAt: revision
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('PagedChatUpdateRefreshCoordinator', () => {
  it('debounces replacements, fetches a bounded tail and commits only the latest invalidation', async () => {
    const requests: TranscriptPageRequest[] = []
    const commits: PagedChatUpdateRefreshCommit[] = []
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 25,
      maxMessages: 50_000,
      maxBytes: 100 * 1024 * 1024,
      fetchPage: async (request) => {
        requests.push(request)
        return page(request.chatId, 2)
      },
      commit: (value) => commits.push(value)
    })

    expect(coordinator.invalidate(invalidation('chat-a', 1))).toBe(1)
    expect(coordinator.invalidate(invalidation('chat-a', 2))).toBe(2)
    await vi.advanceTimersByTimeAsync(24)
    expect(requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await flushMicrotasks()

    expect(requests).toEqual([
      {
        chatId: 'chat-a',
        maxMessages: MAX_LIVE_TAIL_PAGE_MESSAGES,
        maxBytes: MAX_LIVE_TAIL_PAGE_BYTES
      }
    ])
    expect(commits).toHaveLength(1)
    expect(commits[0].invalidation.revision).toBe(2)
    expect(commits[0].generation).toBe(2)
  })

  it('single-flights by chat, drops a stale page and retries once with the newest generation', async () => {
    const first = deferred<TranscriptPage | null>()
    const second = deferred<TranscriptPage | null>()
    const fetchPage = vi
      .fn<(request: TranscriptPageRequest) => Promise<TranscriptPage | null>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchPage,
      commit
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchPage).toHaveBeenCalledTimes(1)

    coordinator.invalidate(invalidation('chat-a', 2))
    expect(fetchPage).toHaveBeenCalledTimes(1)
    first.resolve(page('chat-a', 1))
    await flushMicrotasks()

    expect(commit).not.toHaveBeenCalled()
    expect(fetchPage).toHaveBeenCalledTimes(2)
    second.resolve(page('chat-a', 2))
    await flushMicrotasks()

    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0][0]).toMatchObject({
      generation: 2,
      invalidation: { chatId: 'chat-a', revision: 2 }
    })
  })

  it('returns to debounce when the one immediate retry is itself invalidated', async () => {
    const flights = [
      deferred<TranscriptPage | null>(),
      deferred<TranscriptPage | null>(),
      deferred<TranscriptPage | null>()
    ]
    const fetchPage = vi.fn((_request: TranscriptPageRequest) => {
      const flight = flights[fetchPage.mock.calls.length - 1]
      return flight.promise
    })
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchPage,
      commit
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    coordinator.invalidate(invalidation('chat-a', 2))
    flights[0].resolve(page('chat-a', 1))
    await flushMicrotasks()
    expect(fetchPage).toHaveBeenCalledTimes(2)

    coordinator.invalidate(invalidation('chat-a', 3))
    flights[1].resolve(page('chat-a', 2))
    await flushMicrotasks()
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(commit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    flights[2].resolve(page('chat-a', 3))
    await flushMicrotasks()
    expect(commit.mock.calls[0][0].invalidation.revision).toBe(3)
  })

  it('logically cancels in-flight work and clears all scheduled work on dispose', async () => {
    const flight = deferred<TranscriptPage | null>()
    const fetchPage = vi.fn(() => flight.promise)
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchPage,
      commit
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    expect(coordinator.cancel('chat-a')).toBe(true)
    flight.resolve(page('chat-a', 1))
    await flushMicrotasks()
    expect(commit).not.toHaveBeenCalled()

    coordinator.invalidate(invalidation('chat-b', 1))
    coordinator.dispose()
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(coordinator.invalidate(invalidation('chat-c', 1))).toBeNull()
    expect(coordinator.stats()).toEqual({
      trackedChats: 0,
      inFlight: 0,
      scheduled: 0,
      overdueFetches: 0,
      behind: 0
    })
  })

  it('rejects malformed or mismatched payloads and never commits a cross-chat page', async () => {
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 0,
      fetchPage: async () => page('wrong-chat', 1),
      commit
    })

    expect(coordinator.invalidate({ chatId: 'chat-a' })).toBeNull()
    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(0)
    await flushMicrotasks()
    expect(commit).not.toHaveBeenCalled()
  })

  it('keeps tracked chat ids bounded without evicting active fetch promises', async () => {
    const flight = deferred<TranscriptPage | null>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 0,
      maxTrackedChats: 1,
      fetchPage: () => flight.promise,
      commit: () => undefined
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(0)
    expect(coordinator.invalidate(invalidation('chat-b', 1))).toBeNull()
    expect(coordinator.stats()).toEqual({
      trackedChats: 1,
      inFlight: 1,
      scheduled: 0,
      overdueFetches: 0,
      // The newest invalidation has not been answered by a commit yet.
      behind: 1
    })
    flight.resolve(page('chat-a', 1))
    await flushMicrotasks()
  })

  it('releases the flight slot when a pull overruns its deadline', async () => {
    // The 2026-09-11 shape: main is wedged, the tail pull never settles, and
    // every later invalidation is silently swallowed by the single-flight gate.
    const stuck = deferred<TranscriptPage | null>()
    const fetchPage = vi.fn(() => stuck.promise)
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchDeadlineMs: 1_000,
      fetchPage,
      commit
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    expect(coordinator.stats()).toMatchObject({ inFlight: 1, overdueFetches: 0 })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(coordinator.stats()).toMatchObject({ inFlight: 0, overdueFetches: 1, behind: 1 })

    // A newer invalidation can now be served instead of being dropped forever.
    coordinator.invalidate(invalidation('chat-a', 2))
    await vi.advanceTimersByTimeAsync(10)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('recovers a stalled pull with bounded delayed retries when nothing newer is waiting', async () => {
    const stuck = deferred<TranscriptPage | null>()
    const fetchPage = vi.fn(() => stuck.promise)
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchDeadlineMs: 1_000,
      fetchPage,
      commit: () => {}
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(5_000)
    // No immediate pile-up onto the thread that just missed its deadline: the
    // retry is delayed, so within the first retry window only the original
    // fetch has run.
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(coordinator.stats().overdueFetches).toBe(1)

    // Retry 1 fires one retry-delay after the release, then stalls the same way.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchPage).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(coordinator.stats().overdueFetches).toBe(2)

    // Retry 2 is the last: the cap converts a permanently wedged pull into
    // "waits for the next invalidation" instead of polling forever.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(coordinator.stats().overdueFetches).toBe(3)
  })

  it('commits after a failed pull via the bounded retry, with nothing newer waiting', async () => {
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const fetchPage = vi
      .fn<(request: TranscriptPageRequest) => Promise<TranscriptPage | null>>()
      .mockRejectedValueOnce(new Error('Timed out connecting to the TaskWraith Host'))
      .mockResolvedValueOnce(page('chat-a', 1))
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchDeadlineMs: 1_000,
      fetchPage,
      commit
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    await flushMicrotasks()
    // The connect failure settles fast: slot released, nothing committed, and
    // no newer invalidation exists to re-arm the chat — the coordinator's own
    // retry is the only recovery signal. This is the regression guard for the
    // mirror equality gate: without this retry the panel would stay stale
    // until an unrelated save.
    expect(commit).not.toHaveBeenCalled()
    expect(fetchPage).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5_000)
    await flushMicrotasks()
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledOnce()
    expect(commit.mock.calls[0][0]).toMatchObject({
      generation: 1,
      invalidation: { chatId: 'chat-a', revision: 1 }
    })
  })

  it('still accepts a late page after the deadline released its slot', async () => {
    const stuck = deferred<TranscriptPage | null>()
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchDeadlineMs: 1_000,
      fetchPage: () => stuck.promise,
      commit
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(1_000)
    stuck.resolve(page('chat-a', 1))
    await flushMicrotasks()
    // A late page is still a correct page; the deadline releases the slot, not
    // the work.
    expect(commit).toHaveBeenCalledOnce()
    expect(coordinator.stats().behind).toBe(0)
  })

  it('clears the deadline on a normal completion, so a later fetch is not released early', async () => {
    const first = deferred<TranscriptPage | null>()
    const second = deferred<TranscriptPage | null>()
    const fetchPage = vi
      .fn<(request: TranscriptPageRequest) => Promise<TranscriptPage | null>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchDeadlineMs: 1_000,
      fetchPage,
      commit: () => {}
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(900)
    first.resolve(page('chat-a', 1))
    await flushMicrotasks()

    coordinator.invalidate(invalidation('chat-a', 2))
    await vi.advanceTimersByTimeAsync(10)
    // The first fetch's deadline must not fire against the second fetch.
    await vi.advanceTimersByTimeAsync(200)
    expect(coordinator.stats().overdueFetches).toBe(0)
    expect(coordinator.stats().inFlight).toBe(1)
  })

  it('gives up on a pull whose promise never settles and recovers via the bounded retry', async () => {
    // Transport pathology: the Host accepts the connection then wedges, the
    // request frame never answers, and the invoke sits on the transport's own
    // 30 s timer. Without a settle bound the panel waits out all 30 s and
    // every retry queues behind the same stuck invoke.
    let calls = 0
    const commit = vi.fn<(value: PagedChatUpdateRefreshCommit) => void>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 10,
      fetchDeadlineMs: 60_000,
      fetchSettleTimeoutMs: 1_000,
      fetchPage: () => {
        calls += 1
        return calls === 1 ? new Promise<TranscriptPage | null>(() => {}) : Promise.resolve(page('chat-a', 1))
      },
      commit
    })

    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(10)
    await flushMicrotasks()
    expect(calls).toBe(1)
    expect(commit).not.toHaveBeenCalled()

    // The stuck pull rejects at the settle bound; the retry pull lands and
    // commits — recovery stays on the coordinator's cadence, not the
    // transport's 30 s timer.
    await vi.advanceTimersByTimeAsync(6_500)
    await flushMicrotasks()
    expect(calls).toBe(2)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('reports behind until a commit actually publishes', async () => {
    const flight = deferred<TranscriptPage | null>()
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 0,
      fetchPage: () => flight.promise,
      commit: () => {}
    })
    coordinator.invalidate(invalidation('chat-a', 1))
    expect(coordinator.stats().behind).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    flight.resolve(page('chat-a', 1))
    await flushMicrotasks()
    expect(coordinator.stats().behind).toBe(0)
  })

  it('deadline and settle timeout can be disabled with 0, restoring the old unbounded wait', async () => {
    const stuck = deferred<TranscriptPage | null>()
    const fetchPage = vi.fn(() => stuck.promise)
    const coordinator = new PagedChatUpdateRefreshCoordinator({
      debounceMs: 0,
      fetchDeadlineMs: 0,
      fetchSettleTimeoutMs: 0,
      fetchPage,
      commit: () => {}
    })
    coordinator.invalidate(invalidation('chat-a', 1))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(coordinator.stats()).toMatchObject({ inFlight: 1, overdueFetches: 0 })
  })
})
