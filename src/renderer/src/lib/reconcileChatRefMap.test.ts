import { describe, it, expect, vi } from 'vitest'
import type { ChatRecord, ChatListItem } from '../../../main/store/types'
import { reconcileChatRefMap, RECENTLY_COMPLETED_WINDOW_MS } from './reconcileChatRefMap'

// Minimal ChatRecord factory — the reconcile only reads appChatId and the
// (opaque) record identity, so we cast a thin object.
function chat(appChatId: string, content: string, updatedAt = 0): ChatRecord {
  return {
    appChatId,
    title: appChatId,
    messages: [{ id: `m-${appChatId}`, role: 'assistant', content, timestamp: '' }],
    runs: [],
    createdAt: 0,
    updatedAt,
    archived: false
  } as unknown as ChatRecord
}
function summary(appChatId: string): ChatRecord {
  return { ...chat(appChatId, ''), summaryOnly: true } as unknown as ChatListItem as ChatRecord
}
const content = (m: Map<string, ChatRecord>, id: string) =>
  m.get(id)?.messages[m.get(id)!.messages.length - 1]?.content

const NO_ACTIVE = {
  activeRunChatId: null as string | null,
  activeRunChatIds: new Set<string>(),
  recentlyCompleted: new Map<string, number>(),
  now: 1_000_000
}

describe('reconcileChatRefMap — general rebuild', () => {
  it('mirrors React state and DROPS live entries with no active/recent run', () => {
    const prev = new Map([['A', chat('A', 'live-ahead')]])
    const next = reconcileChatRefMap({
      ...NO_ACTIVE,
      chats: [chat('A', 'react-snapshot'), chat('B', 'b')],
      currentChat: null,
      prev
    })
    // A is rebuilt from React state (no preserve); B added; nothing else.
    expect(content(next, 'A')).toBe('react-snapshot')
    expect(content(next, 'B')).toBe('b')
    expect(next.size).toBe(2)
  })

  it('keeps a live non-summary entry over an incoming summary stub', () => {
    const prev = new Map([['A', chat('A', 'full-content')]])
    const next = reconcileChatRefMap({
      ...NO_ACTIVE,
      chats: [summary('A')],
      currentChat: null,
      prev
    })
    expect(content(next, 'A')).toBe('full-content')
  })

  it('adds currentChat even when it is absent from the chats list', () => {
    const next = reconcileChatRefMap({
      ...NO_ACTIVE,
      chats: [chat('A', 'a')],
      currentChat: chat('Z', 'current'),
      prev: new Map()
    })
    expect(content(next, 'Z')).toBe('current')
  })
})

describe('reconcileChatRefMap — preserve predicates', () => {
  it('preserves via activeRunChatId alone (the run-start "Phase K" gap)', () => {
    // Live ref is ahead of the stale React snapshot; the activeRuns registry
    // is still EMPTY (entry written later) — only activeRunChatId guards it.
    const prev = new Map([['A', chat('A', 'abcdefg')]])
    const next = reconcileChatRefMap({
      chats: [chat('A', 'abcde')], // stale snapshot
      currentChat: null,
      prev,
      activeRunChatId: 'A',
      activeRunChatIds: new Set(), // <-- empty: the gap
      recentlyCompleted: new Map(),
      now: 1_000_000
    })
    expect(content(next, 'A')).toBe('abcdefg') // live ref preserved, not clobbered
  })

  it('preserves via the activeRuns registry (by chatId)', () => {
    const prev = new Map([['A', chat('A', 'abcdefg')]])
    const next = reconcileChatRefMap({
      chats: [chat('A', 'abcde')],
      currentChat: null,
      prev,
      activeRunChatId: null,
      activeRunChatIds: new Set(['A']),
      recentlyCompleted: new Map(),
      now: 1_000_000
    })
    expect(content(next, 'A')).toBe('abcdefg')
  })

  it('preserves within the recently-completed window and drops after it', () => {
    const prev = new Map([['A', chat('A', 'final-streamed')]])
    const within = reconcileChatRefMap({
      chats: [chat('A', 'stale')],
      currentChat: null,
      prev,
      activeRunChatId: null,
      activeRunChatIds: new Set(),
      recentlyCompleted: new Map([['A', 1_000_000 - (RECENTLY_COMPLETED_WINDOW_MS - 1)]]),
      now: 1_000_000
    })
    expect(content(within, 'A')).toBe('final-streamed')

    const after = reconcileChatRefMap({
      chats: [chat('A', 'stale')],
      currentChat: null,
      prev,
      activeRunChatId: null,
      activeRunChatIds: new Set(),
      recentlyCompleted: new Map([['A', 1_000_000 - RECENTLY_COMPLETED_WINDOW_MS]]),
      now: 1_000_000
    })
    expect(content(after, 'A')).toBe('stale') // window elapsed → React state wins
  })

  it('preserve has the LAST word over the currentChat override', () => {
    // currentChat is a stale snapshot of the streaming chat, but the chat is
    // active → the live ref entry must still win.
    const prev = new Map([['A', chat('A', 'abcdefg')]])
    const next = reconcileChatRefMap({
      chats: [chat('A', 'abcde')],
      currentChat: chat('A', 'abcde'), // stale current
      prev,
      activeRunChatId: 'A',
      activeRunChatIds: new Set(),
      recentlyCompleted: new Map(),
      now: 1_000_000
    })
    expect(content(next, 'A')).toBe('abcdefg')
  })
})

describe('reconcileChatRefMap — incremental hydration retention', () => {
  it('delegates to the renderer-lifetime authority with all dynamic pins', () => {
    const records = [chat('focus', 'a'), chat('active', 'b'), chat('recent', 'c')]
    const retain = vi.fn((chats: readonly ChatRecord[], _pinnedIds?: ReadonlySet<string>) => ({
      chats: [...chats],
      evictedIds: [],
      stats: {
        hydratedFullChatCount: chats.length,
        hydratedMessageBytes: 0,
        pinnedChatCount: 0,
        entryCount: chats.length
      }
    }))

    reconcileChatRefMap({
      chats: records,
      currentChat: records[0],
      prev: new Map(records.map((record) => [record.appChatId, record])),
      activeRunChatId: 'active',
      activeRunChatIds: new Set(['active']),
      recentlyCompleted: new Map([['recent', 999_999]]),
      now: 1_000_000,
      pinnedChatIds: new Set(['surface']),
      hydrationRetention: { retain }
    })

    expect(retain).toHaveBeenCalledTimes(1)
    const pins = retain.mock.calls[0]![1]!
    expect(Array.from(pins).sort()).toEqual(['active', 'focus', 'recent', 'surface'])
  })
})
