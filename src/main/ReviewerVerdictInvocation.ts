/**
 * C2-v4 — the ONE pure exact-invocation classifier for the reviewer-verdict path.
 *
 * SINGLE source of truth (Boss general/c2-v4-readonly-safety, Captain guard
 * G-SINGLE): every read-only / auto-allow / provider-preflight / gateway /
 * safe-subset-bridge / final-dispatch boundary that wants to relax the whole-tool
 * `ensemble_bossman_control` block for the nested `submit_review_verdict` action
 * MUST consult THIS predicate — never re-inline the shape check. That is the
 * C1/C2-twin-drift lesson applied to the security floor.
 *
 * Returns TRUE **iff** the invocation is EXACTLY the reviewer verdict — canonical
 * tool name + a plain object whose keys are EXACTLY {action, gateId, verdict},
 * action === 'submit_review_verdict', a non-empty string gateId, and a verdict of
 * 'passed' | 'failed'. Anything else — a wrong tool, a missing key, ANY extra key
 * (reviewer/scope/criteria/waive/owner/reason/…), a bad type, or unavailable args
 * — is a HARD reject → FALSE. Fail-closed: FALSE means the existing name-keyed
 * whole-tool block/deny stands, so no other Bossman action is ever relaxed.
 *
 * Advertisement/name-reachability is NEVER an input here: the predicate keys on
 * the actual invocation payload only. Advertising the name grants discovery,
 * never execution.
 *
 * Pure / no I/O / no state.
 */
export function isExactReviewerVerdictInvocation(toolName: string, args: unknown): boolean {
  if (toolName !== 'ensemble_bossman_control') return false
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
  const record = args as Record<string, unknown>
  const keys = Object.keys(record)
  // Strict set equality: exactly {action, gateId, verdict}. An extra key makes
  // keys.length !== 3; a missing key fails the `in` checks below.
  if (keys.length !== 3) return false
  if (!('action' in record) || !('gateId' in record) || !('verdict' in record)) return false
  if (record.action !== 'submit_review_verdict') return false
  if (typeof record.gateId !== 'string' || record.gateId.trim().length === 0) return false
  if (record.verdict !== 'passed' && record.verdict !== 'failed') return false
  return true
}
