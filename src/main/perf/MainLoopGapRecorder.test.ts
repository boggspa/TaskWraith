import { describe, expect, it, vi } from 'vitest'
import { createMainLoopGapRecorder } from './MainLoopGapRecorder'

function fixture(capacity = 10) {
  let now = 100
  let callback = () => {}
  let held = true
  const clearTimer = vi.fn()
  const release = vi.fn()
  const setTimer = vi.fn((next: () => void, ms: number) => {
    callback = next
    return ms
  })
  const recorder = createMainLoopGapRecorder({
    nowMs: () => now,
    capacity,
    setTimer,
    clearTimer,
    acquireProtection: () => ({ held: () => held, release })
  })
  return {
    recorder,
    setTimer,
    clearTimer,
    release,
    fire: (at: number) => {
      now = at
      callback()
    },
    end: (at: number) => {
      now = at
      return recorder.finish()
    },
    loseProtection: () => {
      held = false
    }
  }
}

describe('main loop-gap recorder', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'censors an invalid starting clock %s',
    (clock) => {
      const recorder = createMainLoopGapRecorder({
        nowMs: () => clock,
        setTimer: () => 1,
        clearTimer: () => {},
        acquireProtection: () => ({ held: () => true, release: () => {} })
      })
      recorder.start()
      const result = recorder.finish()
      expect(result.censored).toBe(true)
      expect(result.reasons).toContain('invalid_gap_clock')
      expect(result.blockedMs).toBe(0)
      expect(result.blockedFraction).toBeNull()
    }
  )
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'censors invalid sampled clock %s without poisoning totals',
    (invalid) => {
      let now = 100
      let tick = () => {}
      const release = vi.fn()
      const recorder = createMainLoopGapRecorder({
        nowMs: () => now,
        setTimer: (callback) => {
          tick = callback
          return 1
        },
        clearTimer: () => {},
        acquireProtection: () => ({ held: () => true, release })
      })
      recorder.start()
      now = invalid
      tick()
      const result = recorder.finish()
      expect(result.reasons).toContain('invalid_gap_clock')
      expect(result.censored).toBe(true)
      for (const value of [
        result.startedAtMs,
        result.endedAtMs,
        result.observedForMs,
        result.blockedMs
      ])
        expect(Number.isFinite(value)).toBe(true)
      expect(result.blockedFraction === null || Number.isFinite(result.blockedFraction)).toBe(true)
      expect(release).toHaveBeenCalledOnce()
    }
  )

  it('releases protection when initial timer registration throws', () => {
    const release = vi.fn()
    const recorder = createMainLoopGapRecorder({
      nowMs: () => 100,
      setTimer: () => {
        throw new Error('timer')
      },
      acquireProtection: () => ({ held: () => true, release })
    })
    expect(recorder.start()).toBe(false)
    expect(recorder.finish().reasons).toContain('gap_timer_failed')
    expect(release).toHaveBeenCalledOnce()
  })
  it('is resource-free until start and records expected-fire gaps including exactly 25ms', () => {
    const f = fixture()
    expect(f.setTimer).not.toHaveBeenCalled()
    f.recorder.start()
    f.fire(105)
    f.fire(134) // 24ms late: below threshold.
    f.fire(164) // 25ms late, expected 139.
    f.fire(209) // 40ms late, expected 169.
    const result = f.end(214)
    expect(result.gaps).toEqual([
      { expectedAtMs: 139, observedAtMs: 164, durationMs: 25 },
      { expectedAtMs: 169, observedAtMs: 209, durationMs: 40 }
    ])
    expect(result.blockedMs).toBe(65)
    expect(result.blockedFraction).toBe(65 / 114)
    expect(result.censored).toBe(false)
    expect(result.suspensionProtection.heldThroughout).toBe(true)
    expect(f.setTimer.mock.calls.every((call) => call[1] === 5)).toBe(true)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('censors overflow but retains the exact sum and a bounded timestamp ring', () => {
    const f = fixture(1)
    f.recorder.start()
    f.fire(135)
    f.fire(170)
    const result = f.end(175)
    expect(result.gaps).toHaveLength(1)
    expect(result.blockedMs).toBe(60)
    expect(result.dropped).toBe(1)
    expect(result.reasons).toContain('gap_ring_overflow')
    expect(result.censored).toBe(true)
  })

  it('captures the overdue final stretch once and cancels timers on end', () => {
    const f = fixture()
    f.recorder.start()
    const result = f.end(150)
    expect(result.blockedMs).toBe(45)
    expect(f.clearTimer).toHaveBeenCalled()
    f.fire(200)
    expect(f.end(250)).toBe(result)
    expect(result.gaps).toHaveLength(1)
  })

  it('refuses missing protection, records a lost lease and censors cancellation', () => {
    const absent = createMainLoopGapRecorder()
    absent.start()
    expect(absent.cancel().reasons).toContain('suspension_protection_unavailable')
    const f = fixture()
    f.recorder.start()
    f.loseProtection()
    f.fire(135)
    expect(f.recorder.cancel().reasons).toEqual(
      expect.arrayContaining(['suspension_protection_unavailable', 'gap_window_cancelled'])
    )
    expect(f.release).toHaveBeenCalledOnce()
    const invalid = createMainLoopGapRecorder({ capacity: 0 })
    expect(invalid.start()).toBe(false)
    expect(invalid.finish().censored).toBe(true)
  })
})
