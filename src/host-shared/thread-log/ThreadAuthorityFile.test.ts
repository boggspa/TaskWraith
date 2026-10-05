/**
 * The authority file is the durable mark that an app process owns a thread.
 * Most cases run on real files in a temporary directory. The crash cases run
 * on a disk held in memory, which can stop after any step and then show what
 * each kind of crash leaves behind: a killed process keeps everything the
 * steps did, while a power loss keeps only what was synced.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'

import {
  NODE_THREAD_AUTHORITY_FS,
  THREAD_AUTHORITY_DIRECTORY,
  THREAD_AUTHORITY_FORMAT,
  THREAD_AUTHORITY_MAX_BYTES,
  THREAD_AUTHORITY_VERSION,
  ThreadAuthorityFiles,
  threadAuthorityArtifactPaths,
  threadAuthorityDirectory,
  threadAuthorityFilePath,
  threadWriterLiveness,
  type ThreadAuthorityFileHandle,
  type ThreadAuthorityFs,
  type ThreadAuthorityRecord
} from './ThreadAuthorityFile'

const PREFIX = 'owner-thread-authority-'
const roots: string[] = []

/**
 * Removes a folder this file made with mkdtemp under the temporary folder,
 * and refuses anything else.
 */
function removeTemporary(directory: string): void {
  const own = os.tmpdir() + path.sep + PREFIX
  if (
    directory === os.tmpdir() ||
    !directory.startsWith(own) ||
    directory.includes(path.sep, own.length)
  ) {
    throw new Error(`Refusing to remove ${directory}`)
  }
  fs.rmSync(directory, { recursive: true, force: true })
}

afterEach(() => {
  while (roots.length > 0) removeTemporary(roots.pop()!)
})

function profile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  roots.push(root)
  return root
}

function record(
  threadId: string,
  overrides: Partial<ThreadAuthorityRecord> = {}
): ThreadAuthorityRecord {
  return {
    threadId,
    writer: { writerId: 'writer-a', pid: 4242 },
    epoch: { host: 'host-1', grant: 3 },
    grantedAtRevision: 17,
    grantedAt: 1_780_000_000_000,
    ...overrides
  }
}

