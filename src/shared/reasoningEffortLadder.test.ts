import { describe, expect, it } from 'vitest'
import {
  REASONING_EFFORT_LADDER,
  compareReasoningEffort,
  isAboveXhighReasoningEffort,
  normalizeReasoningEffortToken,
  reasoningEffortRank,
  sortByReasoningEffortLadder
} from './reasoningEffortLadder'

describe('canonical reasoning-effort ladder', () => {
  it('places persistent strictly between ultracode and ultratask', () => {
    const ultracode = reasoningEffortRank('ultracode') as number
    const persistent = reasoningEffortRank('persistent') as number
    const ultratask = reasoningEffortRank('ultratask') as number
    expect(ultracode).toBeLessThan(persistent)
    expect(persistent).toBeLessThan(ultratask)
    // Adjacency matters: nothing may be inserted between them by accident.
    expect(persistent - ultracode).toBe(1)
    expect(ultratask - persistent).toBe(1)
  })

  it('keeps ultratask at the top of the ladder', () => {
    expect(REASONING_EFFORT_LADDER[REASONING_EFFORT_LADDER.length - 1]).toBe('ultratask')
  })

  it('spells the full ladder in ascending order', () => {
    expect([...REASONING_EFFORT_LADDER]).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
      'persistent',
      'ultratask'
    ])
  })

  it('resolves inbound aliases onto their rung', () => {
    expect(normalizeReasoningEffortToken('ultra')).toBe('ultracode')
    expect(normalizeReasoningEffortToken('  ULTRA  ')).toBe('ultracode')
    expect(normalizeReasoningEffortToken('light')).toBe('low')
    expect(normalizeReasoningEffortToken('off')).toBe('none')
    expect(normalizeReasoningEffortToken('extra')).toBe('xhigh')
    expect(normalizeReasoningEffortToken('maximum')).toBe('max')
    expect(normalizeReasoningEffortToken('ultraTask')).toBe('ultratask')
    expect(normalizeReasoningEffortToken('Persistent')).toBe('persistent')
  })

  it('reports off-ladder tokens as unranked rather than guessing', () => {
    expect(normalizeReasoningEffortToken('turbo')).toBeNull()
    expect(normalizeReasoningEffortToken('')).toBeNull()
    expect(normalizeReasoningEffortToken(null)).toBeNull()
    expect(reasoningEffortRank('turbo')).toBeNull()
  })

  it('sorts a shuffled ladder back into canonical order', () => {
    const shuffled = ['ultratask', 'low', 'persistent', 'xhigh', 'ultra', 'max', 'medium']
    expect(sortByReasoningEffortLadder(shuffled, (t) => t)).toEqual([
      'low',
      'medium',
      'xhigh',
      'max',
      'ultra',
      'persistent',
      'ultratask'
    ])
  })

  it('keeps unknown tiers last instead of dropping them', () => {
    const sorted = sortByReasoningEffortLadder(['turbo', 'persistent', 'low'], (t) => t)
    expect(sorted).toEqual(['low', 'persistent', 'turbo'])
    expect(sorted).toHaveLength(3)
  })

  it('is a stable sort for equal rungs', () => {
    const rows = [
      { id: 'a', effort: 'high' },
      { id: 'b', effort: 'high' },
      { id: 'c', effort: 'low' }
    ]
    expect(sortByReasoningEffortLadder(rows, (r) => r.effort).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b'
    ])
  })

  it('treats every tier above xhigh as above the wire ceiling', () => {
    for (const effort of ['max', 'ultra', 'ultracode', 'persistent', 'ultratask']) {
      expect(isAboveXhighReasoningEffort(effort)).toBe(true)
    }
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
      expect(isAboveXhighReasoningEffort(effort)).toBe(false)
    }
    expect(isAboveXhighReasoningEffort('turbo')).toBe(false)
  })

  it('orders pairs consistently', () => {
    expect(compareReasoningEffort('ultracode', 'persistent')).toBeLessThan(0)
    expect(compareReasoningEffort('persistent', 'ultratask')).toBeLessThan(0)
    expect(compareReasoningEffort('ultratask', 'persistent')).toBeGreaterThan(0)
    expect(compareReasoningEffort('high', 'high')).toBe(0)
  })
})
