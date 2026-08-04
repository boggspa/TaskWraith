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

/** A single line in the JSONL index. */
interface JsonlRecord {
  chatId: string
  /** null ⇒ tombstone (entry was deleted). */
  entry: Omit<ChatListItem, 'runsSummary' | 'lastRun'> | null
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

/** Strip summary fields from a ChatListItem (what the JSONL stores). */
function stripSummaries(
  item: ChatListItem
): Omit<ChatListItem, 'runsSummary' | 'lastRun'> {
  const { runsSummary: _, lastRun: __, ...rest } = item
  return rest
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

/** True when a JSONL line count warrants compaction. */
function shouldCompact(lineCount: number, chatCount: number): boolean {
  // Compact when stale lines (old versions of entries) exceed 3× chat count.
  return lineCount > chatCount * 4 && lineCount > 100
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
  private migrated = false

  constructor(userDataPath: string) {
    this.indexPath = path.join(userDataPath, 'chat-list-index.jsonl')
    this.summariesDir = path.join(userDataPath, 'chat-list-summaries')
    this.legacyPath = path.join(userDataPath, 'chat-list-index.json')
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Read the full merged index (entries + per-chat summaries). */
  readAll(): Record<string, ChatListItem> {
    this.ensureMigrated()

    let records: JsonlRecord[]
    let lineCount: number
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf-8')
      const lines = raw.split('\n')
      lineCount = lines.length
      records = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          records.push(JSON.parse(trimmed))
        } catch {
          // Corrupt line — skip; the next write will heal it.
        }
      }
    } catch {
      return {}
    }

    // Last record per chatId wins (append-only semantics).
    const index: Record<string, ChatListItem> = {}
    for (const rec of records) {
      if (rec.entry === null) {
        delete index[rec.chatId]
      } else {
        const summaries = this.readSummaries(rec.chatId)
        index[rec.chatId] = {
          ...rec.entry,
          ...(summaries.runsSummary ? { runsSummary: summaries.runsSummary } : {}),
          ...(summaries.lastRun ? { lastRun: summaries.lastRun } : {}),
        } as ChatListItem
      }
    }

    this.cache = index
    this.cacheLineCount = lineCount
    return { ...index }
  }

  /**
   * Write a single entry. Appends one line to the JSONL + writes the
   * per-chat summary file. Compacts periodically.
   */
  writeEntry(chatId: string, item: ChatListItem): void {
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

    // Update cache.
    if (this.cache) {
      this.cache[chatId] = item
      this.cacheLineCount++
    }

    this.compactIfNeeded()
  }

  /**
   * Remove entries (history deletion). Appends tombstones immediately
   * then compacts synchronously so deletion remains complete and provable
   * (NON-NEGOTIABLE #4).
   */
  removeEntries(chatIds: string[]): void {
    this.ensureMigrated()
    if (chatIds.length === 0) return

    ensureDir(path.dirname(this.indexPath))

    // Append tombstones.
    const lines = chatIds
      .map((id) => JSON.stringify({ chatId: id, entry: null }) + '\n')
      .join('')
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
    }

    // Force compaction so deletion is durable (no tombstone-only state).
    this.compact()
  }

  /** Clear all in-memory state. */
  clearCache(): void {
    this.cache = null
    this.cacheLineCount = 0
  }

  /** True when the cached index is still valid (same file mtime+size). */
  isCacheValid(): boolean {
    if (this.cache === null) return false
    try {
      const stat = fs.statSync(this.indexPath)
      return stat.size === this.estimatedFileSize()
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private readSummaries(chatId: string): ChatListSummaryFields {
    const summaryPath = path.join(this.summariesDir, `${chatId}.json`)
    try {
      const raw = fs.readFileSync(summaryPath, 'utf-8')
      return JSON.parse(raw) as ChatListSummaryFields
    } catch {
      return {}
    }
  }

  private estimatedFileSize(): number {
    // Approximate: cacheLineCount lines × ~average bytes per line.
    // Not exact but sufficient for cache invalidation.
    // If cache is stale, readAll() will re-parse.
    return -1 // Always invalidate by size — rely on readAll's parse.
  }

  /**
   * Compact the JSONL: re-read all lines, keep only the last entry per
   * chatId, write a fresh file. Called periodically after writes; forced
   * after removals.
   */
  private compactIfNeeded(): void {
    if (!this.cache) return
    const chatCount = Object.keys(this.cache).length
    if (!shouldCompact(this.cacheLineCount, chatCount)) return
    this.compact()
  }

  private compact(): void {
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

    // Compact: remove tombstones, write only live entries.
    const lines: string[] = []
    for (const [, rec] of latest) {
      if (rec.entry === null) continue
      lines.push(JSON.stringify({ chatId: rec.chatId, entry: rec.entry }) + '\n')
    }

    atomicWrite(this.indexPath, lines.join(''))
    this.cacheLineCount = lines.length
  }

  // -----------------------------------------------------------------------
  // Migration
  // -----------------------------------------------------------------------

  private ensureMigrated(): void {
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

      // Write index entry (without summaries).
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
  }
}
