import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMuseSessionLogTailer,
  findMuseSessionLogByFsFallback,
  museSessionIndexDbPath,
  parseMuseSessionLogLine,
  readMuseSessionLogTerminal,
  resolveMuseSessionLogOnce,
  resolveMuseSessionLogPath,
  type MuseSessionLogTailOptions
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

function writeIndexDb(dataHome: string): string {
  const museRoot = join(dataHome, 'muse')
  mkdirSync(museRoot, { recursive: true })
  const dbPath = museSessionIndexDbPath(dataHome)
  writeFileSync(dbPath, '')
  return dbPath
}

function queryIndexRow(row: {
  sessionLogPath: string
  sessionDir: string
  modelId?: string
}): () => Promise<string> {
  return async () =>
    [row.sessionLogPath, row.sessionDir, row.modelId || 'muse-spark-1.2', 'valid', '0'].join('|')
}

describe('resolveMuseSessionLogPath', () => {
  it('resolves session_log_path from session-index.db', async () => {
    const dataHome = tempDir()
    const sessionId = '0c960794-f785-4827-a059-5e7425637cc8'
    const sessionDir = join(dataHome, 'muse', 'sessions', '2026', '08', '10', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'session.jsonl')
    writeFileSync(logPath, '')
    const row = { sessionId, sessionLogPath: logPath, sessionDir }
    writeIndexDb(dataHome)

    const result = await resolveMuseSessionLogOnce({
      dataHome,
      sessionId,
      querySqlite: queryIndexRow(row)
    })
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
        writeIndexDb(dataHome)
      }
    }

    const result = await resolveMuseSessionLogPath({
      dataHome,
      sessionId,
      querySqlite: queryIndexRow({ sessionLogPath: logPath, sessionDir }),
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

  it('joins overlapping polls and queues a final read after the active cursor update', async () => {
    const line = `${envelopeLine(7, 'single delivery')}\n`
    const data = Buffer.from(line)
    let releaseFirstStat = (): void => {}
    const firstStatGate = new Promise<void>((resolve) => {
      releaseFirstStat = resolve
    })
    const stat = vi.fn(async () => {
      if (stat.mock.calls.length === 1) await firstStatGate
      return { size: data.length }
    })
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = data.copy(buffer, offset, position, position + length)
      return { bytesRead, buffer }
    })
    const close = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ read, close }))
    const fileSystem = { stat, open } as unknown as NonNullable<
      MuseSessionLogTailOptions['fileSystem']
    >
    const seen: number[] = []
    const tailer = createMuseSessionLogTailer({
      sessionLogPath: '/virtual/session.jsonl',
      fileSystem,
      onEnvelope: (env) => seen.push(env.sequence)
    })

    const pollPromise = tailer.poll()
    const joinedPollPromise = tailer.poll()
    const flushPromise = tailer.flushFinal()
    expect(stat).toHaveBeenCalledOnce()
    expect(joinedPollPromise).toBe(pollPromise)
    releaseFirstStat()

    expect(await pollPromise).toBe(1)
    expect(await flushPromise).toBe(0)
    expect(stat).toHaveBeenCalledTimes(2)
    expect(open).toHaveBeenCalledOnce()
    expect(read).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(seen).toEqual([7])
    expect(tailer.byteOffset).toBe(data.length)
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

describe('readMuseSessionLogTerminal', () => {
  /** `recorded_at` is MICROSECONDS on the durable record. */
  function terminalLine(options: {
    terminal?: string
    reason?: string
    atMs: number
    sequence: number
    payloadType?: string
    payload?: Record<string, unknown>
  }): string {
    return `${JSON.stringify({
      schema_version: 1,
      id: `env-${options.sequence}`,
      stream: { kind: 'session', id: 'sess-1' },
      sequence: options.sequence,
      recorded_at: options.atMs * 1_000,
      record_type: 'event',
      payload_type: options.payloadType ?? 'run.terminal.completed',
      payload: options.payload ?? {
        ...(options.terminal ? { terminal: options.terminal } : {}),
        ...(options.reason ? { reason: options.reason } : {})
      }
    })}\n`
  }

  function logFile(body: string): string {
    const dir = tempDir()
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, body)
    return path
  }

  it('adopts the terminal Muse recorded for this run', async () => {
    const path = logFile(
      terminalLine({ terminal: 'failed', reason: 'run config error', atMs: 2_000, sequence: 9 })
    )
    const found = await readMuseSessionLogTerminal({ sessionLogPath: path, notBeforeMs: 1_000 })
    expect(found?.terminal).toBe('failed')
    expect(found?.reason).toBe('run config error')
  })

  it('reads the nested terminal_state spelling too', async () => {
    const path = logFile(
      terminalLine({
        atMs: 2_000,
        sequence: 3,
        payload: { terminal_state: { terminal: 'cancelled' }, reason: 'stopped' }
      })
    )
    const found = await readMuseSessionLogTerminal({ sessionLogPath: path, notBeforeMs: 1_000 })
    expect(found?.terminal).toBe('cancelled')
  })

  it('NEVER adopts a prior turn terminal from a resumed session log', async () => {
    // The decisive guard: a resumed session's log still carries turn 1's
    // `completed`. Reporting that for a turn that wedged is worse than
    // reporting nothing — it claims success for work that never ran.
    const path = logFile(
      terminalLine({ terminal: 'completed', reason: 'turn one', atMs: 500, sequence: 1 })
    )
    expect(
      await readMuseSessionLogTerminal({ sessionLogPath: path, notBeforeMs: 1_000 })
    ).toBeNull()
  })

  it('takes the LAST in-window terminal, not the first', async () => {
    const path = logFile(
      terminalLine({ terminal: 'completed', reason: 'old', atMs: 500, sequence: 1 }) +
        terminalLine({ terminal: 'completed', reason: 'earlier', atMs: 1_500, sequence: 4 }) +
        terminalLine({ terminal: 'failed', reason: 'latest', atMs: 2_500, sequence: 7 })
    )
    const found = await readMuseSessionLogTerminal({ sessionLogPath: path, notBeforeMs: 1_000 })
    expect(found?.terminal).toBe('failed')
    expect(found?.reason).toBe('latest')
  })

  it('ignores non-terminal records, torn lines and a missing file', async () => {
    const path = logFile(
      '{"not":"an envelope"}\n' +
        terminalLine({
          terminal: 'failed',
          atMs: 2_000,
          sequence: 2,
          payloadType: 'run.output.delta'
        }) +
        '{"schema_version":1,"id":"torn"'
    )
    expect(
      await readMuseSessionLogTerminal({ sessionLogPath: path, notBeforeMs: 1_000 })
    ).toBeNull()
    expect(
      await readMuseSessionLogTerminal({
        sessionLogPath: join(tempDir(), 'absent.jsonl'),
        notBeforeMs: 0
      })
    ).toBeNull()
  })
})
