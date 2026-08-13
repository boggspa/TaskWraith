import { describe, expect, it, vi } from 'vitest'

import { CodexClientLifecycleQueue } from './CodexClientLifecycleQueue'

describe('CodexClientLifecycleQueue', () => {
  it('serializes lifecycle owners in FIFO order', async () => {
    const queue = new CodexClientLifecycleQueue()
    const first = queue.enqueue()
    const second = queue.enqueue()

    await expect(first.waitUntilAcquired()).resolves.toBe(true)
    const secondAcquired = vi.fn()
    void second.waitUntilAcquired().then(secondAcquired)
    await Promise.resolve()
    expect(secondAcquired).not.toHaveBeenCalled()

    first.release()
    await vi.waitFor(() => expect(secondAcquired).toHaveBeenCalledWith(true))
    second.release()
  })

  it('aborts a queued waiter promptly without allowing its successor to overtake', async () => {
    const queue = new CodexClientLifecycleQueue()
    const first = queue.enqueue()
    const cancelled = queue.enqueue()
    const successor = queue.enqueue()
    const controller = new AbortController()

    await expect(first.waitUntilAcquired()).resolves.toBe(true)
    const cancelledWait = cancelled.waitUntilAcquired(controller.signal)
    const successorAcquired = vi.fn()
    void successor.waitUntilAcquired().then(successorAcquired)

    controller.abort()
    await expect(cancelledWait).resolves.toBe(false)
    await Promise.resolve()
    expect(successorAcquired).not.toHaveBeenCalled()

    first.release()
    await vi.waitFor(() => expect(successorAcquired).toHaveBeenCalledWith(true))
    successor.release()
  })

  it('treats an already-aborted slot as a FIFO barrier rather than a ghost owner', async () => {
    const queue = new CodexClientLifecycleQueue()
    const first = queue.enqueue()
    const cancelled = queue.enqueue()
    const successor = queue.enqueue()
    const controller = new AbortController()
    controller.abort()

    await expect(first.waitUntilAcquired()).resolves.toBe(true)
    await expect(cancelled.waitUntilAcquired(controller.signal)).resolves.toBe(false)
    const successorWait = successor.waitUntilAcquired()

    first.release()
    await expect(successorWait).resolves.toBe(true)
    successor.release()
  })

  it('releases an acquired slot immediately for the next owner', async () => {
    const queue = new CodexClientLifecycleQueue()
    const first = queue.enqueue()
    const second = queue.enqueue()

    await expect(first.waitUntilAcquired()).resolves.toBe(true)
    first.release()
    await expect(second.waitUntilAcquired()).resolves.toBe(true)
    second.release()
  })

  it('rejects duplicate waits on the same queue slot', async () => {
    const queue = new CodexClientLifecycleQueue()
    const slot = queue.enqueue()

    await expect(slot.waitUntilAcquired()).resolves.toBe(true)
    await expect(slot.waitUntilAcquired()).rejects.toThrow(/only be awaited once/)
    slot.release()
  })
})
