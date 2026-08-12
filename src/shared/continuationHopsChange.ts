/**
 * Structured transcript payload for a change to the Continuous round handoff
 * budget. Main persists this object; renderer promotes it into the animated
 * DigitOdometer row. Plain-text clients continue to use the carrier message's
 * `content` fallback.
 */
export const CONTINUATION_HOPS_CHANGE_KIND = 'ensembleContinuationHopsChange'

/** Match the seat-change row's read-before-roll pause. */
export const CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS = 2_000

export type ContinuationHopsChangeActor = 'user' | 'boss' | 'captain'

export interface ContinuationHopsChangePayload {
  before: number
  after: number
  actor: ContinuationHopsChangeActor
  changedAt: string
  /** Present for an agent-authored change so the durable event keeps identity. */
  actorParticipantId?: string
  actorRole?: string
  reason?: string
}

/**
 * Persisted metadata is data, not trusted TypeScript. Reject malformed rows so
 * the transcript falls back to its plain sentence instead of rendering a
 * misleading counter.
 */
export function isContinuationHopsChangePayload(
  value: unknown
): value is ContinuationHopsChangePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<ContinuationHopsChangePayload>
  if (
    !Number.isInteger(payload.before) ||
    !Number.isInteger(payload.after) ||
    (payload.before ?? 0) < 1 ||
    (payload.after ?? 0) < 1
  ) {
    return false
  }
  if (payload.actor !== 'user' && payload.actor !== 'boss' && payload.actor !== 'captain') {
    return false
  }
  return typeof payload.changedAt === 'string' && Number.isFinite(Date.parse(payload.changedAt))
}
