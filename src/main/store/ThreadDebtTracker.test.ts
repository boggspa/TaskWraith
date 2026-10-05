/**
 * What pays a thread's debt when no moment does: the idle barrier, quit and
 * erasure, over the real debt, a port in memory and a clock moved by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createThreadDurabilityDebt, type ThreadDurabilityPort } from './ThreadDurabilityDebt'
import { IDLE_SWEEP_FLOOR_MS, THREAD_IDLE_BARRIER_MS, ThreadDebtTracker } from './ThreadDebtTracker'

afterEach(() => {
  vi.restoreAllMocks()
})

interface FakeTimer {
  at: number
  ms: number
  callback: () => void
  unref: ReturnType<typeof vi.fn>
  cleared: boolean
  fired: boolean
}

/** A clock and timers moved only by `advance`. */
function clock() {
  let now = 0
  const timers: FakeTimer[] = []
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    now: () => now,
    timers,
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired),
    setTimer: (callback: () => void, ms: number) => {
      const timer: FakeTimer = {
        at: now + ms,
        ms,
        callback,
        unref: vi.fn(),
        cleared: false,
        fired: false
      }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle: unknown) => {
      if (handle) (handle as FakeTimer).cleared = true
    },
    /** Moves the clock, firing each timer that falls due on the way, and lets what it started settle. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        await settle()
        const due = timers
          .filter((timer) => !timer.cleared && !timer.fired && timer.at <= end)
          .sort((left, right) => left.at - right.at)[0]
        if (!due) break
        now = Math.max(now, due.at)
        due.fired = true
        due.callback()
      }
      now = end
      await settle()
    }
  }
}

type Outcome = 'synced' | 'refused' | 'held'

/** A port in memory: each sync is recorded, and settles as `outcome` says for its path. */
function port(outcome: (target: string) => Outcome = () => 'synced') {
  const asked: string[] = []
  const held: Array<() => void> = []
  const sync = (target: string) => {
    asked.push(target)
    const result = outcome(target)
    if (result === 'refused') return Promise.reject(new Error('EIO: the disk refused'))
    if (result === 'held')
      return new Promise<'synced'>((resolve) => held.push(() => resolve('synced')))
    return Promise.resolve('synced' as const)
  }
  const fake: ThreadDurabilityPort = { syncFile: sync, syncDirectory: sync }
  return { port: fake, asked, release: () => held.splice(0).forEach((resolve) => resolve()) }
}

function tracked(outcome?: (target: string) => Outcome) {
  const time = clock()
  const disk = port(outcome)
  const debt = createThreadDurabilityDebt({ port: disk.port, now: time.now })
  const warn = vi.fn()
  const tracker = new ThreadDebtTracker({
    debt,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    warn
  })
  const write = (chatId: string, file = `/p/chat-journal-v2/${chatId}.mutations.jsonl`) =>
    tracker.note(chatId, { file, owner: 'journal' })
  return { time, disk, debt, tracker, warn, write }
}

