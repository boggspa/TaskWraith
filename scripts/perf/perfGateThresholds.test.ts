import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { PERF_GATE_THRESHOLDS, PROPOSED_CROSS_THREAD_BOUNDS } = require('./perfGateThresholds.cjs')

const canonicalBounds = {
  roundStartDeltaMs: 250,
  persistBarrierDeltaMs: 300,
  controlResponseMs: 300,
  hostQueueWaitUnrelatedMs: 50,
  hostEventLoopLagP95Ms: 25,
  mainEventLoopLagP95Ms: 25,
  asyncWriterQueueBytesCap: 'configured',
  fallbackCounterMax: 0
}

describe('proposed cross-thread bounds', () => {
  it('freezes eight canonical fields representing seven acceptance rows', () => {
    expect(Object.isFrozen(PROPOSED_CROSS_THREAD_BOUNDS)).toBe(true)
    expect(Object.keys(PROPOSED_CROSS_THREAD_BOUNDS)).toEqual(Object.keys(canonicalBounds))
    expect(Object.keys(PROPOSED_CROSS_THREAD_BOUNDS)).toHaveLength(8)
    expect(Reflect.set(PROPOSED_CROSS_THREAD_BOUNDS, 'roundStartDeltaMs', 999)).toBe(false)
    expect(PROPOSED_CROSS_THREAD_BOUNDS.roundStartDeltaMs).toBe(250)
  })

  it('serializes only canonical fields with the exact proposed values', () => {
    expect(JSON.parse(JSON.stringify(PROPOSED_CROSS_THREAD_BOUNDS))).toEqual(canonicalBounds)
  })

  it('keeps proposals separate from enforced gates and retains the existing main lag bound', () => {
    expect(PERF_GATE_THRESHOLDS).not.toHaveProperty('PROPOSED_CROSS_THREAD_BOUNDS')
    for (const key of Object.keys(canonicalBounds)) {
      expect(PERF_GATE_THRESHOLDS).not.toHaveProperty(key)
    }
    expect(PROPOSED_CROSS_THREAD_BOUNDS.mainEventLoopLagP95Ms).toBe(
      PERF_GATE_THRESHOLDS.maxEventLoopLagP95Ms
    )
  })

  it('preserves legacy property access with non-enumerable readonly aliases', () => {
    const aliases = {
      maxRoundStartLatencyOverLightAloneP95Ms: 250,
      maxPersistenceBarrierOverLightAloneP95Ms: 300,
      maxControlResponseEndToEndP95Ms: 300,
      maxHostQueueWaitUnrelatedCommandP95Ms: 50,
      maxHostEventLoopLagP95Ms: 25,
      maxAsyncWriterFallbackCount: 0,
      requireAsyncWriterQueueBytesWithinCap: true
    }
    for (const [key, value] of Object.entries(aliases)) {
      expect(PROPOSED_CROSS_THREAD_BOUNDS[key]).toBe(value)
      const descriptor = Object.getOwnPropertyDescriptor(PROPOSED_CROSS_THREAD_BOUNDS, key)
      expect(descriptor?.enumerable).toBe(false)
      expect(descriptor?.configurable).toBe(false)
      expect(descriptor?.set).toBeUndefined()
      expect(Reflect.set(PROPOSED_CROSS_THREAD_BOUNDS, key, 'changed')).toBe(false)
      expect(JSON.parse(JSON.stringify(PROPOSED_CROSS_THREAD_BOUNDS))).not.toHaveProperty(key)
    }
  })
})
