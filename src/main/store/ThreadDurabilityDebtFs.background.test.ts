/**
 * Background syncs in the port: the class below normal, for work nobody waits
 * on. They start only when nothing else wants a place, and still start while
 * other syncs keep coming. The file calls complete only when the test says,
 * and everything is counted in syncs, never in time.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  THREAD_DURABILITY_FOREGROUND_RUN,
  THREAD_DURABILITY_URGENT_RUN,
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsCalls
} from './ThreadDurabilityDebtFs'

type Done = (error: NodeJS.ErrnoException | null) => void

/** File calls whose syncs finish only when the test says; opens and closes finish at once. */
class HeldCalls implements ThreadDurabilityDebtFsCalls {
  readonly constants = { O_RDONLY: 0, O_RDWR: 2 }
  /** Every path whose sync started, in order. */
  started: string[] = []
  private nextFd = 100
  private paths = new Map<number, string>()
  private syncs: Array<{ path: string; done: Done }> = []

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
    this.started.push(target)
    this.syncs.push({ path: target, done: callback })
  }

  close(fd: number, callback: Done): void {
    this.paths.delete(fd)
    queueMicrotask(() => callback(null))
  }

  syncing(): string[] {
    return this.syncs.map((sync) => sync.path)
  }

  /** Let the sync of a path finish, or the one that has run longest. */
  async finish(target = this.syncs[0]?.path): Promise<void> {
    const index = this.syncs.findIndex((sync) => sync.path === target)
    if (index < 0) throw new Error(`no sync of ${target} is in flight`)
    this.syncs.splice(index, 1)[0].done(null)
    await settle()
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** Opening is asynchronous: a request reaches its sync only after the promise callbacks run. */
const opened = settle

const BACKGROUND = { background: true } as const

function watch(promise: Promise<unknown>): { state: string } {
  const seen = { state: 'waiting' }
  promise.then(
    (value) => {
      seen.state = String(value)
    },
    () => {
      seen.state = 'rejected'
    }
  )
  return seen
}

describe('background syncs in the port', () => {
  let calls: HeldCalls
  let port: ThreadDurabilityDebtFs

  beforeEach(() => {
    calls = new HeldCalls()
    // The order within the shared place, without the place kept for an
    // urgent sync (ThreadDurabilityDebtFs.extraPlace.test.ts).
    port = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight: 1,
      keepUrgentPlace: false
    })
  })

  it('starts one only when nothing urgent or normal waits, each class in the order asked', async () => {
    void port.syncFile('/p/running')
    void port.syncFile('/p/b1', BACKGROUND)
    void port.syncDirectory('/p/b2', BACKGROUND)
    void port.syncFile('/p/normal')
    void port.syncFile('/p/urgent', { urgent: true })
    await opened()
    expect(port.snapshot()).toMatchObject({
      queued: 4,
      queuedUrgent: 1,
      queuedNormal: 1,
      queuedBackground: 2
    })

    while (calls.syncing().length > 0) await calls.finish()

    expect(calls.started).toEqual(['/p/running', '/p/urgent', '/p/normal', '/p/b1', '/p/b2'])
    expect(port.snapshot()).toMatchObject({
      started: 5,
      startedUrgent: 1,
      startedBackground: 2,
      queued: 0,
      queuedBackground: 0,
      backgroundFairStarts: 0
    })
  })

  it('starts one in a free place at once when nothing else waits', async () => {
    const two = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 2 })
    void two.syncFile('/p/b1', BACKGROUND)
    void two.syncDirectory('/p/b2', BACKGROUND)
    await opened()

    expect(calls.syncing()).toEqual(['/p/b1', '/p/b2'])
    expect(two.snapshot()).toMatchObject({ inFlight: 2, startedBackground: 2, queued: 0 })
  })

  it('starts none while an urgency is open, until it ends', async () => {
    const urgency = port.urgent()
    void port.syncFile('/p/background', BACKGROUND)
    await opened()
    expect(calls.syncing()).toEqual([])
    expect(port.snapshot()).toMatchObject({ urgencies: 1, queuedBackground: 1 })

    urgency.end()
    await opened()
    expect(calls.syncing()).toEqual(['/p/background'])
  })

  it('lets an urgent request start within the in-flight limit with 500 background syncs queued, and a normal one too', async () => {
    const two = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 2 })
    for (let index = 0; index < 500; index += 1) void two.syncFile(`/p/b${index}`, BACKGROUND)
    await opened()
    expect(two.snapshot()).toMatchObject({ inFlight: 2, queuedBackground: 498 })
    // Waiting background syncs are never counted ahead of a new request.
    expect(two.ahead(true)).toBe(2)
    expect(two.ahead(false)).toBe(2)

    const urgent = watch(two.syncFile('/p/urgent', { urgent: true }))
    const normal = watch(two.syncDirectory('/p/normal'))
    await opened()
    await calls.finish()
    await calls.finish()

    // The two that had started, then the urgent one and the normal one.
    expect(calls.started.slice(0, 4)).toEqual(['/p/b0', '/p/b1', '/p/urgent', '/p/normal'])
    await calls.finish('/p/urgent')
    await calls.finish('/p/normal')
    expect([urgent.state, normal.state]).toEqual(['synced', 'synced'])
    expect(calls.syncing()).toEqual(['/p/b2', '/p/b3'])
  })

  it(`still starts one in every ${THREAD_DURABILITY_FOREGROUND_RUN + 1} under a steady flow of normal requests`, async () => {
    void port.syncFile('/p/running')
    for (let index = 0; index < 10; index += 1) void port.syncFile(`/p/b${index}`, BACKGROUND)
    let normal = 0
    const ask = (): void => {
      normal += 1
      void port.syncFile(`/p/normal-${normal}`)
    }
    ask()
    ask()
    await opened()

    // Normal syncs keep coming, two waiting at every moment.
    while (calls.started.filter((path) => path.startsWith('/p/b')).length < 3) {
      await calls.finish()
      ask()
      await opened()
    }

    const backgroundAt = calls.started.flatMap((path, index) =>
      path.startsWith('/p/b') ? [index] : []
    )
    expect(backgroundAt).toHaveLength(3)
    // After the one running when they were asked for: 64 others, one background, and again.
    expect(backgroundAt[0] - 1).toBe(THREAD_DURABILITY_FOREGROUND_RUN)
    expect(backgroundAt[1] - backgroundAt[0] - 1).toBe(THREAD_DURABILITY_FOREGROUND_RUN)
    expect(backgroundAt[2] - backgroundAt[1] - 1).toBe(THREAD_DURABILITY_FOREGROUND_RUN)
    expect(
      calls.started.slice(0, backgroundAt[2] + 1).filter((path) => path.startsWith('/p/b'))
    ).toEqual(['/p/b0', '/p/b1', '/p/b2'])
    expect(port.snapshot()).toMatchObject({ backgroundFairStarts: 3, startedBackground: 3 })
  })

  it(`still starts one in every ${THREAD_DURABILITY_FOREGROUND_RUN + 1} under a steady flow of urgent requests, and the normal one waiting too`, async () => {
    void port.syncFile('/p/running')
    void port.syncFile('/p/background', BACKGROUND)
    void port.syncFile('/p/normal')
    let urgent = 0
    const ask = (): void => {
      urgent += 1
      void port.syncFile(`/p/urgent-${urgent}`, { urgent: true })
    }
    ask()
    ask()
    await opened()

    while (!calls.started.includes('/p/normal')) {
      await calls.finish()
      ask()
      await opened()
    }

    const at = (path: string): number => calls.started.indexOf(path)
    expect(THREAD_DURABILITY_URGENT_RUN).toBe(THREAD_DURABILITY_FOREGROUND_RUN)
    // Both bounds fall due on the same start: the background sync goes first, then the normal one.
    expect(at('/p/background') - at('/p/running') - 1).toBe(THREAD_DURABILITY_FOREGROUND_RUN)
    expect(at('/p/normal')).toBe(at('/p/background') + 1)
    expect(port.snapshot()).toMatchObject({ backgroundFairStarts: 1, fairStarts: 1 })
  })

  it('counts nothing toward the bound while no background sync waits', async () => {
    void port.syncFile('/p/running')
    let normal = 0
    const ask = (): void => {
      normal += 1
      void port.syncFile(`/p/normal-${normal}`)
    }
    ask()
    await opened()
    // More normal syncs start in a row than the bound, with nothing in the background.
    for (let index = 0; index < THREAD_DURABILITY_FOREGROUND_RUN + 6; index += 1) {
      await calls.finish()
      ask()
      await opened()
    }
    const startedBeforeAsked = calls.started.length

    void port.syncFile('/p/background', BACKGROUND)
    ask()
    await opened()
    while (!calls.started.includes('/p/background')) {
      await calls.finish()
      ask()
      await opened()
    }

    // It waited for the bound's worth of starts counted from when it was asked for.
    expect(calls.started.indexOf('/p/background') - startedBeforeAsked).toBe(
      THREAD_DURABILITY_FOREGROUND_RUN
    )
    expect(port.snapshot()).toMatchObject({ backgroundFairStarts: 1 })
  })
})

