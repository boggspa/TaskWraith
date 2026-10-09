/**
 * The trickle: what a thread owes, synced in the background while it keeps
 * writing, outside the thread's barriers, and paid by a barrier's rule. Over
 * a port that holds each sync until the test settles it, the real port over
 * file calls whose syncs take the time the test gives them, and real files
 * on a disk that keeps only what was synced.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createThreadBarrierDurability } from './ThreadBarrierDurability'
import {
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityDebtNote,
  type ThreadDurabilityDebtSnapshot,
  type ThreadDurabilityPort,
  type ThreadDurabilitySyncOptions,
  type ThreadDurabilitySyncOutcome
} from './ThreadDurabilityDebt'
import {
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsCalls
} from './ThreadDurabilityDebtFs'
import { THREAD_TRICKLE_MS, ThreadDebtTracker } from './ThreadDebtTracker'
import { watchCrashDisk, type CrashDisk } from './unsyncedWriteCrashDisk.testutil'

type SyncClass = 'urgent' | 'normal' | 'background'

const classOf = (options?: ThreadDurabilitySyncOptions): SyncClass =>
  options?.urgent ? 'urgent' : options?.background ? 'background' : 'normal'

/** Lets every promise callback that is ready run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const CHAT = 'chat-1'
const journal = '/p/chat-journal-v2/chat-1.mutations.jsonl'
const journalDirectory = '/p/chat-journal-v2'
const events = (run: string): string => `/p/run-events/${run}.jsonl`
const eventsDirectory = '/p/run-events'

interface Asked {
  kind: 'file' | 'directory'
  path: string
  syncClass: SyncClass
  settled: boolean
  settle(outcome: ThreadDurabilitySyncOutcome | Error): void
}

/** A port that holds every sync it is asked for until the test settles it. */
function heldPort() {
  const asked: Asked[] = []
  const ask =
    (kind: Asked['kind']) =>
    (target: string, options?: ThreadDurabilitySyncOptions): Promise<ThreadDurabilitySyncOutcome> =>
      new Promise((resolve, reject) => {
        const entry: Asked = {
          kind,
          path: target,
          syncClass: classOf(options),
          settled: false,
          settle: (outcome) => {
            entry.settled = true
            if (outcome instanceof Error) reject(outcome)
            else resolve(outcome)
          }
        }
        asked.push(entry)
      })
  const port: ThreadDurabilityPort = { syncFile: ask('file'), syncDirectory: ask('directory') }
  return {
    port,
    asked,
    /** What is asked for and not settled, as `<class> <kind> <path>`, oldest first. */
    open: (): string[] =>
      asked
        .filter((entry) => !entry.settled)
        .map((entry) => `${entry.syncClass} ${entry.kind} ${entry.path}`),
    /** Settle the oldest open sync of this path, of this class if one is named. */
    async settle(
      target: string,
      outcome: ThreadDurabilitySyncOutcome | Error = 'synced',
      syncClass?: SyncClass
    ): Promise<void> {
      const entry = asked.find(
        (each) =>
          !each.settled &&
          each.path === target &&
          (syncClass === undefined || each.syncClass === syncClass)
      )
      if (!entry) throw new Error(`No open sync of ${target}`)
      entry.settle(outcome)
      await flush()
    }
  }
}

/** When a promise settled, in the order things settled; null while it waits. */
function watched(promise: Promise<void>): { settled: boolean } {
  const seen = { settled: false }
  void promise.then(
    () => (seen.settled = true),
    () => (seen.settled = true)
  )
  return seen
}

