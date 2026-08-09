import { afterEach, describe, expect, it, vi } from 'vitest'
import { LateBackgroundRefreshCoordinator } from './lateBackgroundRefreshCoordinator'

describe('LateBackgroundRefreshCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces late results through the follow-up and cooldown', async () => {
    vi.useFakeTimers()
    let busy = true
    let finishFollowup!: () => void
    const runFollowup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFollowup = resolve
        })
    )
    const coordinator = new LateBackgroundRefreshCoordinator({
      isBusy: () => busy,
      runFollowup,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      retryDelayMs: 250,
      cooldownMs: 30_000
    })

    expect(coordinator.queue()).toBe(true)
    expect(coordinator.queue()).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(runFollowup).not.toHaveBeenCalled()

    busy = false
    await vi.advanceTimersByTimeAsync(250)
    expect(runFollowup).toHaveBeenCalledTimes(1)
    expect(coordinator.queue()).toBe(false)

    finishFollowup()
    await Promise.resolve()
    await Promise.resolve()
    expect(coordinator.queue()).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(coordinator.queue()).toBe(true)
    coordinator.dispose()
  })

  it('releases the gate after a failed follow-up', async () => {
    vi.useFakeTimers()
    const coordinator = new LateBackgroundRefreshCoordinator({
      isBusy: () => false,
      runFollowup: () => Promise.reject(new Error('offline')),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      retryDelayMs: 0,
      cooldownMs: 0
    })

    expect(coordinator.queue()).toBe(true)
    await vi.runAllTimersAsync()
    expect(coordinator.queue()).toBe(true)
    coordinator.dispose()
  })
})
