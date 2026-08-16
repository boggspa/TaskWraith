import { afterEach, describe, expect, it, vi } from 'vitest'
import { LateBackgroundRefreshCoordinator } from './lateBackgroundRefreshCoordinator'

describe('LateBackgroundRefreshCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces late results queued before the follow-up starts', async () => {
    vi.useFakeTimers()
    let busy = true
    const runFollowup = vi.fn(async () => undefined)
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
    await vi.advanceTimersByTimeAsync(30_000)
    expect(coordinator.queue()).toBe(true)
    coordinator.dispose()
  })

  it('runs one trailing follow-up when another provider resolves during a read', async () => {
    vi.useFakeTimers()
    const finishes: Array<() => void> = []
    const runFollowup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishes.push(resolve)
        })
    )
    const coordinator = new LateBackgroundRefreshCoordinator({
      isBusy: () => false,
      runFollowup,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      retryDelayMs: 250,
      cooldownMs: 30_000
    })

    expect(coordinator.queue()).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(runFollowup).toHaveBeenCalledTimes(1)
    expect(coordinator.queue()).toBe(true)
    expect(coordinator.queue()).toBe(false)

    finishes[0]()
    await Promise.resolve()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(250)
    expect(runFollowup).toHaveBeenCalledTimes(2)
    finishes[1]()
    coordinator.dispose()
  })

  it('interrupts cooldown when a slower provider finishes with newer data', async () => {
    vi.useFakeTimers()
    const runFollowup = vi.fn(async () => undefined)
    const coordinator = new LateBackgroundRefreshCoordinator({
      isBusy: () => false,
      runFollowup,
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      retryDelayMs: 250,
      cooldownMs: 30_000
    })

    expect(coordinator.queue()).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(runFollowup).toHaveBeenCalledTimes(1)

    expect(coordinator.queue()).toBe(true)
    expect(coordinator.queue()).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(runFollowup).toHaveBeenCalledTimes(2)
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
