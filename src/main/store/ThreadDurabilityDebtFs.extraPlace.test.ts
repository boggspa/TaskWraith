/**
 * The place kept for urgent syncs: an urgent request that finds every place
 * taken by syncs that are not urgent starts at once in one more place, which
 * nothing else ever uses. Through the real port over file calls whose syncs
 * each take the time the test gives their path, on a clock the test moves,
 * counted in syncs started and in that clock.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createThreadDurabilityDebt } from './ThreadDurabilityDebt'
import {
  THREAD_DURABILITY_URGENT_RUN,
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
      next.done(null)
    }
    this.now = until
    await settle()
  }

  /** When each sync of a path started. */
  startsOf(path: string): number[] {
    return this.syncs.filter((sync) => sync.path === path).map((sync) => sync.startedAt)
  }

  /** The most syncs that were ever running at once. */
  mostAtOnce(): number {
    let most = 0
    for (const sync of this.syncs) {
      const atOnce = this.syncs.filter(
        (other) =>
          other.startedAt <= sync.startedAt &&
          (other.endedAt === null || other.endedAt > sync.startedAt)
      ).length
      most = Math.max(most, atOnce)
    }
    return most
  }
}

/** Lets every promise callback that is ready run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('the place kept for an urgent sync', () => {
  let calls: TimedCalls
  let port: ThreadDurabilityDebtFs

  beforeEach(() => {
    calls = new TimedCalls((target) => (target.startsWith('/p/slow') ? 800 : 5))
    port = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight: 2,
      now: () => calls.now
    })
  })

  /** When a request settled on the test's clock; null while it waits. */
  const timed = (request: Promise<unknown>): { at: number | null } => {
    const seen = { at: null as number | null }
    void request.then(() => {
      seen.at = calls.now
    })
    return seen
  }

  it('starts an urgent sync at once when two slow syncs that are not urgent hold both places', async () => {
    void port.syncFile('/p/slow-1')
    void port.syncFile('/p/slow-2')
    await calls.advance(1)
    const urgent = timed(port.syncFile('/p/journal', { urgent: true }))
    await calls.advance(100)

    expect(calls.startsOf('/p/journal')).toEqual([1])
    expect(urgent.at).toBe(6)
    expect(port.snapshot()).toMatchObject({ extraUrgentStarts: 1, startedUrgent: 1, inFlight: 2 })
    expect(calls.mostAtOnce()).toBe(3)
  })

  it('keeps a second urgent request waiting while the extra place is busy, then starts it there', async () => {
    void port.syncFile('/p/slow-1')
    void port.syncFile('/p/slow-2')
    await calls.advance(1)
    const first = timed(port.syncFile('/p/journal-1', { urgent: true }))
    await calls.advance(2)
    const second = timed(port.syncFile('/p/journal-2', { urgent: true }))
    await calls.advance(100)

    expect(first.at).toBe(6)
    // It waited only for the extra place, not for a slow sync to end.
    expect(calls.startsOf('/p/journal-2')).toEqual([6])
    expect(second.at).toBe(11)
    expect(port.snapshot()).toMatchObject({ extraUrgentStarts: 2, peakInFlight: 3 })
    expect(calls.mostAtOnce()).toBe(3)
  })

  it('starts nothing that is not urgent in the extra place, so every other class keeps its limit', async () => {
    void port.syncFile('/p/slow-1')
    void port.syncFile('/p/slow-2')
    await calls.advance(1)
    void port.syncFile('/p/normal')
    void port.syncDirectory('/p/background', { background: true })
    void port.syncFile('/p/journal', { urgent: true })
    await calls.advance(799)

    // The urgent one ran beside the slow ones; the others waited for a shared place.
    expect(calls.startsOf('/p/journal')).toEqual([1])
    expect(calls.startsOf('/p/normal')).toEqual([])
    expect(calls.startsOf('/p/background')).toEqual([])
    await calls.advance(900)
    expect(calls.startsOf('/p/normal')).toEqual([800])
    expect(calls.startsOf('/p/background')).toEqual([800])
    expect(port.snapshot()).toMatchObject({ extraUrgentStarts: 1, peakInFlight: 3 })
  })

  it('starts no extra urgent sync while a shared place already holds an urgent one', async () => {
    void port.syncFile('/p/slow-urgent', { urgent: true })
    void port.syncFile('/p/slow-normal')
    await calls.advance(1)
    const urgent = timed(port.syncFile('/p/journal', { urgent: true }))
    await calls.advance(900)

    expect(calls.startsOf('/p/journal')).toEqual([800])
    expect(urgent.at).toBe(805)
    expect(port.snapshot()).toMatchObject({ extraUrgentStarts: 0, peakInFlight: 2 })
  })

  it(`still starts a waiting normal sync after ${THREAD_DURABILITY_URGENT_RUN} urgent ones in a row in the shared place`, async () => {
    const one = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight: 1,
      now: () => calls.now
    })
    void one.syncFile('/p/running')
    void one.syncFile('/p/ordinary')
    let urgent = 0
    const ask = (): void => {
      urgent += 1
      void one.syncFile(`/p/urgent-${urgent}`, { urgent: true })
    }
    ask()
    ask()
    // Urgent syncs keep coming, one more every 5 ms, each taking 5 ms.
    for (let at = 5; calls.startsOf('/p/ordinary').length === 0; at += 5) {
      await calls.advance(at)
      ask()
    }

    const order = calls.syncs.map((sync) => sync.path)
    const before = order.slice(0, order.indexOf('/p/ordinary'))
    // The first urgent one started beside the running sync, in the place kept
    // for it; then the bound counted the ones in the shared place.
    expect(calls.startsOf('/p/urgent-1')).toEqual([0])
    expect(before.filter((path) => path.startsWith('/p/urgent-'))).toHaveLength(
      THREAD_DURABILITY_URGENT_RUN + 1
    )
    expect(one.snapshot()).toMatchObject({ fairStarts: 1 })
    expect(calls.mostAtOnce()).toBe(2)
  })

  it('settles a user’s barrier after its own sync while two run-final syncs take 800 ms', async () => {
    const debt = createThreadDurabilityDebt({ port, now: () => calls.now })
    debt.note('agents-1', { file: '/p/slow-events-1', owner: 'run-events', run: 'run-1' })
    debt.note('agents-2', { file: '/p/slow-events-2', owner: 'run-events', run: 'run-2' })
    void debt.barrier('agents-1', { run: 'run-1' })
    void debt.barrier('agents-2', { run: 'run-2' })
    debt.note('user', { file: '/p/journal', owner: 'journal' })
    await calls.advance(1)
    const user = timed(debt.barrier('user', { threadOnly: true, urgent: true }))
    await calls.advance(100)

    expect(user.at).toBe(6)
    expect(port.snapshot()).toMatchObject({ extraUrgentStarts: 1 })
  })
})
