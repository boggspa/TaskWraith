/**
 * The daily-rollup pipeline: fold every completed scan forward, and seed the
 * tail once with a deep backfill.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. The rollup needs a walk wider than the
 * 90-day scan, and this codebase has been burned three times by wide corpus
 * walks reaching the launch path. Every constraint below is one of those
 * lessons, not a preference:
 *
 *  - **It runs at most once per install.** The watermark is stamped BEFORE the
 *    walk, so a crash still burns an attempt; three failures and it is
 *    abandoned. The stamp is then READ BACK, and the walk is skipped outright
 *    if it did not survive — because every persistence failure here is
 *    swallowed, and without on-disk state to count with, the per-process guard
 *    would bound this to once per LAUNCH rather than once per install.
 *  - **It never touches the shared 90-day file cache.** That cache is pruned to
 *    whatever window the current pass used, so a wide pass and a narrow pass
 *    would delete each other's entries and re-parse the corpus on every
 *    alternation. The backfill gets throwaway cache paths and deletes them
 *    afterwards.
 *  - **It does not go through `startExternalScan`.** That front door returns
 *    the in-flight scan and discards a joined caller's options, so the wide
 *    request would be silently downgraded to whatever was already running.
 *  - **It buckets to per-day totals inside the utility process**, so no wide
 *    record array crosses the process boundary.
 *  - **It is caller-deferred.** Nothing here schedules itself; the caller
 *    starts it well after first paint, on the same footing as the ordinary
 *    prewarm.
 */

import { promises as fs } from 'fs'
import {
  DAILY_USAGE_ROLLUP_MAX_DAYS,
  foldDailyUsageDaysIntoRollup,
  foldUsageRecordsIntoDailyRollup,
  type DailyUsageDays
} from '../shared/dailyUsageRollup'
import {
  loadDailyUsageRollup,
  persistDailyUsageRollup,
  shouldRunDailyUsageBackfill,
  type DailyUsageRollupFile
} from './DailyUsageRollupStore'
import type {
  ExternalScanCompletion,
  ExternalProviderActivityOptions
} from './ExternalProviderActivity'

const MS_PER_DAY = 86_400_000

/** How deep the one-time backfill walks. Matches the rollup's retention so a
 * single pass fills everything the store can hold. */
export const DAILY_USAGE_BACKFILL_LOOKBACK_DAYS = DAILY_USAGE_ROLLUP_MAX_DAYS

export interface DailyUsageRollupPipelineDeps {
  dailyRollupPath: string
  backfillFileCachePath: string
  backfillCursorCachePath: string
  runBackfill: (options: ExternalProviderActivityOptions) => Promise<DailyUsageDays>
  /** Stamps the watermark only. Retention always prunes against the real wall
   * clock — see `recordCompletedScanInDailyRollup`. */
  now?: () => number
  onError?: (error: unknown) => void
}

/** Serialises reads and writes of the rollup file. Two folds racing would each
 * read the same base and the later write would drop the earlier one's days. */
let writeChain: Promise<void> = Promise.resolve()

/** One backfill per process, whatever the on-disk state says. */
let backfillStartedThisProcess = false

/** Joins concurrent callers. The watermark check is async, so a bare boolean
 * flag set after the first `await` lets every concurrent caller past it. */
let backfillInFlight: Promise<boolean> | null = null

function enqueue(work: () => Promise<void>, onError?: (error: unknown) => void): Promise<void> {
  writeChain = writeChain.then(work).catch((error) => {
    onError?.(error)
  })
  return writeChain
}

export function resetDailyUsageRollupPipelineForTests(): void {
  writeChain = Promise.resolve()
  backfillStartedThisProcess = false
  backfillInFlight = null
}

/** Awaits any in-flight fold/backfill write. Test seam. */
export function settleDailyUsageRollupWritesForTests(): Promise<void> {
  return writeChain
}

async function readRollup(path: string): Promise<DailyUsageRollupFile> {
  const loaded = await loadDailyUsageRollup(path)
  return loaded ?? { updatedAt: 0, days: {}, backfill: null }
}

/**
 * Fold one completed full-window scan into the rollup.
 *
 * The observed window is the scan's own rolling cutoff, so its oldest day is
 * partial by construction — the fold max-merges that day rather than replacing
 * it. See `dailyUsageRollup.ts`.
 */
export function recordCompletedScanInDailyRollup(
  completion: ExternalScanCompletion,
  deps: Pick<DailyUsageRollupPipelineDeps, 'dailyRollupPath' | 'onError'>
): Promise<void> {
  return enqueue(async () => {
    const existing = await readRollup(deps.dailyRollupPath)
    // Retention prunes against the WALL CLOCK, never against the scan's own
    // timestamp. Pruning drops days after "today", so a scan that completes
    // out of order — or after a clock adjustment — would otherwise delete
    // every day newer than itself as if it were in the future.
    const prunedAt = Date.now()
    const days = foldUsageRecordsIntoDailyRollup(existing.days, completion.records, {
      observedFromMs: completion.scannedAt - completion.lookbackDays * MS_PER_DAY,
      observedToMs: completion.scannedAt,
      now: prunedAt
    })
    await persistDailyUsageRollup(
      deps.dailyRollupPath,
      { ...existing, updatedAt: Math.max(existing.updatedAt, completion.scannedAt), days },
      prunedAt
    )
  }, deps.onError)
}

