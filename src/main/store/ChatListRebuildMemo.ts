/** getChatList rebuilds a row whenever the index entry cannot vouch for the
 *  chat file, and a rebuild parses the WHOLE record — chat blobs reach tens of
 *  MB. The rebuild is supposed to be self-healing: it restamps the index entry
 *  so the next call takes the fast path. That restamp is gated on
 *  `legacyStoreCanWrite()`, so while the Host owns legacy writes the same rows
 *  rebuild on every call forever — measured at ~191ms per call over 10 chats /
 *  44.9MB, paid roughly five times during one cold boot.
 *
 *  `toChatListItem` is pure with respect to (record, sourceStat), so the row it
 *  derives can be memoised against the file identity that produced it. Any
 *  write changes mtime or size and misses, exactly like chatRecordCache.
 *
 *  This deliberately does NOT make the durable index fresher and does not touch
 *  the write path — the 2026-08-18 append storm came from widening a write
 *  door, and this closes none of that distance. It only stops a single process
 *  paying for the same parse twice. */

export interface ChatListRebuildMemoStat {
  mtimeMs: number
  size: number
}

/** Bounded so a corpus far larger than the retained rows cannot pin memory.
 *  512 covers a whole realistic corpus; past that the coldest row is dropped
 *  and simply re-parses on demand. */
export const CHAT_LIST_REBUILD_MEMO_MAX_ENTRIES = 512

interface MemoEntry<TItem> {
  mtimeMs: number
  size: number
  item: TItem
}

export class ChatListRebuildMemo<TItem> {
  private readonly entries = new Map<string, MemoEntry<TItem>>()

  constructor(private readonly maxEntries: number = CHAT_LIST_REBUILD_MEMO_MAX_ENTRIES) {}

  /** The row derived from exactly these bytes, or undefined. A stat that no
   *  longer matches is dropped rather than kept: it can never be a hit again. */
  get(chatId: string, stat: ChatListRebuildMemoStat): TItem | undefined {
    const entry = this.entries.get(chatId)
    if (!entry) return undefined
    if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      this.entries.delete(chatId)
      return undefined
    }
    // Refresh recency so a row read every call is not the one evicted.
    this.entries.delete(chatId)
    this.entries.set(chatId, entry)
    return entry.item
  }

  set(chatId: string, stat: ChatListRebuildMemoStat, item: TItem): void {
    this.entries.delete(chatId)
    this.entries.set(chatId, { mtimeMs: stat.mtimeMs, size: stat.size, item })
    while (this.entries.size > this.maxEntries) {
      const coldest = this.entries.keys().next()
      if (coldest.done) break
      this.entries.delete(coldest.value)
    }
  }

  delete(chatId: string): void {
    this.entries.delete(chatId)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
