/**
 * Byte budget for `AppStore.chatRecordCache`.
 *
 * The cache was an unbounded Map: every chat parsed by any read stayed
 * resident for the life of the process. A 2-minute whole-corpus sweep
 * therefore pinned the entire parsed corpus in main -- measured at 1.16GB of
 * JSON across 514 files, which lands around 4GB once parsed. Bounding it by
 * BYTES rather than entry count is the point: a count bound over records that
 * range from 4KB to 78MB tells you nothing about resident memory.
 *
 * `size` is the on-disk byte length already recorded beside each cached
 * record, so nothing extra has to be measured to enforce this.
 */
export const CHAT_RECORD_CACHE_MAX_BYTES = 256 * 1024 * 1024

export interface ChatRecordCacheEntryMeta {
  chatId: string
  /** On-disk bytes of the record that produced this entry. */
  size: number
  /** `-1` is the coalescer's dirty marker: saved, not yet flushed to disk. */
  mtimeMs: number
}

/** A dirty entry holds the ONLY copy of a record that has not reached disk.
 * Evicting one silently discards a save, so the budget yields to it. */
function isEvictable(entry: ChatRecordCacheEntryMeta): boolean {
  return entry.mtimeMs !== -1
}

/**
 * Chat ids to drop, least-recently-used first, until the cache fits
 * `maxBytes`. Callers keep the cache in recency order by re-inserting on every
 * hit, so iteration order is LRU order.
 *
 * Returns only what the budget actually demands: a cache that fits, or one
 * whose overflow is entirely unflushed work, yields no evictions at all.
 */
export function selectChatRecordCacheEvictions(
  entries: readonly ChatRecordCacheEntryMeta[],
  maxBytes: number = CHAT_RECORD_CACHE_MAX_BYTES
): string[] {
  let total = 0
  for (const entry of entries) total += Math.max(0, entry.size)

  const evicted: string[] = []
  for (const entry of entries) {
    if (total <= maxBytes) break
    if (!isEvictable(entry)) continue
    evicted.push(entry.chatId)
    total -= Math.max(0, entry.size)
  }
  return evicted
}
