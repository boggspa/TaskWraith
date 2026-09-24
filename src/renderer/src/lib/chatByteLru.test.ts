import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import {
  ChatByteLru,
  demoteChatToSummary,
  estimateChatMessageBytes,
  estimateChatMessagesBytes,
  estimateChatRecordBytes,
  estimateJsonishBytes,
  retainChatsWithinByteBudget
} from './chatByteLru'
import { isChatSummaryRecord } from './chatRecordMerge'

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: '1'
  }
}

function chat(id: string, content: string, updatedAt = 1): ChatRecord {
  return {
    appChatId: id,
    title: id,
    createdAt: 1,
    updatedAt,
    archived: false,
    messages: [message(`${id}-m`, content)],
    runs: []
  }
}

describe('chatByteLru', () => {
  it('demotes unpinned full chats to summaryOnly without deleting durable identity', () => {
    const full = chat('a', 'hello world')
    const demoted = demoteChatToSummary(full)
    expect(isChatSummaryRecord(demoted)).toBe(true)
    expect(demoted.appChatId).toBe('a')
    expect(demoted.messages).toEqual([])
    expect(demoted.messageCount).toBe(1)
    expect(full.messages).toHaveLength(1)
  })

  it('evicts oldest unpinned chats until the byte budget fits', () => {
    const heavy = 'x'.repeat(50_000)
    const chats = [chat('old', heavy, 1), chat('mid', heavy, 2), chat('new', heavy, 3)]
    const oneChatBytes = estimateChatRecordBytes(chats[0]!)
    const result = retainChatsWithinByteBudget({
      chats,
      pinnedIds: new Set(['new']),
      maxBytes: oneChatBytes + 1_000,
      lruOrder: ['old', 'mid', 'new']
    })
    expect(result.evictedIds).toContain('old')
    expect(result.evictedIds).toContain('mid')
    expect(isChatSummaryRecord(result.chats.find((c) => c.appChatId === 'new')!)).toBe(false)
    expect(isChatSummaryRecord(result.chats.find((c) => c.appChatId === 'old')!)).toBe(true)
    expect(result.stats.hydratedFullChatCount).toBe(1)
  })

  it('never demotes pinned chats even when over budget', () => {
    const heavy = 'y'.repeat(40_000)
    const chats = [chat('focus', heavy), chat('side', heavy)]
    const lru = new ChatByteLru({ maxBytes: 1 })
    lru.pin('focus', 'focused')
    lru.pin('side', 'side')
    const result = lru.retain(chats)
    expect(result.evictedIds).toEqual([])
    expect(result.stats.hydratedFullChatCount).toBe(2)
  })

  it('keeps a visible multiview pane resident independently of focus', () => {
    const paneChat = chat('pane', 'visible transcript')
    const lru = new ChatByteLru({ maxBytes: 0 })
    lru.pin(paneChat.appChatId, 'pane')

    const result = lru.retain([paneChat])

    expect(result.evictedIds).toEqual([])
    expect(isChatSummaryRecord(result.chats[0]!)).toBe(false)
    expect(ChatByteLru.pinReasons).toContain('pane')
  })

  it('retainMap updates entries in place and reports evictions', () => {
    const heavy = 'z'.repeat(30_000)
    const map = new Map<string, ChatRecord>([
      ['a', chat('a', heavy, 1)],
      ['b', chat('b', heavy, 2)]
    ])
    const lru = new ChatByteLru({ maxBytes: estimateChatRecordBytes(map.get('b')!) + 100 })
    lru.touch('a')
    lru.touch('b')
    lru.pin('b', 'focused')
    const evicted = lru.retainMap(map)
    expect(evicted).toEqual(['a'])
    expect(isChatSummaryRecord(map.get('a')!)).toBe(true)
    expect(isChatSummaryRecord(map.get('b')!)).toBe(false)
  })

  it('measures a record once per pure retention pass', () => {
    const stable = chat('stable', 'x'.repeat(2_000))
    const estimateBytes = vi.fn(estimateChatRecordBytes)

    retainChatsWithinByteBudget({
      chats: [stable],
      maxBytes: Number.MAX_SAFE_INTEGER,
      estimateBytes
    })

    expect(estimateBytes).toHaveBeenCalledTimes(1)
  })

  it('reuses byte estimates across reconciles and invalidates changed transcript content', () => {
    const stable = chat('stable', 'first')
    const estimateBytes = vi.fn(estimateChatRecordBytes)
    const lru = new ChatByteLru({ maxBytes: Number.MAX_SAFE_INTEGER, estimateBytes })

    lru.retain([stable])
    lru.retain([stable])
    expect(estimateBytes).toHaveBeenCalledTimes(1)

    stable.messages[0]!.content = 'second, longer streamed content'
    lru.retain([stable])
    expect(estimateBytes).toHaveBeenCalledTimes(2)

    const replacement = chat('stable', 'immutable replacement')
    lru.retain([replacement])
    expect(estimateBytes).toHaveBeenCalledTimes(3)
  })

  it('unions reconcile-time pins with surface-owned pins', () => {
    const focused = chat('focus', 'focused transcript')
    const pane = chat('pane', 'pane transcript')
    const lru = new ChatByteLru({ maxBytes: 0 })
    lru.pin('pane', 'pane')

    const result = lru.retain([focused, pane], new Set(['focus']))

    expect(result.evictedIds).toEqual([])
    expect(result.stats.pinnedChatCount).toBe(2)
  })

  it('forgets explicit removals without disturbing other residency metadata', () => {
    const lru = new ChatByteLru({ maxBytes: 0 })
    lru.pin('deleted', 'approval')
    lru.pin('visible', 'pane')
    lru.touch('deleted')

    lru.forget('deleted')

    expect(lru.isPinned('deleted')).toBe(false)
    expect(lru.isPinned('visible')).toBe(true)
    expect(lru.pinnedIds()).toEqual(new Set(['visible']))
  })
})

