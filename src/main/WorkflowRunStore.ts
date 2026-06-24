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

/** Terminal lifecycle kinds (a fold stops advancing `status` past one of these). */
const TERMINAL_KINDS: ReadonlySet<WorkflowRunEventKind> = new Set([
  'completed',
  'failed',
  'cancelled',
  'skipped'
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
}

/**
 * Fold an execution's event log into its current summary (left-fold over events
 * in sequence order). `status` tracks the latest LIFECYCLE kind (budget_breach /
 * stall_settled annotate but don't replace the lifecycle status unless terminal).
 * Forensic fields (tokens/costUsd/durationMs/breach/error) take the LAST non-empty
 * value seen, so a terminal event carrying the harvested totals wins.
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
    if (typeof event.tokens === 'number') summary.tokens = event.tokens
    if (typeof event.costUsd === 'number') summary.costUsd = event.costUsd
    if (typeof event.durationMs === 'number') summary.durationMs = event.durationMs
    if (event.breach) summary.breach = event.breach
    if (event.error) summary.error = event.error

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
        summary.completedAt = event.timestamp
        break
      default:
        break
    }

    // Lifecycle status advances on lifecycle kinds; budget_breach / stall_settled
    // are annotations (the actual terminal lifecycle event follows them).
    if (event.kind !== 'budget_breach' && event.kind !== 'stall_settled') {
      summary.status = event.kind
      summary.isTerminal = TERMINAL_KINDS.has(event.kind)
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
