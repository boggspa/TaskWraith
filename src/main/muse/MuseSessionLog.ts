/**
 * Resolve Muse `session_id → session_log_path` via `session-index.db`, then
 * byte-offset-tail the durable `session.jsonl`.
 *
 * Do **not** reconstruct `sessions/YYYY/MM/DD/<id>/…` from wall clock — the
 * creation-day partition can disagree with a midnight-crossing run. Prefer the
 * index row; fall back to a depth-capped filesystem search that matches the
 * session id directory name.
 *
 * SQLite is opened read-only through `/usr/bin/sqlite3` (same family as
 * CursorUsage / ExternalProviderActivity) so we never hold a write lock
 * against Muse's WAL writer.
 */

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { parseMuseEnvelope, type MuseEnvelope } from './MuseExecJson'

export interface MuseSessionIndexRow {
  session_id: string
  session_log_path: string
  session_dir: string
  model_id: string | null
  status: string | null
  latest_segment_terminated: number | null
}

export interface ResolveMuseSessionLogOptions {
  /** Absolute Muse data home (`$XDG_DATA_HOME/muse` or `…/muse`). */
  dataHome: string
  sessionId: string
  /** Override sqlite3 binary (tests). */
  sqlite3Path?: string
  /** Injected query runner (tests). */
  querySqlite?: (dbPath: string, sql: string) => Promise<string | null>
  /** Max wall time to wait for the index/fs path to appear. */
  timeoutMs?: number
  /** Initial backoff between resolve attempts. */
  initialBackoffMs?: number
  /** Cap on backoff. */
  maxBackoffMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface MuseSessionLogResolveResult {
  row: MuseSessionIndexRow | null
  sessionLogPath: string | null
  source: 'session-index' | 'fs-fallback' | 'missing'
}

export interface MuseSessionLogTailOptions {
  sessionLogPath: string
  /** Called for each complete parsed envelope. */
  onEnvelope?: (envelope: MuseEnvelope) => void
  /** Called for each complete raw line (after newline split). */
  onLine?: (line: string) => void
  onTruncate?: () => void
  onParseError?: (line: string, error: unknown) => void
}

export interface MuseSessionLogTailer {
  readonly byteOffset: number
  readonly pending: string
  readonly parseErrorCount: number
  /** Read newly appended complete lines since the last poll. */
  poll(): Promise<number>
  /** Final read-to-EOF after process exit (settle window left to caller). */
  flushFinal(): Promise<number>
  close(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_INITIAL_BACKOFF_MS = 25
const DEFAULT_MAX_BACKOFF_MS = 250
const SQLITE_TIMEOUT_MS = 8_000
const MAX_FS_FALLBACK_DEPTH = 8
const MAX_FS_FALLBACK_VISITS = 4_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function museDataRoot(dataHome: string): string {
  const trimmed = dataHome.replace(/\/+$/, '')
  return trimmed.endsWith(`${sep}muse`) || trimmed.endsWith('/muse')
    ? trimmed
    : join(trimmed, 'muse')
}

export function museSessionIndexDbPath(dataHome: string): string {
  return join(museDataRoot(dataHome), 'session-index.db')
}

function escapeSqliteLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

async function runSqliteScalar(
  dbPath: string,
  sql: string,
  sqlite3Path = '/usr/bin/sqlite3'
): Promise<string | null> {
  return new Promise((resolve) => {
    const opts = { timeout: SQLITE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    const uriPath = `file:${dbPath}?mode=ro&immutable=1`
    execFile(sqlite3Path, [uriPath, sql], opts, (uriErr, uriStdout) => {
      if (!uriErr) {
        resolve(String(uriStdout || '').trim() || null)
        return
      }
      execFile(sqlite3Path, ['-readonly', dbPath, sql], opts, (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        resolve(String(stdout || '').trim() || null)
      })
    })
  })
}

function parseIndexRow(sessionId: string, raw: string | null): MuseSessionIndexRow | null {
  if (!raw) return null
  // session_log_path|session_dir|model_id|status|latest_segment_terminated
  const parts = raw.split('|')
  if (parts.length < 2) return null
  const session_log_path = parts[0]?.trim()
  const session_dir = parts[1]?.trim()
  if (!session_log_path || !session_dir) return null
  const modelRaw = parts[2]?.trim()
  const statusRaw = parts[3]?.trim()
  const terminatedRaw = parts[4]?.trim()
  const terminated =
    terminatedRaw && terminatedRaw.length > 0 && Number.isFinite(Number(terminatedRaw))
      ? Number(terminatedRaw)
      : null
  return {
    session_id: sessionId,
    session_log_path,
    session_dir,
    model_id: modelRaw ? modelRaw : null,
    status: statusRaw ? statusRaw : null,
    latest_segment_terminated: terminated
  }
}

export async function queryMuseSessionIndexRow(
  dataHome: string,
  sessionId: string,
  deps?: Pick<ResolveMuseSessionLogOptions, 'sqlite3Path' | 'querySqlite'>
): Promise<MuseSessionIndexRow | null> {
  const id = sessionId.trim()
  if (!id) return null
  const dbPath = museSessionIndexDbPath(dataHome)
  try {
    await fs.access(dbPath)
  } catch {
    return null
  }
  const sql =
    `SELECT session_log_path, session_dir, IFNULL(model_id,''), IFNULL(status,''), ` +
    `IFNULL(latest_segment_terminated,'') ` +
    `FROM sessions WHERE session_id = '${escapeSqliteLiteral(id)}' LIMIT 1;`
  const query = deps?.querySqlite ?? ((path, q) => runSqliteScalar(path, q, deps?.sqlite3Path))
  const raw = await query(dbPath, sql)
  return parseIndexRow(id, raw)
}

/**
 * Depth-capped search for `…/<sessionId>/session.jsonl` under the Muse data
 * home. Still does not invent a date partition from the wall clock.
 */
export async function findMuseSessionLogByFsFallback(
  dataHome: string,
  sessionId: string
): Promise<string | null> {
  const id = sessionId.trim()
  if (!id) return null
  const root = join(museDataRoot(dataHome), 'sessions')
  try {
    const rootStat = await fs.stat(root)
    if (!rootStat.isDirectory()) return null
  } catch {
    return null
  }

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let visits = 0
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!
    visits += 1
    if (visits > MAX_FS_FALLBACK_VISITS) return null
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth + 1 <= MAX_FS_FALLBACK_DEPTH) {
          stack.push({ dir: entryPath, depth: depth + 1 })
        }
        continue
      }
      if (!entry.isFile() || entry.name !== 'session.jsonl') continue
      // Parent directory name must equal the session id (date partitions above).
      const parent = normalize(dir)
      const parts = parent.split(sep)
      if (parts[parts.length - 1] === id) {
        try {
          await fs.access(entryPath)
          return entryPath
        } catch {
          continue
        }
      }
    }
  }
  return null
}

