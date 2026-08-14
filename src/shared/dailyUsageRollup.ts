/**
 * Daily usage rollup — the long-horizon tail behind the 365-day heatmap.
 *
 * The External Activity scan keeps hour-resolution buckets for 90 days
 * (`externalUsageBuckets.ts`) and the file cache it parses from is pruned to the
 * same window, so day 91+ is unrecoverable from the live corpus once the source
 * files age past `collectFiles`'s mtime floor. This module is the durable
 * remainder: one token total and one run count per provider per LOCAL calendar
 * day, folded forward on every completed scan and never recomputed from the
 * corpus.
 *
 * Two invariants make that safe to run repeatedly:
 *
 * 1. **A fold REPLACES the days its scan actually covered and KEEPS every other
 *    day.** Adding would double-count on the next scan; replacing wholesale
 *    outside the observed window would erase the tail this store exists to hold.
 *    A day only partially covered by the scan (the rolling `sinceMs` cutoff
 *    always slices its oldest day) takes a per-provider max instead, because the
 *    incoming total for that day is known to be short.
 *
 * 2. **Day keys are LOCAL wall-clock**, matching `buildDailyTokenSeries` and
 *    `externalActivityWindowBounds`, so a rollup day and a heatmap column are
 *    the same day for the person reading them.
 *
 * This also resolves an ordering hazard with `usageRotation.ts`: TaskWraith's
 * own records rotate out of `getUsage` at 200 days, whose doc comment reasons
 * that rotation must never shrink what a live surface can display. A 365-day
 * surface would break that — except a day folded here survives the rotation
 * that later drops its records, so the rollup, not the journal, is what the
 * long window reads.
 */

import { externalActivityRecordTokens } from './usageAccounting'
import { usageRecordRunCount } from './externalUsageBuckets'

/** Days retained on disk. 365 are drawn; the margin absorbs DST and the
 * partial-day boundary so the oldest visible column is never half-pruned. */
export const DAILY_USAGE_ROLLUP_MAX_DAYS = 400

/** Days the 365-day heatmap draws. */
export const DAILY_USAGE_HEATMAP_DAYS = 365

export interface DailyUsageProviderTotal {
  tokens: number
  /** Turn count, honouring the `runCount` contract of aggregated buckets. */
  runs: number
}

/** provider id -> totals, for one local calendar day. */
export type DailyUsageDayTotals = Record<string, DailyUsageProviderTotal>

/** 'YYYY-MM-DD' (local) -> per-provider totals. */
export type DailyUsageDays = Record<string, DailyUsageDayTotals>

/** What `get-daily-usage-rollup` returns. Deliberately small — a few hundred
 * days of two integers per provider — so it crosses the contextBridge deep-copy
 * cheaply, unlike a record array. */
export interface DailyUsageRollupPayload {
  updatedAt: number
  days: DailyUsageDays
  backfill: {
    startedAt: number
    completedAt: number
    lookbackDays: number
    attempts: number
  } | null
}

export interface DailyUsageFoldOptions {
  /**
   * The period the supplying scan actually covered, inclusive. Days fully
   * inside it are authoritative and replace what is stored; days straddling a
   * bound are merged by max; days outside are untouched.
   */
  observedFromMs: number
  observedToMs: number
  now?: number
  maxDays?: number
}

