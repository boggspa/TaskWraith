import type { AuditRunRecord } from '../../../main/store/types'
import { sortAuditRuns } from './auditRunList'

export function auditRunIsActive(run: AuditRunRecord): boolean {
  return run.status === 'planning' || run.status === 'awaitingConfirm' || run.status === 'running'
}

export function selectVisibleAuditRun(
  runs: AuditRunRecord[],
  chatId: string | undefined,
  dismissedIds: ReadonlySet<string>
): AuditRunRecord | null {
  if (!chatId) return null
  const forChat = runs.filter((run) => run.chatId === chatId)
  if (forChat.length === 0) return null

  const active = forChat.find(auditRunIsActive)
  if (active) return active

  const latest = sortAuditRuns(forChat)[0]
  return latest && !dismissedIds.has(latest.id) ? latest : null
}
