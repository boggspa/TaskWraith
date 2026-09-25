import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, open, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST_TRANSACTION_LOG_FILENAME,
  HostTransactionLog,
  type HostTransactionLogAppendResult,
  type HostTransactionLogOptions
} from './HostTransactionLog'
import type {
  HostTransactionPrepareRecord,
  HostTransactionRecoveryInput,
  HostTransactionTerminalRecord
} from './HostTransactionManifest'

// M4 slice 8 (design §16): the write-ahead transaction manifest log. One
// JSONL file, async I/O through the `write`/`fsync`/`rename` seams, group
// commit per event-loop turn, durable-only visibility, fail-stop on a failed
// batch, and compaction through the same queue. Slice 6 validates every
// record and decides compaction; nothing in production reads this log until
// slice 12.

const paths: string[] = []
function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-transaction-log-'))
  paths.push(value)
  return value
}
afterEach(() => {
  for (const value of paths.splice(0)) rmSync(value, { recursive: true, force: true })
})

type Receipt = HostTransactionRecoveryInput['receipt']

const DIGEST = 'a'.repeat(64)
const EPOCH = { hostIncarnation: 'b'.repeat(64), deleteCounter: 0 }
const PRIOR = { dev: '16777232', ino: '1001', size: 4_096 }
const RESULTING = { dev: '16777232', ino: '2002', size: 5_120 }
const END = { generation: 1, cursor: 40 }

/** A prepare in the key order `parseHostTransactionRecord` copies, so a line is byte-predictable. */
function prepare(
  commandId: string,
  overrides: Partial<HostTransactionPrepareRecord> = {}
): HostTransactionPrepareRecord {
  return {
    kind: 'prepare',
    commandId,
    threadId: `chat-${commandId}`,
    epoch: EPOCH,
    expectedRevision: 13,
    resultingRevision: 14,
    prior: PRIOR,
    resulting: RESULTING,
    effects: { count: 3, setDigest: DIGEST },
    preparedAt: 1_000,
    ...overrides
  }
}
function abort(commandId: string, reason = 'interrupted', at = 5): HostTransactionTerminalRecord {
  return { kind: 'abort', commandId, reason, at }
}
function published(commandId: string, position = END, at = 6): HostTransactionTerminalRecord {
  return { kind: 'published', commandId, position, at }
}
function indeterminate(
  commandId: string,
  reason = 'unknown_identity'
): HostTransactionTerminalRecord {
  return { kind: 'indeterminate', commandId, reason, at: 7 }
}
function receipt(status: NonNullable<Receipt>['status']): Receipt {
  return { status, recoveryState: null, commandClass: 'txn-record-persist' }
}
function recoverable(): Receipt {
  return {
    status: 'indeterminate',
    recoveryState: 'recoverable-indeterminate',
    commandClass: 'txn-record-persist'
  }
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 150): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Spins the event loop until `condition` holds; fails loudly instead of hanging. */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

interface Seams {
  options: HostTransactionLogOptions
  writes: Array<{ path: string; data: string }>
  fsyncs: string[]
  renames: Array<{ from: string; to: string }>
  /** Per-call hooks; a hook that rejects fails that I/O. */
  beforeWrite: (path: string, data: string) => Promise<void>
  beforeFsync: (path: string) => Promise<void>
  beforeRename: (from: string, to: string) => Promise<void>
}

/** Real fs behind recording seams, with hooks to hold or fail any call. */
function seams(dataDir: string): Seams {
  const writes: Seams['writes'] = []
  const fsyncs: string[] = []
  const renames: Seams['renames'] = []
  const record: Seams = {
    writes,
    fsyncs,
    renames,
    beforeWrite: async () => {},
    beforeFsync: async () => {},
    beforeRename: async () => {},
    options: {
      dataDir,
      write: async (path, data) => {
        await record.beforeWrite(path, data)
        writes.push({ path, data })
        await appendFile(path, data)
      },
      fsync: async (path) => {
        await record.beforeFsync(path)
        fsyncs.push(path)
        if (statSync(path).isDirectory()) return
        const handle = await open(path, 'r')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      },
      rename: async (from, to) => {
        await record.beforeRename(from, to)
        renames.push({ from, to })
        await rename(from, to)
      }
    }
  }
  return record
}

