import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NODE_THREAD_AUTHORITY_FS,
  THREAD_AUTHORITY_DIRECTORY,
  ThreadAuthorityFiles,
  threadAuthorityFilePath,
  type ThreadAuthorityFileHandle,
  type ThreadAuthorityFs
} from '../host-shared/thread-log/ThreadAuthorityFile'
import type {
  HostDesktopPresence,
  HostWriteDecision,
  ThreadClaimReply,
  ThreadClaimRequest,
  ThreadOwnerEpoch
} from '../host-shared/thread-log/ThreadOwnership'
import { HostThreadOwnerRegistry } from './HostThreadOwnerRegistry'

const THREAD = 'thread-1'
/** Never touched on disk: the in-memory filesystem below stands for it. */
const PROFILE = path.resolve(path.sep, 'profile')
const TEMPORARY_PREFIX = 'host-owner-registry-'
const BUSY: HostWriteDecision = { kind: 'busy', reason: 'thread_busy_in_desktop' }
const WRITE: HostWriteDecision = { kind: 'write' }

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

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
    if (!this.directories.has(directory)) throw missing()
    for (const name of [...this.durable.keys()]) {
      if (path.dirname(name) === directory && !this.names.has(name)) this.durable.delete(name)
    }
    for (const [name, text] of this.names) {
      if (path.dirname(name) === directory) this.durable.set(name, text)
    }
  }

  async readFile(file: string, limit: number): Promise<string> {
    this.reads++
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

  /** A writer stopped between taking a file's name away and syncing that. */
  unlinkWithoutSync(file: string): void {
    this.names.delete(file)
  }

  /** Puts bytes where a thread's file goes, as a torn or foreign write would. */
  scribble(file: string, text: string): void {
    this.names.set(file, text)
    this.durable.set(file, text)
  }

  /** Every name change made since its directory was last synced is lost. */
  powerLoss(): void {
    this.names = new Map(this.durable)
  }
}

interface Desk {
  readonly pid: number
  attached: boolean
}

/** One machine: the Host's copies of each thread, its runs, and the app processes running. */
class Machine {
  readonly files: ThreadAuthorityFiles
  readonly full = new Map<string, number>()
  readonly log = new Map<string, number>()
  readonly runs = new Set<string>()
  readonly desks = new Map<string, Desk>()
  /** Process ids whose liveness cannot be decided. */
  readonly unresolved = new Set<number>()
  /** Threads whose log revision the Host asked for, in order. */
  readonly logAsked: string[] = []

  constructor(fileSystem: ThreadAuthorityFs = new MemoryFs(), profile = PROFILE) {
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
      logRevision: async (threadId) => {
        this.logAsked.push(threadId)
        return this.log.get(threadId) ?? null
      },
      hostRunActive: (threadId) => this.runs.has(threadId),
      // The in-memory filesystem has no inode; real metadata races are covered
      // by HostThreadPublicationGuard/Service tests against guarded temp profiles.
      publicationWitness: () => () => true,
      desktopPresence: () => this.presence(),
      otherDesktopUnattached: (writerId) =>
        [...this.desks].some(([id, desk]) => id !== writerId && !desk.attached),
      liveness: ({ pid }) => {
        if (this.unresolved.has(pid)) return 'unresolved'
        return [...this.desks.values()].some((desk) => desk.pid === pid) ? 'alive' : 'dead'
      }
    })
  }

  /** What an app process does once it is granted a thread, before its first append. */
  async marks(writerId: string, epoch: ThreadOwnerEpoch, threadId = THREAD): Promise<void> {
    await this.files.write({
      threadId,
      writer: { writerId, pid: this.desks.get(writerId)!.pid },
      epoch,
      grantedAtRevision: this.full.get(threadId) ?? 0,
      grantedAt: 1_000
    })
  }

  /** One more revision in the thread's log, above everything the Host holds. */
  appends(threadId = THREAD): void {
    const head = Math.max(this.full.get(threadId) ?? 0, this.log.get(threadId) ?? 0)
    this.log.set(threadId, head + 1)
  }

  /** The Host folds the log into its full copy. */
  folds(threadId = THREAD): void {
    this.full.set(threadId, this.log.get(threadId)!)
  }
}

