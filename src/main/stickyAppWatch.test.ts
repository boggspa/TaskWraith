import { describe, expect, it, vi } from 'vitest'
import {
  clearStickyAppWatch,
  getStickyAppWatch,
  MAX_STICKY_APPWATCH_SNAPSHOTS,
  normalizeStickyAppWatchStore,
  pruneStickyAppWatch,
  stashStickyAppWatch,
  StickyAppWatchStoreController,
  type StickyAppWatchStore
} from './stickyAppWatch'

function meta(over: Partial<{ title: string; bundleID: string; applicationName: string }> = {}) {
  return {
    title: over.title ?? 'Untitled.fcpxml',
    bundleID: over.bundleID ?? 'com.apple.FinalCut',
    applicationName: over.applicationName ?? 'Final Cut Pro'
  }
}

function stashInput(chatId: string, over: Record<string, unknown> = {}) {
  return {
    chatId,
    windowMeta: meta(),
    attachedAt: '2026-06-01T10:00:00.000Z',
    wasStreaming: false,
    stashedAt: '2026-06-01T10:05:00.000Z',
    ...over
  }
}

describe('stashStickyAppWatch', () => {
  it('stores a snapshot keyed by chatId', () => {
    const store = stashStickyAppWatch({}, stashInput('chat-1'))
    expect(getStickyAppWatch(store, 'chat-1')).toMatchObject({
      chatId: 'chat-1',
      wasStreaming: false,
      windowMeta: { applicationName: 'Final Cut Pro' }
    })
  })

  it('does not mutate the input store', () => {
    const original: StickyAppWatchStore = {}
    stashStickyAppWatch(original, stashInput('chat-1'))
    expect(original).toEqual({})
  })

  it('upserts (a second stash for the same chat replaces the first)', () => {
    let store = stashStickyAppWatch({}, stashInput('chat-1', { wasStreaming: false }))
    store = stashStickyAppWatch(store, stashInput('chat-1', { wasStreaming: true }))
    expect(Object.keys(store)).toHaveLength(1)
    expect(getStickyAppWatch(store, 'chat-1')?.wasStreaming).toBe(true)
  })

  it('rejects input with no chatId or no display metadata', () => {
    expect(stashStickyAppWatch({}, stashInput(''))).toEqual({})
    // @ts-expect-error — exercising the runtime guard
    expect(stashStickyAppWatch({}, { chatId: 'c', windowMeta: null })).toEqual({})
    expect(
      stashStickyAppWatch(
        {},
        stashInput('c', { windowMeta: meta({ title: '', bundleID: '', applicationName: '' }) })
      )
    ).toEqual({})
  })

  it('LRU-prunes to the cap, dropping the oldest stashedAt', () => {
    let store: StickyAppWatchStore = {}
    for (let i = 0; i < MAX_STICKY_APPWATCH_SNAPSHOTS; i++) {
      const n = String(i).padStart(3, '0')
      store = stashStickyAppWatch(
        store,
        stashInput(`chat-${n}`, { stashedAt: `2026-06-01T10:00:00.${n}Z` })
      )
    }
    expect(Object.keys(store)).toHaveLength(MAX_STICKY_APPWATCH_SNAPSHOTS)
    // One more, newest — evicts the oldest (chat-000).
    store = stashStickyAppWatch(
      store,
      stashInput('chat-new', { stashedAt: '2026-06-01T11:00:00.000Z' })
    )
    expect(Object.keys(store)).toHaveLength(MAX_STICKY_APPWATCH_SNAPSHOTS)
    expect(getStickyAppWatch(store, 'chat-000')).toBeNull()
    expect(getStickyAppWatch(store, 'chat-new')).not.toBeNull()
  })
})

describe('clearStickyAppWatch', () => {
  it('removes a chat snapshot', () => {
    const store = stashStickyAppWatch({}, stashInput('chat-1'))
    expect(getStickyAppWatch(clearStickyAppWatch(store, 'chat-1'), 'chat-1')).toBeNull()
  })
  it('no-ops for an absent chat', () => {
    const store = stashStickyAppWatch({}, stashInput('chat-1'))
    expect(clearStickyAppWatch(store, 'nope')).toBe(store)
  })
})

