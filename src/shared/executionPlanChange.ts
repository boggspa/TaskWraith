import type { EnsembleAuthorityRole } from './ensembleAuthority'

/**
 * Structured transcript payload for an authoritative execution-plan
 * (round-plan) change — the Boss/Captain `set_round_plan` round-control
 * action. Main persists this object; the renderer promotes it into the
 * preserved ExecutionPlanChangeRow with the same transcript standing as seat
 * and handoff-turn changes. Plain-text clients (TUI, iOS, exports) continue
 * to use the carrier message's "<Authority> set the execution plan: …"
 * `content` fallback.
 *
 * Deliberately NOT `proposedPlan`: that field is a user-approval workflow
 * (pending/approved/dismissed); this is an already-authoritative
 * round-control event with no decision to make.
 */
export const EXECUTION_PLAN_CHANGE_KIND = 'ensembleExecutionPlanChange'

export interface ExecutionPlanChangePayload {
  /** One-line normalized plan summary (the compact row's text). */
  summary: string
  /** set_round_plan is authority-only, so the actor is never 'user'. */
  actor: EnsembleAuthorityRole
  /** Durable identity of the authoring seat. */
  actorParticipantId?: string
  changedAt: string
  /** Present only on later plan updates — the row's "was" line keys on it. */
  previousSummary?: string
  phase?: string
  ownerParticipantIds?: string[]
  /** Durable presentation labels resolved at emit; no mutable-roster lookup
   *  is required on replay (same contract as the handoff advance labels). */
  ownerLabels?: string[]
  blockers?: string[]
  doneCriteria?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value)
}

function isOptionalNonEmptyStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isNonEmptyString))
}

/**
 * Persisted metadata is data, not trusted TypeScript. Reject malformed rows so
 * the transcript falls back to its plain sentence instead of rendering a
 * misleading plan card.
 */
export function isExecutionPlanChangePayload(value: unknown): value is ExecutionPlanChangePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<ExecutionPlanChangePayload>
  if (!isNonEmptyString(payload.summary)) return false
  if (payload.actor !== 'boss' && payload.actor !== 'captain') return false
  if (typeof payload.changedAt !== 'string' || !Number.isFinite(Date.parse(payload.changedAt))) {
    return false
  }
  return (
    isOptionalNonEmptyString(payload.actorParticipantId) &&
    isOptionalNonEmptyString(payload.previousSummary) &&
    isOptionalNonEmptyString(payload.phase) &&
    isOptionalNonEmptyString(payload.doneCriteria) &&
    isOptionalNonEmptyStringArray(payload.ownerParticipantIds) &&
    isOptionalNonEmptyStringArray(payload.ownerLabels) &&
    isOptionalNonEmptyStringArray(payload.blockers)
  )
}

interface ExecutionPlanChangeMessageLike {
  role?: unknown
  content?: unknown
  timestamp?: unknown
  metadata?: { kind?: unknown; executionPlanChange?: unknown } | null
}

/** `normalizeBossmanText` caps the plan at 1,200 chars; the legacy sentence
 *  adds a short authority prefix. Anything longer is not one of ours. */
const MAX_LEGACY_PLAN_SENTENCE_LENGTH = 1_400

/**
 * Resolve the structured payload used by current records, or promote the exact
 * canonical fallback sentence written by older builds for display only.
 * Arbitrary system text and malformed metadata remain plain notices.
 */
export function resolveExecutionPlanChangePayload(
  message: ExecutionPlanChangeMessageLike
): ExecutionPlanChangePayload | null {
  const candidate = message.metadata?.executionPlanChange
  if (candidate !== undefined) {
    return isExecutionPlanChangePayload(candidate) ? candidate : null
  }
  if (
    message.role !== 'system' ||
    message.metadata?.kind !== 'ensembleRoundStatus' ||
    typeof message.content !== 'string' ||
    typeof message.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(message.timestamp)) ||
    message.content.length > MAX_LEGACY_PLAN_SENTENCE_LENGTH ||
    message.content.includes('\n')
  ) {
    return null
  }
  const match = message.content.match(/^(Boss|Captain) set the execution plan: (.+)$/)
  if (!match) return null
  return {
    summary: match[2],
    actor: match[1] === 'Captain' ? 'captain' : 'boss',
    changedAt: message.timestamp
  }
}
