/**
 * Whatever a power cut leaves of a journal that leaves syncing to the thread
 * barrier, the thread loads.
 *
 * A scripted history of journal operations runs over a real directory while
 * this file watches it: every change of a name in the directory, and every
 * sync, whether the journal issues it or a barrier pays it through the port.
 * After each step it enumerates the states a power cut at that moment can
 * leave, and loads each one with a fresh journal:
 * - the directory's names are as they were at some moment since the
 *   directory was last synced: the system applies changes of names in the
 *   order they were made, so a later name never survives without an earlier
 *   one (a new segment under the active name without the rename that freed
 *   that name, say);
 * - each file holds its bytes as of its last sync, followed by none, some or
 *   all of what was written after: cut after each line, in the middle of each
 *   line, or with the unsynced part read back as zeros.
 * A load must not throw, and must give a record of the chain at a revision at
 * or beyond the last one a resolved barrier covered (or one a synced
 * checkpoint holds). A journal that may not write must read the same, and the
 * thread must take its next line and read it back.
 *
 * Every state is enumerated; nothing is sampled. What the bound leaves out:
 * - a power cut in the middle of one step is covered through the names that
 *   step changed and the cuts of its files as they stood at the step's end,
 *   not of the bytes they held part way through it;
 * - each line is cut once in its middle rather than at every byte, and zeros
 *   stand only for the whole of a file's unsynced part, never for part of it
 *   followed by bytes that did reach the disk;
 * - names are never reordered: a file system that makes a later rename
 *   durable without an earlier one is not modelled;
 * - one chat: another chat's sync of the shared directory can only make
 *   fewer of these states possible, never one that is not here.
 */
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveChatRecordMutation, type ChatRecordMutationBatch } from './ChatRecordMutation'
import { prepareCheckpoint } from './CheckpointPreparationCore'
import {
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'
import {
  createIncrementalChatJournal,
  type IncrementalChatJournal,
  type IncrementalChatJournalOptions
} from './IncrementalChatJournal'
import {
  createThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityPort
} from './ThreadDurabilityDebt'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import type { ChatRecord } from './types'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-journal-power-cut-'

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

const CHAT = 'chat-1'

function chat(revision: number): ChatRecord {
  return {
    appChatId: CHAT,
    title: CHAT,
    createdAt: 1,
    updatedAt: revision,
    archived: false,
    persistenceRevision: revision,
    messages: [
      {
        id: 'message',
        role: 'assistant',
        content: `content ${revision}`,
        timestamp: '2026-10-05T00:00:00.000Z'
      }
    ],
    runs: []
  }
}

/** `records[n]` is at revision n + 1, and `batches[n]` takes it to revision n + 2. */
const records: ChatRecord[] = Array.from({ length: 16 }, (_unused, index) => chat(index + 1))
const batches: ChatRecordMutationBatch[] = records
  .slice(0, -1)
  .map((record, index) => deriveChatRecordMutation(record, records[index + 1]))

/** The calls that change what names a directory holds. */
const NAMING = [
  'openSync',
  'renameSync',
  'unlinkSync',
  'writeFileSync',
  'appendFileSync',
  'rmSync',
  'linkSync',
  'copyFileSync',
  'truncateSync',
  'ftruncateSync'
] as const

const real = {
  readdirSync: fs.readdirSync,
  lstatSync: fs.lstatSync,
  statSync: fs.statSync,
  fstatSync: fs.fstatSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync
}

/**
 * Watches one directory: the names it held at each moment, and the bytes each
 * file held when it was last synced. A descriptor is held for every file it has
 * seen, so a file renamed or removed since can still be read.
 */
class PowerCutRecorder {
  readonly moments: Array<ReadonlyMap<string, number>> = []
  /** The first moment a power cut can leave the directory at: the one its last sync made safe. */
  safe = 0
  private readonly synced = new Map<number, Buffer>()
  private readonly held = new Map<number, number>()
  private readonly directoryInode: number

  constructor(readonly directory: string) {
    this.directoryInode = real.statSync(directory).ino
    this.moment()
  }

  moment(): void {
    const names = new Map<string, number>()
    for (const name of real.readdirSync(this.directory) as string[]) {
      const file = path.join(this.directory, name)
      const stat = real.lstatSync(file)
      if (!stat.isFile()) continue
      names.set(name, stat.ino)
      if (!this.held.has(stat.ino)) this.held.set(stat.ino, real.openSync(file, 'r'))
    }
    const last = this.moments[this.moments.length - 1]
    const same =
      last &&
      last.size === names.size &&
      [...names].every(([name, inode]) => last.get(name) === inode)
    if (!same) this.moments.push(names)
  }

  bytes(inode: number): Buffer {
    const fd = this.held.get(inode)!
    const size = real.fstatSync(fd).size
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const count = real.readSync(fd, bytes, offset, size - offset, offset)
      if (count === 0) break
      offset += count
    }
    return bytes.subarray(0, offset)
  }

  syncedBytes(inode: number): Buffer {
    return this.synced.get(inode) ?? Buffer.alloc(0)
  }

  sync(inode: number): void {
    if (inode === this.directoryInode) {
      this.moment()
      this.safe = this.moments.length - 1
      return
    }
    this.moment()
    this.synced.set(inode, this.bytes(inode))
  }

  /** Whatever the code under test syncs is recorded, and nothing reaches the disk. */
  watch(): () => void {
    const spies = [
      ...(['fsyncSync', 'fdatasyncSync'] as const).map((name) =>
        vi.spyOn(fs, name).mockImplementation((fd: number) => {
          this.sync(real.fstatSync(fd).ino)
        })
      ),
      ...(['fsync', 'fdatasync'] as const).map((name) =>
        vi.spyOn(fs, name).mockImplementation(((
          fd: number,
          done: (error: NodeJS.ErrnoException | null) => void
        ) => {
          this.sync(real.fstatSync(fd).ino)
          queueMicrotask(() => done(null))
        }) as never)
      ),
      ...NAMING.map((name) => {
        const original = fs[name] as (...args: unknown[]) => unknown
        return vi.spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
          try {
            return original(...args)
          } finally {
            this.moment()
          }
        }) as never)
      })
    ]
    syncBuiltinESMExports()
    return () => {
      for (const spy of spies) spy.mockRestore()
      syncBuiltinESMExports()
      for (const fd of this.held.values()) real.closeSync(fd)
      this.held.clear()
    }
  }

  /** A barrier's syncs, by path, as the production port makes them. */
  port(): ThreadDurabilityPort {
    const sync = async (target: string): Promise<'synced' | 'missing'> => {
      let inode: number
      try {
        inode = real.statSync(target).ino
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
        throw error
      }
      this.sync(inode)
      return 'synced'
    }
    return { syncFile: sync, syncDirectory: sync }
  }

  /** Every file's possible contents after a power cut, for one state of the directory. */
  *states(): Generator<Map<string, Buffer>> {
    const seen = new Set<string>()
    for (let index = this.safe; index < this.moments.length; index += 1) {
      const choices = [...this.moments[index]].map(
        ([name, inode]) => [name, cuts(this.syncedBytes(inode), this.bytes(inode))] as const
      )
      for (const state of product(choices)) {
        const key = [...state]
          .map(([name, bytes]) => `${name}:${bytes.toString('base64')}`)
          .sort()
          .join('|')
        if (seen.has(key)) continue
        seen.add(key)
        yield state
      }
    }
  }
}

