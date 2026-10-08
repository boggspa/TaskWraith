import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  THREAD_AUTHORITY_FORMAT,
  THREAD_AUTHORITY_VERSION,
  ThreadAuthorityFiles,
  threadAuthorityFilePath,
  type ThreadAuthorityFileHandle,
  type ThreadAuthorityFs
} from '../host-shared/thread-log/ThreadAuthorityFile'
import {
  ReservationInvalid,
  type HostDesktopPresence,
  type ThreadClaimReply,
  type ThreadClaimRequest,
  type ThreadOwnerEpoch
} from '../host-shared/thread-log/ThreadOwnership'
import { HostThreadOwnerRegistry } from './HostThreadOwnerRegistry'

const THREAD = 'thread-1'
/** Never touched on disk: the in-memory filesystem below stands for it. */
const PROFILE = path.resolve(path.sep, 'profile')
const MARK = threadAuthorityFilePath(PROFILE, THREAD)
const FULL_COPY = 4

function missing(): Error {
  return Object.assign(new Error('no such file or directory'), { code: 'ENOENT' })
}

/**
 * The authority files' disk, in memory. A name put in place or taken away
 * lasts through a power loss only once its directory has been synced, as on a
 * real disk. Same shape as the disk in `HostThreadOwnerRegistry.orphan.test.ts`,
 * plus a hook that fires when a name is unlinked, so a test can have a
 * competing writer recreate the mark between the unlink and the witness read.
 */
