import type { AuditRunRecord } from '../../../main/store/types'

export const DISMISSED_AUDIT_RUNS_STORAGE_KEY = 'taskwraith.dismissedAuditRunIds'

export function auditRunTimeKey(run: AuditRunRecord): string {
  return run.updatedAt || run.endedAt || run.startedAt || run.createdAt || ''
}

export function sortAuditRuns(runs: readonly AuditRunRecord[]): AuditRunRecord[] {
  return runs.slice().sort((a, b) => auditRunTimeKey(b).localeCompare(auditRunTimeKey(a)))
}

export function upsertAuditRunList(
  runs: readonly AuditRunRecord[],
  run: AuditRunRecord
): AuditRunRecord[] {
  return sortAuditRuns([run, ...runs.filter((item) => item.id !== run.id)]).slice(0, 30)
}

export function auditActionErrorMessage(fallback: string, err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim()
  if (typeof err === 'string' && err.trim()) return err.trim()
  return fallback
}

export function readDismissedAuditRunIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(DISMISSED_AUDIT_RUNS_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeDismissedAuditRunIds(ids: ReadonlySet<string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      DISMISSED_AUDIT_RUNS_STORAGE_KEY,
      JSON.stringify([...ids].slice(-100))
    )
  } catch {
    // localStorage is optional; the in-memory state still hides it this session.
  }
}
