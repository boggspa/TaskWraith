import { describe, expect, it } from 'vitest'

import { ChatListRebuildMemo, CHAT_LIST_REBUILD_MEMO_MAX_ENTRIES } from './ChatListRebuildMemo'

const stat = (mtimeMs: number, size: number) => ({ mtimeMs, size })

describe('chat list rebuild memo', () => {
  it('returns the row derived from exactly these bytes', () => {
    const memo = new ChatListRebuildMemo<string>()
    memo.set('a', stat(10, 100), 'row-a')

    expect(memo.get('a', stat(10, 100))).toBe('row-a')
  })

  it('misses an unknown chat', () => {
    expect(new ChatListRebuildMemo<string>().get('nope', stat(1, 1))).toBeUndefined()
  })

  it('misses when the file was rewritten (mtime moved)', () => {
    const memo = new ChatListRebuildMemo<string>()
    memo.set('a', stat(10, 100), 'row-a')

    expect(memo.get('a', stat(11, 100))).toBeUndefined()
  })

  it('misses when the file changed size at the same mtime', () => {
    const memo = new ChatListRebuildMemo<string>()
    memo.set('a', stat(10, 100), 'row-a')

    // A compaction that lands inside the same mtime tick must not serve the
    // pre-compaction row — this is the exact shape of the stale entries the
    // memo exists for.
    expect(memo.get('a', stat(10, 90))).toBeUndefined()
  })

  it('drops a stale entry instead of retaining a row that can never hit again', () => {
    const memo = new ChatListRebuildMemo<string>()
    memo.set('a', stat(10, 100), 'row-a')
    memo.get('a', stat(11, 100))

    expect(memo.size).toBe(0)
  })

  it('replaces the row when the same chat is rebuilt at a new stat', () => {
    const memo = new ChatListRebuildMemo<string>()
    memo.set('a', stat(10, 100), 'old')
    memo.set('a', stat(11, 90), 'new')

    expect(memo.get('a', stat(11, 90))).toBe('new')
    expect(memo.size).toBe(1)
  })

  it('bounds retention and evicts the coldest row first', () => {
    const memo = new ChatListRebuildMemo<string>(3)
    memo.set('a', stat(1, 1), 'a')
    memo.set('b', stat(1, 1), 'b')
    memo.set('c', stat(1, 1), 'c')
    memo.set('d', stat(1, 1), 'd')

    expect(memo.size).toBe(3)
    expect(memo.get('a', stat(1, 1))).toBeUndefined()
    expect(memo.get('d', stat(1, 1))).toBe('d')
  })

  it('keeps a row that is read every call from being the one evicted', () => {
    const memo = new ChatListRebuildMemo<string>(2)
    memo.set('hot', stat(1, 1), 'hot')
    memo.set('cold', stat(1, 1), 'cold')
    memo.get('hot', stat(1, 1)) // refreshes recency
    memo.set('new', stat(1, 1), 'new')

    expect(memo.get('hot', stat(1, 1))).toBe('hot')
    expect(memo.get('cold', stat(1, 1))).toBeUndefined()
  })

  it('forgets a single chat on demand', () => {
    const memo = new ChatListRebuildMemo<string>()
    memo.set('a', stat(1, 1), 'a')
    memo.delete('a')

    expect(memo.get('a', stat(1, 1))).toBeUndefined()
  })

  it('clears every retained row', () => {
    const memo = new ChatListRebuildMemo<string>()
    memo.set('a', stat(1, 1), 'a')
    memo.set('b', stat(1, 1), 'b')
    memo.clear()

    expect(memo.size).toBe(0)
  })

  it('defaults to a bound that covers a realistic corpus', () => {
    expect(CHAT_LIST_REBUILD_MEMO_MAX_ENTRIES).toBeGreaterThanOrEqual(448)
    const memo = new ChatListRebuildMemo<string>()
    for (let i = 0; i < CHAT_LIST_REBUILD_MEMO_MAX_ENTRIES + 10; i++) {
      memo.set(`chat-${i}`, stat(1, 1), `row-${i}`)
    }
    expect(memo.size).toBe(CHAT_LIST_REBUILD_MEMO_MAX_ENTRIES)
  })
})
