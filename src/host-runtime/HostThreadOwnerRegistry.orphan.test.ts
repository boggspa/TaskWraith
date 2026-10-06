import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ThreadAuthorityFiles,
  threadAuthorityFilePath,
  type ThreadAuthorityFileHandle,
  type ThreadAuthorityFs
} from '../host-shared/thread-log/ThreadAuthorityFile'
import {
  ReservationInvalid,
  type HostDesktopPresence,
  type ThreadOwnershipReservation
} from '../host-shared/thread-log/ThreadOwnership'
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

/** A caller-built reservation that is not minted by the registry. */
function foreignReservation(
  epoch: { host: string; grant: number },
  onRevalidate: () => void = () => undefined
): ThreadOwnershipReservation {
  return {
    threadId: THREAD,
    epoch,
    revalidate: onRevalidate,
    erasing: () => false
  }
}

class Machine {
  readonly files: ThreadAuthorityFiles
  readonly fileSystem: MemoryFs
  readonly full = new Map<string, number>()
  readonly desks = new Map<string, { pid: number; attached: boolean }>()
  /** Pids whose liveness cannot be decided. */
  readonly unresolved = new Set<number>()
  /** Whether the catalogue is currently erasing the thread. */
  erasing = false
  /** Current erasure generation; a change invalidates minted reservations. */
  erasureGeneration: string | null = null
  /** Throws when profile authority is asserted. */
  authorityLost = false

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
      erasing: () => this.erasing,
      erasureGeneration: () => this.erasureGeneration,
      assertProfileAuthority: () => {
        if (this.authorityLost) throw new Error('profile authority lost')
      },
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
  it('mints a reservation and retires a dead writer’s caught-up mark with it', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    const reservation = await host.reserveOwnership(THREAD)
    expect(reservation).not.toBeNull()
    expect(reservation!.epoch).toEqual({ host: 'host-a', grant: 1 })
    expect(() => reservation!.revalidate()).not.toThrow()
    const outcome = await host.retireOrphanAuthority(THREAD, reservation!)
    expect(outcome).toEqual({ kind: 'retired' })
    expect((await machine.files.read(THREAD)).kind).toBe('none')
  })

  it('mints no reservation when no mark exists on disk', async () => {
    const machine = new Machine()
    const host = machine.host()
    expect(await host.reserveOwnership(THREAD)).toBeNull()
  })

  it('returns busy damaged (not retired) when the mark is already absent at admission', async () => {
    const machine = new Machine()
    const host = machine.host()
    // A previous sync failure left no file and no recorded debt: the registry
    // cannot vouch for the absence, and must not call it retired.
    const outcome = await host.retireOrphanAuthority(
      THREAD,
      foreignReservation({ host: 'host-a', grant: 1 })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
  })

  it('refuses when the reservation epoch does not match the recorded epoch', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    const outcome = await host.retireOrphanAuthority(
      THREAD,
      foreignReservation({ host: 'host-a', grant: 99 })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('returns busy damaged when the reservation revalidate throws', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    let revalidations = 0
    const reservation = foreignReservation({ host: 'host-a', grant: 1 }, () => {
      revalidations += 1
      throw new ReservationInvalid('mark_moved')
    })
    const outcome = await host.retireOrphanAuthority(THREAD, reservation)
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    // revalidate() runs twice by design: the registry revalidates first to
    // short-circuit 'mark_moved' (so it can fall through and retry the
    // directory sync when the mark is absent and a sync debt is recorded),
    // and the retirement module revalidates again before the final
    // erase check. Both calls observe the same ReservationInvalid.
    expect(revalidations).toBe(2)
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('refuses when the writer is still alive', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    const host = machine.host()
    expect(await host.reserveOwnership(THREAD)).toBeNull()
    const outcome = await host.retireOrphanAuthority(
      THREAD,
      foreignReservation({ host: 'host-a', grant: 1 })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'live_writer' })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('mints no reservation while the catalogue is erasing the thread', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    machine.erasing = true
    const host = machine.host()
    expect(await host.reserveOwnership(THREAD)).toBeNull()
    const outcome = await host.retireOrphanAuthority(
      THREAD,
      foreignReservation({ host: 'host-a', grant: 1 })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'erasing' })
  })

  it('mints no reservation when profile authority is lost', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    machine.authorityLost = true
    expect(await host.reserveOwnership(THREAD)).toBeNull()
    // A reservation minted while authority held fails revalidation once the
    // authority lapses.
    machine.authorityLost = false
    const reservation = await host.reserveOwnership(THREAD)
    machine.authorityLost = true
    expect(() => reservation!.revalidate()).toThrow(ReservationInvalid)
    const outcome = await host.retireOrphanAuthority(THREAD, reservation!)
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
  })

  it('invalidates a minted reservation when the erasure generation changes', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    machine.erasureGeneration = 'gen-1'
    const host = machine.host()
    const reservation = await host.reserveOwnership(THREAD)
    expect(reservation).not.toBeNull()
    machine.erasureGeneration = 'gen-2'
    expect(() => reservation!.revalidate()).toThrow(ReservationInvalid)
  })

  it('refuses when the file cannot be read', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    memory.scribble(threadAuthorityFilePath(PROFILE, THREAD), '{damaged')
    const host = machine.host()
    expect(await host.reserveOwnership(THREAD)).toBeNull()
    const outcome = await host.retireOrphanAuthority(
      THREAD,
      foreignReservation({ host: 'host-a', grant: 1 })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
  })

  it('returns busy damaged when the registry is disabled', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host('host-a', false)
    expect(await host.reserveOwnership(THREAD)).toBeNull()
    const outcome = await host.retireOrphanAuthority(
      THREAD,
      foreignReservation({ host: 'host-a', grant: 1 })
    )
    expect(outcome).toEqual({ kind: 'busy', reason: 'damaged' })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('returns uncertain sync_failed when the directory sync fails and leaves the mark unlinked', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    memory.failNextSync = true
    const host = machine.host()
    const reservation = await host.reserveOwnership(THREAD)
    const outcome = await host.retireOrphanAuthority(THREAD, reservation!)
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'sync_failed' })
    // The mark was unlinked; only the directory sync failed. The registry
    // records the debt so the next call retries the sync instead of
    // reporting damage.
    expect((await machine.files.read(THREAD)).kind).toBe('none')
  })

  it('retries the directory sync on the next call when a previous sync failed', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    memory.failNextSync = true
    const host = machine.host()
    const reservation = await host.reserveOwnership(THREAD)
    expect(await host.retireOrphanAuthority(THREAD, reservation!)).toEqual({
      kind: 'uncertain',
      reason: 'sync_failed'
    })
    // The mark is gone but its absence is not durable. The retry syncs the
    // directory even though there is nothing left to unlink, and only then
    // calls the retirement durable.
    expect(await host.retireOrphanAuthority(THREAD, reservation!)).toEqual({ kind: 'retired' })
    expect((await machine.files.read(THREAD)).kind).toBe('none')
  })

  it('revalidates a minted reservation across the serial queue boundary', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    const reservation = await host.reserveOwnership(THREAD)
    // Stall the retirement's file read inside the serial queue; while it
    // waits, the catalogue's erasure generation moves. The retirement must
    // notice through the reservation's revalidate — re-run after the async
    // boundary — even though admission passed.
    let finish!: () => void
    memory.hold = new Promise<void>((resolve) => {
      finish = resolve
    })
    const retiring = host.retireOrphanAuthority(THREAD, reservation!)
    machine.erasureGeneration = 'gen-2'
    memory.hold = null
    finish()
    const outcome = await retiring
    // The reservation surfaces the more specific reason: an erasure generation
    // that changed since mint is `erasing`, not a flat `damaged`.
    expect(outcome).toEqual({ kind: 'busy', reason: 'erasing' })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
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
    const reserving = host.reserveOwnership(THREAD)
    const reread = machine.files.read(THREAD)
    memory.hold = null
    finish()
    const [reservation] = await Promise.all([reserving, reread])
    expect(reservation).not.toBeNull()
    const outcome = await host.retireOrphanAuthority(THREAD, reservation!)
    expect(outcome).toEqual({ kind: 'retired' })
    expect((await machine.files.read(THREAD)).kind).toBe('none')
  })
})

describe('HostThreadOwnerRegistry reservation brand', () => {
  it('mints a reservation stamped with the brand', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    const reservation = await host.reserveOwnership(THREAD)
    expect(reservation).not.toBeNull()
    // The brand slot distinguishes a registry-minted reservation from a
    // foreign one (built directly via ThreadOwnershipReservation, e.g. a
    // test stub or a future `endOrphanViaReservation` foreign path).
    expect(
      (reservation as Record<symbol, unknown>)[
        Symbol.for('taskwraith.thread-ownership-reservation.brand')
      ]
    ).toBe(true)
  })

  it('foreign reservations do not carry the brand', () => {
    const foreign = foreignReservation({ host: 'host-a', grant: 1 })
    expect(
      (foreign as Record<symbol, unknown>)[
        Symbol.for('taskwraith.thread-ownership-reservation.brand')
      ]
    ).toBeUndefined()
  })
})
