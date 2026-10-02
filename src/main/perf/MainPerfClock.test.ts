import { describe, expect, it } from 'vitest'
import {
  productionMainPerfClock,
  profileUsToMonotonicMs,
  resolveMainPerfClock
} from './MainPerfClock'
import { createMainWindowPerfProbes } from './MainWindowPerfProbes'

describe('main performance clock', () => {
  it('uses actual Node monotonic time with process-origin identity', () => {
    expect(productionMainPerfClock.clockId).toBe('node.performance.now')
    expect(productionMainPerfClock.identity).toContain(`main:${process.pid}:`)
    expect(productionMainPerfClock.nowMs()).toBeLessThan(Date.now())
    expect(resolveMainPerfClock(undefined, Date.now).provenance).toBe('injected-unverified')
  })
  it('maps only measured same-clock anchors and refuses invalid coordinates', () => {
    const clock = productionMainPerfClock
    const anchor = {
      clockId: clock.clockId,
      identity: clock.identity,
      measured: true,
      profileUs: 1000000,
      monotonicMs: 250.5
    }
    expect(profileUsToMonotonicMs(1002500, clock, anchor)).toBe(253)
    for (const changed of [
      { measured: false },
      { identity: 'other-process' },
      { clockId: 'Date.now' },
      { profileUs: NaN },
      { monotonicMs: Infinity }
    ]) {
      expect(profileUsToMonotonicMs(1002500, clock, { ...anchor, ...changed })).toBeNull()
    }
    expect(profileUsToMonotonicMs(NaN, clock, anchor)).toBeNull()
    expect(profileUsToMonotonicMs(1, resolveMainPerfClock(undefined, Date.now), anchor)).toBeNull()
  })
  it('runs the native Node window with fractional monotonic coordinates and shared clock identity', async () => {
    const probes = createMainWindowPerfProbes()
    try {
      const begin = probes.request({ action: 'begin', id: 'node_clock', durationMs: 40 })
      expect(begin.status).toBe('started')
      await new Promise((resolve) => setTimeout(resolve, 70))
      const end = probes.request({ action: 'end', id: 'node_clock' })
      expect(end.status).toBe('complete')
      if (end.status !== 'complete' || begin.status !== 'started')
        throw new Error('Missing native receipt')
      expect(end.clock).toEqual(begin.clock)
      expect(end.loopGaps.clock).toEqual(end.clock)
      expect(end.endedAtMs).toBeGreaterThan(begin.startedAtMs)
      expect(end.loopGaps.censored).toBe(true) // No Electron protection port was acquired.
    } finally {
      probes.stop()
    }
  })
})