/** What a file can hold after a power cut, from what its last sync made safe to all it was given. */
function cuts(synced: Buffer, written: Buffer): Buffer[] {
  if (written.length <= synced.length) return [written]
  const out = new Map<string, Buffer>()
  const add = (bytes: Buffer): void => {
    out.set(bytes.toString('base64'), bytes)
  }
  add(written.subarray(0, synced.length))
  let offset = synced.length
  while (offset < written.length) {
    const newline = written.indexOf(0x0a, offset)
    const end = newline < 0 ? written.length : newline + 1
    add(written.subarray(0, offset + ((end - offset) >> 1)))
    add(written.subarray(0, end))
    offset = end
  }
  add(Buffer.concat([synced, Buffer.alloc(written.length - synced.length)]))
  return [...out.values()]
}

function* product(
  choices: ReadonlyArray<readonly [string, Buffer[]]>
): Generator<Map<string, Buffer>> {
  if (choices.length === 0) {
    yield new Map()
    return
  }
  const [[name, options], ...rest] = choices
  for (const tail of product(rest)) {
    for (const bytes of options) {
      const state = new Map(tail)
      state.set(name, bytes)
      yield state
    }
  }
}

interface Live {
  journal: IncrementalChatJournal
  debt: ThreadDurabilityDebt
  /** The revision the journal's head is at now. */
  head: number | null
  /** The highest revision a power cut can no longer take away. */
  covered: number | null
  /** The revision a sealed segment ends at, while one waits to be folded. */
  rotated?: number
  /** A compaction started and not yet adopted, and the revision it folds to. */
  compaction?: { adopted: Promise<unknown>; revision: number }
  preparation?: ControlledPreparation
}

