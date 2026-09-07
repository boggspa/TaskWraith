import { describe, expect, it } from 'vitest'
import {
  orderSweepStatsByRecency,
  planSweepSlices,
  truncateSweepToBudget,
  type SweepFileStat
} from './BootSweepBudget'

const MB = 1024 * 1024

function stat(chatId: string, mtimeMs: number, size: number = MB): SweepFileStat {
  return { chatId, mtimeMs, size }
}

describe('orderSweepStatsByRecency', () => {
  it('orders most-recently modified first', () => {
    const ordered = orderSweepStatsByRecency([stat('old', 100), stat('new', 300), stat('mid', 200)])
    expect(ordered.map((s) => s.chatId)).toEqual(['new', 'mid', 'old'])
  })

  it('breaks mtime ties by chat id for a deterministic boot order', () => {
    const ordered = orderSweepStatsByRecency([stat('b', 100), stat('a', 100)])
    expect(ordered.map((s) => s.chatId)).toEqual(['a', 'b'])
  })

  it('sorts unreadable mtimes last and drops empty ids', () => {
    const ordered = orderSweepStatsByRecency([
      stat('unstatted', Number.NaN),
      stat('', 999),
      stat('known', 100)
    ])
    expect(ordered.map((s) => s.chatId)).toEqual(['known', 'unstatted'])
  })
})

describe('truncateSweepToBudget', () => {
  it('takes the most recent chats up to the count bound', () => {
    const stats = orderSweepStatsByRecency([stat('a', 100), stat('b', 200), stat('c', 300)])
    const taken = truncateSweepToBudget(stats, { maxChats: 2, maxBytes: 1024 * MB })
    expect(taken.map((s) => s.chatId)).toEqual(['c', 'b'])
  })

  it('stops at the byte bound even when the count bound allows more', () => {
    const stats = orderSweepStatsByRecency([
      stat('a', 100, 40 * MB),
      stat('b', 200, 40 * MB),
      stat('c', 300, 1 * MB)
    ])
    const taken = truncateSweepToBudget(stats, { maxChats: 25, maxBytes: 64 * MB })
    expect(taken.map((s) => s.chatId)).toEqual(['c', 'b'])
  })

  it('always covers the most recent chat, even past the byte budget', () => {
    const stats = orderSweepStatsByRecency([stat('jumbo', 200, 250 * MB), stat('a', 100, MB)])
    const taken = truncateSweepToBudget(stats, { maxChats: 25, maxBytes: 64 * MB })
    expect(taken.map((s) => s.chatId)).toEqual(['jumbo'])
  })

  it('returns nothing for an empty candidate set', () => {
    expect(truncateSweepToBudget([], { maxChats: 25, maxBytes: 64 * MB })).toEqual([])
  })
})

describe('planSweepSlices', () => {
  it('packs slices to the byte cap in recency order', () => {
    const stats = [stat('a', 300, 10 * MB), stat('b', 200, 10 * MB), stat('c', 100, 10 * MB)]
    const slices = planSweepSlices(stats, 16 * MB)
    expect(slices.map((slice) => slice.map((s) => s.chatId))).toEqual([['a'], ['b'], ['c']])
  })

  it('gives an over-budget chat a slice of its own instead of stalling', () => {
    const stats = [stat('jumbo', 200, 250 * MB), stat('a', 100, MB)]
    const slices = planSweepSlices(stats, 16 * MB)
    expect(slices.map((slice) => slice.map((s) => s.chatId))).toEqual([['jumbo'], ['a']])
  })

  it('returns no slices for an empty candidate set', () => {
    expect(planSweepSlices([], 16 * MB)).toEqual([])
  })
})
