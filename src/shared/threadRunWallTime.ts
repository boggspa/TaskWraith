/**
 * One thread's wall time: completed solo-run intervals plus whole completed
 * Ensemble-round intervals.
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
 * Parallel Ensemble seats overlap in real time, and preparation/handoffs are
 * part of their enclosing round. New terminal rounds persist their exact
 * duration in a compact id-keyed ledger. The terminal `activeRound` bridges a
 * close that has not reached that ledger. Older rounds without either retain
 * the explicitly approximate union-of-seat-runs fallback.
 */

/** The only run fields this measurement reads. */
export interface ThreadRunWallSpan {
  startedAt?: string | null
  endedAt?: string | null
  ensembleRoundId?: string | null
}

/** Structural slice of Ensemble state used by the shared projection layer. */
export interface ThreadEnsembleWallTimeSource {
  activeRound?: {
    roundId?: string | null
    status?: string | null
    startedAt?: string | null
    endedAt?: string | null
  } | null
  roundWallMsById?: unknown
}

interface WallInterval {
  start: number
  end: number
}

const TERMINAL_ENSEMBLE_ROUND_STATUSES = new Set(['completed', 'cancelled', 'failed'])

function parsedTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function roundId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null
}

function unionWallIntervals(intervals: WallInterval[]): number {
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
 * Milliseconds of completed thread wall time.
 *
 * In-flight runs (no `endedAt`) contribute nothing: a live surface adds their
 * delta itself, once, so counting them here would double them. `until` caps
 * completed spans at the live run/round boundary for the same reason — pass
 * the active start when a caller is about to add a live delta, and omit it
 * when measuring a settled thread.
 */
export function computeThreadRunWallMs(
  runs: readonly ThreadRunWallSpan[] | null | undefined,
  until?: string | null,
  ensemble?: ThreadEnsembleWallTimeSource | null
): number {
  const ceiling = until ? Date.parse(until) : Number.NaN
  const intervals: WallInterval[] = []

  const representedRoundIds = new Set<string>()
  const liveRoundId =
    ensemble?.activeRound?.status === 'running' ? roundId(ensemble.activeRound.roundId) : null
  if (liveRoundId) representedRoundIds.add(liveRoundId)

  let exactRoundWallMs = 0
  for (const [key, value] of Object.entries(record(ensemble?.roundWallMsById) || {})) {
    const id = roundId(key)
    if (
      !id ||
      id === liveRoundId ||
      representedRoundIds.has(id) ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      continue
    }
    exactRoundWallMs += Math.floor(value)
    representedRoundIds.add(id)
  }

  const appendInterval = (start: number | null, end: number | null): boolean => {
    if (start === null || end === null) return false
    const cappedEnd = Number.isFinite(ceiling) ? Math.min(end, ceiling) : end
    if (cappedEnd <= start) return false
    intervals.push({ start, end: cappedEnd })
    return true
  }

  const activeRound = ensemble?.activeRound
  const terminalRoundId =
    activeRound && TERMINAL_ENSEMBLE_ROUND_STATUSES.has(activeRound.status || '')
      ? roundId(activeRound.roundId)
      : null
  if (terminalRoundId && !representedRoundIds.has(terminalRoundId)) {
    const start = parsedTimestamp(activeRound?.startedAt)
    const end = parsedTimestamp(activeRound?.endedAt)
    if (start !== null && end !== null && end >= start) {
      exactRoundWallMs += end - start
      representedRoundIds.add(terminalRoundId)
    }
  }

  for (const run of runs || []) {
    const id = roundId(run?.ensembleRoundId)
    if (id && representedRoundIds.has(id)) continue
    appendInterval(parsedTimestamp(run?.startedAt), parsedTimestamp(run?.endedAt))
  }

  return exactRoundWallMs + unionWallIntervals(intervals)
}

/**
 * The scalar a summary projection carries. Built before the projection strips
 * the run array and compact round ledger. A live round is excluded because the
 * surface adds its round-start delta itself.
 */
export function projectThreadRunWallMs(
  runs: readonly ThreadRunWallSpan[] | null | undefined,
  ensemble?: ThreadEnsembleWallTimeSource | null
): number {
  return computeThreadRunWallMs(runs, undefined, ensemble)
}

/** A carried `runWallMs`, or null when the row predates the field or is malformed. */
export function readThreadRunWallMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null
}
