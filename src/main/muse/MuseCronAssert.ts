import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/**
 * Teardown assert: managed Muse seats must leave `cron_jobs` empty.
 *
 * Native `cron_create` / `cron_delete` / `cron_list` remain model-reachable with
 * no CLI kill-switch (Wave-1 D). Resolve the session directory only via
 * `session-index.db` → `session_log_path` (or `session_dir`), never by
 * reconstructing `YYYY/MM/DD/` date paths.
 */

export const MUSE_SESSION_INDEX_DB_BASENAME = 'session-index.db' as const
export const MUSE_CRON_DB_BASENAME = 'cron.db' as const
export const MUSE_EXPECTED_CRON_SCHEMA_VERSION = '1' as const

export interface MuseSessionIndexLookupRow {
  readonly sessionId: string
  readonly sessionLogPath: string
  readonly sessionDir: string
}

/**
 * How cron emptiness was established.
 * - `session-index`: the CLI's index row resolved the session dir directly.
 * - `lease-scan`: no index row, but every cron.db found in the lease-local
 *   data home was inspected and empty.
 * - `no-session-cron-artifacts`: no index row and no cron.db exists anywhere
 *   in the lease-local data home (e.g. the run failed before its first turn,
 *   or the CLI has not materialized session state) — vacuously empty.
 */
export type MuseCronAssertBasis = 'session-index' | 'lease-scan' | 'no-session-cron-artifacts'

export type MuseCronAssertOk = Readonly<{
  ok: true
  sessionId: string
  sessionDir: string | null
  cronDbPath: string | null
  jobCount: 0
  schemaVersion: string | null
  /** Always set by this module; optional so external test seams stay source-compatible. */
  basis?: MuseCronAssertBasis
}>

export type MuseCronAssertFailure = Readonly<{
  ok: false
  reason: string
  sessionId: string
  sessionDir?: string
  cronDbPath?: string
  jobCount?: number
  schemaVersion?: string | null
  permanentJobCount?: number
  activeJobCount?: number
}>

export type MuseCronAssertResult = MuseCronAssertOk | MuseCronAssertFailure

export interface MuseSqliteReader {
  /**
   * Open `dbPath` read-only and return the first column of the first row for
   * `sql`, or `null` when no row matches. Implementations must not mutate the DB.
   */
  queryScalar(dbPath: string, sql: string, params?: readonly unknown[]): string | null
}

export interface AssertMuseCronJobsEmptyInput {
  /** `$XDG_DATA_HOME/muse` (or equivalent Muse data home inside the lease). */
  readonly museDataHome: string
  readonly sessionId: string
  /** Optional boundary; when set, resolved paths must stay inside it. */
  readonly leaseRoot?: string
  readonly sqlite?: MuseSqliteReader
  /**
   * When true (default), a missing `cron.db` is treated as empty success
   * (Wave-1: some modes may not materialize the file).
   */
  readonly allowMissingCronDb?: boolean
}

function pathIsWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function requireAbsolutePath(path: string, label: string): string {
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw new TypeError(`${label} must be an absolute path.`)
  }
  return resolve(path)
}

function requireSessionId(sessionId: string): string {
  if (
    typeof sessionId !== 'string' ||
    sessionId !== sessionId.trim() ||
    !sessionId ||
    sessionId.includes('\0') ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.length > 256
  ) {
    throw new TypeError('Muse session id is invalid.')
  }
  return sessionId
}

/** Default reader using Node's built-in SQLite (no native addon). */
export function createNodeSqliteReader(): MuseSqliteReader {
  return {
    queryScalar(dbPath: string, sql: string, params: readonly unknown[] = []): string | null {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db.prepare(sql).get(...(params as SQLInputValue[])) as
          | Record<string, unknown>
          | undefined
        if (!row) return null
        const first = Object.values(row)[0]
        if (first == null) return null
        return String(first)
      } finally {
        db.close()
      }
    }
  }
}

export function museSessionIndexDbPath(museDataHome: string): string {
  return join(requireAbsolutePath(museDataHome, 'Muse data home'), MUSE_SESSION_INDEX_DB_BASENAME)
}

/**
 * Resolve `session_id` → session directory via `session-index.db`.
 * Prefers `session_dir`; falls back to the parent of `session_log_path`.
 */
