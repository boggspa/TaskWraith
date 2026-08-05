import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from '../../../main/store/types'
import {
  ChatByteLru,
  demoteChatToSummary,
  estimateChatRecordBytes,
  retainChatsWithinByteBudget
} from './chatByteLru'
import { isChatSummaryRecord } from './chatRecordMerge'

function message(id: string, content: string): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    createdAt: 1
  } as ChatMessage
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
})