function claim(
  writerId: string,
  baseRevision: number,
  headRevision: number = baseRevision,
  claimId = 1,
  threadId = THREAD
): ThreadClaimRequest {
  return { action: 'claim', threadId, writerId, claimId, baseRevision, headRevision }
}

function granted(reply: ThreadClaimReply): ThreadOwnerEpoch {
  if (!reply.granted) throw new Error(`claim refused: ${reply.reason}`)
  return reply.epoch
}

function refusal(reply: ThreadClaimReply): { reason: string; revision: number | null } {
  if (reply.granted) throw new Error('claim granted')
  return { reason: reply.reason, revision: reply.revision }
}

/** desk-a was granted the thread by an earlier Host, marked it, wrote to revision 6 on top of 4, and ended. */
async function deadWritersLog(memory = new MemoryFs()): Promise<Machine> {
  const machine = new Machine(memory)
  machine.start('desk-a', 4101)
  machine.full.set(THREAD, 4)
  await machine.marks('desk-a', { host: 'host-0', grant: 1 })
  machine.appends()
  machine.appends()
  machine.end('desk-a')
  return machine
}

describe('the Host thread owner registry: a log revision only under an authority file', () => {
  it('judges a thread without an authority file on its full copy alone, and never asks for its log', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    // Saves the app logged before the Host took them: a mirror, not owned work.
    machine.log.set(THREAD, 6)
    const host = machine.host()

    expect(refusal(await host.claim(claim('desk-a', 4, 6)))).toEqual({
      reason: 'host_behind',
      revision: 4
    })
    expect(granted(await host.claim(claim('desk-a', 4, 4, 2)))).toEqual({
      host: 'host-a',
      grant: 1
    })
    expect(machine.logAsked).toEqual([])
  })

  it('lets a process carry on the log its own authority file marks', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    // Granted by the Host before this one, marked, and written past the full copy.
    await machine.marks('desk-a', { host: 'host-0', grant: 1 })
    machine.appends()
    machine.appends()
    const host = machine.host()

    expect(granted(await host.claim(claim('desk-a', 4, 6)))).toEqual({ host: 'host-a', grant: 1 })
    expect(machine.logAsked).toEqual([THREAD])
    expect(host.writerOf(THREAD)).toMatchObject({ writerId: 'desk-a', revision: 6 })
  })

  it('never folds a log no authority file marks: the Host writes past it', async () => {
    const machine = new Machine()
    machine.full.set(THREAD, 4)
    machine.log.set(THREAD, 6)
    const host = machine.host()

    expect(await host.requestHostWrite(THREAD, 0)).toEqual(WRITE)
    expect(machine.logAsked).toEqual([])
  })

  it('folds the log of a writer that has ended before the Host writes, then removes its file', async () => {
    const machine = await deadWritersLog()
    // Another app process runs, attached: it is not the writer of that log.
    machine.start('desk-b', 4102)
    const host = machine.host()

    expect(await host.requestHostWrite(THREAD, 0)).toEqual({ kind: 'fold_first', revision: 6 })
    expect(await machine.files.read(THREAD)).toMatchObject({ kind: 'held' })
    machine.folds()
    expect(await host.requestHostWrite(THREAD, 0)).toEqual(WRITE)
    expect(await machine.files.read(THREAD)).toEqual({ kind: 'none' })
    expect(host.writerOf(THREAD)).toEqual({ kind: 'host' })
  })

  it('lets a new app process carry on a dead writer’s log from its head, and from nowhere else', async () => {
    const machine = await deadWritersLog()
    machine.start('desk-b', 4102)
    const host = machine.host()

    expect(refusal(await host.claim(claim('desk-b', 4, 4)))).toEqual({
      reason: 'host_ahead',
      revision: 6
    })
    expect(granted(await host.claim(claim('desk-b', 4, 6, 2)))).toEqual({
      host: 'host-a',
      grant: 1
    })
    expect(host.writerOf(THREAD)).toMatchObject({ writerId: 'desk-b', revision: 6 })
    // Until desk-b marks the thread, the file still names desk-a, which has ended.
    expect(await host.requestHostWrite(THREAD, 0)).toMatchObject({
      kind: 'ask_release',
      writerId: 'desk-b'
    })
  })

  it('still folds a dead writer’s log when the process that took it over ends before marking it', async () => {
    const machine = await deadWritersLog()
    machine.start('desk-b', 4102)
    const host = machine.host()
    granted(await host.claim(claim('desk-b', 4, 6)))
    machine.end('desk-b')

    expect(await host.requestHostWrite(THREAD, 0)).toEqual({ kind: 'fold_first', revision: 6 })
    expect(host.writerOf(THREAD)).toEqual({ kind: 'host' })
  })

  it('waits for every live app process to attach before it folds or takes a dead writer’s thread', async () => {
    const machine = await deadWritersLog()
    // It may hold a grant from before the Host started, its file on the way.
    machine.start('desk-b', 4102, false)
    const host = machine.host()

    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    expect(refusal(await host.claim(claim('desk-c', 4, 6)))).toMatchObject({
      reason: 'owned_by_other_writer'
    })
    machine.desks.get('desk-b')!.attached = true
    expect(await host.requestHostWrite(THREAD, 0)).toEqual({ kind: 'fold_first', revision: 6 })
  })
})

