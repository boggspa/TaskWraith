/**
 * Independent Threads M4 slice 13a (design §23.2): the observer fence over a
 * real commit gate.
 *
 * A fence holds the gate's observer mode around one operation. It waits for a
 * held committer, and a committer waits for it. It is re-entrant by live
 * lease: a nested fence whose enclosing lease is still held runs directly,
 * even with a committer queued, which is where a second entry would
 * self-deadlock (the gate prefers a queued writer). A stale store (a
 * continuation that outlived its window) enters anew. A closed gate runs the
 * operation unfenced. The lease is released on throw, and the operation's
 * value and rejection propagate.
 */
import { describe, expect, it, vi } from 'vitest'

import { createHostCommitFence } from './HostCommitFence'
import { createHostCommitGate, type HostCommitGateLease } from './HostCommitGate'

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Resolves 'pending' when the promise has not settled within a short grace period. */
async function settledWithin<T>(promise: Promise<T>, ms = 40): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Enter the gate as a committer now; throws when it did not enter at once. */
async function holdCommitter(
  gate: ReturnType<typeof createHostCommitGate>,
  label: string
): Promise<HostCommitGateLease> {
  const entered = await gate.enter('committer', { label })
  if (!entered.ok) throw new Error(`committer ${label} refused: ${entered.reason}`)
  return entered.lease
}

