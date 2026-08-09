import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleProviderMetadataWarmup } from './providerMetadataWarmup'

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(new Event(type))
      else listener.handleEvent(new Event(type))
    }
  }
}

function schedulerOptions(
  eventTarget: FakeEventTarget,
  refresh: (provider: string) => Promise<unknown>,
  quietMs = 1_000
) {
  return {
    providers: ['claude', 'kimi', 'cursor'],
    refresh,
    eventTarget: eventTarget as unknown as Window,
    quietMs,
    now: () => Date.now(),
    setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

describe('scheduleProviderMetadataWarmup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for a real quiet window and refreshes providers one at a time', async () => {
    vi.useFakeTimers()
    const target = new FakeEventTarget()
    const refresh = vi.fn(async () => {})
    const controller = scheduleProviderMetadataWarmup(schedulerOptions(target, refresh))

    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).not.toHaveBeenCalled()
    target.dispatch('pointerdown')
    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenNthCalledWith(1, 'claude')
    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenNthCalledWith(2, 'kimi')

    controller.dispose()
  })

  it('holds the remaining queue when activity arrives during an in-flight probe', async () => {
    vi.useFakeTimers()
    const target = new FakeEventTarget()
    let releaseFirst: (() => void) | undefined
    const refresh = vi.fn((provider: string) =>
      provider === 'claude'
        ? new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        : Promise.resolve()
    )
    const controller = scheduleProviderMetadataWarmup(schedulerOptions(target, refresh))

    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    target.dispatch('wheel')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    releaseFirst?.()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenNthCalledWith(2, 'kimi')

    controller.dispose()
  })

  it('deduplicates providers and disposal cancels pending work and input listeners', async () => {
    vi.useFakeTimers()
    const target = new FakeEventTarget()
    const refresh = vi.fn(async () => {})
    const controller = scheduleProviderMetadataWarmup({
      ...schedulerOptions(target, refresh),
      providers: ['claude', 'claude']
    })

    controller.dispose()
    target.dispatch('keydown')
    await vi.runAllTimersAsync()
    expect(refresh).not.toHaveBeenCalled()
  })
})
