// Pure helpers for the DURABLE workflow EXECUTION ledger (Stage 1). Mirrors the
// RunEventStore pattern (per-file, append-only, node-free pure logic; the disk
// I/O lives in store/index.ts) but is a lifecycle ledger, NOT a tamper-evident
// audit chain — so no hash-chaining.
//
// WHY THIS EXISTS
// ---------------
// Today a scheduled occurrence's outcome is recorded only in
// WorkflowDefinition.history (capped at 50, and living inside the
// concurrently-written workflows.json — clobber-prone) and ScheduledTask
// (deleted on cleanup). Budget breaches survive only as a transient lastError
// string subject to the 50-cap eviction. So "the loop ran 40×, spent $12, hit
// the token wall on run 41" is unanswerable. This ledger persists every
// occurrence's full lifecycle (materialized→dispatched→running→terminal) + the
// harvested cost/token totals + the structured budget breach, uncapped, one file
// per EXECUTION (workflowExecutionId) so there is exactly one writer per file
// (no cross-writer contention — the run-events model).

export const WORKFLOW_RUN_SCHEMA_VERSION = 1

export type WorkflowRunEventKind =
  | 'materialized'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'budget_breach'
  | 'stall_settled'
  // Pure forensic annotation (slice 3): carries the harvested tokens/costUsd/
  // durationMs of a finished run. Does NOT advance lifecycle status — it rides
  // alongside the terminal lifecycle event so the fold picks up the consumption.
  | 'harvested'
  // Terminal close of a LOOP execution (Stage 2): the loop engine writes it when
  // the maker/verifier loop stops. Like the lifecycle terminals it ends the
  // execution — distinct from the per-iteration sub-run events (tagged `iteration`).
  | 'loop_settled'

/** Terminal lifecycle kinds (a fold stops advancing `status` past one of these).
 * `stall_settled` (the startup reconciler's crash-close) + `loop_settled` (the loop
 * engine's terminal) are terminal: no real lifecycle event follows either. */
const TERMINAL_KINDS: ReadonlySet<WorkflowRunEventKind> = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'stall_settled',
  'loop_settled'
])

export interface WorkflowRunBudgetBreach {
  kind: 'tokens' | 'cost' | 'wallclock'
  limit: number
  observed: number
}

export interface WorkflowRunEventInput {
  workflowExecutionId: string
  workflowId: string
  kind: WorkflowRunEventKind
  timestamp?: string
  scheduledTaskId?: string
  runId?: string
  plannedFor?: string
  tokens?: number
  costUsd?: number
  durationMs?: number
  breach?: WorkflowRunBudgetBreach
  error?: string
  /** Stage 2 — the 1-based MAKER iteration this event belongs to, for a LOOP
   * execution. Absent on a single-occurrence run AND on a loop's execution-level
   * events (running / loop_settled). Per-iteration sub-run events set it; the fold
   * uses it to keep them from terminalizing the whole execution + to count loops. */
  iteration?: number
}

export interface WorkflowRunEvent extends WorkflowRunEventInput {
  schemaVersion: number
  sequence: number
  timestamp: string
}

