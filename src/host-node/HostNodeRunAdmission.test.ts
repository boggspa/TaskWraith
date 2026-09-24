import { describe, expect, it } from 'vitest'

import { createHostNodeRunAdmission } from './HostNodeRunAdmission'

describe('HostNodeRunAdmission', () => {
  it('admits up to the concurrent cap and rejects over-capacity starts', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 2, maxQueuedStarts: 0 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    const second = await admission.acquire({ commandId: 'run-2', threadId: 'thread-b' })
    expect(first.kind).toBe('admitted')
    expect(second.kind).toBe('admitted')
    expect(admission.inflightCount()).toBe(2)

    const overflow = await admission.acquire({ commandId: 'run-3', threadId: 'thread-c' })
    expect(overflow).toEqual({
      kind: 'rejected',
      errorCode: 'host_saturated',
      errorMessage: expect.stringMatching(/concurrent run capacity \(2\)/)
    })
    expect(admission.queuedCount()).toBe(0)
  })

  it('queues a bounded waiter and recovers the slot when an in-flight run releases', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 1 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    if (first.kind !== 'admitted') throw new Error('expected first admit')
    const queued = admission.acquire({ commandId: 'run-2', threadId: 'thread-b' })
    await Promise.resolve()
    expect(admission.queuedCount()).toBe(1)

    const overflow = await admission.acquire({ commandId: 'run-3', threadId: 'thread-c' })
    expect(overflow.kind).toBe('rejected')
    expect(overflow).toMatchObject({ errorCode: 'host_saturated' })

    first.lease.release()
    const admitted = await queued
    expect(admitted.kind).toBe('admitted')
    expect(admission.inflightCount()).toBe(1)
    expect(admission.queuedCount()).toBe(0)
    if (admitted.kind === 'admitted') admitted.lease.release()
    expect(admission.inflightCount()).toBe(0)
  })

  it('rejects a second start on a thread that is already admitted or queued', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 1 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    expect(first.kind).toBe('admitted')
    await expect(admission.acquire({ commandId: 'run-2', threadId: 'thread-a' })).resolves.toEqual({
      kind: 'rejected',
      errorCode: 'thread_busy',
      errorMessage: expect.stringMatching(/already has an active or queued run/)
    })

    const queued = admission.acquire({ commandId: 'run-3', threadId: 'thread-b' })
    await Promise.resolve()
    await expect(admission.acquire({ commandId: 'run-4', threadId: 'thread-b' })).resolves.toEqual({
      kind: 'rejected',
      errorCode: 'thread_busy',
      errorMessage: expect.stringMatching(/already has an active or queued run/)
    })
    if (first.kind === 'admitted') first.lease.release()
    const admitted = await queued
    if (admitted.kind === 'admitted') admitted.lease.release()
  })

  it('cancels a queued start without starting it and frees the queue slot', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 1 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    const queued = admission.acquire({ commandId: 'run-2', threadId: 'thread-b' })
    await Promise.resolve()
    expect(admission.cancelQueued({ threadId: 'thread-b', commandId: 'run-2' })).toBe(1)
    await expect(queued).resolves.toEqual({
      kind: 'rejected',
      errorCode: 'run_start_cancelled',
      errorMessage: 'Queued run was cancelled before it started.'
    })
    expect(admission.queuedCount()).toBe(0)
    if (first.kind === 'admitted') first.lease.release()
    const recovered = await admission.acquire({ commandId: 'run-3', threadId: 'thread-c' })
    expect(recovered.kind).toBe('admitted')
    if (recovered.kind === 'admitted') recovered.lease.release()
  })

  it('rejects waiters on shutdown and refuses later acquires', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 2 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    const queued = admission.acquire({ commandId: 'run-2', threadId: 'thread-b' })
    await Promise.resolve()
    admission.beginShutdown()
    await expect(queued).resolves.toEqual({
      kind: 'rejected',
      errorCode: 'host_shutting_down',
      errorMessage: 'Host is shutting down; the queued run was not started.'
    })
    await expect(admission.acquire({ commandId: 'run-3', threadId: 'thread-c' })).resolves.toEqual({
      kind: 'rejected',
      errorCode: 'host_shutting_down',
      errorMessage: 'Host is shutting down; the run was not started.'
    })
    expect(admission.queuedCount()).toBe(0)
    if (first.kind === 'admitted') first.lease.release()
  })

  it('invokes onClaim synchronously before the direct-admit result escapes', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 0 })
    const order: string[] = []
    const result = await admission.acquire({
      commandId: 'run-1',
      threadId: 'thread-a',
      onClaim: (lease) => {
        order.push(`claim:${lease.commandId}`)
      }
    })
    order.push(`observed:${result.kind}`)
    expect(order).toEqual(['claim:run-1', 'observed:admitted'])
    expect(result.kind).toBe('admitted')
    if (result.kind === 'admitted') result.lease.release()
  })

  it('invokes onClaim inside flushWaiters before the waiter promise resolves', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 1 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    const order: string[] = []
    const queued = admission
      .acquire({
        commandId: 'run-2',
        threadId: 'thread-b',
        onClaim: (lease) => {
          order.push(`claim:${lease.commandId}`)
        }
      })
      .then((result) => {
        order.push(`resolved:${result.kind}`)
        return result
      })
    await Promise.resolve()
    expect(admission.queuedCount()).toBe(1)

    if (first.kind === 'admitted') first.lease.release()
    const admitted = await queued
    // The latch hook ran strictly before the waiter observed the admission.
    expect(order).toEqual(['claim:run-2', 'resolved:admitted'])
    expect(admitted.kind).toBe('admitted')
    if (admitted.kind === 'admitted') admitted.lease.release()
  })

  it('cancelQueuedWithStatus reports a still-queued target and cancels it', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 1 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    const queued = admission.acquire({ commandId: 'run-2', threadId: 'thread-b' })
    await Promise.resolve()

    expect(admission.cancelQueuedWithStatus({ threadId: 'thread-b', commandId: 'run-2' })).toEqual({
      cancelled: 1,
      stillQueued: true,
      targetInflight: false
    })
    await expect(queued).resolves.toMatchObject({
      kind: 'rejected',
      errorCode: 'run_start_cancelled'
    })
    if (first.kind === 'admitted') first.lease.release()
  })

  it('cancelQueuedWithStatus routes a post-claim cancel to the latch instead of losing it', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 1 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    let latched: string | null = null
    const queued = admission.acquire({
      commandId: 'run-2',
      threadId: 'thread-b',
      onClaim: (lease) => {
        // The latch is installed atomically with the claim.
        latched = lease.commandId
      }
    })
    await Promise.resolve()

    // The Gap-1 race: release flushes the waiter (claim + latch happen
    // synchronously) BEFORE the awaiting continuation can act. A cancel that
    // lands anywhere after the release must NOT find "nothing".
    if (first.kind === 'admitted') first.lease.release()
    const status = admission.cancelQueuedWithStatus({ threadId: 'thread-b', commandId: 'run-2' })
    expect(status).toEqual({ cancelled: 0, stillQueued: false, targetInflight: true })
    expect(latched).toBe('run-2')

    const admitted = await queued
    expect(admitted.kind).toBe('admitted')
    if (admitted.kind === 'admitted') admitted.lease.release()
    expect(admission.inflightCount()).toBe(0)
  })

  it('keeps cancelQueued returning a bare count (existing API unchanged)', async () => {
    const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 1 })
    const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
    const queued = admission.acquire({ commandId: 'run-2', threadId: 'thread-b' })
    await Promise.resolve()
    expect(admission.cancelQueued({ threadId: 'thread-b' })).toBe(1)
    await expect(queued).resolves.toMatchObject({ kind: 'rejected' })
    if (first.kind === 'admitted') first.lease.release()
  })

  /**
   * M2 fixes A1/A2 (Review2 wave-4): a throwing claim hook must never leak
   * occupancy or surface through the releasing owner, and the inflight
   * cancel-target check must respect thread identity.
   */
  describe('claim-hook failure containment (A1)', () => {
    it('rolls back a direct admission when the hook throws and frees the slot', async () => {
      const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 0 })
      const explosion = new Error('latch install failed')
      await expect(
        admission.acquire({
          commandId: 'run-1',
          threadId: 'thread-a',
          onClaim: () => {
            throw explosion
          }
        })
      ).rejects.toBe(explosion)

      // The failed claim never became observable: no occupancy, no thread hold.
      expect(admission.inflightCount()).toBe(0)
      expect(admission.hasThread('thread-a')).toBe(false)

      // The slot is genuinely reusable, including by the same thread.
      const retry = await admission.acquire({ commandId: 'run-2', threadId: 'thread-a' })
      expect(retry.kind).toBe('admitted')
      if (retry.kind === 'admitted') retry.lease.release()
    })

    it('rejects the shifted waiter in its own await, keeps the releasing owner clean, and flushes later waiters', async () => {
      const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 1, maxQueuedStarts: 2 })
      const first = await admission.acquire({ commandId: 'run-1', threadId: 'thread-a' })
      if (first.kind !== 'admitted') throw new Error('expected first admit')

      const explosion = new Error('waiter latch failed')
      const broken = admission.acquire({
        commandId: 'run-2',
        threadId: 'thread-b',
        onClaim: () => {
          throw explosion
        }
      })
      // Attach the rejection expectation before the flush so the rejection
      // is observed in the waiter's own await, never as an unhandled error.
      const brokenSettled = expect(broken).rejects.toBe(explosion)
      let healthyLatch: string | null = null
      const healthy = admission.acquire({
        commandId: 'run-3',
        threadId: 'thread-c',
        onClaim: (lease) => {
          healthyLatch = lease.commandId
        }
      })
      await Promise.resolve()
      expect(admission.queuedCount()).toBe(2)

      // The releasing owner's own cleanup must not throw or observe the
      // broken waiter's failure.
      expect(() => first.lease.release()).not.toThrow()

      await brokenSettled
      // Flushing continued past the failed waiter: the freed slot belongs to
      // the next healthy waiter, whose latch installed atomically.
      const admitted = await healthy
      expect(admitted.kind).toBe('admitted')
      expect(healthyLatch).toBe('run-3')
      expect(admission.inflightCount()).toBe(1)
      expect(admission.hasThread('thread-b')).toBe(false)
      if (admitted.kind === 'admitted') admitted.lease.release()
      expect(admission.inflightCount()).toBe(0)
    })
  })

  describe('inflight cancel-target identity (A2)', () => {
    it('reports targetInflight only for the thread that owns the command', async () => {
      const admission = createHostNodeRunAdmission({ maxConcurrentRuns: 2, maxQueuedStarts: 0 })
      const owner = await admission.acquire({ commandId: 'cmd-1', threadId: 'thread-a' })
      expect(owner.kind).toBe('admitted')

      // Another thread naming this commandId is NOT the target: routing its
      // cancel to thread-a's latch would cancel the wrong run.
      expect(
        admission.cancelQueuedWithStatus({ threadId: 'thread-b', commandId: 'cmd-1' })
      ).toEqual({ cancelled: 0, stillQueued: false, targetInflight: false })

      // The owning identity still resolves, and so does the no-id thread search.
      expect(
        admission.cancelQueuedWithStatus({ threadId: 'thread-a', commandId: 'cmd-1' })
      ).toEqual({ cancelled: 0, stillQueued: false, targetInflight: true })
      expect(admission.cancelQueuedWithStatus({ threadId: 'thread-a' })).toEqual({
        cancelled: 0,
        stillQueued: false,
        targetInflight: true
      })

      // An unknown command is never inflight for anyone.
      expect(
        admission.cancelQueuedWithStatus({ threadId: 'thread-a', commandId: 'cmd-404' })
      ).toEqual({ cancelled: 0, stillQueued: false, targetInflight: false })

      if (owner.kind === 'admitted') owner.lease.release()
    })
  })
})
