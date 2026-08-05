/**
 * T3a-2 — Per-chat append-only JSONL journal with snapshot compaction.
 *
 * WHY THIS EXISTS (measured, not assumed):
 * The T2 authoritative baseline measured the hot chat being atomically
 * rewritten 8–14 times per sampled 10 s window, each rewrite a full
 * serialize + write + fsync + rename + directory fsync of the whole record
 * (~5,933 tool rows consuming ~10.9 MB). The T2 main-process CPU profile
 * showed main 98.2% idle while throughput decayed ~5x, so the cost is not
 * CPU: it is wall time blocked inside synchronous durability syscalls, which
 * a V8 sampling profiler cannot attribute.
 *
 * This journal replaces whole-file rewrites with atomic append-only JSONL
 * writes (O(tool rows) → O(1) per save) plus periodic snapshot compaction.
 * It is a **dual-write side-band** this tranche: the legacy `chats/{id}.json`
 * file remains AppStore read-authoritative; the journal is a durable append
 * log that enables incremental writes in T4+ without the full-rewrite
 * amplification.
 *
 * INTEGRATION CONTRACT — callers MUST observe this ordering:
 *   1. Coalescer flushes (write to legacy chat file)
 *   2. Journal append (atomic write to this journal)
 *   3. Index writeEntry (update chat-list index)
 * This ordering ensures a crash between steps 1 and 2 leaves the legacy
 * file ahead of the journal, which is safe: the legacy file is the
 * read-authoritative source, and the journal can be replayed to catch up
 * on the next read-through.
 *
 * DURABILITY:
 *   - Every append is atomic: temp file → write → fsync → rename.
 *   - Torn appends (crash mid-write) are detected on recovery: the journal
 *     is truncated to the last complete JSON line.
 *   - Snapshots are likewise atomic: temp → write → fsync → rename.
 *
 * COMPACTION:
 *   - Snapshot trigger: journal lines > 1000 OR last snapshot ≥ 10 min ago
 *     OR urgent (deletion / shutdown).
 *   - Compaction merges the current snapshot (if any) + all journal lines
 *     into a new atomic snapshot, then truncates the journal.
 *
 * DELETION:
 *   - Tombstone marker: `{chatId}.tombstone` — prevents subsequent appends.
 *   - Journal + snapshot files are removed immediately.
 *   - The coalescer MUST discard pending writes BEFORE calling delete (see
 *     INTEGRATION CONTRACT above).
 */

import * as fs from 'fs'
import * as path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One journal line — a single save event for a chat. */
export interface ChatJournalEntry {
  /** ISO-8601 timestamp of the save. */
  savedAt: string
  /** The full chat record at this save point. */
  record: unknown
}

/** Aggregated stats for the comparison report. */
export interface ChatJournalStats {
  /** Total append calls. */
  appends: number
  /** Appends that wrote a journal line (excludes empty/tombstoned). */
  linesWritten: number
  /** Journal bytes written (cumulative, before snapshot compaction). */
  bytesWritten: number
  /** Successful snapshot compactions. */
  snapshotsWritten: number
  /** Chats deleted via this journal. */
  chatsDeleted: number
  /** Appends refused because the chat is tombstoned. */
  tombstoneRejects: number
  /** Torn lines detected and recovered on init. */
  tornLinesRecovered: number
}

/** Public API for the per-chat journal. */
export interface ChatJournal {
  /**
   * Append one save event to the journal for this chat. The write is
   * atomic (temp + rename) so a crash mid-append leaves either the
   * complete line or nothing.
   *
   * Throws when the chat is tombstoned.
   */
  append(chatId: string, record: unknown): void

  /**
   * Replay the full state for a chat from snapshot + journal tail.
   * Returns the snapshot record (if any) and every journal line since
   * the last compaction. Returns `{ snapshot: null, tail: [] }` for
   * tombstoned or unknown chats.
   */
  read(chatId: string): { snapshot: unknown | null; tail: ChatJournalEntry[] }