const logPath = (dataDir: string) => join(dataDir, HOST_TRANSACTION_LOG_FILENAME)
const readLines = (dataDir: string) =>
  readFileSync(logPath(dataDir), 'utf8')
    .split('\n')
    .filter((text) => text.length > 0)
    .map((text) => JSON.parse(text) as unknown)

const DURABLE: HostTransactionLogAppendResult = { kind: 'durable' }

describe('HostTransactionLog group commit', () => {
  it('shares one write and one file fsync across appends made in the same turn, resolving after the fsync', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const fsyncHold = deferred()
    io.beforeFsync = () => fsyncHold.promise
    const log = HostTransactionLog.open(io.options)

    const results = [
      log.append(prepare('cmd-1')),
      log.append(prepare('cmd-2')),
      log.append(prepare('cmd-3')),
      log.append(prepare('cmd-4'))
    ]
    await until(() => io.writes.length === 1, 'the batch write')
    expect(io.writes[0]).toEqual({
      path: logPath(dataDir),
      data:
        line(prepare('cmd-1')) +
        line(prepare('cmd-2')) +
        line(prepare('cmd-3')) +
        line(prepare('cmd-4'))
    })
    // Nothing is durable, or visible, before the fsync completes.
    expect(await settledWithin(Promise.race(results))).toBe('pending')
    expect(log.get('cmd-1')).toBeNull()
    expect(log.commandIds()).toEqual([])
    expect(log.stats()).toEqual({ commands: 0, conflicts: 0, corrupt: 0 })

    fsyncHold.resolve()
    expect(await Promise.all(results)).toEqual([DURABLE, DURABLE, DURABLE, DURABLE])
    expect(io.writes).toHaveLength(1)
    expect(io.fsyncs.filter((path) => path === logPath(dataDir))).toHaveLength(1)
    expect(log.commandIds()).toEqual(['cmd-1', 'cmd-2', 'cmd-3', 'cmd-4'])
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: null })
    expect(log.get('cmd-4')).toEqual({ prepare: prepare('cmd-4'), terminal: null })
    expect(log.stats()).toEqual({ commands: 4, conflicts: 0, corrupt: 0 })
  })

  it('writes appends made in separate turns as separate batches, each with its own fsync', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    expect(await log.append(prepare('cmd-1'))).toEqual(DURABLE)
    expect(await log.append(abort('cmd-1'))).toEqual(DURABLE)
    expect(io.writes.map((write) => write.data)).toEqual([
      line(prepare('cmd-1')),
      line(abort('cmd-1'))
    ])
    expect(io.fsyncs.filter((path) => path === logPath(dataDir))).toHaveLength(2)
    expect(readLines(dataDir)).toEqual([prepare('cmd-1'), abort('cmd-1')])
  })

  it('queues appends made while a batch is in flight into the next batch, after it', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const first = deferred()
    // Hold only the first batch's file fsync; everything after runs freely.
    let held = false
    io.beforeFsync = () => {
      if (held) return Promise.resolve()
      held = true
      return first.promise
    }
    const log = HostTransactionLog.open(io.options)
    const one = log.append(prepare('cmd-1'))
    await until(() => io.writes.length === 1, 'the first write')
    const two = log.append(abort('cmd-1'))
    const three = log.append(prepare('cmd-2'))
    expect(await settledWithin(Promise.race([one, two, three]))).toBe('pending')
    expect(io.writes).toHaveLength(1)

    first.resolve()
    expect(await Promise.all([one, two, three])).toEqual([DURABLE, DURABLE, DURABLE])
    expect(io.writes.map((write) => write.data)).toEqual([
      line(prepare('cmd-1')),
      line(abort('cmd-1')) + line(prepare('cmd-2'))
    ])
    expect(log.commandIds()).toEqual(['cmd-1', 'cmd-2'])
  })

  it('fsyncs the directory only for the write that creates the file', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    expect(existsSync(logPath(dataDir))).toBe(false)

    await log.append(prepare('cmd-1'))
    expect(io.fsyncs).toEqual([logPath(dataDir), dataDir])

    await log.append(abort('cmd-1'))
    await log.append(prepare('cmd-2'))
    expect(io.fsyncs.filter((path) => path === dataDir)).toHaveLength(1)
    expect(io.fsyncs.filter((path) => path === logPath(dataDir))).toHaveLength(3)

    // A reopened log of an existing file never creates it.
    const again = seams(dataDir)
    const reopened = HostTransactionLog.open(again.options)
    await reopened.append(prepare('cmd-3'))
    expect(again.fsyncs).toEqual([logPath(dataDir)])
  })
})

