import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import {
  DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES,
  type ChatShell
} from '../../../shared/transcriptPage'
import { ChatHydrationRequestPool } from './chatHydrationRuntime'
import { createSurfaceChatHydrator, isSurfaceChatHydrated } from './chatSurfacePagedHydration'
import { ChatTranscriptStore } from './chatTranscriptStore'
import {
  SelectedChatHydrationRecovery,
  type SelectedChatHydrationState
} from './SelectedChatHydrationRecovery'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function scheduled(callback: () => void, delayMs = 0): () => void {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

function harness(hydrate = vi.fn<() => Promise<unknown | null>>()) {
  const pending = new Set(['a'])
  const publish = vi.fn<(state: SelectedChatHydrationState | null) => void>()
  const recovery = new SelectedChatHydrationRecovery({
    needsHydration: (id) => pending.has(id),
    hydrate,
    publish,
    afterPaint: scheduled,
    scheduleRetry: scheduled
  })
  return { recovery, hydrate, pending, publish }
}

describe('selected chat hydration recovery', () => {
  it('releases a rejected pooled read and retries successfully without a second selection', async () => {
    const pool = new ChatHydrationRequestPool<unknown>()
    const read = vi.fn().mockRejectedValueOnce(new Error('host_unavailable')).mockResolvedValue({})
    const commit = vi.fn()
    const hydrate = vi.fn(() =>
      pool.run('a', async () => {
        const result = await read()
        commit(result)
        return result
      })
    )
    const { recovery, publish } = harness(hydrate)
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.pendingChatIds()).toEqual([])
    expect(commit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith(null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('retries the whole paged/full chain when both initial reads fail', async () => {
    const messageCount = DEFAULT_TRANSCRIPT_PAGE_MAX_MESSAGES + 1
    let chat = {
      appChatId: 'a',
      title: 'Saved',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      messages: [],
      runs: [],
      summaryOnly: true,
      messageCount
    } as ChatRecord
    const shell = { ...chat, transcriptPaged: true } as ChatShell
    const store = new ChatTranscriptStore()
    const fetchPagedShell = vi
      .fn()
      .mockRejectedValueOnce(new Error('host_unavailable'))
      .mockResolvedValue({
        shell,
        page: {
          chatId: 'a',
          messages: [{ id: 'tail', role: 'assistant', content: 'Saved output', timestamp: '1' }],
          runs: [],
          totalMessageCount: messageCount,
          windowStart: messageCount - 1,
          windowEnd: messageCount,
          estimatedBytes: 64,
          hasOlder: true,
          hasNewer: false,
          oldestMessageId: 'tail',
          newestMessageId: 'tail',
          updatedAt: 2
        }
      })
    const pool = new ChatHydrationRequestPool<ChatRecord | null>()
    const fullRead = vi.fn().mockRejectedValue(new Error('host_unavailable'))
    const commitPagedShell = vi.fn((next, page) => {
      chat = next
      store.ingestPage(page)
      return next
    })
    const hydrate = createSurfaceChatHydrator({
      resolveChat: () => chat,
      transcriptStore: store,
      fetchPagedShell,
      commitPagedShell,
      fullHydrate: (id) => pool.run(id, fullRead)
    })
    const publish = vi.fn()
    const recovery = new SelectedChatHydrationRecovery({
      needsHydration: () => !isSurfaceChatHydrated(chat, store),
      hydrate,
      publish,
      afterPaint: scheduled,
      scheduleRetry: scheduled
    })
    const unsubscribe = store.subscribe('a', () => recovery.reconcile())
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(fullRead).toHaveBeenCalledTimes(1)
    expect(pool.pendingChatIds()).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchPagedShell).toHaveBeenCalledTimes(2)
    expect(fullRead).toHaveBeenCalledTimes(1)
    expect(commitPagedShell).toHaveBeenCalledTimes(1)
    expect(store.get('a')?.messages[0].content).toBe('Saved output')
    expect(publish).toHaveBeenLastCalledWith(null)
    unsubscribe()
  })

  it('cancels work on selection change both before paint and during retry delay', async () => {
    const { recovery, hydrate, publish } = harness(vi.fn().mockRejectedValue(new Error('offline')))
    recovery.select('a')
    recovery.select('b')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(hydrate).not.toHaveBeenCalled()
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(hydrate).toHaveBeenCalledTimes(1)
    recovery.select('b')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith(null)
  })

  it('cancels retries when the selected summary is no longer eligible', async () => {
    const { recovery, hydrate, pending, publish } = harness(vi.fn().mockResolvedValue(null))
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(0)
    pending.delete('a')
    recovery.reconcile()
    const published = publish.mock.calls.length
    for (let index = 0; index < 100; index++) recovery.reconcile()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(published)
    expect(publish).toHaveBeenLastCalledWith(null)
  })

  it('exhausts after two retries, stays exhausted across renders, and allows manual recovery', async () => {
    const { recovery, hydrate, publish } = harness(vi.fn().mockRejectedValue(new Error('offline')))
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(hydrate).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenLastCalledWith({ chatId: 'a', phase: 'failed' })
    recovery.select('a')
    recovery.reconcile()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hydrate).toHaveBeenCalledTimes(3)
    hydrate.mockResolvedValue({})
    recovery.retry()
    expect(publish).toHaveBeenLastCalledWith({ chatId: 'a', phase: 'loading' })
    await vi.advanceTimersByTimeAsync(0)
    expect(hydrate).toHaveBeenCalledTimes(4)
    expect(publish).toHaveBeenLastCalledWith(null)
  })

  it('also bounds null results instead of leaving a missing transcript silently blank', async () => {
    const { recovery, hydrate, publish } = harness(vi.fn().mockResolvedValue(null))
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(hydrate).toHaveBeenCalledTimes(3)
    expect(publish).toHaveBeenLastCalledWith({ chatId: 'a', phase: 'failed' })
  })

  it('keeps one valid slow read alive without racing it against retry reads', async () => {
    let resolve!: (value: unknown) => void
    const { recovery, hydrate, publish } = harness(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
    )
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(120_000)
    recovery.select('a')
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenLastCalledWith({ chatId: 'a', phase: 'loading' })
    resolve({})
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).toHaveBeenLastCalledWith(null)
  })

  it('ignores a late failure from the old selection', async () => {
    let reject!: (error: Error) => void
    const { recovery, hydrate, publish } = harness(
      vi.fn(
        () =>
          new Promise((_, fail) => {
            reject = fail
          })
      )
    )
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(0)
    recovery.select('b')
    const published = publish.mock.calls.length
    reject(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(published)
  })

  it('cancels retries on unmount and can be set up again by React StrictMode', async () => {
    const { recovery, hydrate, pending, publish } = harness(vi.fn().mockResolvedValue(null))
    recovery.select('a')
    await vi.advanceTimersByTimeAsync(0)
    recovery.dispose()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(hydrate).toHaveBeenCalledTimes(1)
    pending.delete('a')
    recovery.select('a')
    expect(publish).toHaveBeenLastCalledWith(null)
  })
})
