import { describe, expect, it } from 'vitest'
import {
  decideLoopContinuation,
  loopBudgetExhausted,
  makeLoopBudget,
  markLoopTruncated,
  recordLoopSpend,
  type WorkflowLoopAcceptance,
  type WorkflowLoopBudget,
  type WorkflowLoopVerdict
} from './WorkflowLoopModel'

const budget = (over: Partial<WorkflowLoopBudget> = {}): WorkflowLoopBudget => ({
  maxRuns: 10,
  spentRuns: 0,
  spentTokens: 0,
  spentCostUsd: 0,
  truncated: false,
  ...over
})

const accept = (over: Partial<WorkflowLoopAcceptance> = {}): WorkflowLoopAcceptance => ({
  maxIterations: 5,
  ...over
})

describe('WorkflowLoopBudget', () => {
  it('makeLoopBudget seeds counters at 0 + clamps maxRuns to >= 1', () => {
    expect(makeLoopBudget({ maxRuns: 4, maxTokens: 1000 })).toEqual({
      maxRuns: 4,
      maxTokens: 1000,
      spentRuns: 0,
      spentTokens: 0,
      spentCostUsd: 0,
      truncated: false
    })
    expect(makeLoopBudget({ maxRuns: 0 }).maxRuns).toBe(1)
    expect(makeLoopBudget({ maxRuns: -3 }).maxRuns).toBe(1)
    // No token/cost cap → those keys are absent (treated as "no cap").
    expect(makeLoopBudget({ maxRuns: 2 }).maxTokens).toBeUndefined()
  })

  it('recordLoopSpend accumulates + ignores NaN/undefined', () => {
    let b = makeLoopBudget({ maxRuns: 10, maxTokens: 5000, maxCostUsd: 1 })
    b = recordLoopSpend(b, { runs: 1, tokens: 1200, costUsd: 0.3 })
    b = recordLoopSpend(b, { runs: 1, tokens: Number.NaN, costUsd: undefined })
    expect(b.spentRuns).toBe(2)
    expect(b.spentTokens).toBe(1200)
    expect(b.spentCostUsd).toBeCloseTo(0.3)
  })

  it('loopBudgetExhausted trips on runs, tokens, or cost', () => {
    expect(loopBudgetExhausted(budget({ maxRuns: 3, spentRuns: 3 }))).toBe(true)
    expect(loopBudgetExhausted(budget({ maxRuns: 3, spentRuns: 2 }))).toBe(false)
    expect(loopBudgetExhausted(budget({ maxTokens: 1000, spentTokens: 1000 }))).toBe(true)
    expect(loopBudgetExhausted(budget({ maxCostUsd: 0.5, spentCostUsd: 0.6 }))).toBe(true)
    // A 0 token/cost cap is "no cap" (only maxRuns is unconditional).
    expect(loopBudgetExhausted(budget({ maxTokens: 0, spentTokens: 9999 }))).toBe(false)
  })

  it('markLoopTruncated flags without mutating the input', () => {
    const b = budget()
    expect(markLoopTruncated(b).truncated).toBe(true)
    expect(b.truncated).toBe(false)
  })
})

describe('decideLoopContinuation', () => {
  const verdict = (over: Partial<WorkflowLoopVerdict> & { decision: WorkflowLoopVerdict['decision'] }) =>
    ({ ...over }) as WorkflowLoopVerdict

  it('accept stops the loop (accepted) even if budget/iterations remain', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 1,
        acceptance: accept({ maxIterations: 10 }),
        budget: budget(),
        latestVerdict: verdict({ decision: 'accept' })
      })
    ).toEqual({ kind: 'stop', reason: 'accepted' })
  })

  it('accept WINS even when budget is exhausted on the same tick (decisive verdict first)', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 9,
        acceptance: accept({ maxIterations: 3 }),
        budget: budget({ maxRuns: 2, spentRuns: 2 }),
        latestVerdict: verdict({ decision: 'accept' })
      }).reason
    ).toBe('accepted')
  })

  it('reject stops the loop (rejected)', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 1,
        acceptance: accept(),
        budget: budget(),
        latestVerdict: verdict({ decision: 'reject', evidence: 'fundamentally wrong approach' })
      })
    ).toEqual({ kind: 'stop', reason: 'rejected' })
  })

  it('revise WITH evidence continues', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 1,
        acceptance: accept(),
        budget: budget(),
        latestVerdict: verdict({ decision: 'revise', evidence: 'test foo still fails: <trace>' })
      })
    ).toEqual({ kind: 'continue', reason: 'continue' })
  })

  it('revise WITHOUT evidence stops inconclusive (evidence-anchor rule — no blind looping)', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 1,
        acceptance: accept(),
        budget: budget(),
        latestVerdict: verdict({ decision: 'revise', evidence: '   ' })
      })
    ).toEqual({ kind: 'stop', reason: 'inconclusive' })
  })

  it('maker-only loop (no verifier) continues until a ceiling', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 2,
        acceptance: accept({ maxIterations: 5 }),
        budget: budget(),
        latestVerdict: null
      })
    ).toEqual({ kind: 'continue', reason: 'continue' })
  })

  it('stops at the hard iteration backstop', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 5,
        acceptance: accept({ maxIterations: 5 }),
        budget: budget(),
        latestVerdict: null
      })
    ).toEqual({ kind: 'stop', reason: 'max_iterations' })
  })

  it('stops on cumulative budget BEFORE the iteration backstop (budget checked first)', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 5,
        acceptance: accept({ maxIterations: 5 }),
        budget: budget({ maxRuns: 4, spentRuns: 4 }),
        latestVerdict: null
      }).reason
    ).toBe('budget_exhausted')
  })

  it('a verifier that never accepts still terminates (revise+evidence capped by maxIterations)', () => {
    // The loop keeps getting actionable revise verdicts, but the hard backstop fires.
    const reviseForever = verdict({ decision: 'revise', evidence: 'still failing' })
    expect(
      decideLoopContinuation({
        iterationsCompleted: 3,
        acceptance: accept({ maxIterations: 3 }),
        budget: budget(),
        latestVerdict: reviseForever
      })
    ).toEqual({ kind: 'stop', reason: 'max_iterations' })
  })

  it('clamps a non-positive maxIterations to 1 (never unbounded)', () => {
    expect(
      decideLoopContinuation({
        iterationsCompleted: 1,
        acceptance: accept({ maxIterations: 0 }),
        budget: budget(),
        latestVerdict: null
      })
    ).toEqual({ kind: 'stop', reason: 'max_iterations' })
  })
})