describe('HostTransactionLog rules', () => {
  it('rejects an invalid record before anything is queued, with no write', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    for (const value of [
      null,
      'prepare',
      { kind: 'commit', commandId: 'cmd-1' },
      prepare('cmd-1', { resulting: { ...PRIOR } }),
      { kind: 'abort', commandId: 'cmd-1', reason: '', at: 5 }
    ]) {
      expect(await log.append(value)).toMatchObject({ kind: 'rejected', reason: 'invalid' })
    }
    expect(io.writes).toHaveLength(0)
    expect(existsSync(logPath(dataDir))).toBe(false)
    expect(log.stats()).toEqual({ commands: 0, conflicts: 0, corrupt: 0 })
  })

  it('takes a prepare only where the command has no record, and a terminal only over a prepare', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)

    expect(await log.append(abort('cmd-1'))).toEqual({ kind: 'rejected', reason: 'no_prepare' })
    expect(await log.append(published('cmd-1'))).toEqual({ kind: 'rejected', reason: 'no_prepare' })
    expect(await log.append(indeterminate('cmd-1'))).toEqual({
      kind: 'rejected',
      reason: 'no_prepare'
    })
    expect(await log.append(prepare('cmd-1'))).toEqual(DURABLE)
    // A second prepare, different or not by content, once the first is durable.
    expect(await log.append(prepare('cmd-1', { preparedAt: 2_000 }))).toEqual({
      kind: 'rejected',
      reason: 'already_prepared'
    })
    expect(await log.append(published('cmd-1'))).toEqual(DURABLE)
    for (const terminal of [abort('cmd-1'), indeterminate('cmd-1'), published('cmd-1', END, 9)]) {
      expect(await log.append(terminal)).toEqual({ kind: 'rejected', reason: 'already_terminal' })
    }
    // A prepare after the command ended is still a prepare over an earlier record.
    expect(await log.append(prepare('cmd-1', { preparedAt: 3_000 }))).toEqual({
      kind: 'rejected',
      reason: 'already_prepared'
    })
    expect(io.writes.map((write) => write.data)).toEqual([
      line(prepare('cmd-1')),
      line(published('cmd-1'))
    ])
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: published('cmd-1') })
  })

  it('resolves an exact duplicate of a durable record as duplicate and writes nothing', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    await log.append(prepare('cmd-1'))
    await log.append(abort('cmd-1'))
    expect(await log.append(prepare('cmd-1'))).toEqual({ kind: 'duplicate' })
    expect(await log.append(abort('cmd-1'))).toEqual({ kind: 'duplicate' })
    expect(await log.append({ ...abort('cmd-1'), at: 6 })).toEqual({
      kind: 'rejected',
      reason: 'already_terminal'
    })
    expect(io.writes).toHaveLength(2)
    expect(readLines(dataDir)).toEqual([prepare('cmd-1'), abort('cmd-1')])
  })

  it('applies the rules over records still queued in the same turn, so one batch never writes a conflict', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    // A prepare and its terminal record in one turn: both land in one batch.
    const results = [
      log.append(prepare('cmd-1')),
      log.append(published('cmd-1')),
      // A second prepare, or a second terminal, behind a queued one is not
      // "no earlier record": the queued record is earlier.
      log.append(prepare('cmd-1', { preparedAt: 2_000 })),
      log.append(abort('cmd-1')),
      log.append(prepare('cmd-1')),
      log.append(published('cmd-1')),
      // A terminal whose prepare was never appended at all.
      log.append(abort('cmd-2'))
    ]
    expect(await Promise.all(results)).toEqual([
      DURABLE,
      DURABLE,
      { kind: 'rejected', reason: 'already_prepared' },
      { kind: 'rejected', reason: 'already_terminal' },
      { kind: 'duplicate' },
      { kind: 'duplicate' },
      { kind: 'rejected', reason: 'no_prepare' }
    ])
    expect(io.writes).toHaveLength(1)
    expect(io.writes[0]?.data).toBe(line(prepare('cmd-1')) + line(published('cmd-1')))
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: published('cmd-1') })
    expect(log.get('cmd-2')).toBeNull()
    const reopened = HostTransactionLog.open({ dataDir })
    expect(reopened.stats()).toEqual({ commands: 1, conflicts: 0, corrupt: 0 })
  })
})

