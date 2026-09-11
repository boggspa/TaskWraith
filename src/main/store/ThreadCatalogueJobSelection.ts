/**
 * Which queued decode job the history worker runs next.
 *
 * `pump` has always had two lanes — a `metadata` job with no `priority` is the
 * slow one — but the selection was strict priority with no floor, which is only
 * safe while nothing actually uses the slow lane. Now that the post-paint
 * recovery drain does, strict priority starves it: a background job runs only
 * if the queue holds zero foreground jobs at the instant a decode finishes, and
 * the app has several steady foreground producers (the 500ms mirror poll, queue
 * recovery, the remote cache, every renderer open). Two overlapping producers
 * are enough to hold the lane shut indefinitely.
 *
 * Starving that lane is not "recovery finishes later". Recovery's own pump is
 * serial, so one starved chat stops the whole corpus, and `joinsReady` requires
 * every join-policy thread to have recovered before ANY sub-thread join fires.
 * It also breaks quit: `quiesce()` gives up after 30s and the throw skips
 * `dispose()` and `flushAllChatSaves()`, stranding a write-gate hold and
 * unflushed saves.
 *
 * So the floor: after `BACKGROUND_STARVATION_FLOOR` consecutive fast-lane
 * picks, take the queue head instead. The lane still protects a user — a
 * foreground request waits at most one in-flight decode in the common case —
 * while a background job can only ever be passed over a bounded number of
 * times, which is what keeps `recover()` inside the quiesce budget.
 *
 * Pure and queue-shaped so the policy is testable without a worker, a decoder
 * or a profile — the integration path cannot pin it, because inventory
 * discovery enqueues its own jobs in readdir order before a test can look.
 */

export interface CatalogueJobLane {
  /** Slow lane iff `metadata` without `priority`. Mirrors `ImportJob`. */
  mode: string
  priority?: boolean
}

/**
 * Consecutive fast-lane picks tolerated before the queue head is taken
 * regardless. Four is a compromise, not a measurement: low enough that a
 * starved background job still lands well inside the 30s quiesce deadline even
 * when the fast picks are large uncached threads, high enough that a burst of
 * user opens is not interleaved with repair.
 */
export const BACKGROUND_STARVATION_FLOOR = 4

export interface CatalogueJobSelection {
  /** Index into the queue. Always valid for a non-empty queue. */
  index: number
  /** Consecutive fast-lane picks to carry into the next selection. */
  consecutiveFastPicks: number
}

export function isFastLaneCatalogueJob(job: CatalogueJobLane): boolean {
  return job.mode !== 'metadata' || job.priority === true
}

/**
 * Pick the next job. Returns the queue head when nothing is in the fast lane,
 * and also when the floor has been reached — so a background job that keeps
 * being passed over eventually runs.
 */
export function selectNextCatalogueJob(
  queue: readonly CatalogueJobLane[],
  consecutiveFastPicks: number,
  floor: number = BACKGROUND_STARVATION_FLOOR
): CatalogueJobSelection {
  if (queue.length === 0) return { index: 0, consecutiveFastPicks }
  const fastIndex =
    consecutiveFastPicks >= floor ? -1 : queue.findIndex((job) => isFastLaneCatalogueJob(job))
  if (fastIndex < 0) return { index: 0, consecutiveFastPicks: 0 }
  return { index: fastIndex, consecutiveFastPicks: consecutiveFastPicks + 1 }
}
