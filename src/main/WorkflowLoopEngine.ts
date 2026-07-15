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
  type WorkflowLoopVerdict,
  type WorkflowLoopVerdictDecision
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
      // Cancellation may settle/release the owning occurrence while the child
      // transport is unwinding. Preserve the completed-step accounting, but let
      // cancellation outrank a late failed result from that child.
      if (this.deps.isCancelled()) {
        iterations.push(record)
        return settle('cancelled', 'cancelled')
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
        if (this.deps.isCancelled()) {
          iterations.push(record)
          return settle('cancelled', 'cancelled')
        }
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

/** Where a finished loop's ScheduledTask should land. PURE + testable — the one
 * piece of loop-wiring logic that carries real risk (mis-mapping poisons the
 * workflow's failureStreak). */
export interface ScheduledLoopOutcome {
  status: 'completed' | 'failed' | 'cancelled'
  lastError?: string
}

/**
 * Map a terminal loop snapshot to the single ScheduledTask terminal mark.
 *  - cancelled → 'cancelled'.
 *  - INFRA failure (a maker/verifier run crashed) → 'failed' (this is the ONLY path
 *    that bumps failureStreak → can auto-disable the workflow at maxConsecutiveFailures).
 *  - everything else COMPLETES: a clean accept or the configured maxIterations stop
 *    silently; a verifier reject / inconclusive / budget stop completes WITH a note
 *    but NOT as a failure — a non-acceptance outcome of a correctly-run loop must not
 *    poison the streak and silently disable a healthy recurring workflow.
 */
export function mapLoopSnapshotToScheduledOutcome(
  snap: Pick<WorkflowLoopRunSnapshot, 'status' | 'stopReason' | 'error'>
): ScheduledLoopOutcome {
  if (snap.status === 'cancelled') return { status: 'cancelled' }
  if (snap.status === 'failed') return { status: 'failed', lastError: snap.error || 'Workflow loop failed.' }
  const clean = snap.stopReason === 'accepted' || snap.stopReason === 'max_iterations'
  return {
    status: 'completed',
    ...(clean ? {} : { lastError: `Loop stopped: ${snap.stopReason ?? 'unknown'}` })
  }
}

// ── Slice 5b — verifier prompt + verdict parsing ──────────────────────────────
// PURE helpers so the marker grammar the verifier is TAUGHT (buildLoopVerifierPrompt)
// stays co-located with — and tested alongside — the parser that must AGREE with it
// (parseLoopVerdict). The real verifier dispatch (index.ts dispatchStep, role
// 'verifier') composes buildLoopVerifierPrompt as the run prompt and feeds the run's
// final assistant text back through parseLoopVerdict to produce the WorkflowLoopStepResult
// verdict the engine acts on.

/**
 * The verifier judging prompt. The verifier is an INDEPENDENT judge run (fresh
 * context, asked to CRITIQUE rather than produce) that reads the maker's work
 * product and may inspect the workspace (read-only under the unattended posture).
 * It is instructed to end with a single `LOOP_VERDICT:` line that parseLoopVerdict
 * extracts. The evidence requirement on `revise` is what the engine's evidence-anchor
 * rule (decideLoopContinuation) enforces — a revise with no evidence stops the loop
 * 'inconclusive' rather than burning iterations on unsupported feedback.
 */
export function buildLoopVerifierPrompt(taskGoal: string, workProduct: string): string {
  // Neutralize any LOOP_VERDICT marker the task goal / work product themselves
  // contain (e.g. a workflow whose task is ABOUT this loop code, or a hallucinated
  // marker), so that if the verifier quotes the artifact back in its reply ("for
  // reference, here is what I reviewed: …") the echoed copy can NEVER be parsed as
  // the verdict. parseLoopVerdict is last-match-wins, so an echoed 'accept' could
  // otherwise outvote the verifier's real judgment — only its OWN fresh verdict
  // line (written from this prompt, not from the redacted text) must ever survive.
  const redact = (s: string): string => s.replace(/LOOP_VERDICT:/gi, 'LOOP-VERDICT-REDACTED:')
  const safeGoal = redact(taskGoal)
  const safeProduct = redact(workProduct)
  return [
    'You are an independent reviewer. Judge whether the work below satisfies the task.',
    '',
    '[Task]',
    safeGoal,
    '',
    '[Work product to review — the latest attempt]',
    safeProduct.trim() ? safeProduct : '(no textual work product was produced — inspect the workspace)',
    '',
    'Inspect the workspace if needed, then respond with EXACTLY ONE verdict line as the LAST line of your reply:',
    '  LOOP_VERDICT: accept',
    '  LOOP_VERDICT: revise <specific, actionable evidence of what is wrong and must change>',
    '  LOOP_VERDICT: reject <why this approach cannot succeed and should not be retried>',
    '',
    'Rules:',
    '- accept ONLY if the task is fully satisfied.',
    '- A revise REQUIRES concrete evidence. A revise with no evidence is treated as inconclusive and STOPS the loop.',
    '- Put the LOOP_VERDICT line LAST; write nothing after it.'
  ].join('\n')
}

/**
 * Parse a verifier run's final text into a structured verdict. Mirrors the audit/
 * builder marker-parse pattern (a `KEY: value` line). Tolerant by design: scans
 * every line and takes the LAST `LOOP_VERDICT:` match (an echoed example earlier in
 * the reply cannot outvote the real, final verdict), case-insensitive, and lenient
 * on a trailing word suffix ('accepted' → accept). Returns null when no recognizable
 * marker is present — the engine then defaults to an evidence-less { decision:
 * 'revise' }, which decideLoopContinuation resolves to a fail-safe 'inconclusive'
 * stop (a verifier that won't commit can never loop the maker forever).
 */
export function parseLoopVerdict(finalText: string | undefined | null): WorkflowLoopVerdict | null {
  if (!finalText || typeof finalText !== 'string') return null
  // Match the marker anywhere on a line (not only at line-start, so "My verdict:
  // LOOP_VERDICT: accept" still parses); `.` excludes newlines so evidence is the
  // rest of THAT line. `g` drives the last-match scan below. The decision verb is
  // bounded by `(?:ed)?\b` — it tolerates the past tense ('accepted') but a longer
  // word must NOT reduce to a bare verb: 'acceptance criteria are NOT met' must
  // parse as no-verdict (→ null → inconclusive), never as a false 'accept'.
  const re = /LOOP_VERDICT:[^\S\n]*(accept|revise|reject)(?:ed)?\b[^\S\n]*(.*)/gi
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = re.exec(finalText)) !== null) last = match
  if (!last) return null
  const decision = last[1].toLowerCase() as WorkflowLoopVerdictDecision
  const evidence = last[2]?.trim()
  // accept is decisive on its own; revise/reject carry the (optional) evidence that
  // the evidence-anchor rule reads — a revise WITHOUT evidence stops 'inconclusive'.
  if (decision === 'accept') return { decision: 'accept' }
  return { decision, ...(evidence ? { evidence } : {}) }
}
