/**
 * The barrier of a wait the user sits in, raised while another barrier runs
 * or is queued on its thread: it syncs the thread's own paths beside that
 * barrier and waits for nothing else. Driven through the real port over file
 * calls whose syncs each take the time the test gives their path, on a clock
 * the test moves, and counted in syncs started and in that clock.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createThreadDurabilityDebt, type ThreadDurabilityDebt } from './ThreadDurabilityDebt'
import {
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsCalls
} from './ThreadDurabilityDebtFs'

type Done = (error: NodeJS.ErrnoException | null) => void

interface Sync {
  path: string
  startedAt: number
  endsAt: number
  endedAt: number | null
  done: Done
}

/** File calls whose syncs each take the time `durationOf` gives their path, on the test's clock. */
class TimedCalls implements ThreadDurabilityDebtFsCalls {
  readonly constants = { O_RDONLY: 0, O_RDWR: 2 }
  now = 0
  /** Every sync started, in order. */
  readonly syncs: Sync[] = []
  /** Paths whose next sync fails. */
  readonly failing = new Set<string>()
  private nextFd = 100
  private paths = new Map<number, string>()

  constructor(private readonly durationOf: (path: string) => number) {}

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
    this.syncs.push({
      path: target,
      startedAt: this.now,
      endsAt: this.now + this.durationOf(target),
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
      await settle()
      const next = this.syncs
        .filter((sync) => sync.endedAt === null)
        .sort((left, right) => left.endsAt - right.endsAt)[0]
      if (!next || next.endsAt > until) break
      this.now = next.endsAt
      next.endedAt = next.endsAt
      if (this.failing.delete(next.path)) {
        next.done(Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }))
      } else next.done(null)
    }
    this.now = until
    await settle()
  }

  /** When each sync of a path started. */
  startsOf(path: string): number[] {
    return this.syncs.filter((sync) => sync.path === path).map((sync) => sync.startedAt)
  }
}