describe('a round of the trickle', () => {
  it('syncs what a thread owes at background class, its files and then its directories, and pays each', async () => {
    const { port, asked, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    debt.note(CHAT, { directory: eventsDirectory, run: 'run-1' })

    const round = debt.trickle(CHAT)
    await flush()
    expect(open()).toEqual([`background file ${journal}`, `background file ${events('run-1')}`])
    expect(debt.snapshot().trickle.inFlight).toBe(2)
    await settle(journal)
    expect(open()).toEqual([`background file ${events('run-1')}`])
    await settle(events('run-1'))
    expect(open()).toEqual([
      `background directory ${journalDirectory}`,
      `background directory ${eventsDirectory}`
    ])
    await settle(journalDirectory)
    await settle(eventsDirectory)
    await round

    const snapshot = debt.snapshot()
    expect(snapshot.owed).toEqual({ threads: 0, files: 0, directories: 0 })
    expect(snapshot.owingRuns).toBe(0)
    expect(snapshot.trickle).toEqual({
      rounds: 1,
      started: 4,
      paid: 4,
      notedSince: 0,
      takenOver: 0,
      failed: 0,
      inFlight: 0
    })
    // Counted apart from what barriers paid.
    expect(snapshot.owners.journal.synced).toBe(0)

    // A barrier raised later finds nothing to pay.
    await debt.barrier(CHAT, { run: 'run-1' })
    expect(asked).toHaveLength(4)
    expect(debt.snapshot().barriers).toMatchObject({ idle: 1, rounds: 0 })
  })

  it('pays a path found gone, as a barrier does', async () => {
    const { port, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: journal, owner: 'journal' })

    const round = debt.trickle(CHAT)
    await flush()
    await settle(journal, 'missing')
    await round

    expect(debt.snapshot().owed.threads).toBe(0)
    expect(debt.snapshot().trickle).toMatchObject({ started: 1, paid: 1 })
  })

  it('keeps owed a path noted again while its sync is in flight, for the next barrier to pay', async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })

    const round = debt.trickle(CHAT)
    await flush()
    // A line written while the sync runs, which it may have begun before.
    debt.note(CHAT, { file: journal, owner: 'journal' })
    await settle(journal)
    await settle(events('run-1'))
    await round

    expect(debt.snapshot().trickle).toMatchObject({ started: 2, paid: 1, notedSince: 1 })
    // The run's file is paid, and the run owes nothing more.
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
    expect(debt.snapshot().owingRuns).toBe(0)
    const barrier = debt.barrier(CHAT)
    await flush()
    expect(open()).toEqual([`normal file ${journal}`])
    await settle(journal)
    await barrier
    expect(debt.snapshot().owed.threads).toBe(0)
  })

  it('leaves a directory noted after the round began, and the file that came with it, to the next one', async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })

    const round = debt.trickle(CHAT)
    await flush()
    // A run starts while the round runs: a new file, and the name it made.
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    debt.note(CHAT, { directory: eventsDirectory, run: 'run-1' })
    await settle(journal)

    expect(open()).toEqual([`background directory ${journalDirectory}`])
    await settle(journalDirectory)
    await round
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })
  })

  it('leaves a directory noted again after the round began, which may name a file it did not sync', async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    debt.note(CHAT, { directory: eventsDirectory, run: 'run-1' })

    const round = debt.trickle(CHAT)
    await flush()
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })
    debt.note(CHAT, { directory: eventsDirectory, run: 'run-2' })
    await settle(events('run-1'))

    expect(open()).toEqual([])
    await round
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })
  })

  it('asks for no directory when a file sync fails, and leaves both owed', async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })

    const round = debt.trickle(CHAT)
    await flush()
    await settle(journal, new Error('EIO: the disk refused'))

    // Nobody waits on a round: it settles without the failure.
    await expect(round).resolves.toBeUndefined()
    expect(open()).toEqual([])
    expect(debt.snapshot().trickle).toMatchObject({ started: 1, paid: 0, failed: 1 })
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })
    // Nor is the failure the barrier's: it syncs both, and pays them.
    const barrier = debt.barrier(CHAT)
    await flush()
    await settle(journal)
    await settle(journalDirectory)
    await expect(barrier).resolves.toBeUndefined()
    expect(debt.snapshot().barriers.failed).toBe(0)
  })

  it('asks at most once for a path while a sync of it waits or runs, and runs one round a thread at a time', async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    const otherJournal = '/p/chat-journal-v2/chat-2.mutations.jsonl'
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    debt.note('chat-2', { file: otherJournal, owner: 'journal' })
    debt.note('chat-2', { directory: journalDirectory })

    const first = debt.trickle(CHAT)
    await flush()
    // Asked again while its round runs, the thread gets no second one.
    const again = debt.trickle(CHAT)
    await flush()
    expect(open()).toEqual([`background file ${journal}`])
    await settle(journal)
    expect(open()).toEqual([`background directory ${journalDirectory}`])

    // Another thread owes the same folder, whose sync the first round has asked for.
    const second = debt.trickle('chat-2')
    await flush()
    await settle(otherJournal)
    expect(open()).toEqual([`background directory ${journalDirectory}`])
    await settle(journalDirectory)
    await Promise.all([first, again, second])

    expect(debt.snapshot().trickle).toMatchObject({ rounds: 2, started: 3, paid: 3 })
    // That thread still owes the folder: its next round or barrier syncs it.
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 0, directories: 1 })
  })

  it('asks for no directory while an earlier round still syncs one of its files', async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    const first = debt.trickle(CHAT)
    await flush()
    // A barrier pays all of it while the round's sync of the journal runs,
    // and the thread writes again: a new line, and a new name.
    const barrier = debt.barrier(CHAT)
    await flush()
    await settle(journal, 'synced', 'normal')
    await settle(journalDirectory, 'synced', 'normal')
    await barrier
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })

    const second = debt.trickle(CHAT)
    await flush()

    // The journal's sync from the first round is still in flight, and may
    // have begun before the new line: the folder waits for a later round.
    expect(open()).toEqual([`background file ${journal}`])
    await settle(journal)
    await Promise.all([first, second])
    expect(debt.snapshot().trickle).toMatchObject({ rounds: 2, started: 1, takenOver: 1 })
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 1 })
  })

  it('counts a sync of a path the thread was erased under as taken over, and keeps nothing for it', async () => {
    const { port, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port })
    debt.note(CHAT, { file: journal, owner: 'journal' })

    const round = debt.trickle(CHAT)
    await flush()
    debt.forget(CHAT)
    await settle(journal)
    await round

    expect(debt.snapshot().trickle).toMatchObject({ started: 1, paid: 0, takenOver: 1 })
    expect(debt.snapshot().owed.threads).toBe(0)
  })

  it('does nothing for a thread that owes nothing', async () => {
    const { port, asked } = heldPort()
    const debt = createThreadDurabilityDebt({ port })

    await debt.trickle(CHAT)

    expect(asked).toEqual([])
    expect(debt.snapshot().trickle.rounds).toBe(0)
  })
})