async function pathExists(path: string | null | undefined): Promise<boolean> {
  if (!path) return false
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** Single resolve attempt (index, then fs fallback). */
export async function resolveMuseSessionLogOnce(
  options: ResolveMuseSessionLogOptions
): Promise<MuseSessionLogResolveResult> {
  const row = await queryMuseSessionIndexRow(options.dataHome, options.sessionId, options)
  if (row && (await pathExists(row.session_log_path))) {
    return { row, sessionLogPath: row.session_log_path, source: 'session-index' }
  }
  const fallback = await findMuseSessionLogByFsFallback(options.dataHome, options.sessionId)
  if (fallback) {
    return {
      row,
      sessionLogPath: fallback,
      source: 'fs-fallback'
    }
  }
  return { row, sessionLogPath: null, source: 'missing' }
}

/**
 * Poll until the session log path appears or timeout. Indexer lag of ~20s has
 * been observed after session creation.
 */
export async function resolveMuseSessionLogPath(
  options: ResolveMuseSessionLogOptions
): Promise<MuseSessionLogResolveResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs
  let backoff = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
  const maxBackoff = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS

  for (;;) {
    const result = await resolveMuseSessionLogOnce(options)
    if (result.sessionLogPath) return result
    if (now() >= deadline) return result
    await sleep(backoff)
    backoff = Math.min(maxBackoff, Math.max(backoff * 2, backoff + 1))
  }
}

function splitCompleteLines(buffer: string): { complete: string[]; pending: string } {
  const segments = buffer.split(/\r?\n/)
  const pending = segments.pop() ?? ''
  return { complete: segments, pending }
}

/**
 * Create a byte-offset tailer for an append-only `session.jsonl`.
 * Handles torn last lines, truncate/rotate (`size < offset` → reset), and a
 * final flush after process exit.
 */
export function createMuseSessionLogTailer(options: MuseSessionLogTailOptions): MuseSessionLogTailer {
  let byteOffset = 0
  let pending = ''
  let parseErrorCount = 0
  let closed = false

  const emitLine = (line: string): void => {
    if (!line.trim()) return
    options.onLine?.(line)
    try {
      const parsed = JSON.parse(line)
      const envelope = parseMuseEnvelope(parsed)
      if (envelope) options.onEnvelope?.(envelope)
    } catch (err) {
      parseErrorCount += 1
      options.onParseError?.(line, err)
    }
  }

  const readAvailable = async (): Promise<number> => {
    if (closed) return 0
    let stat
    try {
      stat = await fs.stat(options.sessionLogPath)
    } catch {
      return 0
    }
    if (stat.size < byteOffset) {
      // Truncate / rotate — reset and warn via callback.
      byteOffset = 0
      pending = ''
      options.onTruncate?.()
    }
    if (stat.size === byteOffset) return 0

    const handle = await fs.open(options.sessionLogPath, 'r')
    try {
      const toRead = stat.size - byteOffset
      const buf = Buffer.alloc(toRead)
      const { bytesRead } = await handle.read(buf, 0, toRead, byteOffset)
      byteOffset += bytesRead
      const chunk = buf.subarray(0, bytesRead).toString('utf8')
      const split = splitCompleteLines(pending + chunk)
      pending = split.pending
      for (const line of split.complete) emitLine(line)
      return split.complete.length
    } finally {
      await handle.close()
    }
  }

  return {
    get byteOffset() {
      return byteOffset
    },
    get pending() {
      return pending
    },
    get parseErrorCount() {
      return parseErrorCount
    },
    poll: readAvailable,
    flushFinal: readAvailable,
    async close() {
      closed = true
    }
  }
}

/**
 * Parse a single complete `session.jsonl` line into an envelope (or null).
 * Malformed complete lines return null rather than throwing.
 */
export function parseMuseSessionLogLine(line: string): MuseEnvelope | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return parseMuseEnvelope(JSON.parse(trimmed))
  } catch {
    return null
  }
}
