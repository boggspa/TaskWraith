/** Boot needs one field off every chat — `parentChatId` — to find sub-threads
 *  whose root chat is gone. Materialising a whole ChatRecord to read it
 *  replays that chat's journal, so the scan costs seconds on a large corpus
 *  and, on almost every boot, finds nothing.
 *
 *  The chat-list index already carries `parentChatId`, alongside the mtime and
 *  size of the chat file it was built from. A stat is therefore enough to
 *  decide whether the cheap answer is still the true one. Anything the index
 *  cannot vouch for falls back to the full read, so the candidate set is
 *  identical to reading every record — the index is an accelerator here, never
 *  the authority. */

export interface OrphanSubThreadIndexEntry {
  appChatId: string
  parentChatId?: string
  sourceChatMtimeMs?: number
  sourceChatSize?: number
}

export interface OrphanSubThreadRecord {
  appChatId: string
  parentChatId?: string
}

export interface OrphanSubThreadSourceStat {
  mtimeMs: number
  size: number
}

export interface OrphanSubThreadScanDeps {
  /** Chat ids present on disk, one per chat file. */
  listChatIds(): string[]
  /** Null when the file vanished between listing and stat. */
  statChatFile(chatId: string): OrphanSubThreadSourceStat | null
  indexEntry(chatId: string): OrphanSubThreadIndexEntry | undefined
  /** The authoritative, expensive read. Reached only when the index cannot vouch. */
  readChatRecord(chatId: string): OrphanSubThreadRecord | null
  parentChatExists(parentChatId: string): boolean
}

export interface OrphanSubThreadScanResult {
  candidates: string[]
  /** Chats that still needed the expensive read. Surfaced so a boot which
   *  silently degrades back to full-corpus cost is observable rather than
   *  invisible. */
  fullReads: number
}

/** The index may only stand in for the record when it was built from exactly
 *  the bytes now on disk, and when it actually carries the identity the
 *  candidate set is keyed by. A partial entry is not a cheap answer, it is a
 *  wrong one. */
export function indexEntryVouchesForSource(
  entry: OrphanSubThreadIndexEntry | undefined,
  stat: OrphanSubThreadSourceStat | null
): boolean {
  if (!entry || !stat) return false
  if (typeof entry.appChatId !== 'string' || entry.appChatId.length === 0) return false
  // A missing mtime/size fails the comparison on its own — an absent field is
  // never equal to a real stat — so no separate presence guard is needed.
  return entry.sourceChatMtimeMs === stat.mtimeMs && entry.sourceChatSize === stat.size
}

export function collectOrphanSubThreadCandidates(
  deps: OrphanSubThreadScanDeps
): OrphanSubThreadScanResult {
  const candidates: string[] = []
  let fullReads = 0

  for (const chatId of deps.listChatIds()) {
    const entry = deps.indexEntry(chatId)
    let record: OrphanSubThreadRecord | null
    if (indexEntryVouchesForSource(entry, deps.statChatFile(chatId))) {
      record = { appChatId: entry!.appChatId, parentChatId: entry!.parentChatId }
    } else {
      fullReads += 1
      record = deps.readChatRecord(chatId)
    }

    if (!record?.parentChatId) continue
    if (deps.parentChatExists(record.parentChatId)) continue
    candidates.push(record.appChatId)
  }

  return { candidates, fullReads }
}
