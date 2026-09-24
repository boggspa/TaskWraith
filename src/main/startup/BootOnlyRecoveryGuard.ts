/**
 * Decides whether the boot-only startup recovery steps are still safe to run
 * after a mid-session authority retry.
 *
 * `recoverRunQueueJobsAfterStartup` settles every job in an ACTIVE status
 * without proving its process is dead — correct at boot, where no run of this
 * process can exist, and wrong afterwards, where it would fail a live run. The
 * execution-graph and workflow-ledger recoveries carry the same assumption.
 *
 * So the guard is conservative and structural rather than clever: boot-only
 * recovery is safe only if the run queue is byte-for-byte the shape it had when
 * the process started. Any new job, any status change, and we restore the
 * authority but ask for a restart instead.
 */
export interface BootOnlyRecoveryRunShape {
  runId: string
  status: string
}

export type BootOnlyRecoveryVerdict =
  | { safe: true }
  | { safe: false; reason: 'run_started' | 'run_status_changed' | 'run_removed' }

export function captureBootOnlyRecoveryShape(
  jobs: readonly { runId: string; status: string }[]
): BootOnlyRecoveryRunShape[] {
  return jobs
    .map((job) => ({ runId: job.runId, status: job.status }))
    .sort((left, right) => left.runId.localeCompare(right.runId))
}

export function bootOnlyRecoveryVerdict(
  atBoot: readonly BootOnlyRecoveryRunShape[],
  now: readonly BootOnlyRecoveryRunShape[]
): BootOnlyRecoveryVerdict {
  const before = new Map(atBoot.map((entry) => [entry.runId, entry.status]))
  const after = new Map(now.map((entry) => [entry.runId, entry.status]))
  for (const [runId, status] of after) {
    if (!before.has(runId)) return { safe: false, reason: 'run_started' }
    if (before.get(runId) !== status) return { safe: false, reason: 'run_status_changed' }
  }
  for (const runId of before.keys()) {
    if (!after.has(runId)) return { safe: false, reason: 'run_removed' }
  }
  return { safe: true }
}
