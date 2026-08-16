/**
 * M5 — Ensemble complexity-escalation heuristic.
 *
 * Pure, dependency-free detection over a round's END state. The orchestrator
 * calls `detectComplexityEscalation` once a round finishes; any signals are
 * appended to `chat.ensemble.escalationSignals` and broadcast to the renderer.
 *
 * This module emits events only. Policy may attempt bounded remediation before
 * calling it, while this detector records the terminal truth that remains.
 * Kept pure so the four heuristics are exhaustively unit-testable without an
 * orchestrator harness; ids are injected via `makeId` so there's no
 * clock/random dependence.
 */
import type {
  ComplexityEscalationAction,
  ComplexityEscalationKind,
  ComplexityEscalationSignal,
  EnsembleRoundParticipantState
} from '../store/types'

/** Keep the persisted signal list bounded. */
export const MAX_ESCALATION_SIGNALS = 30

/**
 * A cluster is "enough failures to be worth flagging": at least this many
 * failed/unreachable participants, OR at least half the roster when the roster
 * is small.
 */
export const TOOL_ERROR_CLUSTER_MIN = 2

const FAILURE_STATUSES = new Set(['failed', 'unreachable'])
const ANSWER_STATUSES = new Set(['answered', 'yielded'])

export interface DetectEscalationInput {
  chatId: string
  roundId: string
  participants: EnsembleRoundParticipantState[]
  /** Handoffs consumed this round (continuous mode). */
  continuationHops?: number
  maxContinuationHops?: number
  /** Whether a structured synthesis was actually captured for this round. */
  hasCompletedSynthesis: boolean
  createdAt: string
  /** Deterministic id factory — called with the signal kind. */
  makeId: (kind: ComplexityEscalationKind) => string
}

function participantLabel(p: EnsembleRoundParticipantState): string {
  return p.role?.trim() || p.participantId
}

function signal(
  input: DetectEscalationInput,
  kind: ComplexityEscalationKind,
  evidence: string,
  recommendedAction: ComplexityEscalationAction
): ComplexityEscalationSignal {
  return {
    id: input.makeId(kind),
    chatId: input.chatId,
    roundId: input.roundId,
    kind,
    evidence,
    recommendedAction,
    createdAt: input.createdAt
  }
}

/**
 * Run all four heuristics over a finished round's state and return the signals
 * that fired (possibly empty). Order is stable: tool-error-cluster, stuck,
 * looping, disagreement-unresolved. Multiple signals can fire for one round —
 * they're independent lenses (e.g. an all-failed round trips both
 * tool-error-cluster and stuck), and the renderer shows each.
 */
export function detectComplexityEscalation(
  input: DetectEscalationInput
): ComplexityEscalationSignal[] {
  const participants = input.participants || []
  const total = participants.length
  if (total === 0) return []

  const failed = participants.filter(
    (p) => FAILURE_STATUSES.has(p.status) || Boolean(p.lastFailureReason)
  )
  const answered = participants.filter((p) => ANSWER_STATUSES.has(p.status))

  const signals: ComplexityEscalationSignal[] = []

  // 1. tool-error-cluster — a meaningful share of the roster failed/unreachable.
  const isCluster =
    failed.length >= TOOL_ERROR_CLUSTER_MIN || (total >= 2 && failed.length / total >= 0.5)
  if (isCluster && failed.length > 0) {
    const names = failed.map(participantLabel).join(', ')
    signals.push(
      signal(
        input,
        'tool-error-cluster',
        `${failed.length} of ${total} participant(s) failed or were unreachable: ${names}.`,
        'pause-for-user'
      )
    )
  }

  // 2. stuck — the round produced no answer at all. Can co-fire with
  // tool-error-cluster when the cause is failures; that's intentional (the two
  // describe the round from different angles).
  if (answered.length === 0) {
    signals.push(
      signal(
        input,
        'stuck',
        `Round completed but no participant produced an answer (${total} participant(s)).`,
        'pause-for-user'
      )
    )
  }

  // 3. looping — continuous round burned its entire handoff budget without
  // returning to the user, i.e. the panel kept passing the baton without
  // converging.
  if (
    typeof input.maxContinuationHops === 'number' &&
    input.maxContinuationHops > 0 &&
    typeof input.continuationHops === 'number' &&
    input.continuationHops >= input.maxContinuationHops
  ) {
    signals.push(
      signal(
        input,
        'looping',
        `Round used all ${input.maxContinuationHops} handoff(s) without returning to the user.`,
        'pause-for-user'
      )
    )
  }

  // 4. disagreement-unresolved — multiple parallel answers without a captured
  // synthesis. A configured seat is intent, not evidence of convergence.
  if (!input.hasCompletedSynthesis && answered.length >= 2) {
    signals.push(
      signal(
        input,
        'disagreement-unresolved',
        `${answered.length} participants answered without a completed synthesis to reconcile them.`,
        'call-synthesizer'
      )
    )
  }

  return signals
}

/**
 * Append new signals to the persisted list, keeping the most recent
 * MAX_ESCALATION_SIGNALS. Returns the input unchanged (same reference) when
 * there's nothing to add, so the caller can skip a write.
 */
export function appendEscalationSignals(
  existing: ComplexityEscalationSignal[] | undefined,
  fresh: ComplexityEscalationSignal[]
): ComplexityEscalationSignal[] | undefined {
  if (fresh.length === 0) return existing
  const next = [...(existing || []), ...fresh]
  return next.length > MAX_ESCALATION_SIGNALS
    ? next.slice(next.length - MAX_ESCALATION_SIGNALS)
    : next
}