describe('a barrier and the trickle', () => {
  it('begins at once while a round runs on its thread, and pays what it took with syncs of its own', async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port, now: () => 0 })
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })

    const round = debt.trickle(CHAT)
    await flush()
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const barrier = watched(debt.barrier(CHAT, { run: 'run-1' }))
    await flush()

    expect(open()).toEqual([
      `background file ${journal}`,
      `background file ${events('run-1')}`,
      `normal file ${journal}`,
      `normal file ${events('run-1')}`
    ])
    await settle(journal, 'synced', 'normal')
    await settle(events('run-1'), 'synced', 'normal')
    // Settled while the round's syncs still run.
    expect(barrier.settled).toBe(true)
    expect(debt.snapshot().waits.normal).toMatchObject({
      count: 1,
      waitedBehind: 0,
      behindTotalMs: 0
    })
    expect(debt.snapshot().barriers).toMatchObject({ shared: 0, rounds: 1 })

    await settle(journal)
    await settle(events('run-1'))
    await round
    expect(debt.snapshot().trickle).toMatchObject({ started: 2, paid: 0, takenOver: 2 })
    expect(debt.snapshot().owed.threads).toBe(0)
  })

  it("asks a user's barrier's syncs as urgent at once while a round runs on its thread", async () => {
    const { port, open, settle } = heldPort()
    const debt = createThreadDurabilityDebt({ port, now: () => 0 })
    debt.note(CHAT, { file: journal, owner: 'journal' })

    void debt.trickle(CHAT)
    await flush()
    const user = watched(debt.barrier(CHAT, { threadOnly: true, urgent: true }))
    await flush()

    expect(open()).toEqual([`background file ${journal}`, `urgent file ${journal}`])
    await settle(journal, 'synced', 'urgent')
    expect(user.settled).toBe(true)
    expect(debt.snapshot().waits.urgent).toMatchObject({ waitedBehind: 0, behindTotalMs: 0 })
  })
})

