// Stage 2 slice 1 — the PURE decision brain + config types for a generalized
// workflow LOOP (maker→verifier iterations until structured acceptance / budget).
// This is the testable seed of the shared loop engine: the AuditOrchestrator is
// ALREADY a durable maker/verifier loop, but its DAG is hand-unrolled control flow
// and its budget/acceptance vocabulary is audit-specific (findings/verdicts). This
// module lifts the two GENERAL primitives out — a cumulative cross-iteration budget
// (generalizing AuditRunModel's agent/token ceiling) and a pure stop-predicate —
// so the loop's every branch unit-tests under plain vitest with no Electron / no
// dispatch (mirroring WorkflowBudgetGuard.ts + WorkflowRunStore.ts landing first).
//
// SCOPE: pure model only. NO engine class, NO dispatch/spawn wiring, NO scheduler
// branch, NO WorkflowDefinition plumbing, NO ledger I/O, NO AuditOrchestrator
// refactor — those are later slices. Nothing here imports electron or AppStore.

import type {
  ProviderId,
  WorkflowLoopAcceptance,
  WorkflowLoopConfig,
  WorkflowLoopLimits
} from './store/types'

// The persisted loop CONFIG types live in store/types (the home for everything on
// WorkflowDefinition). Re-exported here so the engine + callers keep importing them
// from the model alongside the budget/decision primitives.
export type { WorkflowLoopAcceptance, WorkflowLoopConfig, WorkflowLoopLimits }

// ----------------------------------------------------------------------------
// Cumulative budget (live state). Generalizes AuditRunModel.makeBudget/
// recordSpend/budgetExhausted/markTruncated — agents become runs, plus an
// explicit cost ceiling.
// ----------------------------------------------------------------------------

export interface WorkflowLoopBudget extends WorkflowLoopLimits {
  spentRuns: number
  spentTokens: number
  spentCostUsd: number
  /** Set when a ceiling was hit and the loop stopped early (vs a clean accept). */
  truncated: boolean
}

export function makeLoopBudget(limits: WorkflowLoopLimits): WorkflowLoopBudget {
  return {
    maxRuns: Math.max(1, Math.floor(limits.maxRuns) || 1),
    ...(typeof limits.maxTokens === 'number' ? { maxTokens: limits.maxTokens } : {}),
    ...(typeof limits.maxCostUsd === 'number' ? { maxCostUsd: limits.maxCostUsd } : {}),
    spentRuns: 0,
    spentTokens: 0,
    spentCostUsd: 0,
    truncated: false
  }
}

/** Add one run's spend. Pure — returns a new budget (NaN-defensive for the hot
 * path, mirroring evaluateTokenCostBudget). */
export function recordLoopSpend(
  budget: WorkflowLoopBudget,
  spend: { runs?: number; tokens?: number; costUsd?: number }
): WorkflowLoopBudget {
  const add = (base: number, delta: number | undefined): number =>
    base + (typeof delta === 'number' && Number.isFinite(delta) ? delta : 0)
  return {
    ...budget,
    spentRuns: add(budget.spentRuns, spend.runs),
    spentTokens: add(budget.spentTokens, spend.tokens),
    spentCostUsd: add(budget.spentCostUsd, spend.costUsd)
  }
}

/** True once any ceiling is met. A positive cap of 0 is treated as "no cap" for
 * tokens/cost (mirrors hasAnyBudget semantics); maxRuns always applies. */
export function loopBudgetExhausted(budget: WorkflowLoopBudget): boolean {
  if (budget.spentRuns >= budget.maxRuns) return true
  if (
    typeof budget.maxTokens === 'number' &&
    budget.maxTokens > 0 &&
    budget.spentTokens >= budget.maxTokens
  ) {
    return true
  }
  if (
    typeof budget.maxCostUsd === 'number' &&
    budget.maxCostUsd > 0 &&
    budget.spentCostUsd >= budget.maxCostUsd
  ) {
    return true
  }
  return false
}

export function markLoopTruncated(budget: WorkflowLoopBudget): WorkflowLoopBudget {
  return { ...budget, truncated: true }
}

// ----------------------------------------------------------------------------
// Verifier verdict — generalizes the audit's evidence-anchored accept/downgrade/
// refute (resolveFindingVerdictState) to a per-iteration loop verdict.
// ----------------------------------------------------------------------------

export type WorkflowLoopVerdictDecision = 'accept' | 'revise' | 'reject'

export interface WorkflowLoopVerdict {
  decision: WorkflowLoopVerdictDecision
  /** Required to JUSTIFY a 'revise' that continues the loop — the evidence-anchor
   * rule (mirrors the audit's refute-needs-counterEvidence). A 'revise' with no
   * actionable evidence does NOT drive another pass (stops 'inconclusive'), so a
   * verifier can never loop the maker forever on unsupported feedback. */
  evidence?: string
  rationale?: string
}

