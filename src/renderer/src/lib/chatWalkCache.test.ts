import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { createChatWalkCache, noWalkDepsEqual } from './chatWalkCache'

function chat(id: string): ChatRecord {
  return { appChatId: id, messages: [], runs: [] } as unknown as ChatRecord
}

describe('createChatWalkCache', () => {
  it('computes once per chat identity, reuses on repeat calls', () => {
    const compute = vi.fn((c: ChatRecord) => (c.messages?.length ?? 0) + 1)
    const cached = createChatWalkCache(compute, noWalkDepsEqual)
    const a = chat('a')

    expect(cached(a, {})).toBe(1)
    expect(cached(a, {})).toBe(1)
    expect(cached(a, {})).toBe(1)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('recomputes when the chat OBJECT identity changes (streaming frame)', () => {
    const compute = vi.fn((c: ChatRecord) => c.appChatId)
    const cached = createChatWalkCache(compute, noWalkDepsEqual)
    const first = chat('x')
    const second = chat('x') // same id, NEW object — as flushCoalescedChats produces

    cached(first, {})
    cached(second, {})
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('recomputes when secondary deps change even for the same chat object', () => {
    const compute = vi.fn((_c: ChatRecord, deps: { rates: object }) => deps.rates)
    const cached = createChatWalkCache(compute, (p, n) => p.rates === n.rates)
    const a = chat('a')
    const ratesA = {}
    const ratesB = {}

    cached(a, { rates: ratesA })
    cached(a, { rates: ratesA }) // same deps → cached
    cached(a, { rates: ratesB }) // changed deps → recompute
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('keeps separate entries per chat', () => {
    const compute = vi.fn((c: ChatRecord) => c.appChatId)
    const cached = createChatWalkCache(compute, noWalkDepsEqual)
    const a = chat('a')
    const b = chat('b')
    expect(cached(a, {})).toBe('a')
    expect(cached(b, {})).toBe('b')
    expect(cached(a, {})).toBe('a')
    expect(compute).toHaveBeenCalledTimes(2)
  })
})