describe('the paths a barrier of a run took', () => {
  it('counts, for each round of a barrier of one or more runs, the files and directories it took', async () => {
    const paid: string[] = []
    const debt = createThreadDurabilityDebt({
      port: {
        syncFile: async (target) => (paid.push(target), 'synced'),
        syncDirectory: async (target) => (paid.push(target), 'synced')
      }
    })
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    debt.note(CHAT, { directory: eventsDirectory, run: 'run-1' })
    debt.note(CHAT, { directory: '/p/run-artifacts/run-1', run: 'run-1' })
    await debt.barrier(CHAT, { run: 'run-1' })
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })
    await debt.barrier(CHAT, { run: 'run-2' })
    // Neither a barrier of everything nor one of the thread's own debt alone.
    debt.note(CHAT, { file: journal, owner: 'journal' })
    await debt.barrier(CHAT)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    await debt.barrier(CHAT, { threadOnly: true })
    // Nor a barrier of a run that had nothing to pay.
    await debt.barrier(CHAT, { run: 'run-3' })

    expect(paid).toHaveLength(7)
    expect(debt.snapshot().barriers).toMatchObject({
      rounds: 4,
      runRounds: 2,
      runPathsTotal: 5,
      runPathsMost: 4
    })
  })
})

type Done = (error: NodeJS.ErrnoException | null) => void

interface Sync {
  path: string
  startedAt: number
  endsAt: number
  endedAt: number | null
  done: Done
}

/** File calls whose syncs each take the time `durationOf` gives a path's nth sync, on the test's clock. */
class TimedCalls implements ThreadDurabilityDebtFsCalls {
  readonly constants = { O_RDONLY: 0, O_RDWR: 2 }
  now = 0
  readonly syncs: Sync[] = []
  private nextFd = 100
  private paths = new Map<number, string>()

  constructor(private readonly durationOf: (path: string, nth: number) => number) {}

  open(
    target: string,
    _flags: number,
    callback: (error: NodeJS.ErrnoException | null, fd: number) => void
  ): void {
    const fd = this.nextFd
    this.nextFd += 1
    this.paths.set(fd, target)
    queueMicrotask(() => callback(null, fd))
  }

  fsync(fd: number, callback: Done): void {
    const target = this.paths.get(fd)!
    const nth = this.startsOf(target).length
    this.syncs.push({
      path: target,
      startedAt: this.now,
      endsAt: this.now + this.durationOf(target, nth),
      endedAt: null,
      done: callback
    })
  }

  close(fd: number, callback: Done): void {
    this.paths.delete(fd)
    queueMicrotask(() => callback(null))
  }

  /** Move the clock to `until`, ending each sync when its time comes, earliest first. */
  async advance(until: number): Promise<void> {
    for (;;) {
      await flush()
      const next = this.syncs
        .filter((sync) => sync.endedAt === null)
        .sort((left, right) => left.endsAt - right.endsAt)[0]
      if (!next || next.endsAt > until) break
      this.now = next.endsAt
      next.endedAt = next.endsAt
      next.done(null)
    }
    this.now = until
    await flush()
  }

