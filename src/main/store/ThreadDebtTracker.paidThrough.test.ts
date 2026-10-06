/**
 * `paidThrough`: a write confirmed by the barriers the app raises anyway,
 * over the real debt and a port in memory. It raises nothing itself.
 */
import { describe, expect, it } from 'vitest'

import { createThreadDurabilityDebt, type ThreadDurabilityPort } from './ThreadDurabilityDebt'
import { ThreadDebtTracker } from './ThreadDebtTracker'

const JOURNAL = (chatId: string) => `/p/chat-journal-v2/${chatId}.mutations.jsonl`
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function tracked() {
  const asked: string[] = []
  let refuse = false
  const sync = (target: string) => {
    asked.push(target)
    return refuse
      ? Promise.reject(new Error('EIO: the disk refused'))
      : Promise.resolve('synced' as const)
  }
  const port: ThreadDurabilityPort = { syncFile: sync, syncDirectory: sync }
  const debt = createThreadDurabilityDebt({ port, now: () => 0 })
  // No timer fires: only the barriers each test raises pay anything.
  const tracker = new ThreadDebtTracker({
    debt,
    now: () => 0,
    setTimer: () => null,
    clearTimer: () => undefined,
    warn: () => undefined
  })
  const write = (chatId: string) =>
    tracker.note(chatId, { file: JOURNAL(chatId), owner: 'journal' })
  /** Resolves to 'paid', 'erased', or 'waiting' if it has not settled yet. */
  const watch = (promise: Promise<void>) => {
    let state: 'waiting' | 'paid' | 'erased' = 'waiting'
    promise.then(
      () => (state = 'paid'),
      () => (state = 'erased')
    )
    return () => state
  }
  return {
    tracker,
    debt,
    asked,
    write,
    watch,
    refuseSyncs: (value: boolean) => (refuse = value)
  }
}

describe('ThreadDebtTracker.paidThrough', () => {
  it('raises no sync, and resolves on the next barrier raised for the thread', async () => {
    const t = tracked()
    t.write('chat-1')
    const state = t.watch(t.tracker.paidThrough('chat-1'))
    await settle()
    expect(state()).toBe('waiting')
    expect(t.asked).toEqual([])
    expect(t.debt.snapshot().barriers.raised).toBe(0)

    // A run's barrier pays the thread's own debt too, where the journal is.
    await t.tracker.barrier('chat-1', { run: 'run-1' })
    await settle()
    expect(state()).toBe('paid')
    expect(t.asked).toEqual([JOURNAL('chat-1')])
  })

  it('is covered by a barrier raised after the write even when it waits after that barrier', async () => {
    const t = tracked()
    t.write('chat-1')
    // The user moment's barrier is raised inside the save, before the save asks.
    const userBarrier = t.tracker.barrier('chat-1', { threadOnly: true, urgent: true })
    const state = t.watch(t.tracker.paidThrough('chat-1'))
    await userBarrier
    await settle()
    expect(state()).toBe('paid')
  })

  it('is not covered by a barrier raised before the write it waits for', async () => {
    const t = tracked()
    t.write('chat-1')
    const earlier = t.tracker.barrier('chat-1', { threadOnly: true })
    t.write('chat-1')
    const state = t.watch(t.tracker.paidThrough('chat-1'))
    await earlier
    await settle()
    expect(state()).toBe('waiting')
    await t.tracker.barrier('chat-1')
    await settle()
    expect(state()).toBe('paid')
  })

  it('keeps waiting through a failed barrier, and is paid by the next', async () => {
    const t = tracked()
    t.write('chat-1')
    const state = t.watch(t.tracker.paidThrough('chat-1'))
    t.refuseSyncs(true)
    await t.tracker.barrier('chat-1').catch(() => undefined)
    await settle()
    expect(state()).toBe('waiting')
    t.refuseSyncs(false)
    await t.tracker.barrier('chat-1')
    await settle()
    expect(state()).toBe('paid')
  })

  it('resolves at once for a thread that owes nothing, and only for its own thread', async () => {
    const t = tracked()
    const nothing = t.watch(t.tracker.paidThrough('chat-quiet'))
    t.write('chat-1')
    t.write('chat-2')
    const other = t.watch(t.tracker.paidThrough('chat-2'))
    await t.tracker.barrier('chat-1')
    await settle()
    expect(nothing()).toBe('paid')
    expect(other()).toBe('waiting')
  })

  it('rejects when the thread is erased, or every thread is, before it is paid', async () => {
    const t = tracked()
    t.write('chat-1')
    t.write('chat-2')
    const one = t.watch(t.tracker.paidThrough('chat-1'))
    const two = t.watch(t.tracker.paidThrough('chat-2'))
    t.tracker.forget('chat-1')
    await settle()
    expect(one()).toBe('erased')
    expect(two()).toBe('waiting')
    t.tracker.forgetAll()
    await settle()
    expect(two()).toBe('erased')
  })

  it('is paid by the quit barriers', async () => {
    const t = tracked()
    t.write('chat-1')
    const state = t.watch(t.tracker.paidThrough('chat-1'))
    await t.tracker.payAll(1_000)
    await settle()
    expect(state()).toBe('paid')
  })
})
