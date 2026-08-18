import { describe, expect, it, vi } from 'vitest'
import { createMainPerfInstrumentation } from './MainPerfSnapshot'
import type { EventLoopLagMeter, EventLoopLagSnapshot } from './EventLoopLagMeter'

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
