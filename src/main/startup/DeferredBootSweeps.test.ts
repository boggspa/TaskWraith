import { describe, expect, it, vi } from 'vitest'
import {
  runSlicesSerially,
  scheduleDeferredBootSweeps,
  yieldToEventLoop,
  type DeferredBootSweepSchedule
} from './DeferredBootSweeps'

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function manualTimers() {
  const callbacks = new Map<number, () => void>()
  let nextId = 1
  return {
    callbacks,
    setTimeoutFn: vi.fn((callback: () => void, _ms: number) => {
      const id = nextId++
      callbacks.set(id, callback)
      return id
    }),
    clearTimeoutFn: vi.fn((handle: unknown) => {
      callbacks.delete(handle as number)
    }),
    fire: (id: number) => callbacks.get(id)?.()
  }
}

describe('runSlicesSerially', () => {
  it('processes slices in order and yields between them', async () => {
    const processed: string[] = []
    let yields = 0
    await runSlicesSerially(
      [['a'], ['b', 'c'], []],
      (slice) => {
        processed.push(slice.join(','))
      },
      async () => {
        yields++
      }
    )
    expect(processed).toEqual(['a', 'b,c', ''])
    expect(yields).toBe(3)
  })

  it('processes nothing when there are no slices', async () => {
    const processSlice = vi.fn()
    const yieldBetweenSlices = vi.fn(async () => {})
    await runSlicesSerially([], processSlice, yieldBetweenSlices)
    expect(processSlice).not.toHaveBeenCalled()
    expect(yieldBetweenSlices).not.toHaveBeenCalled()
  })

  it('yields to the event loop', async () => {
    await expect(yieldToEventLoop()).resolves.toBeUndefined()
  })
})

describe('scheduleDeferredBootSweeps', () => {
  function schedule(overrides: Partial<DeferredBootSweepSchedule> = {}) {
    const timers = manualTimers()
    let paintCallback: (() => void) | null = null
    const runFullSweeps = vi.fn(async () => {})
    scheduleDeferredBootSweeps({
      headless: false,
      onFirstPaint: (cb) => {
        paintCallback = cb
      },
      paintTimeoutMs: 60_000,
      runFullSweeps,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      ...overrides
    })
    return { timers, runFullSweeps, firePaint: () => paintCallback?.() }
  }

  it('runs on first paint and disarms the backstop', async () => {
    const { timers, runFullSweeps, firePaint } = schedule()
    firePaint()
    await flushAsync()
    expect(runFullSweeps).toHaveBeenCalledTimes(1)
    expect(timers.clearTimeoutFn).toHaveBeenCalledTimes(1)
    expect(timers.callbacks.size).toBe(0)
  })

  it('runs on the backstop when paint never arrives', async () => {
    const { timers, runFullSweeps } = schedule()
    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(1)
    expect(timers.setTimeoutFn.mock.calls[0][1]).toBe(60_000)
    timers.fire(1)
    await flushAsync()
    expect(runFullSweeps).toHaveBeenCalledTimes(1)
  })

  it('runs exactly once when paint and the backstop both fire', async () => {
    const { timers, runFullSweeps, firePaint } = schedule()
    firePaint()
    timers.fire(1)
    firePaint()
    await flushAsync()
    expect(runFullSweeps).toHaveBeenCalledTimes(1)
  })

  it('runs headless on the next macrotask without waiting for paint', async () => {
    const onFirstPaint = vi.fn()
    const { timers, runFullSweeps } = schedule({ headless: true, onFirstPaint })
    expect(onFirstPaint).not.toHaveBeenCalled()
    expect(timers.setTimeoutFn).toHaveBeenCalledTimes(1)
    expect(timers.setTimeoutFn.mock.calls[0][1]).toBe(0)
    // No backstop is armed headless: nothing to clear.
    expect(timers.clearTimeoutFn).not.toHaveBeenCalled()
    timers.fire(1)
    await flushAsync()
    expect(runFullSweeps).toHaveBeenCalledTimes(1)
  })

  it('reports sweep failures instead of throwing', async () => {
    const onError = vi.fn()
    const runFullSweeps = vi.fn(async () => {
      throw new Error('sweep exploded')
    })
    const { firePaint } = schedule({ runFullSweeps, onError })
    firePaint()
    await flushAsync()
    await flushAsync()
    expect(runFullSweeps).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(String(onError.mock.calls[0][0])).toMatch(/sweep exploded/)
  })
})
