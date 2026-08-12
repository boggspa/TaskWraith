import { describe, expect, it } from 'vitest'
import {
  STUDIO_TIME_ZERO,
  StudioTimeError,
  isStudioRationalTime,
  studioTimeAdd,
  studioTimeCompare,
  studioTimeEquals,
  studioTimeFromWire,
  studioTimeIsFrameAligned,
  studioTimeSub
} from './StudioRationalTime'

describe('StudioRationalTime', () => {
  it('normalises wire values to lowest terms', () => {
    expect(studioTimeFromWire({ n: 500, d: 1000 })).toEqual({ n: 1, d: 2 })
    expect(studioTimeFromWire({ n: 0, d: 48000 })).toEqual({ n: 0, d: 1 })
    expect(studioTimeFromWire({ n: -1500, d: 1000 })).toEqual({ n: -3, d: 2 })
  })

  it('rejects malformed wire values with a typed error', () => {
    const malformed = [
      null,
      7,
      'time',
      { n: 1.5, d: 2 },
      { n: 1, d: 0 },
      { n: 1, d: -25 },
      { n: 1 }
    ]
    for (const bad of malformed) {
      expect(() => studioTimeFromWire(bad)).toThrowError(StudioTimeError)
    }
    expect(isStudioRationalTime({ n: 1, d: 25 })).toBe(true)
    expect(isStudioRationalTime({ n: 1, d: -25 })).toBe(false)
  })

  it('compares across different timescales exactly', () => {
    expect(studioTimeCompare({ n: 1, d: 2 }, { n: 500, d: 1000 })).toBe(0)
    expect(studioTimeCompare({ n: 1001, d: 30000 }, { n: 1, d: 25 })).toBe(-1)
    expect(studioTimeCompare({ n: 1, d: 24 }, { n: 1, d: 25 })).toBe(1)
    expect(studioTimeEquals(STUDIO_TIME_ZERO, { n: 0, d: 90000 })).toBe(true)
  })

  it('accumulates NTSC frame durations without drift', () => {
    const frameDuration = { n: 1001, d: 30000 }
    let elapsed = STUDIO_TIME_ZERO
    for (let frame = 0; frame < 30000; frame += 1) {
      elapsed = studioTimeAdd(elapsed, frameDuration)
    }
    expect(elapsed).toEqual({ n: 1001, d: 1 })
  })

  it('adds tenths exactly where binary floats drift', () => {
    const tenth = { n: 1, d: 10 }
    const sum = studioTimeAdd(studioTimeAdd(tenth, tenth), tenth)
    expect(sum).toEqual({ n: 3, d: 10 })
    expect(0.1 + 0.1 + 0.1).not.toBe(0.3)
  })

  it('subtracts into negative deltas', () => {
    expect(studioTimeSub({ n: 1, d: 2 }, { n: 3, d: 4 })).toEqual({ n: -1, d: 4 })
  })

  it('raises a typed error instead of rounding when a result is unrepresentable', () => {
    const huge = { n: Number.MAX_SAFE_INTEGER, d: 1 }
    expect(() => studioTimeAdd(huge, { n: 1, d: 3 })).toThrowError(StudioTimeError)
    try {
      studioTimeAdd(huge, { n: 1, d: 3 })
    } catch (error) {
      expect((error as StudioTimeError).code).toBe('unrepresentable_time')
    }
  })

  it('detects frame alignment for NTSC and integer rates', () => {
    const ntsc = { n: 30000, d: 1001 }
    expect(studioTimeIsFrameAligned({ n: 1001, d: 30000 }, ntsc)).toBe(true)
    expect(studioTimeIsFrameAligned({ n: 7007, d: 30000 }, ntsc)).toBe(true)
    expect(studioTimeIsFrameAligned({ n: 1000, d: 30000 }, ntsc)).toBe(false)
    expect(studioTimeIsFrameAligned({ n: 1, d: 25 }, { n: 25, d: 1 })).toBe(true)
    expect(studioTimeIsFrameAligned({ n: 1, d: 50 }, { n: 25, d: 1 })).toBe(false)
    expect(studioTimeIsFrameAligned(STUDIO_TIME_ZERO, ntsc)).toBe(true)
  })
})
