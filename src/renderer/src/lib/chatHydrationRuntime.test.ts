import { describe, expect, it, vi } from 'vitest'
import type { ChatListItem, ChatRecord } from '../../../main/store/types'
import { commitHydratedChat } from './chatHydrationMerge'
import { demoteChatToSummary, estimateChatRecordBytes } from './chatByteLru'
import {
  APP_MAX_HYDRATED_MESSAGE_BYTES,
  ChatHydrationRequestPool,
  MAX_HYDRATED_BYTES_ENV_KEY,
  createChatHydrationRuntime,
  getOrCreateChatHydrationRuntime,
  reconcileHydrationOptions,
  resolveMaxHydratedMessageBytes
} from './chatHydrationRuntime'
import { isChatSummaryRecord } from './chatRecordMerge'
import { reconcileChatRefMap } from './reconcileChatRefMap'

function fullChat(id: string, content: string): ChatRecord {
  return {
    appChatId: id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [{ id: `${id}-m`, role: 'user', content, timestamp: '1' }],
    runs: []
  }
}

describe('resolveMaxHydratedMessageBytes', () => {
  it('defaults to 512 MiB', () => {
    expect(resolveMaxHydratedMessageBytes({})).toBe(APP_MAX_HYDRATED_MESSAGE_BYTES)
    expect(APP_MAX_HYDRATED_MESSAGE_BYTES).toBe(512 * 1024 * 1024)
  })

  it('accepts TASKWRAITH_MAX_HYDRATED_CHAT_BYTES override including 0', () => {
    expect(
      resolveMaxHydratedMessageBytes({ [MAX_HYDRATED_BYTES_ENV_KEY]: String(64 * 1024 * 1024) })
    ).toBe(64 * 1024 * 1024)
    expect(resolveMaxHydratedMessageBytes({ [MAX_HYDRATED_BYTES_ENV_KEY]: '0' })).toBe(0)
  })

  it('rejects invalid env values', () => {
    expect(resolveMaxHydratedMessageBytes({ [MAX_HYDRATED_BYTES_ENV_KEY]: 'nope' })).toBe(
      APP_MAX_HYDRATED_MESSAGE_BYTES
    )
    expect(resolveMaxHydratedMessageBytes({ [MAX_HYDRATED_BYTES_ENV_KEY]: '-1' })).toBe(
      APP_MAX_HYDRATED_MESSAGE_BYTES
    )
  })
})

describe('ChatHydrationRequestPool', () => {
  it('shares one same-chat read while keeping different chats independent', async () => {
    const pool = new ChatHydrationRequestPool<string>()
    let finishShared!: (value: string) => void
    const hydrateShared = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishShared = resolve
        })
    )

    const first = pool.run('shared', hydrateShared)
    const joined = pool.run('shared', hydrateShared)
    const neighbour = pool.run('neighbour', async () => 'neighbour-ready')
    expect(joined).toBe(first)
    expect(hydrateShared).toHaveBeenCalledTimes(0)
    expect(pool.pendingChatIds()).toEqual(['shared', 'neighbour'])

    await Promise.resolve()
    expect(hydrateShared).toHaveBeenCalledTimes(1)
    await expect(neighbour).resolves.toBe('neighbour-ready')
    finishShared('shared-ready')
    await expect(first).resolves.toBe('shared-ready')
    await expect(joined).resolves.toBe('shared-ready')
    expect(pool.pendingChatIds()).toEqual([])

    await expect(pool.run('shared', async () => 'fresh-read')).resolves.toBe('fresh-read')
  })
})

describe('getOrCreateChatHydrationRuntime', () => {
  it('keeps one runtime when render-like callers resolve the ref repeatedly', () => {
    const ref = { current: null }
    const runtime = createChatHydrationRuntime({ maxBytes: 123 })
    const createRuntime = vi.fn(() => runtime)

    expect(getOrCreateChatHydrationRuntime(ref, createRuntime)).toBe(runtime)
    expect(getOrCreateChatHydrationRuntime(ref, createRuntime)).toBe(runtime)
    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(ref.current).toBe(runtime)
  })
})

describe('T7 App wiring — demote then rehydrate on focus', () => {
  it('demotes unpinned chats to summaryOnly under budget, then focus rehydrates', () => {
    const runtime = createChatHydrationRuntime({ maxBytes: 1 })
    const focused = fullChat('focus', 'keep-me')
    const cold = fullChat('cold', 'x'.repeat(8_000))
    runtime.byteLru.pin('focus', 'focused')
    runtime.transcriptStore.ingest(focused)
    runtime.transcriptStore.ingest(cold)

    const afterReconcile = reconcileChatRefMap({
      chats: [focused, cold],
      currentChat: focused,
      prev: new Map([
        ['focus', focused],
        ['cold', cold]
      ]),
      activeRunChatId: null,
      activeRunChatIds: new Set(),
      recentlyCompleted: new Map(),
      now: 1_000_000,
      ...reconcileHydrationOptions(runtime)
    })

    const demoted = afterReconcile.get('cold')
    expect((demoted as ChatListItem | undefined)?.summaryOnly).toBe(true)
    expect(demoted?.messages ?? []).toEqual([])
    expect(afterReconcile.get('focus')?.messages?.[0]?.content).toBe('keep-me')
    expect(runtime.transcriptStore.has('cold')).toBe(false)

    // Simulate focus switch + getChat rehydrate (App hydrateSelectedChatAfterPaint).
    const rehydratedPayload = fullChat('cold', 'x'.repeat(8_000))
    const committed = commitHydratedChat({
      chat: rehydratedPayload,
      transcriptStore: runtime.transcriptStore,
      byteLru: runtime.byteLru,
      pinReason: 'focused'
    })
    runtime.byteLru.unpin('focus', 'focused')
    expect(isChatSummaryRecord(committed)).toBe(false)
    expect(committed.messages?.[0]?.content.length).toBe(8_000)
    expect(runtime.transcriptStore.get('cold')?.messages).toHaveLength(1)
    expect(runtime.byteLru.isPinned('cold')).toBe(true)
    // Durable history was never deleted — demotion only dropped heap arrays.
    expect(estimateChatRecordBytes(demoteChatToSummary(cold))).toBeLessThan(
      estimateChatRecordBytes(cold)
    )
  })

  it('passes the renderer-lifetime LRU through reconcile wiring', () => {
    const runtime = createChatHydrationRuntime({ maxBytes: 123 })
    const options = reconcileHydrationOptions(runtime)

    expect(options.maxHydratedMessageBytes).toBe(123)
    expect(options.hydrationRetention).toBe(runtime.retention)
  })
})
