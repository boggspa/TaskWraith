/**
 * ChatRun statuses that project as "still active" on remote/task surfaces.
 * Mirrors `isActiveSubThreadRunStatus` plus `steer_promoting` / `cancelling`
 * so the universal reconciler is a strict superset of the sub-thread path.
 */
const ACTIVE_CHAT_RUN_STATUSES = new Set([
  'running',
  'queued',
  'starting',
  'cancelling',
  'steer_promoting',
  'active',
  'paused'
])

export function isActiveChatRunStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_CHAT_RUN_STATUSES.has(status)
}
