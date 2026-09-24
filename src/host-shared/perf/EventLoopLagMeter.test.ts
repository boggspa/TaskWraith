import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { createEventLoopLagMeter } from './EventLoopLagMeter'

function blockEventLoop(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // Deliberate busy-wait: the meter exists to observe exactly this.
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('createEventLoopLagMeter', () => {
  it('reports zeros before sampling starts', () => {
    const meter = createEventLoopLagMeter()
    const snapshot = meter.snapshot()

    expect(snapshot.sampling).toBe(false)
    expect(snapshot.observedForMs).toBe(0)
    expect(snapshot.maxMs).toBe(0)
  })

  it('observes a deliberate main-thread block as max lag', async () => {
    const meter = createEventLoopLagMeter({ resolutionMs: 5 })
    meter.start()
    // Let the sampler take a couple of idle baselines first.
    await settle(30)
    blockEventLoop(60)
    // The blocked wakeup is recorded on the next tick after the block.
    await settle(30)
    const snapshot = meter.snapshot()
    meter.stop()

    expect(snapshot.sampling).toBe(true)
    expect(snapshot.observedForMs).toBeGreaterThanOrEqual(60)
    // The 60ms block must dominate the histogram max. Generous floor: the
    // sampler's own resolution and scheduler noise subtract from the reading.
    expect(snapshot.maxMs).toBeGreaterThanOrEqual(30)
    expect(snapshot.p50Ms).toBeLessThanOrEqual(snapshot.p95Ms)
    expect(snapshot.p95Ms).toBeLessThanOrEqual(snapshot.p99Ms + 0.001)
    expect(snapshot.p99Ms).toBeLessThanOrEqual(snapshot.maxMs + 0.001)
  })

  it('windows readings when a snapshot resets', async () => {
    const meter = createEventLoopLagMeter({ resolutionMs: 5 })
    meter.start()
    await settle(20)
    blockEventLoop(50)
    await settle(20)
    const first = meter.snapshot({ reset: true })
    expect(first.maxMs).toBeGreaterThanOrEqual(25)

    // A calm window after the reset must not re-report the old spike.
    await settle(40)
    const second = meter.snapshot()
    meter.stop()
    expect(second.maxMs).toBeLessThan(25)
  })

  it('stops sampling on stop and reports it', async () => {
    const meter = createEventLoopLagMeter({ resolutionMs: 5 })
    meter.start()
    await settle(15)
    meter.stop()
    const snapshot = meter.snapshot()

    expect(snapshot.sampling).toBe(false)
    expect(snapshot.observedForMs).toBe(0)
  })
})
