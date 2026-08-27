/**
 * T3c — Chat-list-index split + incremental store.
 *
 * Replaces the monolithic `chat-list-index.json` (full rewrite on every
 * chat save, ~7.2 MB × 13–14 rewrites per 10 s) with:
 *
 * 1. An append-only JSONL index (`chat-list-index.jsonl`) — one line per
 *    changed chat, so writes are O(delta) instead of O(all-chats).
 * 2. Per-chat summary files (`chat-list-summaries/{chatId}.json`) —
 *    `runsSummary` and `lastRun` are moved out of the index, shrinking it
 *    by >90% (the 7.2 MB figure is dominated by run-summary arrays).
 * 3. Periodic snapshot compaction when the JSONL grows too many stale
 *    lines relative to the live chat count.
 * 4. Lazy migration from the legacy `chat-list-index.json` format —
 *    transparent on first load; old format readable forever.
 * 5. mtimeMs+size cache stamp so repeat readAll()/readEntry() skips the
 *    full JSONL parse (and the per-summary reads) when the file is
 *    unchanged. Invalidation is stamped on every mutation path, and the
 *    stamp records WHICH file it came from so an unmigrated legacy profile
 *    on a read-only Host caches too instead of re-parsing on every call.
 *    A cold parse also resolves the append-only last-line-wins winner BEFORE
 *    touching any side file, so summary reads cost O(live chats) and not
 *    O(lines): `shouldCompact` lets the JSONL carry up to 4x chatCount
 *    lines, so reading per line threw ~75% of that file I/O away.
 * 6. List projection carries only the LEAN ensemble (the flagged
 *    `toChatListEnsembleProjection` output, ~3 KB); the fat blob was ~98% of
 *    each entry and is not a list-index concern. Dropping `ensemble` outright
 *    was worse than keeping it lean: `normalizeChatRecord` then rebuilt a
 *    `createDefaultEnsembleConfig` roster, so rows advertised seats the user
 *    never configured. One-time compact rewrites historical fat lines so
 *    existing installs actually shrink, REDUCING each legacy blob to that same
 *    lean projection rather than dropping it — dropping there reintroduced the
 *    fabricated roster for every chat not since re-saved.
 *
 * NON-NEGOTIABLE #4 (history deletion) — the `removeEntries` method
 * appends tombstones immediately and then writes a compacted snapshot
 * synchronously so deletion remains complete and provable; the old
 * full-rewrite semantics are preserved for this path.
 */

import * as fs from 'fs'
import * as path from 'path'

import type { ChatListItem, ChatListRunSummary, ChatRun } from './types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields we strip from the index and store in per-chat summary files. */
export interface ChatListSummaryFields {
  runsSummary?: ChatListRunSummary[]
  lastRun?: ChatRun
}

/**
 * Fields that must never live in the list-index JSONL line.
 *
 * `ensemble` is optional rather than omitted: the line carries the LEAN
 * projection (flagged `__chatListProjection`) so the sidebar can render a real
 * roster, and never the fat blob. Omitting it outright made this type lie
 * about what `stripSummaries` now emits.
 */
type ChatListIndexLineEntry = Omit<ChatListItem, 'runsSummary' | 'lastRun' | 'ensemble'> &
  Partial<Pick<ChatListItem, 'ensemble'>>

/** A single line in the JSONL index. */
interface JsonlRecord {
  chatId: string
  /** null ⇒ tombstone (entry was deleted). */
  entry: ChatListIndexLineEntry | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, data, { encoding: 'utf-8' })
  fs.renameSync(tmp, filePath)
}

/**
 * Marker stamped by `AppStore.toChatListEnsembleProjection`, which is the ONLY
 * producer of a list-sized ensemble (roundSummaries / blackboard / wakeups /
 * activity ledger dropped, seat `instructions` blanked: 111 KB → 3 KB on a
 * 15-seat round). Its presence is what separates a LEAN row roster from a
 * legacy FAT blob, and the whole read/write split below turns on it.
 *
 * The literal is mirrored from `store/index.ts` (private there). Keep the two
 * identical — if they drift, lean rosters get treated as legacy blobs and
 * every read triggers a compact (see `entryHasUnprojectedEnsemble`).
 */