export function lookupMuseSessionDirFromIndex(input: {
  readonly museDataHome: string
  readonly sessionId: string
  readonly leaseRoot?: string
  readonly sqlite?: MuseSqliteReader
}): MuseSessionIndexLookupRow | null {
  const sessionId = requireSessionId(input.sessionId)
  const museDataHome = requireAbsolutePath(input.museDataHome, 'Muse data home')
  const indexPath = museSessionIndexDbPath(museDataHome)
  if (!existsSync(indexPath)) return null

  const sqlite = input.sqlite ?? createNodeSqliteReader()
  const sessionDirRaw = sqlite.queryScalar(
    indexPath,
    'SELECT session_dir FROM sessions WHERE session_id = ?1 LIMIT 1',
    [sessionId]
  )
  const sessionLogPathRaw = sqlite.queryScalar(
    indexPath,
    'SELECT session_log_path FROM sessions WHERE session_id = ?1 LIMIT 1',
    [sessionId]
  )

  let sessionDir: string | null = null
  let sessionLogPath: string | null = null

  if (typeof sessionLogPathRaw === 'string' && sessionLogPathRaw.trim()) {
    sessionLogPath = requireAbsolutePath(sessionLogPathRaw.trim(), 'Muse session_log_path')
    sessionDir = resolve(sessionLogPath, '..')
  }
  if (typeof sessionDirRaw === 'string' && sessionDirRaw.trim()) {
    sessionDir = requireAbsolutePath(sessionDirRaw.trim(), 'Muse session_dir')
    if (!sessionLogPath) {
      sessionLogPath = join(sessionDir, 'session.jsonl')
    }
  }

  if (!sessionDir || !sessionLogPath) return null

  if (input.leaseRoot) {
    const leaseRoot = requireAbsolutePath(input.leaseRoot, 'Muse lease root')
    if (!pathIsWithin(leaseRoot, sessionDir) || !pathIsWithin(leaseRoot, sessionLogPath)) {
      throw new Error('Muse session index path escaped the isolated-home lease.')
    }
  }

  return Object.freeze({
    sessionId,
    sessionDir,
    sessionLogPath
  })
}

export function museCronDbPathForSessionDir(sessionDir: string): string {
  return join(requireAbsolutePath(sessionDir, 'Muse session dir'), MUSE_CRON_DB_BASENAME)
}

const MUSE_CRON_SCAN_MAX_DEPTH = 12
const MUSE_CRON_SCAN_MAX_ENTRIES = 20_000

/**
 * Bounded lease-local search for `cron.db` files under the Muse data home.
 * Never follows symlinks, so a hostile session cannot point the scan outside
 * the lease. A missing/unreadable directory yields an empty list — the seat
 * simply has no cron artifacts.
 */
export function scanMuseDataHomeForCronDbs(museDataHome: string): string[] {
  const root = requireAbsolutePath(museDataHome, 'Muse data home')
  const found: string[] = []
  let visited = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > MUSE_CRON_SCAN_MAX_DEPTH) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      visited += 1
      if (visited > MUSE_CRON_SCAN_MAX_ENTRIES) return
      if (entry.isSymbolicLink()) continue
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(child, depth + 1)
      } else if (entry.isFile() && entry.name === MUSE_CRON_DB_BASENAME) {
        found.push(child)
      }
    }
  }
  walk(root, 0)
  return found.sort()
}

interface MuseCronDbCounts {
  readonly schemaVersion: string | null
  readonly jobCount: number
  readonly permanentJobCount: number
  readonly activeJobCount: number
}

/** Read the schema version and job counts from one cron.db (throws on error). */
function readMuseCronDbCounts(sqlite: MuseSqliteReader, cronDbPath: string): MuseCronDbCounts {
  const schemaVersion = sqlite.queryScalar(
    cronDbPath,
    "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1"
  )
  const countRaw = sqlite.queryScalar(cronDbPath, 'SELECT COUNT(*) FROM cron_jobs')
  const permanentRaw = sqlite.queryScalar(
    cronDbPath,
    'SELECT COUNT(*) FROM cron_jobs WHERE permanent != 0'
  )
  const activeRaw = sqlite.queryScalar(
    cronDbPath,
    "SELECT COUNT(*) FROM cron_jobs WHERE status = 'active'"
  )
  return {
    schemaVersion,
    jobCount: Number(countRaw ?? '0'),
    permanentJobCount: Number(permanentRaw ?? '0'),
    activeJobCount: Number(activeRaw ?? '0')
  }
}

