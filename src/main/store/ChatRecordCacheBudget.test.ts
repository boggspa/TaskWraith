import { describe, expect, it } from 'vitest'

import {
  CHAT_RECORD_CACHE_MAX_BYTES,
  selectChatRecordCacheEvictions
} from './ChatRecordCacheBudget'

const clean = (chatId: string, size: number) => ({ chatId, size, mtimeMs: 1 })
const dirty = (chatId: string, size: number) => ({ chatId, size, mtimeMs: -1 })

describe('selectChatRecordCacheEvictions', () => {
  it('keeps a cache that already fits', () => {
    expect(selectChatRecordCacheEvictions([clean('a', 10), clean('b', 10)], 100)).toEqual([])
  })

  it('drops least-recently-used entries first until the budget fits', () => {
    // Insertion order IS recency order: the store re-inserts on every hit.
    const evicted = selectChatRecordCacheEvictions(
      [clean('oldest', 40), clean('middle', 40), clean('newest', 40)],
      100
    )
    expect(evicted).toEqual(['oldest'])
  })

  it('drops as many as the budget demands, never more', () => {
    const evicted = selectChatRecordCacheEvictions(
      [clean('a', 40), clean('b', 40), clean('c', 40)],
      50
    )
    expect(evicted).toEqual(['a', 'b'])
  })

  it('never evicts a dirty record — it is the only copy not yet on disk', () => {
    // The whole corpus is over budget and the oldest entry is unflushed.
    const evicted = selectChatRecordCacheEvictions(
      [dirty('unflushed', 400), clean('clean-a', 40), clean('clean-b', 40)],
      50
    )
    expect(evicted).toEqual(['clean-a', 'clean-b'])
    expect(evicted).not.toContain('unflushed')
  })

  it('gives up rather than evicting dirty records when only they remain', () => {
    expect(selectChatRecordCacheEvictions([dirty('a', 400), dirty('b', 400)], 50)).toEqual([])
  })

  it('ships a budget that bounds a real corpus well below its parsed footprint', () => {
    // A 1.16GB on-disk corpus parsed at 3-5x is what pinned ~4GB in main.
    expect(CHAT_RECORD_CACHE_MAX_BYTES).toBeLessThan(1_160_000_000)
    expect(CHAT_RECORD_CACHE_MAX_BYTES).toBeGreaterThan(64 * 1024 * 1024)
  })
})
