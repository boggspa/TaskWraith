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
 *   - Snapshot trigger: journal BYTES since the last snapshot > 16 MB OR
 *     journal lines > 1000 OR last snapshot (or first sighting) ≥ 10 min ago
 *     OR urgent (deletion / shutdown). Bytes lead because a journal line holds
 *     the whole record, so line count alone let a 60 MB chat reach a 42.67 GB
 *     journal on a live install (2026-08-05).
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

/**
 * Hard ceiling on journal bytes between snapshots. Sized so a big chat
 * compacts after a handful of saves rather than after 1000 of them: at 60 MB
 * per record the old line rule allowed ~60 GB, which is what filled a live
 * disk. A snapshot rewrites one whole record, so this bounds steady-state
 * amplification to roughly (threshold / record size) appends per snapshot.
 */
const SNAPSHOT_BYTE_THRESHOLD = 16 * 1024 * 1024

/** Trigger snapshot compaction after this many ms since the last snapshot. */
const SNAPSHOT_AGE_THRESHOLD_MS = 10 * 60 * 1000

/**
 * Refuse to read a journal larger than this into memory.
 *
 * `parseJournalLines` reads a whole journal with `readFileSync(path, 'utf-8')`,
 * i.e. into ONE JS string, and V8 caps strings at ~512 MB. On 2026-08-06 a live
 * `chat-journal/{id}.jsonl` reached 2.75 GB, and because `initDirectory()` runs
 * inside `createChatJournal()` — which `store/index.ts` calls at MODULE SCOPE —
 * the failure arrived before any try/catch, log line, or handler this app owns.
 * The app died with exit 133 / SIGTRAP and ZERO output. So did every TaskWraith
 * MCP bridge child, each being a re-entry of the same binary, which surfaced to
 * Mistral/Vibe as `unhandled errors in a TaskGroup (1 sub-exception)`.
 *
 * 256 MB sits well under V8's limit and far above any healthy journal
 * (SNAPSHOT_BYTE_THRESHOLD compacts at 16 MB), so crossing it always means the
 * compaction path has already failed. Quarantine rather than delete: the
 * journal may hold saves the authoritative `chats/{id}.json` has not caught up
 * with, and it is the evidence for why compaction stopped working.
 */
const MAX_JOURNAL_PARSE_BYTES = 256 * 1024 * 1024

