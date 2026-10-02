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
