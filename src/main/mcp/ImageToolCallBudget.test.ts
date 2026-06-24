import { describe, it, expect } from 'vitest'
import {
  ImageToolCallBudget,
  DEFAULT_MAX_IMAGE_TOOL_CALLS_PER_RUN
} from './ImageToolCallBudget'

describe('ImageToolCallBudget', () => {
  it('allows exactly the cap then rejects every subsequent call', () => {
    const budget = new ImageToolCallBudget(3)
    expect(budget.tryConsume('run1')).toBe(true) // 1
    expect(budget.tryConsume('run1')).toBe(true) // 2
    expect(budget.tryConsume('run1')).toBe(true) // 3 (at cap)
    expect(budget.tryConsume('run1')).toBe(false) // 4 — over
    expect(budget.tryConsume('run1')).toBe(false) // stays rejected
  })

  it('matches the historical boundary: 100 calls pass, the 101st is blocked', () => {
    const budget = new ImageToolCallBudget() // default cap = 100
    expect(DEFAULT_MAX_IMAGE_TOOL_CALLS_PER_RUN).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(budget.tryConsume('run')).toBe(true)
    }
    expect(budget.tryConsume('run')).toBe(false)
    expect(budget.getConsumed('run')).toBe(101) // attempts are always counted
  })

  it('tracks each run independently', () => {
    const budget = new ImageToolCallBudget(1)
    expect(budget.tryConsume('a')).toBe(true)
    expect(budget.tryConsume('a')).toBe(false)
    // A different run has its own fresh budget.
    expect(budget.tryConsume('b')).toBe(true)
  })

  it('evicts the oldest-inserted key when the key cap is exceeded', () => {
    const budget = new ImageToolCallBudget(5, 2) // at most 2 distinct run keys
    budget.tryConsume('a') // keys: {a}
    budget.tryConsume('b') // keys: {a,b}
    budget.tryConsume('c') // inserting c evicts oldest (a) → keys: {b,c}
    expect(budget.getConsumed('a')).toBe(0) // evicted → fresh
    expect(budget.getConsumed('b')).toBe(1)
    expect(budget.getConsumed('c')).toBe(1)
  })

  it('getConsumed reports the running count without consuming a slot', () => {
    const budget = new ImageToolCallBudget()
    budget.tryConsume('x')
    budget.tryConsume('x')
    expect(budget.getConsumed('x')).toBe(2)
    expect(budget.getConsumed('never-seen')).toBe(0)
  })

  it('treats a malformed (negative / non-finite) cap as 0 — fail closed', () => {
    expect(new ImageToolCallBudget(-5).tryConsume('r')).toBe(false)
    expect(new ImageToolCallBudget(Number.NaN).tryConsume('r')).toBe(false)
  })

  it('__reset clears all counts', () => {
    const budget = new ImageToolCallBudget(1)
    budget.tryConsume('r')
    expect(budget.tryConsume('r')).toBe(false)
    budget.__reset()
    expect(budget.tryConsume('r')).toBe(true)
  })
})
