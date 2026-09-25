/**
 * The M4 transaction manifest's write-ahead log (M4 slice 8).
 *
 * A JSONL file of slice 6's records (`prepare`, `abort`, `published`,
 * `indeterminate`), one per line, written with async I/O and a group-committed
 * fsync: every record appended in the same turn shares one write and one
 * fsync, and resolves only once it is durable. A prepare's promise is what the
 * persist's rename waits for.
 *
 * `parseHostTransactionRecord` validates every record in both directions, and
 * `hostTransactionRecordsCompactable` decides compaction, which keeps a
 * command's records until its receipt is terminal or gone (RR-3) and drops
 * them together.
 *
 * A failed write or fsync fail-stops the log: nothing more is written, so a
 * torn line can never have a record concatenated onto it. Only a new `open()`,
 * at boot, moves on.
 *
 * Inert until slice 12 wires the transactional persist to it.
 */

import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync } from 'node:fs'
import {
  appendFile as appendFileAsync,
  open as openAsync,
  rename as renameAsync,
  unlink as unlinkAsync
} from 'node:fs/promises'
import { join } from 'node:path'

import {
  hostTransactionRecordsCompactable,
  parseHostTransactionRecord,
  type HostTransactionPrepareRecord,
  type HostTransactionRecord,
  type HostTransactionRecoveryInput,
  type HostTransactionTerminalRecord
} from './HostTransactionManifest'

export const HOST_TRANSACTION_LOG_FILENAME = 'host-transactions.jsonl'

export interface HostTransactionLogOptions {
  dataDir: string
  /** Appends `data` to `path`, creating it. */
  write?: (path: string, data: string) => Promise<void>
  /** Fsyncs a file or directory path. */
  fsync?: (path: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
}

export type HostTransactionLogAppendResult =
  | { kind: 'durable' }
  | { kind: 'duplicate' }
  | {
      kind: 'rejected'
      reason: 'invalid' | 'already_prepared' | 'no_prepare' | 'already_terminal'
      detail?: string
    }
  | { kind: 'failed'; detail: string }

export interface HostTransactionLogEntry {
  prepare: HostTransactionPrepareRecord | null
  terminal: HostTransactionTerminalRecord | null
}

export type HostTransactionLogCompaction =
  | { kind: 'compacted'; kept: number; dropped: number; keptIndeterminate: number }
  | { kind: 'failed'; detail: string }

interface QueuedRecord {
  record: HostTransactionRecord
  resolve: (result: HostTransactionLogAppendResult) => void
}

export class HostTransactionLog {
  private readonly dataDir: string
  private readonly path: string
  private readonly write: NonNullable<HostTransactionLogOptions['write']>
  private readonly fsync: NonNullable<HostTransactionLogOptions['fsync']>
  private readonly rename: NonNullable<HostTransactionLogOptions['rename']>

  /** What `get` and `commandIds` show: durable records only, in first-seen order. */
  private durable = new Map<string, HostTransactionLogEntry>()
  /** Durable plus queued: the rules judge a new record against this. */
  private accepted = new Map<string, HostTransactionLogEntry>()
  private queue: QueuedRecord[] = []
  private flushScheduled = false
  /** The single I/O queue: batches and compactions run one at a time, in order. */
  private io: Promise<void> = Promise.resolve()
  private fileExists: boolean
  private failure: { detail: string } | null = null
  private conflicts = 0
  private corrupt = 0

  private constructor(options: HostTransactionLogOptions) {
    if (!options.dataDir || typeof options.dataDir !== 'string') {
      throw new Error('HostTransactionLog requires an injected dataDir')
    }
    this.dataDir = options.dataDir
    this.path = join(this.dataDir, HOST_TRANSACTION_LOG_FILENAME)
    this.write =
      options.write ??
      ((path, data) => appendFileAsync(path, data, { encoding: 'utf8', mode: 0o600 }))
    this.fsync = options.fsync ?? fsyncPath
    this.rename = options.rename ?? renameAsync
    this.fileExists = existsSync(this.path)
  }