/** Per-execution file name. Sanitizes the id (path-injection safe), mirroring safeRunEventFileName. */
export function safeWorkflowRunFileName(workflowExecutionId: string): string {
  const normalized = String(workflowExecutionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${normalized || 'unknown-execution'}.jsonl`
}

export function createWorkflowRunEvent(
  input: WorkflowRunEventInput,
  sequence: number,
  now?: string
): WorkflowRunEvent {
  const workflowExecutionId = String(input.workflowExecutionId || '').trim()
  if (!workflowExecutionId) {
    throw new Error('Workflow run event requires a workflowExecutionId.')
  }
  if (!input.workflowId) {
    throw new Error('Workflow run event requires a workflowId.')
  }
  return {
    ...input,
    workflowExecutionId,
    schemaVersion: WORKFLOW_RUN_SCHEMA_VERSION,
    sequence: Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 1,
    timestamp: input.timestamp || now || new Date().toISOString()
  }
}

export function serializeWorkflowRunEvent(event: WorkflowRunEvent): string {
  return `${JSON.stringify(event)}\n`
}

export function parseWorkflowRunEventLine(line: string): WorkflowRunEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as WorkflowRunEvent
    if (
      !parsed ||
      parsed.schemaVersion !== WORKFLOW_RUN_SCHEMA_VERSION ||
      !parsed.workflowExecutionId ||
      !parsed.kind
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function nextWorkflowRunSequence(events: readonly WorkflowRunEvent[]): number {
  return events.reduce((max, event) => Math.max(max, Number(event.sequence) || 0), 0) + 1
}

export interface WorkflowRunSummary {
  workflowExecutionId: string
  workflowId: string
  /** The latest lifecycle status (the last non-budget_breach kind seen). */
  status: WorkflowRunEventKind | 'unknown'
  isTerminal: boolean
  runId?: string
  scheduledTaskId?: string
  plannedFor?: string
  dispatchedAt?: string
  startedAt?: string
  completedAt?: string
  durationMs?: number
  tokens?: number
  costUsd?: number
  breach?: WorkflowRunBudgetBreach
  error?: string
  eventCount: number
  /** Stage 2 — the highest maker iteration observed (a LOOP execution); absent for
   * a single-occurrence run. */
  iterationCount?: number
}

/**
 * Fold an execution's event log into its current summary (left-fold over events
 * in sequence order). `status` tracks the latest EXECUTION-LEVEL lifecycle kind
 * (budget_breach / harvested annotate but don't replace it; stall_settled +
 * loop_settled are terminal). Forensic totals (tokens/costUsd/durationMs) SUM across
 * events so a LOOP's cumulative spend = the sum of its per-iteration harvests; a
 * single occurrence carries them on one event so the sum equals that value. A loop's
 * per-iteration sub-run events (tagged `iteration`) contribute forensics + the
 * iteration count but do NOT terminalize the execution — only an execution-level
 * terminal (loop_settled / stall_settled / a single-occurrence completed) does.
 */
export function foldWorkflowRunSummary(
  workflowExecutionId: string,
  events: readonly WorkflowRunEvent[]
): WorkflowRunSummary {
  const ordered = [...events]
    .filter((e) => e.workflowExecutionId === workflowExecutionId)
    .sort((a, b) => a.sequence - b.sequence)

  const summary: WorkflowRunSummary = {
    workflowExecutionId,
    workflowId: '',
    status: 'unknown',
    isTerminal: false,
    eventCount: ordered.length
  }

  for (const event of ordered) {
    if (event.workflowId) summary.workflowId = event.workflowId
    if (event.scheduledTaskId) summary.scheduledTaskId = event.scheduledTaskId
    if (event.runId) summary.runId = event.runId
    if (event.plannedFor) summary.plannedFor = event.plannedFor
    // Forensic totals SUM across events (a loop's cumulative spend = the sum of its
    // per-iteration harvests; a single occurrence sums one value → unchanged).
    if (typeof event.tokens === 'number') summary.tokens = (summary.tokens ?? 0) + event.tokens
    if (typeof event.costUsd === 'number') summary.costUsd = (summary.costUsd ?? 0) + event.costUsd
    if (typeof event.durationMs === 'number') {
      summary.durationMs = (summary.durationMs ?? 0) + event.durationMs
    }
    if (event.breach) summary.breach = event.breach
    if (event.error) summary.error = event.error
    if (typeof event.iteration === 'number') {
      summary.iterationCount = Math.max(summary.iterationCount ?? 0, event.iteration)
    }

    // Only EXECUTION-LEVEL events (no `iteration`) drive the execution lifecycle. A
    // loop's per-iteration sub-run events (tagged `iteration`) must NOT terminalize
    // the whole execution — else the fold would close it on iteration 1's own
    // `completed`. They still contribute forensics + the iteration count above.
    if (event.iteration === undefined) {
      switch (event.kind) {
        case 'dispatched':
          summary.dispatchedAt = event.timestamp
          break
        case 'running':
          summary.startedAt = event.timestamp
          break
        case 'completed':
        case 'failed':
        case 'cancelled':
        case 'skipped':
        case 'stall_settled':
        case 'loop_settled':
          summary.completedAt = event.timestamp
          break
        default:
          break
      }
      // Status advances on every execution-level kind EXCEPT the pure annotations
      // (budget_breach + harvested). stall_settled + loop_settled ARE terminal.
      if (event.kind !== 'budget_breach' && event.kind !== 'harvested') {
        summary.status = event.kind
        summary.isTerminal = TERMINAL_KINDS.has(event.kind)
      }
    }
  }

  return summary
}

export interface WorkflowRunEventFilter {
  workflowId?: string
  workflowExecutionId?: string
  /** Inclusive ISO lower bound on timestamp. */
  fromTimestamp?: string
  /** Keep only the most-recent N (after sort). */
  limit?: number
}

export function filterWorkflowRunEvents(
  events: readonly WorkflowRunEvent[],
  filter: WorkflowRunEventFilter = {}
): WorkflowRunEvent[] {
  const fromMs = filter.fromTimestamp ? Date.parse(filter.fromTimestamp) : Number.NaN
  const filtered = events.filter((event) => {
    if (filter.workflowId && event.workflowId !== filter.workflowId) return false
    if (filter.workflowExecutionId && event.workflowExecutionId !== filter.workflowExecutionId) {
      return false
    }
    if (Number.isFinite(fromMs) && Date.parse(event.timestamp) < fromMs) return false
    return true
  })

  const sorted = filtered.sort((a, b) => {
    if (a.workflowExecutionId === b.workflowExecutionId) return a.sequence - b.sequence
    return Date.parse(a.timestamp) - Date.parse(b.timestamp)
  })

  return filter.limit && filter.limit > 0 ? sorted.slice(-Math.floor(filter.limit)) : sorted
}

export interface StaleLedgerExecution {
  workflowExecutionId: string
  workflowId: string
  /** The non-terminal lifecycle status the ledger was left in (e.g. 'running'). */
  status: WorkflowRunSummary['status']
}

/**
 * PURE (Stage 1 slice 2). Given each execution's folded summary, return the
 * executions a STARTUP reconciler should close with a terminal `stall_settled`
 * event — those left NON-terminal by a crash/quit mid-run:
 *   - not already terminal (completed/failed/cancelled/skipped/stall_settled —
 *     stall_settled is itself terminal, so a re-boot is idempotent), AND
 *   - has at least one real lifecycle event (eventCount>0 / status!=='unknown'),
 *     so a 0-event / unparseable file is never settled.
 * Does NOT write; the store seam appends. No age/backstop: a non-terminal ledger
 * at BOOT is by definition orphaned (the app was just down), and a deleted
 * ScheduledTask leaves no reliable wall-clock basis to age against.
 */
export function reconcileStaleLedgerExecutions(
  summaries: readonly WorkflowRunSummary[]
): StaleLedgerExecution[] {
  const stale: StaleLedgerExecution[] = []
  for (const summary of summaries) {
    if (summary.isTerminal) continue
    if (summary.eventCount === 0 || summary.status === 'unknown') continue
    stale.push({
      workflowExecutionId: summary.workflowExecutionId,
      workflowId: summary.workflowId,
      status: summary.status
    })
  }
  return stale
}
