import { describe, it, expect } from 'vitest'
import type { ActiveGoal, EnsembleBossmanReviewGate } from './store/types'
import { gateBlocksActiveGoal, gateBoundToActiveGoal } from './ReviewGateScope'

const GOAL: Pick<ActiveGoal, 'id' | 'createdAt'> = {
  id: 'goal-active',
  createdAt: '2026-07-12T09:00:00.000Z'
}

function gate(
  overrides: Partial<Pick<EnsembleBossmanReviewGate, 'status' | 'goalId' | 'createdAt'>>
): Pick<EnsembleBossmanReviewGate, 'status' | 'goalId' | 'createdAt'> {
  return { status: 'required', createdAt: '2026-07-12T10:00:00.000Z', ...overrides }
}

describe('gateBlocksActiveGoal — C2 shared gate-scope predicate', () => {
  it('blocks: required gate stamped with the active goal id', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'required', goalId: 'goal-active' }), GOAL)).toBe(true)
  })

  it('blocks: failed gate stamped with the active goal id', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'failed', goalId: 'goal-active' }), GOAL)).toBe(true)
  })

  it('does NOT block: passed (resolved) gate even for the active goal', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'passed', goalId: 'goal-active' }), GOAL)).toBe(false)
  })

  it('does NOT block: waived gate', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'waived', goalId: 'goal-active' }), GOAL)).toBe(false)
  })

  it('does NOT block: required gate stamped for a DIFFERENT goal', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'required', goalId: 'goal-other' }), GOAL)).toBe(false)
  })

  it('does NOT block when there is no active goal', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'required', goalId: 'goal-active' }), null)).toBe(false)
    expect(gateBlocksActiveGoal(gate({ status: 'required', goalId: 'goal-active' }), undefined)).toBe(false)
  })

  // LEGACY (absent goalId) — ISO createdAt supersession, evidence never deleted.
  it('legacy (no goalId): gate created AT/AFTER the active goal ⇒ blocks (current)', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'required', createdAt: '2026-07-12T10:00:00.000Z' }), GOAL)).toBe(true)
  })

  it('legacy (no goalId): gate created BEFORE the active goal ⇒ SUPERSEDED (non-blocking)', () => {
    // This is the live O3-stuck-gate case: a pre-C2 gate from an older goal must
    // not block a newer goal's completion.
    expect(gateBlocksActiveGoal(gate({ status: 'required', createdAt: '2026-07-12T08:00:00.000Z' }), GOAL)).toBe(false)
  })

  it('legacy (no goalId): equal createdAt ⇒ bound (>=)', () => {
    expect(gateBlocksActiveGoal(gate({ status: 'required', createdAt: GOAL.createdAt }), GOAL)).toBe(true)
  })
})

describe('gateBoundToActiveGoal', () => {
  it('goalId is authoritative over createdAt (newer stale-goal gate still unbound)', () => {
    expect(gateBoundToActiveGoal({ goalId: 'goal-other', createdAt: '2026-07-12T23:00:00.000Z' }, GOAL)).toBe(false)
    expect(gateBoundToActiveGoal({ goalId: 'goal-active', createdAt: '2026-07-12T01:00:00.000Z' }, GOAL)).toBe(true)
  })

  it('no active goal ⇒ never bound', () => {
    expect(gateBoundToActiveGoal({ goalId: 'goal-active', createdAt: GOAL.createdAt }, null)).toBe(false)
  })
})
