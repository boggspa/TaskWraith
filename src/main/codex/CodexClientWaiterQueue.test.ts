import { describe, expect, it, vi } from 'vitest'
import { CodexClientLifecycleQueue } from './CodexClientLifecycleQueue'
import { CodexClientRunCohortRegistry } from './CodexClientRunCohort'
import { CodexClientWaiterQueue } from './CodexClientWaiterQueue'

function harness(onClose: (owner: string) => Promise<void> = async () => undefined) {
  const close = vi.fn(onClose)
  const lifecycleQueue = new CodexClientLifecycleQueue()
  const cohorts = new CodexClientRunCohortRegistry<{ owner: string }>()
  const canReopen = vi.fn(() => true)
  const queue = new CodexClientWaiterQueue({
    lifecycleQueue: () => lifecycleQueue,
    cohorts: () => cohorts,
    canReopen
  })
  const start = async (owner: string, key: string, signal?: AbortSignal) => {
    const grant = await queue.acquireCompatible(owner, key, signal)
    if (!grant) throw new Error('cancelled')
    if (grant.kind === 'cohort') return grant.lease
    const lease = cohorts.open(
      owner,
      key,
      { owner },
      () => close(owner),
      () => grant.release()
    )
    queue.cohortOpened()
    return lease
  }
  return { lifecycleQueue, cohorts, queue, start, close, canReopen }
}