/**
 * Delete the backfill's scratch caches.
 *
 * Called both before and after a walk. The `finally` after covers a worker
 * crash or timeout but NOT the process exiting mid-walk, and the file cache is
 * checkpointed after every provider — so a partial one exists within seconds of
 * starting. Built over 400 days it is a superset of the live 90-day cache,
 * which has been measured in the hundreds of MB. On a machine this repo has
 * already seen filled to 926 GB, that is worth clearing on the way in as well
 * as on the way out.
 */
async function removeScratchCaches(deps: DailyUsageRollupPipelineDeps): Promise<void> {
  for (const path of [deps.backfillFileCachePath, deps.backfillCursorCachePath]) {
    try {
      await fs.rm(path, { force: true })
    } catch {
      // Best-effort; a leftover scratch cache costs disk, never correctness.
    }
  }
}

/**
 * Run the one-time deep backfill if it is still owed.
 *
 * Resolves `false` without doing any work when the watermark, the attempt
 * ceiling or the per-process guard says it has already been tried. Never
 * throws: a failed backfill leaves the rollup exactly as it was, and the
 * ordinary per-scan fold keeps extending it forward regardless.
 */
export function runDailyUsageBackfillIfNeeded(
  deps: DailyUsageRollupPipelineDeps
): Promise<boolean> {
  if (backfillStartedThisProcess) return Promise.resolve(false)
  if (backfillInFlight) return backfillInFlight
  backfillInFlight = runDailyUsageBackfill(deps).finally(() => {
    backfillInFlight = null
  })
  return backfillInFlight
}

async function runDailyUsageBackfill(deps: DailyUsageRollupPipelineDeps): Promise<boolean> {
  const now = deps.now ?? Date.now
  const existing = await readRollup(deps.dailyRollupPath)
  if (!shouldRunDailyUsageBackfill(existing, DAILY_USAGE_BACKFILL_LOOKBACK_DAYS)) return false
  backfillStartedThisProcess = true

  const startedAt = now()
  // A scratch cache orphaned by a previous process exiting mid-walk is never
  // cleaned by that run's `finally`. Clear before starting so at most one can
  // exist, rather than one per abandoned attempt.
  await removeScratchCaches(deps)

  // Stamp the attempt BEFORE walking: a crash mid-walk must still cost one, or
  // a reliably-dying backfill re-walks the corpus on every launch.
  const attempts = (existing.backfill?.attempts ?? 0) + 1
  await enqueue(async () => {
    const base = await readRollup(deps.dailyRollupPath)
    await persistDailyUsageRollup(
      deps.dailyRollupPath,
      {
        ...base,
        backfill: {
          startedAt,
          completedAt: 0,
          lookbackDays: DAILY_USAGE_BACKFILL_LOOKBACK_DAYS,
          attempts: Math.max(attempts, (base.backfill?.attempts ?? 0) + 1)
        }
      },
      Date.now()
    )
  }, deps.onError)

  // If the stamp did not survive — unwritable userData, a full disk, an
  // oversized payload, all of which `persistDailyUsageRollup` swallows — then
  // nothing on disk bounds a retry, and this multi-GB walk would run again on
  // every single launch. Refuse rather than let that loop form: the per-process
  // guard alone bounds it per LAUNCH, which is not the same as per install.
  const stamped = await loadDailyUsageRollup(deps.dailyRollupPath)
  if (!stamped?.backfill || stamped.backfill.attempts < attempts) {
    deps.onError?.(
      new Error('Daily usage backfill attempt could not be recorded; skipping the walk.')
    )
    return false
  }

  try {
    const days = await deps.runBackfill({
      lookbackDays: DAILY_USAGE_BACKFILL_LOOKBACK_DAYS,
      force: true,
      externalFileCachePath: deps.backfillFileCachePath,
      cursorCachePath: deps.backfillCursorCachePath
    })
    const completedAt = now()
    await enqueue(async () => {
      const base = await readRollup(deps.dailyRollupPath)
      // The backfill observed a window ending at its START: anything logged
      // while it walked belongs to the ordinary scan, not to this pass.
      const folded = foldDailyUsageDaysIntoRollup(base.days, days, {
        observedFromMs: startedAt - DAILY_USAGE_BACKFILL_LOOKBACK_DAYS * MS_PER_DAY,
        observedToMs: startedAt,
        now: Date.now()
      })
      await persistDailyUsageRollup(
        deps.dailyRollupPath,
        {
          updatedAt: completedAt,
          days: folded,
          backfill: {
            startedAt,
            completedAt,
            lookbackDays: DAILY_USAGE_BACKFILL_LOOKBACK_DAYS,
            attempts: base.backfill?.attempts ?? 1
          }
        },
        Date.now()
      )
    }, deps.onError)
    return true
  } catch (error) {
    deps.onError?.(error)
    return false
  } finally {
    await removeScratchCaches(deps)
  }
}
