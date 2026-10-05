import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  THREAD_AUTHORITY_FORMAT,
  THREAD_AUTHORITY_MAX_BYTES,
  THREAD_AUTHORITY_VERSION,
  ThreadAuthorityFiles,
  threadAuthorityFilePath,
  type ThreadAuthorityFileHandle,
  type ThreadAuthorityFs,
  type ThreadAuthorityRecord
} from '../host-shared/thread-log/ThreadAuthorityFile'
import { HostThreadOwnerRegistry } from './HostThreadOwnerRegistry'

const THREAD = 'thread-1'
/** Never touched on disk: the in-memory filesystem below stands for it. */
const PROFILE = path.join(path.sep, 'profile')
const MARK = threadAuthorityFilePath(PROFILE, THREAD)

/**
 * A mark as the writer that introduced the authority file wrote it, byte for
 * byte. The file's format has not changed since: the opaque ownership
 * reservation added by I7 lives in the Host's memory and wraps the epoch, it
 * is never serialized. Any change to these bytes, or to the reader's verdict
 * on them, is a compatibility break with a Host or app that is still running
 * the earlier build over the same profile.
 */
const GOLDEN =
  '{"format":"taskwraith.thread-authority","version":1,"threadId":"thread-1",' +
  '"writer":{"writerId":"desk-a","pid":4101},"epoch":{"host":"host-a","grant":3},' +
  '"grantedAtRevision":4,"grantedAt":1000}\n'

const GOLDEN_RECORD: ThreadAuthorityRecord = {
  threadId: THREAD,
  writer: { writerId: 'desk-a', pid: 4101 },
  epoch: { host: 'host-a', grant: 3 },
  grantedAtRevision: 4,
  grantedAt: 1_000
}

function missing(): Error {
  return Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
}

class MemoryFs implements ThreadAuthorityFs {
  private readonly names = new Map<string, string>()
  private readonly directories = new Set([PROFILE])

  async mkdir(directory: string): Promise<string | undefined> {
    if (this.directories.has(directory)) return undefined
    this.directories.add(directory)
    return directory
  }

