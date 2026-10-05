/**
 * The authority file: the durable mark that an app process owns a thread.
 *
 * A thread's log can run ahead of the Host's full copy for two reasons. Its
 * owner wrote work it has not published yet, or the app wrote a save the Host
 * then refused or overtook. The two look the same from their revisions, and
 * only the first may ever be folded into the full copy or carried on by a new
 * process. This file is what tells them apart: the app writes it when the Host
 * grants it the thread, before its first append under that grant, and from then
 * on the log above the grant revision is the owner's work.
 *
 * So a reader must never mistake a file it cannot read for no file at all: a
 * missing mark would let someone else write a thread that is owned. Anything
 * that is there and cannot be understood is reported as damaged.
 *
 * One small file per thread, in a directory of its own under the profile. A
 * write goes to a temporary name and is renamed into place, so a reader meets
 * the earlier file or the whole new one. Every step is asynchronous: the app
 * writes and removes these on its main thread, the Host reads and removes them
 * on its only thread, and neither may wait on a disk sync there.
 */
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import * as path from 'node:path'

import { chatPathForId, isSafeChatId } from '../../shared/ChatPath'
import type { ThreadOwnerEpoch } from './ThreadOwnership'

export const THREAD_AUTHORITY_DIRECTORY = 'thread-authority'
export const THREAD_AUTHORITY_FORMAT = 'taskwraith.thread-authority' as const
export const THREAD_AUTHORITY_VERSION = 1 as const

/** A record is a few hundred bytes. Anything far beyond that is not one. */
export const THREAD_AUTHORITY_MAX_BYTES = 16 * 1024

const FILE_SUFFIX = '.json'
const TEMPORARY_SUFFIX = '.tmp'
const MAX_ID_LENGTH = 256

/** The app process that owns the thread, and how to tell whether it still runs. */
export interface ThreadAuthorityWriter {
  readonly writerId: string
  readonly pid: number
}

export interface ThreadAuthorityRecord {
  readonly threadId: string
  readonly writer: ThreadAuthorityWriter
  /** The grant this file was written under. */
  readonly epoch: ThreadOwnerEpoch
  /** Revision of the Host's full copy when it granted the thread. */
  readonly grantedAtRevision: number
  /** When the grant was given, in Unix milliseconds. */
  readonly grantedAt: number
}

export type ThreadAuthorityRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'held'; readonly record: ThreadAuthorityRecord }
  /** A file is there and cannot be relied on. The thread must be treated as owned. */
  | { readonly kind: 'damaged'; readonly reason: string }

export interface ThreadAuthorityEntry {
  readonly threadId: string
  readonly read: Exclude<ThreadAuthorityRead, { readonly kind: 'none' }>
}

