import { describe, expect, it } from 'vitest'

import { midTurnSteerEnabled } from './SteeringFeatureGate'

describe('midTurnSteerEnabled', () => {
  it('is enabled by default', () => {
    expect(midTurnSteerEnabled({})).toBe(true)
    expect(midTurnSteerEnabled({ TASKWRAITH_MID_TURN_STEER: '' })).toBe(true)
  })

  it('retains explicit emergency kill-switch values', () => {
    for (const value of ['0', 'false', 'FALSE', ' no ', 'off']) {
      expect(midTurnSteerEnabled({ TASKWRAITH_MID_TURN_STEER: value })).toBe(false)
    }
  })

  it('accepts the documented true values', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(midTurnSteerEnabled({ TASKWRAITH_MID_TURN_STEER: value })).toBe(true)
    }
  })
})