describe('HostCommitFence (M4 slice 13a)', () => {
  it('an observer fence waits while a committer is held, then runs and returns the value', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    const committer = await holdCommitter(gate, 'txn:held')
    let ran = 0
    const fenced = fence('legacy-window', async () => {
      ran += 1
      return 'observed'
    })
    await tick()
    expect(ran).toBe(0)
    expect(gate.snapshot()).toMatchObject({ holding: 'committer', waiting: 1 })
    expect(await settledWithin(fenced)).toBe('pending')

    committer.release()
    expect(await fenced).toBe('observed')
    expect(ran).toBe(1)
    const after = gate.snapshot()
    expect(after).toMatchObject({ holding: null, waiting: 0 })
    expect(after.holders).toEqual([])
    expect(after.modes.observer.entered).toBe(1)
  })

  it('a committer waits for a held fence and enters once it releases', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    const hold = deferred()
    const fenced = fence('snapshot', async () => {
      await hold.promise
      return 1
    })
    await vi.waitFor(() => expect(gate.snapshot().holding).toBe('observer'))
    expect(gate.snapshot().holders).toHaveLength(1)
    expect(gate.snapshot().holders).toEqual(['snapshot'])

    const committing = gate.enter('committer', { label: 'txn:queued' })
    await tick()
    expect(gate.snapshot()).toMatchObject({ holding: 'observer', waiting: 1 })
    expect(await settledWithin(committing)).toBe('pending')

    hold.resolve()
    expect(await fenced).toBe(1)
    const entered = await committing
    expect(entered.ok).toBe(true)
    if (!entered.ok) return
    expect(gate.snapshot()).toMatchObject({ holding: 'committer', waiting: 0 })
    expect(gate.snapshot().holders).toEqual(['txn:queued'])
    entered.lease.release()
  })

  it('a nested fence inside a live one runs directly, even with a committer queued at the gate', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    const order: string[] = []
    let committerEntered: Promise<unknown> | null = null
    const outer = fence('reconcile-pass', async () => {
      order.push('outer:start')
      // A writer arrives while the pass holds the observer: it queues.
      committerEntered = gate.enter('committer', { label: 'txn:queued' }).then((entered) => {
        order.push('committer:entered')
        if (entered.ok) entered.lease.release()
        return entered
      })
      await tick()
      expect(gate.snapshot()).toMatchObject({ holding: 'observer', waiting: 1 })
      // The nested snapshot must not queue behind that writer.
      const inner = fence('snapshot', async () => {
        order.push('inner:run')
        return 'nested'
      })
      expect(await settledWithin(inner)).toBe('nested')
      // Still one observer holder: the nested fence took no lease of its own.
      const during = gate.snapshot()
      expect(during.holders).toHaveLength(1)
      expect(during.holders).toEqual(['reconcile-pass'])
      expect(during.modes.observer.entered).toBe(1)
      expect(during.waiting).toBe(1)
      order.push('outer:end')
      return 'pass'
    })
    expect(await outer).toBe('pass')
    expect(committerEntered).not.toBeNull()
    await committerEntered
    expect(order.length).toBeGreaterThan(0)
    expect(order).toEqual(['outer:start', 'inner:run', 'outer:end', 'committer:entered'])
    expect(gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
  })

  it('a stale store (a continuation scheduled inside a fence, run after it released) enters anew and waits for a held committer', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    const go = deferred()
    let continuation: Promise<string> | null = null
    let continuationRan = 0
    await fence('legacy-window', async () => {
      // Carries the window's lease in its async context, as a provider
      // continuation started inside a window would.
      continuation = new Promise<string>((resolve) => {
        setTimeout(() => {
          void go.promise.then(() =>
            fence('provider-continuation', async () => {
              continuationRan += 1
              return 'late'
            }).then(resolve)
          )
        }, 0)
      })
    })
    expect(gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
    expect(gate.snapshot().modes.observer.entered).toBe(1)

    const committer = await holdCommitter(gate, 'txn:held')
    go.resolve()
    await tick()
    expect(continuationRan).toBe(0)
    expect(gate.snapshot()).toMatchObject({ holding: 'committer', waiting: 1 })
    expect(continuation).not.toBeNull()
    expect(await settledWithin(continuation!)).toBe('pending')

    committer.release()
    expect(await continuation!).toBe('late')
    expect(continuationRan).toBe(1)
    // The continuation took its own lease: a second observer entry.
    expect(gate.snapshot().modes.observer.entered).toBe(2)
    expect(gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
  })

  it('a closed gate runs the operation unfenced', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    gate.close()
    let ran = 0
    expect(
      await fence('shutdown-window', async () => {
        ran += 1
        expect(gate.snapshot().holders).toEqual([])
        return 'unfenced'
      })
    ).toBe('unfenced')
    expect(ran).toBe(1)
    const after = gate.snapshot()
    expect(after.modes.observer.entered).toBe(0)
    expect(after.modes.observer.closed).toBe(1)
    expect(after).toMatchObject({ holding: null, waiting: 0 })
  })

  it('releases the lease when the operation throws, and the rejection propagates', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    const failure = new Error('capture failed')
    await expect(
      fence('legacy-window', async () => {
        expect(gate.snapshot().holding).toBe('observer')
        throw failure
      })
    ).rejects.toBe(failure)
    expect(gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
    expect(gate.snapshot().holders).toEqual([])
    // The gate is free: a committer enters at once.
    const committer = await holdCommitter(gate, 'txn:after-throw')
    expect(gate.snapshot().holders).toEqual(['txn:after-throw'])
    committer.release()
  })

  it('a nested fence that throws leaves the enclosing lease held until the outer releases', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    const failure = new Error('nested failed')
    await fence('outer', async () => {
      await expect(fence('inner', async () => Promise.reject(failure))).rejects.toBe(failure)
      expect(gate.snapshot()).toMatchObject({ holding: 'observer' })
      expect(gate.snapshot().holders).toEqual(['outer'])
    })
    expect(gate.snapshot()).toMatchObject({ holding: null, waiting: 0 })
  })

  it('labels the holder with the fence label', async () => {
    const gate = createHostCommitGate()
    const fence = createHostCommitFence(gate)
    await fence('control:run.cancel', async () => {
      const holders = gate.snapshot().holders
      expect(holders).toHaveLength(1)
      expect(holders).toEqual(['control:run.cancel'])
    })
  })
})
