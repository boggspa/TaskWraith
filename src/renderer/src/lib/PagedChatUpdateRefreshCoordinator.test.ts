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
    expect(coordinator.stats()).toEqual({ trackedChats: 0, inFlight: 0, scheduled: 0 })
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
    expect(coordinator.stats()).toEqual({ trackedChats: 1, inFlight: 1, scheduled: 0 })
    flight.resolve(page('chat-a', 1))
    await flushMicrotasks()
  })
})