describe('a request that joins a background sync', () => {
  let calls: HeldCalls
  let port: ThreadDurabilityDebtFs

  beforeEach(() => {
    calls = new HeldCalls()
    port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 1 })
  })

  it('moves a waiting one up to normal when a normal request joins it', async () => {
    void port.syncFile('/p/running')
    for (const name of ['b1', 'b2', 'shared']) void port.syncFile(`/p/${name}`, BACKGROUND)
    const first = watch(port.syncFile('/p/shared', BACKGROUND))
    await opened()

    const joining = watch(port.syncFile('/p/shared'))
    while (calls.syncing().length > 0) await calls.finish()

    expect(calls.started).toEqual(['/p/running', '/p/shared', '/p/b1', '/p/b2'])
    expect([first.state, joining.state]).toEqual(['synced', 'synced'])
    expect(port.snapshot()).toMatchObject({ joined: 2, promoted: 1, startedBackground: 2 })
  })

  it('moves a waiting one up to urgent when an urgent request joins it', async () => {
    void port.syncFile('/p/running')
    void port.syncFile('/p/normal')
    void port.syncDirectory('/p/shared', BACKGROUND)
    await opened()

    void port.syncDirectory('/p/shared', { urgent: true })
    while (calls.syncing().length > 0) await calls.finish()

    expect(calls.started).toEqual(['/p/running', '/p/shared', '/p/normal'])
    expect(port.snapshot()).toMatchObject({
      joined: 1,
      promoted: 1,
      startedUrgent: 1,
      startedBackground: 0
    })
  })

  it('moves a waiting one up to urgent when an urgency raises it', async () => {
    void port.syncFile('/p/running')
    void port.syncFile('/p/normal')
    void port.syncFile('/p/shared', BACKGROUND)
    await opened()
    const urgency = port.urgent()

    urgency.raise(['/p/shared'], [])
    await calls.finish()
    urgency.end()
    while (calls.syncing().length > 0) await calls.finish()

    expect(calls.started).toEqual(['/p/running', '/p/shared', '/p/normal'])
    expect(port.snapshot()).toMatchObject({ promoted: 1, startedUrgent: 1 })
  })

  it('leaves a waiting normal sync normal when a background request joins it', async () => {
    void port.syncFile('/p/running')
    void port.syncFile('/p/shared')
    void port.syncFile('/p/b1', BACKGROUND)
    void port.syncFile('/p/shared', BACKGROUND)
    await opened()

    while (calls.syncing().length > 0) await calls.finish()

    expect(calls.started).toEqual(['/p/running', '/p/shared', '/p/b1'])
    expect(port.snapshot()).toMatchObject({ joined: 1, promoted: 0, startedBackground: 1 })
  })

  it('never joins one that has started: a later request gets a sync of its own', async () => {
    void port.syncFile('/p/shared', BACKGROUND)
    await opened()
    expect(calls.syncing()).toEqual(['/p/shared'])

    const later = watch(port.syncFile('/p/shared'))
    await opened()
    await calls.finish('/p/shared')
    expect(later.state).toBe('waiting')
    await calls.finish('/p/shared')

    expect(later.state).toBe('synced')
    expect(calls.started).toEqual(['/p/shared', '/p/shared'])
    expect(port.snapshot()).toMatchObject({ joined: 0, startedBackground: 1, started: 2 })
  })
})
