import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  waitForWorkspaceLockStateChange,
  type WorkspaceLockAvailabilitySource
} from './WorkspaceLockAvailability'
import { acquireWorkspaceMutationWhenAvailable } from './WorkspaceLockMcpAdmissionCoordinator'
import type { WorkspaceLockRuntimeAcquireResult } from './WorkspaceLockRuntime'

afterEach(() => vi.useRealTimers())

describe('workspace mutation availability waiting', () => {
  it('does not amplify other waiters’ contention notices into retry storms', async () => {
    vi.useFakeTimers()
    let notify!: Parameters<NonNullable<WorkspaceLockAvailabilitySource['subscribe']>>[1]
    const unsubscribe = vi.fn()
    const acquire = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'conflict', message: 'held' })
      .mockResolvedValueOnce({ ok: true } as WorkspaceLockRuntimeAcquireResult)
    const waiting = acquireWorkspaceMutationWhenAvailable({
      runtime: {
        subscribe: (_query, listener) => {
          notify = listener
          return { unsubscribe, snapshot: {} as never }
        }
      },
      acquire,
      stillWanted: () => true
    })
    await Promise.resolve()
    for (let i = 0; i < 1000; i++) notify({ reason: 'contended', snapshot: {} as never })
    await Promise.resolve()
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(unsubscribe).not.toHaveBeenCalled()
    notify({ reason: 'released', snapshot: {} as never })
    expect(await waiting).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks another process without requiring a local event and honors cancellation', async () => {
    vi.useFakeTimers()
    let wanted = true
    const acquire = vi.fn(async () => ({
      ok: false as const,
      code: 'conflict' as const,
      message: 'held'
    }))
    const waiting = acquireWorkspaceMutationWhenAvailable({
      runtime: {},
      acquire,
      stillWanted: () => wanted
    })
    await Promise.resolve()
    wanted = false
    await vi.advanceTimersByTimeAsync(250)
    expect(await waiting).toBeNull()
    expect(acquire).toHaveBeenCalledOnce()
  })

  it('unsubscribes an adapter that delivers a state change synchronously', async () => {
    vi.useFakeTimers()
    const unsubscribe = vi.fn()
    await waitForWorkspaceLockStateChange(
      {
        subscribe: (_query, notify) => {
          notify({ reason: 'released', snapshot: {} as never })
          return { unsubscribe, snapshot: {} as never }
        }
      },
      () => true
    )
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
