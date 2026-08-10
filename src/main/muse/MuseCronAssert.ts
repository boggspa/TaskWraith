import { existsSync } from 'node:fs'
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

export type MuseCronAssertOk = Readonly<{
  ok: true
  sessionId: string
  sessionDir: string
  cronDbPath: string
  jobCount: 0
  schemaVersion: string | null
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
    return {
      ok: false,
      reason: 'Muse session-index has no row for the seat session; cannot assert cron emptiness.',
      sessionId
    }
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
        schemaVersion: null
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
    schemaVersion = sqlite.queryScalar(
      cronDbPath,
      "SELECT value FROM schema_meta WHERE key = 'schema_version' LIMIT 1"
    )
    const countRaw = sqlite.queryScalar(cronDbPath, 'SELECT COUNT(*) FROM cron_jobs')
    jobCount = Number(countRaw ?? '0')
    const permanentRaw = sqlite.queryScalar(
      cronDbPath,
      'SELECT COUNT(*) FROM cron_jobs WHERE permanent != 0'
    )
    permanentJobCount = Number(permanentRaw ?? '0')
    const activeRaw = sqlite.queryScalar(
      cronDbPath,
      "SELECT COUNT(*) FROM cron_jobs WHERE status = 'active'"
    )
    activeJobCount = Number(activeRaw ?? '0')
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
    schemaVersion
  }
}
