import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MUSE_EXPECTED_CRON_SCHEMA_VERSION,
  assertMuseCronJobsEmpty,
  createNodeSqliteReader,
  lookupMuseSessionDirFromIndex,
  museCronDbPathForSessionDir,
  museSessionIndexDbPath
} from './MuseCronAssert'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'taskwraith-muse-cron-assert-test-'))

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

function seedSessionIndex(input: {
  museDataHome: string
  sessionId: string
  sessionDir: string
  sessionLogPath: string
}): void {
  mkdirSync(input.museDataHome, { recursive: true, mode: 0o700 })
  const dbPath = museSessionIndexDbPath(input.museDataHome)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1');
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        session_dir TEXT,
        session_log_path TEXT UNIQUE
      );
    `)
    db.prepare(
      'INSERT INTO sessions(session_id, session_dir, session_log_path) VALUES (?1, ?2, ?3)'
    ).run(input.sessionId, input.sessionDir, input.sessionLogPath)
  } finally {
    db.close()
  }
}

function seedCronDb(
  sessionDir: string,
  options: { jobs?: number; schemaVersion?: string; permanent?: boolean } = {}
): string {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  const cronDbPath = museCronDbPathForSessionDir(sessionDir)
  const db = new DatabaseSync(cronDbPath)
  try {
    db.exec(`
      CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE cron_jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        cron_expr TEXT,
        prompt TEXT,
        permanent INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
    `)
    db.prepare('INSERT INTO schema_meta(key, value) VALUES (?1, ?2)').run(
      'schema_version',
      options.schemaVersion ?? MUSE_EXPECTED_CRON_SCHEMA_VERSION
    )
    const jobs = options.jobs ?? 0
    for (let i = 0; i < jobs; i += 1) {
      db.prepare(
        'INSERT INTO cron_jobs(id, session_id, cron_expr, prompt, permanent, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).run(`job-${i}`, 'session', '*/5 * * * *', 'ping', options.permanent ? 1 : 0, 'active')
    }
  } finally {
    db.close()
  }
  return cronDbPath
}

describe('MuseCronAssert', () => {
  it('resolves the session dir from session-index and accepts an empty cron_jobs table', () => {
    const root = join(TEMP_ROOT, 'empty-ok')
    const museDataHome = join(root, 'xdg-data', 'muse')
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const sessionDir = join(museDataHome, 'sessions', '2026', '08', '10', sessionId)
    const sessionLogPath = join(sessionDir, 'session.jsonl')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(sessionLogPath, '')
    seedSessionIndex({ museDataHome, sessionId, sessionDir, sessionLogPath })
    seedCronDb(sessionDir, { jobs: 0 })

    const lookup = lookupMuseSessionDirFromIndex({
      museDataHome,
      sessionId,
      leaseRoot: root,
      sqlite: createNodeSqliteReader()
    })
    expect(lookup).toEqual({
      sessionId,
      sessionDir,
      sessionLogPath
    })

    const result = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId,
      leaseRoot: root
    })
    expect(result).toMatchObject({
      ok: true,
      sessionId,
      sessionDir,
      jobCount: 0,
      schemaVersion: '1'
    })
  })

  it('treats a missing cron.db as empty when allowed', () => {
    const root = join(TEMP_ROOT, 'missing-cron')
    const museDataHome = join(root, 'xdg-data', 'muse')
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const sessionDir = join(museDataHome, 'sessions', 'nested', sessionId)
    const sessionLogPath = join(sessionDir, 'session.jsonl')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(sessionLogPath, '')
    seedSessionIndex({ museDataHome, sessionId, sessionDir, sessionLogPath })

    const result = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId,
      leaseRoot: root,
      allowMissingCronDb: true
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.jobCount).toBe(0)
      expect(result.schemaVersion).toBeNull()
    }
  })

  it('fails closed when cron_jobs has rows', () => {
    const root = join(TEMP_ROOT, 'non-empty')
    const museDataHome = join(root, 'xdg-data', 'muse')
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const sessionDir = join(museDataHome, 'sessions', sessionId)
    const sessionLogPath = join(sessionDir, 'session.jsonl')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(sessionLogPath, '')
    seedSessionIndex({ museDataHome, sessionId, sessionDir, sessionLogPath })
    seedCronDb(sessionDir, { jobs: 2 })

    const result = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId,
      leaseRoot: root
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/containment breach|not empty/i)
      expect(result.jobCount).toBe(2)
      expect(result.activeJobCount).toBe(2)
    }
  })

  it('treats a missing session-index row with no cron artifacts as vacuously empty', () => {
    // The CLI indexes sessions asynchronously, and a run that failed before
    // its first turn (e.g. missing credentials) never creates a row at all.
    // That must not fabricate a hard "cannot assert" failure onto a run
    // result that already failed for its real reason.
    const root = join(TEMP_ROOT, 'missing-index-row')
    const museDataHome = join(root, 'xdg-data', 'muse')
    mkdirSync(museDataHome, { recursive: true })
    const db = new DatabaseSync(museSessionIndexDbPath(museDataHome))
    try {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          session_dir TEXT,
          session_log_path TEXT UNIQUE
        );
      `)
    } finally {
      db.close()
    }

    const missing = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId: '44444444-4444-4444-8444-444444444444',
      leaseRoot: root
    })
    expect(missing).toMatchObject({
      ok: true,
      sessionDir: null,
      cronDbPath: null,
      jobCount: 0,
      basis: 'no-session-cron-artifacts'
    })
  })

  it('treats an entirely missing session-index with no cron artifacts as vacuously empty', () => {
    const root = join(TEMP_ROOT, 'missing-index-db')
    const museDataHome = join(root, 'xdg-data', 'muse')
    mkdirSync(museDataHome, { recursive: true })

    const result = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId: '77777777-7777-4777-8777-777777777777',
      leaseRoot: root
    })
    expect(result).toMatchObject({
      ok: true,
      jobCount: 0,
      basis: 'no-session-cron-artifacts'
    })
  })

  it('still fails closed on an unindexed cron.db that has jobs', () => {
    // Protection preserved: no session-index row, but a real cron.db with
    // rows exists inside the lease data home — that is a containment breach,
    // not an indexing hiccup.
    const root = join(TEMP_ROOT, 'unindexed-breach')
    const museDataHome = join(root, 'xdg-data', 'muse')
    mkdirSync(museDataHome, { recursive: true })
    const sessionDir = join(museDataHome, 'sessions', '2026', '09', '01', 'unindexed')
    seedCronDb(sessionDir, { jobs: 1 })

    const result = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId: '88888888-8888-4888-8888-888888888888',
      leaseRoot: root
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/containment breach.*unindexed/i)
      expect(result.jobCount).toBe(1)
      expect(result.cronDbPath).toBe(museCronDbPathForSessionDir(sessionDir))
    }
  })

  it('accepts an unindexed cron.db whose cron_jobs table is empty via the lease scan', () => {
    const root = join(TEMP_ROOT, 'unindexed-empty')
    const museDataHome = join(root, 'xdg-data', 'muse')
    mkdirSync(museDataHome, { recursive: true })
    const sessionDir = join(museDataHome, 'sessions', '2026', '09', '01', 'unindexed-empty')
    seedCronDb(sessionDir, { jobs: 0 })

    const result = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId: '99999999-9999-4999-8999-999999999999',
      leaseRoot: root
    })
    expect(result).toMatchObject({
      ok: true,
      jobCount: 0,
      cronDbPath: museCronDbPathForSessionDir(sessionDir),
      basis: 'lease-scan'
    })
  })

  it('refuses lease escapes from the session index', () => {
    const escapeRoot = join(TEMP_ROOT, 'escape')
    const escapeData = join(escapeRoot, 'xdg-data', 'muse')
    const outsideDir = join(TEMP_ROOT, 'outside-session')
    const outsideLog = join(outsideDir, 'session.jsonl')
    mkdirSync(outsideDir, { recursive: true })
    writeFileSync(outsideLog, '')
    seedSessionIndex({
      museDataHome: escapeData,
      sessionId: '55555555-5555-4555-8555-555555555555',
      sessionDir: outsideDir,
      sessionLogPath: outsideLog
    })
    expect(() =>
      lookupMuseSessionDirFromIndex({
        museDataHome: escapeData,
        sessionId: '55555555-5555-4555-8555-555555555555',
        leaseRoot: escapeRoot
      })
    ).toThrow(/escaped the isolated-home lease/i)
  })

  it('falls back to session_log_path parent when session_dir is null', () => {
    const root = join(TEMP_ROOT, 'log-path-only')
    const museDataHome = join(root, 'xdg-data', 'muse')
    const sessionId = '66666666-6666-4666-8666-666666666666'
    const sessionDir = join(museDataHome, 'sessions', sessionId)
    const sessionLogPath = join(sessionDir, 'session.jsonl')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(sessionLogPath, '')
    mkdirSync(museDataHome, { recursive: true })
    const db = new DatabaseSync(museSessionIndexDbPath(museDataHome))
    try {
      db.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          session_dir TEXT,
          session_log_path TEXT UNIQUE
        );
      `)
      db.prepare(
        'INSERT INTO sessions(session_id, session_dir, session_log_path) VALUES (?1, NULL, ?2)'
      ).run(sessionId, sessionLogPath)
    } finally {
      db.close()
    }
    seedCronDb(sessionDir, { jobs: 0 })

    const result = assertMuseCronJobsEmpty({
      museDataHome,
      sessionId,
      leaseRoot: root
    })
    expect(result).toMatchObject({
      ok: true,
      sessionDir,
      jobCount: 0
    })
  })
})
