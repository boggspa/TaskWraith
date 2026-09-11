import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './store/types'
import { TranscriptMediaScanMemo } from './TranscriptMediaScanMemo'

function message(id: string, content = `content-${id}`): ChatMessage {
  return { id, role: 'assistant', content, timestamp: '2026-09-11T17:50:00.000Z' } as ChatMessage
}

describe('TranscriptMediaScanMemo', () => {
  it('answers false until a row is marked, then true for that exact object', () => {
    const memo = new TranscriptMediaScanMemo()
    const row = message('a')
    expect(memo.isInert(row)).toBe(false)
    memo.markInert(row)
    expect(memo.isInert(row)).toBe(true)
  })

  it('keys on object identity, so a replaced row is re-inspected', () => {
    const memo = new TranscriptMediaScanMemo()
    const original = message('a', 'no image here')
    memo.markInert(original)
    // An edit replaces the object; the new one may now carry image syntax.
    const edited = { ...original, content: '![shot](./a.png)' } as ChatMessage
    expect(memo.isInert(edited)).toBe(false)
  })

  it('finds the first row that still needs inspecting', () => {
    const memo = new TranscriptMediaScanMemo()
    const rows = [message('a'), message('b'), message('c')]
    memo.markInert(rows[0]!)
    memo.markInert(rows[1]!)
    expect(memo.firstUnknownIndex(rows)).toBe(2)
  })

  it('returns -1 when every row is known inert, so the caller can skip the walk', () => {
    const memo = new TranscriptMediaScanMemo()
    const rows = [message('a'), message('b')]
    for (const row of rows) memo.markInert(row)
    expect(memo.firstUnknownIndex(rows)).toBe(-1)
  })

  it('collapses a repeated whole-transcript scan to a probe loop', () => {
    const memo = new TranscriptMediaScanMemo()
    const rows = Array.from({ length: 1_493 }, (_, index) => message(`m-${index}`))
    expect(memo.firstUnknownIndex(rows)).toBe(0)
    for (const row of rows) memo.markInert(row)
    memo.resetStats()
    expect(memo.firstUnknownIndex(rows)).toBe(-1)
    expect(memo.stats()).toEqual({ hits: 1_493, misses: 0 })

    // One appended row is the only thing the next save has to inspect.
    const appended = [...rows, message('m-1493')]
    memo.resetStats()
    expect(memo.firstUnknownIndex(appended)).toBe(1_493)
    expect(memo.stats().misses).toBe(1)
  })

  it('returns -1 for an empty transcript', () => {
    expect(new TranscriptMediaScanMemo().firstUnknownIndex([])).toBe(-1)
  })

  it('treats a missing row as unknown rather than throwing', () => {
    const memo = new TranscriptMediaScanMemo()
    expect(memo.isInert(null)).toBe(false)
    expect(memo.isInert(undefined)).toBe(false)
    memo.markInert(null)
    memo.markInert(undefined)
    expect(memo.firstUnknownIndex([null as unknown as ChatMessage])).toBe(0)
  })

  it('counts hits and misses so the memo’s own effectiveness is observable', () => {
    const memo = new TranscriptMediaScanMemo()
    const row = message('a')
    memo.isInert(row)
    memo.markInert(row)
    memo.isInert(row)
    memo.isInert(row)
    expect(memo.stats()).toEqual({ hits: 2, misses: 1 })
    memo.resetStats()
    expect(memo.stats()).toEqual({ hits: 0, misses: 0 })
  })
})