  /** When each sync of a path started. */
  startsOf(target: string): number[] {
    return this.syncs.filter((sync) => sync.path === target).map((sync) => sync.startedAt)
  }
}

describe('the trickle through the port', () => {
  let calls: TimedCalls
  let port: ThreadDurabilityDebtFs
  let debt: ThreadDurabilityDebt

  const build = (maxInFlight: number, durationOf: (target: string, nth: number) => number) => {
    calls = new TimedCalls(durationOf)
    port = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight,
      now: () => calls.now
    })
    debt = createThreadDurabilityDebt({ port, now: () => calls.now })
  }

  /** When a barrier settled on the test's clock; null while it waits. */
  const timed = (promise: Promise<void>): { at: number | null } => {
    const seen = { at: null as number | null }
    void promise.then(() => {
      seen.at = calls.now
    })
    return seen
  }

  it.each([
    ['normal', {}, 800, 805, 0],
    ['urgent', { threadOnly: true, urgent: true }, 1, 6, 1]
  ] as const)(
    'has a %s barrier take over the sync the trickle asked for that still waits, at its own class',
    async (_syncClass, options, startsAt, settlesAt, startedUrgent) => {
      build(1, (target) => (target === '/p/slow' ? 800 : 5))
      // A sync somebody waits on holds the one shared place for 800 ms.
      void port.syncFile('/p/slow')
      debt.note(CHAT, { file: journal, owner: 'journal' })
      void debt.trickle(CHAT)
      await calls.advance(1)
      expect(port.snapshot()).toMatchObject({ queuedBackground: 1 })

      const barrier = timed(debt.barrier(CHAT, options))
      await calls.advance(1_000)

      // One sync of the journal: the trickle's, started at the barrier's class.
      expect(calls.startsOf(journal)).toEqual([startsAt])
      expect(barrier.at).toBe(settlesAt)
      expect(port.snapshot()).toMatchObject({
        joined: 1,
        promoted: 1,
        startedBackground: 0,
        startedUrgent
      })
      expect(port.snapshot().timing.background.startToSettle.count).toBe(0)
      expect(debt.snapshot().trickle).toMatchObject({ started: 1, takenOver: 1, paid: 0 })
      expect(debt.snapshot().owed.threads).toBe(0)
    }
  )

  it('never holds a barrier behind a sync it has in flight: the barrier syncs the path again, beside it', async () => {
    build(2, (target, nth) => (target === journal && nth === 0 ? 800 : 5))
    debt.note(CHAT, { file: journal, owner: 'journal' })
    void debt.trickle(CHAT)
    await calls.advance(1)
    debt.note(CHAT, { file: journal, owner: 'journal' })

    const barrier = timed(debt.barrier(CHAT))
    await calls.advance(100)

    expect(calls.startsOf(journal)).toEqual([0, 1])
    expect(barrier.at).toBe(6)
    expect(debt.snapshot().waits.normal).toMatchObject({ waitedBehind: 0, behindTotalMs: 0 })
    await calls.advance(1_000)
    expect(debt.snapshot().trickle).toMatchObject({ started: 1, takenOver: 1 })
  })
})

/**
 * Seeded runs of notes, rounds and barriers of every kind, settled in random
 * order: after a last barrier of everything, every path noted was synced by
 * a sync asked for after its last note, and no barrier waited behind a round.
 */
