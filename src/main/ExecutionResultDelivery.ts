import type { ExecutionRunProjection } from './executionGraph/ExecutionGraphRun'
import type {
  ExecutionResultMailboxEvent,
  ExecutionResultMailboxEventInput,
  ExecutionResultOutcome
} from './ExecutionResultMailbox'

/**
 * ExecutionResultDelivery.ts
 *
 * Converts a settled execution graph into a result its owning thread actually
 * receives.
 *
 * Without this, the `output` stage's stated objective — "Publish the reviewed
 * synthesis to the owning TaskWraith run" — was prose only: the coordinator
 * recorded the result into the graph's own ledger and stopped, so a fully
 * successful graph and one that never ran produced the same visible outcome
 * (nothing). Delivery is therefore a correctness requirement, not presentation.
 *
 * Ordering is load-bearing and mirrors the sub-thread return path: the durable
 * record is written BEFORE the transcript card and before any wake. A crash
 * between them can lose presentation, never delivery, and re-entry deduplicates
 * on (thread, execution, output attempt).
 */

/** States worth delivering. A paused graph owes its owner the blocker. */
const DELIVERABLE_STATES = new Set<ExecutionResultOutcome>([
  'succeeded',
  'failed',
  'cancelled',
  'requires_action'
])

export interface ExecutionResultCardInput {
  threadId: string
  executionId: string
  outputAttemptId: string
  mailboxEventId: string
  outcome: ExecutionResultOutcome
  title?: string
  seatId?: string
  content: string
}

export interface ExecutionResultWakeRequest {
  threadId: string
  executionId: string
  outcome: ExecutionResultOutcome
}

export interface DeliverExecutionResultDeps {
  enqueueResult(input: ExecutionResultMailboxEventInput): {
    event: ExecutionResultMailboxEvent
    inserted: boolean
  }
  /** True when this exact result already has a transcript row. */
  hasDeliveredCard(threadId: string, mailboxEventId: string): boolean
  appendResultCard(input: ExecutionResultCardInput): void
  /** True while the owning seat is still holding its turn (e.g. in an
   * ensemble_await poll), in which case the poll delivers and a wake would
   * start a redundant turn. */
  isOwnerTurnActive(threadId: string): boolean
  requestOwnerWake(request: ExecutionResultWakeRequest): void
}

export interface DeliverExecutionResultOutcome {
  delivered: boolean
  reason?: string
}

function outputStepIds(projection: ExecutionRunProjection): Set<string> {
  return new Set(
    projection.topology.steps.filter((step) => step.kind === 'output').map((step) => step.id)
  )
}

/**
 * The output stage's own attempt, when there is one. Its id is part of the
 * delivery identity, so a genuine retry of the output stage delivers again
 * while a replay of the same attempt does not.
 */
function outputAttempt(
  projection: ExecutionRunProjection
): { id: string; summary?: string; output?: unknown } | null {
  const stepIds = outputStepIds(projection)
  const activationIds = new Set(
    Object.values(projection.activations)
      .filter((activation) => stepIds.has(activation.stepId))
      .map((activation) => activation.id)
  )
  let latest: { id: string; summary?: string; output?: unknown } | null = null
  for (const attempt of Object.values(projection.attempts)) {
    if (!activationIds.has(attempt.activationId)) continue
    const result = attempt.result as { summary?: string; output?: unknown } | undefined
    latest = {
      id: attempt.id,
      ...(result?.summary ? { summary: result.summary } : {}),
      ...(result?.output !== undefined ? { output: result.output } : {})
    }
  }
  return latest
}

/**
 * Why a graph stopped. The projection carries no top-level state reason, so the
 * blocker is read where it is actually recorded: the activation that stopped,
 * and the error on its latest attempt.
 */
function blockerFor(projection: ExecutionRunProjection): string | null {
  const stopped = Object.values(projection.activations).filter(
    (activation) =>
      activation.state === 'requires_action' ||
      activation.state === 'failed' ||
      activation.state === 'cancelled'
  )
  for (const activation of stopped) {
    const reason = (activation as { reason?: string }).reason?.trim()
    if (reason) return reason
  }
  const stoppedIds = new Set(stopped.map((activation) => activation.id))
  for (const attempt of Object.values(projection.attempts)) {
    if (!stoppedIds.has(attempt.activationId)) continue
    const error = (attempt as { error?: string }).error?.trim()
    if (error) return error
  }
  return null
}

function contentFor(
  projection: ExecutionRunProjection,
  outcome: ExecutionResultOutcome,
  attempt: { summary?: string; output?: unknown } | null
): string {
  // For anything but success, what the owner needs first is why it stopped —
  // a partial or stale synthesis buried above the blocker reads as an answer.
  if (outcome !== 'succeeded') {
    const blocker = blockerFor(projection)
    if (blocker) return blocker
  }
  const summary = attempt?.summary?.trim()
  if (summary) return summary
  const output = attempt?.output
  if (typeof output === 'string' && output.trim()) return output.trim()
  if (output !== undefined) {
    try {
      return JSON.stringify(output, null, 2)
    } catch {
      // Fall through to the state-derived text below.
    }
  }
  // Never deliver an empty card: an outcome with no detail is still information
  // the owner needs, and silence is what this whole path exists to remove.
  return `The execution finished as "${outcome}" without producing a result payload.`
}

export function deliverExecutionResult(
  projection: ExecutionRunProjection,
  deps: DeliverExecutionResultDeps
): DeliverExecutionResultOutcome {
  const outcome = projection.state as ExecutionResultOutcome
  if (!DELIVERABLE_STATES.has(outcome)) {
    return { delivered: false, reason: 'The execution has not settled.' }
  }
  const owner = projection.owner
  if (!owner?.threadId) {
    return {
      delivered: false,
      reason: 'The execution names no owning thread, so there is nobody to deliver to.'
    }
  }

  const attempt = outputAttempt(projection)
  // A graph can settle without ever reaching its output stage (it failed at a
  // scout, or was cancelled). Key on the execution's terminal state instead, so
  // the delivery still has a stable identity.
  const outputAttemptId = attempt?.id || `${projection.executionId}:${outcome}`
  const content = contentFor(projection, outcome, attempt)

  const { event, inserted } = deps.enqueueResult({
    threadId: owner.threadId,
    executionId: projection.executionId,
    outputAttemptId,
    outcome,
    ...(projection.title ? { title: projection.title } : {}),
    ...(owner.seatId ? { seatId: owner.seatId } : {}),
    payload: { content }
  })

  if (!inserted && deps.hasDeliveredCard(owner.threadId, event.id)) {
    return { delivered: false, reason: 'This result was already delivered.' }
  }

  deps.appendResultCard({
    threadId: owner.threadId,
    executionId: projection.executionId,
    outputAttemptId,
    mailboxEventId: event.id,
    outcome,
    ...(projection.title ? { title: projection.title } : {}),
    ...(owner.seatId ? { seatId: owner.seatId } : {}),
    content: event.payload.content
  })

  // The seat holding its turn will collect this through its own await poll.
  // Waking it as well would start a second, redundant turn on the same result.
  if (!deps.isOwnerTurnActive(owner.threadId)) {
    deps.requestOwnerWake({
      threadId: owner.threadId,
      executionId: projection.executionId,
      outcome
    })
  }

  return { delivered: true }
}
