import { describe, expect, it } from 'vitest'
import type { ChatListItem, ChatRecord } from '../../../main/store/types'
import { CHAT_UPDATE_MAX_RENDER_LATENCY_MS } from './chatUpdateRenderUrgency'
import {
  PagedChatPresentationCoalescer,
  pagedChatChromeRenderEqual,
  publishCoalescedChatList,
  publishCoalescedCurrentChat,
  type PagedChatPresentationScheduling
} from './PagedChatPresentationCoalescer'

function shell(
  chatId: string,
  revision: number,
  overrides: Partial<ChatListItem> = {}
): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: chatId,
    archived: false,
    createdAt: 1,
    updatedAt: revision,
    persistenceRevision: revision,
    messages: [],
    runs: [],
    summaryOnly: true,
    messageCount: 100,
    runCount: 1,
    transcriptPaged: true,
    runsSummary: [{ runId: `${chatId}-run`, provider: 'codex', diffFileCount: 0 }],
    ...overrides
  } as unknown as ChatRecord
}

describe('pagedChatChromeRenderEqual', () => {
  it('retains across volatile-only churn even with fresh deep-equal sub-objects', () => {
    expect(pagedChatChromeRenderEqual(shell('a', 3), shell('a', 9))).toBe(true)
  })

  it('publishes when status content, counts, key sets, or identity change', () => {
    expect(
      pagedChatChromeRenderEqual(
        shell('a', 3),
        shell('a', 4, {
          runsSummary: [
            {
              runId: 'a-run',
              provider: 'codex',
              diffFileCount: 1,
              endedAt: '2026-09-05T00:00:00.000Z'
            }
          ]
        })
      )
    ).toBe(false)
    expect(pagedChatChromeRenderEqual(shell('a', 3), shell('a', 3, { messageCount: 101 })).toBe(
      false
    )
    expect(
      pagedChatChromeRenderEqual(shell('a', 3), shell('a', 3, { searchText: 'now present' }))
    ).toBe(false)
    expect(pagedChatChromeRenderEqual(shell('a', 3), shell('b', 3))).toBe(false)
    expect(pagedChatChromeRenderEqual(null, shell('a', 3))).toBe(false)
    expect(pagedChatChromeRenderEqual(shell('a', 3), null)).toBe(false)
  })

  it('is conservative for non-summary records: fresh sub-objects publish', () => {
    const full = (): ChatRecord =>
      ({
        appChatId: 'full',
        provider: 'codex',
        title: 'full',
        archived: false,
        createdAt: 1,
        updatedAt: 3,
        persistenceRevision: 3,
        messages: [],
        runs: [],
        runsSummary: [{ runId: 'full-run', provider: 'codex', diffFileCount: 0 }]
      }) as unknown as ChatRecord
    // Deep-equal content but fresh array identity: the cheap reference walk
    // used for non-summary records must conservatively publish.
    expect(pagedChatChromeRenderEqual(full(), full())).toBe(false)
  })
})

describe('publishCoalescedChatList', () => {
  it('returns the previous array identity when every dirty chat is retained or vanished', () => {
    const previous = [shell('a', 3), shell('b', 3)]
    const canonical = new Map([['a', shell('a', 8)]])
    const next = publishCoalescedChatList(previous, new Set(['a', 'gone']), (chatId) =>
      canonical.get(chatId)
    )
    expect(next).toBe(previous)
  })

  it('publishes changed chats, inserts new canonical chats, and sorts by recency', () => {
    const previous = [shell('a', 3), shell('b', 5)]
    const changedA = shell('a', 9, {
      runsSummary: [
        { runId: 'a-run', provider: 'codex', diffFileCount: 1, endedAt: '2026-09-05T00:00:00.000Z' }
      ]
    })
    const inserted = shell('c', 7)
    const canonical = new Map([
      ['a', changedA],
      ['c', inserted]
    ])
    const next = publishCoalescedChatList(previous, new Set(['a', 'c']), (chatId) =>
      canonical.get(chatId)
    )
    expect(next.map((chat) => chat.appChatId)).toEqual(['a', 'c', 'b'])
    expect(next[0]).toBe(changedA)
    expect(next[1]).toBe(inserted)
    expect(next[2]).toBe(previous[1])
  })
})

describe('publishCoalescedCurrentChat', () => {
  it('retains on volatile-only churn and passes through non-dirty or vanished chats', () => {
    const previous = shell('a', 3)
    expect(publishCoalescedCurrentChat(previous, new Set(['a']), () => shell('a', 9))).toBe(
      previous
    )
    expect(publishCoalescedCurrentChat(previous, new Set(['b']), () => shell('b', 9))).toBe(
      previous
    )
    expect(publishCoalescedCurrentChat(previous, new Set(['a']), () => undefined)).toBe(previous)
    expect(publishCoalescedCurrentChat(null, new Set(['a']), () => shell('a', 9))).toBeNull()
  })

  it('publishes the canonical record when chrome meaningfully changed', () => {
    const previous = shell('a', 3)
    const changed = shell('a', 4, {
      runsSummary: [
        { runId: 'a-run', provider: 'codex', diffFileCount: 1, endedAt: '2026-09-05T00:00:00.000Z' }
      ]
    })
    expect(publishCoalescedCurrentChat(previous, new Set(['a']), () => changed)).toBe(changed)
  })
})

describe('PagedChatPresentationCoalescer', () => {
  function manualScheduling(): {
    frames: Array<() => void>
    timers: Array<{ callback: () => void; delayMs: number }>
    cancelledFrames: () => number
    clearedTimers: () => number
    scheduling: PagedChatPresentationScheduling
  } {
    const frames: Array<() => void> = []
    const timers: Array<{ callback: () => void; delayMs: number }> = []
    let cancelledFrames = 0
    let clearedTimers = 0
    return {
      frames,
      timers,
      cancelledFrames: () => cancelledFrames,
      clearedTimers: () => clearedTimers,
      scheduling: {
        scheduleFrame: (callback) => {
          frames.push(callback)
          return frames.length
        },
        cancelFrame: () => {
          cancelledFrames += 1
        },
        setTimer: (callback, delayMs) => {
          timers.push({ callback, delayMs })
          return timers.length as unknown as ReturnType<typeof setTimeout>
        },
        clearTimer: () => {
          clearedTimers += 1
        }
      }
    }
  }

  it('arms one frame and one deadline per burst and flushes the batch exactly once', () => {
    const flushes: string[][] = []
    const manual = manualScheduling()
    const coalescer = new PagedChatPresentationCoalescer(
      (chatIds) => flushes.push([...chatIds].sort()),
      manual.scheduling
    )
    coalescer.schedule('a')
    coalescer.schedule('b')
    coalescer.schedule('a')
    expect(manual.frames).toHaveLength(1)
    expect(manual.timers).toHaveLength(1)
    expect(manual.timers[0].delayMs).toBe(CHAT_UPDATE_MAX_RENDER_LATENCY_MS)

    manual.frames[0]()
    expect(flushes).toEqual([['a', 'b']])
    expect(manual.clearedTimers()).toBe(1)
    // A deadline that still fires later must find nothing pending.
    manual.timers[0].callback()
    expect(flushes).toEqual([['a', 'b']])
  })

  it('publishes through the deadline when frames are starved', () => {
    const flushes: string[][] = []
    const manual = manualScheduling()
    const coalescer = new PagedChatPresentationCoalescer(
      (chatIds) => flushes.push([...chatIds].sort()),
      manual.scheduling
    )
    coalescer.schedule('a')
    // The frame never fires (throttled/occluded window); the deadline must.
    manual.timers[0].callback()
    expect(flushes).toEqual([['a']])
    expect(manual.cancelledFrames()).toBe(1)
    // The starved frame arriving afterwards finds nothing pending.
    manual.frames[0]()
    expect(flushes).toEqual([['a']])
  })

  it('flushNow drains synchronously and disarm cancels without publishing', () => {
    const flushes: string[][] = []
    const manual = manualScheduling()
    const coalescer = new PagedChatPresentationCoalescer(
      (chatIds) => flushes.push([...chatIds].sort()),
      manual.scheduling
    )
    coalescer.flushNow()
    expect(flushes).toEqual([])

    coalescer.schedule('a')
    coalescer.flushNow()
    expect(flushes).toEqual([['a']])
    expect(coalescer.stats()).toEqual({ pending: 0, armed: false })

    coalescer.schedule('b')
    coalescer.disarm()
    expect(flushes).toEqual([['a']])
    expect(coalescer.stats()).toEqual({ pending: 1, armed: false })
    coalescer.flushNow()
    expect(flushes).toEqual([['a'], ['b']])
  })
})