/**
 * Assert the session's `cron.db` has zero `cron_jobs` rows.
 * Lookup is always session-index → session dir → `cron.db`.
 */
export function assertMuseCronJobsEmpty(input: AssertMuseCronJobsEmptyInput): MuseCronAssertResult {
  const sessionId = requireSessionId(input.sessionId)
  const museDataHome = requireAbsolutePath(input.museDataHome, 'Muse data home')
  const sqlite = input.sqlite ?? createNodeSqliteReader()
  const allowMissingCronDb = input.allowMissingCronDb !== false

  let lookup: MuseSessionIndexLookupRow | null
  try {
    lookup = lookupMuseSessionDirFromIndex({
      museDataHome,
      sessionId,
      leaseRoot: input.leaseRoot,
      sqlite
    })
  } catch (error) {
    return {
      ok: false,
      reason: `Muse cron assert refused session-index lookup: ${
        error instanceof Error ? error.message : String(error)
      }`,
      sessionId
    }
  }

  if (!lookup) {
    // The CLI writes the session-index row asynchronously, and a run that
    // failed before its first turn (missing credentials, refused argv, crash
    // on startup) never creates one at all. A missing row is therefore not
    // evidence of a containment breach — but it also must not blind the
    // assert, so degrade to a bounded lease-local scan for cron.db artifacts
    // and judge those directly.
    return assertCronArtifactsFromLeaseScan({
      museDataHome,
      sessionId,
      leaseRoot: input.leaseRoot,
      sqlite
    })
  }

  const cronDbPath = museCronDbPathForSessionDir(lookup.sessionDir)
  if (input.leaseRoot) {
    const leaseRoot = requireAbsolutePath(input.leaseRoot, 'Muse lease root')
    if (!pathIsWithin(leaseRoot, cronDbPath)) {
      return {
        ok: false,
        reason: 'Muse cron.db path escaped the isolated-home lease.',
        sessionId,
        sessionDir: lookup.sessionDir,
        cronDbPath
      }
    }
  }

  if (!existsSync(cronDbPath)) {
    if (allowMissingCronDb) {
      return {
        ok: true,
        sessionId,
        sessionDir: lookup.sessionDir,
        cronDbPath,
        jobCount: 0,
        schemaVersion: null,
        basis: 'session-index'
      }
    }
    return {
      ok: false,
      reason: 'Muse session cron.db is missing.',
      sessionId,
      sessionDir: lookup.sessionDir,
      cronDbPath
    }
  }

  let schemaVersion: string | null = null
  let jobCount: number
  let permanentJobCount: number
  let activeJobCount: number
  try {
    ;({ schemaVersion, jobCount, permanentJobCount, activeJobCount } = readMuseCronDbCounts(
      sqlite,
      cronDbPath
    ))
  } catch (error) {
    return {
      ok: false,
      reason: `Muse cron.db could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      sessionId,
      sessionDir: lookup.sessionDir,
      cronDbPath
    }
  }

  if (!Number.isFinite(jobCount) || jobCount < 0) {
    return {
      ok: false,
      reason: 'Muse cron_jobs COUNT(*) was not a finite non-negative integer.',
      sessionId,
      sessionDir: lookup.sessionDir,
      cronDbPath,
      schemaVersion,
      jobCount
    }
  }

  if (schemaVersion != null && schemaVersion !== MUSE_EXPECTED_CRON_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `Muse cron schema_version is ${JSON.stringify(schemaVersion)}; expected ${JSON.stringify(
        MUSE_EXPECTED_CRON_SCHEMA_VERSION
      )}.`,
      sessionId,
      sessionDir: lookup.sessionDir,
      cronDbPath,
      schemaVersion,
      jobCount,
      permanentJobCount,
      activeJobCount
    }
  }

  if (jobCount !== 0 || permanentJobCount !== 0 || activeJobCount !== 0) {
    return {
      ok: false,
      reason: 'Muse containment breach: cron_jobs is not empty at seat teardown.',
      sessionId,
      sessionDir: lookup.sessionDir,
      cronDbPath,
      schemaVersion,
      jobCount,
      permanentJobCount,
      activeJobCount
    }
  }

  return {
    ok: true,
    sessionId,
    sessionDir: lookup.sessionDir,
    cronDbPath,
    jobCount: 0,
    schemaVersion,
    basis: 'session-index'
  }
}

/**
 * Missing session-index row fallback: judge cron emptiness from the lease's
 * actual cron.db artifacts. No artifacts → vacuously empty (a run that never
 * started cannot have scheduled crons). Any artifact found is inspected with
 * the same schema and emptiness rules as the indexed path, so real leftovers
 * still fail closed.
 */
function assertCronArtifactsFromLeaseScan(input: {
  readonly museDataHome: string
  readonly sessionId: string
  readonly leaseRoot?: string
  readonly sqlite: MuseSqliteReader
}): MuseCronAssertResult {
  const { museDataHome, sessionId, sqlite } = input

  let scanned: string[]
  try {
    scanned = scanMuseDataHomeForCronDbs(museDataHome)
  } catch (error) {
    return {
      ok: false,
      reason: `Muse cron assert could not scan the lease data home for cron.db artifacts: ${
        error instanceof Error ? error.message : String(error)
      }`,
      sessionId
    }
  }

  if (input.leaseRoot) {
    const leaseRoot = requireAbsolutePath(input.leaseRoot, 'Muse lease root')
    for (const cronDbPath of scanned) {
      if (!pathIsWithin(leaseRoot, cronDbPath)) {
        return {
          ok: false,
          reason: 'Muse cron.db path escaped the isolated-home lease.',
          sessionId,
          cronDbPath
        }
      }
    }
  }

  if (scanned.length === 0) {
    return {
      ok: true,
      sessionId,
      sessionDir: null,
      cronDbPath: null,
      jobCount: 0,
      schemaVersion: null,
      basis: 'no-session-cron-artifacts'
    }
  }

  let firstSchemaVersion: string | null = null
  for (const cronDbPath of scanned) {
    let counts: MuseCronDbCounts
    try {
      counts = readMuseCronDbCounts(sqlite, cronDbPath)
    } catch (error) {
      return {
        ok: false,
        reason: `Muse cron.db could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        sessionId,
        cronDbPath
      }
    }
    if (!Number.isFinite(counts.jobCount) || counts.jobCount < 0) {
      return {
        ok: false,
        reason: 'Muse cron_jobs COUNT(*) was not a finite non-negative integer.',
        sessionId,
        cronDbPath,
        schemaVersion: counts.schemaVersion,
        jobCount: counts.jobCount
      }
    }
    if (
      counts.schemaVersion != null &&
      counts.schemaVersion !== MUSE_EXPECTED_CRON_SCHEMA_VERSION
    ) {
      return {
        ok: false,
        reason: `Muse cron schema_version is ${JSON.stringify(
          counts.schemaVersion
        )}; expected ${JSON.stringify(MUSE_EXPECTED_CRON_SCHEMA_VERSION)}.`,
        sessionId,
        cronDbPath,
        schemaVersion: counts.schemaVersion,
        jobCount: counts.jobCount,
        permanentJobCount: counts.permanentJobCount,
        activeJobCount: counts.activeJobCount
      }
    }
    if (counts.jobCount !== 0 || counts.permanentJobCount !== 0 || counts.activeJobCount !== 0) {
      return {
        ok: false,
        reason:
          'Muse containment breach: an unindexed session cron.db is not empty at seat teardown.',
        sessionId,
        cronDbPath,
        schemaVersion: counts.schemaVersion,
        jobCount: counts.jobCount,
        permanentJobCount: counts.permanentJobCount,
        activeJobCount: counts.activeJobCount
      }
    }
    if (firstSchemaVersion == null) firstSchemaVersion = counts.schemaVersion
  }

  return {
    ok: true,
    sessionId,
    sessionDir: null,
    cronDbPath: scanned[0],
    jobCount: 0,
    schemaVersion: firstSchemaVersion,
    basis: 'lease-scan'
  }
}
