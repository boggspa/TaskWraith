import { describe, expect, it } from 'vitest'
import {
  budgetLastErrorMessage,
  evaluateTokenCostBudget,
  evaluateWallclockBudget,
  hasAnyBudget,
  type OccurrenceBudget
} from './WorkflowBudgetGuard'

const budget = (over: Partial<OccurrenceBudget> = {}): OccurrenceBudget => ({
  runId: 'run-1',
  scheduledTaskId: 'task-1',
  startedAtMs: 1_000_000,
  ...over
})

describe('hasAnyBudget', () => {
  it('is true only when at least one positive limit is set', () => {
    expect(hasAnyBudget({ timeoutSeconds: 60 })).toBe(true)
    expect(hasAnyBudget({ maxTokens: 1000 })).toBe(true)
    expect(hasAnyBudget({ maxCostUsd: 0.5 })).toBe(true)
  })

  it('is false for undefined / empty / non-positive limits', () => {
    expect(hasAnyBudget(undefined)).toBe(false)
    expect(hasAnyBudget({})).toBe(false)
    expect(hasAnyBudget({ timeoutSeconds: 0, maxTokens: 0, maxCostUsd: 0 })).toBe(false)
    expect(hasAnyBudget({ timeoutSeconds: -5 })).toBe(false)
    expect(hasAnyBudget({ maxTokens: Number.NaN })).toBe(false)
  })
})

describe('evaluateTokenCostBudget', () => {
  it('breaches tokens when total_tokens >= maxTokens', () => {
    expect(evaluateTokenCostBudget({ maxTokens: 1000 }, { total_tokens: 1000 })).toEqual({
      kind: 'tokens',
      limit: 1000,
      observed: 1000
    })
    expect(evaluateTokenCostBudget({ maxTokens: 1000 }, { total_tokens: 1500 })).toMatchObject({
      kind: 'tokens',
      observed: 1500
    })
  })

  it('returns null below the token limit', () => {
    expect(evaluateTokenCostBudget({ maxTokens: 1000 }, { total_tokens: 999 })).toBeNull()
  })

  it('breaches cost when total_cost_usd >= maxCostUsd', () => {
    expect(evaluateTokenCostBudget({ maxCostUsd: 0.5 }, { total_cost_usd: 0.5 })).toEqual({
      kind: 'cost',
      limit: 0.5,
      observed: 0.5
    })
  })

  it('reports the token breach first when both trip (tokens before the weaker cost signal)', () => {
    expect(
      evaluateTokenCostBudget(
        { maxTokens: 100, maxCostUsd: 0.1 },
        { total_tokens: 200, total_cost_usd: 1 }
      )
    ).toMatchObject({ kind: 'tokens' })
  })

  it('is defensive: missing / NaN / null usage never throws and reads as 0 (no breach)', () => {
    expect(evaluateTokenCostBudget({ maxTokens: 1000 }, undefined)).toBeNull()
    expect(evaluateTokenCostBudget({ maxTokens: 1000 }, null)).toBeNull()
    expect(evaluateTokenCostBudget({ maxTokens: 1000 }, {})).toBeNull()
    expect(
      evaluateTokenCostBudget({ maxTokens: 1000 }, { total_tokens: Number.NaN })
    ).toBeNull()
  })

  it('ignores non-positive limits (an unset budget never trips)', () => {
    expect(evaluateTokenCostBudget({ maxTokens: 0 }, { total_tokens: 9999 })).toBeNull()
    expect(evaluateTokenCostBudget({}, { total_tokens: 9999, total_cost_usd: 9999 })).toBeNull()
  })
})

describe('evaluateWallclockBudget', () => {
  it('breaches when elapsed >= timeoutSeconds', () => {
    const b = budget({ timeoutSeconds: 60, startedAtMs: 1_000_000 })
    expect(evaluateWallclockBudget(b, 1_060_000)).toEqual({
      kind: 'wallclock',
      limit: 60_000,
      observed: 60_000
    })
    expect(evaluateWallclockBudget(b, 1_120_000)).toMatchObject({ kind: 'wallclock' })
  })

  it('returns null before the deadline and when no timeout is set', () => {
    expect(evaluateWallclockBudget(budget({ timeoutSeconds: 60 }), 1_059_999)).toBeNull()
    expect(evaluateWallclockBudget(budget({ timeoutSeconds: undefined }), 9_999_999)).toBeNull()
  })
})

describe('budgetLastErrorMessage', () => {
  it('names the breach kind with observed / limit', () => {
    expect(budgetLastErrorMessage({ kind: 'wallclock', limit: 60_000, observed: 65_000 })).toContain(
      '65s / 60s'
    )
    expect(budgetLastErrorMessage({ kind: 'tokens', limit: 1000, observed: 1200 })).toContain(
      '1200 / 1000 tokens'
    )
    expect(budgetLastErrorMessage({ kind: 'cost', limit: 0.5, observed: 0.75 })).toContain(
      '$0.7500 / $0.50'
    )
  })
})
