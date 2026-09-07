/**
 * Bounds for the boot chat sweeps.
 *
 * Every pre-window sweep used to parse the whole corpus on the main thread to
 * reach a handful of chats: measured on Chris's profile 2026-09-07, ~1GB
 * across ~510 files parsed SEVERAL times over (stale-run sweep, ensemble
 * wakeups, solo wakeups, orphan-job settle, worker-queue recovery), which is
 * the multi-minute pre-window stall — and profiles past the V8 ceiling never
 * launch at all.
 *
 * The index-vouch prefilters narrow those sweeps once the index is fresh, but
 * every uncertainty widens to a candidate, so a stale index still parses
 * everything. The bound here is orthogonal: it caps HOW MUCH the pre-window
 * pass may parse, whatever the index says. Candidates are taken most-recently
 * modified first, so the bound always covers the most recent activity from the
 * most recent chats — the only surface launch needs — and the deferred
 * post-paint sweep (src/main/startup/DeferredBootSweeps.ts) covers the
 * remainder with the same predicates, just later.
 *
 * Truncation is a DEFERRAL, never a skip: nothing truncated here is settled,
 * expired, or dropped, so the error-direction paranoia of the candidate
 * selectors does not apply. The one hard guarantee is at-least-one: a
 * non-empty candidate set always yields at least its most recent chat, even
 * when that chat alone exceeds the byte budget.
 */

export interface SweepFileStat {
  chatId: string
  mtimeMs: number
  size: number
}

export interface SweepBudget {
  /** Maximum chats parsed in one bounded pass. */
  maxChats: number
  /** Maximum cumulative file bytes parsed in one bounded pass. */
  maxBytes: number
}

/**
 * Pre-window parse budget. Sized so the whole pre-paint sweep admits seconds
 * of JSON parsing, not minutes: 25 files or 64MB of file bytes, whichever
 * binds first. File size overestimates parse cost slightly (UTF-8 expansion),
 * which errs toward fewer parses — the safe direction for a launch path.
 */
export const PRE_WINDOW_SWEEP_BUDGET: SweepBudget = {
  maxChats: 25,
  maxBytes: 64 * 1024 * 1024
}

/**
 * Parse bytes per deferred-sweep slice. The post-paint sweep yields the event
 * loop between slices so chat IPC stays responsive while it works through the
 * corpus; 16MB keeps each slice to roughly a second of parsing on the slow end.
 */
export const DEFERRED_SWEEP_SLICE_BYTES = 16 * 1024 * 1024

function finiteSize(size: number): number {
  return Number.isFinite(size) && size > 0 ? size : 0
}

function finiteMtime(mtimeMs: number): number {
  return Number.isFinite(mtimeMs) ? mtimeMs : Number.NEGATIVE_INFINITY
}

/**
 * Order sweep stats most-recently modified first. Chat id breaks ties so the
 * order is deterministic across boots; entries with no usable id are dropped,
 * and entries with an unreadable mtime sort last (their read will fail cheaply
 * or not at all — they must never displace a known-recent chat from a budget).
 */
export function orderSweepStatsByRecency(stats: readonly SweepFileStat[]): SweepFileStat[] {
  return [...stats]
    .filter((stat) => typeof stat?.chatId === 'string' && stat.chatId !== '')
    .sort((a, b) => {
      const delta = finiteMtime(b.mtimeMs) - finiteMtime(a.mtimeMs)
      if (delta !== 0) return delta
      return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0
    })
}

/**
 * Take the leading stats that fit the budget. The input must already be in
 * recency order (see orderSweepStatsByRecency). Always returns at least the
 * first stat when one exists, even if it alone exceeds the byte budget — the
 * most recent chat is what launch needs.
 */
export function truncateSweepToBudget(
  stats: readonly SweepFileStat[],
  budget: SweepBudget
): SweepFileStat[] {
  const out: SweepFileStat[] = []
  let bytes = 0
  for (const stat of stats) {
    const size = finiteSize(stat.size)
    if (out.length > 0 && (out.length >= budget.maxChats || bytes + size > budget.maxBytes)) break
    out.push(stat)
    bytes += size
  }
  return out
}

/**
 * Split recency-ordered stats into slices of at most maxBytesPerSlice file
 * bytes for the deferred sweep's yield-between-slices driver. Order is
 * preserved, so the most recent chats still settle first. A single chat larger
 * than the slice budget gets a slice of its own rather than blocking the
 * sweep or being split mid-record.
 */
export function planSweepSlices(
  stats: readonly SweepFileStat[],
  maxBytesPerSlice: number = DEFERRED_SWEEP_SLICE_BYTES
): SweepFileStat[][] {
  const cap =
    Number.isFinite(maxBytesPerSlice) && maxBytesPerSlice > 0
      ? maxBytesPerSlice
      : DEFERRED_SWEEP_SLICE_BYTES
  const slices: SweepFileStat[][] = []
  let current: SweepFileStat[] = []
  let bytes = 0
  for (const stat of stats) {
    const size = finiteSize(stat.size)
    if (current.length > 0 && bytes + size > cap) {
      slices.push(current)
      current = []
      bytes = 0
    }
    current.push(stat)
    bytes += size
  }
  if (current.length > 0) slices.push(current)
  return slices
}