  /** Read the log synchronously, for boot recovery. */
  static open(options: HostTransactionLogOptions): HostTransactionLog {
    const log = new HostTransactionLog(options)
    log.readFile()
    return log
  }

  append(record: unknown): Promise<HostTransactionLogAppendResult> {
    if (this.failure) return Promise.resolve({ kind: 'failed', detail: this.failure.detail })
    const parsed = parseHostTransactionRecord(record)
    if (!parsed.ok) {
      return Promise.resolve({ kind: 'rejected', reason: 'invalid', detail: parsed.reason })
    }
    const next = parsed.record
    const entry = this.accepted.get(next.commandId)
    if (next.kind === 'prepare') {
      if (entry?.prepare) {
        return Promise.resolve(
          sameRecord(entry.prepare, next)
            ? { kind: 'duplicate' }
            : { kind: 'rejected', reason: 'already_prepared' }
        )
      }
      // A prepare opens a command's records; nothing may precede it.
      if (entry) return Promise.resolve({ kind: 'rejected', reason: 'already_prepared' })
      this.accepted.set(next.commandId, { prepare: next, terminal: null })
    } else {
      if (!entry?.prepare) return Promise.resolve({ kind: 'rejected', reason: 'no_prepare' })
      if (entry.terminal) {
        return Promise.resolve(
          sameRecord(entry.terminal, next)
            ? { kind: 'duplicate' }
            : { kind: 'rejected', reason: 'already_terminal' }
        )
      }
      this.accepted.set(next.commandId, { prepare: entry.prepare, terminal: next })
    }
    return new Promise((resolve) => {
      this.queue.push({ record: next, resolve })
      this.scheduleFlush()
    })
  }

  /** The command's durable records, or null. */
  get(commandId: string): HostTransactionLogEntry | null {
    const entry = this.durable.get(commandId)
    return entry ? { prepare: entry.prepare, terminal: entry.terminal } : null
  }

  commandIds(): string[] {
    return [...this.durable.keys()]
  }

  getFailure(): { detail: string } | null {
    return this.failure ? { ...this.failure } : null
  }

  stats(): { commands: number; conflicts: number; corrupt: number } {
    return { commands: this.durable.size, conflicts: this.conflicts, corrupt: this.corrupt }
  }

  /**
   * Rewrite the log keeping only commands whose receipt is not yet terminal
   * (RR-3). It runs in the same I/O queue as appends, so its snapshot is
   * taken at its turn and appends queued after it land in the new file.
   */
  compact(
    receiptOf: (commandId: string) => HostTransactionRecoveryInput['receipt']
  ): Promise<HostTransactionLogCompaction> {
    return new Promise((resolve) => {
      this.io = this.io.then(async () => resolve(await this.compactNow(receiptOf)))
    })
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return
    this.flushScheduled = true
    // Every record appended in this turn joins one batch: one write, one fsync.
    queueMicrotask(() => {
      this.flushScheduled = false
      const batch = this.queue.splice(0)
      if (batch.length === 0) return
      this.io = this.io.then(() => this.writeBatch(batch))
    })
  }

  private async writeBatch(batch: QueuedRecord[]): Promise<void> {
    if (this.failure) {
      for (const queued of batch) queued.resolve({ kind: 'failed', detail: this.failure.detail })
      return
    }
    const created = !this.fileExists
    try {
      await this.write(this.path, batch.map(({ record }) => `${JSON.stringify(record)}\n`).join(''))
      this.fileExists = true
      await this.fsync(this.path)
      // The file's name is durable only once its directory is.
      if (created && process.platform !== 'win32') await this.fsync(this.dataDir)
    } catch (error) {
      this.failStop(error instanceof Error ? error.message : String(error))
      for (const queued of batch) queued.resolve({ kind: 'failed', detail: this.failure!.detail })
      return
    }
    for (const { record, resolve } of batch) {
      const entry = this.durable.get(record.commandId) ?? { prepare: null, terminal: null }
      this.durable.set(
        record.commandId,
        record.kind === 'prepare'
          ? { prepare: record, terminal: entry.terminal }
          : { prepare: entry.prepare, terminal: record }
      )
      resolve({ kind: 'durable' })
    }
  }

