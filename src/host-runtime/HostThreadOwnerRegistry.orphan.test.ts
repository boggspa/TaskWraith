import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ThreadAuthorityFiles,
  threadAuthorityFilePath,
  type ThreadAuthorityFileHandle,
  type ThreadAuthorityFs
} from '../host-shared/thread-log/ThreadAuthorityFile'
import type { HostDesktopPresence } from '../host-shared/thread-log/ThreadOwnership'
import { HostThreadOwnerRegistry } from './HostThreadOwnerRegistry'

const THREAD = 'thread-1'
/** Never touched on disk: the in-memory filesystem below stands for it. */
const PROFILE = path.join(path.sep, 'profile')

function missing(): Error {
  return Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
}

/**
 * The authority files' disk, in memory. A name put in place or taken away
 * lasts through a power loss only once its directory has been synced, as on a
 * real disk.
 */
class MemoryFs implements ThreadAuthorityFs {
  private names = new Map<string, string>()
  private durable = new Map<string, string>()
  private readonly directories = new Set([PROFILE])
  /** While set, every read waits for it. */
  hold: Promise<void> | null = null
  /** Forces the next directory sync to throw. */
  failNextSync = false
  reads = 0

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
    if (this.failNextSync) {
      this.failNextSync = false
      throw new Error('forced sync failure')
    }
    if (!this.directories.has(directory)) throw missing()
    for (const name of [...this.durable.keys()]) {
      if (path.dirname(name) === directory && !this.names.has(name)) this.durable.delete(name)
    }
    for (const [name, text] of this.names) {
      if (path.dirname(name) === directory) this.durable.set(name, text)
    }
  }

  async readFile(file: string, limit: number): Promise<string> {
    this.reads += 1
    await this.hold
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

  /** Replace the file's bytes with torn contents. */
  scribble(file: string, text: string): void {
    this.names.set(file, text)
    this.durable.set(file, text)
  }

  /** Whether the file is currently in the live (not-yet-synced) view. */
  presence(file: string): boolean {
    return this.names.has(file)
  }
}

/** A witness that mirrors `threadPublicationAuthorityWitness` for the in-memory FS. */
function makeWitness(memory: MemoryFs): (threadId: string) => () => boolean {
  return (threadId: string) => {
    const file = threadAuthorityFilePath(PROFILE, threadId)
    const before = memory.presence(file) ? 'present' : 'missing'
    return () => {
      const now = memory.presence(file) ? 'present' : 'missing'
      return before === now
    }
  }
}

class Machine {
  readonly files: ThreadAuthorityFiles
  readonly fileSystem: MemoryFs
  readonly full = new Map<string, number>()
  readonly desks = new Map<string, { pid: number; attached: boolean }>()
  /** Pids whose liveness cannot be decided. */
  readonly unresolved = new Set<number>()
  /** Times the directory sync threw, so tests can assert the policy reacted. */
  readonly syncFailures = 0

  constructor(fileSystem: MemoryFs = new MemoryFs(), profile = PROFILE) {
    this.fileSystem = fileSystem
    this.files = new ThreadAuthorityFiles(profile, fileSystem)
  }

  start(writerId: string, pid: number, attached = true): void {
    this.desks.set(writerId, { pid, attached })
  }

  end(writerId: string): void {
    this.desks.delete(writerId)
  }

  presence(): HostDesktopPresence {
    const desks = [...this.desks.values()]
    if (desks.length === 0) return 'none'
    return desks.every((desk) => desk.attached) ? 'attached' : 'unattached'
  }

  host(incarnation = 'host-a', enabled = true): HostThreadOwnerRegistry {
    return new HostThreadOwnerRegistry({
      incarnation,
      enabled,
      files: this.files,
      fullCopyRevision: (threadId) => this.full.get(threadId) ?? null,
      // Orphan retirement does not need the log revision; the registry calls
      // it before any log-read happens. Returning null here keeps the test
      // focused on the authority-file retirement path.
      logRevision: async () => null,
      hostRunActive: () => false,
      // A publication witness that reads the in-memory FS: when the mark
      // is gone after the operation, the witness reports a change; while the
      // mark is still present, the witness reports unchanged. This matches
      // the real `threadPublicationAuthorityWitness` semantics.
      publicationWitness: makeWitness(this.fileSystem),
      desktopPresence: () => this.presence(),
      otherDesktopUnattached: () => false,
      liveness: ({ pid }) => {
        if (this.unresolved.has(pid)) return 'unresolved'
        return [...this.desks.values()].some((desk) => desk.pid === pid) ? 'alive' : 'dead'
      }
    })
  }

  /** A writer's authority mark on disk. */
  async marks(writerId: string, epoch: { host: string; grant: number }): Promise<void> {
    await this.files.write({
      threadId: THREAD,
      writer: { writerId, pid: this.desks.get(writerId)!.pid },
      epoch,
      grantedAtRevision: this.full.get(THREAD) ?? 0,
      grantedAt: 1_000
    })
  }
}

describe('HostThreadOwnerRegistry.orphan authority retirement', () => {
  it('retires a dead writer’s caught-up mark when the reservation matches', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    const outcome = await host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 1 })
    expect(outcome).toEqual({ kind: 'retired' })
    expect((await machine.files.read(THREAD)).kind).toBe('none')
  })

  it('returns retired immediately when no mark exists on disk', async () => {
    const machine = new Machine()
    const host = machine.host()
    const outcome = await host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 1 })
    expect(outcome).toEqual({ kind: 'retired' })
  })

  it('refuses when the reservation does not match the recorded epoch', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    const outcome = await host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 99 })
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('refuses when the writer is still alive', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    const host = machine.host()
    const outcome = await host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 1 })
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_writer' })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('refuses when the file cannot be read', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    memory.scribble(threadAuthorityFilePath(PROFILE, THREAD), '{damaged')
    const host = machine.host()
    const outcome = await host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 1 })
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
  })

  it('returns busy-damaged when the registry is disabled', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host('host-a', false)
    const outcome = await host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 1 })
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('returns uncertain when the directory sync fails and leaves the mark unlinked', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    memory.failNextSync = true
    const host = machine.host()
    const outcome = await host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 1 })
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'remove_failed' })
    // The mark was unlinked; only the directory sync failed. A later
    // restart would re-list the durably-stored file (none), so the policy
    // does not paper over the problem.
    expect((await machine.files.read(THREAD)).kind).toBe('none')
  })

  it('serializes with a queued request on the same thread', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    let finish!: () => void
    memory.hold = new Promise<void>((resolve) => {
      finish = resolve
    })
    const retiring = host.retireOrphanAuthority(THREAD, { host: 'host-a', grant: 1 })
    const reread = machine.files.read(THREAD)
    memory.hold = null
    finish()
    const [outcome] = await Promise.all([retiring, reread])
    expect(outcome).toEqual({ kind: 'retired' })
    expect((await machine.files.read(THREAD)).kind).toBe('none')
  })
})