class MemoryFs implements ThreadAuthorityFs {
  private names = new Map<string, string>()
  private durable = new Map<string, string>()
  private readonly directories = new Set([PROFILE])
  /** While set, every read waits for it. */
  hold: Promise<void> | null = null
  /** Runs once, right after the next unlink of the mark itself. */
  afterMarkUnlink: (() => void) | null = null

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
    if (file === MARK && this.afterMarkUnlink) {
      const hook = this.afterMarkUnlink
      this.afterMarkUnlink = null
      hook()
    }
  }

  async syncDirectory(directory: string): Promise<void> {
    if (!this.directories.has(directory)) throw missing()
    for (const name of [...this.durable.keys()]) {
      if (path.dirname(name) === directory && !this.names.has(name)) this.durable.delete(name)
    }
    for (const [name, text] of this.names) {
      if (path.dirname(name) === directory) this.durable.set(name, text)
    }
  }

  async readFile(file: string, limit: number): Promise<string> {
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

  /** Put bytes in place directly, as a writer that stopped mid-step leaves them. */
  scribble(file: string, text: string): void {
    this.directories.add(path.dirname(file))
    this.names.set(file, text)
    this.durable.set(file, text)
  }

  /** Whether the name is currently in the live (not-yet-synced) view. */
  presence(file: string): boolean {
    return this.names.has(file)
  }

  /** The mark as a competing writer would have written it. */
  setMark(writerId: string, pid: number, epoch: ThreadOwnerEpoch): void {
    this.names.set(
      MARK,
      `${JSON.stringify({
        format: THREAD_AUTHORITY_FORMAT,
        version: THREAD_AUTHORITY_VERSION,
        threadId: THREAD,
        writer: { writerId, pid },
        epoch,
        grantedAtRevision: FULL_COPY,
        grantedAt: 2_000
      })}\n`
    )
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
  readonly full = new Map<string, number>([[THREAD, FULL_COPY]])
  readonly desks = new Map<string, { pid: number; attached: boolean }>()
  /** Pids whose liveness cannot be decided. */
  readonly unresolved = new Set<number>()

  constructor(fileSystem: MemoryFs = new MemoryFs()) {
    this.fileSystem = fileSystem
    this.files = new ThreadAuthorityFiles(PROFILE, fileSystem)
  }

  start(writerId: string, pid: number): void {
    this.desks.set(writerId, { pid, attached: true })
  }

  end(writerId: string): void {
    this.desks.delete(writerId)
  }

  presence(): HostDesktopPresence {
    return this.desks.size === 0 ? 'none' : 'attached'
  }

  /** A Host process. A new incarnation over the same files is a Host restart. */
  host(incarnation = 'host-a'): HostThreadOwnerRegistry {
    return new HostThreadOwnerRegistry({
      incarnation,
      enabled: true,
      files: this.files,
      fullCopyRevision: (threadId) => this.full.get(threadId) ?? null,
      logRevision: async () => null,
      hostRunActive: () => false,
      publicationWitness: makeWitness(this.fileSystem),
      desktopPresence: () => this.presence(),
      otherDesktopUnattached: () => false,
      erasing: () => false,
      erasureGeneration: () => null,
      assertProfileAuthority: () => undefined,
      liveness: ({ pid }) => {
        if (this.unresolved.has(pid)) return 'unresolved'
        return [...this.desks.values()].some((desk) => desk.pid === pid) ? 'alive' : 'dead'
      }
    })
  }

  /** A writer's authority mark on disk. */
  async marks(writerId: string, epoch: ThreadOwnerEpoch): Promise<void> {
    await this.files.write({
      threadId: THREAD,
      writer: { writerId, pid: this.desks.get(writerId)!.pid },
      epoch,
      grantedAtRevision: FULL_COPY,
      grantedAt: 1_000
    })
  }
}

function claimRequest(writerId: string, claimId = 1): ThreadClaimRequest {
  return {
    action: 'claim',
    threadId: THREAD,
    writerId,
    claimId,
    baseRevision: FULL_COPY,
    headRevision: FULL_COPY
  }
}

/** The grant a claim won; fails the test when it was refused. */
function grantOf(reply: ThreadClaimReply): ThreadOwnerEpoch {
  if (!reply.granted) throw new Error(`claim refused: ${reply.reason}`)
  return reply.epoch
}

function invalidReason(probe: () => void): string | null {
  try {
    probe()
  } catch (error) {
    if (error instanceof ReservationInvalid) return error.reason
    throw error
  }
  return null
}

describe('HostThreadOwnerRegistry disconnects', () => {
  it('retires the mark of a writer that died holding a grant it never saw answered', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    const hostA = machine.host('host-a')
    const grants: ThreadOwnerEpoch[] = []
    const reply = await hostA.claim(claimRequest('desk-a'), {
      isCurrent: () => true,
      granted: (epoch) => grants.push(epoch)
    })
    const epoch = grantOf(reply)
    expect(epoch).toEqual({ host: 'host-a', grant: 1 })
    expect(grants).toEqual([epoch])
    // The writer marks the thread under the grant, then dies before its
    // reply is delivered or its first append is published.
    await machine.marks('desk-a', epoch)
    machine.end('desk-a')

    // The next Host finds the mark, sees the writer ended, and retires it.
    const hostB = machine.host('host-b')
    expect(await hostB.rebuild()).toEqual({ held: [], fold: [THREAD], damaged: [] })
    const reservation = await hostB.reserveOwnership(THREAD)
    expect(reservation).not.toBeNull()
    // The reservation carries the dead Host's grant: it names the mark, not this Host.
    expect(reservation!.epoch).toEqual({ host: 'host-a', grant: 1 })
    expect(await hostB.retireOrphanAuthority(THREAD, reservation!)).toEqual({ kind: 'retired' })
    expect((await machine.files.read(THREAD)).kind).toBe('none')

    // Durable retirement does not itself release custody: the fold sequence
    // still holds the thread across any trailing directory work until it
    // explicitly lets go. Claims wait for that release.
    expect(await hostB.claim(claimRequest('desk-b'))).toMatchObject({
      granted: false,
      reason: 'owned_by_other_writer'
    })
    expect(hostB.releaseOwnership(reservation!)).toBe(true)

    // The thread is claimable again, under the new Host's own grant numbering.
    machine.start('desk-b', 4102)
    expect(grantOf(await hostB.claim(claimRequest('desk-b')))).toEqual({
      host: 'host-b',
      grant: 1
    })
  })

  it('leaves nothing to retire when the writer dies before it marks the thread', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    const hostA = machine.host('host-a')
    grantOf(await hostA.claim(claimRequest('desk-a')))
    machine.end('desk-a')

    const hostB = machine.host('host-b')
    expect(await hostB.rebuild()).toEqual({ held: [], fold: [], damaged: [] })
    expect(await hostB.reserveOwnership(THREAD)).toBeNull()
    machine.start('desk-b', 4102)
    expect(grantOf(await hostB.claim(claimRequest('desk-b')))).toEqual({
      host: 'host-b',
      grant: 1
    })
  })

  it('treats the temporary sibling of a mark write that died midway as no mark at all', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    // The writer stopped between creating the temporary name and renaming it.
    memory.scribble(`${MARK}.tmp`, '{"format":"taskwraith.thread-au')

    const host = machine.host('host-b')
    expect(await host.rebuild()).toEqual({ held: [], fold: [], damaged: [] })
    expect((await machine.files.read(THREAD)).kind).toBe('none')
    expect(await host.reserveOwnership(THREAD)).toBeNull()

    // The leftover is cleaned by the removal a Host takeover performs.
    expect(await machine.files.remove(THREAD)).toBe(false)
    expect(memory.presence(`${MARK}.tmp`)).toBe(false)
    machine.start('desk-b', 4102)
    expect(grantOf(await host.claim(claimRequest('desk-b')))).toEqual({ host: 'host-b', grant: 1 })
  })

  it('refuses a claim whose socket closed while the mark was being read, and burns no grant', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    const host = machine.host()
    let open = true
    const grants: ThreadOwnerEpoch[] = []
    let finish!: () => void
    memory.hold = new Promise<void>((resolve) => {
      finish = resolve
    })
    const claiming = host.claim(claimRequest('desk-a'), {
      isCurrent: () => open,
      granted: (epoch) => grants.push(epoch)
    })
    // The connection drops while the claim waits on the disk.
    open = false
    memory.hold = null
    finish()
    const reply = await claiming
    expect(reply).toEqual({
      threadId: THREAD,
      claimId: 1,
      granted: false,
      reason: 'owned_by_other_writer',
      revision: FULL_COPY
    })
    expect(grants).toEqual([])
    expect(host.writerOf(THREAD)).toEqual({ kind: 'host' })

    // The reconnected writer gets the first grant: the dropped claim took none.
    expect(grantOf(await host.claim(claimRequest('desk-a', 2)))).toEqual({
      host: 'host-a',
      grant: 1
    })
  })

  it('frees a revoked grant for another claimer only once the first writer’s mark is gone or dead', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.start('desk-b', 4102)
    const host = machine.host()
    const epoch = grantOf(await host.claim(claimRequest('desk-a')))
    await machine.marks('desk-a', epoch)

    // The socket that held the grant closes: the table forgets it at once.
    host.revoke(THREAD, epoch)
    expect(host.writerOf(THREAD)).toEqual({ kind: 'host' })

    // Its process is still running and its mark is still on disk, so the
    // thread stays that writer's.
    expect(await host.claim(claimRequest('desk-b'))).toMatchObject({
      granted: false,
      reason: 'owned_by_other_writer'
    })

    // Once that process ends, the same mark no longer keeps the thread.
    machine.end('desk-a')
    expect(grantOf(await host.claim(claimRequest('desk-b', 2)))).toEqual({
      host: 'host-a',
      grant: 2
    })
  })
})