describe('the Host thread owner registry: after a Host restart', () => {
  it('keeps a thread for the live writer its file names, until that writer claims it again', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.start('desk-b', 4102)
    machine.full.set(THREAD, 4)
    const before = machine.host('host-a')
    const epoch = granted(await before.claim(claim('desk-a', 4)))
    await machine.marks('desk-a', epoch)
    machine.appends()

    // The Host restarts: its table is gone, the file is not.
    const host = machine.host('host-b')
    expect(await host.rebuild()).toEqual({
      held: [{ threadId: THREAD, writerId: 'desk-a' }],
      fold: [],
      damaged: []
    })
    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    expect(refusal(await host.claim(claim('desk-b', 4, 5)))).toEqual({
      reason: 'owned_by_other_writer',
      revision: 5
    })
    expect(host.writerOf(THREAD)).toEqual({ kind: 'host' })

    expect(granted(await host.claim(claim('desk-a', 4, 5, 2)))).toEqual({
      host: 'host-b',
      grant: 1
    })
    expect(await host.requestHostWrite(THREAD, 0)).toMatchObject({
      kind: 'ask_release',
      writerId: 'desk-a',
      created: true
    })
  })

  it('names the threads whose writer has ended for folding, and keeps those it cannot read', async () => {
    const memory = new MemoryFs()
    const machine = await deadWritersLog(memory)
    machine.start('desk-c', 4103)
    machine.full.set('thread-2', 2)
    await machine.marks('desk-c', { host: 'host-0', grant: 2 }, 'thread-2')
    memory.scribble(threadAuthorityFilePath(PROFILE, 'thread-3'), '{"format":')
    const host = machine.host('host-b')

    expect(await host.rebuild()).toEqual({
      held: [{ threadId: 'thread-2', writerId: 'desk-c' }],
      fold: [THREAD],
      damaged: ['thread-3']
    })
  })

  it('counts a writer it cannot probe as alive, and every writer as ended when no app process runs', async () => {
    const machine = await deadWritersLog()
    // desk-a's process id can no longer be probed either way.
    machine.unresolved.add(4101)
    machine.start('desk-b', 4102)
    const host = machine.host('host-b')

    expect((await host.rebuild()).held).toEqual([{ threadId: THREAD, writerId: 'desk-a' }])
    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    expect(refusal(await host.claim(claim('desk-b', 4, 6)))).toMatchObject({
      reason: 'owned_by_other_writer'
    })

    machine.end('desk-b')
    expect((await host.rebuild()).fold).toEqual([THREAD])
    expect(await host.requestHostWrite(THREAD, 0)).toEqual({ kind: 'fold_first', revision: 6 })
  })
})