describe('what the trickle pays', () => {
  it.each(Array.from({ length: 40 }, (_unused, index) => index + 1))(
    'is only ever what a sync asked for after the last note covered (seed %i)',
    async (seed) => {
      let state = seed >>> 0
      const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]
      let step = 0
      /** When each path was last noted, and when each successful sync of it was asked for. */
      const lastNoted = new Map<string, number>()
      const covered = new Map<string, number[]>()
      const asked: Array<{ path: string; at: number; done: boolean; settle(ok: boolean): void }> =
        []
      const ask = (target: string): Promise<ThreadDurabilitySyncOutcome> =>
        new Promise((resolve, reject) => {
          const at = step
          asked.push({
            path: target,
            at,
            done: false,
            settle: (ok) => {
              if (!ok) return reject(new Error('EIO: injected'))
              covered.set(target, [...(covered.get(target) ?? []), at])
              resolve('synced')
            }
          })
        })
      const debt = createThreadDurabilityDebt({
        port: { syncFile: ask, syncDirectory: ask },
        now: () => step
      })
      const files: Array<Extract<ThreadDurabilityDebtNote, { file: string }>> = [
        { file: journal, owner: 'journal' },
        { file: events('A'), owner: 'run-events', run: 'A' },
        { file: events('B'), owner: 'run-events', run: 'B' }
      ]
      const directories: ThreadDurabilityDebtNote[] = [
        { directory: journalDirectory },
        { directory: eventsDirectory, run: 'A' },
        { directory: eventsDirectory, run: 'B' }
      ]
      const barriers = [
        undefined,
        { run: 'A' },
        { run: 'B', urgent: true },
        { threadOnly: true },
        { threadOnly: true, urgent: true }
      ] as const
      for (; step < 80; step += 1) {
        const roll = random()
        if (roll < 0.35) {
          const note = random() < 0.7 ? pick(files) : pick(directories)
          debt.note(CHAT, note)
          lastNoted.set('file' in note ? note.file : note.directory, step)
        } else if (roll < 0.5) {
          void debt.trickle(CHAT)
        } else if (roll < 0.62) {
          const options = pick(barriers)
          debt.barrier(CHAT, options).catch(() => {})
        } else {
          const open = asked.filter((each) => !each.done)
          if (open.length > 0) {
            const one = pick(open)
            one.done = true
            one.settle(random() > 0.05)
          }
        }
        await flush()
      }
      // Settle everything, then pay all that is left.
      for (;;) {
        const open = asked.filter((each) => !each.done)
        if (open.length === 0) break
        for (const each of open) {
          each.done = true
          each.settle(true)
        }
        await flush()
      }
      const last = debt.barrier(CHAT)
      for (;;) {
        await flush()
        const open = asked.filter((each) => !each.done)
        if (open.length === 0) break
        for (const each of open) {
          each.done = true
          each.settle(true)
        }
      }
      await last

      expect(debt.snapshot().owed.threads).toBe(0)
      for (const [target, at] of lastNoted) {
        expect(
          (covered.get(target) ?? []).some((askedAt) => askedAt >= at),
          `${target}, last noted at step ${at}`
        ).toBe(true)
      }
      const trickle = debt.snapshot().trickle
      expect(trickle.paid + trickle.notedSince + trickle.takenOver + trickle.failed).toBe(
        trickle.started
      )
      expect(trickle.inFlight).toBe(0)
    }
  )
})

interface FakeTimer {
  at: number
  ms: number
  callback: () => void
  cleared: boolean
  fired: boolean
}

