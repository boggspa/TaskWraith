import { describe, expect, it } from 'vitest'
import {
  PI_CEREBRAS_429_BACKOFF_MS,
  PI_CEREBRAS_MAX_HOLD_MS,
  PI_CEREBRAS_RATE_WINDOW_MS,
  PI_CEREBRAS_RPM_SLOTS,
  PiCerebrasRateGovernor
} from './PiCerebrasRateGovernor'

const T0 = 1_000_000

describe('PiCerebrasRateGovernor', () => {
  it('dispatches the first window of slots immediately', () => {
    const governor = new PiCerebrasRateGovernor()
    for (let i = 0; i < PI_CEREBRAS_RPM_SLOTS; i++) {
      expect(governor.reserveDispatchSlot(T0 + i).waitMs).toBe(0)
    }
  })

  it('holds the slot after the window fills until the anchor ages out', () => {
    const governor = new PiCerebrasRateGovernor()
    for (let i = 0; i < PI_CEREBRAS_RPM_SLOTS; i++) governor.reserveDispatchSlot(T0)
    const { waitMs } = governor.reserveDispatchSlot(T0 + 1_000)
    expect(waitMs).toBe(PI_CEREBRAS_RATE_WINDOW_MS - 1_000)
  })

  it('serializes a concurrent ensemble stampede onto spaced future slots', () => {
    const governor = new PiCerebrasRateGovernor()
    const waits = Array.from({ length: 8 }, () => governor.reserveDispatchSlot(T0).waitMs)
    // First window immediate, later reservations strictly non-decreasing.
    expect(waits.slice(0, PI_CEREBRAS_RPM_SLOTS)).toEqual([0, 0, 0, 0])
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i]).toBeGreaterThanOrEqual(waits[i - 1])
    }
    // Slot 5 waits a full window behind the first batch.
    expect(waits[PI_CEREBRAS_RPM_SLOTS]).toBe(PI_CEREBRAS_RATE_WINDOW_MS)
    // Nothing ever parks longer than the cap.
    expect(Math.max(...waits)).toBeLessThanOrEqual(PI_CEREBRAS_MAX_HOLD_MS)
  })

  it('a 429 floors the next slot a full backoff window out', () => {
    const governor = new PiCerebrasRateGovernor()
    governor.reserveDispatchSlot(T0)
    governor.note429(T0 + 5_000)
    const { waitMs } = governor.reserveDispatchSlot(T0 + 10_000)
    expect(waitMs).toBe(PI_CEREBRAS_429_BACKOFF_MS - 5_000)
  })

  it('frees the window again once time passes', () => {
    const governor = new PiCerebrasRateGovernor()
    for (let i = 0; i < PI_CEREBRAS_RPM_SLOTS + 2; i++) governor.reserveDispatchSlot(T0)
    const later = T0 + PI_CEREBRAS_RATE_WINDOW_MS * 3
    expect(governor.reserveDispatchSlot(later).waitMs).toBe(0)
  })

  it('peekHoldMs previews without reserving', () => {
    const governor = new PiCerebrasRateGovernor()
    for (let i = 0; i < PI_CEREBRAS_RPM_SLOTS; i++) governor.reserveDispatchSlot(T0)
    const preview = governor.peekHoldMs(T0)
    expect(preview).toBe(PI_CEREBRAS_RATE_WINDOW_MS)
    // Preview twice — unchanged (no reservation was recorded).
    expect(governor.peekHoldMs(T0)).toBe(preview)
    // A real reservation after two peeks still lands on the same slot.
    expect(governor.reserveDispatchSlot(T0).waitMs).toBe(preview)
  })

  it('caps a pathological queue at the max hold', () => {
    const governor = new PiCerebrasRateGovernor()
    let last = 0
    for (let i = 0; i < 30; i++) last = governor.reserveDispatchSlot(T0).waitMs
    expect(last).toBe(PI_CEREBRAS_MAX_HOLD_MS)
  })
})