/** What a valid file holds, for the cases that write one by hand. */
function fileText(value: ThreadAuthorityRecord, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    format: THREAD_AUTHORITY_FORMAT,
    version: THREAD_AUTHORITY_VERSION,
    threadId: value.threadId,
    writer: value.writer,
    epoch: value.epoch,
    grantedAtRevision: value.grantedAtRevision,
    grantedAt: value.grantedAt,
    ...overrides
  })}\n`
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

// The memory disk's paths, spelt as this platform spells them.
const PROFILE = path.resolve('/profile')
const ROOT = path.parse(PROFILE).root
const DIRECTORY = threadAuthorityDirectory(PROFILE)
const FILE = threadAuthorityFilePath(PROFILE, 'thread-1')

type DiskEntry = { kind: 'file'; inode: number } | { kind: 'directory' }

interface DiskFile {
  /** What a reader sees while the machine is up. */
  text: string
  /** What the last sync of the file made durable. */
  synced: string
}

/** How the machine stopped: the process was killed, or the power went. */
type Crash =
  /** Everything the steps did is still there, and what was not synced is still not durable. */
  | 'process killed'
  /** Only synced data and synced directories survive. */
  | 'power lost'
  /** Every name change survived, synced or not, but unsynced data did not. */
  | 'power lost, names kept'

const CRASHES: readonly Crash[] = ['process killed', 'power lost', 'power lost, names kept']

class Halted extends Error {}

/**
 * A disk in memory that tells apart what is visible from what is durable, and
 * can stop before any step. After it stops, every further step fails without
 * effect, as it would for a process that no longer runs.
 */
class CrashDisk implements ThreadAuthorityFs {
  readonly steps: string[] = []
  private readonly files = new Map<number, DiskFile>()
  private readonly names = new Map<string, Map<string, DiskEntry>>()
  private readonly syncedNames = new Map<string, Map<string, DiskEntry>>()
  private inodes = 0
  private stepsLeft = Number.POSITIVE_INFINITY
  private stopLabel: string | null = null

  constructor() {
    this.names.set(ROOT, new Map())
    this.syncedNames.set(ROOT, new Map())
  }

  /** A directory that already exists and is durable, with its ancestors. */
  seedDirectory(directory: string): void {
    const missing: string[] = []
    for (let current = directory; !this.names.has(current); current = path.dirname(current)) {
      missing.unshift(current)
    }
    for (const made of missing) {
      this.names.set(made, new Map())
      this.syncedNames.set(made, new Map())
      const parent = path.dirname(made)
      this.names.get(parent)!.set(path.basename(made), { kind: 'directory' })
      this.syncedNames.get(parent)!.set(path.basename(made), { kind: 'directory' })
    }
  }

  /** Stop the machine after this many more steps. */
  stopAfter(steps: number): void {
    this.stepsLeft = steps
  }

  /** Stop the machine just before the first step with this label. */
  stopAt(label: string): void {
    this.stopLabel = label
  }

  /** The disk as the next process to start finds it. */
  after(crash: Crash): CrashDisk {
    const next = new CrashDisk()
    next.inodes = this.inodes
    if (crash === 'process killed') {
      // The machine runs on: what the steps did stays, and what they did not
      // sync is still not durable, so a later power loss can undo it.
      for (const [inode, file] of this.files) next.files.set(inode, { ...file })
      for (const [directory, entries] of this.names) next.names.set(directory, new Map(entries))
      for (const [directory, entries] of this.syncedNames) {
        next.syncedNames.set(directory, new Map(entries))
      }
      return next
    }
    for (const [inode, file] of this.files) {
      next.files.set(inode, { text: file.synced, synced: file.synced })
    }
    const source = crash === 'power lost' ? this.syncedNames : this.names
    const copy = (directory: string): void => {
      const entries = new Map(source.get(directory) ?? [])
      next.names.set(directory, entries)
      next.syncedNames.set(directory, new Map(entries))
      for (const [name, entry] of entries) {
        if (entry.kind === 'directory') copy(path.join(directory, name))
      }
    }
    copy(ROOT)
    return next
  }

  async mkdir(directory: string): Promise<string | undefined> {
    this.step(`mkdir ${directory}`)
    const missing: string[] = []
    for (let current = directory; !this.names.has(current); current = path.dirname(current)) {
      missing.unshift(current)
    }
    for (const made of missing) {
      this.names.set(made, new Map())
      this.syncedNames.set(made, new Map())
      this.names.get(path.dirname(made))!.set(path.basename(made), { kind: 'directory' })
    }
    return missing[0]
  }

  async create(file: string): Promise<ThreadAuthorityFileHandle> {
    this.step(`create ${file}`)
    const directory = this.directory(path.dirname(file))
    const existing = directory.get(path.basename(file))
    if (existing?.kind === 'directory') throw errno('EISDIR')
    let inode = existing?.inode
    if (inode === undefined) {
      inode = ++this.inodes
      this.files.set(inode, { text: '', synced: '' })
      directory.set(path.basename(file), { kind: 'file', inode })
    } else {
      this.files.get(inode)!.text = ''
    }
    const target = this.files.get(inode)!
    return {
      write: async (text) => {
        this.step('write')
        target.text += text
      },
      sync: async () => {
        this.step('sync')
        target.synced = target.text
      },
      close: async () => {
        this.step('close')
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    this.step(`rename ${from} -> ${to}`)
    const source = this.directory(path.dirname(from))
    const entry = source.get(path.basename(from))
    if (!entry) throw errno('ENOENT')
    source.delete(path.basename(from))
    this.directory(path.dirname(to)).set(path.basename(to), entry)
  }

  async unlink(file: string): Promise<void> {
    this.step(`unlink ${file}`)
    if (!this.directory(path.dirname(file)).delete(path.basename(file))) throw errno('ENOENT')
  }

  async syncDirectory(directory: string): Promise<void> {
    this.step(`syncDirectory ${directory}`)
    this.syncedNames.set(directory, new Map(this.directory(directory)))
  }

  async readFile(file: string, limit: number): Promise<string> {
    const entry = this.names.get(path.dirname(file))?.get(path.basename(file))
    if (!entry) throw errno('ENOENT')
    if (entry.kind === 'directory') throw errno('EISDIR')
    return this.files.get(entry.inode)!.text.slice(0, limit)
  }

  async readdir(directory: string): Promise<string[]> {
    return [...this.directory(directory).keys()]
  }

  private directory(directory: string): Map<string, DiskEntry> {
    const entries = this.names.get(directory)
    if (!entries) throw errno('ENOENT')
    return entries
  }

  private step(label: string): void {
    if (label === this.stopLabel) this.stepsLeft = 0
    if (this.stepsLeft === 0) throw new Halted(label)
    this.stepsLeft -= 1
    this.steps.push(label)
  }
}

const TEMPORARY = `${FILE}.tmp`

function seededDisk(): CrashDisk {
  const disk = new CrashDisk()
  disk.seedDirectory(PROFILE)
  return disk
}

/** Runs `work` on a copy of the disk for every number of steps it may complete before the stop. */
async function atEveryStop(
  disk: () => Promise<CrashDisk>,
  work: (files: ThreadAuthorityFiles) => Promise<unknown>,
  check: (
    after: ThreadAuthorityFiles,
    stop: { steps: number; of: number; crash: Crash }
  ) => Promise<void>
): Promise<number> {
  const whole = await disk()
  const before = whole.steps.length
  await work(new ThreadAuthorityFiles(PROFILE, whole))
  const total = whole.steps.length - before
  for (let steps = 0; steps <= total; steps += 1) {
    const stopped = await disk()
    stopped.stopAfter(steps)
    await work(new ThreadAuthorityFiles(PROFILE, stopped)).catch((error: unknown) => {
      if (!(error instanceof Halted)) throw error
    })
    for (const crash of CRASHES) {
      await check(new ThreadAuthorityFiles(PROFILE, stopped.after(crash)), {
        steps,
        of: total,
        crash
      })
    }
  }
  return total
}

describe('where an authority file lives', () => {
  it('has a directory of its own under the profile, one file per thread', () => {
    expect(THREAD_AUTHORITY_DIRECTORY).toBe('thread-authority')
    expect(threadAuthorityDirectory('/p')).toBe(path.resolve('/p', 'thread-authority'))
    expect(threadAuthorityFilePath('/p', 'thread-1')).toBe(
      path.resolve('/p', 'thread-authority', 'thread-1.json')
    )
    expect(new ThreadAuthorityFiles('/p').directory).toBe(threadAuthorityDirectory('/p'))
    // Not among the journal's files: clearing or listing one never meets the other.
    expect(threadAuthorityDirectory('/p')).not.toBe(path.resolve('/p', 'chat-journal-v2'))
  })

  it('names every file erasure must remove for a thread: the file, and the temporary name a crashed write leaves', async () => {
    expect(threadAuthorityArtifactPaths('/p', 'thread-1')).toEqual([
      threadAuthorityFilePath('/p', 'thread-1'),
      `${threadAuthorityFilePath('/p', 'thread-1')}.tmp`
    ])
    // The same names a write uses and a remove takes away.
    const disk = seededDisk()
    disk.stopAfter(6)
    await new ThreadAuthorityFiles(PROFILE, disk).write(record('thread-1')).catch(() => undefined)
    const left = await disk.readdir(DIRECTORY)
    expect(left).toHaveLength(1)
    expect(threadAuthorityArtifactPaths(PROFILE, 'thread-1')).toContain(
      path.join(DIRECTORY, left[0])
    )
  })

  it.each(['', ' ', '.', '..', '../thread-1', 'a/b', 'a\\b', ' thread-1', 'thread-1 '])(
    'refuses the thread id %j rather than name a file outside the directory',
    async (threadId) => {
      const files = new ThreadAuthorityFiles(profile())
      expect(() => threadAuthorityFilePath('/p', threadId)).toThrow()
      await expect(files.read(threadId)).rejects.toThrow()
      await expect(files.remove(threadId)).rejects.toThrow()
      await expect(files.write(record(threadId))).rejects.toThrow(/thread id/)
      expect(() => threadAuthorityArtifactPaths('/p', threadId)).toThrow()
    }
  )
})

describe('writing and reading an authority file', () => {
  it('gives a reader back exactly what was written', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    const written = record('thread-1')

    await files.write(written)

    expect(await files.read('thread-1')).toEqual({ kind: 'held', record: written })
    // A second object over the same profile, as another process would hold.
    expect(await new ThreadAuthorityFiles(root).read('thread-1')).toEqual({
      kind: 'held',
      record: written
    })
  })

  it('stores the format, its version, the thread, the writer and its process, the epoch, the grant revision and the time', async () => {
    const root = profile()
    await new ThreadAuthorityFiles(root).write(record('thread-1'))

    const text = fs.readFileSync(threadAuthorityFilePath(root, 'thread-1'), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual({
      format: 'taskwraith.thread-authority',
      version: 1,
      threadId: 'thread-1',
      writer: { writerId: 'writer-a', pid: 4242 },
      epoch: { host: 'host-1', grant: 3 },
      grantedAtRevision: 17,
      grantedAt: 1_780_000_000_000
    })
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the file and its directory to the user',
    async () => {
      const root = profile()
      await new ThreadAuthorityFiles(root).write(record('thread-1'))

      expect(fs.statSync(threadAuthorityDirectory(root)).mode & 0o777).toBe(0o700)
      expect(fs.statSync(threadAuthorityFilePath(root, 'thread-1')).mode & 0o777).toBe(0o600)
    }
  )

  it('replaces an earlier file for the thread and leaves no temporary file', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    await files.write(record('thread-1'))
    const later = record('thread-1', {
      writer: { writerId: 'writer-b', pid: 5151 },
      epoch: { host: 'host-2', grant: 1 },
      grantedAtRevision: 40
    })

    await files.write(later)

    expect(await files.read('thread-1')).toEqual({ kind: 'held', record: later })
    expect(fs.readdirSync(threadAuthorityDirectory(root))).toEqual(['thread-1.json'])
  })

  it('reads a thread with no file as none, with or without the directory', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    expect(await files.read('thread-1')).toEqual({ kind: 'none' })

    await files.write(record('thread-2'))

    expect(await files.read('thread-1')).toEqual({ kind: 'none' })
  })

  it.each<[string, (valid: ThreadAuthorityRecord) => ThreadAuthorityRecord]>([
    ['an empty writer id', (valid) => ({ ...valid, writer: { ...valid.writer, writerId: '' } })],
    ['a process id of 1', (valid) => ({ ...valid, writer: { ...valid.writer, pid: 1 } })],
    ['a process id of 0', (valid) => ({ ...valid, writer: { ...valid.writer, pid: 0 } })],
    ['a fractional process id', (valid) => ({ ...valid, writer: { ...valid.writer, pid: 4.5 } })],
    ['an empty Host incarnation', (valid) => ({ ...valid, epoch: { ...valid.epoch, host: '' } })],
    ['a grant of 0', (valid) => ({ ...valid, epoch: { ...valid.epoch, grant: 0 } })],
    ['a negative grant revision', (valid) => ({ ...valid, grantedAtRevision: -1 })],
    ['a fractional grant revision', (valid) => ({ ...valid, grantedAtRevision: 1.5 })],
    ['a time that is not a number', (valid) => ({ ...valid, grantedAt: Number.NaN })]
  ])('refuses to write a record with %s, and writes nothing', async (_what, spoil) => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)

    await expect(files.write(spoil(record('thread-1')))).rejects.toThrow(/Invalid/)

    expect(fs.existsSync(threadAuthorityDirectory(root))).toBe(false)
  })
})

describe('a file that cannot be trusted', () => {
  const valid = record('thread-1')
  const damagedTexts: Array<[string, string]> = [
    ['an empty file', ''],
    ['half a file', fileText(valid).slice(0, 40)],
    ['text that is not JSON', 'not json\n'],
    ['a JSON array', '[]\n'],
    ['a JSON null', 'null\n'],
    ['another format', fileText(valid, { format: 'taskwraith-chat-mutation' })],
    ['a version this build does not know', fileText(valid, { version: 2 })],
    ['no version', fileText(valid, { version: undefined })],
    ['another thread than its name says', fileText(valid, { threadId: 'thread-2' })],
    ['no writer', fileText(valid, { writer: undefined })],
    ['a writer with no process id', fileText(valid, { writer: { writerId: 'writer-a' } })],
    ['a process id of 1', fileText(valid, { writer: { writerId: 'writer-a', pid: 1 } })],
    ['a process id that is text', fileText(valid, { writer: { writerId: 'writer-a', pid: '42' } })],
    ['an empty writer id', fileText(valid, { writer: { writerId: '', pid: 4242 } })],
    ['no epoch', fileText(valid, { epoch: undefined })],
    ['an epoch with no Host', fileText(valid, { epoch: { grant: 3 } })],
    [
      'an epoch with a field this version does not have',
      fileText(valid, { epoch: { ...valid.epoch, at: 1 } })
    ],
    ['a grant of 0', fileText(valid, { epoch: { host: 'host-1', grant: 0 } })],
    ['no grant revision', fileText(valid, { grantedAtRevision: undefined })],
    ['a negative grant revision', fileText(valid, { grantedAtRevision: -1 })],
    ['no time', fileText(valid, { grantedAt: undefined })],
    ['a field this version does not have', fileText(valid, { owner: 'someone' })],
    [
      'a writer with a field this version does not have',
      fileText(valid, { writer: { ...valid.writer, host: 'x' } })
    ],
    [
      'more bytes than a record can need',
      `${fileText(valid).trimEnd()}${' '.repeat(THREAD_AUTHORITY_MAX_BYTES)}\n`
    ]
  ]

  it.each(damagedTexts)('reads %s as damaged, never as no file', async (_what, text) => {
    const root = profile()
    fs.mkdirSync(threadAuthorityDirectory(root))
    fs.writeFileSync(threadAuthorityFilePath(root, 'thread-1'), text)
    const files = new ThreadAuthorityFiles(root)

    const read = await files.read('thread-1')

    expect(read).toEqual({ kind: 'damaged', reason: expect.any(String) })
    expect((read as { reason: string }).reason.length).toBeGreaterThan(0)
    expect(await files.list()).toEqual([{ threadId: 'thread-1', read }])
  })

  it('reads a directory standing where the file should be as damaged', async () => {
    const root = profile()
    fs.mkdirSync(threadAuthorityFilePath(root, 'thread-1'), { recursive: true })

    expect(await new ThreadAuthorityFiles(root).read('thread-1')).toEqual({
      kind: 'damaged',
      reason: expect.stringContaining('unreadable')
    })
  })

  it('reads a file it is not allowed to open as damaged', async () => {
    const disk = seededDisk()
    await new ThreadAuthorityFiles(PROFILE, disk).write(valid)
    const denied: ThreadAuthorityFs = {
      ...NODE_THREAD_AUTHORITY_FS,
      readFile: async () => {
        throw errno('EACCES')
      }
    }

    expect(await new ThreadAuthorityFiles(PROFILE, denied).read('thread-1')).toEqual({
      kind: 'damaged',
      reason: expect.stringContaining('EACCES')
    })
  })
})

describe('listing every authority file', () => {
  it('lists nothing before any file was written', async () => {
    expect(await new ThreadAuthorityFiles(profile()).list()).toEqual([])
  })

  it('lists each thread once, in thread order, damaged files included', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    await files.write(record('thread-b'))
    await files.write(record('thread-a', { grantedAtRevision: 2 }))
    fs.writeFileSync(threadAuthorityFilePath(root, 'thread-c'), '{')

    expect(await files.list()).toEqual([
      {
        threadId: 'thread-a',
        read: { kind: 'held', record: record('thread-a', { grantedAtRevision: 2 }) }
      },
      { threadId: 'thread-b', read: { kind: 'held', record: record('thread-b') } },
      { threadId: 'thread-c', read: { kind: 'damaged', reason: expect.any(String) } }
    ])
  })

  it('passes over a temporary file a crashed write left, and names that are no thread file', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    await files.write(record('thread-1'))
    const directory = threadAuthorityDirectory(root)
    fs.writeFileSync(path.join(directory, 'thread-2.json.tmp'), fileText(record('thread-2')))
    fs.writeFileSync(path.join(directory, '.DS_Store'), 'x')
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'x')
    // As long as a thread file's name, without being one.
    fs.writeFileSync(path.join(directory, 'thread-1.bak1'), 'x')
    // A name that would stand for the empty thread id.
    fs.writeFileSync(path.join(directory, '.json'), fileText(record('thread-3')))
    fs.mkdirSync(path.join(directory, 'folder'))

    expect((await files.list()).map((entry) => entry.threadId)).toEqual(['thread-1'])
    expect(await files.read('thread-2')).toEqual({ kind: 'none' })
  })

  it('puts the threads in order whatever order the directory gives their names in', async () => {
    const disk = seededDisk()
    const files = new ThreadAuthorityFiles(PROFILE, disk)
    for (const threadId of ['thread-b', 'thread-a.x', 'thread-a', 'thread-a-x']) {
      await files.write(record(threadId))
    }
    expect(await disk.readdir(DIRECTORY)).toEqual([
      'thread-b.json',
      'thread-a.x.json',
      'thread-a.json',
      'thread-a-x.json'
    ])

    expect((await files.list()).map((entry) => entry.threadId)).toEqual([
      'thread-a',
      'thread-a-x',
      'thread-a.x',
      'thread-b'
    ])
  })

  it('fails rather than list nothing when the directory is there but cannot be read', async () => {
    const disk = seededDisk()
    await new ThreadAuthorityFiles(PROFILE, disk).write(record('thread-1'))
    const denied: ThreadAuthorityFs = {
      ...boundTo(disk),
      readdir: async () => {
        throw errno('EACCES')
      }
    }

    await expect(new ThreadAuthorityFiles(PROFILE, denied).list()).rejects.toThrow('EACCES')
  })

  it('leaves out a file that was removed between the listing and its read', async () => {
    const disk = seededDisk()
    const files = new ThreadAuthorityFiles(PROFILE, disk)
    await files.write(record('thread-1'))
    await files.write(record('thread-2'))
    const vanishing: ThreadAuthorityFs = {
      ...boundTo(disk),
      readFile: async (file, limit) => {
        if (file.endsWith('thread-1.json')) throw errno('ENOENT')
        return disk.readFile(file, limit)
      }
    }

    expect(
      (await new ThreadAuthorityFiles(PROFILE, vanishing).list()).map((e) => e.threadId)
    ).toEqual(['thread-2'])
  })
})

/** The disk's steps as a plain object, so one of them can be replaced. */
function boundTo(disk: CrashDisk): ThreadAuthorityFs {
  return {
    mkdir: (directory) => disk.mkdir(directory),
    create: (file) => disk.create(file),
    rename: (from, to) => disk.rename(from, to),
    unlink: (file) => disk.unlink(file),
    syncDirectory: (directory) => disk.syncDirectory(directory),
    readFile: (file, limit) => disk.readFile(file, limit),
    readdir: (directory) => disk.readdir(directory)
  }
}

describe('removing an authority file', () => {
  it('removes the thread file and says so; a reader then sees none', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    await files.write(record('thread-1'))
    await files.write(record('thread-2'))

    expect(await files.remove('thread-1')).toBe(true)

    expect(await files.read('thread-1')).toEqual({ kind: 'none' })
    expect(await files.read('thread-2')).toEqual({ kind: 'held', record: record('thread-2') })
    expect(fs.readdirSync(threadAuthorityDirectory(root))).toEqual(['thread-2.json'])
  })

  it('says there was nothing to remove, without failing, when the file or the directory is not there', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    expect(await files.remove('thread-1')).toBe(false)

    await files.write(record('thread-2'))

    expect(await files.remove('thread-1')).toBe(false)
  })

  it('takes a temporary file a crashed write left for the thread with it', async () => {
    const root = profile()
    const files = new ThreadAuthorityFiles(root)
    await files.write(record('thread-1'))
    fs.writeFileSync(`${threadAuthorityFilePath(root, 'thread-1')}.tmp`, 'half')

    await files.remove('thread-1')

    expect(fs.readdirSync(threadAuthorityDirectory(root))).toEqual([])
  })

  it('fails, and does not report a removal, when the file cannot be removed', async () => {
    const disk = seededDisk()
    await new ThreadAuthorityFiles(PROFILE, disk).write(record('thread-1'))
    const stuck: ThreadAuthorityFs = {
      ...boundTo(disk),
      unlink: async () => {
        throw errno('EPERM')
      }
    }

    await expect(new ThreadAuthorityFiles(PROFILE, stuck).remove('thread-1')).rejects.toThrow(
      'EPERM'
    )
  })
})

describe('the steps of a write and of a remove', () => {
  it('writes a temporary file, syncs it, renames it into place, then syncs the directory', async () => {
    const disk = seededDisk()

    await new ThreadAuthorityFiles(PROFILE, disk).write(record('thread-1'))

    expect(disk.steps).toEqual([
      `mkdir ${DIRECTORY}`,
      // The directory was made by this write, so its own name is synced too.
      `syncDirectory ${PROFILE}`,
      `create ${TEMPORARY}`,
      'write',
      'sync',
      'close',
      `rename ${TEMPORARY} -> ${FILE}`,
      `syncDirectory ${DIRECTORY}`
    ])
  })

  it('syncs the profile directory on its first write even when the directory was there, and not again', async () => {
    const disk = seededDisk()
    // Another process made the directory.
    await new ThreadAuthorityFiles(PROFILE, disk).write(record('thread-2'))
    const files = new ThreadAuthorityFiles(PROFILE, disk)
    disk.steps.length = 0

    await files.write(record('thread-1'))
    await files.write(record('thread-1'))

    const written = [
      `create ${TEMPORARY}`,
      'write',
      'sync',
      'close',
      `rename ${TEMPORARY} -> ${FILE}`,
      `syncDirectory ${DIRECTORY}`
    ]
    expect(disk.steps).toEqual([
      `mkdir ${DIRECTORY}`,
      `syncDirectory ${PROFILE}`,
      ...written,
      `mkdir ${DIRECTORY}`,
      ...written
    ])
  })

  it('syncs the profile directory again on the next write when that sync failed', async () => {
    const disk = seededDisk()
    let failures = 1
    const flaky: ThreadAuthorityFs = {
      ...boundTo(disk),
      syncDirectory: async (directory) => {
        if (directory === PROFILE && failures > 0) {
          failures -= 1
          throw errno('EIO')
        }
        await disk.syncDirectory(directory)
      }
    }
    const files = new ThreadAuthorityFiles(PROFILE, flaky)
    await expect(files.write(record('thread-1'))).rejects.toThrow('EIO')
    disk.steps.length = 0

    await files.write(record('thread-1'))

    expect(disk.steps.slice(0, 2)).toEqual([`mkdir ${DIRECTORY}`, `syncDirectory ${PROFILE}`])
  })

  it('syncs every directory it had to make, from the first missing one down', async () => {
    const disk = new CrashDisk()

    await new ThreadAuthorityFiles(PROFILE, disk).write(record('thread-1'))

    expect(disk.steps.slice(0, 3)).toEqual([
      `mkdir ${DIRECTORY}`,
      `syncDirectory ${ROOT}`,
      `syncDirectory ${PROFILE}`
    ])
    for (const crash of CRASHES) {
      expect(await new ThreadAuthorityFiles(PROFILE, disk.after(crash)).read('thread-1')).toEqual({
        kind: 'held',
        record: record('thread-1')
      })
    }
  })

  it('removes the name, and any temporary file with it, then syncs the directory', async () => {
    const disk = seededDisk()
    const files = new ThreadAuthorityFiles(PROFILE, disk)
    await files.write(record('thread-1'))
    disk.steps.length = 0

    await files.remove('thread-1')

    expect(disk.steps).toEqual([
      `unlink ${FILE}`,
      `unlink ${TEMPORARY}`,
      `syncDirectory ${DIRECTORY}`
    ])
  })

  it('syncs the directory on a remove that finds nothing to remove', async () => {
    const disk = seededDisk()
    const files = new ThreadAuthorityFiles(PROFILE, disk)
    await files.write(record('thread-2'))
    disk.steps.length = 0

    expect(await files.remove('thread-1')).toBe(false)

    // An earlier remove may have taken the name away and stopped before its sync.
    expect(disk.steps).toEqual([
      `unlink ${FILE}`,
      `unlink ${TEMPORARY}`,
      `syncDirectory ${DIRECTORY}`
    ])
  })

  it('syncs the directory before it lists it, and reads one file without syncing', async () => {
    const disk = seededDisk()
    const files = new ThreadAuthorityFiles(PROFILE, disk)
    await files.write(record('thread-1'))
    disk.steps.length = 0

    await files.read('thread-1')
    expect(disk.steps).toEqual([])
    await files.list()
    expect(disk.steps).toEqual([`syncDirectory ${DIRECTORY}`])
  })

  it('closes the temporary file and removes it when a step of the write fails', async () => {
    const disk = seededDisk()
    const closed: string[] = []
    const failing: ThreadAuthorityFs = {
      ...boundTo(disk),
      create: async (file) => {
        const handle = await disk.create(file)
        return {
          write: (text) => handle.write(text),
          sync: async () => {
            throw errno('EIO')
          },
          close: async () => {
            closed.push(file)
            await handle.close()
          }
        }
      }
    }

    await expect(
      new ThreadAuthorityFiles(PROFILE, failing).write(record('thread-1'))
    ).rejects.toThrow('EIO')

    expect(closed).toEqual([TEMPORARY])
    expect(await disk.readdir(DIRECTORY)).toEqual([])
    expect(await new ThreadAuthorityFiles(PROFILE, disk).read('thread-1')).toEqual({ kind: 'none' })
  })
})

describe('a crash at each step', () => {
  const first = record('thread-1')
  const second = record('thread-1', {
    writer: { writerId: 'writer-b', pid: 5151 },
    epoch: { host: 'host-2', grant: 1 },
    grantedAtRevision: 40
  })

  it('of a first write leaves no file or the whole file, and the whole file once the write returned', async () => {
    const seen = new Set<string>()
    const total = await atEveryStop(
      async () => seededDisk(),
      (files) => files.write(first),
      async (after, stop) => {
        const read = await after.read('thread-1')
        seen.add(read.kind)
        if (stop.steps === stop.of)
          expect(read, JSON.stringify(stop)).toEqual({ kind: 'held', record: first })
        else if (read.kind !== 'none')
          expect(read, JSON.stringify(stop)).toEqual({ kind: 'held', record: first })
        // Whatever was left, a listing agrees with the read and meets nothing damaged.
        expect(await after.list(), JSON.stringify(stop)).toEqual(
          read.kind === 'none' ? [] : [{ threadId: 'thread-1', read }]
        )
      }
    )
    expect(total).toBe(8)
    expect([...seen].sort()).toEqual(['held', 'none'])
  })

  it('of a write over an earlier file leaves the earlier file or the new one, never neither', async () => {
    const seen = new Set<string>()
    const total = await atEveryStop(
      async () => {
        const disk = seededDisk()
        await new ThreadAuthorityFiles(PROFILE, disk).write(first)
        return disk
      },
      (files) => files.write(second),
      async (after, stop) => {
        const read = await after.read('thread-1')
        expect(read.kind, JSON.stringify(stop)).toBe('held')
        const found = (read as { record: ThreadAuthorityRecord }).record
        seen.add(found.writer.writerId)
        if (stop.steps === stop.of) expect(found, JSON.stringify(stop)).toEqual(second)
        else expect([first, second], JSON.stringify(stop)).toContainEqual(found)
      }
    )
    expect(total).toBe(8)
    expect([...seen].sort()).toEqual(['writer-a', 'writer-b'])
  })

  it('of a remove leaves the file or no file, and no file once the remove returned', async () => {
    const seen = new Set<string>()
    const total = await atEveryStop(
      async () => {
        const disk = seededDisk()
        await new ThreadAuthorityFiles(PROFILE, disk).write(first)
        return disk
      },
      (files) => files.remove('thread-1'),
      async (after, stop) => {
        const read = await after.read('thread-1')
        seen.add(read.kind)
        if (stop.steps === stop.of) expect(read, JSON.stringify(stop)).toEqual({ kind: 'none' })
        else if (read.kind !== 'none')
          expect(read, JSON.stringify(stop)).toEqual({ kind: 'held', record: first })
      }
    )
    expect(total).toBe(3)
    expect([...seen].sort()).toEqual(['held', 'none'])
  })

  it('of a write that follows a crashed one starts from a clean temporary file', async () => {
    const disk = seededDisk()
    // Stopped after the temporary file was written and synced, before the rename.
    disk.stopAfter(6)
    await new ThreadAuthorityFiles(PROFILE, disk).write(first).catch(() => undefined)
    const restarted = disk.after('process killed')
    expect(await restarted.readdir(DIRECTORY)).toEqual(['thread-1.json.tmp'])

    await new ThreadAuthorityFiles(PROFILE, restarted).write(second)

    expect(await new ThreadAuthorityFiles(PROFILE, restarted).read('thread-1')).toEqual({
      kind: 'held',
      record: second
    })
    expect(await restarted.readdir(DIRECTORY)).toEqual(['thread-1.json'])
  })

  it('of a write that made the directory, before it synced the name, cannot cost a later write its file', async () => {
    const disk = seededDisk()
    disk.stopAt(`syncDirectory ${PROFILE}`)
    await new ThreadAuthorityFiles(PROFILE, disk).write(first).catch(() => undefined)
    const restarted = disk.after('process killed')
    expect(await restarted.readdir(DIRECTORY)).toEqual([])

    await new ThreadAuthorityFiles(PROFILE, restarted).write(second)

    for (const crash of CRASHES) {
      expect(
        await new ThreadAuthorityFiles(PROFILE, restarted.after(crash)).read('thread-1'),
        crash
      ).toEqual({ kind: 'held', record: second })
    }
  })

  it('of a remove, after the unlink and before the sync, is made durable by removing again', async () => {
    const disk = seededDisk()
    await new ThreadAuthorityFiles(PROFILE, disk).write(first)
    disk.stopAt(`syncDirectory ${DIRECTORY}`)
    await new ThreadAuthorityFiles(PROFILE, disk).remove('thread-1').catch(() => undefined)
    const restarted = disk.after('process killed')
    const files = new ThreadAuthorityFiles(PROFILE, restarted)
    expect(await files.read('thread-1')).toEqual({ kind: 'none' })
    // A power loss now would bring the file back.
    expect(
      await new ThreadAuthorityFiles(PROFILE, restarted.after('power lost')).read('thread-1')
    ).toEqual({ kind: 'held', record: first })

    expect(await files.remove('thread-1')).toBe(false)

    for (const crash of CRASHES) {
      expect(
        await new ThreadAuthorityFiles(PROFILE, restarted.after(crash)).read('thread-1'),
        crash
      ).toEqual({ kind: 'none' })
    }
  })

  it('of a write or a remove is made durable by a listing before it answers', async () => {
    const disk = seededDisk()
    await new ThreadAuthorityFiles(PROFILE, disk).write(record('thread-removed'))
    // A remove stopped after its unlink, then a first write stopped after its rename.
    disk.stopAt(`syncDirectory ${DIRECTORY}`)
    await new ThreadAuthorityFiles(PROFILE, disk).remove('thread-removed').catch(() => undefined)
    const between = disk.after('process killed')
    between.stopAt(`syncDirectory ${DIRECTORY}`)
    await new ThreadAuthorityFiles(PROFILE, between)
      .write(record('thread-written'))
      .catch(() => undefined)
    const restarted = between.after('process killed')
    const threads = async (disk: CrashDisk): Promise<string[]> =>
      (await new ThreadAuthorityFiles(PROFILE, disk).list()).map((entry) => entry.threadId)
    // A power loss now would undo both.
    expect(await threads(restarted.after('power lost'))).toEqual(['thread-removed'])

    expect(await threads(restarted)).toEqual(['thread-written'])

    for (const crash of CRASHES) {
      expect(await threads(restarted.after(crash)), crash).toEqual(['thread-written'])
    }
  })
})

describe('whether a writer is still running', () => {
  it('finds this process alive', () => {
    expect(threadWriterLiveness({ pid: process.pid })).toBe('alive')
  })

  it('finds a process dead only when the system says there is none', () => {
    const probed: number[] = []
    expect(
      threadWriterLiveness({ pid: 4242 }, (pid) => {
        probed.push(pid)
        throw errno('ESRCH')
      })
    ).toBe('dead')
    expect(probed).toEqual([4242])
  })

  it.each(['EPERM', 'EINVAL', undefined])(
    'leaves it unresolved when the probe fails with %s',
    (code) => {
      expect(
        threadWriterLiveness({ pid: 4242 }, () => {
          throw code ? errno(code) : new Error('no code')
        })
      ).toBe('unresolved')
    }
  )

  it.each([0, 1, -1, -4242, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'leaves the process id %j unresolved without signalling anything',
    (pid) => {
      const probed: number[] = []
      expect(threadWriterLiveness({ pid }, (probedPid) => probed.push(probedPid))).toBe(
        'unresolved'
      )
      expect(probed).toEqual([])
    }
  )
})

describe('where the work runs', () => {
  it('imports no synchronous filesystem module', () => {
    const file = path.resolve(process.cwd(), 'src/host-shared/thread-log/ThreadAuthorityFile.ts')
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true
    )
    const imported: string[] = []
    source.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imported.push(node.moduleSpecifier.text)
      }
    })
    expect(imported).toContain('node:fs/promises')
    expect(imported.filter((name) => name === 'node:fs' || name === 'fs')).toEqual([])
  })

  it('returns to the event loop while a write is in flight', async () => {
    const root = profile()
    let turned = false
    const turn = new Promise<void>((resolve) =>
      setImmediate(() => {
        turned = true
        resolve()
      })
    )

    const write = new ThreadAuthorityFiles(root).write(record('thread-1')).then(() => turned)
    await turn

    expect(await write).toBe(true)
  })
})
