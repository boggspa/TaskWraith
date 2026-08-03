import type { ChatRun } from '../../../main/store/types'

/**
 * Returns thread wall time from completed runs without double-counting
 * concurrent Ensemble seats. When a current run/round start is supplied, the
 * caller adds its live delta separately, so completed spans are capped there
 * before the interval union is measured.
 */
export function computeCumulativeRunBaseMs(
  runs: readonly ChatRun[] | undefined,
  activeStartedAt?: string | null
): number {
  if (!runs || runs.length === 0) return 0
  const activeStart = activeStartedAt ? Date.parse(activeStartedAt) : Number.NaN
  const intervals: Array<{ start: number; end: number }> = []
  for (const run of runs) {
    if (!run.startedAt) continue
    const start = Date.parse(run.startedAt)
    if (!Number.isFinite(start)) continue
    if (!run.endedAt) continue
    const end = Date.parse(run.endedAt)
    if (!Number.isFinite(end)) continue
    const cappedEnd = Number.isFinite(activeStart) ? Math.min(end, activeStart) : end
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
