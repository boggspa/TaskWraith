import type { ToolActivity } from '../store/types'

export const ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE =
  '[Host evidence correction: no permission-denied tool result was recorded for this AntiGravity turn. Treat the following refusal as unsupported context, not as a blocker; retry the requested in-workspace operation using a listed tool.]'

const FIRST_PERSON_BLOCKED_PATTERNS = [
  /\bi (?:cannot|can't|am unable to|was unable to)\b.{0,240}\b(?:because|since|until|without)\b.{0,180}\b(?:permission|approval|grant|access|outside[- ]workspace)\b/i,
  /\bmy (?:read|write|file|filesystem|shell|command)?\s*(?:access|permission)\b.{0,120}\b(?:was |is |has been )?(?:denied|declined|blocked|not granted)\b/i,
  /\bi (?:require|need)\b.{0,160}\b(?:explicit\s+)?(?:host|user)\s+(?:grant|approval)\b/i,
  /\bi will wait\b.{0,160}\b(?:grant|approval|permission)\b/i
] as const

const TOOL_BLOCKED_PATTERN =
  /\b(?:read_file|write_file|run_command|shell|command|tool)\b.{0,120}\b(?:was|is|has been)\s+(?:denied|declined|blocked)\b/i
const PATH_GRANT_BLOCKED_PATTERN =
  /\b(?:this|that|the)\s+(?:path|file|directory)\b.{0,160}\boutside[- ]workspace\b.{0,160}\b(?:requires?|needs?|waiting|grant|approval)\b/i
const BLOCKING_OUTCOME_PATTERN = /\b(?:cannot|can't|unable|wait|need|require|blocked)\b/i
const PERMISSION_DENIAL_EVIDENCE_PATTERN =
  /\b(?:permission(?:s)?|approval|access|grant|request|command|tool)\b.{0,120}\b(?:denied|declined|blocked|not granted|not allowed|refused)\b|\b(?:denied|declined|blocked|refused)\b.{0,120}\b(?:permission(?:s)?|approval|access|grant|request|command|tool)\b|\boutside[- ]workspace\b/i

function compactClaimText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function safeJson(value: unknown): string {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function activityEvidenceText(activity: ToolActivity): string {
  return [
    activity.resultSummary,
    activity.outputPreview,
    activity.outputSummary,
    safeJson(activity.rawResultEvent)
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
}

/**
 * Narrowly recognizes a provider-authored claim that its own work is blocked
 * on a permission decision. It intentionally ignores hypothetical guidance
 * such as "if permission is denied" and host corrections from prior turns.
 */
export function isAntigravityBlockingPermissionClaim(text: unknown): boolean {
  const compact = compactClaimText(text)
  if (!compact || compact.includes(ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE)) return false
  if (FIRST_PERSON_BLOCKED_PATTERNS.some((pattern) => pattern.test(compact))) return true
  return (
    PATH_GRANT_BLOCKED_PATTERN.test(compact) ||
    (TOOL_BLOCKED_PATTERN.test(compact) && BLOCKING_OUTCOME_PATTERN.test(compact))
  )
}

/** A prose refusal is supported only by a terminal tool error that names a permission boundary. */
export function hasAntigravityPermissionDenialEvidence(
  activities: readonly ToolActivity[] | undefined
): boolean {
  return Boolean(
    activities?.some(
      (activity) =>
        (activity.status === 'error' || activity.status === 'warning') &&
        PERMISSION_DENIAL_EVIDENCE_PATTERN.test(activityEvidenceText(activity))
    )
  )
}

export function isUnsupportedAntigravityPermissionClaim(
  text: unknown,
  activities: readonly ToolActivity[] | undefined
): boolean {
  return (
    isAntigravityBlockingPermissionClaim(text) &&
    !hasAntigravityPermissionDenialEvidence(activities)
  )
}

/**
 * Preserve provider-authored history for audit, but make its evidence status
 * explicit before another model consumes it as panel context.
 */
export function qualifyUnsupportedAntigravityPermissionClaim(
  text: string,
  activities: readonly ToolActivity[] | undefined
): string {
  if (!isUnsupportedAntigravityPermissionClaim(text, activities)) return text
  return `${ANTIGRAVITY_UNSUPPORTED_PERMISSION_CLAIM_NOTE}\n${text}`
}