describe('HostTransactionLog visibility', () => {
  it('returns records callers cannot mutate into the index', async () => {
    const dataDir = directory()
    const log = HostTransactionLog.open({ dataDir })
    const input = prepare('cmd-1')
    await log.append(input)
    ;(input as { preparedAt: number }).preparedAt = 9_999
    ;(input.effects as { count: number }).count = 99
    expect(log.get('cmd-1')?.prepare).toEqual(prepare('cmd-1'))

    const entry = log.get('cmd-1')
    expect(entry).not.toBeNull()
    if (entry === null || entry.prepare === null) return
    expect(Object.isFrozen(entry.prepare)).toBe(true)
    expect(Object.isFrozen(entry.prepare.effects)).toBe(true)
    // A frozen entry throws on assignment under strict mode; a copy just
    // takes it. Either way the index is untouched.
    try {
      ;(entry as { terminal: unknown }).terminal = abort('cmd-1')
    } catch {
      // frozen
    }
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: null })

    const ids = log.commandIds()
    try {
      ids.push('cmd-9')
    } catch {
      // frozen
    }
    expect(log.commandIds()).toEqual(['cmd-1'])
    expect(log.get('missing')).toBeNull()
  })
})

describe('HostTransactionLog reopen', () => {
  it('round-trips every record kind, in insertion order, as one JSON line per record', async () => {
    const dataDir = directory()
    const log = HostTransactionLog.open({ dataDir })
    const creating = prepare('cmd-4', { prior: null, expectedRevision: 0, resultingRevision: 1 })
    for (const record of [
      prepare('cmd-1'),
      prepare('cmd-2'),
      abort('cmd-1'),
      prepare('cmd-3'),
      published('cmd-2'),
      indeterminate('cmd-3'),
      creating
    ]) {
      expect(await log.append(record)).toEqual(DURABLE)
    }
    expect(readFileSync(logPath(dataDir), 'utf8').endsWith('\n')).toBe(true)
    expect(readLines(dataDir)).toEqual([
      prepare('cmd-1'),
      prepare('cmd-2'),
      abort('cmd-1'),
      prepare('cmd-3'),
      published('cmd-2'),
      indeterminate('cmd-3'),
      creating
    ])

    const reopened = HostTransactionLog.open({ dataDir })
    expect(reopened.commandIds()).toEqual(['cmd-1', 'cmd-2', 'cmd-3', 'cmd-4'])
    expect(reopened.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: abort('cmd-1') })
    expect(reopened.get('cmd-2')).toEqual({
      prepare: prepare('cmd-2'),
      terminal: published('cmd-2')
    })
    expect(reopened.get('cmd-3')).toEqual({
      prepare: prepare('cmd-3'),
      terminal: indeterminate('cmd-3')
    })
    expect(reopened.get('cmd-4')).toEqual({ prepare: creating, terminal: null })
    expect(reopened.stats()).toEqual({ commands: 4, conflicts: 0, corrupt: 0 })
    expect(reopened.getFailure()).toBeNull()
    // The rules hold over what was read back.
    expect(await reopened.append(prepare('cmd-1'))).toEqual({ kind: 'duplicate' })
    expect(await reopened.append(abort('cmd-4'))).toEqual(DURABLE)
  })

  it('opens an absent file as empty, without creating it', () => {
    const dataDir = directory()
    const log = HostTransactionLog.open({ dataDir })
    expect(log.commandIds()).toEqual([])
    expect(log.stats()).toEqual({ commands: 0, conflicts: 0, corrupt: 0 })
    expect(log.getFailure()).toBeNull()
    expect(existsSync(logPath(dataDir))).toBe(false)
  })

  it('repairs a torn tail on open, and the next append starts on its own line', async () => {
    const dataDir = directory()
    const whole = line(prepare('cmd-1')) + line(abort('cmd-1'))
    const torn = JSON.stringify(prepare('cmd-2')).slice(0, 40)
    writeFileSync(logPath(dataDir), whole + torn)

    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(whole)
    expect(log.commandIds()).toEqual(['cmd-1'])
    expect(log.get('cmd-2')).toBeNull()

    expect(await log.append(prepare('cmd-2'))).toEqual(DURABLE)
    expect(io.writes).toEqual([{ path: logPath(dataDir), data: line(prepare('cmd-2')) }])
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(whole + line(prepare('cmd-2')))
    const reopened = HostTransactionLog.open({ dataDir })
    expect(reopened.commandIds()).toEqual(['cmd-1', 'cmd-2'])
    expect(reopened.get('cmd-2')).toEqual({ prepare: prepare('cmd-2'), terminal: null })
  })

  it('treats a last line without its newline as torn even when it parses', async () => {
    const dataDir = directory()
    const whole = line(prepare('cmd-1'))
    writeFileSync(logPath(dataDir), whole + JSON.stringify(abort('cmd-1')))
    const log = HostTransactionLog.open({ dataDir })
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(whole)
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: null })
    expect(await log.append(abort('cmd-1'))).toEqual(DURABLE)
    expect(readLines(dataDir)).toEqual([prepare('cmd-1'), abort('cmd-1')])
  })

  it('skips and counts unparseable or refused interior lines', () => {
    const dataDir = directory()
    writeFileSync(
      logPath(dataDir),
      line(prepare('cmd-1')) +
        'not json at all\n' +
        line({ kind: 'commit', commandId: 'cmd-1' }) +
        line(prepare('cmd-2', { resulting: { ...PRIOR } })) +
        '\n' +
        line([1, 2]) +
        line(abort('cmd-1')) +
        line(prepare('cmd-3'))
    )
    const log = HostTransactionLog.open({ dataDir })
    expect(log.commandIds()).toEqual(['cmd-1', 'cmd-3'])
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: abort('cmd-1') })
    expect(log.get('cmd-2')).toBeNull()
    expect(log.stats().commands).toBe(2)
    expect(log.stats().conflicts).toBe(0)
    expect(log.stats().corrupt).toBeGreaterThanOrEqual(4)
    expect(log.stats().corrupt).toBeLessThanOrEqual(5)
  })

  it('keeps the first record on a conflict, counts it, and does not count a byte-identical terminal', () => {
    const dataDir = directory()
    writeFileSync(
      logPath(dataDir),
      line(prepare('cmd-1')) +
        line(prepare('cmd-1', { preparedAt: 2_000 })) +
        line(published('cmd-1')) +
        line(published('cmd-1')) +
        line(abort('cmd-1')) +
        line(prepare('cmd-2')) +
        line(abort('cmd-2')) +
        line(abort('cmd-2', 'other'))
    )
    const log = HostTransactionLog.open({ dataDir })
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: published('cmd-1') })
    expect(log.get('cmd-2')).toEqual({ prepare: prepare('cmd-2'), terminal: abort('cmd-2') })
    expect(log.stats()).toEqual({ commands: 2, conflicts: 3, corrupt: 0 })
    expect(log.commandIds()).toEqual(['cmd-1', 'cmd-2'])
  })
})