describe('estimateChatMessageBytes memoisation', () => {
  it('agrees with the shared walker on a first measurement', () => {
    const row = message('m-1', 'x'.repeat(500))
    expect(estimateChatMessageBytes(row)).toBe(estimateJsonishBytes(row))
  })

  it('measures a given message object exactly ONCE', () => {
    // The O(new rows) claim, observed directly. A row is measured, then grown
    // in place — something the renderer never does, which is precisely why
    // identity is a sound key. Getting the ORIGINAL size back is proof that no
    // second walk ran; a re-walk would return the new, much larger number.
    const row = message('m-1', 'small')
    const first = estimateChatMessageBytes(row)
    ;(row as { content: string }).content = 'x'.repeat(100_000)
    expect(estimateChatMessageBytes(row)).toBe(first)
    expect(estimateJsonishBytes(row)).toBeGreaterThan(first * 100)
  })

  it('re-measures a REPLACED row, which is how the renderer changes one', () => {
    // `applyChatTranscriptOps` assigns a new object for an `update`, so a
    // changed row is a cache miss and gets the right size.
    const before = message('m-1', 'small')
    const measured = estimateChatMessageBytes(before)
    const after = { ...before, content: 'x'.repeat(10_000) }
    expect(estimateChatMessageBytes(after)).toBeGreaterThan(measured * 10)
    expect(estimateChatMessageBytes(after)).toBe(estimateJsonishBytes(after))
  })

  it('answers 0 for a row that is not an object instead of throwing', () => {
    // A WeakMap.set on a non-object throws; the shared walker answers 0. Paged
    // and summary records carry holes, so this path is reachable.
    expect(estimateChatMessageBytes(null as unknown as ChatMessage)).toBe(0)
    expect(estimateChatMessageBytes(undefined as unknown as ChatMessage)).toBe(0)
  })

  it('totals an array identically to walking the array whole', () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      message(`m-${index}`, `row ${index} `.repeat(index + 1))
    )
    expect(estimateChatMessagesBytes(rows)).toBe(estimateJsonishBytes(rows))
    expect(estimateChatMessagesBytes([])).toBe(estimateJsonishBytes([]))
  })
})