/** A clock and timers moved only by `advance`. */
function clock() {
  let now = 0
  const timers: FakeTimer[] = []
  return {
    now: () => now,
    timers,
    setTimer: (callback: () => void, ms: number) => {
      const timer: FakeTimer = { at: now + ms, ms, callback, cleared: false, fired: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle: unknown) => {
      if (handle) (handle as FakeTimer).cleared = true
    },
    /** Moves the clock to `until`, firing each timer that falls due on the way. */
    async advance(until: number) {
      for (;;) {
        await flush()
        const due = timers
          .filter((timer) => !timer.cleared && !timer.fired && timer.at <= until)
          .sort((left, right) => left.at - right.at)[0]
        if (!due) break
        now = Math.max(now, due.at)
        due.fired = true
        due.callback()
      }
      now = until
      await flush()
    }
  }
}

// The disk that keeps only what was synced is POSIX only.
describe.skipIf(process.platform === 'win32')('a run streaming for 20 s', () => {
  const PREFIX = 'log-trickle-'
  const roots: string[] = []
  const disks: CrashDisk[] = []

  afterEach(() => {
    while (disks.length > 0) disks.pop()!.dispose()
    for (const root of roots.splice(0)) {
      // Only the folder this test made, never one computed from it.
      if (root === os.tmpdir() || !root.startsWith(path.join(os.tmpdir(), PREFIX))) {
        throw new Error(`Refusing to remove ${root}`)
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  interface Paid {
    path: string
    syncClass: SyncClass
    /** Bytes a file sync made safe that no earlier sync had. */
    bytes: number
  }

  /** What the stream writes through, and the debt it reads after. */
  interface Streamed {
    note: NoteThreadDurabilityDebt
    barrier(chatId: string, options: { run: string }): Promise<void>
    snapshot(): ThreadDurabilityDebtSnapshot
  }
  type Build = (port: ThreadDurabilityPort, time: ReturnType<typeof clock>) => Streamed

  /**
   * One thread on a disk that keeps only what was synced: its run appends a
   * 1,000-byte event every 100 ms and its journal a 2,000-byte line every
   * 500 ms, each file new at its first write, from 0 until 19.9 s. At 19.95 s
   * the run's final record raises the run's barrier.
   */
  async function streaming(build: Build) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
    roots.push(root)
    const eventsFile = path.join(root, 'run-events', 'run-1.jsonl')
    const journalFile = path.join(root, 'chat-journal-v2', 'chat-1.mutations.jsonl')
    fs.mkdirSync(path.dirname(eventsFile))
    fs.mkdirSync(path.dirname(journalFile))
    const disk = watchCrashDisk(root)
    disks.push(disk)
    const time = clock()
    const paid: Paid[] = []
    const safe = new Map<string, number>()
    const counted =
      (kind: 'file' | 'directory') =>
      (
        target: string,
        options?: ThreadDurabilitySyncOptions
      ): Promise<ThreadDurabilitySyncOutcome> => {
        let bytes = 0
        if (kind === 'file') {
          const size = fs.statSync(target).size
          bytes = size - (safe.get(target) ?? 0)
          safe.set(target, size)
        }
        paid.push({ path: path.relative(root, target), syncClass: classOf(options), bytes })
        return kind === 'file' ? disk.port.syncFile(target) : disk.port.syncDirectory(target)
      }
    const layer = build({ syncFile: counted('file'), syncDirectory: counted('directory') }, time)
    const write = (
      file: string,
      bytes: number,
      note: { owner: 'journal' | 'run-events'; run?: string }
    ) => {
      const created = !fs.existsSync(file)
      fs.appendFileSync(file, `${'x'.repeat(bytes - 1)}\n`)
      layer.note(CHAT, { file, ...note })
      if (created) layer.note(CHAT, { directory: path.dirname(file), run: note.run })
    }
    for (let at = 0; at < 20_000; at += 100) {
      await time.advance(at)
      write(eventsFile, 1_000, { owner: 'run-events', run: 'run-1' })
      if (at % 500 === 0) write(journalFile, 2_000, { owner: 'journal' })
    }
    await time.advance(19_950)
    const before = paid.length
    await layer.barrier(CHAT, { run: 'run-1' })
    const final = paid.slice(before)
    const background = paid.slice(0, before)
    disk.powerLoss()
    return {
      final,
      background,
      debt: layer.snapshot(),
      kept: {
        events: fs.statSync(eventsFile).size,
        journal: fs.statSync(journalFile).size
      }
    }
  }

  const tracked =
    (trickleMs?: number): Build =>
    (port, time) => {
      const debt = createThreadDurabilityDebt({ port, now: time.now })
      const tracker = new ThreadDebtTracker({
        debt,
        now: time.now,
        setTimer: time.setTimer,
        clearTimer: time.clearTimer,
        ...(trickleMs === undefined ? {} : { trickleMs })
      })
      return {
        note: tracker.note,
        barrier: (chatId, options) => tracker.barrier(chatId, options),
        snapshot: () => debt.snapshot()
      }
    }

  it('with a 2 s trickle, ends with a final barrier that pays only what was written since its last round', async () => {
    const { final, background, debt, kept } = await streaming(tracked(THREAD_TRICKLE_MS))

    // Rounds at 2, 4 ... 18 s: the first also syncs the two folders the
    // files were made in, after the files.
    expect(background.every((sync) => sync.syncClass === 'background')).toBe(true)
    expect(background.slice(0, 4).map((sync) => sync.path)).toEqual([
      'run-events/run-1.jsonl',
      'chat-journal-v2/chat-1.mutations.jsonl',
      'run-events',
      'chat-journal-v2'
    ])
    expect(background).toHaveLength(2 + 9 * 2)
    expect(debt.trickle).toMatchObject({ rounds: 9, started: 20, paid: 20, notedSince: 0 })
    // The run's final barrier: two files, holding what was written from 18 s
    // on: 20 events and 4 lines.
    expect(final).toEqual([
      { path: 'chat-journal-v2/chat-1.mutations.jsonl', syncClass: 'normal', bytes: 4 * 2_000 },
      { path: 'run-events/run-1.jsonl', syncClass: 'normal', bytes: 20 * 1_000 }
    ])
    expect(debt.barriers).toMatchObject({ runRounds: 1, runPathsTotal: 2, runPathsMost: 2 })
    // And all of it survives a power loss.
    expect(kept).toEqual({ events: 200 * 1_000, journal: 40 * 2_000 })
  })

  it('with no trickle, leaves all 20 s of it to the final barrier', async () => {
    const { final, background, debt, kept } = await streaming(tracked())

    expect(background).toEqual([])
    expect(debt.trickle.rounds).toBe(0)
    expect(final).toEqual([
      { path: 'chat-journal-v2/chat-1.mutations.jsonl', syncClass: 'normal', bytes: 40 * 2_000 },
      { path: 'run-events/run-1.jsonl', syncClass: 'normal', bytes: 200 * 1_000 },
      { path: 'chat-journal-v2', syncClass: 'normal', bytes: 0 },
      { path: 'run-events', syncClass: 'normal', bytes: 0 }
    ])
    expect(debt.barriers).toMatchObject({ runRounds: 1, runPathsTotal: 4, runPathsMost: 4 })
    expect(kept).toEqual({ events: 200 * 1_000, journal: 40 * 2_000 })
  })

  it('trickles through the layer the store builds, and not when it is turned off', async () => {
    const through =
      (trickleMs?: null): Build =>
      (port, time) => {
        const layer = createThreadBarrierDurability({
          port,
          now: time.now,
          setTimer: time.setTimer,
          clearTimer: time.clearTimer,
          checkpointPreparation: {
            start: () => null,
            admits: () => true,
            onCapacity: () => () => {}
          },
          ...(trickleMs === undefined ? {} : { trickleMs })
        })
        return {
          note: layer.note,
          barrier: (chatId, options) => layer.debt.barrier(chatId, options),
          snapshot: () => layer.debt.snapshot()
        }
      }

    const on = await streaming(through())
    expect(on.debt.trickle).toMatchObject({ rounds: 9, paid: 20 })
    expect(on.final.map((sync) => sync.bytes)).toEqual([4 * 2_000, 20 * 1_000])

    const off = await streaming(through(null))
    expect(off.debt.trickle.rounds).toBe(0)
    expect(off.final.map((sync) => sync.bytes)).toEqual([40 * 2_000, 200 * 1_000, 0, 0])
  })
})
