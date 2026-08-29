import type { ChatMessage } from '../../../main/store/types'

export type ExecutionResultOutcome = 'succeeded' | 'failed' | 'cancelled' | 'requires_action'

/**
 * A durable execution graph's delivered result.
 *
 * Deliberately its own row kind rather than a `subThreadReturn`: a graph stage
 * is not a sub-thread, and borrowing that vocabulary would make close-out
 * harvesting, seat attribution and parallel-result grouping describe the
 * execution as something it is not.
 */
export function isExecutionResultMessage(message: ChatMessage | null | undefined): boolean {
  return (
    (message?.role === 'tool' || message?.role === 'system') &&
    message?.metadata?.kind === 'executionResult'
  )
}

export function executionResultOutcome(message: ChatMessage): ExecutionResultOutcome {
  const outcome = message.metadata?.executionOutcome
  return outcome === 'failed' || outcome === 'cancelled' || outcome === 'requires_action'
    ? outcome
    : 'succeeded'
}

export function executionResultStatusLabel(outcome: ExecutionResultOutcome): string {
  switch (outcome) {
    case 'succeeded':
      return 'Complete'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'requires_action':
      return 'Needs attention'
  }
}

/**
 * Status slug for the shared orchestration chassis. `requires_action` maps to
 * the attention tone rather than a failure tone: the graph is stopped and
 * waiting for a person, which is not the same as having failed.
 */
export function executionResultStatusSlug(outcome: ExecutionResultOutcome): string {
  switch (outcome) {
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'requires_action':
      return 'attention'
  }
}

export function executionResultTitle(message: ChatMessage): string {
  const title = message.metadata?.executionTitle
  return typeof title === 'string' && title.trim() ? title.trim() : 'Durable execution'
}

/** The seat that owned the execution, for header attribution. */
export function executionResultSeatId(message: ChatMessage): string | undefined {
  const seatId = message.metadata?.executionSeatId
  return typeof seatId === 'string' && seatId.trim() ? seatId.trim() : undefined
}
