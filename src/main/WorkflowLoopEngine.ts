// Stage 2 slice 2 — the WorkflowLoopEngine: drives maker→(verifier)→decide
// iterations using the pure WorkflowLoopModel brain (slice 1). Mirrors the
// AuditOrchestrator pattern (an injected dispatch seam + now/uuid/isCancelled/
// onState) so it unit-tests with a FAKE dispatchStep — no Electron, no real spawn.
// The real dispatchStep (slice 5) reuses dispatchRole/spawnAndAwait + the composer;
// this slice is pure orchestration over that seam.
//
// SCOPE: the engine + its DI surface only. NO real dispatch wiring, NO scheduler
// branch, NO ledger I/O, NO WorkflowDefinition plumbing, NO AuditOrchestrator
// refactor. Nothing here imports electron or AppStore.

import {
  decideLoopContinuation,
  loopBudgetExhausted,
  makeLoopBudget,
  markLoopTruncated,
  recordLoopSpend,
  type WorkflowLoopBudget,
  type WorkflowLoopConfig,
  type WorkflowLoopStopReason,
  type WorkflowLoopVerdict
} from './WorkflowLoopModel'

export type WorkflowLoopStepRole = 'maker' | 'verifier'

export interface WorkflowLoopStepInput {
  role: WorkflowLoopStepRole
  /** 1-based maker iteration this step belongs to. */
  iteration: number
  /** Unique id for this step's run (from deps.uuid). */
  runId: string
  /** The latest maker output, threaded forward — into the verifier's prompt (to
   * judge) and into the next maker's prompt (to revise). Undefined on iteration 1. */
  priorOutput?: string
  /** The latest verifier verdict, threaded into the next maker's prompt so it can
   * act on the revise feedback. Null when no verifier ran / first iteration. */
  priorVerdict?: WorkflowLoopVerdict | null
}

export interface WorkflowLoopStepResult {
  /** The run's final assistant text — the maker's work product, or verifier notes. */
  output?: string
  /** The verifier's structured verdict (verifier steps only). */
  verdict?: WorkflowLoopVerdict
  /** Run spend, fed into the cumulative cross-iteration budget. */
  tokens?: number
  costUsd?: number
  /** The run itself failed (process error / no usable output). */
  failed?: boolean
  error?: string
}

export interface WorkflowLoopEngineDeps {
  /** Dispatch one step run + await its REAL completion. Real impl (slice 5) reuses
   * dispatchRole/spawnAndAwait; tests pass a fake. Must never throw (the engine
   * does not wrap it) — model a failure as `{ failed: true }`. */
  dispatchStep: (input: WorkflowLoopStepInput) => Promise<WorkflowLoopStepResult>
  /** Monotonic clock (Date.now). */
  now: () => number
  /** Unique step run id (randomUUID). */
  uuid: () => string
  /** Cooperative cancellation — checked before each dispatch. */
  isCancelled: () => boolean
  /** Optional progress/persist hook fired after each transition (the durable
   * single-writer + live-broadcast pattern; tests capture snapshots). */
  onState?: (snapshot: WorkflowLoopRunSnapshot) => void
}

export type WorkflowLoopRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'
export type WorkflowLoopRunStopReason = WorkflowLoopStopReason | 'cancelled' | 'failed'

export interface WorkflowLoopIterationRecord {
  iteration: number
  makerRunId: string
  makerOutput?: string
  verifierRunId?: string
  verdict?: WorkflowLoopVerdict
  /** A run in this iteration failed (maker or verifier). */
  failed?: boolean
}

export interface WorkflowLoopRunSnapshot {
  status: WorkflowLoopRunStatus
  iterationsCompleted: number
  budget: WorkflowLoopBudget
  iterations: WorkflowLoopIterationRecord[]
  stopReason?: WorkflowLoopRunStopReason
  /** The final maker output when the loop stopped (the accepted / last work product). */
  finalOutput?: string
  startedAtMs: number
  updatedAtMs: number
  error?: string
}

export class WorkflowLoopEngine {
  constructor(private readonly deps: WorkflowLoopEngineDeps) {}

