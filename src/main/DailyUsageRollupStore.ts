/**
 * Persistence for the daily usage rollup — the 365-day tail behind the daily
 * heatmap.
 *
 * Shape and discipline follow `ExternalUsageSnapshot.ts`: explicit path (the
 * scan utility process has no Electron `app`), numeric version, byte cap
 * checked before both parse and write, tmp-with-pid + rename, `0o600`, and
 * every failure best-effort.
 *
 * ONE DELIBERATE DEVIATION from that sibling: a malformed day is dropped and
 * the rest of the file is kept, where the snapshot discards itself wholesale on
 * any bad record. The snapshot can afford that because the next background scan
 * rebuilds it; this file cannot, because the days it holds are exactly the ones
 * no longer reachable from the corpus. Discarding a year of history over one
 * unparseable key would be the bug, not the safety measure.
 */

import { promises as fs } from 'fs'
import { dirname } from 'path'
import {
  DAILY_USAGE_ROLLUP_MAX_DAYS,
  dailyUsageDayBounds,
  pruneDailyUsageRollupDays,
  type DailyUsageDayTotals,
  type DailyUsageDays
} from '../shared/dailyUsageRollup'

const DAILY_USAGE_ROLLUP_VERSION = 1

/** 400 days x ~12 providers of two integers lands near 100 KB. The ceiling is
 * loose enough never to bite in practice and tight enough to refuse a file that
 * has clearly gone wrong. */
const MAX_ROLLUP_BYTES = 4 * 1024 * 1024

/** Guards against a corrupted `days` object with pathological key counts. */
const MAX_ROLLUP_DAY_KEYS = 4_000

/**
 * Records that the one-time deep backfill already ran, so it never repeats.
 *
 * `attempts` is incremented and persisted BEFORE the walk starts, not after it
 * finishes. A crash mid-walk must still burn an attempt — otherwise a backfill
 * that reliably dies re-walks the corpus on every single launch, which is
 * exactly the freeze class this surface exists to avoid.
 *
 * `completedAt === 0` therefore means "attempted, never finished".
 */
export interface DailyUsageBackfillWatermark {
  startedAt: number
  completedAt: number
  lookbackDays: number
  attempts: number
}

export interface DailyUsageRollupFile {
  updatedAt: number
  days: DailyUsageDays
  backfill: DailyUsageBackfillWatermark | null
}

interface StoredDailyUsageRollup {
  version: number
  updatedAt: number
  days: unknown
  backfill?: unknown
}

function normalizeTotal(value: unknown): { tokens: number; runs: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const tokens = Number(record.tokens)
  const runs = Number(record.runs)
  if (!Number.isFinite(tokens) || tokens < 0) return null
  if (!Number.isFinite(runs) || runs < 0) return null
  return { tokens: Math.trunc(tokens), runs: Math.trunc(runs) }
}

function normalizeDayTotals(value: unknown): DailyUsageDayTotals | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const totals: DailyUsageDayTotals = {}
  let kept = 0
  for (const [provider, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!provider) continue
    const total = normalizeTotal(raw)
    if (!total) continue
    totals[provider] = total
    kept += 1
  }
  return kept > 0 ? totals : null
}

function normalizeDays(value: unknown): DailyUsageDays {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ROLLUP_DAY_KEYS) return {}
  const days: DailyUsageDays = {}
  for (const [key, raw] of entries) {
    if (!dailyUsageDayBounds(key)) continue
    const totals = normalizeDayTotals(raw)
    if (!totals) continue
    days[key] = totals
  }
  return days
}