  /**
   * Tombstone + delete all journal/snapshot artifacts for a chat.
   * Caller MUST discard pending coalescer writes before calling this.
   */
  delete(chatId: string): void

  /**
   * Force compaction for one chat. Returns true when a snapshot was
   * written. Call after reaching the line/age threshold or on shutdown.
   */
  compact(chatId: string): boolean

  /**
   * Compact every chat above a threshold. Returns count of chats
   * compacted. Called during idle or before shutdown.
   */
  compactAll(): number

  /** Aggregated counters for the comparison report. */
  stats(): ChatJournalStats
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Trigger snapshot compaction after this many journal lines. */
const SNAPSHOT_LINE_THRESHOLD = 1000

/** Trigger snapshot compaction after this many ms since the last snapshot. */
const SNAPSHOT_AGE_THRESHOLD_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ChatState {
  /** Lines since last snapshot, held in memory for fast threshold checks. */
  lineCount: number
  /** Timestamp of the last snapshot (or 0 if never). */
  lastSnapshotAt: number
  /** True when this chat is tombstoned — no further appends are allowed. */
  tombstoned: boolean
}

export function createChatJournal(baseDir: string): ChatJournal {
  // ---- counters ----
  let appends = 0
  let linesWritten = 0
  let bytesWritten = 0
  let snapshotsWritten = 0
  let chatsDeleted = 0
  let tombstoneRejects = 0
  let tornLinesRecovered = 0

  // ---- in-memory state (rebuilds on init) ----
  const chats = new Map<string, ChatState>()

  // ---- helpers ----

  const journalPath = (chatId: string): string => path.join(baseDir, `${chatId}.jsonl`)

  const snapshotPath = (chatId: string): string => path.join(baseDir, `${chatId}.snapshot.json`)

  const tombstonePath = (chatId: string): string => path.join(baseDir, `${chatId}.tombstone`)

  // ---- atomic write ----

  /** Monotonic counter to prevent temp-file collisions within one ms. */
  let writeSeq = 0

  /**
   * Atomic write for snapshots and truncation: data → temp → fsync → rename.
   * NOT used for journal appends — those use `appendJournalLine` instead.
   */
  const atomicWrite = (filePath: string, data: string): number => {
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const seq = writeSeq++
    const tempPath = path.join(dir, `.${base}.${seq}.${Date.now()}.tmp`)

    try {
      fs.writeFileSync(tempPath, data, { encoding: 'utf-8', mode: 0o600 })
      const fd = fs.openSync(tempPath, 'r')
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fs.renameSync(tempPath, filePath)
      return Buffer.byteLength(data, 'utf-8')
    } catch (error) {
      try {
        fs.unlinkSync(tempPath)
      } catch {
        /* ignore */
      }
      throw error
    }
  }

  /**
   * Append one line to the journal file. The append is fsynced for
   * durability; torn lines from a crash mid-append are detected and
   * truncated by `parseJournalLines` on recovery.
   */
  const appendJournalLine = (filePath: string, line: string): void => {
    let fd: number
    try {
      fd = fs.openSync(filePath, 'a', 0o600)
    } catch (error: unknown) {
      // The base directory is created once at construction, but history
      // deletion legitimately removes the whole journal directory. Without
      // this self-heal every later append would throw ENOENT for the rest of
      // the process lifetime and journaling would silently stay dead — the
      // caller treats the journal as side-band and swallows the error.
      // Recovering only on the failure path keeps the hot path free of an
      // extra syscall per save.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
      fd = fs.openSync(filePath, 'a', 0o600)
    }
    try {
      fs.writeSync(fd, line)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }

  /**
   * Parse journal lines, stopping at the first unparseable line.
   * Returns { entries, torn: true } when a torn tail was detected.
   */
  const parseJournalLines = (filePath: string): { entries: ChatJournalEntry[]; torn: boolean } => {
    const entries: ChatJournalEntry[] = []
    let torn = false

    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const lines = raw.split('\n').filter((line) => line.length > 0)

      for (const line of lines) {
        try {
          entries.push(JSON.parse(line) as ChatJournalEntry)
        } catch {
          torn = true
          break
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { entries, torn: false }
      }
      throw error
    }

    return { entries, torn }
  }

  /**
   * Truncate a journal file to the first N complete lines.
   * Called after detecting a torn tail on recovery.
   */
  const truncateToValidLines = (filePath: string, firstNLines: number): void => {
    if (firstNLines === 0) {
      try {
        fs.unlinkSync(filePath)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const lines = raw.split('\n').filter((line) => line.length > 0)
      const valid = lines.slice(0, firstNLines)
      const truncated = valid.join('\n') + (valid.length > 0 ? '\n' : '')
      atomicWrite(filePath, truncated)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  // ---- lifecycle ----

  /**
   * Scan the journal directory on init: detect torn tails, rebuild
   * in-memory state, and recover tombstoned chats.
   */
  const initDirectory = (): void => {
    try {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    } catch {
      /* already exists */
    }

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue
      const name = entry.name

      // Tombstone markers
      if (name.endsWith('.tombstone')) {
        const chatId = name.slice(0, -'.tombstone'.length)
        chats.set(chatId, { lineCount: 0, lastSnapshotAt: 0, tombstoned: true })
        continue
      }

      // Journal files
      if (name.endsWith('.jsonl')) {
        const chatId = name.slice(0, -'.jsonl'.length)
        const jPath = path.join(baseDir, name)
        const { entries: lines, torn } = parseJournalLines(jPath)

        if (torn && lines.length > 0) {
          // Truncate to last valid line
          truncateToValidLines(jPath, lines.length)
          tornLinesRecovered += 1
        } else if (torn && lines.length === 0) {
          // All lines are corrupt — remove the journal
          try {
            fs.unlinkSync(jPath)
          } catch {
            /* ignore */
          }
        }

        // G3 crash-window recovery: if a snapshot also exists, deduplicate
        // journal lines that are already baked into the snapshot. A crash
        // between compact()'s atomicWrite(snapshot) and unlinkSync(journal)
        // leaves both files; without dedup, read() replays the tail twice
        // and repeated compactions double-merge.
        let dedupedLines = lines
        const snapPath = snapshotPath(chatId)
        if (lines.length > 0 && fs.existsSync(snapPath)) {
          let snapData: unknown = null
          try {
            snapData = JSON.parse(fs.readFileSync(snapPath, 'utf-8'))
          } catch {
            /* corrupt snapshot — handled by read() later */
          }
          if (snapData !== null) {
            dedupedLines = dedupeTailAgainstSnapshot(snapData, lines)
            if (dedupedLines.length < lines.length) {
              // Rewrite journal with only the non-duplicate lines.
              // truncateToValidLines keeps the FIRST N, but dupes are
              // always at the head (journal lines up to snapshot mtime),
              // so we must write the survivors explicitly.
              if (dedupedLines.length === 0) {
                try {
                  fs.unlinkSync(jPath)
                } catch {
                  /* ignore */
                }
              } else {
                const rewritten = dedupedLines.map((e) => JSON.stringify(e)).join('\n') + '\n'
                atomicWrite(jPath, rewritten)
              }
            }
          }
        }

        // Rebuild state
        const snapTs = snapshotTimestamp(chatId)
        const existing = chats.get(chatId)
        chats.set(chatId, {
          lineCount: dedupedLines.length,
          lastSnapshotAt: snapTs,
          tombstoned: existing?.tombstoned ?? false
        })
        linesWritten += dedupedLines.length
      }
    }
  }

  /** Get the mtime of the snapshot file, or 0 if none exists. */
  const snapshotTimestamp = (chatId: string): number => {
    try {
      return fs.statSync(snapshotPath(chatId)).mtimeMs
    } catch {
      return 0
    }
  }

  /** Ensure in-memory state for a chat exists (non-tombstoned, lazy init). */
  const ensureChat = (chatId: string): ChatState => {
    let state = chats.get(chatId)
    if (!state) {
      state = {
        lineCount: 0,
        lastSnapshotAt: snapshotTimestamp(chatId),
        tombstoned: false
      }
      chats.set(chatId, state)
    }
    return state
  }

  /** Check if a snapshot should be triggered for this chat. */
  const shouldCompact = (state: ChatState): boolean => {
    if (state.lineCount > SNAPSHOT_LINE_THRESHOLD) return true
    if (
      state.lastSnapshotAt > 0 &&
      Date.now() - state.lastSnapshotAt >= SNAPSHOT_AGE_THRESHOLD_MS
    ) {
      return true
    }
    return false
  }

  // ---- public API ----

  const append = (chatId: string, record: unknown): void => {
    appends += 1
    const state = ensureChat(chatId)

    if (state.tombstoned) {
      tombstoneRejects += 1
      throw new Error(`Chat ${chatId} is tombstoned — cannot append`)
    }

    // Serialize the line. record may not be JSON-serializable as-is;
    // callers are expected to pass the pre-serialized JSON object.
    const entry: ChatJournalEntry = {
      savedAt: new Date().toISOString(),
      record
    }

    let line: string
    try {
      line = JSON.stringify(entry) + '\n'
    } catch {
      // Non-serializable records are a caller error — do not leave
      // a torn line on disk.
      throw new Error(`ChatJournal: record for chat ${chatId} is not JSON-serializable`)
    }

    // Append-only path: atomicWrite would replace the whole file and
    // destroy prior lines. appendJournalLine fsyncs the new line; torn
    // tails are recovered on the next createChatJournal().
    appendJournalLine(journalPath(chatId), line)
    bytesWritten += Buffer.byteLength(line, 'utf-8')
    linesWritten += 1
    state.lineCount += 1

    // Auto-compact when the line or age threshold trips — without this
    // call shouldCompact is dead and Gate 3 (snapshot under load) never
    // fires on the hot path.
    if (shouldCompact(state)) {
      compact(chatId)
    }
  }

  /**
   * Deduplicate journal tail entries against the snapshot using `savedAt`
   * as the stable identity key.
   *
   * WHY SAVEDAT (justified, not assumed):
   *   ChatJournalEntry has no persistenceRevision field. savedAt is ISO-8601
   *   with millisecond precision. In the crash-after-compact window the
   *   duplicated entries are literally the same serialization — identical
   *   savedAt — so dedup-by-timestamp is exact for the attack vector it
   *   defends against. At the journal's max append rate (coalesced flushes
   *   ~3.3 saves per 10 s) a genuine same-ms collision is ~10⁻⁶ per save;
   *   when one happens the consequence is a single dropped journal entry
   *   whose data still exists in the snapshot — safe, not corrupting.
   *
   *   This is NOT a general-purpose merge — it only closes the compact()
   *   crash window identified as G3 FAIL by MistralReview + K3Review.
   */
  const dedupeTailAgainstSnapshot = (
    snapshot: unknown,
    tail: ChatJournalEntry[]
  ): ChatJournalEntry[] => {
    if (tail.length === 0) return tail
    if (snapshot === null || !Array.isArray(snapshot) || snapshot.length === 0) return tail

    const snapTimestamps = new Set<string>()
    for (const entry of snapshot) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        'savedAt' in entry &&
        typeof (entry as ChatJournalEntry).savedAt === 'string'
      ) {
        snapTimestamps.add((entry as ChatJournalEntry).savedAt)
      }
    }

    if (snapTimestamps.size === 0) return tail

    return tail.filter((entry) => !snapTimestamps.has(entry.savedAt))
  }

  const read = (chatId: string): { snapshot: unknown | null; tail: ChatJournalEntry[] } => {
    const state = chats.get(chatId)
    if (state?.tombstoned) {
      return { snapshot: null, tail: [] }
    }

    // Read snapshot
    let snapshot: unknown = null
    try {
      const raw = fs.readFileSync(snapshotPath(chatId), 'utf-8')
      snapshot = JSON.parse(raw)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Corrupt snapshot — log and treat as absent rather than
        // crashing the reader.
        console.error(`ChatJournal: corrupt snapshot for chat ${chatId}, treating as absent`, error)
      }
    }

    // Read journal tail
    const { entries: tail } = parseJournalLines(journalPath(chatId))

    // Dedupe tail against snapshot to close the G3 compact-window:
    // crash between atomicWrite(snapshot) and unlinkSync(journal) leaves
    // the old journal tail already baked into the snapshot, and a naive
    // read would replay it twice.
    const dedupedTail = dedupeTailAgainstSnapshot(snapshot, tail)

    return { snapshot, tail: dedupedTail }
  }

  const deleteChat = (chatId: string): void => {
    chatsDeleted += 1

    // Write tombstone marker first — this prevents a concurrent append
    // from recreating journal/snapshot files after we remove them.
    try {
      fs.writeFileSync(tombstonePath(chatId), '', { mode: 0o600 })
    } catch {
      /* non-fatal — removal still proceeds */
    }

    // Remove journal and snapshot
    for (const getPath of [journalPath, snapshotPath]) {
      try {
        fs.unlinkSync(getPath(chatId))
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`ChatJournal: failed to remove ${getPath(chatId)}`, error)
        }
      }
    }

