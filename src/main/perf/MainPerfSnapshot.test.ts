import { describe, expect, it, vi } from 'vitest'
import { createMainPerfInstrumentation } from './MainPerfSnapshot'
import type { EventLoopLagMeter, EventLoopLagSnapshot } from './EventLoopLagMeter'
import type { HostLoadSampler, HostLoadSnapshot } from './HostLoadSample'

function fakeHostLoad(overrides: Partial<HostLoadSnapshot> = {}): HostLoadSampler {
  const snapshot: HostLoadSnapshot = {
    loadPerCpu1m: 0.25,
    loadAverage1m: 2,
    loadAverage5m: 2,
    loadAverage15m: 2,
    loadAverageReported: true,
    cpuBusyPercent: 41,
    hostContended: false,
    loadIsNotCpuBound: false,
    cpuCount: 8,
    processCpuPercent: 40,
    processCpuWindowMs: 1_000,
    processCpuUserMs: 350,
    processCpuSystemMs: 50,
    ...overrides
  }
  return { sample: () => snapshot }
}

function fakeMeter(): { meter: EventLoopLagMeter; resets: number[] } {
  const resets: number[] = []
  const lag: EventLoopLagSnapshot = {
    observedForMs: 1000,
    p50Ms: 1,
    p95Ms: 5,
    p99Ms: 9,
    maxMs: 42,
    meanMs: 2,
    sampling: true
  }
  return {
    resets,
    meter: {
      start: vi.fn(),
      stop: vi.fn(),
      snapshot: (options) => {
        resets.push(options?.reset ? 1 : 0)
        return lag
      }
    }
  }
}

describe('createMainPerfInstrumentation', () => {
  it('bundles the lag snapshot with every healthy section', () => {
    const { meter } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({
      meter,
      hostLoad: fakeHostLoad(),
      now: () => new Date('2026-08-18T18:00:00.000Z'),
      sections: {
        journal: () => ({ appends: 7 }),
        queue: () => null
      }
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.capturedAt).toBe('2026-08-18T18:00:00.000Z')
    expect(snapshot.eventLoopLag.maxMs).toBe(42)
    expect(snapshot.sections.journal).toEqual({ appends: 7 })
    expect(snapshot.sections.queue).toBeNull()
  })

  it('carries the host reading beside the lag, so a red gate can be attributed', () => {
    const { meter } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({
      meter,
      hostLoad: fakeHostLoad({ loadPerCpu1m: 3.5, hostContended: true })
    })

    const snapshot = instrumentation.snapshot()

    // Same window, both halves: p95 5 ms of lag against a host running 3.5x
    // oversubscribed is a different verdict from the same lag on an idle box.
    expect(snapshot.eventLoopLag.p95Ms).toBe(5)
    expect(snapshot.host.loadPerCpu1m).toBe(3.5)
    expect(snapshot.host.hostContended).toBe(true)
    expect(snapshot.host.processCpuPercent).toBe(40)
  })

  it('degrades a throwing section to an error marker without failing the snapshot', () => {
    const { meter } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({
      meter,
      sections: {
        broken: () => {
          throw new Error('stats source detached')
        },
        healthy: () => 3
      }
    })
    const snapshot = instrumentation.snapshot()

    expect(snapshot.sections.broken).toEqual({ error: 'stats source detached' })
    expect(snapshot.sections.healthy).toBe(3)
  })

  it('passes the window reset through to the meter', () => {
    const { meter, resets } = fakeMeter()
    const instrumentation = createMainPerfInstrumentation({ meter })
    instrumentation.snapshot()
    instrumentation.snapshot({ resetLagWindow: true })

    expect(resets).toEqual([0, 1])
  })
})