// ----------------------------------------------------------------------------
// The pure stop-predicate — the loop driver. Called AFTER an iteration completes
// to decide whether to run another. Every branch is fail-safe bounded.
// ----------------------------------------------------------------------------

export interface WorkflowLoopState {
  /** Maker iterations COMPLETED so far (>= 1 when this is called). */
  iterationsCompleted: number
  acceptance: WorkflowLoopAcceptance
  budget: WorkflowLoopBudget
  /** The latest verifier verdict, or null when no verifier ran (maker-only loop —
   * bounded purely by maxIterations + budget). */
  latestVerdict: WorkflowLoopVerdict | null
}

export type WorkflowLoopStopReason =
  | 'accepted' // verifier accepted the maker's output
  | 'rejected' // verifier hard-rejected (don't burn more iterations)
  | 'inconclusive' // verifier said revise but cited no actionable evidence
  | 'max_iterations' // hit the hard iteration backstop
  | 'budget_exhausted' // hit the cumulative budget ceiling

export interface WorkflowLoopDecision {
  kind: 'continue' | 'stop'
  reason: WorkflowLoopStopReason | 'continue'
}

/**
 * Decide whether a loop should run another maker iteration. Order is deliberate:
 *  1. A DECISIVE verifier verdict (accept / reject) ends the loop regardless of
 *     remaining budget — a clean accept must not be masked by a coincident ceiling.
 *  2. A 'revise' WITHOUT evidence stops 'inconclusive' (evidence-anchor rule) — no
 *     actionable feedback to drive a useful next pass.
 *  3. Otherwise we WOULD continue (maker-only, or revise-with-evidence) — the
 *     fail-safe ceilings cap it: cumulative budget first, then the hard iteration
 *     backstop. A misconfigured verifier that never accepts still terminates here.
 */
export function decideLoopContinuation(state: WorkflowLoopState): WorkflowLoopDecision {
  const verdict = state.latestVerdict
  if (verdict?.decision === 'accept') return { kind: 'stop', reason: 'accepted' }
  if (verdict?.decision === 'reject') return { kind: 'stop', reason: 'rejected' }
  if (verdict?.decision === 'revise' && !(verdict.evidence && verdict.evidence.trim().length > 0)) {
    return { kind: 'stop', reason: 'inconclusive' }
  }
  if (loopBudgetExhausted(state.budget)) return { kind: 'stop', reason: 'budget_exhausted' }
  if (state.iterationsCompleted >= Math.max(1, Math.floor(state.acceptance.maxIterations) || 1)) {
    return { kind: 'stop', reason: 'max_iterations' }
  }
  return { kind: 'continue', reason: 'continue' }
}

// ----------------------------------------------------------------------------
// Normalize / sanitize a persisted loop config (slice 4) — called by the store's
// normalizeWorkflowDefinitionRecord on save/update. FAIL-SAFE: a present-but-
// malformed config still yields a bounded maxIterations + maxRuns (never
// unbounded); an absent / non-object config → undefined (the workflow runs as a
// single occurrence, the existing path).
// ----------------------------------------------------------------------------

const DEFAULT_LOOP_MAX_ITERATIONS = 3

function clampPositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export function normalizeWorkflowLoopConfig(raw: unknown): WorkflowLoopConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { acceptance?: unknown; limits?: unknown }
  // A loop MUST declare acceptance (the maxIterations backstop) — without it the
  // config is treated as absent (single-occurrence), never as an unbounded loop.
  if (!r.acceptance || typeof r.acceptance !== 'object') return undefined
  const acc = r.acceptance as { maxIterations?: unknown; verifier?: unknown }
  const maxIterations = clampPositiveInt(acc.maxIterations, DEFAULT_LOOP_MAX_ITERATIONS)
  const acceptance: WorkflowLoopAcceptance = { maxIterations }
  if (acc.verifier && typeof acc.verifier === 'object') {
    const provider = (acc.verifier as { provider?: unknown }).provider
    // Keep a string provider hint; the dispatch path (slice 5) validates it's a
    // live ProviderId. Absent → verifier with no provider preference.
    acceptance.verifier =
      typeof provider === 'string' && provider ? { provider: provider as ProviderId } : {}
  }
  const lim = (r.limits && typeof r.limits === 'object' ? r.limits : {}) as {
    maxRuns?: unknown
    maxTokens?: unknown
    maxCostUsd?: unknown
  }
  const maxTokens = optionalPositiveNumber(lim.maxTokens)
  const maxCostUsd = optionalPositiveNumber(lim.maxCostUsd)
  const limits: WorkflowLoopLimits = {
    // Default ceiling: 2 runs per iteration (one maker + one verifier).
    maxRuns: clampPositiveInt(lim.maxRuns, maxIterations * 2),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {})
  }
  return { acceptance, limits }
}