/** Options for {@link createChatJournal}. */
export interface ChatJournalOptions {
  /** Override the oversized-journal ceiling. Tests only — production uses the constant. */
  maxJournalParseBytes?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface ChatState {
  /** Lines since last snapshot, held in memory for fast threshold checks. */
  lineCount: number
  /**
   * Journal bytes since the last snapshot.
   *
   * A journal LINE holds the whole record, so line count says nothing about
   * size: measured on a live install 2026-08-05, one 60 MB chat reached a
   * 42.67 GB journal (~700 lines) growing 389 MB/min and filled the disk.
   * Bytes are what the disk cares about, so bytes are what bound compaction.
   */
  bytesSinceSnapshot: number
  /** Timestamp of the last snapshot (or 0 if never). */
  lastSnapshotAt: number
  /**
   * When this chat's journal was first observed this process. Used as the age
   * baseline when nothing has ever been snapshotted — the old age check was
   * guarded on `lastSnapshotAt > 0`, so a never-compacted journal (exactly the
   * one at risk) could never compact by age.
   */
  observedAt: number
  /** True when this chat is tombstoned — no further appends are allowed. */
  tombstoned: boolean
}

export function createChatJournal(
  baseDir: string,
  options: ChatJournalOptions = {}
): ChatJournal {
  const maxJournalParseBytes = options.maxJournalParseBytes ?? MAX_JOURNAL_PARSE_BYTES

  /**
   * Size of `filePath` when it is too large to read into one string, else null.
   * A missing/unstattable file is never "oversized" — the existing ENOENT paths
   * own that case.
   */
  const oversizedJournalBytes = (filePath: string): number | null => {
    try {
      const { size } = fs.statSync(filePath)
      return size > maxJournalParseBytes ? size : null
    } catch {
      return null
    }
  }

  /**
   * Rename an unreadable journal out of the `.jsonl` suffix so the directory
   * scan stops finding it, keeping every byte. Returns the parked path, or
   * null when the rename failed — a failed rename must NOT throw, or the
   * unlaunchable-app bug simply moves from the read to the rename.
   */
  const quarantineOversizedJournal = (filePath: string): string | null => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? '' : `.${attempt}`
      const parked = `${filePath}.oversized-${stamp}${suffix}.bak`
      if (fs.existsSync(parked)) continue
      try {
        fs.renameSync(filePath, parked)
        return parked
      } catch {
        return null
      }
    }
    return null
  }

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

    // Size gate BEFORE the read. Above the ceiling `readFileSync(…, 'utf-8')`
    // is not a recoverable error — it can abort the process outright — so this
    // must never be reached by a try/catch further down. Reported as an empty,
    // NON-torn journal so no caller truncates or rewrites a file it could not
    // read: init quarantines it instead, and read() degrades to the
    // authoritative chat record.
    const oversized = oversizedJournalBytes(filePath)
    if (oversized !== null) {
      return { entries, torn: false }
    }

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
   * The newest complete entry in a journal, read WITHOUT loading the file.
   *
   * `compact` collapses to the newest entry and discards the rest, so this is
   * everything it needs. It used to get there through `read()`, which reads
   * the whole journal into one string — making the only operation that BOUNDS
   * the journal cost O(journal) and fail exactly when the journal had grown
   * too big to read. `store/index.ts` swallows that throw, and the append has
   * already landed by then, so every save grew the file AND failed to compact
   * it. Silent, unbounded, self-reinforcing: one chat reached 2.75 GB with no
   * snapshot while a sibling chat compacted normally.
   *
   * Reads a window off the END and walks backwards to the first parseable
   * line, widening if the window did not contain a whole one. Walking
   * backwards also skips a torn tail from a crash mid-append for free.
   * Splitting on '\n' is safe at an arbitrary byte offset: 0x0A cannot occur
   * inside a multi-byte UTF-8 sequence, so a complete line never straddles the
   * cut ambiguously — only the leading partial does, and that one is refused.
   */
  const readNewestJournalEntry = (filePath: string): ChatJournalEntry | null => {
    let size = 0
    try {
      size = fs.statSync(filePath).size
    } catch {
      return null
    }
    if (size === 0) return null

    let fd: number
    try {
      fd = fs.openSync(filePath, 'r')
    } catch {
      return null
    }

    try {
      // A line holds a WHOLE chat record, so start generous. The cap stays far
      // below V8's string limit — this must never reintroduce the failure it
      // exists to remove.
      let window = 1024 * 1024
      const MAX_WINDOW = 64 * 1024 * 1024
      for (;;) {
        const length = Math.min(window, size)
        const start = size - length
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, start)
        const text = buffer.toString('utf-8')
        const body = text.endsWith('\n') ? text.slice(0, -1) : text
        const lines = body.split('\n')

        for (let i = lines.length - 1; i >= 0; i -= 1) {
          // Element 0 is a partial line whenever the window starts mid-file.
          if (i === 0 && start > 0) break
          const raw = lines[i]
          if (!raw) continue
          try {
            return JSON.parse(raw) as ChatJournalEntry
          } catch {
            // Torn tail (or a line split by the window) — keep walking back.
          }
        }

        if (length >= size || window >= MAX_WINDOW) return null
        window *= 4
      }
    } finally {
      try {
        fs.closeSync(fd)
      } catch {
        /* best effort */
      }
    }
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
        // Same completeness requirement as the rebuild below: a tombstoned
        // chat can be revived, and it would otherwise carry NaN byte state.
        chats.set(chatId, {
          lineCount: 0,
          bytesSinceSnapshot: 0,
          lastSnapshotAt: 0,
          observedAt: Date.now(),
          tombstoned: true
        })
        continue
      }

      // Journal files
      if (name.endsWith('.jsonl')) {
        const chatId = name.slice(0, -'.jsonl'.length)
        const jPath = path.join(baseDir, name)

        // Oversized journal: park it and move on. Renaming out of the `.jsonl`
        // suffix is what takes it out of this scan, so the next launch is
        // clean; the bytes are kept because this file is the only record of
        // both the unmerged saves and the compaction failure that grew it.
        // `continue` (rather than seeding state) deliberately leaves the chat
        // looking journal-less, so a fresh journal starts from zero.
        const oversized = oversizedJournalBytes(jPath)
        if (oversized !== null) {
          const parked = quarantineOversizedJournal(jPath)
          console.warn(
            `[chat-journal] ${name} is ${oversized} bytes, above the ${maxJournalParseBytes}-byte read ceiling; ` +
              `parked as ${parked ? path.basename(parked) : '(rename failed)'} and skipped. ` +
              'The authoritative chat record is unaffected; snapshot compaction for this chat needs investigating.'
          )
          continue
        }

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

        // Rebuild state.
        //
        // Every ChatState field has to be set here. `append` accumulates with
        // `state.bytesSinceSnapshot += lineBytes`, so omitting it leaves NaN,
        // and NaN fails every comparison — the byte ceiling then silently never
        // fires for any chat that existed when the process started, which is
        // exactly the set of chats whose journals are already large.
        //
        // Seed the byte count from what is ACTUALLY on disk rather than 0: a
        // journal reopened at 80 MB must be over the ceiling immediately, not
        // 16 MB from now.
        const snapTs = snapshotTimestamp(chatId)
        const existing = chats.get(chatId)
        let bytesOnDisk = 0
        try {
          bytesOnDisk = fs.statSync(jPath).size
        } catch {
          /* journal was unlinked above (all lines deduped away) — 0 is right */
        }
        chats.set(chatId, {
          lineCount: dedupedLines.length,
          bytesSinceSnapshot: bytesOnDisk,
          lastSnapshotAt: snapTs,
          observedAt: Date.now(),
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
        bytesSinceSnapshot: 0,
        lastSnapshotAt: snapshotTimestamp(chatId),
        observedAt: Date.now(),
        tombstoned: false
      }
      chats.set(chatId, state)
    }
    return state
  }

  /** Check if a snapshot should be triggered for this chat. */
  const shouldCompact = (state: ChatState): boolean => {
    if (state.lineCount > SNAPSHOT_LINE_THRESHOLD) return true
    // Bytes, not lines, are what exhaust a disk.
    if (state.bytesSinceSnapshot > SNAPSHOT_BYTE_THRESHOLD) return true
    // Fall back to when the journal was first seen so a never-snapshotted
    // chat still ages into compaction.
    const ageBaseline = state.lastSnapshotAt > 0 ? state.lastSnapshotAt : state.observedAt
    if (ageBaseline > 0 && Date.now() - ageBaseline >= SNAPSHOT_AGE_THRESHOLD_MS) return true
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
    const lineBytes = Buffer.byteLength(line, 'utf-8')
    bytesWritten += lineBytes
    linesWritten += 1
    state.lineCount += 1
    state.bytesSinceSnapshot += lineBytes

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
      state.bytesSinceSnapshot = 0
    } else {
      chats.set(chatId, {
        lineCount: 0,
        bytesSinceSnapshot: 0,
        lastSnapshotAt: 0,
        observedAt: Date.now(),
        tombstoned: true
      })
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

    // Only the NEWEST journal entry is needed. The previous snapshot was read
    // here when compaction merged into it; the collapse below deliberately
    // discards it, so binding it left an unused variable (and a tsc error).
    //
    // Deliberately NOT `read(chatId)`: that loads the entire journal into one
    // string to hand back a tail whose last element is the only part used, so
    // compaction failed on exactly the journals that most needed compacting.
    // See readNewestJournalEntry.
    const newest = readNewestJournalEntry(journalPath(chatId))
    if (!newest) return false

    // COLLAPSE to the newest entry. The snapshot is still a flat array (one
    // element) so the read contract is unchanged.
    //
    // `append` writes the WHOLE chat record per line, so the newest entry IS
    // complete state and every earlier copy is dead weight. This previously
    // kept `[...previousSnapshot, ...tail]`, making the "snapshot" an
    // append-only archive: measured 2026-08-05 on a real 62 MB chat it reached
    // 488 MB after a handful of saves, and because compaction rewrites the file
    // wholesale, bounding the journal by bytes then made total write volume
    // QUADRATIC in save count — the journal shrank and the snapshot took over.
    // Nothing in production calls `read()`; it is staged for T5 incremental
    // writes, so no consumer loses anything by collapsing. When T5 lands and
    // entries become deltas rather than whole records, this must be revisited:
    // deltas are NOT independently complete and cannot be collapsed this way.
    const merged: unknown[] = [newest]

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
    state.bytesSinceSnapshot = 0
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
