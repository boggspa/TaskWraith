/**
 * Structured transcript payload for the user's thread-wide Auto Approvals
 * consent toggle. The persisted carrier keeps a plain sentence for clients
 * that do not render the animated before/after row.
 */
export const AUTO_APPROVALS_CHANGE_KIND = 'ensembleAutoApprovalsChange'

/** Match the authoritative seat-change row's read-before-transition pause. */
export const AUTO_APPROVALS_CHANGE_REVEAL_DELAY_MS = 2_000

export interface AutoApprovalsChangePayload {
  before: boolean
  after: boolean
  changedAt: string
}

/**
 * Persisted metadata is untrusted data. Malformed or no-op events fall back to
 * their carrier sentence instead of presenting a false state transition.
 */
export function isAutoApprovalsChangePayload(value: unknown): value is AutoApprovalsChangePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<AutoApprovalsChangePayload>
  return (
    typeof payload.before === 'boolean' &&
    typeof payload.after === 'boolean' &&
    payload.before !== payload.after &&
    typeof payload.changedAt === 'string' &&
    Number.isFinite(Date.parse(payload.changedAt))
  )
}
