import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMuseSessionLogTailer,
  findMuseSessionLogByFsFallback,
  museSessionIndexDbPath,
  parseMuseSessionLogLine,
  resolveMuseSessionLogOnce,
  resolveMuseSessionLogPath
} from './MuseSessionLog'

const temps: string[] = []

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muse-session-log-'))
  temps.push(dir)
  return dir
}

function writeIndexDb(
  dataHome: string,
  row: {
    sessionId: string
    sessionLogPath: string
    sessionDir: string
    modelId?: string
  }
): string {
  const museRoot = join(dataHome, 'muse')
  mkdirSync(museRoot, { recursive: true })
  const dbPath = museSessionIndexDbPath(dataHome)
  const sql = `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  session_stream_id TEXT,
  session_dir TEXT,
  session_log_path TEXT UNIQUE,
  layout TEXT,
  model_id TEXT,
  status TEXT,
  latest_segment_terminated INTEGER
);
INSERT INTO sessions (
  session_id, session_stream_id, session_dir, session_log_path, layout, model_id, status, latest_segment_terminated
) VALUES (
  '${row.sessionId}', '${row.sessionId}', '${row.sessionDir}', '${row.sessionLogPath}',
  'session_jsonl', '${row.modelId || 'muse-spark-1.2'}', 'valid', 0
);
`
  execFileSync('/usr/bin/sqlite3', [dbPath], { input: sql })
  return dbPath
}

describe('resolveMuseSessionLogPath', () => {
  it('resolves session_log_path from session-index.db', async () => {
    const dataHome = tempDir()
    const sessionId = '0c960794-f785-4827-a059-5e7425637cc8'
    const sessionDir = join(dataHome, 'muse', 'sessions', '2026', '08', '10', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'session.jsonl')
    writeFileSync(logPath, '')
    writeIndexDb(dataHome, { sessionId, sessionLogPath: logPath, sessionDir })

    const result = await resolveMuseSessionLogOnce({ dataHome, sessionId })
    expect(result.source).toBe('session-index')
    expect(result.sessionLogPath).toBe(logPath)
    expect(result.row?.model_id).toBe('muse-spark-1.2')
  })

  it('falls back to filesystem search when the index row is missing', async () => {
    const dataHome = tempDir()
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sessionDir = join(dataHome, 'muse', 'sessions', '2099', '01', '02', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'session.jsonl')
    writeFileSync(logPath, '{"schema_version":1}\n')

    const found = await findMuseSessionLogByFsFallback(dataHome, sessionId)
    expect(found).toBe(logPath)

    const result = await resolveMuseSessionLogOnce({ dataHome, sessionId })
    expect(result.source).toBe('fs-fallback')
    expect(result.sessionLogPath).toBe(logPath)
  })

  it('polls until the index row appears', async () => {
    const dataHome = tempDir()
    const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    // Keep the log outside sessions/ so fs-fallback cannot win before the index.
    const sessionDir = join(dataHome, 'muse', 'indexed-only', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'session.jsonl')
    writeFileSync(logPath, '')

    let ticks = 0
    const sleep = async () => {
      ticks += 1
      if (ticks === 2) {
        writeIndexDb(dataHome, { sessionId, sessionLogPath: logPath, sessionDir })
      }
    }

    const result = await resolveMuseSessionLogPath({
      dataHome,
      sessionId,
      timeoutMs: 5_000,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      sleep
    })
    expect(result.source).toBe('session-index')
    expect(result.sessionLogPath).toBe(logPath)
    expect(ticks).toBeGreaterThanOrEqual(2)
  })
})

describe('createMuseSessionLogTailer', () => {
  const envelopeLine = (sequence: number, text: string): string =>
    JSON.stringify({
      schema_version: 1,
      id: `id-${sequence}`,
      stream: { kind: 'session', id: 'sess-1' },
      sequence,
      recorded_at: 1780531400000000 + sequence,
      record_type: 'event',
      durability: 'durable',
      payload_type: 'runtime.session',
      payload_schema_version: 1,
      payload: {
        kind: 'run',
        run_id: 'run-1',
        event: { kind: 'assistant_message_committed', text }
      }
    })

  it('holds a torn trailing line until newline arrives', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, '')
    const seen: string[] = []
    const tailer = createMuseSessionLogTailer({
      sessionLogPath: path,
      onEnvelope: (env) => seen.push(String(env.sequence))
    })

    const partial = envelopeLine(1, 'hello').slice(0, 40)
    writeFileSync(path, partial)
    expect(await tailer.poll()).toBe(0)
    expect(seen).toEqual([])
    expect(tailer.pending.length).toBeGreaterThan(0)

    appendFileSync(path, envelopeLine(1, 'hello').slice(40) + '\n')
    expect(await tailer.poll()).toBe(1)
    expect(seen).toEqual(['1'])
    await tailer.close()
  })

  it('advances the byte offset across appends and resets on truncate', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, `${envelopeLine(1, 'a')}\n`)
    const seen: number[] = []
    let truncated = 0
    const tailer = createMuseSessionLogTailer({
      sessionLogPath: path,
      onEnvelope: (env) => seen.push(env.sequence),
      onTruncate: () => {
        truncated += 1
      }
    })

    expect(await tailer.poll()).toBe(1)
    appendFileSync(path, `${envelopeLine(2, 'b')}\n`)
    expect(await tailer.poll()).toBe(1)
    expect(seen).toEqual([1, 2])

    writeFileSync(path, `${envelopeLine(9, 'reset')}\n`)
    expect(await tailer.poll()).toBe(1)
    expect(truncated).toBe(1)
    expect(seen).toEqual([1, 2, 9])
    await tailer.close()
  })

  it('skips malformed complete lines without aborting', async () => {
    const dir = tempDir()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, `{not-json}\n${envelopeLine(3, 'ok')}\n`)
    const seen: number[] = []
    const tailer = createMuseSessionLogTailer({
      sessionLogPath: path,
      onEnvelope: (env) => seen.push(env.sequence)
    })
    await tailer.flushFinal()
    expect(tailer.parseErrorCount).toBe(1)
    expect(seen).toEqual([3])
    await tailer.close()
  })
})

describe('parseMuseSessionLogLine', () => {
  it('parses a valid envelope and returns null on garbage', () => {
    const line = JSON.stringify({
      schema_version: 1,
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      stream: { kind: 'session', id: 's' },
      sequence: 1,
      recorded_at: 1,
      record_type: 'event',
      payload_type: 'runtime.session',
      payload: { kind: 'run', event: { kind: 'x' } }
    })
    expect(parseMuseSessionLogLine(line)?.payload_type).toBe('runtime.session')
    expect(parseMuseSessionLogLine('{bad')).toBeNull()
    expect(parseMuseSessionLogLine('')).toBeNull()
  })
})
