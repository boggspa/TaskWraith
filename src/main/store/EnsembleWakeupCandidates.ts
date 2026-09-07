/**
 * Boot prefilter for the persisted ensemble-wakeup sweep.
 *
 * `getPersistedEnsembleWakeups()` read and parsed every chat record on the
 * main thread, pre-window, to flatMap `ensemble.wakeups`. Measured on Chris's
 * profile 2026-09-07: 1080MB across 516 files to build an EMPTY list — not one
 * chat held a wakeup.
 *
 * The index cannot answer this from the ensemble it stores, because
 * `toLeanEnsembleProjection` strips `wakeups` by design (and that projection is
 * mirrored in three places, so widening it invites drift). The row instead
 * carries a top-level `ensembleWakeupCount`, built beside `messageCount` /
 * `runCount` from the same record and judged by the same mtime+size vouch.
 *
 * `chatKind` alone is not the lever it looks like: measured on the same
 * profile the 375 non-ensemble records are 125MB, while the 140 ensemble ones
 * are 955MB. The count is what reaches the bytes that matter.
 *
 * Narrowing only. A candidate still takes the unchanged canonical read and the
 * caller still reads real `ensemble.wakeups` off it; only the SKIP is decided
 * here. The error directions are not symmetric — a wrong "has wakeups" costs
 * one read, a wrong "none" leaves a wakeup armed with nothing left to fire it
 * — so a row must be vouched AND carry an explicit numeric zero to be skipped.
 * Rows written before the field existed carry no value, which reads as unknown
 * and takes the canonical read.
 */

export interface EnsembleWakeupCandidateSource {
  /** True only when the index row's mtime+size match the record on disk. */
  vouchesForSourceBytes: (chatId: string) => boolean
  /** The vouched row's wakeup count, or null when the row carries none. */
  readWakeupCount: (chatId: string) => number | null
}

/**
 * The chats that must be read canonically to collect persisted wakeups.
 * Order is preserved so the caller's sweep order is unchanged.
 */
export function selectEnsembleWakeupCandidateChatIds(
  chatIds: readonly string[],
  source: EnsembleWakeupCandidateSource
): string[] {
  const candidates: string[] = []
  for (const chatId of chatIds) {
    if (typeof chatId !== 'string' || chatId === '') continue
    let count: number | null
    try {
      count = source.vouchesForSourceBytes(chatId) ? source.readWakeupCount(chatId) : null
    } catch {
      // An unreadable row is not evidence the chat holds no wakeup.
      count = null
    }
    if (count !== 0) candidates.push(chatId)
  }
  return candidates
}
