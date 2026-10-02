import { describe, expect, it, vi } from 'vitest'
import { createMainWindowPerfProbes } from './MainWindowPerfProbes'
import type { EventLoopLagMeter } from './EventLoopLagMeter'

function fixture() {
  let now = 100
  let finish = () => {}
  const meter: EventLoopLagMeter = {
    start: vi.fn(),
    stop: vi.fn(),
    snapshot: () => ({
      sampling: true,
      observedForMs: now - 100,
      p50Ms: 1,
      p95Ms: 30,
      p99Ms: 40,
      maxMs: 50,
      meanMs: 2
    })
  }
  const clearTimer = vi.fn()
  const probes = createMainWindowPerfProbes({
    createMeter: () => meter,
    nowMs: () => now,
    setTimer: (callback) => {
      finish = callback
      return 1
    },
    clearTimer
  })
  return {
    probes,
    meter,
    clearTimer,
    finish: () => {
      now = 230
      finish()
    }
  }
}

describe('main window probes', () => {
  it('captures counters at the meter deadline rather than the later end read', () => {
    let finish = () => {}
    let counters = 1
    const f = fixture()
    const probes = createMainWindowPerfProbes({
      createMeter: () => f.meter,
      readDurability: () => ({ counters }),
      setTimer: (callback) => {
        finish = callback
        return 1
      },
      clearTimer: () => {}
    })
    expect(probes.request({ action: 'begin', id: 'a', durationMs: 120 })).toMatchObject({
      durability: { counters: 1 }
    })
    counters = 2
    finish()
    counters = 99
    expect(probes.request({ action: 'end', id: 'a' })).toMatchObject({
      durability: { counters: 2 }
    })
  })

  it('retains the window histogram captured at its deadline until the end read', () => {
    const f = fixture()
    expect(f.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120 })).toEqual({
      status: 'started',
      id: 'beside_0',
      startedAtMs: 100,
      expectedEndAtMs: 220,
      durability: null
    })
    expect(f.probes.request({ action: 'end', id: 'beside_0' })).toEqual({
      status: 'unavailable',
      reason: 'window_incomplete'
    })
    f.finish()
    expect(f.probes.request({ action: 'end', id: 'beside_0' })).toMatchObject({
      status: 'complete',
      endedAtMs: 230,
      expectedEndAtMs: 220,
      eventLoopLag: { p95Ms: 30, sampling: true, observedForMs: 130 }
    })
    expect(f.meter.stop).toHaveBeenCalled()
    expect(f.probes.request({ action: 'end', id: 'beside_0' })).toMatchObject({
      reason: 'window_missing'
    })
  })

  it('refuses overlapping, malformed and unmatched requests and cleans up on shutdown', () => {
    const f = fixture()
    expect(f.probes.request({ action: 'begin', id: 'bad id', durationMs: 120 })).toMatchObject({
      reason: 'invalid_window'
    })
    expect(f.probes.request({ action: 'begin', id: 'a', durationMs: 600001 })).toMatchObject({
      reason: 'invalid_duration'
    })
    f.probes.request({ action: 'begin', id: 'a', durationMs: 120 })
    expect(f.probes.request({ action: 'begin', id: 'b', durationMs: 120 })).toMatchObject({
      reason: 'window_held'
    })
    expect(f.probes.request({ action: 'end', id: 'b' })).toMatchObject({ reason: 'window_missing' })
    f.probes.stop()
    expect(f.clearTimer).toHaveBeenCalledWith(1)
    expect(f.meter.stop).toHaveBeenCalled()
  })
})