describe('HostTransactionLog failure', () => {
  it('fails every append in a batch whose fsync failed, and fail-stops', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    io.beforeFsync = async () => {
      throw new Error('disk full')
    }
    const log = HostTransactionLog.open(io.options)
    const results = await Promise.all([log.append(prepare('cmd-1')), log.append(prepare('cmd-2'))])
    expect(results).toEqual([
      { kind: 'failed', detail: expect.stringContaining('disk full') },
      { kind: 'failed', detail: expect.stringContaining('disk full') }
    ])
    expect(log.getFailure()).toEqual({ detail: expect.stringContaining('disk full') })
    expect(log.get('cmd-1')).toBeNull()
    expect(log.commandIds()).toEqual([])
    expect(io.writes).toHaveLength(1)

    io.beforeFsync = async () => {}
    expect(await log.append(abort('cmd-1'))).toEqual({
      kind: 'failed',
      detail: expect.stringContaining('disk full')
    })
    expect(await log.append(prepare('cmd-3'))).toMatchObject({ kind: 'failed' })
    expect(io.writes).toHaveLength(1)
    // Only a new open clears it: the written batch reached the file.
    const reopened = HostTransactionLog.open(io.options)
    expect(reopened.getFailure()).toBeNull()
    expect(reopened.commandIds()).toEqual(['cmd-1', 'cmd-2'])
    expect(await reopened.append(prepare('cmd-3'))).toEqual(DURABLE)
  })

  it('fails every append in a batch whose write failed, and writes nothing more', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    expect(await log.append(prepare('cmd-1'))).toEqual(DURABLE)
    io.beforeWrite = async () => {
      throw new Error('EIO write')
    }
    expect(await log.append(abort('cmd-1'))).toEqual({
      kind: 'failed',
      detail: expect.stringContaining('EIO write')
    })
    io.beforeWrite = async () => {}
    expect(await log.append(prepare('cmd-2'))).toMatchObject({ kind: 'failed' })
    expect(io.writes).toHaveLength(1)
    expect(io.fsyncs.filter((path) => path === logPath(dataDir))).toHaveLength(1)
    expect(log.get('cmd-1')).toEqual({ prepare: prepare('cmd-1'), terminal: null })
    expect(readLines(dataDir)).toEqual([prepare('cmd-1')])
  })

  it('fails appends queued behind the failing batch without writing them', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const hold = deferred()
    io.beforeFsync = () => hold.promise
    const log = HostTransactionLog.open(io.options)
    const first = log.append(prepare('cmd-1'))
    await until(() => io.writes.length === 1, 'the first write')
    const queued = [log.append(prepare('cmd-2')), log.append(prepare('cmd-3'))]
    expect(await settledWithin(Promise.race(queued))).toBe('pending')

    hold.reject(new Error('fsync lost'))
    expect(await first).toEqual({ kind: 'failed', detail: expect.stringContaining('fsync lost') })
    expect(await Promise.all(queued)).toEqual([
      { kind: 'failed', detail: expect.stringContaining('fsync lost') },
      { kind: 'failed', detail: expect.stringContaining('fsync lost') }
    ])
    expect(io.writes).toHaveLength(1)
    expect(log.commandIds()).toEqual([])
    expect(readLines(dataDir)).toEqual([prepare('cmd-1')])
  })

  it('refuses compaction once it has fail-stopped', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    await log.append(prepare('cmd-1'))
    io.beforeFsync = async () => {
      throw new Error('gone')
    }
    await log.append(abort('cmd-1'))
    io.beforeFsync = async () => {}
    expect(await log.compact(() => null)).toMatchObject({ kind: 'failed' })
    expect(io.renames).toHaveLength(0)
    expect(readLines(dataDir)).toEqual([prepare('cmd-1'), abort('cmd-1')])
  })
})

