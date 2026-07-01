import { describe, expect, it } from 'vitest'
import { buildRuntimeFeatureGateSnapshot } from './runtimeFeatureGates'

describe('runtimeFeatureGates', () => {
  it('defaults concurrent lanes on when unset', () => {
    expect(buildRuntimeFeatureGateSnapshot({}).concurrentLanes).toBe(true)
    expect(buildRuntimeFeatureGateSnapshot(undefined).concurrentLanes).toBe(true)
  })

  it('opts out of concurrent lanes with TASKWRAITH_CONCURRENT_LANES=0', () => {
    expect(
      buildRuntimeFeatureGateSnapshot({ TASKWRAITH_CONCURRENT_LANES: '0' }).concurrentLanes
    ).toBe(false)
  })

  it('defaults write lanes on unless explicitly disabled', () => {
    expect(buildRuntimeFeatureGateSnapshot({}).concurrentWriteLanes).toBe(true)
    expect(
      buildRuntimeFeatureGateSnapshot({ TASKWRAITH_CONCURRENT_WRITE_LANES: '0' })
        .concurrentWriteLanes
    ).toBe(false)
  })
})
