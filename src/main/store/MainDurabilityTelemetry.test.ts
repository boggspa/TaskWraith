import { describe, expect, it } from 'vitest'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { readMainDurabilityTelemetry, UNMEASURED_X3_COUNTERS } from './MainDurabilityTelemetry'

describe('partial X3 telemetry', () => {
  it('leaves absent pool and legacy/residual measurements null rather than synthesizing zero', () => {
    const telemetry = readMainDurabilityTelemetry(null)
    expect(telemetry.poolOwners).toBeNull()
    expect(Object.keys(telemetry.unmeasured)).toEqual([...UNMEASURED_X3_COUNTERS])
    expect(Object.values(telemetry.unmeasured).every((value) => value === null)).toBe(true)
  })
  it('exposes actual pool operations separately from still-unmeasured residuals', () => {
    const pool = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (_fd, done) => ({ joinSync: () => done() }),
      fsyncSync: () => {},
      close: () => {}
    })
    const file = pool.open(1, 1, 1, 0, 'journal')
    pool.noteWrite(file, 10, 'sync')
    const telemetry = readMainDurabilityTelemetry(pool)
    expect(telemetry.poolOwners?.journal.strictFsyncs).toBe(1)
    expect(telemetry.unmeasured.forcedSynchronousCheckpoints).toBeNull()
    expect(telemetry).not.toHaveProperty('accepted')
  })
})