/** Lets every promise callback that is ready run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const CHAT = 'chat-1'
const journal = '/p/chat-journal-v2/chat-1.mutations.jsonl'
const journalDirectory = '/p/chat-journal-v2'
const events = (run: string): string => `/p/run-events/${run}.jsonl`

describe('a user’s barrier while another barrier runs on its thread', () => {
  let calls: TimedCalls
  let port: ThreadDurabilityDebtFs
  let debt: ThreadDurabilityDebt
  /** Milliseconds each sync takes, by path. */
  let durations: Map<string, number>

  const build = (maxInFlight = 2): void => {
    calls = new TimedCalls((target) => durations.get(target) ?? 5)
    port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight })
    debt = createThreadDurabilityDebt({ port, now: () => calls.now })
  }

  beforeEach(() => {
    durations = new Map([[events('run-1'), 500]])
    build()
  })

  /** When a barrier settled on the test's clock, or how it failed; null while it waits. */
  const timed = (promise: Promise<void>): { at: number | null; error: string | null } => {
    const seen = { at: null as number | null, error: null as string | null }
    promise.then(
      () => {
        seen.at = calls.now
      },
      (error: Error) => {
        seen.at = calls.now
        seen.error = error.message
      }
    )
    return seen
  }
  const userBarrier = (): Promise<void> => debt.barrier(CHAT, { threadOnly: true, urgent: true })

  it('resolves after the journal’s sync alone, and starts no sync of the run-events file', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const running = timed(debt.barrier(CHAT, { run: 'run-1' }))
    await calls.advance(5)
    // The user's message: a new line in the journal, while the run's file syncs.
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const user = timed(userBarrier())
    await calls.advance(499)

    expect(user).toEqual({ at: 10, error: null })
    expect(running.at).toBeNull()
    expect(calls.startsOf(events('run-1'))).toEqual([0])
    expect(calls.startsOf(journal)).toEqual([0, 5])
    expect(port.snapshot()).toMatchObject({ startedUrgent: 1, promoted: 0 })
    expect(debt.snapshot().barriers).toMatchObject({ beside: 1, hastened: 0, shared: 0 })

    // The running barrier settles with everything it took, at its own pace.
    await calls.advance(600)
    expect(running).toEqual({ at: 500, error: null })
    expect(debt.snapshot().owners['run-events']).toMatchObject({ synced: 1, failed: 0 })
    // What the user's barrier synced paid no debt: only the running barrier's syncs count.
    expect(debt.snapshot().owners.journal).toMatchObject({ synced: 1, failed: 0 })
    // The new line stays owed to the barriers of the thread, which sync it again.
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
  })

  it('starts a new urgent journal sync when the running barrier’s began before the new line', async () => {
    durations.set(journal, 50)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const running = timed(debt.barrier(CHAT, { run: 'run-1' }))
    await calls.advance(10)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const user = timed(userBarrier())
    await calls.advance(499)

    // Both places were taken by syncs that are not urgent: its own started at
    // once, in the place kept for an urgent sync.
    expect(calls.startsOf(journal)).toEqual([0, 10])
    expect(user).toEqual({ at: 60, error: null })
    expect(port.snapshot()).toMatchObject({ startedUrgent: 1 })
    expect(calls.startsOf(events('run-1'))).toEqual([0])
    await calls.advance(600)
    expect(running).toEqual({ at: 500, error: null })
  })

  it('syncs beside it, files first, the thread’s own paths that barrier took and has not synced', async () => {
    build(4)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const running = timed(debt.barrier(CHAT, { run: 'run-1' }))
    await calls.advance(1)
    // Nothing new: what it needs is what the running barrier took.
    const user = timed(userBarrier())
    await calls.advance(499)

    expect(calls.startsOf(journal)).toEqual([0, 1])
    // Its directory only once its file is synced, and long before the running
    // barrier reaches the directories it took.
    expect(calls.startsOf(journalDirectory)).toEqual([6])
    expect(user).toEqual({ at: 11, error: null })
    await calls.advance(600)
    expect(running).toEqual({ at: 505, error: null })
    expect(calls.startsOf(journalDirectory)).toEqual([6, 500])
  })

  it('resolves at once, with no sync, when the running barrier has synced all of the thread’s own it took', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    void debt.barrier(CHAT, { run: 'run-1' })
    await calls.advance(6)
    const started = calls.syncs.length
    const user = timed(userBarrier())
    await settle()

    expect(user).toEqual({ at: 6, error: null })
    expect(calls.syncs.length).toBe(started)
  })

  it('syncs only what the running barrier has not, and what it syncs itself counts for the next one', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { directory: journalDirectory })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    void debt.barrier(CHAT, { run: 'run-1' })
    await calls.advance(6)
    const first = timed(userBarrier())
    await calls.advance(100)

    expect(first).toEqual({ at: 11, error: null })
    expect(calls.startsOf(journal)).toEqual([0])
    expect(calls.startsOf(journalDirectory)).toEqual([6])

    // The running barrier reaches its directories only at 500; the first
    // user's sync of the directory already covers it for a second user.
    const started = calls.syncs.length
    const second = timed(userBarrier())
    await settle()
    expect(second).toEqual({ at: 100, error: null })
    expect(calls.syncs.length).toBe(started)
  })

  it('goes ahead of the running barrier’s waiting syncs without raising them', async () => {
    build(1)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const running = timed(debt.barrier(CHAT, { run: 'run-1' }))
    await calls.advance(1)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const user = timed(userBarrier())
    await calls.advance(499)

    // One shared place, held by the running barrier's journal: the user's
    // started in the place kept for an urgent sync, and the run's file, never
    // raised, only once the user's barrier had settled.
    expect(calls.startsOf(journal)).toEqual([0, 1])
    expect(calls.startsOf(events('run-1'))).toEqual([6])
    expect(user).toEqual({ at: 6, error: null })
    expect(port.snapshot()).toMatchObject({ promoted: 0 })
    expect(debt.snapshot().barriers).toMatchObject({ hastened: 0 })
    await calls.advance(600)
    expect(running).toEqual({ at: 506, error: null })
  })

  it('syncs beside a queued barrier, raised as the running one ends, and never waits for it', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    durations.set(events('run-1'), 20)
    durations.set(events('run-2'), 500)
    const first = debt.barrier(CHAT, { run: 'run-1' })
    // This runs as soon as the running barrier ends, before the one queued
    // behind it starts.
    let user: { at: number | null; error: string | null } | null = null
    first.then(() => {
      user = timed(userBarrier())
    })
    await calls.advance(1)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })
    const queued = timed(debt.barrier(CHAT))
    await calls.advance(400)

    expect(user).toEqual({ at: 25, error: null })
    // The queued barrier began as the running one ended, and its syncs start
    // once the user's have settled.
    expect(calls.startsOf(events('run-2'))).toEqual([25])
    expect(debt.snapshot().barriers).toMatchObject({ beside: 1, shared: 0 })
    await calls.advance(600)
    expect(queued).toEqual({ at: 525, error: null })
  })

  it('takes nothing, so a barrier raised after it still waits for a sync of the new line', async () => {
    durations.set(journal, 600)
    durations.set(events('run-1'), 100)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    void debt.barrier(CHAT, { run: 'run-1' })
    await calls.advance(1)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const user = timed(userBarrier())
    await calls.advance(2)
    const later = timed(debt.barrier(CHAT))
    await calls.advance(2_000)

    expect(user).toEqual({ at: 601, error: null })
    expect(later.at).not.toBeNull()
    // Some sync of the journal began after the new line and ended before the
    // later barrier settled.
    const covering = calls.syncs.filter(
      (sync) =>
        sync.path === journal &&
        sync.startedAt > 1 &&
        sync.endedAt !== null &&
        sync.endedAt <= later.at!
    )
    expect(covering.length).toBeGreaterThan(0)
    expect(later).toEqual({ at: 1_201, error: null })
  })

  it('leaves a barrier of the thread’s own debt that is not urgent waiting for the running one, as before', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    void debt.barrier(CHAT, { run: 'run-1' })
    await calls.advance(5)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const own = timed(debt.barrier(CHAT, { threadOnly: true }))
    await calls.advance(499)

    expect(own.at).toBeNull()
    await calls.advance(600)
    // Queued behind it, then its own round: the journal from 500 to 505.
    expect(own).toEqual({ at: 505, error: null })
    expect(calls.startsOf(journal)).toEqual([0, 500])
    expect(debt.snapshot().barriers).toMatchObject({ beside: 0, rounds: 2 })
  })

  it('rejects when its own sync fails, and leaves the running barrier and the debt as they were', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const running = timed(debt.barrier(CHAT, { run: 'run-1' }))
    await calls.advance(5)
    debt.note(CHAT, { file: journal, owner: 'journal' })
    calls.failing.add(journal)
    const user = timed(userBarrier())
    await calls.advance(600)

    expect(user).toEqual({ at: 10, error: 'EIO: i/o error, fsync' })
    expect(running).toEqual({ at: 500, error: null })
    expect(debt.snapshot().barriers).toMatchObject({ beside: 1, besideFailed: 1, failed: 0 })
    expect(debt.snapshot().owners.journal).toMatchObject({ synced: 1, failed: 0 })
    expect(debt.snapshot().owed).toEqual({ threads: 1, files: 1, directories: 0 })
  })
})