function normalizeBackfill(value: unknown): DailyUsageBackfillWatermark | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const startedAt = Number(record.startedAt)
  const completedAt = Number(record.completedAt)
  const lookbackDays = Number(record.lookbackDays)
  const attempts = Number(record.attempts)
  if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) return null
  if (!Number.isFinite(attempts) || attempts <= 0) return null
  const now = Date.now()
  return {
    // Future stamps would outlive a clock correction; clamp rather than reject,
    // since rejecting resets the attempt counter and re-opens the walk.
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.min(startedAt, now) : 0,
    completedAt: Number.isFinite(completedAt) && completedAt > 0 ? Math.min(completedAt, now) : 0,
    lookbackDays: Math.trunc(lookbackDays),
    attempts: Math.trunc(attempts)
  }
}

/**
 * Read the persisted rollup. Returns `null` only when there is nothing usable
 * at all — a partially damaged file still yields whatever days survived
 * validation, because those days are unrecoverable elsewhere.
 */
export async function loadDailyUsageRollup(
  rollupPath: string
): Promise<DailyUsageRollupFile | null> {
  try {
    const stat = await fs.stat(rollupPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ROLLUP_BYTES) return null
    const raw = await fs.readFile(rollupPath, 'utf8')
    if (Buffer.byteLength(raw, 'utf8') > MAX_ROLLUP_BYTES) return null
    const parsed = JSON.parse(raw) as StoredDailyUsageRollup
    if (parsed?.version !== DAILY_USAGE_ROLLUP_VERSION) return null
    const updatedAt = Number(parsed.updatedAt)
    return {
      updatedAt: Number.isFinite(updatedAt) ? Math.min(updatedAt, Date.now()) : 0,
      days: normalizeDays(parsed.days),
      backfill: normalizeBackfill(parsed.backfill)
    }
  } catch {
    return null
  }
}

/**
 * Persist the rollup atomically. Pruned to the retention ceiling on the way out
 * so a caller cannot grow the file without bound.
 */
export async function persistDailyUsageRollup(
  rollupPath: string,
  file: DailyUsageRollupFile,
  now: number = Date.now()
): Promise<void> {
  const tempPath = `${rollupPath}.tmp-${process.pid}`
  try {
    const days = pruneDailyUsageRollupDays(file.days, now, DAILY_USAGE_ROLLUP_MAX_DAYS)
    const payload = JSON.stringify({
      version: DAILY_USAGE_ROLLUP_VERSION,
      updatedAt: file.updatedAt,
      days,
      backfill: file.backfill ?? undefined
    })
    if (Buffer.byteLength(payload, 'utf8') > MAX_ROLLUP_BYTES) return
    await fs.mkdir(dirname(rollupPath), { recursive: true })
    await fs.writeFile(tempPath, payload, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, rollupPath)
  } catch {
    try {
      await fs.rm(tempPath, { force: true })
    } catch {
      // Best-effort: the next completed scan folds and writes again.
    }
  }
}

/** Attempts beyond this and the one-time backfill is abandoned for good. */
export const MAX_DAILY_USAGE_BACKFILL_ATTEMPTS = 3

/**
 * Whether the one-time deep backfill should run.
 *
 * A missing file means a first launch, so this necessarily returns true — the
 * gate cannot fail closed on absence without the feature never starting. What
 * bounds a repeat is the attempt counter, which the caller persists BEFORE
 * walking; see `DailyUsageBackfillWatermark`. Callers must additionally hold a
 * per-process guard, because a rollup file that cannot be written at all leaves
 * no on-disk state to count with.
 *
 * Returns false once the backfill has completed at least as deep as
 * `lookbackDays`, and false after `MAX_DAILY_USAGE_BACKFILL_ATTEMPTS` tries
 * whether or not any of them finished.
 */
export function shouldRunDailyUsageBackfill(
  file: DailyUsageRollupFile | null,
  lookbackDays: number
): boolean {
  if (!file) return true
  const watermark = file.backfill
  if (!watermark) return true
  if (watermark.attempts >= MAX_DAILY_USAGE_BACKFILL_ATTEMPTS) return false
  if (watermark.completedAt <= 0) return true
  return watermark.lookbackDays < lookbackDays
}
