// MAIN-process reconciler for orphaned `chat.runs` rows.
//
// iOS (and desktop bridge projections) treat `status: 'running'` on the latest
// ChatRun as authoritative — there is no live process probe on the phone. When
// TaskWraith restarts, a provider dies without a terminal flush, or a bridge
// transcript is dropped, runs can stay non-terminal on disk forever and pin the
// Active section / thread spinner.
//
// This module is the pure BACKSTOP: given a liveness probe, settle every active
// ChatRun with no live owner to 'failed'. I/O (AppStore writes, task-card /
// thread-list / snapshot pushes) lives in index.ts so this stays unit-testable.
//
// Liveness is injected so the same logic covers:
//   - RunManager sessions
//   - bridge run transcripts
//   - background sub-thread transcripts
//   - non-terminal run-queue jobs (mid-dispatch before a session exists)
//
// Intentionally does NOT settle `sleeping` ensemble participant runs — those
// are waiting on wakeups and may legitimately outlive a process session.

import type { ChatRecord, ChatRun } from './store/types'

/** Terminal status stamped onto a ChatRun settled by this reconciler. */
export const CHAT_RUN_STALE_SETTLEMENT_STATUS = 'failed' as const

/** Default exit code when the orphaned run never recorded one. */
export const CHAT_RUN_STALE_EXIT_CODE = 1

/**
 * Human-readable reason retained in durable run-event audit lines (index.ts).
 * Kept stable so greps / ledgers can correlate reconciler settlements.
 */
export const CHAT_RUN_STALE_REASON =
  'Interrupted with no live RunManager session, bridge transcript, background sub-thread transcript, or non-terminal run-queue job.'

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

export interface StaleChatRunSettlement {
  chatId: string
  runId: string
  previousStatus: string
}

export interface ReconcileStaleChatRunsResult {
  /** Chats that need to be persisted (only those with at least one settlement). */
  chats: ChatRecord[]
  settlements: StaleChatRunSettlement[]
}

export interface ReconcileStaleChatRunsOptions {
  /**
   * Skip settling runs younger than this many ms. Periodic sweeps use a short
   * grace window so a brand-new ChatRun is not false-failed during the gap
   * between transcript seed and RunManager registration. Startup passes 0.
   */
  minAgeMs?: number
  /** Override wall clock for age checks (defaults to `Date.parse(nowIso)`). */
  nowMs?: number
}

export function settleStaleChatRun(run: ChatRun, nowIso: string): ChatRun {
  return {
    ...run,
    status: CHAT_RUN_STALE_SETTLEMENT_STATUS,
    endedAt: run.endedAt ?? nowIso,
    exitCode: run.exitCode ?? CHAT_RUN_STALE_EXIT_CODE
  }
}

/**
 * Window in which a bridge run-transcript entry counts as live purely on its
 * own recent activity. The entry is only load-bearing for liveness in the two
 * short gaps where the run has no active RunManager session (register →
 * session, finish → terminal flush); outside those, a genuinely live run is
 * covered by the RunManager probe. A leaked entry — terminal flush threw, or
 * a lane never finalized — otherwise pinned `isChatRunLive` true for the rest
 * of the process, permanently defeating the periodic reconciler.
 */
export const BRIDGE_TRANSCRIPT_ACTIVITY_GRACE_MS = 60_000

/**
 * Whether a bridge transcript entry's last recorded activity is recent enough
 * to count the run as live. Entries with no recorded activity are NOT live —
 * an unstamped entry is indistinguishable from a leak, and the reconciler's
 * min-age grace already protects freshly seeded runs.
 */
export function bridgeTranscriptActivityIsLive(
  lastActivityAtMs: number | undefined,
  nowMs: number,
  graceMs: number = BRIDGE_TRANSCRIPT_ACTIVITY_GRACE_MS
): boolean {
  return (
    typeof lastActivityAtMs === 'number' &&
    Number.isFinite(lastActivityAtMs) &&
    nowMs - lastActivityAtMs < graceMs
  )
}

export interface ChatRunTerminalSeal {
  status: 'success' | 'failed' | 'cancelled'
  endedAt: string
  stats?: unknown
  exitCode?: number
}

/**
 * Idempotent fill of a ChatRun's terminal fields — the direct-seal fallback
 * for when the bridge lane's terminal flush cannot run. Only fields the live
 * seal never wrote are filled (an already-terminal status, an existing
 * endedAt, and existing stats all win), so racing a completed flush is
 * harmless. Returns null when nothing needs writing so callers can skip the
 * persist entirely.
 */
export function sealChatRunTerminalFields(run: ChatRun, seal: ChatRunTerminalSeal): ChatRun | null {
  const needsStatus = run.status === undefined || isActiveChatRunStatus(run.status)
  const needsEndedAt = !run.endedAt
  const needsStats = run.stats === undefined && seal.stats !== undefined
  const needsExitCode = run.exitCode === undefined && seal.exitCode !== undefined
  if (!needsStatus && !needsEndedAt && !needsStats && !needsExitCode) return null
  return {
    ...run,
    status: needsStatus ? seal.status : run.status,
    endedAt: run.endedAt ?? seal.endedAt,
    ...(needsStats ? { stats: seal.stats } : {}),
    ...(needsExitCode ? { exitCode: seal.exitCode } : {}),
    ...(needsStatus && seal.status === 'cancelled' ? { cancelled: true } : {})
  }
}

/**
 * PURE wedge detector + settler. Returns only chats that changed; does NOT write.
 * Idempotent: already-terminal runs are skipped, so a second pass is a no-op.
 */
export function reconcileStaleChatRuns(
  chats: readonly ChatRecord[],
  isRunLive: (runId: string) => boolean,
  nowIso: string = new Date().toISOString(),
  options: ReconcileStaleChatRunsOptions = {}
): ReconcileStaleChatRunsResult {
  const minAgeMs = Math.max(0, Math.floor(options.minAgeMs ?? 0))
  const nowMs =
    typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.parse(nowIso)
  const updatedAtMs = Number.isFinite(nowMs) ? nowMs : Date.now()

  const settlements: StaleChatRunSettlement[] = []
  const out: ChatRecord[] = []

  for (const chat of chats) {
    if (!chat?.appChatId) continue
    const runs = Array.isArray(chat.runs) ? chat.runs : []
    if (runs.length === 0) continue

    let changed = false
    const nextRuns = runs.map((run) => {
      if (!run || typeof run.runId !== 'string' || !run.runId.trim()) return run
      if (!isActiveChatRunStatus(run.status)) return run
      if (isRunLive(run.runId)) return run

      if (minAgeMs > 0) {
        const startedMs = Date.parse(run.startedAt || '')
        if (Number.isFinite(startedMs) && nowMs - startedMs < minAgeMs) {
          return run
        }
      }

      changed = true
      settlements.push({
        chatId: chat.appChatId,
        runId: run.runId,
        previousStatus: String(run.status)
      })
      return settleStaleChatRun(run, nowIso)
    })

    if (changed) {
      out.push({
        ...chat,
        runs: nextRuns,
        updatedAt: updatedAtMs
      })
    }
  }

  return { chats: out, settlements }
}
