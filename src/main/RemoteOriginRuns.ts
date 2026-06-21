/**
 * Registry of runs initiated by a REMOTE (phone) bridge composer prompt.
 *
 * Cross-thread recall is blocked from these runs: a recall like "yesterday
 * ~6pm" resolves in the HOST's timezone, which may differ from the remote
 * user's, so a phone-issued query could silently read the wrong day's run.
 * Until phone-timezone propagation lands, time-based recall stays desktop-only.
 *
 * In-memory + bounded — lost on restart, which is fine: a run that outlives a
 * restart is terminal and won't issue new tool calls. Marked at the single
 * remote-composer dispatch point in index.ts; checked by the recall gate.
 */
const remoteOriginRunIds = new Set<string>()
const MAX_TRACKED = 5000

export function markRemoteOriginRun(runId: string | null | undefined): void {
  if (!runId) return
  if (remoteOriginRunIds.size >= MAX_TRACKED) {
    // Bounded ring: drop the oldest (Set preserves insertion order).
    const oldest = remoteOriginRunIds.values().next().value
    if (oldest) remoteOriginRunIds.delete(oldest)
  }
  remoteOriginRunIds.add(runId)
}

export function isRemoteOriginRun(runId: string | null | undefined): boolean {
  return Boolean(runId && remoteOriginRunIds.has(runId))
}

/** Test-only reset. */
export function __resetRemoteOriginRuns(): void {
  remoteOriginRunIds.clear()
}