describe('the Host thread owner registry: files it cannot rely on', () => {
  it('keeps a thread whose file it cannot read, as a live writer’s file does', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-b', 4102)
    machine.full.set(THREAD, 4)
    memory.scribble(threadAuthorityFilePath(PROFILE, THREAD), '{"format":')
    const host = machine.host()

    expect(refusal(await host.claim(claim('desk-b', 4)))).toEqual({
      reason: 'owned_by_other_writer',
      revision: 4
    })
    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    machine.end('desk-b')
    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    expect(machine.logAsked).toEqual([])
  })

  it('keeps a thread whose holder’s file turned unreadable, even once no app process runs', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    const host = machine.host()
    const epoch = granted(await host.claim(claim('desk-a', 4)))
    await machine.marks('desk-a', epoch)
    memory.scribble(threadAuthorityFilePath(PROFILE, THREAD), 'not a record')
    machine.end('desk-a')

    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    expect(await machine.files.read(THREAD)).toMatchObject({ kind: 'damaged' })
  })

  it('frees a holder its own file shows has ended, and keeps one that died before writing it', async () => {
    const machine = new Machine()
    for (const [writerId, pid] of [
      ['desk-a', 4101],
      ['desk-b', 4102],
      ['desk-c', 4103]
    ] as const) {
      machine.start(writerId, pid)
    }
    machine.full.set(THREAD, 4)
    machine.full.set('thread-2', 4)
    const host = machine.host()
    granted(await host.claim(claim('desk-a', 4)))
    const epoch = granted(await host.claim(claim('desk-c', 4, 4, 1, 'thread-2')))
    await machine.marks('desk-c', epoch, 'thread-2')
    machine.appends('thread-2')
    machine.end('desk-a')
    machine.end('desk-c')

    // desk-a died between its grant and its file: nothing on disk says so.
    expect(refusal(await host.claim(claim('desk-b', 4, 4, 2)))).toEqual({
      reason: 'owned_by_other_writer',
      revision: 4
    })
    expect(await host.requestHostWrite(THREAD, 0)).toMatchObject({
      kind: 'ask_release',
      writerId: 'desk-a'
    })

    expect(await host.requestHostWrite('thread-2', 0)).toEqual({ kind: 'fold_first', revision: 5 })
    expect(host.writerOf('thread-2')).toEqual({ kind: 'host' })
    expect(granted(await host.claim(claim('desk-b', 4, 5, 3, 'thread-2')))).toEqual({
      host: 'host-a',
      grant: 3
    })
  })

  it('keeps a thread busy when it cannot take an ended writer’s file away', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    const host = machine.host()
    const epoch = granted(await host.claim(claim('desk-a', 4)))
    await machine.marks('desk-a', epoch)
    machine.end('desk-a')
    memory.unlink = async () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    }

    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    expect(await machine.files.read(THREAD)).toMatchObject({ kind: 'held' })
  })

  it('makes its taking of a thread durable: a file removed without its sync cannot come back', async () => {
    const released = async (memory: MemoryFs, unattached: boolean) => {
      const machine = new Machine(memory)
      machine.start('desk-a', 4101)
      machine.full.set(THREAD, 4)
      const host = machine.host()
      const epoch = granted(await host.claim(claim('desk-a', 4)))
      await machine.marks('desk-a', epoch)
      // desk-a gives the thread back, takes its file away, and stops before the sync.
      expect(await host.release({ action: 'release', threadId: THREAD, epoch, revision: 4 })).toBe(
        true
      )
      memory.unlinkWithoutSync(threadAuthorityFilePath(PROFILE, THREAD))
      machine.end('desk-a')
      if (unattached) machine.start('desk-z', 4199, false)
      return { machine, host }
    }

    const alone = new MemoryFs()
    const left = await released(alone, false)
    alone.powerLoss()
    expect(await left.machine.files.read(THREAD)).toMatchObject({ kind: 'held' })

    const taken = new MemoryFs()
    const writing = await released(taken, false)
    expect(await writing.host.requestHostWrite(THREAD, 0)).toEqual(WRITE)
    taken.powerLoss()
    expect(await writing.machine.files.read(THREAD)).toEqual({ kind: 'none' })

    // A process that has not attached may hold the thread from before: hands off.
    const waiting = new MemoryFs()
    const held = await released(waiting, true)
    expect(await held.host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    waiting.powerLoss()
    expect(await held.machine.files.read(THREAD)).toMatchObject({ kind: 'held' })
  })
})

