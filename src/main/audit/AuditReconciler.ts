// Slice 6 — startup reconciler for orphaned audit runs.
//
// AuditOrchestrator persists its run record to audit-runs.json but holds its LIVE
// execution state only on the JS call stack (it's a run-once DAG with no resume),
// and it is a hard singleton gated by an in-memory `auditRunInFlight` flag that
// resets to false on restart. So an audit interrupted by a crash/quit is left on
// disk at status 'planning'/'awaitingConfirm'/'running' FOREVER — never marked
// terminal, and (pre-slice-6) never reconciled. This mirrors the workflow ledger's
// reconcileStaleLedgerExecutions: at BOOT, any non-terminal run is orphaned by
// definition (its process is gone), so it is safe to settle without any age/backstop.

import type { AuditRunRecord, AuditRunStatus } from '../store/types'

const AUDIT_TERMINAL_STATUSES: ReadonlySet<AuditRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled'
])

/** The error stamped onto an audit run settled by the startup reconciler. */
export const AUDIT_RESTART_INTERRUPTION_ERROR =
  'Audit interrupted by an app restart (audit runs do not resume).'

export interface StaleAuditRun {
  id: string
  previousStatus: AuditRunStatus
}

/**
 * PURE — the audit runs left non-terminal by a crash/quit mid-run. Does NOT write
 * (the AppStore seam applies the terminal mark). No age/backstop: a non-terminal
 * run at BOOT is orphaned by definition. Idempotent — once settled to a terminal
 * status, a re-boot skips it.
 */
export function findStaleAuditRuns(runs: readonly AuditRunRecord[]): StaleAuditRun[] {
  const stale: StaleAuditRun[] = []
  for (const run of runs) {
    if (!run || typeof run.id !== 'string' || !run.id) continue
    if (AUDIT_TERMINAL_STATUSES.has(run.status)) continue
    stale.push({ id: run.id, previousStatus: run.status })
  }
  return stale
}
