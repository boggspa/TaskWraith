/**
 * Ghost density cells for a durable execution graph.
 *
 * Deliberately the same visual grammar as the fleet wave strip
 * (`fleetWaveGhostCellStates`): one mini monoline ghost per unit of work,
 * outline while unsettled, filled once it stops. A reader who has learned the
 * fleet card can read an execution graph without learning anything new.
 *
 * The types here are STRUCTURAL on purpose. The authoritative shapes
 * (`ExecutionStepDefinition`, `StepActivation`) live in `src/main`, and the
 * renderer may not take a runtime import on main — `guard:architecture`
 * enforces that. Describing only the fields this projection needs keeps the
 * module importable from either side with no cross-process edge.
 */

/** Cell states, in the order a step travels through them. */
export type ExecutionGhostStatus =
  | 'proposed'
  | 'queued'
  | 'working'
  | 'needs_action'
  | 'completed'
  | 'failed'
  | 'skipped'

export interface ExecutionGhostCell {
  readonly id: string
  readonly status: ExecutionGhostStatus
  readonly title?: string
  readonly kind?: string
}

export interface ExecutionGhostCounts {
  readonly total: number
  readonly proposed: number
  readonly queued: number
  readonly running: number
  readonly needsAction: number
  readonly completed: number
  readonly failed: number
  readonly skipped: number
  /** completed + failed + skipped — everything that has stopped moving. */
  readonly settled: number
}

interface GhostStepInput {
  readonly id: string
  readonly kind: string
  readonly title?: string
}

interface GhostActivationInput {
  readonly stepId: string
  readonly state: string
  readonly updatedAt?: string
}

/**
 * Step kinds that occupy a participant — a model seat or a person — and so
 * answer "how many agents are in flight".
 *
 * `join`, `output` and `deterministic_check` are excluded because they are
 * structure, not work: they are the graph's own plumbing, they settle
 * instantly, and counting them would inflate every total so that "3 of 7
 * settled" no longer described any agent the reader could point at. A
 * `human_gate` IS counted: it occupies somebody, it is the state the reader
 * most needs to see, and leaving it out would make a graph paused on an
 * approval render as entirely idle.
 */
const WORK_BEARING_KINDS = new Set(['solo_agent', 'ensemble_round', 'human_gate'])

export function isWorkBearingStepKind(kind: string): boolean {
  return WORK_BEARING_KINDS.has(kind)
}

/**
 * An activation exists but has not begun. Kept distinct from "no activation at
 * all" in the model even though both render muted, because the difference
 * matters to anyone reading the counts rather than the picture.
 */
const NOT_YET_STARTED = new Set(['dormant', 'ready'])
const QUEUED = new Set(['claimed', 'queued', 'waiting_retry'])
/** Stopped, waiting on a person — the amber ask. */
const AWAITING_A_PERSON = new Set(['waiting_input', 'waiting_approval', 'requires_action'])
const ABANDONED = new Set(['cancelled', 'skipped'])

export function executionGhostStatusForActivation(state: string | undefined): ExecutionGhostStatus {
  if (!state || NOT_YET_STARTED.has(state)) return 'proposed'
  if (QUEUED.has(state)) return 'queued'
  if (state === 'running') return 'working'
  if (AWAITING_A_PERSON.has(state)) return 'needs_action'
  if (state === 'succeeded') return 'completed'
  if (state === 'failed') return 'failed'
  if (ABANDONED.has(state)) return 'skipped'
  // An unrecognised state is not progress. Reporting it as `proposed` keeps a
  // new activation state from silently reading as finished work.
  return 'proposed'
}

/**
 * Cells in topology order — never re-sorted by status, so a cell keeps its
 * position as it fills and the strip reads as one stable row of work rather
 * than a leaderboard.
 */