const CHAT_LIST_ENSEMBLE_PROJECTION_FLAG = '__chatListProjection'

/** True when an `ensemble` value is the lean, list-sized projection. */
function isLeanEnsembleProjection(ensemble: unknown): boolean {
  if (!ensemble || typeof ensemble !== 'object') return false
  return (ensemble as Record<string, unknown>)[CHAT_LIST_ENSEMBLE_PROJECTION_FLAG] === true
}

/**
 * The store-local mirror of `AppStore.toChatListEnsembleProjection`: drop the
 * four sub-blobs that make an entry fat and blank the seat briefs, keeping
 * activeRound / roles / providers so sidebar rows still render.
 *
 * It cannot be imported from `store/index.ts` — that module owns this one, so
 * the dependency would be circular. The duplication is deliberate and narrow;
 * the projection suite's round-trip test fails if the two drift.
 */
function toLeanEnsembleProjection(ensemble: Record<string, unknown>): Record<string, unknown> {
  const {
    roundSummaries: _roundSummaries,
    blackboard: _blackboard,
    blackboardTombstones: _blackboardTombstones,
    wakeups: _wakeups,
    sessionActivityLedger: _sessionActivityLedger,
    ...rest
  } = ensemble
  const participants = Array.isArray(rest.participants) ? rest.participants : []
  return {
    ...rest,
    // `instructions` is required on EnsembleParticipant, so blank it rather
    // than drop it — a row needs the seat's role and provider, never its brief.
    participants: participants.map((participant) =>
      participant && typeof participant === 'object'
        ? { ...(participant as Record<string, unknown>), instructions: '' }
        : participant
    ),
    [CHAT_LIST_ENSEMBLE_PROJECTION_FLAG]: true
  }
}

/**
 * Strip fields that do not belong in the JSONL list projection:
 * - runsSummary / lastRun → per-chat summary side files (T3c)
 * - ensemble → reduced to the LEAN projection, never dropped
 *
 * `ensemble` used to be dropped unconditionally for size. That blanked the
 * roster on every sidebar row, and `normalizeChatRecord` then REBUILT one from
 * `createDefaultEnsembleConfig` for any `chatKind === 'ensemble'` record — so a
 * 15-seat chat rendered as ~4 seats the user never configured. Fabricated
 * rosters are worse than absent ones, so a lean projection is kept.
 *
 * An UNFLAGGED ensemble is REDUCED here rather than dropped. Dropping it was
 * the same fabrication bug one step earlier: the legacy JSONL every existing
 * install already has is fat and unflagged, it is healed through this function
 * by the one-time compact, and dropping there handed the sidebar a rosterless
 * row that `normalizeChatRecord` refilled with default seats — for every chat
 * the user never happens to re-save. The real roster is present in that line,
 * so reducing it costs one projection and loses nothing a list surface reads.
 * Fat in / lean out, never fat in / gone. Size is unaffected in practice: the
 * lean copy is ~3 KB against the ~229 KB blob it replaces.
 */
function stripSummaries(item: ChatListItem): ChatListIndexLineEntry {
  const { runsSummary: _runsSummary, lastRun: _lastRun, ensemble, ...rest } = item
  if (!ensemble || typeof ensemble !== 'object') return rest
  if (isLeanEnsembleProjection(ensemble)) return { ...rest, ensemble }
  return {
    ...rest,
    ensemble: toLeanEnsembleProjection(
      ensemble as unknown as Record<string, unknown>
    ) as unknown as ChatListItem['ensemble']
  }
}