describe('the Host thread owner registry: grants, advances and releases', () => {
  it('records advances and releases only for the current grant', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    const host = machine.host()
    const epoch = granted(await host.claim(claim('desk-a', 4)))
    const stale = { host: 'host-0', grant: 1 }

    expect(await host.advanced({ action: 'advanced', threadId: THREAD, epoch, revision: 7 })).toBe(
      true
    )
    expect(
      await host.advanced({ action: 'advanced', threadId: THREAD, epoch: stale, revision: 9 })
    ).toBe(false)
    expect(
      await host.release({ action: 'release', threadId: THREAD, epoch: stale, revision: 9 })
    ).toBe(false)
    expect(host.writerOf(THREAD)).toMatchObject({ writerId: 'desk-a', revision: 7 })
    expect(await host.release({ action: 'release', threadId: THREAD, epoch, revision: 7 })).toBe(
      true
    )
    expect(host.writerOf(THREAD)).toEqual({ kind: 'host' })
    expect(await host.release({ action: 'release', threadId: THREAD, epoch, revision: 7 })).toBe(
      false
    )
  })

  it('keeps a released thread for its writer until the writer removes its file', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.start('desk-b', 4102)
    machine.full.set(THREAD, 4)
    const host = machine.host()
    const epoch = granted(await host.claim(claim('desk-a', 4)))
    await machine.marks('desk-a', epoch)
    expect(await host.release({ action: 'release', threadId: THREAD, epoch, revision: 4 })).toBe(
      true
    )

    expect(await host.requestHostWrite(THREAD, 0)).toEqual(BUSY)
    expect(refusal(await host.claim(claim('desk-b', 4)))).toMatchObject({
      reason: 'owned_by_other_writer'
    })
    await machine.files.remove(THREAD)
    expect(await host.requestHostWrite(THREAD, 0)).toEqual(WRITE)
  })

  it('grants nothing and reads no authority file with log authority off', async () => {
    const memory = new MemoryFs()
    const machine = await deadWritersLog(memory)
    machine.start('desk-b', 4102)
    const host = machine.host('host-a', false)

    expect(await host.rebuild()).toEqual({ held: [], fold: [], damaged: [] })
    expect(refusal(await host.claim(claim('desk-b', 4, 6)))).toEqual({
      reason: 'disabled',
      revision: 4
    })
    expect(await host.requestHostWrite(THREAD, 0)).toEqual(WRITE)
    expect(memory.reads).toBe(0)
    expect(machine.logAsked).toEqual([])
  })

  it('rejects a thread id that could not name a file', async () => {
    const host = new Machine().host()
    await expect(host.claim(claim('desk-a', 4, 4, 1, '../thread-1'))).rejects.toThrow(
      'Invalid thread id'
    )
    await expect(host.requestHostWrite('', 0)).rejects.toThrow('Invalid thread id')
  })
})

describe('the Host thread owner registry: one decision at a time', () => {
  it('decides on the facts as they stand after its last wait', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    const host = machine.host()

    let open = (): void => undefined
    memory.hold = new Promise((resolve) => (open = resolve))
    const asked = host.claim(claim('desk-a', 4))
    expect(memory.reads).toBe(1)
    machine.runs.add(THREAD)
    open()
    expect(refusal(await asked)).toEqual({ reason: 'host_run_active', revision: 4 })

    machine.runs.delete(THREAD)
    await nextTurn()
    memory.hold = new Promise((resolve) => (open = resolve))
    const again = host.claim(claim('desk-a', 4, 4, 2))
    expect(memory.reads).toBe(2)
    machine.full.set(THREAD, 5)
    open()
    expect(refusal(await again)).toEqual({ reason: 'host_ahead', revision: 5 })
  })

  it('takes a claim that arrives during a Host write decision only after it', async () => {
    const memory = new MemoryFs()
    const machine = await deadWritersLog(memory)
    machine.folds()
    machine.start('desk-b', 4102)
    const host = machine.host()

    const write = host.requestHostWrite(THREAD, 0).then((decision) => {
      if (decision.kind === 'write') machine.runs.add(THREAD)
      return decision
    })
    const taken = host.claim(claim('desk-b', 6))
    expect(await write).toEqual(WRITE)
    expect(refusal(await taken)).toEqual({ reason: 'host_run_active', revision: 6 })
    expect(host.writerOf(THREAD)).toEqual({ kind: 'host' })
  })

  it('lets a caller that passes the answer through layers of functions mark its write live first', async () => {
    const machine = new Machine()
    machine.start('desk-b', 4102)
    machine.full.set(THREAD, 4)
    const host = machine.host()
    const layered = async (depth: number): Promise<HostWriteDecision> =>
      depth === 0 ? await host.requestHostWrite(THREAD, 0) : await layered(depth - 1)

    const write = layered(12).then((decision) => {
      if (decision.kind === 'write') machine.runs.add(THREAD)
      return decision
    })
    const taken = host.claim(claim('desk-b', 4))
    expect(await write).toEqual(WRITE)
    expect(refusal(await taken)).toEqual({ reason: 'host_run_active', revision: 4 })
  })
})

