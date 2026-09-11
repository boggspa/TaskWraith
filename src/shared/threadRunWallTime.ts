/**
 * One thread's wall time: the union of its completed run intervals.
 *
 * Shared because the number has to be produced on BOTH sides of the record
 * projections. The renderer can compute it exactly from a hydrated
 * `ChatRecord.runs`, but every summary projection — the catalogue row
 * (`catalogueChatListItem`), the paged shell (`buildChatShell`), the compact
 * live update (`ChatUpdateInterestRouter.projectCompactChat`), the renderer
 * byte-LRU demotion (`demoteChatToSummary`) — ships `runs: []`. A consumer of
 * one of those rows has no array left to walk, so the aggregate has to travel
 * with the row as a scalar, exactly the way `runCount` already does.
 *
 * Union, not sum: parallel Ensemble seats overlap in real time, and a thread
 * that ran three seats for ten seconds spent ten seconds, not thirty.
 */

/** The only two run fields this measurement reads. */
export interface ThreadRunWallSpan {
  startedAt?: string | null
  endedAt?: string | null
}

/**
 * Milliseconds of thread wall time contributed by COMPLETED runs.
 *
 * In-flight runs (no `endedAt`) contribute nothing: a live surface adds their
 * delta itself, once, so counting them here would double them. `until` caps
 * completed spans at the live run/round boundary for the same reason — pass
 * the active start when a caller is about to add a live delta, and omit it
 * when measuring a settled thread.
 */
export function computeThreadRunWallMs(
  runs: readonly ThreadRunWallSpan[] | null | undefined,
  until?: string | null
): number {
  if (!runs || runs.length === 0) return 0
  const ceiling = until ? Date.parse(until) : Number.NaN
  const intervals: Array<{ start: number; end: number }> = []
  for (const run of runs) {
    if (!run?.startedAt) continue
    const start = Date.parse(run.startedAt)
    if (!Number.isFinite(start)) continue
    if (!run.endedAt) continue
    const end = Date.parse(run.endedAt)
    if (!Number.isFinite(end)) continue
    const cappedEnd = Number.isFinite(ceiling) ? Math.min(end, ceiling) : end
    if (cappedEnd <= start) continue
    intervals.push({ start, end: cappedEnd })
  }

  if (intervals.length === 0) return 0
  intervals.sort((left, right) => left.start - right.start)

  let total = 0
  let currentStart = intervals[0].start
  let currentEnd = intervals[0].end
  for (let index = 1; index < intervals.length; index += 1) {
    const interval = intervals[index]
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end)
      continue
    }
    total += currentEnd - currentStart
    currentStart = interval.start
    currentEnd = interval.end
  }
  total += currentEnd - currentStart
  return total
}

/**
 * The scalar a summary projection carries. Built from the canonical array at
 * the moment the projection strips it, so it is uncapped by construction —
 * the projector does not know which run a later reader will treat as live.
 */
export function projectThreadRunWallMs(
  runs: readonly ThreadRunWallSpan[] | null | undefined
): number {
  return computeThreadRunWallMs(runs)
}

/** A carried `runWallMs`, or null when the row predates the field or is malformed. */
export function readThreadRunWallMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}