export interface DailyUsageTokenRecordLike {
  provider?: string
  timestamp: number
  usageKind?: 'run' | 'reset_hint'
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  runCount?: number
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** Local calendar day key for a timestamp. Mirrors `DailyTokenSeries.dayKey`. */
export function dailyUsageDayKey(timestamp: number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Inclusive local-midnight bounds of the day a key names. */
export function dailyUsageDayBounds(dayKey: string): { startMs: number; endMs: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const start = new Date(year, month - 1, day, 0, 0, 0, 0)
  // Round-trip guard: `new Date(2026, 1, 31)` silently rolls into March.
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    return null
  }
  const end = new Date(start)
  end.setHours(23, 59, 59, 999)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

/** Ordered list of the `dayCount` local day keys ending at `now`'s day. */
export function dailyUsageDayKeyRange(now: number, dayCount: number): string[] {
  const days = Math.max(1, Math.round(dayCount))
  const cursor = new Date(now)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - (days - 1))
  const keys: string[] = []
  for (let index = 0; index < days; index += 1) {
    keys.push(dailyUsageDayKey(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return keys
}

function emptyTotal(): DailyUsageProviderTotal {
  return { tokens: 0, runs: 0 }
}

function accumulate(
  into: DailyUsageDayTotals,
  provider: string,
  tokens: number,
  runs: number
): void {
  const existing = into[provider] ?? emptyTotal()
  into[provider] = { tokens: existing.tokens + tokens, runs: existing.runs + runs }
}

/**
 * Bucket records into per-day/per-provider totals. Zero-token rows still
 * contribute `runs` — Cursor daily-stat rows and Codex SQLite markers are real
 * activity that colours a cell without inventing spend.
 */
export function buildDailyUsageTotals(
  records: readonly DailyUsageTokenRecordLike[]
): DailyUsageDays {
  const days: DailyUsageDays = {}
  for (const record of records) {
    if (record.usageKind === 'reset_hint') continue
    if (!Number.isFinite(record.timestamp)) continue
    const key = dailyUsageDayKey(record.timestamp)
    const tokens = externalActivityRecordTokens(record)
    const runs = usageRecordRunCount(record)
    const bucket = (days[key] ??= {})
    accumulate(bucket, record.provider || 'unknown', tokens, runs)
  }
  return days
}

function mergeByMax(
  existing: DailyUsageDayTotals | undefined,
  incoming: DailyUsageDayTotals | undefined
): DailyUsageDayTotals {
  const merged: DailyUsageDayTotals = {}
  for (const provider of new Set([
    ...Object.keys(existing ?? {}),
    ...Object.keys(incoming ?? {})
  ])) {
    const a = existing?.[provider] ?? emptyTotal()
    const b = incoming?.[provider] ?? emptyTotal()
    merged[provider] = { tokens: Math.max(a.tokens, b.tokens), runs: Math.max(a.runs, b.runs) }
  }
  return merged
}

/**
 * Fold already-bucketed days into the stored rollup.
 *
 * See the module header: replace fully-observed days, max-merge the partial
 * boundary day, keep everything else. Idempotent for a fixed scan window, which
 * is what lets this run on every completed scan.
 *
 * This is the days-in entry point, used by the deep backfill, which buckets
 * inside the scan utility process so a wide record array never crosses the
 * process boundary. `foldUsageRecordsIntoDailyRollup` is the records-in wrapper
 * over the same rule — there is deliberately only one implementation of it.
 */
export function foldDailyUsageDaysIntoRollup(
  base: DailyUsageDays,
  incoming: DailyUsageDays,
  options: DailyUsageFoldOptions
): DailyUsageDays {
  const next: DailyUsageDays = {}
  const { observedFromMs, observedToMs } = options

  for (const key of new Set([...Object.keys(base), ...Object.keys(incoming)])) {
    const bounds = dailyUsageDayBounds(key)
    if (!bounds) continue
    const outsideWindow = bounds.endMs < observedFromMs || bounds.startMs > observedToMs
    if (outsideWindow) {
      const kept = base[key]
      if (kept) next[key] = kept
      continue
    }
    const fullyObserved = bounds.startMs >= observedFromMs && bounds.endMs <= observedToMs
    if (fullyObserved) {
      const replacement = incoming[key]
      // A fully-observed day with no records is a genuine zero, not a gap.
      if (replacement) next[key] = replacement
      continue
    }
    next[key] = mergeByMax(base[key], incoming[key])
  }

  return pruneDailyUsageRollupDays(next, options.now ?? Date.now(), options.maxDays)
}

/** Records-in wrapper over `foldDailyUsageDaysIntoRollup`. */
export function foldUsageRecordsIntoDailyRollup(
  base: DailyUsageDays,
  records: readonly DailyUsageTokenRecordLike[],
  options: DailyUsageFoldOptions
): DailyUsageDays {
  return foldDailyUsageDaysIntoRollup(base, buildDailyUsageTotals(records), options)
}

/** Keep the newest `maxDays` day keys, dropping days newer than today too —
 * a clock roll-back must not strand a future key that never prunes. */
export function pruneDailyUsageRollupDays(
  days: DailyUsageDays,
  now: number,
  maxDays: number = DAILY_USAGE_ROLLUP_MAX_DAYS
): DailyUsageDays {
  const limit = Math.max(1, Math.round(maxDays))
  const todayKey = dailyUsageDayKey(now)
  const keys = Object.keys(days)
    .filter((key) => dailyUsageDayBounds(key) !== null && key <= todayKey)
    .sort()
  const kept = keys.slice(Math.max(0, keys.length - limit))
  const pruned: DailyUsageDays = {}
  for (const key of kept) pruned[key] = days[key]
  return pruned
}

/** Total tokens across every provider on one day. */
export function dailyUsageDayTokens(totals: DailyUsageDayTotals | undefined): number {
  if (!totals) return 0
  let sum = 0
  for (const value of Object.values(totals)) sum += value.tokens
  return sum
}

/** Total runs across every provider on one day. */
export function dailyUsageDayRuns(totals: DailyUsageDayTotals | undefined): number {
  if (!totals) return 0
  let sum = 0
  for (const value of Object.values(totals)) sum += value.runs
  return sum
}

/**
 * The provider whose tokens dominate a day — this is the accent the day's chip
 * wears. `order` breaks ties deterministically; providers outside it can still
 * win outright so a new seat is never invisible.
 */
export function dominantProviderForDay(
  totals: DailyUsageDayTotals | undefined,
  order: readonly string[]
): string | null {
  if (!totals) return null
  let dominant: string | null = null
  let dominantTokens = 0
  let dominantRank = Number.MAX_SAFE_INTEGER
  for (const [provider, value] of Object.entries(totals)) {
    if (value.tokens <= 0) continue
    const rank = order.indexOf(provider)
    const rankValue = rank < 0 ? Number.MAX_SAFE_INTEGER - 1 : rank
    if (
      value.tokens > dominantTokens ||
      (value.tokens === dominantTokens && rankValue < dominantRank)
    ) {
      dominant = provider
      dominantTokens = value.tokens
      dominantRank = rankValue
    }
  }
  if (dominant) return dominant
  // Token-less activity days still deserve an accent; fall back to run counts.
  let fallback: string | null = null
  let fallbackRuns = 0
  let fallbackRank = Number.MAX_SAFE_INTEGER
  for (const [provider, value] of Object.entries(totals)) {
    if (value.runs <= 0) continue
    const rank = order.indexOf(provider)
    const rankValue = rank < 0 ? Number.MAX_SAFE_INTEGER - 1 : rank
    if (value.runs > fallbackRuns || (value.runs === fallbackRuns && rankValue < fallbackRank)) {
      fallback = provider
      fallbackRuns = value.runs
      fallbackRank = rankValue
    }
  }
  return fallback
}
