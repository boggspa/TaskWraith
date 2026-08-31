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
})