describe('the idle barrier', () => {
  it('pays a thread that has written nothing for 15 s, once', async () => {
    const { time, disk, debt, write } = tracked()
    write('chat-1')

    await time.advance(THREAD_IDLE_BARRIER_MS - 1)
    expect(disk.asked).toEqual([])

    await time.advance(1)
    expect(disk.asked).toEqual(['/p/chat-journal-v2/chat-1.mutations.jsonl'])
    expect(debt.snapshot().owed.threads).toBe(0)
    // Armed once, for when the thread fell quiet: no polling on the way.
    expect(time.timers.map((timer) => timer.ms)).toEqual([THREAD_IDLE_BARRIER_MS])

    await time.advance(THREAD_IDLE_BARRIER_MS * 4)
    expect(debt.snapshot().barriers.raised).toBe(1)
  })

  it('waits for 15 s after the last write of a thread that keeps writing', async () => {
    const { time, disk, write } = tracked()
    write('chat-1')
    await time.advance(10_000)
    write('chat-1')

    await time.advance(THREAD_IDLE_BARRIER_MS - 1)
    expect(disk.asked).toEqual([])
    await time.advance(1)
    expect(disk.asked).toHaveLength(1)
  })

  it("keeps one timer for the whole app, unref'd, and none while nothing is owed", async () => {
    const { time, write } = tracked()
    expect(time.timers).toHaveLength(0)

    write('chat-1')
    write('chat-2')
    write('chat-3')
    expect(time.pending()).toHaveLength(1)
    expect(time.pending()[0].unref).toHaveBeenCalled()

    await time.advance(THREAD_IDLE_BARRIER_MS)
    expect(time.pending()).toHaveLength(0)
  })

  it('fires no sooner than its floor, however close together threads fall quiet', async () => {
    const { time, disk, write } = tracked()
    write('chat-1')
    await time.advance(100)
    write('chat-2')

    await time.advance(THREAD_IDLE_BARRIER_MS - 100)
    expect(disk.asked).toEqual(['/p/chat-journal-v2/chat-1.mutations.jsonl'])
    expect(time.pending().map((timer) => timer.ms)).toEqual([IDLE_SWEEP_FLOOR_MS])

    await time.advance(IDLE_SWEEP_FLOOR_MS)
    expect(disk.asked).toHaveLength(2)
  })

  it('tries a barrier the disk refused again one idle period later, never sooner', async () => {
    let refuse = true
    const { time, debt, tracker, write } = tracked(() => (refuse ? 'refused' : 'synced'))
    write('chat-1')

    await time.advance(THREAD_IDLE_BARRIER_MS)
    expect(tracker.snapshot()).toMatchObject({ idleBarriers: 1, idleFailed: 1, owing: 1 })
    expect(debt.snapshot().owed.files).toBe(1)

    await time.advance(THREAD_IDLE_BARRIER_MS - 1)
    expect(tracker.snapshot().idleBarriers).toBe(1)
    refuse = false
    await time.advance(1)
    expect(tracker.snapshot()).toMatchObject({ idleBarriers: 2, idleFailed: 1, owing: 0 })
    expect(debt.snapshot().owed.threads).toBe(0)
  })

  it('raises no second idle barrier for a thread while its first is still running', async () => {
    const { time, disk, tracker, write } = tracked((target) =>
      target.includes('chat-1') ? 'held' : 'synced'
    )
    write('chat-1')
    await time.advance(THREAD_IDLE_BARRIER_MS)
    write('chat-1')
    await time.advance(5_000)
    write('chat-2')

    // chat-2 falls quiet, and chat-1 is quiet again, while its barrier still runs.
    await time.advance(THREAD_IDLE_BARRIER_MS * 3)
    expect(tracker.snapshot().idleBarriers).toBe(2)

    disk.release()
    await time.advance(THREAD_IDLE_BARRIER_MS)
    expect(tracker.snapshot().idleBarriers).toBe(3)
  })
})

describe('what a barrier leaves the tracker', () => {
  it('forgets a thread a barrier paid, and keeps one that wrote again meanwhile', async () => {
    const { time, disk, tracker, write } = tracked(() => 'held')
    write('chat-1')
    write('chat-2')
    const first = tracker.barrier('chat-1')
    const second = tracker.barrier('chat-2')
    write('chat-2')

    disk.release()
    await Promise.all([first, second])
    await time.advance(0)

    expect(tracker.snapshot().owing).toBe(1)
  })

  it("keeps a thread after a barrier of one of its runs, which leaves another run's debt owed", async () => {
    const { disk, debt, tracker, write } = tracked()
    write('chat-1')
    tracker.note('chat-1', { file: '/p/run-events/run-1.jsonl', owner: 'run-events', run: 'run-1' })
    tracker.note('chat-1', { file: '/p/run-events/run-2.jsonl', owner: 'run-events', run: 'run-2' })

    await tracker.barrier('chat-1', { run: 'run-1' })

    expect([...disk.asked].sort()).toEqual([
      '/p/chat-journal-v2/chat-1.mutations.jsonl',
      '/p/run-events/run-1.jsonl'
    ])
    expect(debt.snapshot().barriers.scoped).toBe(1)
    expect(tracker.snapshot().owing).toBe(1)
    // The barrier of the whole thread, urgent or not, pays the rest and forgets it.
    await tracker.barrier('chat-1', { urgent: true })
    expect(disk.asked).toHaveLength(3)
    expect(debt.snapshot().barriers.urgent).toBe(1)
    expect(tracker.snapshot().owing).toBe(0)
  })
})