describe('normalizeStickyAppWatchStore', () => {
  it('returns {} for junk', () => {
    expect(normalizeStickyAppWatchStore(null)).toEqual({})
    expect(normalizeStickyAppWatchStore('str')).toEqual({})
    expect(normalizeStickyAppWatchStore([1, 2])).toEqual({})
  })

  it('drops entries with no safe display identity and strips legacy process fields', () => {
    const raw = {
      good: {
        windowMeta: { windowID: 3, title: 't', bundleID: 'b', applicationName: 'A', pid: 1 },
        attachedAt: 'x',
        stashedAt: 'y',
        wasStreaming: true
      },
      bad: { windowMeta: { title: '', bundleID: '', applicationName: '' } }
    }
    const out = normalizeStickyAppWatchStore(raw)
    expect(Object.keys(out)).toEqual(['good'])
    expect(out.good.wasStreaming).toBe(true)
    expect(out.good.windowMeta).toEqual({ title: 't', bundleID: 'b', applicationName: 'A' })
    expect(out.good.windowMeta).not.toHaveProperty('pid')
    expect(out.good.windowMeta).not.toHaveProperty('windowID')
  })

  it('normalizes and bounds safe display fields defensively', () => {
    const out = normalizeStickyAppWatchStore({
      c: {
        windowMeta: {
          title: '  Example   window  ',
          bundleID: '',
          applicationName: 'A'.repeat(200)
        }
      }
    })
    expect(out.c.windowMeta.title).toBe('Example window')
    expect(out.c.windowMeta.bundleID).toBe('')
    expect(out.c.windowMeta.applicationName).toHaveLength(160)
    expect(out.c.attachedAt).toBe('')
  })
})

describe('pruneStickyAppWatch', () => {
  it('returns the same reference when under the cap', () => {
    const store = stashStickyAppWatch({}, stashInput('chat-1'))
    expect(pruneStickyAppWatch(store)).toBe(store)
  })
})

describe('StickyAppWatchStoreController', () => {
  it('serializes concurrent cross-chat stashes without losing either snapshot', async () => {
    let persisted: StickyAppWatchStore = {}
    let releaseFirstPersist: (() => void) | undefined
    const firstPersistBlocked = new Promise<void>((resolve) => {
      releaseFirstPersist = resolve
    })
    const persist = vi.fn(async (store: StickyAppWatchStore) => {
      if (persist.mock.calls.length === 1) await firstPersistBlocked
      persisted = structuredClone(store)
    })
    const controller = new StickyAppWatchStoreController({
      load: async () => persisted,
      persist
    })

    const first = controller.stash(stashInput('chat-1'))
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    const second = controller.stash(stashInput('chat-2'))
    expect(persist).toHaveBeenCalledTimes(1)

    releaseFirstPersist?.()
    await Promise.all([first, second])

    expect(persist).toHaveBeenCalledTimes(2)
    expect(Object.keys(persisted).sort()).toEqual(['chat-1', 'chat-2'])
  })

  it('serializes a cross-chat clear behind an in-flight stash', async () => {
    let persisted = stashStickyAppWatch({}, stashInput('chat-existing'))
    let releaseFirstPersist: (() => void) | undefined
    const firstPersistBlocked = new Promise<void>((resolve) => {
      releaseFirstPersist = resolve
    })
    const persist = vi.fn(async (store: StickyAppWatchStore) => {
      if (persist.mock.calls.length === 1) await firstPersistBlocked
      persisted = structuredClone(store)
    })
    const controller = new StickyAppWatchStoreController({
      load: async () => persisted,
      persist
    })

    const stash = controller.stash(stashInput('chat-new'))
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    const clear = controller.clear('chat-existing')
    releaseFirstPersist?.()
    await Promise.all([stash, clear])

    expect(Object.keys(persisted)).toEqual(['chat-new'])
  })

  it('keeps the in-memory result and reports best-effort persistence failures', async () => {
    const onPersistError = vi.fn()
    const controller = new StickyAppWatchStoreController({
      load: async () => ({}),
      persist: async () => {
        throw new Error('disk unavailable')
      },
      onPersistError
    })

    await expect(controller.stash(stashInput('chat-1'))).resolves.toBeUndefined()
    await expect(controller.get('chat-1')).resolves.toMatchObject({ chatId: 'chat-1' })
    expect(onPersistError).toHaveBeenCalledTimes(1)
  })
})
