/**
 * Urgent syncs in the port, alone and under the debt ledger: a barrier the
 * user is sitting in goes ahead of every sync that has not started, without
 * leaving the rest waiting for good. The file calls complete only when the
 * test says, and everything is counted in syncs, never in time.
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

describe('urgent syncs in the port', () => {
  let calls: HeldCalls
  let port: ThreadDurabilityDebtFs

  beforeEach(() => {
    calls = new HeldCalls()
    // The order within the shared places, without the place kept for an
    // urgent sync (ThreadDurabilityDebtFs.extraPlace.test.ts).
    port = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight: 2,
      keepUrgentPlace: false
    })
  })

  it('starts urgent syncs ahead of every waiting sync that is not, each kind in the order asked', async () => {
    for (const name of ['a', 'b', 'c', 'd']) void port.syncFile(`/p/${name}`)
    void port.syncFile('/p/u1', { urgent: true })
    void port.syncDirectory('/p/u2', { urgent: true })
    await opened()
    expect(calls.syncing()).toEqual(['/p/a', '/p/b'])
    expect(port.snapshot()).toMatchObject({ queued: 4, queuedUrgent: 2, queuedNormal: 2 })

    for (let index = 0; index < 6; index += 1) await calls.finish()

    expect(calls.started).toEqual(['/p/a', '/p/b', '/p/u1', '/p/u2', '/p/c', '/p/d'])
    expect(port.snapshot()).toMatchObject({ started: 6, startedUrgent: 2, queued: 0 })
  })

  it('moves a waiting sync ahead when an urgent request joins it', async () => {
    for (const name of ['a', 'b', 'c', 'd']) void port.syncFile(`/p/${name}`)
    await opened()

    void port.syncFile('/p/d', { urgent: true })
    await calls.finish('/p/a')

    expect(calls.syncing()).toEqual(['/p/b', '/p/d'])
    expect(port.snapshot()).toMatchObject({ joined: 1, promoted: 1, startedUrgent: 1 })
  })

  it('moves the waiting syncs an urgency raises ahead, and leaves a started one alone', async () => {
    for (const name of ['a', 'b', 'c', 'd']) void port.syncFile(`/p/${name}`)
    void port.syncDirectory('/p/e')
    await opened()
    const urgency = port.urgent()

    urgency.raise(['/p/a', '/p/d'], ['/p/e'])
    await calls.finish('/p/a')
    await calls.finish('/p/b')
    urgency.end()

    expect(calls.started.slice(0, 4)).toEqual(['/p/a', '/p/b', '/p/d', '/p/e'])
    expect(port.snapshot()).toMatchObject({ promoted: 2, joined: 0 })
  })

  it('starts nothing that is not urgent in a free place while an urgency is open', async () => {
    const urgency = port.urgent()
    void port.syncFile('/p/ordinary')
    await opened()
    expect(calls.syncing()).toEqual([])
    expect(port.snapshot()).toMatchObject({ urgencies: 1, queuedNormal: 1 })

    void port.syncFile('/p/urgent', { urgent: true })
    await opened()
    expect(calls.syncing()).toEqual(['/p/urgent'])

    urgency.end()
    urgency.end()
    await opened()
    expect(calls.syncing()).toEqual(['/p/urgent', '/p/ordinary'])
    expect(port.snapshot()).toMatchObject({ urgencies: 0 })
  })

  it(`starts a waiting sync that is not urgent after ${THREAD_DURABILITY_URGENT_RUN} urgent ones in a row`, async () => {
    const one = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight: 1,
      keepUrgentPlace: false
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
    await opened()

    // Urgent syncs keep coming, two waiting at every moment.
    while (!calls.started.includes('/p/ordinary')) {
      await calls.finish()
      ask()
      await opened()
    }

    const before = calls.started.indexOf('/p/ordinary')
    expect(calls.started.slice(1, before).every((path) => path.startsWith('/p/urgent-'))).toBe(true)
    expect(before - 1).toBe(THREAD_DURABILITY_URGENT_RUN)
    expect(one.snapshot()).toMatchObject({ fairStarts: 1 })
  })

  it(`counts the ${THREAD_DURABILITY_URGENT_RUN} again for each waiting sync that is not urgent, and only while one waits`, async () => {
    const one = createThreadDurabilityDebtFs({
      fs: calls,
      platform: 'darwin',
      maxInFlight: 1,
      keepUrgentPlace: false
    })
    let urgent = 0
    const ask = (): void => {
      urgent += 1
      void one.syncFile(`/p/urgent-${urgent}`, { urgent: true })
    }
    // Urgent syncs alone, more than the bound: nothing else waits, so none count.
    for (let index = 0; index < THREAD_DURABILITY_URGENT_RUN + 6; index += 1) ask()
    await opened()
    while (calls.syncing().length > 0) await calls.finish()

    void one.syncFile('/p/running')
    void one.syncFile('/p/first')
    void one.syncFile('/p/second')
    ask()
    ask()
    await opened()
    while (!calls.started.includes('/p/second')) {
      await calls.finish()
      ask()
      await opened()
    }

    const at = (path: string): number => calls.started.indexOf(path)
    expect(at('/p/first') - at('/p/running') - 1).toBe(THREAD_DURABILITY_URGENT_RUN)
    expect(at('/p/second') - at('/p/first') - 1).toBe(THREAD_DURABILITY_URGENT_RUN)
    expect(one.snapshot()).toMatchObject({ fairStarts: 2 })
  })

  it('says how many syncs run or wait ahead of a new one of each kind', async () => {
    for (const name of ['a', 'b', 'c', 'd']) void port.syncFile(`/p/${name}`)
    void port.syncFile('/p/u', { urgent: true })
    await opened()

    expect(port.ahead(true)).toBe(3)
    expect(port.ahead(false)).toBe(5)
  })
})

describe('an urgent barrier under the debt ledger', () => {
  let calls: HeldCalls
  let port: ThreadDurabilityDebtFs

  beforeEach(() => {
    calls = new HeldCalls()
    port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 2 })
  })

  it('resolves behind 1,000 waiting syncs after only the ones already started and its own', async () => {
    const debt = createThreadDurabilityDebt({ port })
    for (let index = 0; index < 1_000; index += 1)
      debt.note('agents', { file: `/p/agents/${index}.jsonl`, owner: 'run-events' })
    void debt.barrier('agents')
    await opened()
    expect(port.snapshot()).toMatchObject({ inFlight: 2, queuedNormal: 998 })

    for (const name of ['journal', 'events', 'detail'])
      debt.note('user', { file: `/p/user/${name}.jsonl`, owner: 'journal' })
    debt.note('user', { directory: '/p/user' })
    let startedWhenResolved: string[] | null = null
    void debt.barrier('user', { urgent: true }).then(() => {
      startedWhenResolved = [...calls.started]
    })
    await opened()
    while (!startedWhenResolved) await calls.finish()

    // The two that had started, then its three files and its directory.
    expect(startedWhenResolved).toEqual([
      '/p/agents/0.jsonl',
      '/p/agents/1.jsonl',
      '/p/user/journal.jsonl',
      '/p/user/events.jsonl',
      '/p/user/detail.jsonl',
      '/p/user'
    ])
    expect(port.snapshot()).toMatchObject({ startedUrgent: 4 })
    expect(debt.snapshot().waits.urgent).toMatchObject({ count: 1, aheadTotal: 2, aheadMost: 2 })
    // Then the rest go on.
    await opened()
    expect(calls.syncing()).toEqual(['/p/agents/2.jsonl', '/p/agents/3.jsonl'])
  })

  it('moves ahead the waiting syncs of the running barrier it joins', async () => {
    const debt = createThreadDurabilityDebt({ port })
    for (let index = 0; index < 100; index += 1)
      debt.note('agents', { file: `/p/agents/${index}.jsonl`, owner: 'run-events' })
    void debt.barrier('agents')
    debt.note('user', { file: '/p/user/journal.jsonl', owner: 'journal' })
    debt.note('user', { directory: '/p/user' })
    const ordinary = debt.barrier('user')
    await opened()

    // Nothing new is owed: it joins the running barrier, and raises it.
    const urgent = debt.barrier('user', { urgent: true })
    await opened()
    await calls.finish()
    expect(calls.syncing()).toEqual(['/p/agents/1.jsonl', '/p/user/journal.jsonl'])
    await calls.finish()
    // The free place is kept for the barrier's directory.
    expect(calls.syncing()).toEqual(['/p/user/journal.jsonl'])
    await calls.finish()
    expect(calls.syncing()).toEqual(['/p/user'])
    await calls.finish()
    await Promise.all([ordinary, urgent])

    expect(calls.started.slice(0, 4)).toEqual([
      '/p/agents/0.jsonl',
      '/p/agents/1.jsonl',
      '/p/user/journal.jsonl',
      '/p/user'
    ])
    expect(debt.snapshot().barriers).toMatchObject({ shared: 1, hastened: 1 })
  })

  it('still finishes an ordinary barrier while urgent ones keep coming', async () => {
    const one = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 1 })
    const debt = createThreadDurabilityDebt({ port: one })
    debt.note('agents', { file: '/p/agents/0.jsonl', owner: 'run-events' })
    debt.note('agents', { file: '/p/agents/1.jsonl', owner: 'run-events' })
    let ordinaryDone = false
    void debt.barrier('agents').then(() => {
      ordinaryDone = true
    })
    let users = 0
    const userBarrier = (): void => {
      users += 1
      const chatId = `user-${users}`
      debt.note(chatId, { file: `/p/${chatId}/journal.jsonl`, owner: 'journal' })
      void debt.barrier(chatId, { urgent: true })
    }
    userBarrier()
    await opened()

    let finished = 0
    while (!ordinaryDone) {
      await calls.finish()
      finished += 1
      userBarrier()
      await opened()
      expect(finished).toBeLessThanOrEqual(2 * (THREAD_DURABILITY_URGENT_RUN + 1) + 1)
    }
    expect(one.snapshot().fairStarts).toBeGreaterThanOrEqual(1)
  })
})
