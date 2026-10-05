/**
 * Where a barrier's wait goes, by class: the time it spends behind another
 * barrier on its thread, and the time from the start of its own syncs to its
 * settling. Driven through a port whose syncs settle only when the test says,
 * on a clock that moves only when the test moves it.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  createThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityPort,
  type ThreadDurabilitySyncOutcome,
  type ThreadDurabilityWaitCounters
} from './ThreadDurabilityDebt'

class HeldPort implements ThreadDurabilityPort {
  private pending: Array<{ path: string; resolve(outcome: ThreadDurabilitySyncOutcome): void }> = []

  private ask(path: string): Promise<ThreadDurabilitySyncOutcome> {
    return new Promise((resolve) => {
      this.pending.push({ path, resolve })
    })
  }

  syncFile(path: string): Promise<ThreadDurabilitySyncOutcome> {
    return this.ask(path)
  }

  syncDirectory(path: string): Promise<ThreadDurabilitySyncOutcome> {
    return this.ask(path)
  }

  /** Let the waiting sync of a path finish. */
  async finish(path: string): Promise<void> {
    const index = this.pending.findIndex((sync) => sync.path === path)
    if (index < 0) throw new Error(`no sync of ${path} is waiting`)
    this.pending.splice(index, 1)[0].resolve('synced')
    await settle()
  }
}

/** Lets every promise callback that is ready run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const CHAT = 'chat-1'
const journal = '/p/chat-journal-v2/chat-1.mutations.jsonl'
const events = (run: string): string => `/p/run-events/${run}.jsonl`

/** The split of the barriers counted, with nothing else of the counters. */
const split = (
  counters: ThreadDurabilityWaitCounters
): Pick<
  ThreadDurabilityWaitCounters,
  | 'count'
  | 'totalMs'
  | 'waitedBehind'
  | 'behindTotalMs'
  | 'behindLongestMs'
  | 'ownSyncsTotalMs'
  | 'ownSyncsLongestMs'
> => ({
  count: counters.count,
  totalMs: counters.totalMs,
  waitedBehind: counters.waitedBehind,
  behindTotalMs: counters.behindTotalMs,
  behindLongestMs: counters.behindLongestMs,
  ownSyncsTotalMs: counters.ownSyncsTotalMs,
  ownSyncsLongestMs: counters.ownSyncsLongestMs
})

describe('the time a barrier spends behind another and on its own syncs', () => {
  let port: HeldPort
  let clock: number
  let debt: ThreadDurabilityDebt

  beforeEach(() => {
    port = new HeldPort()
    clock = 1_000
    debt = createThreadDurabilityDebt({ port, now: () => clock })
  })

  it('counts a barrier that begins at once all on its own syncs', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const barrier = debt.barrier(CHAT)
    clock += 30
    await port.finish(journal)
    await barrier

    expect(split(debt.snapshot().waits.normal)).toEqual({
      count: 1,
      totalMs: 30,
      waitedBehind: 0,
      behindTotalMs: 0,
      behindLongestMs: 0,
      ownSyncsTotalMs: 30,
      ownSyncsLongestMs: 30
    })
  })

  it('counts a barrier that joins a running one all behind it', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const running = debt.barrier(CHAT)
    clock += 10
    // Nothing new is owed: it waits for the running one.
    const joined = debt.barrier(CHAT)
    clock += 40
    await port.finish(journal)
    await Promise.all([running, joined])

    expect(split(debt.snapshot().waits.normal)).toEqual({
      count: 2,
      totalMs: 90,
      waitedBehind: 1,
      behindTotalMs: 40,
      behindLongestMs: 40,
      ownSyncsTotalMs: 50,
      ownSyncsLongestMs: 50
    })
  })

  it('splits a queued barrier’s wait where its own syncs begin, for each caller that joined it', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const running = debt.barrier(CHAT, { run: 'run-1' })
    clock += 10
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })
    const queued = debt.barrier(CHAT, { run: 'run-2' })
    clock += 10
    const joining = debt.barrier(CHAT, { run: 'run-2' })
    clock += 20
    await port.finish(journal)
    await running
    // The queued barrier began as the running one ended, 40 after it began.
    clock += 30
    await port.finish(events('run-2'))
    await Promise.all([queued, joining])

    expect(split(debt.snapshot().waits.normal)).toEqual({
      count: 3,
      totalMs: 40 + 60 + 50,
      waitedBehind: 2,
      behindTotalMs: 30 + 20,
      behindLongestMs: 30,
      ownSyncsTotalMs: 40 + 30 + 30,
      ownSyncsLongestMs: 40
    })
  })

  it('counts one raised as the running barrier ends, which joins the queued one as it starts, as not behind', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const running = debt.barrier(CHAT)
    // This runs as soon as the running barrier ends, before the one queued
    // behind it starts.
    let late: Promise<void> | null = null
    void running.then(() => {
      late = debt.barrier(CHAT, { run: 'run-2' })
    })
    clock += 10
    debt.note(CHAT, { file: events('run-2'), owner: 'run-events', run: 'run-2' })
    const queued = debt.barrier(CHAT)
    clock += 10
    await port.finish(journal)
    expect(late).not.toBeNull()
    clock += 30
    await port.finish(events('run-2'))
    await Promise.all([running, queued, late])

    expect(split(debt.snapshot().waits.normal)).toEqual({
      count: 3,
      totalMs: 20 + 40 + 30,
      waitedBehind: 1,
      behindTotalMs: 10,
      behindLongestMs: 10,
      ownSyncsTotalMs: 20 + 30 + 30,
      ownSyncsLongestMs: 30
    })
  })

  it('counts an urgent barrier of the thread’s own debt beside a running one all on its own syncs', async () => {
    debt.note(CHAT, { file: journal, owner: 'journal' })
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    const running = debt.barrier(CHAT, { run: 'run-1' })
    await port.finish(journal)
    clock += 10
    debt.note(CHAT, { file: journal, owner: 'journal' })
    const user = debt.barrier(CHAT, { threadOnly: true, urgent: true })
    clock += 5
    await port.finish(journal)
    await user
    clock += 100
    await port.finish(events('run-1'))
    await running

    expect(split(debt.snapshot().waits.urgent)).toEqual({
      count: 1,
      totalMs: 5,
      waitedBehind: 0,
      behindTotalMs: 0,
      behindLongestMs: 0,
      ownSyncsTotalMs: 5,
      ownSyncsLongestMs: 5
    })
    expect(split(debt.snapshot().waits.normal)).toMatchObject({
      count: 1,
      totalMs: 115,
      ownSyncsTotalMs: 115
    })
  })

  it('counts a barrier with nothing to pay as neither', async () => {
    await debt.barrier(CHAT)
    debt.note(CHAT, { file: events('run-1'), owner: 'run-events', run: 'run-1' })
    await debt.barrier(CHAT, { threadOnly: true })

    expect(split(debt.snapshot().waits.normal)).toEqual({
      count: 2,
      totalMs: 0,
      waitedBehind: 0,
      behindTotalMs: 0,
      behindLongestMs: 0,
      ownSyncsTotalMs: 0,
      ownSyncsLongestMs: 0
    })
  })
})
