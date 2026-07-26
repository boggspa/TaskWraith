import { beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage,
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  return { store }
})

import {
  clearComposerSuggestionLog,
  readComposerSuggestionLog,
  readComposerSuggestionStats,
  recordComposerSuggestionEvent
} from './composerSuggestionLog'

const KEY = 'taskwraith.composerSuggestionLog.v1'

beforeEach(() => {
  fake.store.clear()
})

describe('composer suggestion log', () => {
  it('starts empty and reports no stats', () => {
    expect(readComposerSuggestionLog()).toEqual([])
    expect(readComposerSuggestionStats()).toEqual({})
  })

  it('appends outcomes in order', () => {
    recordComposerSuggestionEvent('picker-dismissed', 'shown', 1)
    recordComposerSuggestionEvent('picker-dismissed', 'accepted', 2)
    expect(readComposerSuggestionLog()).toEqual([
      { at: 1, trigger: 'picker-dismissed', action: 'shown' },
      { at: 2, trigger: 'picker-dismissed', action: 'accepted' }
    ])
  })

  it('computes a per-trigger accept rate', () => {
    recordComposerSuggestionEvent('picker-dismissed', 'shown', 1)
    recordComposerSuggestionEvent('picker-dismissed', 'shown', 2)
    recordComposerSuggestionEvent('picker-dismissed', 'accepted', 3)
    recordComposerSuggestionEvent('uncommitted-changes', 'shown', 4)
    recordComposerSuggestionEvent('uncommitted-changes', 'dismissed', 5)

    const stats = readComposerSuggestionStats()
    expect(stats['picker-dismissed']).toEqual({
      shown: 2,
      accepted: 1,
      dismissed: 0,
      acceptRate: 0.5
    })
    expect(stats['uncommitted-changes']).toEqual({
      shown: 1,
      accepted: 0,
      dismissed: 1,
      acceptRate: 0
    })
  })

  it('bounds the ring at 500 entries, keeping the newest', () => {
    for (let i = 0; i < 520; i += 1) {
      recordComposerSuggestionEvent('lane-failed', 'shown', i)
    }
    const log = readComposerSuggestionLog()
    expect(log).toHaveLength(500)
    expect(log[0].at).toBe(20)
    expect(log[log.length - 1].at).toBe(519)
  })

  it('ignores malformed persisted entries rather than throwing', () => {
    fake.store.set(
      KEY,
      JSON.stringify([{ at: 'nope' }, null, 7, { at: 1, trigger: 'x', action: 'shown' }])
    )
    expect(readComposerSuggestionLog()).toEqual([{ at: 1, trigger: 'x', action: 'shown' }])
  })

  it('survives non-JSON in storage', () => {
    fake.store.set(KEY, '{{{')
    expect(readComposerSuggestionLog()).toEqual([])
  })

  it('clears', () => {
    recordComposerSuggestionEvent('lane-failed', 'shown', 1)
    clearComposerSuggestionLog()
    expect(readComposerSuggestionLog()).toEqual([])
  })
})