/** A flusher whose every sync goes through `node:fs`, where the recorder sees it. */
function flusher(): MainDurabilityFlusher {
  return new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (fd, complete) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        fs.fsyncSync(fd)
        complete()
      }
      queueMicrotask(finish)
      return { joinSync: finish }
    },
    fsyncSync: (fd) => fs.fsyncSync(fd),
    close: (fd) => fs.closeSync(fd)
  })
}

/** Prepares a checkpoint on this thread when told to, as the worker would off it. */
class ControlledPreparation implements CheckpointPreparationPort {
  private readonly requests: Array<{
    request: CheckpointPreparationRequest
    ready: (value: PreparedCheckpoint) => void
    prepared?: PreparedCheckpoint
  }> = []

  constructor(private readonly baseDir: string) {}

  start(source: CheckpointPreparationSource): CheckpointPreparationJob {
    const outputPath = path.join(
      this.baseDir,
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 })
    const output = checkpointFileReference(outputPath)
    let ready!: (value: PreparedCheckpoint) => void
    const result = new Promise<PreparedCheckpoint>((resolve) => {
      ready = resolve
    })
    const release = (): void => fs.rmSync(outputPath, { force: true })
    this.requests.push({ request: { ...source, output, maxOutputBytes: 1024 * 1024 }, ready })
    return { output, result, cancel: release, release }
  }

  /** Writes and syncs the prepared checkpoint, as the worker does, and hands it back. */
  complete(): void {
    this.prepare()
    this.hand()
  }

  /** Writes and syncs the prepared checkpoint without handing it back yet. */
  prepare(): void {
    const latest = this.requests[this.requests.length - 1]
    latest.prepared = prepareCheckpoint(latest.request)
  }

  private hand(): void {
    const { prepared, ready } = this.requests[this.requests.length - 1]
    ready(prepared!)
  }
}

interface Step {
  name: string
  run(live: Live): void | Promise<void>
}

const append = (count: number): Step => ({
  name: `append ${count}`,
  run: (live) => {
    for (let index = 0; index < count; index += 1) {
      live.journal.append(batches[live.head! - 1])
      live.head! += 1
    }
  }
})

const barrier: Step = {
  name: 'barrier',
  run: async (live) => {
    const raisedAt = live.head
    await live.debt.barrier(CHAT)
    live.covered = raisedAt
  }
}

const initialize: Step = {
  name: 'initialize',
  run: (live) => {
    live.journal.initialize(CHAT, records[0])
    live.head = 1
    live.covered = 1
  }
}

const compact: Step = {
  name: 'compact',
  run: (live) => {
    expect(live.journal.checkpoint(CHAT, 'bounded')).toBe(true)
    // The checkpoint is written synced and holds the whole chain so far.
    live.covered = live.head
  }
}

const rotate: Step = {
  name: 'rotate',
  run: (live) => {
    expect(live.journal.rotateForPreparation!(CHAT)).toMatchObject({ revision: live.head })
    live.rotated = live.head!
  }
}

const startCompaction: Step = {
  name: 'start a compaction',
  run: (live) => {
    // A compaction folds the sealed segment, sealing the active one first if none is.
    const revision = live.rotated ?? live.head!
    live.rotated = revision
    live.compaction = { adopted: live.journal.checkpointDeferred!(CHAT), revision }
  }
}

const prepare: Step = {
  name: 'prepare the checkpoint',
  run: (live) => live.preparation!.prepare()
}

const adopt: Step = {
  name: 'adopt the compaction',
  run: async (live) => {
    live.preparation!.complete()
    await expect(live.compaction!.adopted).resolves.toBe('checkpointed')
    // The prepared checkpoint is adopted with the sync that makes it safe.
    live.covered = Math.max(live.covered ?? 0, live.compaction!.revision)
    live.compaction = undefined
    live.rotated = undefined
  }
}

const reanchor = (ahead: number): Step => ({
  name: `re-anchor ${ahead} ahead`,
  run: (live) => {
    live.head! += ahead
    live.journal.replaceAuthoritativeCheckpoint(CHAT, records[live.head! - 1])
    live.covered = live.head
  }
})