  /**
   * Run the loop to a terminal snapshot. FAIL-SAFE bounded: decideLoopContinuation
   * enforces maxIterations + the cumulative budget after each iteration, and a
   * pre-dispatch budget guard stops a run the prior iteration already exhausted, so
   * the loop can never run unbounded regardless of the verifier.
   */
  async run(config: WorkflowLoopConfig): Promise<WorkflowLoopRunSnapshot> {
    const startedAtMs = this.deps.now()
    let budget = makeLoopBudget(config.limits)
    const iterations: WorkflowLoopIterationRecord[] = []
    let finalOutput: string | undefined
    let lastVerdict: WorkflowLoopVerdict | null = null

    const snapshot = (
      status: WorkflowLoopRunStatus,
      stopReason?: WorkflowLoopRunStopReason,
      error?: string
    ): WorkflowLoopRunSnapshot => ({
      status,
      iterationsCompleted: iterations.length,
      budget,
      iterations: iterations.map((it) => ({ ...it })),
      ...(stopReason ? { stopReason } : {}),
      ...(finalOutput !== undefined ? { finalOutput } : {}),
      startedAtMs,
      updatedAtMs: this.deps.now(),
      ...(error ? { error } : {})
    })
    const settle = (
      status: WorkflowLoopRunStatus,
      stopReason: WorkflowLoopRunStopReason,
      error?: string
    ): WorkflowLoopRunSnapshot => {
      const snap = snapshot(status, stopReason, error)
      this.deps.onState?.(snap)
      return snap
    }

    for (;;) {
      if (this.deps.isCancelled()) return settle('cancelled', 'cancelled')
      if (loopBudgetExhausted(budget)) {
        budget = markLoopTruncated(budget)
        return settle('completed', 'budget_exhausted')
      }

      const iteration = iterations.length + 1
      const makerRunId = this.deps.uuid()
      const makerResult = await this.deps.dispatchStep({
        role: 'maker',
        iteration,
        runId: makerRunId,
        priorOutput: finalOutput,
        priorVerdict: lastVerdict
      })
      budget = recordLoopSpend(budget, {
        runs: 1,
        tokens: makerResult.tokens,
        costUsd: makerResult.costUsd
      })
      const record: WorkflowLoopIterationRecord = { iteration, makerRunId }
      if (makerResult.output !== undefined) {
        record.makerOutput = makerResult.output
        finalOutput = makerResult.output
      }
      if (makerResult.failed) {
        record.failed = true
        iterations.push(record)
        // A maker process failure is an infra failure (no work product) → fail the
        // loop; verdict-driven retries are for 'revise', not crashes.
        return settle('failed', 'failed', makerResult.error)
      }

      // VERIFIER (optional). A verifier configured but producing NO verdict (its run
      // failed or it never emitted one) is treated as an unsupported 'revise' → the
      // loop stops 'inconclusive' rather than burning iterations on a verifier that
      // isn't committing to a decision.
      let verdict: WorkflowLoopVerdict | null = null
      if (config.acceptance.verifier) {
        if (this.deps.isCancelled()) {
          iterations.push(record)
          return settle('cancelled', 'cancelled')
        }
        if (loopBudgetExhausted(budget)) {
          iterations.push(record)
          budget = markLoopTruncated(budget)
          return settle('completed', 'budget_exhausted')
        }
        const verifierRunId = this.deps.uuid()
        const verifierResult = await this.deps.dispatchStep({
          role: 'verifier',
          iteration,
          runId: verifierRunId,
          priorOutput: finalOutput
        })
        budget = recordLoopSpend(budget, {
          runs: 1,
          tokens: verifierResult.tokens,
          costUsd: verifierResult.costUsd
        })
        record.verifierRunId = verifierRunId
        if (verifierResult.failed) record.failed = true
        verdict = verifierResult.verdict ?? { decision: 'revise' }
        record.verdict = verdict
      }
      lastVerdict = verdict
      iterations.push(record)

      const decision = decideLoopContinuation({
        iterationsCompleted: iterations.length,
        acceptance: config.acceptance,
        budget,
        latestVerdict: verdict
      })
      if (decision.kind === 'stop') {
        const reason = decision.reason as WorkflowLoopStopReason
        // 'truncated' is a RESOURCE-cut semantic (budget), not the configured
        // iteration ceiling — max_iterations is a clean stop.
        if (reason === 'budget_exhausted') budget = markLoopTruncated(budget)
        return settle('completed', reason)
      }
      // continue → another iteration; emit a progress snapshot first.
      this.deps.onState?.(snapshot('running'))
    }
  }
}