  private failStop(detail: string): void {
    if (this.failure) return
    this.failure = { detail }
    // Nothing queued will be written: the rules go back to what is durable.
    this.accepted = new Map(this.durable)
  }

  private async compactNow(
    receiptOf: (commandId: string) => HostTransactionRecoveryInput['receipt']
  ): Promise<HostTransactionLogCompaction> {
    if (this.failure) return { kind: 'failed', detail: this.failure.detail }
    const kept = new Map<string, HostTransactionLogEntry>()
    let dropped = 0
    let keptIndeterminate = 0
    for (const [commandId, entry] of this.durable) {
      if (hostTransactionRecordsCompactable(receiptOf(commandId))) {
        dropped += 1
        continue
      }
      kept.set(commandId, entry)
      if (entry.terminal?.kind === 'indeterminate') keptIndeterminate += 1
    }
    const lines: string[] = []
    for (const entry of kept.values()) {
      if (entry.prepare) lines.push(`${JSON.stringify(entry.prepare)}\n`)
      if (entry.terminal) lines.push(`${JSON.stringify(entry.terminal)}\n`)
    }
    const tmpPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await this.write(tmpPath, lines.join(''))
      await this.fsync(tmpPath)
      await this.rename(tmpPath, this.path)
      if (process.platform !== 'win32') await this.fsync(this.dataDir)
    } catch (error) {
      await unlinkAsync(tmpPath).catch(() => {})
      return { kind: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
    this.fileExists = true
    this.durable = kept
    for (const commandId of [...this.accepted.keys()]) {
      // A dropped command leaves the rules too, unless a queued record of it
      // is still to be written.
      if (
        !kept.has(commandId) &&
        !this.queue.some(({ record }) => record.commandId === commandId)
      ) {
        this.accepted.delete(commandId)
      }
    }
    return { kind: 'compacted', kept: kept.size, dropped, keptIndeterminate }
  }

  private readFile(): void {
    let source: string
    try {
      source = readFileSync(this.path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return
      throw err
    }
    const endsWithNewline = source.endsWith('\n')
    const lines = source.split('\n')
    if (!endsWithNewline && source.length > 0) {
      // A torn last line is discarded, and the repair is made durable before
      // anything is appended after it.
      const torn = lines.pop()!
      const keepBytes = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(torn, 'utf8')
      const descriptor = openSync(this.path, 'r+')
      try {
        ftruncateSync(descriptor, keepBytes)
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
    }
    for (const line of lines) {
      if (!line) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        this.corrupt += 1
        continue
      }
      const parsed = parseHostTransactionRecord(value)
      if (!parsed.ok) {
        this.corrupt += 1
        continue
      }
      this.index(parsed.record)
    }
    this.accepted = new Map(this.durable)
  }

  /** The first record of each kind wins; an exact repeat is harmless. */
  private index(record: HostTransactionRecord): void {
    const entry = this.durable.get(record.commandId)
    if (record.kind === 'prepare') {
      if (entry?.prepare) {
        if (!sameRecord(entry.prepare, record)) this.conflicts += 1
        return
      }
      this.durable.set(record.commandId, { prepare: record, terminal: entry?.terminal ?? null })
      return
    }
    if (entry?.terminal) {
      if (!sameRecord(entry.terminal, record)) this.conflicts += 1
      return
    }
    this.durable.set(record.commandId, { prepare: entry?.prepare ?? null, terminal: record })
  }
}

function sameRecord(left: HostTransactionRecord, right: HostTransactionRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await openAsync(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