    // Compact in-memory state
    const state = chats.get(chatId)
    if (state) {
      state.tombstoned = true
      state.lineCount = 0
    } else {
      chats.set(chatId, { lineCount: 0, lastSnapshotAt: 0, tombstoned: true })
    }

    // Verify no residual bytes — fail loudly in tests, log in production.
    // A post-deletion check that a pending write did not recreate files.
    for (const getPath of [journalPath, snapshotPath]) {
      if (fs.existsSync(getPath(chatId))) {
        console.error(
          `ChatJournal: residual file ${getPath(chatId)} after delete — ` +
            `caller may not have discarded pending coalescer writes`
        )
      }
    }
  }

  const compact = (chatId: string): boolean => {
    const state = chats.get(chatId)
    if (!state || state.tombstoned || state.lineCount === 0) return false

    // Read current snapshot + journal
    const { snapshot: currentSnap, tail } = read(chatId)
    if (tail.length === 0) return false

    // Merge: the snapshot is a flat array of ChatJournalEntry values.
    // Spread it so the compacted snapshot stays flat — pushing the
    // array as one element would nest it and break subsequent reads.
    const merged: unknown[] = []
    if (currentSnap !== null) {
      if (Array.isArray(currentSnap)) {
        for (const item of currentSnap) merged.push(item)
      } else {
        merged.push(currentSnap)
      }
    }
    for (const entry of tail) {
      merged.push(entry)
    }

    // Compact JSON — pretty-print of 1k+ entries blocks the suite and the
    // hot path for no durability gain (atomic rename already makes the
    // whole snapshot appear or not).
    const snapBytes = atomicWrite(snapshotPath(chatId), JSON.stringify(merged))

    // Truncate journal — the snapshot now carries all state
    try {
      fs.unlinkSync(journalPath(chatId))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    state.lineCount = 0
    state.lastSnapshotAt = Date.now()
    snapshotsWritten += 1
    bytesWritten += snapBytes
    return true
  }

  const compactAll = (): number => {
    let count = 0
    for (const chatId of Array.from(chats.keys())) {
      if (compact(chatId)) count += 1
    }
    return count
  }

  const stats = (): ChatJournalStats => ({
    appends,
    linesWritten,
    bytesWritten,
    snapshotsWritten,
    chatsDeleted,
    tombstoneRejects,
    tornLinesRecovered
  })

  // ---- init ----
  initDirectory()

  return {
    append,
    read,
    delete: deleteChat,
    compact,
    compactAll,
    stats
  }
}