describe('HostTransactionLog compaction', () => {
  async function seeded(io: Seams) {
    const log = HostTransactionLog.open(io.options)
    for (const record of [
      prepare('done'),
      published('done'),
      prepare('pending'),
      prepare('recoverable'),
      indeterminate('recoverable'),
      prepare('final'),
      indeterminate('final'),
      prepare('gone'),
      abort('gone'),
      prepare('published-pending'),
      published('published-pending'),
      prepare('failed-open')
    ]) {
      expect(await log.append(record)).toEqual(DURABLE)
    }
    return log
  }
  const receipts: Record<string, Receipt> = {
    done: receipt('succeeded'),
    pending: receipt('pending'),
    recoverable: recoverable(),
    final: receipt('indeterminate'),
    gone: null,
    'published-pending': receipt('pending'),
    'failed-open': receipt('failed')
  }
  const receiptOf = (commandId: string): Receipt => {
    if (!(commandId in receipts)) throw new Error(`unexpected receipt lookup ${commandId}`)
    return receipts[commandId] ?? null
  }

  it('keeps pending and indeterminate commands whole, drops terminal and missing receipts whole', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = await seeded(io)
    const writesBefore = io.writes.length
    const asked: string[] = []

    expect(
      await log.compact((commandId) => {
        asked.push(commandId)
        return receiptOf(commandId)
      })
    ).toEqual({ kind: 'compacted', kept: 4, dropped: 3, keptIndeterminate: 2 })
    expect([...asked].sort()).toEqual(Object.keys(receipts).sort())

    // Temp file, fsync, rename over the log, directory fsync.
    expect(io.renames).toHaveLength(1)
    const { from, to } = io.renames[0]!
    expect(to).toBe(logPath(dataDir))
    expect(from).not.toBe(to)
    expect(from.startsWith(dataDir)).toBe(true)
    expect(existsSync(from)).toBe(false)
    const tempWrites = io.writes.slice(writesBefore)
    expect(tempWrites.length).toBeGreaterThanOrEqual(1)
    expect(tempWrites.every((write) => write.path === from)).toBe(true)
    const afterSeed = io.fsyncs.indexOf(from)
    expect(afterSeed).toBeGreaterThan(-1)
    expect(io.fsyncs.slice(afterSeed)).toEqual([from, dataDir])

    expect(readLines(dataDir)).toEqual([
      prepare('pending'),
      prepare('recoverable'),
      indeterminate('recoverable'),
      prepare('final'),
      indeterminate('final'),
      prepare('published-pending'),
      published('published-pending')
    ])
    expect(log.commandIds()).toEqual(['pending', 'recoverable', 'final', 'published-pending'])
    expect(log.get('done')).toBeNull()
    expect(log.get('gone')).toBeNull()
    expect(log.get('failed-open')).toBeNull()
    expect(log.stats()).toEqual({ commands: 4, conflicts: 0, corrupt: 0 })
    const reopened = HostTransactionLog.open({ dataDir })
    expect(reopened.commandIds()).toEqual(['pending', 'recoverable', 'final', 'published-pending'])
    expect(reopened.stats()).toEqual({ commands: 4, conflicts: 0, corrupt: 0 })
    // A dropped command may begin again; a kept one may not.
    expect(await log.append(prepare('done'))).toEqual(DURABLE)
    expect(await log.append(prepare('pending'))).toEqual({ kind: 'duplicate' })
  })

  it('compacts an empty log to nothing kept', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    expect(await log.compact(() => null)).toEqual({
      kind: 'compacted',
      kept: 0,
      dropped: 0,
      keptIndeterminate: 0
    })
    expect(log.commandIds()).toEqual([])
    expect(await log.append(prepare('cmd-1'))).toEqual(DURABLE)
    expect(log.commandIds()).toEqual(['cmd-1'])
  })

  it('takes its snapshot at its turn in the queue: a same-turn append is a batch not yet queued, and lands after it', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    await log.append(prepare('old'))
    await log.append(abort('old'))
    // A batch joins the queue when its turn ends; the compaction joins at its
    // call, so it snapshots only 'old' and the new record follows it.
    const appended = log.append(prepare('new'))
    const asked: string[] = []
    const compacted = log.compact((commandId) => {
      asked.push(commandId)
      return commandId === 'old' ? receipt('failed') : receipt('pending')
    })
    expect(await appended).toEqual(DURABLE)
    expect(await compacted).toEqual({
      kind: 'compacted',
      kept: 0,
      dropped: 1,
      keptIndeterminate: 0
    })
    expect(asked).toEqual(['old'])
    expect(readLines(dataDir)).toEqual([prepare('new')])
    expect(log.commandIds()).toEqual(['new'])
    expect(log.get('old')).toBeNull()
    expect(HostTransactionLog.open({ dataDir }).commandIds()).toEqual(['new'])
    expect(io.renames).toHaveLength(1)
    expect(io.writes[io.writes.length - 1]).toEqual({
      path: logPath(dataDir),
      data: line(prepare('new'))
    })
  })

  it('lands appends queued during a compaction in the new file, after it', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = HostTransactionLog.open(io.options)
    await log.append(prepare('old'))
    await log.append(published('old'))
    await log.append(prepare('kept'))

    const hold = deferred()
    io.beforeRename = () => hold.promise
    const compacted = log.compact((commandId) =>
      commandId === 'old' ? receipt('succeeded') : receipt('pending')
    )
    await until(() => io.fsyncs.length > 4, 'the temp file fsync')
    const during = [log.append(abort('kept')), log.append(prepare('later'))]
    expect(await settledWithin(Promise.race([compacted, ...during]))).toBe('pending')
    // The rules see the pre-compaction index: 'kept' still has its prepare.
    expect(log.get('kept')).toEqual({ prepare: prepare('kept'), terminal: null })

    hold.resolve()
    expect(await compacted).toEqual({
      kind: 'compacted',
      kept: 1,
      dropped: 1,
      keptIndeterminate: 0
    })
    expect(await Promise.all(during)).toEqual([DURABLE, DURABLE])
    expect(readLines(dataDir)).toEqual([prepare('kept'), abort('kept'), prepare('later')])
    expect(log.commandIds()).toEqual(['kept', 'later'])
    const lastWrite = io.writes[io.writes.length - 1]!
    expect(lastWrite.path).toBe(logPath(dataDir))
    expect(lastWrite.data).toBe(line(abort('kept')) + line(prepare('later')))
    // The directory was fsynced for the rename, not again for the append into an existing file.
    expect(io.fsyncs.filter((path) => path === dataDir)).toHaveLength(2)
    const reopened = HostTransactionLog.open({ dataDir })
    expect(reopened.get('kept')).toEqual({ prepare: prepare('kept'), terminal: abort('kept') })
    expect(reopened.get('later')).toEqual({ prepare: prepare('later'), terminal: null })
    expect(reopened.get('old')).toBeNull()
  })

  it('leaves the old file, the index and later appends untouched when the rename fails', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = await seeded(io)
    const before = readFileSync(logPath(dataDir), 'utf8')
    io.beforeRename = async () => {
      throw new Error('rename refused')
    }
    expect(await log.compact(receiptOf)).toEqual({
      kind: 'failed',
      detail: expect.stringContaining('rename refused')
    })
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(before)
    expect(log.commandIds()).toEqual([
      'done',
      'pending',
      'recoverable',
      'final',
      'gone',
      'published-pending',
      'failed-open'
    ])
    expect(log.stats().commands).toBe(7)
    expect(log.getFailure()).toBeNull()
    io.beforeRename = async () => {}
    expect(await log.append(abort('pending'))).toEqual(DURABLE)
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(before + line(abort('pending')))
    const reopened = HostTransactionLog.open({ dataDir })
    expect(reopened.stats()).toEqual({ commands: 7, conflicts: 0, corrupt: 0 })
    expect(reopened.get('pending')).toEqual({
      prepare: prepare('pending'),
      terminal: abort('pending')
    })
  })

  it('leaves the old file in place when the temp write or its fsync fails', async () => {
    const dataDir = directory()
    const io = seams(dataDir)
    const log = await seeded(io)
    const before = readFileSync(logPath(dataDir), 'utf8')
    io.beforeWrite = async (path) => {
      if (path !== logPath(dataDir)) throw new Error('temp write refused')
    }
    expect(await log.compact(receiptOf)).toEqual({
      kind: 'failed',
      detail: expect.stringContaining('temp write refused')
    })
    io.beforeWrite = async () => {}
    io.beforeFsync = async (path) => {
      if (path !== logPath(dataDir) && path !== dataDir) throw new Error('temp fsync refused')
    }
    expect(await log.compact(receiptOf)).toEqual({
      kind: 'failed',
      detail: expect.stringContaining('temp fsync refused')
    })
    io.beforeFsync = async () => {}
    expect(io.renames).toHaveLength(0)
    expect(readFileSync(logPath(dataDir), 'utf8')).toBe(before)
    expect(log.getFailure()).toBeNull()
    expect(await log.append(abort('pending'))).toEqual(DURABLE)
    expect(await log.compact(receiptOf)).toEqual({
      kind: 'compacted',
      kept: 4,
      dropped: 3,
      keptIndeterminate: 2
    })
    expect(log.get('pending')).toEqual({ prepare: prepare('pending'), terminal: abort('pending') })
  })
})
