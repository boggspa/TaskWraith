import type { ChatRecord, ChatRun } from './store/types'
import { isActiveChatRunStatus } from './ChatRunReconciler'

/**
 * Promote a persisted ChatRun from `starting` to `running` once RunManager
 * has a live process.
 *
 * Desktop interactive runs are seeded `starting` in the renderer and never
 * flipped. Measured 2026-08-21: a Kimi ACP seat ran tools for 18 minutes,
 * the queue job was `active`, and ChatRun stayed `starting`. App restart
 * then settled it as "still marked starting with no live process owner".
 *
 * Never demotes a terminal row. Returns the same chat when there is nothing
 * to write so callers can skip save/broadcast.
 */
export function withLiveChatRunStatus(
  chat: ChatRecord,
  runId: string,
  sessionStatus: string
): ChatRecord | null {
  if (sessionStatus !== 'running' || !runId || !chat?.runs?.length) return null
  const runIndex = chat.runs.findIndex((run) => run.runId === runId)
  if (runIndex < 0) return null
  const existing = chat.runs[runIndex]
  if (existing.status === 'running') return null
  // A late RunManager event must never revive a terminal or unknown persisted
  // status. Only known active states (or legacy unstamped rows) may advance.
  if (existing.status && !isActiveChatRunStatus(existing.status)) return null

  const runs: ChatRun[] = [...chat.runs]
  runs[runIndex] = { ...existing, status: 'running' }
  return { ...chat, runs, updatedAt: Date.now() }
}
