import type { ChatMessage } from '../../../main/store/types'
import type { SeatChangeLink } from '../../../shared/seatChange'

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

/**
 * The owning seat as the shared seat presentation element understands it, so
 * the card names its caller the same way the composer, the Task Complete
 * close-out and the seat-change row do — provider glyph, accent and model
 * chip — rather than printing a bare model slug that matches nothing else in
 * the transcript.
 *
 * `before` and `after` are the same seat on purpose: nothing changed here, and
 * that is the established idiom for showing one static seat through this
 * element (`fleetWaveSeatLink` does the same).
 */
export function executionSeatLink(
  seatId: string | undefined,
  participantId?: string
): SeatChangeLink | null {
  if (!seatId) return null
  // `provider:model`, split on the FIRST colon only — Ollama model ids carry
  // their own (`qwen3-coder:30b`), and splitting greedily would strip the tag.
  const separator = seatId.indexOf(':')
  if (separator <= 0) return null
  const provider = seatId.slice(0, separator).trim()
  const model = seatId.slice(separator + 1).trim()
  if (!provider || !model) return null
  const seat = { provider, model }
  return {
    participantId: participantId || seatId,
    before: seat,
    after: seat
  }
}

export function executionResultSeatLink(message: ChatMessage): SeatChangeLink | null {
  return executionSeatLink(
    executionResultSeatId(message),
    executionResultExecutionId(message) || executionResultSeatId(message)
  )
}

/** The execution this row reports on, when the payload names one. */
export function executionResultExecutionId(message: ChatMessage): string | undefined {
  const executionId = message.metadata?.executionId
  return typeof executionId === 'string' && executionId.trim() ? executionId.trim() : undefined
}