describe('HostThreadOwnerRegistry retirement interrupted', () => {
  async function orphan(): Promise<{
    machine: Machine
    host: HostThreadOwnerRegistry
    reservation: NonNullable<Awaited<ReturnType<HostThreadOwnerRegistry['reserveOwnership']>>>
  }> {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    const host = machine.host()
    const reservation = await host.reserveOwnership(THREAD)
    if (!reservation) throw new Error('no reservation minted')
    return { machine, host, reservation }
  }

  it('refuses to retire when the dead writer’s process comes back', async () => {
    const { machine, host, reservation } = await orphan()
    expect(invalidReason(() => reservation.revalidate())).toBeNull()

    // The process id is alive again: a restarted writer, or a reused pid.
    machine.start('desk-a-returned', 4101)
    expect(invalidReason(() => reservation.revalidate())).toBe('writer_alive')
    // The reservation surfaces the more specific reason: a writer that came
    // back is `live_writer`, not a flat `damaged`.
    expect(await host.retireOrphanAuthority(THREAD, reservation)).toEqual({
      kind: 'busy',
      reason: 'live_writer'
    })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('answers live_writer when the writer’s liveness becomes undecidable under a held reservation', async () => {
    const { machine, host, reservation } = await orphan()
    // Another desktop attaches, and the old writer's pid can no longer be probed.
    machine.start('desk-b', 4102)
    machine.unresolved.add(4101)
    // Revalidation only objects to a writer proved alive; the registry still
    // treats an undecidable writer as alive and holds the mark.
    expect(invalidReason(() => reservation.revalidate())).toBeNull()
    expect(await host.retireOrphanAuthority(THREAD, reservation)).toEqual({
      kind: 'busy',
      reason: 'live_writer'
    })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('refuses to retire a mark a competing claim overwrote before the retirement began', async () => {
    const { machine, host, reservation } = await orphan()
    machine.start('desk-b', 4102)
    await machine.marks('desk-b', { host: 'host-a', grant: 2 })
    expect(await host.retireOrphanAuthority(THREAD, reservation)).toEqual({
      kind: 'busy',
      reason: 'damaged'
    })
    const read = await machine.files.read(THREAD)
    expect(read.kind).toBe('held')
    if (read.kind === 'held') expect(read.record.writer.writerId).toBe('desk-b')
  })

  it('reports uncertain witness_changed, never retired, when a competing writer recreates the mark mid-retirement', async () => {
    const { machine, host, reservation } = await orphan()
    machine.start('desk-b', 4102)
    // Between the unlink and the witness read, desk-b's claim lands its own mark.
    machine.fileSystem.afterMarkUnlink = () =>
      machine.fileSystem.setMark('desk-b', 4102, { host: 'host-a', grant: 2 })
    expect(await host.retireOrphanAuthority(THREAD, reservation)).toEqual({
      kind: 'uncertain',
      reason: 'witness_changed'
    })
    const read = await machine.files.read(THREAD)
    expect(read.kind).toBe('held')
    if (read.kind === 'held') expect(read.record.writer.writerId).toBe('desk-b')

    // The retry reports what stands, still uncertain: the first attempt's
    // custody never unlinks again, so it never reaches desk-b's mark.
    expect(await host.retireOrphanAuthority(THREAD, reservation)).toEqual({
      kind: 'uncertain',
      reason: 'witness_changed'
    })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })
})

describe('HostThreadOwnerRegistry competing claims', () => {
  it('refuses a second writer while the first holds the grant, and frees it on release', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.start('desk-b', 4102)
    const host = machine.host()
    const first = grantOf(await host.claim(claimRequest('desk-a')))
    expect(first).toEqual({ host: 'host-a', grant: 1 })

    expect(await host.claim(claimRequest('desk-b'))).toEqual({
      threadId: THREAD,
      claimId: 1,
      granted: false,
      reason: 'owned_by_other_writer',
      revision: FULL_COPY
    })

    expect(
      await host.release({ action: 'release', threadId: THREAD, epoch: first, revision: FULL_COPY })
    ).toBe(true)
    const second = grantOf(await host.claim(claimRequest('desk-b', 2)))
    expect(second).toEqual({ host: 'host-a', grant: 2 })

    // The first writer's late release names a grant that no longer exists: it frees nothing.
    expect(
      await host.release({ action: 'release', threadId: THREAD, epoch: first, revision: FULL_COPY })
    ).toBe(false)
    expect(host.writerOf(THREAD)).toMatchObject({ kind: 'desktop', writerId: 'desk-b' })
  })

  it('grants exactly one of two claims issued at the same moment, in arrival order', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.start('desk-b', 4102)
    const host = machine.host()
    const [a, b] = await Promise.all([
      host.claim(claimRequest('desk-a')),
      host.claim(claimRequest('desk-b'))
    ])
    expect(a).toMatchObject({ granted: true, epoch: { host: 'host-a', grant: 1 } })
    expect(b).toMatchObject({ granted: false, reason: 'owned_by_other_writer' })
    expect(host.writerOf(THREAD)).toMatchObject({ kind: 'desktop', writerId: 'desk-a' })
  })

  it('lets a new writer claim the thread once the orphan mark ahead of it has been retired', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'host-a', grant: 1 })
    machine.end('desk-a')
    machine.start('desk-b', 4102)
    const host = machine.host('host-b')
    const reservation = await host.reserveOwnership(THREAD)
    expect(reservation).not.toBeNull()

    // A queued competing claim cannot cross custody, even after a durable retire.
    const [retired, reply] = await Promise.all([
      host.retireOrphanAuthority(THREAD, reservation!),
      host.claim(claimRequest('desk-b'))
    ])
    expect(retired).toEqual({ kind: 'retired' })
    expect(reply).toMatchObject({ granted: false, reason: 'owned_by_other_writer' })
    expect(host.releaseOwnership(reservation!)).toBe(true)
    expect(await host.claim(claimRequest('desk-b'))).toMatchObject({
      granted: true,
      epoch: { host: 'host-b', grant: 1 }
    })
    expect(host.writerOf(THREAD)).toMatchObject({ kind: 'desktop', writerId: 'desk-b' })
  })
})
