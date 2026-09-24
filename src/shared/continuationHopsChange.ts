import type { EnsembleAuthorityRole } from './ensembleAuthority'

/**
 * Structured transcript payload for a configured-budget change or consumed
 * Continuous-round handoff. Main persists this object; renderer promotes it
 * into the animated DigitOdometer row. Plain-text clients continue to use the
 * carrier message's `content` fallback.
 */
export const CONTINUATION_HOPS_CHANGE_KIND = 'ensembleContinuationHopsChange'

/** Match the seat-change row's read-before-roll pause. */
export const CONTINUATION_HOPS_CHANGE_REVEAL_DELAY_MS = 2_000

export type ContinuationHopsChangeActor = 'user' | EnsembleAuthorityRole

interface ContinuationHopsChangeBasePayload {
  before: number
  after: number
  changedAt: string
}

/**
 * A user- or authority-authored edit to the configured handoff ceiling.
 * `event` remains optional so rows persisted before the discriminator existed
 * continue to validate and render as limit changes.
 */
export interface ContinuationHopsLimitChangePayload extends ContinuationHopsChangeBasePayload {
  event?: 'limit'
  actor: ContinuationHopsChangeActor
  /** Present for an agent-authored change so the durable event keeps identity. */
  actorParticipantId?: string
  actorRole?: string
  reason?: string
}

/** A consumed Continuous-round handoff, including the stable budget denominator. */
export interface ContinuationHopsAdvancePayload extends ContinuationHopsChangeBasePayload {
  event: 'advance'
  maxHops: number
  /** Optional durable presentation labels; no mutable-roster lookup is required on replay. */
  targetLabel?: string
  sourceLabel?: string
}

export type ContinuationHopsChangePayload =
  | ContinuationHopsLimitChangePayload
  | ContinuationHopsAdvancePayload

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().length > 0)
}

export function isContinuationHopsAdvancePayload(
  value: unknown
): value is ContinuationHopsAdvancePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<ContinuationHopsAdvancePayload>
  if (payload.event !== 'advance') return false
  if (
    !Number.isInteger(payload.before) ||
    !Number.isInteger(payload.after) ||
    !Number.isInteger(payload.maxHops) ||
    (payload.before ?? -1) < 0 ||
    (payload.after ?? 0) <= (payload.before ?? -1) ||
    (payload.maxHops ?? 0) < (payload.after ?? 0)
  ) {
    return false
  }
  if (
    !isOptionalNonEmptyString(payload.targetLabel) ||
    !isOptionalNonEmptyString(payload.sourceLabel)
  ) {
    return false
  }
  return typeof payload.changedAt === 'string' && Number.isFinite(Date.parse(payload.changedAt))
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
  if ((value as { event?: unknown }).event === 'advance') {
    return isContinuationHopsAdvancePayload(value)
  }
  const payload = value as Partial<ContinuationHopsLimitChangePayload>
  if (
    (payload.event !== undefined && payload.event !== 'limit') ||
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

interface ContinuationHopsChangeMessageLike {
  role?: unknown
  content?: unknown
  timestamp?: unknown
  metadata?: { kind?: unknown; continuationHopsChange?: unknown } | null
}

/**
 * Resolve the structured payload used by current records, or promote the exact
 * canonical fallback sentence written by older builds for display only.
 * Arbitrary system text and malformed metadata remain plain notices.
 */
export function resolveContinuationHopsChangePayload(
  message: ContinuationHopsChangeMessageLike
): ContinuationHopsChangePayload | null {
  const candidate = message.metadata?.continuationHopsChange
  if (candidate !== undefined) {
    return isContinuationHopsChangePayload(candidate) ? candidate : null
  }
  if (
    message.role !== 'system' ||
    message.metadata?.kind !== 'ensembleRoundStatus' ||
    typeof message.content !== 'string' ||
    typeof message.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(message.timestamp)) ||
    message.content.length > 512 ||
    message.content.includes('\n')
  ) {
    return null
  }
  const match = message.content.match(/^(.+\.) Continuous handoff (\d+)\/(\d+)\.$/)
  if (!match) return null
  const after = Number(match[2])
  const maxHops = Number(match[3])
  if (!Number.isInteger(after) || !Number.isInteger(maxHops) || after < 1 || maxHops < after) {
    return null
  }
  const mention = match[1].match(/^@-mention: extra turn appended for ([^.]{1,160})\.$/)
  return {
    event: 'advance',
    before: after - 1,
    after,
    maxHops,
    changedAt: message.timestamp,
    ...(mention ? { targetLabel: mention[1], sourceLabel: '@-mention' } : {})
  }
}
