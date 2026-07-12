import type { ActiveGoal, EnsembleBossmanReviewGate } from './store/types'

/**
 * C2 — the SINGLE source of truth for whether a Bossman review gate blocks the
 * ACTIVE goal's completion.
 *
 * EVERY consumer IMPORTS this predicate and none re-inlines the status test:
 *   1) EnsembleOrchestrator.activeBossmanReviewGateBlocks (+ its 3 callers, incl.
 *      the binding-poll gate_blocked branch),
 *   2) index.ts goal_complete gate check (both the `.some` block test and the
 *      `.filter` error listing — a HARD FORK that does NOT call the orchestrator
 *      method),
 *   3) EnsemblePrompt "Review gates:" surfacing (the VISIBLE symptom of pain #2 —
 *      a resolved/superseded gate must disappear from the rendered list).
 *
 * Sharing one predicate kills the twin-drift class Adversary1#2/A4 flagged, on a
 * completion-blocking (security-relevant) floor — the same one-source-of-truth
 * discipline C1's shared quota evaluator used. Pure / no I/O.
 */

/**
 * Is this gate bound to (created for) the active goal? `goalId` is the authority.
 * A LEGACY gate without a goalId falls back to an ISO `createdAt` comparison: a
 * gate created BEFORE the active goal is SUPERSEDED (non-blocking); its evidence
 * is retained, never deleted (Boss clause 4). Both timestamps are ISO-8601 UTC
 * strings, so a lexicographic compare is chronological.
 */
export function gateBoundToActiveGoal(
  gate: Pick<EnsembleBossmanReviewGate, 'goalId' | 'createdAt'>,
  activeGoal: Pick<ActiveGoal, 'id' | 'createdAt'> | null | undefined
): boolean {
  if (!activeGoal) return false // no active goal to bind/complete against
  if (gate.goalId) return gate.goalId === activeGoal.id
  return gate.createdAt >= activeGoal.createdAt
}

/**
 * Does this gate BLOCK completion of the active goal? It must be required/failed
 * AND bound to the active goal. A passed/waived gate — or one superseded by a
 * newer goal — never blocks.
 */
export function gateBlocksActiveGoal(
  gate: Pick<EnsembleBossmanReviewGate, 'status' | 'goalId' | 'createdAt'>,
  activeGoal: Pick<ActiveGoal, 'id' | 'createdAt'> | null | undefined
): boolean {
  return (
    (gate.status === 'required' || gate.status === 'failed') &&
    gateBoundToActiveGoal(gate, activeGoal)
  )
}
