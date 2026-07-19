import { createReadStream, createWriteStream } from 'fs'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import { createInterface } from 'readline'

/**
 * Per-file incremental cache for the External Activity scan.
 *
 * The 90-day external scan used to re-read and re-parse every in-window
 * session file for codex/claude/gemini/kimi on every refresh — multi-GB of
 * disk reads and JSON parsing per scan on a busy machine. This module keeps
 * the parsed per-file events keyed by (provider, path) and validated by
 * mtime+size, so a refresh only re-parses files that actually changed.
 *
 * Design constraints (deliberate — see perf-drain hunt 2026-07):
 * - Events are stored UNFILTERED by the scan window and filtered by the
 *   caller at assembly time. The cache is therefore never keyed by a
 *   `sinceMs` value; a forward-moving 90-day window keeps every entry valid.
 *   (Keying the whole cache by exact sinceMs is the bug that silently
 *   defeated the Cursor incremental cache.)
 * - The disk format is JSONL (header line + one line per file entry) so
 *   loading and persisting stream line-by-line instead of materializing one
 *   giant JSON.stringify on the main process.
 * - All disk IO is best-effort: a missing/corrupt cache file simply means a
 *   full re-parse, never a broken usage surface.
 */

// Bump whenever a provider parse function changes shape or semantics: entries
// are keyed on (provider, path, mtime, size), so an unchanged file would
// otherwise keep serving events produced by the previous parser forever.
// v3: Codex parses whole files (was: last 8MB only) and derives per-turn
// deltas from the cumulative advance (was: summing possibly-repeated deltas).
// v4: Claude dedupes on requestId+messageId (was: keyed on timestamp too,
// which never matched across the per-content-block rows of one message).
export const EXTERNAL_ACTIVITY_FILE_CACHE_VERSION = 4

interface ExternalActivityFileCacheEntry {
  provider: string
  path: string
  mtimeMs: number
  size: number
  events: unknown[]
}

interface CacheHeaderLine {
  version: number
}

let entriesByKey: Map<string, ExternalActivityFileCacheEntry> | null = null
let loadedPath: string | null = null
let dirty = false

function entryKey(provider: string, path: string): string {
  return `${provider}\u0000${path}`
}

/** Load the cache file into memory once per path; subsequent calls no-op.
 * Passing a different path (tests) reloads from that path. */
export async function ensureExternalActivityFileCacheLoaded(cachePath: string): Promise<void> {
  if (entriesByKey && loadedPath === cachePath) return
  const entries = new Map<string, ExternalActivityFileCacheEntry>()
  entriesByKey = entries
  loadedPath = cachePath
  dirty = false
  let sawValidHeader = false
  try {
    const input = createReadStream(cachePath, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (!sawValidHeader) {
          const header = parsed as CacheHeaderLine
          if (header?.version !== EXTERNAL_ACTIVITY_FILE_CACHE_VERSION) return
          sawValidHeader = true
          continue
        }
        const entry = parsed as ExternalActivityFileCacheEntry
        if (
          typeof entry?.provider !== 'string' ||
          typeof entry?.path !== 'string' ||
          !Number.isFinite(entry?.mtimeMs) ||
          !Number.isFinite(entry?.size) ||
          !Array.isArray(entry?.events)
        ) {
          continue
        }
        entries.set(entryKey(entry.provider, entry.path), entry)
      }
    } finally {
      lines.close()
      input.destroy()
    }
  } catch {
    // Missing or unreadable cache file — start empty.
  }
}

export function getCachedExternalFileEvents(
  provider: string,
  path: string,
  mtimeMs: number,
  size: number
): unknown[] | null {
  const entry = entriesByKey?.get(entryKey(provider, path))
  if (!entry) return null
  if (entry.mtimeMs !== mtimeMs || entry.size !== size) return null
  return entry.events
}

export function setCachedExternalFileEvents(
  provider: string,
  path: string,
  mtimeMs: number,
  size: number,
  events: unknown[]
): void {
  if (!entriesByKey) return
  entriesByKey.set(entryKey(provider, path), { provider, path, mtimeMs, size, events })
  dirty = true
}

/** Drop entries for files no longer in the provider's active (in-window) set
 * so the cache tracks the rolling window instead of growing forever. */
export function pruneExternalActivityFileCache(provider: string, activePaths: Set<string>): void {
  if (!entriesByKey) return
  for (const [key, entry] of entriesByKey) {
    if (entry.provider !== provider) continue
    if (!activePaths.has(entry.path)) {
      entriesByKey.delete(key)
      dirty = true
    }
  }
}

/** Persist to disk when anything changed this scan. Streams JSONL through a
 * write stream (awaiting drain) and swaps in atomically via tmp+rename. */
export async function persistExternalActivityFileCacheIfDirty(cachePath: string): Promise<void> {
  if (!dirty || !entriesByKey || loadedPath !== cachePath) return
  const tempPath = `${cachePath}.tmp-${process.pid}`
  try {
    await fs.mkdir(dirname(cachePath), { recursive: true })
    const stream = createWriteStream(tempPath, { encoding: 'utf8', mode: 0o600 })
    const writeLine = (line: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (stream.write(`${line}\n`)) {
          resolve()
          return
        }
        const onDrain = (): void => {
          stream.off('error', onError)
          resolve()
        }
        const onError = (err: Error): void => {
          stream.off('drain', onDrain)
          reject(err)
        }
        stream.once('drain', onDrain)
        stream.once('error', onError)
      })
    try {
      await writeLine(JSON.stringify({ version: EXTERNAL_ACTIVITY_FILE_CACHE_VERSION }))
      for (const entry of entriesByKey.values()) {
        await writeLine(JSON.stringify(entry))
      }
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
      })
    } catch (err) {
      stream.destroy()
      throw err
    }
    await fs.rename(tempPath, cachePath)
    dirty = false
  } catch {
    // Best-effort persistence — a failed write must not break usage surfaces.
    try {
      await fs.rm(tempPath, { force: true })
    } catch {
      // ignore
    }
  }
}

/** Tests only: drop in-memory state so the next load re-reads from disk. */
export function resetExternalActivityFileCacheForTests(): void {
  entriesByKey = null
  loadedPath = null
  dirty = false
}