/**
 * True when a parsed JSONL entry carries an ensemble that does NOT belong on a
 * list line — i.e. a legacy fat blob written before the projection existed.
 *
 * Gating on the projection flag rather than the bare presence of `ensemble` is
 * load-bearing: this predicate drives `sawEnsemble → compact()` in `readAll`.
 * Keyed on presence alone, every healthy lean row would look like a legacy blob
 * and fire a full compaction on EVERY read — on the path already measured at
 * ~485 ms per `saveChat`. Legacy lines still heal exactly once, then stop
 * matching because the rewritten line carries the flag.
 */
function entryHasUnprojectedEnsemble(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (!Object.prototype.hasOwnProperty.call(entry, 'ensemble')) return false
  return !isLeanEnsembleProjection((entry as Record<string, unknown>).ensemble)
}

/** Extract summary fields from a ChatListItem.
 *  Always emits `runsSummary` for summaryOnly entries so the
 *  freshness check in getChatList (which uses runsSummary absence
 *  as a signal that the entry predates the field) works correctly
 *  with the split store. */
function extractSummaries(item: ChatListItem): ChatListSummaryFields {
  const result: ChatListSummaryFields = {}
  if (item.summaryOnly === true) {
    result.runsSummary = Array.isArray(item.runsSummary) ? item.runsSummary : []
  }
  if (item.lastRun) {
    result.lastRun = item.lastRun
  }
  return result
}

/** Merge a stripped index line with optional side-file summaries. */
function mergeEntry(entry: ChatListIndexLineEntry, summaries: ChatListSummaryFields): ChatListItem {
  return {
    ...entry,
    ...(summaries.runsSummary ? { runsSummary: summaries.runsSummary } : {}),
    ...(summaries.lastRun ? { lastRun: summaries.lastRun } : {})
  } as ChatListItem
}

/** True when a JSONL line count warrants compaction. */
function shouldCompact(lineCount: number, chatCount: number): boolean {
  // Compact when stale lines (old versions of entries) exceed 3× chat count.
  return lineCount > chatCount * 4 && lineCount > 100
}

export interface ChatListIndexStoreOptions {
  /** Dynamic authority for durable migrations and index mutations. */
  canWrite?: () => boolean
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ChatListIndexStore {
  private readonly indexPath: string
  private readonly summariesDir: string
  private readonly legacyPath: string
  private cache: Record<string, ChatListItem> | null = null
  private cacheLineCount = 0
  /**
   * Which file `cache` was stamped against: normally indexPath, but legacyPath
   * while a read-only Host projects an unmigrated profile. Empty = unstamped.
   */
  private cacheSourcePath = ''
  /** mtimeMs of cacheSourcePath when `cache` was last stamped from disk. */
  private cacheMtimeMs = -1
  /** size of cacheSourcePath when `cache` was last stamped from disk. */
  private cacheSize = -1
  private migrated = false
  private readonly canWrite: () => boolean

  constructor(userDataPath: string, options: ChatListIndexStoreOptions = {}) {
    this.indexPath = path.join(userDataPath, 'chat-list-index.jsonl')
    this.summariesDir = path.join(userDataPath, 'chat-list-summaries')
    this.legacyPath = path.join(userDataPath, 'chat-list-index.json')
    this.canWrite = options.canWrite ?? (() => true)
  }

  private isWritable(): boolean {
    try {
      return this.canWrite() === true
    } catch {
      return false
    }
  }

  private assertWritable(): void {
    if (!this.isWritable()) throw new Error('Chat list index is read-only')
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Read the full merged index (entries + per-chat summaries). */
  readAll(): Record<string, ChatListItem> {
    this.ensureMigrated()

    if (this.isCacheValid() && this.cache) {
      // Defensive shallow copy — callers must not mutate the live cache.
      return { ...this.cache }
    }

    let records: JsonlRecord[]
    let sawEnsemble = false
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8')
      const lines = raw.split('\n')
      records = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          const parsed = JSON.parse(trimmed) as JsonlRecord
          if (parsed.entry !== null && entryHasUnprojectedEnsemble(parsed.entry)) {
            sawEnsemble = true
            // Reduce the legacy fat blob to lean in the in-memory projection
            // immediately, so the sidebar gets the real roster on this very
            // read rather than waiting for the compact below. A LEAN
            // projection is left alone — it is already what rows render from.
            parsed.entry = stripSummaries(parsed.entry as ChatListItem)
          }
          records.push(parsed)
        } catch {
          // Corrupt line — skip; the next write will heal it.
        }
      }
    } catch {
      // A read-only Host may still project a pre-JSONL profile. Migration is
      // deliberately deferred until authority is restored, so preserve the
      // legacy record in memory rather than creating any new artifact here.
      if (!this.isWritable() && !fs.existsSync(this.indexPath)) {
        return this.readLegacyIndexReadOnly()
      }
      return {}
    }