export interface ThreadAuthorityFileHandle {
  write(text: string): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/**
 * The filesystem steps an authority file takes. Each is one awaited call, so a
 * test can stop between any two of them.
 */
export interface ThreadAuthorityFs {
  /** Makes the directory and any missing parent; resolves with the first one it made, if any. */
  mkdir(directory: string): Promise<string | undefined>
  /** Opens a file for writing, empty, making it if need be. */
  create(file: string): Promise<ThreadAuthorityFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(file: string): Promise<void>
  syncDirectory(directory: string): Promise<void>
  /** At most `limit` bytes of the file, as text. */
  readFile(file: string, limit: number): Promise<string>
  readdir(directory: string): Promise<string[]>
}

export const NODE_THREAD_AUTHORITY_FS: ThreadAuthorityFs = {
  mkdir: (directory) => mkdir(directory, { recursive: true, mode: 0o700 }),
  async create(file) {
    const handle = await open(file, 'w', 0o600)
    return {
      write: async (text) => {
        await handle.writeFile(text, 'utf8')
      },
      sync: () => handle.sync(),
      close: () => handle.close()
    }
  },
  rename: (from, to) => rename(from, to),
  unlink: (file) => unlink(file),
  async syncDirectory(directory) {
    // Windows cannot open a directory to sync it, and does not need to.
    if (process.platform === 'win32') return
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  async readFile(file, limit) {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(limit)
      let length = 0
      while (length < limit) {
        const { bytesRead } = await handle.read(buffer, length, limit - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      return buffer.toString('utf8', 0, length)
    } finally {
      await handle.close()
    }
  },
  readdir: (directory) => readdir(directory)
}

export function threadAuthorityDirectory(profilePath: string): string {
  return path.resolve(profilePath, THREAD_AUTHORITY_DIRECTORY)
}

/** Throws for an id that could name a file outside the directory. */
export function threadAuthorityFilePath(profilePath: string, threadId: string): string {
  return chatPathForId(threadAuthorityDirectory(profilePath), threadId)
}

/**
 * Every file an authority write can leave for a thread: the file itself and
 * the temporary name a crashed write leaves beside it. Erasure removes them
 * all, from this list and no copy of it.
 */
export function threadAuthorityArtifactPaths(profilePath: string, threadId: string): string[] {
  const file = threadAuthorityFilePath(profilePath, threadId)
  return [file, temporaryName(file)]
}

function temporaryName(file: string): string {
  return `${file}${TEMPORARY_SUFFIX}`
}

export type ThreadWriterLiveness = 'alive' | 'dead' | 'unresolved'

/**
 * Whether an authority file's writer still runs, decided the way the thread
 * catalogue's recovery decides that a desktop is alive: signal 0 to its
 * process id. Only "no such process" proves it dead. A process id that cannot
 * be probed, and a probe that fails any other way, leave it unresolved, and an
 * unresolved writer must be treated as alive.
 */
export function threadWriterLiveness(
  writer: Pick<ThreadAuthorityWriter, 'pid'>,
  probe: (pid: number) => void = (pid) => {
    process.kill(pid, 0)
  }
): ThreadWriterLiveness {
  // 0 and negative ids address process groups, and 1 is never an app process.
  if (!isProcessId(writer.pid)) return 'unresolved'
  try {
    probe(writer.pid)
  } catch (error) {
    return errorCode(error) === 'ESRCH' ? 'dead' : 'unresolved'
  }
  return 'alive'
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' ? code : undefined
}

function isProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 1
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

function isCount(value: unknown, least: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= least
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The first thing wrong with a record's fields, or null when they are all sound. */
function recordFault(record: {
  readonly [key in keyof ThreadAuthorityRecord]?: unknown
}): string | null {
  if (!isId(record.threadId) || !isSafeChatId(record.threadId)) return 'thread id'
  const { writer, epoch } = record
  if (!isObject(writer) || !hasOnlyKeys(writer, ['writerId', 'pid'])) return 'writer'
  if (!isId(writer.writerId)) return 'writer id'
  if (!isProcessId(writer.pid)) return 'writer process id'
  if (!isObject(epoch) || !hasOnlyKeys(epoch, ['host', 'grant'])) return 'epoch'
  if (!isId(epoch.host)) return 'epoch Host'
  if (!isCount(epoch.grant, 1)) return 'epoch grant'
  if (!isCount(record.grantedAtRevision, 0)) return 'grant revision'
  if (!isCount(record.grantedAt, 0)) return 'grant time'
  return null
}

const FILE_KEYS = [
  'format',
  'version',
  'threadId',
  'writer',
  'epoch',
  'grantedAtRevision',
  'grantedAt'
] as const

function serialize(record: ThreadAuthorityRecord): string {
  return `${JSON.stringify({
    format: THREAD_AUTHORITY_FORMAT,
    version: THREAD_AUTHORITY_VERSION,
    threadId: record.threadId,
    writer: { writerId: record.writer.writerId, pid: record.writer.pid },
    epoch: { host: record.epoch.host, grant: record.epoch.grant },
    grantedAtRevision: record.grantedAtRevision,
    grantedAt: record.grantedAt
  })}\n`
}

function parse(threadId: string, text: string): ThreadAuthorityRead {
  const damaged = (reason: string): ThreadAuthorityRead => ({ kind: 'damaged', reason })
  if (Buffer.byteLength(text, 'utf8') > THREAD_AUTHORITY_MAX_BYTES) return damaged('too large')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return damaged('not JSON')
  }
  if (!isObject(value)) return damaged('not an object')
  if (value.format !== THREAD_AUTHORITY_FORMAT) return damaged('unknown format')
  if (value.version !== THREAD_AUTHORITY_VERSION) return damaged('unknown version')
  if (!hasOnlyKeys(value, FILE_KEYS)) return damaged('unknown field')
  const fault = recordFault(value)
  if (fault) return damaged(`invalid ${fault}`)
  if (value.threadId !== threadId) return damaged('names another thread')
  const writer = value.writer as ThreadAuthorityWriter
  const epoch = value.epoch as ThreadOwnerEpoch
  return {
    kind: 'held',
    record: {
      threadId,
      writer: { writerId: writer.writerId, pid: writer.pid },
      epoch: { host: epoch.host, grant: epoch.grant },
      grantedAtRevision: value.grantedAtRevision as number,
      grantedAt: value.grantedAt as number
    }
  }
}

/** The authority files of one profile. */
export class ThreadAuthorityFiles {
  /** Whether this object has synced the directory that names the authority directory. */
  private directoryNamed = false

  constructor(
    private readonly profilePath: string,
    private readonly fs: ThreadAuthorityFs = NODE_THREAD_AUTHORITY_FS
  ) {}

  get directory(): string {
    return threadAuthorityDirectory(this.profilePath)
  }

  /**
   * Resolves once the file is in place and would survive a power loss. A
   * caller writes one thread's file at a time: two writes for one thread share
   * a temporary name. A write that rejects may still have put the file in
   * place, so a caller that gives the grant up removes it.
   */
  async write(record: ThreadAuthorityRecord): Promise<void> {
    const fault = recordFault(record)
    if (fault) throw new Error(`Invalid thread authority ${fault}`)
    const file = threadAuthorityFilePath(this.profilePath, record.threadId)
    const temporary = temporaryName(file)
    const text = serialize(record)
    const made = await this.fs.mkdir(this.directory)
    if (made !== undefined || !this.directoryNamed) {
      // A directory is only as durable as its own name, and the same goes for
      // any parent made with it. A process that made the directory may have
      // stopped before it synced that, so each object's first write syncs the
      // name whether or not it made the directory.
      for (const parent of parentsFrom(made ?? this.directory, this.directory)) {
        await this.fs.syncDirectory(parent)
      }
      this.directoryNamed = true
    }
    try {
      const handle = await this.fs.create(temporary)
      try {
        await handle.write(text)
        // Before the rename: a name that outlives a power loss must not lead to
        // data that did not.
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.fs.rename(temporary, file)
    } catch (error) {
      await this.fs.unlink(temporary).catch(() => undefined)
      throw error
    }
    await this.fs.syncDirectory(this.directory)
  }

  /**
   * Syncs nothing. A writer that stopped between an unlink or a rename and its
   * sync leaves a change a power loss could still undo, so a caller about to
   * act on a thread having no file removes it first, which makes that durable.
   */
  async read(threadId: string): Promise<ThreadAuthorityRead> {
    const file = threadAuthorityFilePath(this.profilePath, threadId)
    let text: string
    try {
      // One byte over the limit is enough to know the file is too large.
      text = await this.fs.readFile(file, THREAD_AUTHORITY_MAX_BYTES + 1)
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') return { kind: 'none' }
      return { kind: 'damaged', reason: `unreadable (${code ?? 'unknown error'})` }
    }
    return parse(threadId, text)
  }

  /**
   * Every thread with a file, in thread order. For a Host that has just
   * started. A directory that is there and cannot be read fails the call: an
   * empty answer would say that no thread is owned. The directory is synced
   * first, so what a writer that stopped before its sync left is durable
   * before anyone acts on the answer.
   */
  async list(): Promise<ThreadAuthorityEntry[]> {
    if (!(await this.syncDirectoryIfPresent())) return []
    let names: string[]
    try {
      names = await this.fs.readdir(this.directory)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return []
      throw error
    }
    const entries: ThreadAuthorityEntry[] = []
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue
      const threadId = name.slice(0, -FILE_SUFFIX.length)
      if (!isSafeChatId(threadId)) continue
      const read = await this.read(threadId)
      // Removed since the directory was read.
      if (read.kind !== 'none') entries.push({ threadId, read })
    }
    return entries.sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0))
  }

  /** Resolves with whether there was a file, once its absence would survive a power loss. */
  async remove(threadId: string): Promise<boolean> {
    const file = threadAuthorityFilePath(this.profilePath, threadId)
    const removed = await this.unlinkIfPresent(file)
    // What a crashed write may have left for the thread.
    await this.unlinkIfPresent(temporaryName(file))
    // Also when there was nothing to remove: an earlier remove may have taken
    // the name away and stopped before its sync.
    await this.syncDirectoryIfPresent()
    return removed
  }

  /** Resolves false when there is no directory to sync. */
  private async syncDirectoryIfPresent(): Promise<boolean> {
    try {
      await this.fs.syncDirectory(this.directory)
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
  }

  private async unlinkIfPresent(file: string): Promise<boolean> {
    try {
      await this.fs.unlink(file)
      return true
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false
      throw error
    }
  }
}

/**
 * The directories that gained a name when `first` and everything below it down
 * to `last` were made: the parent of `first`, then each one from `first` to the
 * parent of `last`.
 */
function parentsFrom(first: string, last: string): string[] {
  const from = path.resolve(first)
  const to = path.resolve(last)
  const parents = [path.dirname(to)]
  // Only when `first` is spelt as an ancestor of `last`; otherwise the walk
  // would not know where to stop.
  if (to.startsWith(`${from}${path.sep}`)) {
    for (let made = path.dirname(to); ; made = path.dirname(made)) {
      parents.unshift(path.dirname(made))
      if (made === from) break
    }
  }
  return parents
}