describe('CodexClientWaiterQueue', () => {
  it('tags waiters with stable sequence and intent and joins older compatible demand first', async () => {
    const { queue, cohorts, start, close } = harness()
    const barrier = await queue.acquireExclusive('barrier')
    const firstPending = start('first', 'key')
    const olderPending = start('older', 'key')
    expect(queue.snapshot()).toEqual([
      { ownerId: 'first', compatibilityKey: 'key', seq: 2, intent: 'compatible' },
      { ownerId: 'older', compatibilityKey: 'key', seq: 3, intent: 'compatible' }
    ])
    const joins = vi.spyOn(cohorts, 'tryJoin')
    barrier!.release()
    const first = await firstPending
    const newcomer = await start('newcomer', 'key')
    const older = await olderPending
    expect(joins.mock.calls.map(([owner]) => owner)).toEqual(['older', 'newcomer'])
    expect(older.resource).toBe(first.resource)
    expect(newcomer.resource).toBe(first.resource)
    expect(queue.snapshot()).toEqual([])
    await first.release()
    await older.release()
    expect(close).not.toHaveBeenCalled()
    await newcomer.release()
    expect(close).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('does not starve older incompatible demand under a continuing compatible stream', async () => {
    const { queue, cohorts, start, close } = harness()
    const first = await start('first', 'A')
    const incompatiblePending = start('different', 'B')
    const arrivals = Array.from({ length: 20 }, (_, i) => start('new-' + i, 'A'))
    expect(cohorts.tryBorrow('read-behind-destructive-demand')).toBeNull()
    await first.release()
    const incompatible = await incompatiblePending
    expect(incompatible.resource.owner).toBe('different')
    expect(queue.snapshot()).toHaveLength(20)
    let exclusiveAcquired = false
    const exclusivePending = queue.acquireExclusive('after-batch').then((grant) => {
      exclusiveAcquired = true
      return grant
    })
    await incompatible.release()
    const batch = await Promise.all(arrivals)
    expect(new Set(batch.map((lease) => lease.resource)).size).toBe(1)
    expect(exclusiveAcquired).toBe(false)
    await Promise.all(batch.map((lease) => lease.release()))
    const exclusive = await exclusivePending
    exclusive!.release()
    expect(close.mock.calls.map(([owner]) => owner)).toEqual(['first', 'different', 'new-0'])
  })

  it('does not let compatible arrivals or neutral borrowers overtake maintenance', async () => {
    const { queue, cohorts, start } = harness()
    const first = await start('first', 'A')
    const maintenancePending = queue.acquireExclusive('maintenance')
    let nextAcquired = false
    const nextPending = start('next', 'A').then((lease) => {
      nextAcquired = true
      return lease
    })
    expect(cohorts.tryBorrow('neutral')).toBeNull()
    await first.release()
    const maintenance = await maintenancePending
    expect(nextAcquired).toBe(false)
    maintenance!.release()
    await (await nextPending).release()
  })

  it('reopens after abort and joins queued compatible work without releasing the predecessor barrier', async () => {
    const { queue, lifecycleQueue, cohorts, start, close } = harness()
    const first = await start('first', 'A')
    const abort = new AbortController()
    const cancelled = queue.acquireCompatible('cancelled', 'B', abort.signal)
    const compatiblePending = start('compatible', 'A')
    abort.abort()
    expect(await cancelled).toBeNull()
    const compatible = await compatiblePending
    expect(compatible.resource).toBe(first.resource)
    const borrowed = cohorts.tryBorrow('neutral-during-compatible-reopen')
    expect(borrowed?.resource).toBe(first.resource)

    const tail = lifecycleQueue.enqueue()
    let tailAcquired = false
    const waitingTail = tail.waitUntilAcquired().then((value) => {
      tailAcquired = value
      return value
    })
    await first.release()
    await compatible.release()
    expect(close).not.toHaveBeenCalled()
    expect(tailAcquired).toBe(false)
    await borrowed!.release()
    expect(await waitingTail).toBe(true)
    tail.release()
    expect(close).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('keeps admission closed after abort while another exclusive waiter remains', async () => {
    const { queue, cohorts, start } = harness()
    const first = await start('first', 'A')
    const abort = new AbortController()
    const cancelled = queue.acquireExclusive('cancelled', abort.signal)
    const maintenancePending = queue.acquireExclusive('remaining')
    abort.abort()
    expect(await cancelled).toBeNull()
    expect(cohorts.admissionState()?.accepting).toBe(false)
    expect(cohorts.tryBorrow('neutral')).toBeNull()
    await first.release()
    const maintenance = await maintenancePending
    maintenance!.release()
  })

  it('does not close the live cohort for already-aborted demand', async () => {
    const { queue, cohorts, start } = harness()
    const first = await start('first', 'A')
    const stop = vi.spyOn(cohorts, 'stopAccepting')
    const abort = new AbortController()
    abort.abort()
    expect(await queue.acquireCompatible('cancelled', 'B', abort.signal)).toBeNull()
    expect(await queue.acquireExclusive('cancelled-exclusive', abort.signal)).toBeNull()
    expect(stop).not.toHaveBeenCalled()
    expect(queue.snapshot()).toEqual([])
    await first.release()
  })

  it('releases a slot aborted after the underlying FIFO acquisition but before transfer', async () => {
    const { queue, lifecycleQueue } = harness()
    const barrier = await queue.acquireExclusive('barrier')
    const abort = new AbortController()
    const enqueue = lifecycleQueue.enqueue.bind(lifecycleQueue)
    vi.spyOn(lifecycleQueue, 'enqueue').mockImplementationOnce(() => {
      const slot = enqueue()
      return {
        release: slot.release,
        waitUntilAcquired: async (signal) => {
          const acquired = await slot.waitUntilAcquired(signal)
          if (acquired) abort.abort()
          return acquired
        }
      }
    })
    const cancelled = queue.acquireExclusive('race', abort.signal)
    const nextPending = queue.acquireExclusive('next')
    barrier!.release()
    expect(await cancelled).toBeNull()
    const next = await nextPending
    expect(next?.kind).toBe('lifecycle')
    next!.release()
    expect(queue.snapshot()).toEqual([])
  })

  it('removes an owner when abort re-enters synchronously during queued cohort enrollment', async () => {
    const { queue, cohorts, start, close } = harness()
    const barrier = await queue.acquireExclusive('barrier')
    const firstPending = start('first', 'A')
    const abort = new AbortController()
    const cancelled = queue.acquireCompatible('race', 'A', abort.signal)
    const join = cohorts.tryJoin.bind(cohorts)
    vi.spyOn(cohorts, 'tryJoin').mockImplementation((owner, key) => {
      const lease = join(owner, key)
      if (owner === 'race') abort.abort()
      return lease
    })
    barrier!.release()
    const first = await firstPending
    expect(await cancelled).toBeNull()
    expect(queue.snapshot()).toEqual([])
    await first.release()
    expect(close).toHaveBeenCalledExactlyOnceWith('first')
  })

  it('does not reopen a closing cohort or start a successor before death is proven', async () => {
    let finishClose!: () => void
    const closing = new Promise<void>((resolve) => {
      finishClose = resolve
    })
    const { queue, cohorts, start } = harness(vi.fn(async () => closing))
    const first = await start('first', 'A')
    const release = first.release()
    expect(cohorts.admissionState()).toBeNull()
    expect(cohorts.reopenAdmission()).toBe(false)
    let nextAcquired = false
    const nextPending = queue.acquireExclusive('next').then((grant) => {
      nextAcquired = true
      return grant
    })
    await Promise.resolve()
    expect(nextAcquired).toBe(false)
    finishClose()
    await release
    const next = await nextPending
    next!.release()
  })

  it('recomputes admission when abort re-enters while drain closure is being applied', async () => {
    const { queue, cohorts, start } = harness()
    const first = await start('first', 'A')
    const abort = new AbortController()
    const stop = cohorts.stopAccepting.bind(cohorts)
    vi.spyOn(cohorts, 'stopAccepting').mockImplementationOnce(() => {
      stop()
      abort.abort()
    })
    expect(await queue.acquireExclusive('cancelled', abort.signal)).toBeNull()
    expect(cohorts.admissionState()?.accepting).toBe(true)
    const borrower = cohorts.tryBorrow('read-after-reentrant-abort')
    expect(borrower).not.toBeNull()
    await borrower!.release()
    await first.release()
  })

  it('does not undo a closed cohort whose lifecycle ownership was lost', async () => {
    const { queue, cohorts, canReopen, start } = harness()
    const first = await start('first', 'A')
    const abort = new AbortController()
    const cancelled = queue.acquireExclusive('cancelled', abort.signal)
    canReopen.mockReturnValue(false)
    abort.abort()
    expect(await cancelled).toBeNull()
    expect(cohorts.admissionState()?.accepting).toBe(false)
    expect(cohorts.tryBorrow('neutral')).toBeNull()
    await first.release()
  })
})