    // Last record per chatId wins (append-only semantics). Resolve that
    // winner FIRST, then read side files once per SURVIVING chat. Reading
    // them inside the record loop cost one readFileSync + JSON.parse per
    // LINE, and every superseded line's summaries were overwritten by the
    // next line for the same chat before any caller could observe them --
    // `shouldCompact` lets the file hold 4x chatCount lines, so ~75% of that
    // synchronous I/O was pure waste on the measured ~485ms cold path.
    const latest = new Map<string, ChatListIndexLineEntry | null>()
    for (const rec of records) {
      latest.set(rec.chatId, rec.entry)
    }

    const index: Record<string, ChatListItem> = {}
    for (const [chatId, entry] of latest) {
      // A tombstone that won simply never materializes.
      if (entry === null) continue
      index[chatId] = mergeEntry(entry, this.readSummaries(chatId))
    }

    this.cache = index
    // Count real parsed records: `lines.length` also counted the trailing ''
    // after the final newline, so this now agrees with compact()'s own count.
    this.cacheLineCount = records.length
    this.stampCacheFromDisk()

    // Historical fat lines stay on disk until compacted. Force one rewrite so
    // the 98.7 MB install actually shrinks; projecting on write alone cannot
    // reach lines that were already written.
    if (sawEnsemble && this.isWritable()) {
      this.compact()
    }

