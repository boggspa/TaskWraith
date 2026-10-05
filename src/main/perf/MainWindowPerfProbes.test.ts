import { describe, expect, it, vi } from 'vitest'
import { createMainWindowPerfProbes } from './MainWindowPerfProbes'
import { createMainLoopGapRecorder } from './MainLoopGapRecorder'
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
  it.each(['start', 'gap_start', 'timer', 'snapshot', 'stop', 'finish', 'cancel', 'clock'])(
    'cleans timer and protection after %s faults',
    (fault) => {
      let now = 100
      let complete = () => {}
      const timers = new Set<unknown>()
      let leases = 0
      const base = fixture().meter
      const probes = createMainWindowPerfProbes({
        nowMs: () => (fault === 'clock' ? Number.NaN : now),
        createMeter: () => ({
          ...base,
          start: () => {
            if (fault === 'start') throw new Error('start')
          },
          snapshot: () => {
            if (fault === 'snapshot') throw new Error('snapshot')
            return base.snapshot()
          },
          stop: () => {
            if (fault === 'stop') throw new Error('stop')
          }
        }),
        setTimer: (callback) => {
          if (fault === 'timer') throw new Error('timer')
          complete = callback
          timers.add('window')
          return 'window'
        },
        clearTimer: (id) => {
          timers.delete(id)
        },
        createGapRecorder: () => {
          const recorder = createMainLoopGapRecorder({
            nowMs: () => now,
            setTimer: () => {
              timers.add('gap')
              return 'gap'
            },
            clearTimer: (id) => {
              timers.delete(id)
            },
            acquireProtection: () => {
              leases++
              return {
                held: () => true,
                release: () => {
                  leases--
                }
              }
            }
          })
          return {
            ...recorder,
            start: (...args: Parameters<typeof recorder.start>) => {
              const started = recorder.start(...args)
              if (fault === 'gap_start') throw new Error('gap_start')
              return started
            },
            finish: (...args: Parameters<typeof recorder.finish>) => {
              if (fault === 'finish') throw new Error('finish')
              return recorder.finish(...args)
            },
            cancel: () => {
              if (fault === 'cancel') throw new Error('cancel')
              return recorder.cancel()
            }
          }
        }
      })
      const begin = probes.request({ action: 'begin', id: 'fault', durationMs: 100 })
      if (begin.status === 'started') {
        now = 200
        timers.delete('window')
        complete()
        expect(probes.request({ action: 'end', id: 'fault' })?.status).toBe('unavailable')
      } else expect(begin.status).toBe('unavailable')
      probes.stop()
      expect(timers.size).toBe(0)
      expect(leases).toBe(0)
    }
  )
  it('returns timer-fenced gaps and releases the protection resource on end or cancellation', () => {
    let now = 100
    let tick = () => {}
    let finish = () => {}
    const release = vi.fn()
    const f = fixture()
    const probes = createMainWindowPerfProbes({
      createMeter: () => f.meter,
      nowMs: () => now,
      setTimer: (callback) => {
        finish = callback
        return 1
      },
      clearTimer: () => {},
      createGapRecorder: () =>
        createMainLoopGapRecorder({
          nowMs: () => now,
          setTimer: (callback) => {
            tick = callback
            return 2
          },
          clearTimer: () => {},
          acquireProtection: () => ({ held: () => true, release })
        })
    })
    probes.request({ action: 'begin', id: 'gap', durationMs: 100 })
    now = 140
    tick()
    now = 200
    finish()
    expect(probes.request({ action: 'end', id: 'gap' })).toMatchObject({
      loopGaps: { blockedMs: 90, observedForMs: 100, blockedFraction: 0.9, censored: false }
    })
    expect(release).toHaveBeenCalledOnce()
    probes.request({ action: 'begin', id: 'cancel', durationMs: 100 })
    probes.stop()
    expect(release).toHaveBeenCalledTimes(2)
  })
  it('captures counters at the meter deadline rather than the later end read', () => {
    let finish = () => {}
    let counters = 1
    let now = 100
    const f = fixture()
    const probes = createMainWindowPerfProbes({
      createMeter: () => f.meter,
      nowMs: () => now,
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
    now = 220
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
      clock: {
        clockId: 'injected.nowMs',
        identity: 'unverified',
        provenance: 'injected-unverified'
      },
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

describe('a window main closes only once its clock has covered it', () => {
  /** Main's probes with the clock and every timer in the test's hands. */
  function rig(options: { rearmFails?: boolean; startAtMs?: number } = {}) {
    let now = options.startAtMs ?? 100
    const arms: Array<{ id: number; ms: number; fire: () => void }> = []
    const cleared: unknown[] = []
    const gapFinishes: unknown[][] = []
    const gaps = { cancel: vi.fn(), dispose: vi.fn() }
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
    const probes = createMainWindowPerfProbes({
      createMeter: () => meter,
      nowMs: () => now,
      readDurability: () => ({ counters: 1 }),
      createGapRecorder: () =>
        ({
          start: () => true,
          finish: (...args: unknown[]) => {
            gapFinishes.push(args)
            return { endedAtMs: args[1] }
          },
          ...gaps
        }) as never,
      setTimer: (callback, ms) => {
        if (options.rearmFails && arms.length > 0) throw new Error('timer')
        arms.push({ id: arms.length + 1, ms, fire: callback })
        return arms.length
      },
      clearTimer: (id) => {
        cleared.push(id)
      }
    })
    return {
      probes,
      arms,
      cleared,
      gapFinishes,
      gaps,
      meter,
      at: (value: number) => {
        now = value
      }
    }
  }

  it('waits out a timer that runs half a millisecond early, then closes the window covered', () => {
    const r = rig()
    r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120 })
    expect(r.arms.map((arm) => arm.ms)).toEqual([120])
    r.at(219.5)
    r.arms[0].fire()
    // The rest of the window, rounded up to a whole millisecond.
    expect(r.arms.map((arm) => arm.ms)).toEqual([120, 1])
    expect(r.meter.stop).not.toHaveBeenCalled()
    expect(r.gapFinishes).toEqual([])
    r.at(220.25)
    r.arms[1].fire()
    expect(r.meter.stop).toHaveBeenCalledOnce()
    const receipt = r.probes.request({ action: 'end', id: 'beside_0' })
    expect(receipt).toEqual({
      status: 'complete',
      clock: {
        clockId: 'injected.nowMs',
        identity: 'unverified',
        provenance: 'injected-unverified'
      },
      id: 'beside_0',
      startedAtMs: 100,
      endedAtMs: 220.25,
      expectedEndAtMs: 220,
      eventLoopLag: {
        sampling: true,
        observedForMs: 120.25,
        p50Ms: 1,
        p95Ms: 30,
        p99Ms: 40,
        maxMs: 50,
        meanMs: 2
      },
      loopGaps: { endedAtMs: 220.25 },
      durability: { counters: 1 },
      residuals: undefined
    })
    if (receipt.status !== 'complete') throw new Error('no receipt')
    expect(receipt.endedAtMs - receipt.startedAtMs).toBeGreaterThanOrEqual(120)
    expect(r.gapFinishes).toEqual([[false, 220.25]])
    expect(r.arms).toHaveLength(2)
  })

  it('arms once for a timer that runs on time, or late', () => {
    for (const firedAtMs of [220, 230]) {
      const r = rig()
      r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120 })
      r.at(firedAtMs)
      r.arms[0].fire()
      expect(r.arms).toHaveLength(1)
      expect(r.probes.request({ action: 'end', id: 'beside_0' })).toMatchObject({
        status: 'complete',
        startedAtMs: 100,
        endedAtMs: firedAtMs
      })
    }
  })

  it('answers an end asked between the early run and the re-armed one as incomplete', () => {
    const r = rig()
    r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120 })
    r.at(219.5)
    r.arms[0].fire()
    expect(r.probes.request({ action: 'end', id: 'beside_0' })).toEqual({
      status: 'unavailable',
      reason: 'window_incomplete'
    })
    // Asked again, as the harness does, the window is still held, not lost.
    expect(r.probes.request({ action: 'end', id: 'beside_0' })).toEqual({
      status: 'unavailable',
      reason: 'window_incomplete'
    })
    r.at(220)
    r.arms[1].fire()
    expect(r.probes.request({ action: 'end', id: 'beside_0' })).toMatchObject({
      status: 'complete',
      endedAtMs: 220
    })
  })

  it('rounds each rest up to whole milliseconds, never under one', () => {
    const r = rig()
    r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120 })
    r.at(217.7)
    r.arms[0].fire()
    r.at(219.9999)
    r.arms[1].fire()
    expect(r.arms.map((arm) => arm.ms)).toEqual([120, 3, 1])
    r.at(220)
    r.arms[2].fire()
    expect(r.probes.request({ action: 'end', id: 'beside_0' })).toMatchObject({
      status: 'complete',
      endedAtMs: 220
    })
  })

  it('waits a millisecond more where the end is reached but the length is short by rounding', () => {
    // From this start, the end main expects is reached a few hundred-billionths
    // of a millisecond before the window's whole length has passed.
    const startedAtMs = 213605.1522862971
    const expectedEndAtMs = startedAtMs + 120_000
    expect(expectedEndAtMs - startedAtMs).toBeLessThan(120_000)
    const r = rig({ startAtMs: startedAtMs })
    r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120_000 })
    r.at(expectedEndAtMs)
    r.arms[0].fire()
    expect(r.arms.map((arm) => arm.ms)).toEqual([120_000, 1])
    r.at(expectedEndAtMs + 1)
    r.arms[1].fire()
    const receipt = r.probes.request({ action: 'end', id: 'beside_0' })
    if (receipt.status !== 'complete') throw new Error('no receipt')
    expect(receipt.endedAtMs - receipt.startedAtMs).toBeGreaterThanOrEqual(120_000)
  })

  it('waits for its own expected end even where the length has passed by rounding', () => {
    // From this start, the window's whole length has passed a hair before the
    // clock reaches the end main promised: no receipt ends before that end.
    const startedAtMs = 8059.246122876029
    const expectedEndAtMs = startedAtMs + 120_000
    const justBefore = 128059.24612287602
    expect(justBefore).toBeLessThan(expectedEndAtMs)
    expect(justBefore - startedAtMs).toBeGreaterThanOrEqual(120_000)
    const r = rig({ startAtMs: startedAtMs })
    r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120_000 })
    r.at(justBefore)
    r.arms[0].fire()
    expect(r.arms.map((arm) => arm.ms)).toEqual([120_000, 1])
    r.at(expectedEndAtMs)
    r.arms[1].fire()
    expect(r.probes.request({ action: 'end', id: 'beside_0' })).toMatchObject({
      status: 'complete',
      endedAtMs: expectedEndAtMs
    })
  })

  it('clears the re-armed timer when stopped while it waits', () => {
    const r = rig()
    r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120 })
    r.at(219.5)
    r.arms[0].fire()
    r.probes.stop()
    expect(r.cleared).toEqual([2])
    expect(r.meter.stop).toHaveBeenCalledOnce()
    expect(r.gaps.cancel).toHaveBeenCalled()
    expect(r.gaps.dispose).toHaveBeenCalled()
    r.at(220)
    r.arms[1].fire()
    expect(r.gapFinishes).toEqual([])
    expect(r.probes.request({ action: 'end', id: 'beside_0' })).toMatchObject({
      reason: 'window_missing'
    })
  })

  it('fails the window rather than close it short when the rest cannot be armed', () => {
    const r = rig({ rearmFails: true })
    r.probes.request({ action: 'begin', id: 'beside_0', durationMs: 120 })
    r.at(219.5)
    r.arms[0].fire()
    expect(r.gapFinishes).toEqual([])
    expect(r.meter.stop).toHaveBeenCalledOnce()
    expect(r.probes.request({ action: 'end', id: 'beside_0' })).toEqual({
      status: 'unavailable',
      reason: 'window_measurement_failed'
    })
  })
})