export function executionGraphGhostCellStates(input: {
  readonly steps: readonly GhostStepInput[]
  readonly activations: readonly GhostActivationInput[]
}): ExecutionGhostCell[] {
  const latestByStep = new Map<string, GhostActivationInput>()
  for (const activation of input.activations) {
    const current = latestByStep.get(activation.stepId)
    // A retried step has more than one activation. The newest wins, so a step
    // that failed and was retried into flight reads as working, not failed.
    if (!current || (activation.updatedAt || '') >= (current.updatedAt || '')) {
      latestByStep.set(activation.stepId, activation)
    }
  }

  return input.steps
    .filter((step) => isWorkBearingStepKind(step.kind))
    .map((step) => ({
      id: step.id,
      status: executionGhostStatusForActivation(latestByStep.get(step.id)?.state),
      ...(step.title ? { title: step.title } : {}),
      kind: step.kind
    }))
}

export function executionGraphGhostCounts(
  cells: readonly ExecutionGhostCell[]
): ExecutionGhostCounts {
  let proposed = 0
  let queued = 0
  let running = 0
  let needsAction = 0
  let completed = 0
  let failed = 0
  let skipped = 0
  for (const cell of cells) {
    if (cell.status === 'proposed') proposed += 1
    else if (cell.status === 'queued') queued += 1
    else if (cell.status === 'working') running += 1
    else if (cell.status === 'needs_action') needsAction += 1
    else if (cell.status === 'completed') completed += 1
    else if (cell.status === 'failed') failed += 1
    else if (cell.status === 'skipped') skipped += 1
  }
  return {
    total: cells.length,
    proposed,
    queued,
    running,
    needsAction,
    completed,
    failed,
    skipped,
    settled: completed + failed + skipped
  }
}

/**
 * Everything a transcript card needs to draw one execution, with no reference
 * to any main-process type. Built once per projection so the live card and the
 * settled result card read from the same derivation and cannot disagree about
 * how a graph fanned out.
 */
export interface ExecutionGhostCardView {
  readonly executionId: string
  readonly title?: string
  readonly seatId?: string
  readonly state: string
  /** The graph has stopped moving; the live card must stand down. */
  readonly settled: boolean
  readonly cells: readonly ExecutionGhostCell[]
  readonly counts: ExecutionGhostCounts
}

/**
 * `requires_action` is NOT settled here, matching `liveOwnedExecutionThreadIds`
 * — a paused graph is unfinished work the thread still owes an answer for, so
 * its live card stays up and keeps offering the map and the killswitch.
 */
const SETTLED_RUN_STATES = new Set(['succeeded', 'failed', 'cancelled'])

export function executionGhostCardView(run: {
  readonly executionId: string
  readonly title?: string
  readonly state: string
  readonly owner?: { readonly seatId?: string }
  readonly topology: { readonly steps: readonly { id: string; kind: string; title?: string }[] }
  readonly activations: Readonly<
    Record<string, { readonly stepId: string; readonly state: string; readonly updatedAt?: string }>
  >
}): ExecutionGhostCardView {
  const cells = executionGraphGhostCellStates({
    steps: run.topology.steps,
    activations: Object.values(run.activations)
  })
  return {
    executionId: run.executionId,
    ...(run.title ? { title: run.title } : {}),
    ...(run.owner?.seatId ? { seatId: run.owner.seatId } : {}),
    state: run.state,
    settled: SETTLED_RUN_STATES.has(run.state),
    cells,
    counts: executionGraphGhostCounts(cells)
  }
}

/**
 * The one-line read under the card header. Names only what is actually true —
 * a graph with only queue claims must not claim providers are running.
 */
export function executionGhostSummary(counts: ExecutionGhostCounts): string {
  if (counts.total === 0) return 'No agent steps'
  const parts: string[] = [`${counts.settled} of ${counts.total} settled`]
  if (counts.running > 0) parts.push(`${counts.running} running`)
  if (counts.queued > 0) parts.push(`${counts.queued} queued`)
  if (counts.needsAction > 0) parts.push(`${counts.needsAction} awaiting a decision`)
  if (counts.proposed > 0) parts.push(`${counts.proposed} proposed`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  return parts.join(' · ')
}