    return { ...this.cache! }
  }

  /**
   * O(1) single-entry read on a warm/valid cache. Warms via readAll() on miss.
   * Always returns a defensive copy (R4) — never a live reference into `cache`.
   */
  readEntry(chatId: string): ChatListItem | undefined {
    this.ensureMigrated()

    if (!this.isCacheValid() || !this.cache) {
      this.readAll()
    }

    const item = this.cache?.[chatId]
    return item ? { ...item } : undefined
  }

  /**
   * Write a single entry. Appends one line to the JSONL + writes the
   * per-chat summary file. Compacts periodically.
   */
  writeEntry(chatId: string, item: ChatListItem): void {
    this.assertWritable()
    this.ensureMigrated()
    ensureDir(path.dirname(this.indexPath))
    ensureDir(this.summariesDir)

    // Write per-chat summaries.
    const summaries = extractSummaries(item)
    if (summaries.runsSummary || summaries.lastRun) {
      atomicWrite(
        path.join(this.summariesDir, `${chatId}.json`),
        JSON.stringify(summaries, null, 2)
      )
    } else {
      // No summaries — remove stale file if present.
      const summaryPath = path.join(this.summariesDir, `${chatId}.json`)
      try {
        fs.unlinkSync(summaryPath)
      } catch {
        // ignore
      }
    }

    const entry = stripSummaries(item)
    const line = JSON.stringify({ chatId, entry }) + '\n'
    fs.appendFileSync(this.indexPath, line, { encoding: 'utf-8' })

    // Update cache with the list projection (summaries in, ensemble leaned).
    if (this.cache) {
      this.cache[chatId] = mergeEntry(entry, summaries)
      this.cacheLineCount++
    }
    this.stampCacheFromDisk()

    this.compactIfNeeded()
  }

  /**
   * Remove entries (history deletion). Appends tombstones immediately
   * then compacts synchronously so deletion remains complete and provable
   * (NON-NEGOTIABLE #4).
   */
  removeEntries(chatIds: string[]): void {
    this.assertWritable()
    this.ensureMigrated()
    if (chatIds.length === 0) return

    ensureDir(path.dirname(this.indexPath))

    // Append tombstones.
    const lines = chatIds.map((id) => JSON.stringify({ chatId: id, entry: null }) + '\n').join('')
    fs.appendFileSync(this.indexPath, lines, { encoding: 'utf-8' })

    // Remove per-chat summary files.
    for (const chatId of chatIds) {
      const summaryPath = path.join(this.summariesDir, `${chatId}.json`)
      try {
        fs.unlinkSync(summaryPath)
      } catch {
        // ignore
      }
    }

    // Update cache.
    if (this.cache) {
      for (const chatId of chatIds) delete this.cache[chatId]
      this.cacheLineCount += chatIds.length
    }
    // Stamp the post-append size before compact rewrites the file; compact()
    // restamps after the atomic write so a deleted entry cannot be served.
    this.stampCacheFromDisk()

    // Force compaction so deletion is durable (no tombstone-only state).
    this.compact()
  }

  /** Clear all in-memory state. */
  clearCache(): void {
    this.cache = null
    this.cacheLineCount = 0
    this.cacheSourcePath = ''
    this.cacheMtimeMs = -1
    this.cacheSize = -1
  }

  /** True when the cached index is still valid (same file mtimeMs + size). */
  isCacheValid(): boolean {
    if (this.cache === null) return false
    if (this.cacheSourcePath === '') return false
    if (this.cacheMtimeMs < 0 || this.cacheSize < 0) return false
    // A legacy-sourced stamp only holds while no JSONL exists: readAll always
    // prefers the JSONL, so its arrival (migration, or another process) must
    // drop the legacy cache rather than keep serving pre-migration rows.
    if (this.cacheSourcePath !== this.indexPath && fs.existsSync(this.indexPath)) {
      return false
    }
    try {
      const stat = fs.statSync(this.cacheSourcePath)
      return stat.mtimeMs === this.cacheMtimeMs && stat.size === this.cacheSize
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Stamp cache validity from the file the cache was actually built from
   * (R1 — every mutation). Defaults to the live index; the read-only legacy
   * projection passes legacyPath so it stops re-parsing on every call.
   */
  private stampCacheFromDisk(sourcePath: string = this.indexPath): void {
    try {
      const stat = fs.statSync(sourcePath)
      this.cacheSourcePath = sourcePath
      this.cacheMtimeMs = stat.mtimeMs
      this.cacheSize = stat.size
    } catch {
      this.cacheSourcePath = ''
      this.cacheMtimeMs = -1
      this.cacheSize = -1
    }
  }

  private readSummaries(chatId: string): ChatListSummaryFields {
    const summaryPath = path.join(this.summariesDir, `${chatId}.json`)
    try {
      const raw = fs.readFileSync(summaryPath, 'utf-8')
      return JSON.parse(raw) as ChatListSummaryFields
    } catch {
      return {}
    }
  }

  /**
   * Compact the JSONL: re-read all lines, keep only the last entry per
   * chatId, re-apply stripSummaries (which REDUCES a legacy fat ensemble to
   * the lean projection — it does not drop it, because the roster is what the
   * sidebar renders), write a fresh file. Called periodically after writes;
   * forced after removals and after detecting pre-migration ensemble blobs.
   */
  private compactIfNeeded(): void {
    if (!this.cache) return
    const chatCount = Object.keys(this.cache).length
    if (!shouldCompact(this.cacheLineCount, chatCount)) return
    this.compact()
  }

  private compact(): void {
    this.assertWritable()
    let records: JsonlRecord[]
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8')
      records = []
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          records.push(JSON.parse(trimmed))
        } catch {
          // skip corrupt lines
        }
      }
    } catch {
      return
    }

    // Last entry per chatId wins.
    const latest = new Map<string, JsonlRecord>()
    for (const rec of records) {
      latest.set(rec.chatId, rec)
    }

    // Compact: remove tombstones, re-apply the list projection (a legacy fat
    // ensemble is reduced to lean here, not dropped), write only live entries.
    const lines: string[] = []
    for (const [, rec] of latest) {
      if (rec.entry === null) continue
      const entry = stripSummaries(rec.entry as ChatListItem)
      lines.push(JSON.stringify({ chatId: rec.chatId, entry }) + '\n')
    }

    atomicWrite(this.indexPath, lines.join(''))
    this.cacheLineCount = lines.length
    this.stampCacheFromDisk()
  }

  // -----------------------------------------------------------------------
  // Migration
  // -----------------------------------------------------------------------

  /**
   * Project the pre-JSONL index without migrating it. This is only reached
   * while writes are unavailable, and intentionally leaves `migrated` false
   * so a later writable operation can perform the durable migration.
   */
  private readLegacyIndexReadOnly(): Record<string, ChatListItem> {
    let legacyIndex: Record<string, ChatListItem>
    try {
      legacyIndex = JSON.parse(fs.readFileSync(this.legacyPath, 'utf-8')) as Record<
        string,
        ChatListItem
      >
    } catch {
      return {}
    }

    const index: Record<string, ChatListItem> = {}
    for (const [chatId, item] of Object.entries(legacyIndex)) {
      if (!item || typeof item !== 'object') continue
      const entry = stripSummaries(item)
      index[chatId] = mergeEntry(entry, extractSummaries(item))
    }

    this.cache = index
    this.cacheLineCount = Object.keys(index).length
    // Stamp against the LEGACY file so a read-only Host stops re-parsing it
    // on every readAll/readEntry. isCacheValid() drops this stamp the moment
    // a JSONL appears, so a later migration still wins.
    this.stampCacheFromDisk(this.legacyPath)
    return { ...index }
  }

  private ensureMigrated(): void {
    if (!this.isWritable()) {
      return
    }
    if (this.migrated) return
    this.migrated = true

    // Already migrated — JSONL exists.
    if (fs.existsSync(this.indexPath)) return

    // No legacy file — nothing to migrate.
    if (!fs.existsSync(this.legacyPath)) return

    // Migrate from legacy chat-list-index.json.
    let legacyIndex: Record<string, ChatListItem>
    try {
      legacyIndex = JSON.parse(fs.readFileSync(this.legacyPath, 'utf-8'))
    } catch {
      return // Corrupt legacy file — start fresh.
    }

    ensureDir(path.dirname(this.indexPath))
    ensureDir(this.summariesDir)

    const lines: string[] = []
    for (const [chatId, item] of Object.entries(legacyIndex)) {
      if (!item || typeof item !== 'object') continue

      // Write per-chat summary file.
      const summaries = extractSummaries(item)
      if (summaries.runsSummary || summaries.lastRun) {
        atomicWrite(
          path.join(this.summariesDir, `${chatId}.json`),
          JSON.stringify(summaries, null, 2)
        )
      }

      // Write index entry (summaries split out, ensemble reduced to lean).
      const entry = stripSummaries(item)
      lines.push(JSON.stringify({ chatId, entry }) + '\n')
    }

    // Write new JSONL index.
    atomicWrite(this.indexPath, lines.join(''))

    // Remove legacy file so we never double-migrate.
    try {
      fs.unlinkSync(this.legacyPath)
    } catch {
      // Non-fatal — next load skips migration because JSONL exists.
    }

    this.cacheLineCount = lines.length
    this.stampCacheFromDisk()
  }
}
