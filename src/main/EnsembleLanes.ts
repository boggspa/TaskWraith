/**
 * 1.0.5-C1 — Pure helpers for the concurrent Ensemble lane state
 * model. Bookkeeping seam for multi-writer dispatch; the
 * orchestrator (1.0.5-C2 onward) plugs these into its dispatch
 * + flush + cancel paths once the per-workspace write-intent
 * registry lands.
 *
 * Functions here are intentionally pure — no `Date.now()`, no
 * randomness, no file I/O. The caller injects `nowIso` and a lane
 * id factory so tests can pin every state transition without
 * stubbing globals.
 *
 * Lane lifecycle:
 *
 *   pending  ────────► running ──┬──► completed
 *      ▲                │        ├──► failed
 *      │                ▼        ├──► cancelled
 *      └─ blocked (write-intent conflict; can retry)
 *      └─ awaiting-approval (approval gate open; can resume to running)
 *
 * Terminal states: `completed`, `failed`, `cancelled`. Once a lane
 * reaches a terminal state it never transitions again — a new
 * attempt creates a new lane id (typically
 * `lane-${roundId}-${participantId}-${attempt+1}`).
 */

import type {
  ConcurrentLane,
  ConcurrentLaneIntent,
  ConcurrentLaneStatus,
  ConcurrentLaneWriteScope,
  EnsembleRoundState,
  ProviderId
} from './store/types'

/**
 * Build a stable lane id from round + participant + attempt
 * counter. Reusable across helpers + the orchestrator so tests
 * can pin the shape.
 */
export function buildLaneId(roundId: string, participantId: string, attempt: number = 1): string {
  return `lane-${roundId}-${participantId}-${attempt}`
}

/** Lanes that are still in-flight (not terminal). */
export const NON_TERMINAL_LANE_STATUSES: ReadonlySet<ConcurrentLaneStatus> = new Set([
  'pending',
  'running',
  'blocked',
  'awaiting-approval'
])

/** Lanes that no longer accept transitions. */
export const TERMINAL_LANE_STATUSES: ReadonlySet<ConcurrentLaneStatus> = new Set([
  'completed',
  'failed',
  'cancelled'
])

export function isTerminalLaneStatus(status: ConcurrentLaneStatus): boolean {
  return TERMINAL_LANE_STATUSES.has(status)
}

export interface CreateLaneInput {
  laneId: string
  participantId: string
  provider: ProviderId
  intent?: ConcurrentLaneIntent
  approvedWriteScopes?: ConcurrentLaneWriteScope[]
  runId?: string
  providerSessionId?: string | null
  nowIso: string
}

/**
 * Build a fresh lane record in the `pending` state. The caller
 * transitions it to `running` once the adapter accepts the
 * dispatch.
 */
export function createLane(input: CreateLaneInput): ConcurrentLane {
  return {
    laneId: input.laneId,
    participantId: input.participantId,
    runId: input.runId,
    provider: input.provider,
    status: 'pending',
    intent: input.intent ?? 'none',
    ...(input.approvedWriteScopes?.length
      ? { approvedWriteScopes: input.approvedWriteScopes }
      : {}),
    startedAt: input.nowIso,
    providerSessionId: input.providerSessionId ?? null,
    approvalsQueued: 0
  }
}

export interface TransitionLaneInput {
  status: ConcurrentLaneStatus
  reason?: string
  nowIso: string
  /** Optional fields the transition can also update. */
  runId?: string
  providerSessionId?: string | null
  approvalsQueued?: number
  cancellationRequestedAt?: string
}

/**
 * Transition a lane to a new status. Returns the updated lane or
 * the input untouched if the transition is rejected (e.g. trying
 * to move a terminal lane). Mutations are immutable — the result
 * is a fresh object so the caller can persist it without
 * worrying about reference identity.
 *
 * Terminal transitions stamp `endedAt`. Non-terminal-to-terminal
 * cancellations don't require a prior `cancellationRequestedAt`;
 * the orchestrator can write both in a single transition when
 * the user clicks Stop and the adapter confirms immediately.
 */