describe.skipIf(process.platform === 'win32')(
  'a journal that leaves syncing to the thread barrier, after a power cut',
  () => {
    let root: string

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
    })

    afterEach(() => {
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      removeTemporaryDirectory(root)
    })

    /**
     * Run the steps, and after each one load every state a power cut could
     * leave. Returns how many states were loaded, and the failures by step.
     */
    const everyPowerCut = async (
      steps: Step[],
      options: (directory: string) => IncrementalChatJournalOptions = () => ({}),
      preparation = false
    ): Promise<{ states: number; failures: string[] }> => {
      const liveDirectory = path.join(root, 'live')
      fs.mkdirSync(liveDirectory)
      const recorder = new PowerCutRecorder(liveDirectory)
      const unwatch = recorder.watch()
      const debt = createThreadDurabilityDebt({ port: recorder.port() })
      const prepared = preparation ? new ControlledPreparation(liveDirectory) : undefined
      const live: Live = {
        journal: createIncrementalChatJournal(liveDirectory, {
          noteDurabilityDebt: debt.note,
          ...(prepared ? { checkpointPreparation: prepared } : {}),
          ...options(liveDirectory)
        }),
        debt,
        head: null,
        covered: null,
        preparation: prepared
      }
      const cutStates: Array<{
        after: string
        head: number | null
        covered: number | null
        files: Map<string, Buffer>
      }> = []
      try {
        for (const step of steps) {
          await step.run(live)
          recorder.moment()
          for (const files of recorder.states())
            cutStates.push({ after: step.name, head: live.head, covered: live.covered, files })
        }
      } finally {
        unwatch()
      }

      const failures: string[] = []
      let index = 0
      for (const { after, head, covered, files } of cutStates) {
        index += 1
        const directory = path.join(root, `state-${index}`)
        fs.mkdirSync(directory)
        for (const [name, bytes] of files) fs.writeFileSync(path.join(directory, name), bytes)
        const label = `after ${after}, state ${index} (${[...files]
          .map(([name, bytes]) => `${name}:${bytes.length}`)
          .join(' ')})`
        const problem = loads(directory, head, covered)
        if (problem) failures.push(`${label}: ${problem}`)
      }
      return { states: cutStates.length, failures }
    }

    /** Null when the thread loads as it must; otherwise what went wrong. */
    const loads = (
      directory: string,
      head: number | null,
      covered: number | null
    ): string | null => {
      const ignore = (): void => {}
      const check = (
        result: ReturnType<IncrementalChatJournal['replay']>,
        who: string
      ): string | null => {
        if (result.revision === null) {
          return covered === null ? null : `${who} found no record, and ${covered} was covered`
        }
        if (covered !== null && result.revision < covered)
          return `${who} read revision ${result.revision}, below the ${covered} covered`
        if (head !== null && result.revision > head)
          return `${who} read revision ${result.revision}, beyond the head ${head}`
        if (JSON.stringify(result.record) !== JSON.stringify(records[result.revision - 1]))
          return `${who} read a record that is not the chain's at ${result.revision}`
        return null
      }
      try {
        const readOnly = createIncrementalChatJournal(directory, {
          noteDurabilityDebt: ignore,
          canWrite: () => false
        }).replay(CHAT)
        const readOnlyProblem = check(readOnly, 'a reader')
        if (readOnlyProblem) return readOnlyProblem
        const journal = createIncrementalChatJournal(directory, {
          noteDurabilityDebt: ignore,
          repairTornTailBeforeAppend: true
        })
        const loaded = journal.replay(CHAT)
        const problem = check(loaded, 'the writer')
        if (problem) return problem
        if (loaded.revision !== readOnly.revision)
          return `the writer read ${loaded.revision}, the reader ${readOnly.revision}`
        if (loaded.revision === null) return null
        // The thread goes on from what it loaded.
        journal.append(batches[loaded.revision - 1])
        const next = createIncrementalChatJournal(directory, {
          noteDurabilityDebt: ignore
        }).replay(CHAT)
        if (next.revision !== loaded.revision + 1)
          return `after one more line the thread read ${next.revision}, not ${loaded.revision + 1}`
        return null
      } catch (error) {
        return `threw: ${(error as Error).message}`
      }
    }

    it('loads every state of appends, barriers, a compaction and a re-anchor', async () => {
      const { states, failures } = await everyPowerCut([
        initialize,
        append(2),
        barrier,
        append(1),
        compact,
        append(2),
        barrier,
        append(1),
        reanchor(1),
        append(2),
        barrier,
        append(1)
      ])

      expect(failures).toEqual([])
      expect(states).toBeGreaterThan(40)
    })

    it('loads every state of a rotation, and of a compaction adopted or not', async () => {
      const cache = new IncrementalChatJournalDescriptorCache(flusher())
      try {
        const { states, failures } = await everyPowerCut(
          [
            initialize,
            append(1),
            barrier,
            append(1),
            rotate,
            append(1),
            barrier,
            append(1),
            startCompaction,
            append(1),
            adopt,
            append(1),
            barrier,
            append(1),
            startCompaction,
            append(1),
            prepare,
            append(1)
          ],
          () => ({ descriptorCache: cache, rotationEnabled: true }),
          true
        )

        expect(failures).toEqual([])
        expect(states).toBeGreaterThan(200)
      } finally {
        cache.retireSync()
      }
    })
  }
)