describe('the Host thread owner registry: on a real disk', () => {
  it('is ruled after a restart by the files a writer left', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    try {
      const machine = new Machine(NODE_THREAD_AUTHORITY_FS, profile)
      machine.start('desk-a', 4101)
      machine.full.set(THREAD, 4)
      const before = machine.host('host-a')
      const epoch = granted(await before.claim(claim('desk-a', 4)))
      await machine.marks('desk-a', epoch)
      machine.appends()
      machine.end('desk-a')

      const host = machine.host('host-b')
      expect(await host.rebuild()).toEqual({ held: [], fold: [THREAD], damaged: [] })
      expect(await host.requestHostWrite(THREAD, 0)).toEqual({ kind: 'fold_first', revision: 5 })
      machine.folds()
      expect(await host.requestHostWrite(THREAD, 0)).toEqual(WRITE)
      expect(fs.readdirSync(path.join(profile, THREAD_AUTHORITY_DIRECTORY))).toEqual([])
    } finally {
      removeTemporaryDirectory(profile)
    }
  })
})

describe('final full-copy publication admission', () => {
  const unclaimed = { owner: null, isCurrent: () => true }

  it('preserves a dead owner’s leading log and authority mark until an orphan fold', async () => {
    const machine = await deadWritersLog()
    const host = machine.host()
    let commits = 0
    expect(await host.publishFullCopy(THREAD, unclaimed, () => ++commits)).toEqual({
      kind: 'refused',
      errorCode: 'thread_fold_first'
    })
    expect(commits).toBe(0)
    expect(machine.full.get(THREAD)).toBe(4)
    expect(machine.log.get(THREAD)).toBe(6)
    expect((await machine.files.read(THREAD)).kind).toBe('held')
    // Even caught-up authority must be durably retired by recovery, not this guard.
    machine.folds()
    expect(await host.publishFullCopy(THREAD, unclaimed, () => ++commits)).toMatchObject({
      kind: 'refused'
    })
    expect((await machine.files.read(THREAD)).kind).toBe('held')
  })

  it('a live or unreadable authority mark never becomes permission to publish', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.full.set(THREAD, 4)
    machine.start('desk-a', 4101)
    await machine.marks('desk-a', { host: 'before', grant: 1 })
    const host = machine.host()
    let commits = 0
    expect(await host.publishFullCopy(THREAD, unclaimed, () => ++commits)).toMatchObject({
      kind: 'refused'
    })
    memory.scribble(threadAuthorityFilePath(PROFILE, THREAD), '{damaged')
    expect(await host.publishFullCopy(THREAD, unclaimed, () => ++commits)).toMatchObject({
      kind: 'refused'
    })
    expect(commits).toBe(0)
  })

  it('rechecks the exact epoch independently of connection validity', async () => {
    const machine = new Machine()
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    const host = machine.host()
    const epoch = granted(await host.claim(claim('desk-a', 4)))
    const binding = { owner: { writerId: 'desk-a', epoch }, isCurrent: () => true }
    host.revoke(THREAD, epoch)
    const next = granted(await host.claim(claim('desk-a', 4, 4, 2)))
    expect(next.grant).toBeGreaterThan(epoch.grant)
    let committed = false
    expect(
      await host.publishFullCopy(THREAD, binding, () => {
        committed = true
      })
    ).toMatchObject({ kind: 'refused' })
    expect(committed).toBe(false)
  })

  it('commits inside serialization before a queued claim can acquire the thread', async () => {
    const memory = new MemoryFs()
    const machine = new Machine(memory)
    machine.start('desk-a', 4101)
    machine.full.set(THREAD, 4)
    const host = machine.host()
    let finish!: () => void
    memory.hold = new Promise<void>((resolve) => {
      finish = resolve
    })
    const publication = host.publishFullCopy(THREAD, unclaimed, () => {
      machine.full.set(THREAD, 5)
      return 'adopted'
    })
    const claiming = host.claim(claim('desk-a', 4))
    memory.hold = null
    finish()
    expect(await publication).toEqual({ kind: 'published', value: 'adopted' })
    expect(refusal(await claiming)).toEqual({ reason: 'host_ahead', revision: 5 })
  })
})