export function transitionLane(lane: ConcurrentLane, input: TransitionLaneInput): ConcurrentLane {
  if (isTerminalLaneStatus(lane.status)) return lane
  const next: ConcurrentLane = {
    ...lane,
    status: input.status,
    reason: input.reason ?? lane.reason
  }
  if (input.runId !== undefined) next.runId = input.runId
  if (input.providerSessionId !== undefined) {
    next.providerSessionId = input.providerSessionId
  }
  if (input.approvalsQueued !== undefined) {
    next.approvalsQueued = Math.max(0, input.approvalsQueued)
  }
  if (input.cancellationRequestedAt !== undefined) {
    next.cancellationRequestedAt = input.cancellationRequestedAt
  }
  if (isTerminalLaneStatus(input.status)) {
    next.endedAt = input.nowIso
  }
  return next
}

/**
 * Increment / decrement the approvals-queued counter on a lane.
 * Clamped at 0 — never negative. Convenience wrapper around
 * `transitionLane` since the status is unchanged.
 */
export function adjustLaneApprovals(
  lane: ConcurrentLane,
  delta: number,
  nowIso: string
): ConcurrentLane {
  if (isTerminalLaneStatus(lane.status)) return lane
  const next = Math.max(0, (lane.approvalsQueued ?? 0) + delta)
  return transitionLane(lane, {
    status: lane.status,
    approvalsQueued: next,
    nowIso
  })
}

/**
 * Collect every lane belonging to a participant (across attempts).
 * Returned in insertion order. Used by the orchestrator to find
 * the latest lane on retry + by the renderer to render a
 * lane-history strip.
 */
export function lanesForParticipant(
  round: EnsembleRoundState,
  participantId: string
): ConcurrentLane[] {
  if (!round.lanes) return []
  const out: ConcurrentLane[] = []
  for (const lane of Object.values(round.lanes)) {
    if (lane.participantId === participantId) out.push(lane)
  }
  return out
}

/**
 * Returns true when the round has at least one non-terminal lane
 * (still in flight). The orchestrator uses this to decide
 * whether to keep the round in `'running'` status.
 */
export function roundHasActiveLanes(round: EnsembleRoundState): boolean {
  if (!round.lanes) return false
  for (const lane of Object.values(round.lanes)) {
    if (!isTerminalLaneStatus(lane.status)) return true
  }
  return false
}

/**
 * Returns counts of lanes by status. Used by the renderer's
 * round-card chip to surface "3 running / 1 awaiting / 2 done"
 * at a glance.
 */
export function summariseLanes(round: EnsembleRoundState): Record<ConcurrentLaneStatus, number> {
  const counts: Record<ConcurrentLaneStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    blocked: 0,
    'awaiting-approval': 0
  }
  if (!round.lanes) return counts
  for (const lane of Object.values(round.lanes)) {
    counts[lane.status] = (counts[lane.status] ?? 0) + 1
  }
  return counts
}

/**
 * Pure check: would the orchestrator be allowed to start a
 * concurrent-mode round? Used at `startRound` time to reject
 * concurrent requests when the env gate is off OR the chat
 * isn't ensemble. Returns a structured result so the caller can
 * surface the specific reason.
 */
export interface CanStartConcurrentRoundResult {
  ok: boolean
  reason?: string
}

export function canStartConcurrentRound(input: {
  concurrentLanesEnabled: boolean
  chatIsEnsemble: boolean
  requestedConcurrentMode: boolean
  enabledParticipantCount: number
}): CanStartConcurrentRoundResult {
  if (!input.requestedConcurrentMode) {
    // Caller asked for serial — always allowed.
    return { ok: true }
  }
  if (!input.concurrentLanesEnabled) {
    return {
      ok: false,
      reason: 'Concurrent Ensemble dispatch is behind the TASKWRAITH_CONCURRENT_LANES safety flag.'
    }
  }
  if (!input.chatIsEnsemble) {
    return {
      ok: false,
      reason: 'Concurrent dispatch requires an Ensemble chat (chatKind === "ensemble").'
    }
  }
  if (input.enabledParticipantCount < 2) {
    return {
      ok: false,
      reason: 'Concurrent dispatch requires at least 2 enabled participants.'
    }
  }
  return { ok: true }
}
