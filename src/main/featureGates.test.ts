import { afterEach, describe, expect, it } from 'vitest'
import { concurrentLanesEnabled } from './featureGates'

const ORIGINAL_CONCURRENT_FLAG = process.env.TASKWRAITH_CONCURRENT_LANES

afterEach(() => {
  if (ORIGINAL_CONCURRENT_FLAG === undefined) delete process.env.TASKWRAITH_CONCURRENT_LANES
  else process.env.TASKWRAITH_CONCURRENT_LANES = ORIGINAL_CONCURRENT_FLAG
})

describe('featureGates', () => {
  describe('concurrentLanesEnabled', () => {
    it('defaults on when the env flag is unset', () => {
      delete process.env.TASKWRAITH_CONCURRENT_LANES
      expect(concurrentLanesEnabled()).toBe(true)
    })

    it('opts out when TASKWRAITH_CONCURRENT_LANES=0', () => {
      process.env.TASKWRAITH_CONCURRENT_LANES = '0'
      expect(concurrentLanesEnabled()).toBe(false)
    })
  })
})
