import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DELEGATION_APPROVAL_BUDGET,
  DELEGATION_APPROVAL_BUDGET_ENV,
  DelegationApprovalBudgetGuard,
  delegationApprovalBudgetExhaustedMessage,
  resolveDelegationApprovalBudget
} from './DelegationApprovalBudgetGuard'

describe('resolveDelegationApprovalBudget', () => {
  it('falls back to the default when unset or blank', () => {
    expect(resolveDelegationApprovalBudget({})).toBe(DEFAULT_DELEGATION_APPROVAL_BUDGET)
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: '' })).toBe(
      DEFAULT_DELEGATION_APPROVAL_BUDGET
    )
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: '   ' })).toBe(
      DEFAULT_DELEGATION_APPROVAL_BUDGET
    )
  })

  it('honours a valid override and floors fractions', () => {
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: '5' })).toBe(5)
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: '4.9' })).toBe(4)
  })

  it('honours 0 as a kill switch', () => {
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: '0' })).toBe(0)
  })

  it('falls back for malformed / negative / non-finite values', () => {
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: '-3' })).toBe(
      DEFAULT_DELEGATION_APPROVAL_BUDGET
    )
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: 'nope' })).toBe(
      DEFAULT_DELEGATION_APPROVAL_BUDGET
    )
    expect(resolveDelegationApprovalBudget({ [DELEGATION_APPROVAL_BUDGET_ENV]: 'Infinity' })).toBe(
      DEFAULT_DELEGATION_APPROVAL_BUDGET
    )
  })
})

describe('DelegationApprovalBudgetGuard — delegation-loop anti-spam', () => {
  // Mirror the index.ts delegation gate: consume a slot per attempt;
  // an `exhausted` decision short-circuits to the decline tool_result
  // WITHOUT spawning a sub-thread (no modal, no provider run).
  function simulateDelegationAttempt(
    guard: DelegationApprovalBudgetGuard,
    parentRunId: string
  ): { spawned: boolean; toolResult?: string } {
    const decision = guard.tryConsume(parentRunId)
    if (decision === 'exhausted') {
      return {
        spawned: false,
        toolResult: delegationApprovalBudgetExhaustedMessage('Codex', 'Claude', guard.cap())
      }
    }
    return { spawned: true }
  }

  it('allows delegations up to the cap, then blocks the runaway loop', () => {
    const guard = new DelegationApprovalBudgetGuard(3)
    const parentRunId = 'run-parent-1'

    // A runaway agent calls delegate_to_subthread six times in one turn
    // (all under the same parent run id).
    const outcomes = Array.from({ length: 6 }, () =>
      simulateDelegationAttempt(guard, parentRunId)
    )

    // First 3 spawn; every attempt past the cap is blocked.
    expect(outcomes.slice(0, 3).every((o) => o.spawned)).toBe(true)
    expect(outcomes.slice(3).every((o) => o.spawned === false)).toBe(true)
    expect(outcomes[3].toolResult).toContain('delegation-approval budget (3)')
    expect(outcomes[3].toolResult).toContain('Claude')
  })

  it('scopes the budget per parent run — a new turn starts fresh', () => {
    const guard = new DelegationApprovalBudgetGuard(2)
    // Exhaust run A.
    expect(simulateDelegationAttempt(guard, 'run-A').spawned).toBe(true)
    expect(simulateDelegationAttempt(guard, 'run-A').spawned).toBe(true)
    expect(simulateDelegationAttempt(guard, 'run-A').spawned).toBe(false)
    // A different parent run (next turn) carries its own budget.
    expect(simulateDelegationAttempt(guard, 'run-B').spawned).toBe(true)
  })

  it('reports remaining slots and resets a run on demand', () => {
    const guard = new DelegationApprovalBudgetGuard(2)
    expect(guard.remaining('run-1')).toBe(2)
    guard.tryConsume('run-1')
    expect(guard.remaining('run-1')).toBe(1)
    guard.tryConsume('run-1')
    expect(guard.tryConsume('run-1')).toBe('exhausted')
    guard.reset('run-1')
    expect(guard.remaining('run-1')).toBe(2)
    expect(guard.tryConsume('run-1')).toBe('allowed')
  })

  it('release refunds reserved slots so a denied wave can be retried', () => {
    const guard = new DelegationApprovalBudgetGuard(4)
    expect(guard.tryConsume('run-wave')).toBe('allowed')
    expect(guard.tryConsume('run-wave')).toBe('allowed')
    expect(guard.remaining('run-wave')).toBe(2)
    guard.release('run-wave', 2)
    expect(guard.remaining('run-wave')).toBe(4)
    expect(guard.tryConsume('run-wave')).toBe('allowed')
  })

  it('release clamps at zero and ignores empty keys', () => {
    const guard = new DelegationApprovalBudgetGuard(1)
    guard.release('never-consumed', 3)
    expect(guard.remaining('never-consumed')).toBe(1)
    guard.tryConsume('')
    guard.release('', 1)
    expect(guard.tryConsume('')).toBe('allowed')
  })

  it('treats an empty parent-run key as unscoped (never blocks)', () => {
    const guard = new DelegationApprovalBudgetGuard(1)
    expect(guard.tryConsume('')).toBe('allowed')
    expect(guard.tryConsume('')).toBe('allowed')
  })

  it('a 0 cap blocks every delegation (kill switch)', () => {
    const guard = new DelegationApprovalBudgetGuard(0)
    expect(simulateDelegationAttempt(guard, 'run-x').spawned).toBe(false)
  })
})
