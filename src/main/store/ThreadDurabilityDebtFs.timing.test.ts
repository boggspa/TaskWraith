/**
 * How long syncs wait in the port and how long they take, by class: from each
 * request to the start of the sync that serves it, and from each sync's start
 * to its settling. The file calls finish only when the test says, and the
 * clock moves only when the test moves it.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsCalls,
  type ThreadDurabilitySyncTiming
} from './ThreadDurabilityDebtFs'

type Done = (error: NodeJS.ErrnoException | null) => void

/** File calls whose syncs finish only when the test says; opens and closes finish at once. */
class HeldCalls implements ThreadDurabilityDebtFsCalls {
  readonly constants = { O_RDONLY: 0, O_RDWR: 2 }
  /** Paths that are gone: opening one fails with ENOENT. */
  readonly gone = new Set<string>()
  private nextFd = 100
  private paths = new Map<number, string>()
  private syncs: Array<{ path: string; done: Done }> = []

  open(
    target: string,
    _flags: number,
    callback: (error: NodeJS.ErrnoException | null, fd: number) => void
  ): void {
    if (this.gone.has(target)) {
      queueMicrotask(() => callback(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), -1))
      return
    }
    const fd = this.nextFd
    this.nextFd += 1
    this.paths.set(fd, target)
    queueMicrotask(() => callback(null, fd))
  }

  fsync(fd: number, callback: Done): void {
    this.syncs.push({ path: this.paths.get(fd)!, done: callback })
  }

  close(fd: number, callback: Done): void {
    this.paths.delete(fd)
    queueMicrotask(() => callback(null))
  }

  syncing(): string[] {
    return this.syncs.map((sync) => sync.path)
  }

  /** Let the sync of a path finish, or fail it. */
  async finish(target: string, error: NodeJS.ErrnoException | null = null): Promise<void> {
    const index = this.syncs.findIndex((sync) => sync.path === target)
    if (index < 0) throw new Error(`no sync of ${target} is in flight`)
    this.syncs.splice(index, 1)[0].done(error)
    await settle()
  }
}

/** Lets every promise callback that is ready run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** No time counted yet. */
const none = (): ThreadDurabilitySyncTiming => ({
  count: 0,
  totalMs: 0,
  longestMs: 0,
  under10Ms: 0,
  from10To50Ms: 0,
  from50To200Ms: 0,
  from200To1000Ms: 0,
  from1000Ms: 0
})

/** One time of `ms`, in its band. */
const once = (ms: number): ThreadDurabilitySyncTiming => ({
  count: 1,
  totalMs: ms,
  longestMs: ms,
  under10Ms: ms < 10 ? 1 : 0,
  from10To50Ms: ms >= 10 && ms < 50 ? 1 : 0,
  from50To200Ms: ms >= 50 && ms < 200 ? 1 : 0,
  from200To1000Ms: ms >= 200 && ms < 1_000 ? 1 : 0,
  from1000Ms: ms >= 1_000 ? 1 : 0
})

describe('the time syncs take in the port', () => {
  let calls: HeldCalls
  let clock: number
  let port: ThreadDurabilityDebtFs

  beforeEach(() => {
    calls = new HeldCalls()
    clock = 5_000
    port = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight: 1,
      now: () => clock
    })
  })

  it('times each class from request to start and from start to settle, in five bands', async () => {
    void port.syncFile('/p/normal')
    void port.syncFile('/p/urgent', { urgent: true })
    void port.syncDirectory('/p/background', { background: true })
    await settle()
    expect(port.snapshot().timing).toEqual({
      urgent: { requestToStart: none(), startToSettle: none() },
      normal: { requestToStart: once(0), startToSettle: none() },
      background: { requestToStart: none(), startToSettle: none() }
    })

    clock += 30
    await calls.finish('/p/normal')
    clock += 700
    await calls.finish('/p/urgent')
    clock += 1_500
    await calls.finish('/p/background')

    expect(port.snapshot().timing).toEqual({
      urgent: { requestToStart: once(30), startToSettle: once(700) },
      normal: { requestToStart: once(0), startToSettle: once(30) },
      background: { requestToStart: once(730), startToSettle: once(1_500) }
    })
  })

  it('times each request that joins a sync at its own class, and the sync once, at the class it started in', async () => {
    void port.syncFile('/p/first')
    void port.syncFile('/p/shared', { background: true })
    await settle()
    clock += 145
    void port.syncFile('/p/shared', { urgent: true })
    clock += 5
    await calls.finish('/p/first')
    clock += 60
    await calls.finish('/p/shared')

    const { timing } = port.snapshot()
    expect(timing.background.requestToStart).toEqual(once(150))
    expect(timing.urgent.requestToStart).toEqual(once(5))
    // Moved up to urgent before it started, it is timed as urgent.
    expect(timing.urgent.startToSettle).toEqual(once(60))
    expect(timing.background.startToSettle).toEqual(none())
    expect(timing.normal).toEqual({ requestToStart: once(0), startToSettle: once(150) })
  })

  it('sums, keeps the longest, and fills each band', async () => {
    for (const ms of [0, 9, 10, 49, 50, 199, 200, 999, 1_000, 4_000]) {
      void port.syncFile('/p/each')
      await settle()
      clock += ms
      await calls.finish('/p/each')
    }

    expect(port.snapshot().timing.normal.startToSettle).toEqual({
      count: 10,
      totalMs: 6_516,
      longestMs: 4_000,
      under10Ms: 2,
      from10To50Ms: 2,
      from50To200Ms: 2,
      from200To1000Ms: 2,
      from1000Ms: 2
    })
  })

  it('times a sync that fails, and one that finds nothing at its path, to their settling', async () => {
    const failed = port.syncFile('/p/failing').catch((error: Error) => error.message)
    await settle()
    clock += 40
    await calls.finish(
      '/p/failing',
      Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
    )
    expect(await failed).toBe('EIO: i/o error, fsync')
    calls.gone.add('/p/gone')
    await expect(port.syncFile('/p/gone')).resolves.toBe('missing')

    expect(port.snapshot().timing.normal.startToSettle).toMatchObject({
      count: 2,
      totalMs: 40,
      longestMs: 40,
      under10Ms: 1,
      from10To50Ms: 1
    })
  })

  it('leaves a sync still running out of the times until it settles', async () => {
    void port.syncFile('/p/slow')
    await settle()
    clock += 2_000

    expect(port.snapshot().timing.normal).toEqual({
      requestToStart: once(0),
      startToSettle: none()
    })
    expect(calls.syncing()).toEqual(['/p/slow'])
  })

  it('times nothing for a directory on Windows, where no sync is made', async () => {
    const windows = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'win32',
      now: () => clock
    })
    await expect(windows.syncDirectory('/p')).resolves.toBe('synced')

    expect(windows.snapshot().timing.normal).toEqual({
      requestToStart: none(),
      startToSettle: none()
    })
  })
})