describe('a barrier of the thread alone', () => {
  it('keeps the thread owing while a run still owes, and its idle barrier pays the run', async () => {
    const { time, disk, debt, tracker, write } = tracked()
    write('chat-1')
    tracker.note('chat-1', { file: '/p/run-events/run-1.jsonl', owner: 'run-events', run: 'run-1' })

    await tracker.barrier('chat-1', { threadOnly: true, urgent: true })
    expect(disk.asked).toEqual(['/p/chat-journal-v2/chat-1.mutations.jsonl'])
    expect(tracker.snapshot().owing).toBe(1)

    await time.advance(THREAD_IDLE_BARRIER_MS)
    expect(disk.asked).toEqual([
      '/p/chat-journal-v2/chat-1.mutations.jsonl',
      '/p/run-events/run-1.jsonl'
    ])
    expect(debt.snapshot().owed.threads).toBe(0)
    expect(tracker.snapshot().owing).toBe(0)
  })
})

describe('erasure', () => {
  it("drops an erased thread's debt unpaid, and gives it no idle barrier", async () => {
    const { time, disk, debt, tracker, write } = tracked()
    write('chat-1')
    write('chat-2')

    tracker.forget('chat-1')

    expect(debt.snapshot().owed.threads).toBe(1)
    await time.advance(THREAD_IDLE_BARRIER_MS)
    expect(disk.asked).toEqual(['/p/chat-journal-v2/chat-2.mutations.jsonl'])
  })

  it("drops every thread's debt at a global clear", async () => {
    const { time, disk, debt, tracker, write } = tracked()
    write('chat-1')
    write('chat-2')

    tracker.forgetAll()

    expect(debt.snapshot().owed.threads).toBe(0)
    expect(tracker.snapshot().owing).toBe(0)
    await time.advance(THREAD_IDLE_BARRIER_MS)
    expect(disk.asked).toEqual([])
  })
})

describe('quit', () => {
  it('pays every thread that owes something, and stops the idle timer', async () => {
    const { time, disk, debt, tracker, warn, write } = tracked()
    write('chat-1')
    write('chat-2')

    expect(await tracker.payAll(10_000)).toEqual({ threads: 2, unpaid: 0 })

    expect([...disk.asked].sort()).toEqual([
      '/p/chat-journal-v2/chat-1.mutations.jsonl',
      '/p/chat-journal-v2/chat-2.mutations.jsonl'
    ])
    expect(debt.snapshot().owed.threads).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    write('chat-3')
    expect(time.pending()).toHaveLength(0)
  })

  it('counts what it could not pay in its time, or the disk refused, and logs the count alone', async () => {
    const { time, tracker, warn, write } = tracked((target) =>
      target.includes('chat-1') ? 'held' : target.includes('chat-2') ? 'refused' : 'synced'
    )
    write('chat-1')
    write('chat-2')
    write('chat-3')

    const quit = tracker.payAll(5_000)
    await time.advance(5_000)

    expect(await quit).toEqual({ threads: 3, unpaid: 2 })
    expect(tracker.snapshot()).toMatchObject({ quitThreads: 3, quitUnpaid: 2 })
    expect(warn).toHaveBeenCalledTimes(1)
    const [message] = warn.mock.calls[0]
    expect(message).toBe('[thread-barrier] 2 of 3 thread(s) still owed the disk at quit')
  })

  it('returns at once when nothing is owed', async () => {
    const { tracker } = tracked()
    expect(await tracker.payAll(5_000)).toEqual({ threads: 0, unpaid: 0 })
  })
})