  async create(file: string): Promise<ThreadAuthorityFileHandle> {
    this.names.set(file, '')
    return {
      write: async (text) => {
        this.names.set(file, `${this.names.get(file) ?? ''}${text}`)
      },
      sync: async () => undefined,
      close: async () => undefined
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const text = this.names.get(from)
    if (text === undefined) throw missing()
    this.names.delete(from)
    this.names.set(to, text)
  }

  async unlink(file: string): Promise<void> {
    if (!this.names.delete(file)) throw missing()
  }

  async syncDirectory(directory: string): Promise<void> {
    if (!this.directories.has(directory)) throw missing()
  }

  async readFile(file: string, limit: number): Promise<string> {
    const text = this.names.get(file)
    if (text === undefined) throw missing()
    return text.slice(0, limit)
  }

  async readdir(directory: string): Promise<string[]> {
    if (!this.directories.has(directory)) throw missing()
    return [...this.names.keys()]
      .filter((name) => path.dirname(name) === directory)
      .map((name) => path.basename(name))
  }

  /** Put bytes in place directly, as another build's writer would have left them. */
  put(file: string, text: string): void {
    this.directories.add(path.dirname(file))
    this.names.set(file, text)
  }

  text(file: string): string | undefined {
    return this.names.get(file)
  }
}

/** The golden mark with its fields edited, as JSON text. */
function variant(edit: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(GOLDEN) as Record<string, unknown>
  edit(value)
  return `${JSON.stringify(value)}\n`
}

describe('ThreadAuthorityFile on-disk compatibility', () => {
  it('pins the format constants an older build also reads', () => {
    expect(THREAD_AUTHORITY_FORMAT).toBe('taskwraith.thread-authority')
    expect(THREAD_AUTHORITY_VERSION).toBe(1)
    expect(THREAD_AUTHORITY_MAX_BYTES).toBe(16 * 1024)
  })

  it('reads a mark exactly as the earlier build wrote it', async () => {
    const memory = new MemoryFs()
    memory.put(MARK, GOLDEN)
    const read = await new ThreadAuthorityFiles(PROFILE, memory).read(THREAD)
    expect(read).toEqual({ kind: 'held', record: GOLDEN_RECORD })
  })

  it('writes the same bytes, so an earlier build reads what this one writes', async () => {
    const memory = new MemoryFs()
    const files = new ThreadAuthorityFiles(PROFILE, memory)
    await files.write(GOLDEN_RECORD)
    expect(memory.text(MARK)).toBe(GOLDEN)
    // Nothing of the in-memory reservation (opaque handle, probes) is serialized.
    expect(Object.keys(JSON.parse(memory.text(MARK)!))).toEqual([
      'format',
      'version',
      'threadId',
      'writer',
      'epoch',
      'grantedAtRevision',
      'grantedAt'
    ])
  })

  it('round-trips a record through write and read unchanged', async () => {
    const files = new ThreadAuthorityFiles(PROFILE, new MemoryFs())
    await files.write(GOLDEN_RECORD)
    expect(await files.read(THREAD)).toEqual({ kind: 'held', record: GOLDEN_RECORD })
  })
})

describe('ThreadAuthorityFile reading a mark from a different build', () => {
  // The reader is strict on purpose: "anything that is there and cannot be
  // understood is reported as damaged", because a mark mistaken for no mark
  // would let someone else write an owned thread. So a newer build's extra
  // field is NOT ignored; it fails closed.
  const cases: Array<[string, string, string]> = [
    ['a forward-incompatible version', variant((v) => (v.version = 2)), 'unknown version'],
    ['another format', variant((v) => (v.format = 'taskwraith.other')), 'unknown format'],
    [
      'fields of a later shape beside the known ones',
      variant((v) => {
        v.logRevision = 9
        v.checkpointRevision = 8
        v.logHeadSha256 = 'a'.repeat(64)
        v.createdAt = 1_000
      }),
      'unknown field'
    ],
    ['a single extra top-level field', variant((v) => (v.futureField = true)), 'unknown field'],
    [
      'an extra field inside the writer',
      variant((v) => (v.writer = { writerId: 'desk-a', pid: 4101, session: 's' })),
      'invalid writer'
    ],
    [
      'an extra field inside the epoch',
      variant((v) => (v.epoch = { host: 'host-a', grant: 3, lease: 1 })),
      'invalid epoch'
    ],
    ['a missing required field', variant((v) => delete v.grantedAt), 'invalid grant time'],
    [
      'a mark that names another thread',
      variant((v) => (v.threadId = 'thread-2')),
      'names another thread'
    ],
    ['bytes cut off mid-record', GOLDEN.slice(0, 60), 'not JSON'],
    ['a file far larger than any record', ' '.repeat(THREAD_AUTHORITY_MAX_BYTES + 1), 'too large']
  ]

  it.each(cases)('reports %s as damaged and leaves the file alone', async (_name, text, reason) => {
    const memory = new MemoryFs()
    memory.put(MARK, text)
    const files = new ThreadAuthorityFiles(PROFILE, memory)
    expect(await files.read(THREAD)).toEqual({ kind: 'damaged', reason })
    // Reading is never destructive: the other build's mark survives for it.
    expect(memory.text(MARK)).toBe(text)
  })

  it('lists a mark of each build side by side without hiding either', async () => {
    const memory = new MemoryFs()
    memory.put(MARK, GOLDEN)
    memory.put(
      threadAuthorityFilePath(PROFILE, 'thread-2'),
      variant((v) => {
        v.threadId = 'thread-2'
        v.version = 2
      })
    )
    const entries = await new ThreadAuthorityFiles(PROFILE, memory).list()
    expect(entries).toEqual([
      { threadId: 'thread-1', read: { kind: 'held', record: GOLDEN_RECORD } },
      { threadId: 'thread-2', read: { kind: 'damaged', reason: 'unknown version' } }
    ])
  })
})

describe('HostThreadOwnerRegistry over a mark it cannot understand', () => {
  function hostOver(memory: MemoryFs): HostThreadOwnerRegistry {
    return new HostThreadOwnerRegistry({
      incarnation: 'host-b',
      enabled: true,
      files: new ThreadAuthorityFiles(PROFILE, memory),
      fullCopyRevision: () => 4,
      logRevision: async () => null,
      hostRunActive: () => false,
      desktopPresence: () => 'attached',
      otherDesktopUnattached: () => false
    })
  }

  it('keeps the thread with its unknown writer: rebuild reports damage and no claim is granted', async () => {
    const memory = new MemoryFs()
    memory.put(
      MARK,
      variant((v) => (v.version = 2))
    )
    const host = hostOver(memory)
    expect(await host.rebuild()).toEqual({ held: [], fold: [], damaged: [THREAD] })
    expect(
      await host.claim({
        action: 'claim',
        threadId: THREAD,
        writerId: 'desk-b',
        claimId: 1,
        baseRevision: 4,
        headRevision: 4
      })
    ).toMatchObject({ granted: false, reason: 'owned_by_other_writer', revision: 4 })
    expect(await host.reserveOwnership(THREAD)).toBeNull()
    // Nor does the Host write over it.
    expect((await host.requestHostWrite(THREAD, 1_000)).kind).toBe('busy')
    expect(memory.text(MARK)).toContain('"version":2')
  })
})
