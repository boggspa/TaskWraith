import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_SCROLL_MAX_DURATION_MS,
  TRANSCRIPT_SCROLL_MIN_DURATION_MS,
  easeInOutCubic,
  transcriptScrollDurationMs
} from './transcriptSmoothScroll'

describe('transcriptScrollDurationMs (glide duration curve)', () => {
  it('is zero for sub-pixel distances (instant path)', () => {
    expect(transcriptScrollDurationMs(0)).toBe(0)
    expect(transcriptScrollDurationMs(0.4)).toBe(0)
    expect(transcriptScrollDurationMs(-0.4)).toBe(0)
  })

  it('keeps tiny settle-corrections fast instead of a full-length glide', () => {
    expect(transcriptScrollDurationMs(5)).toBe(140)
    expect(transcriptScrollDurationMs(40)).toBe(280)
    expect(transcriptScrollDurationMs(5)).toBeLessThan(TRANSCRIPT_SCROLL_MIN_DURATION_MS)
  })

  it('floors ordinary jumps at the minimum and scales long hauls into the 1-2s band', () => {
    expect(transcriptScrollDurationMs(200)).toBe(TRANSCRIPT_SCROLL_MIN_DURATION_MS)
    expect(transcriptScrollDurationMs(2000)).toBe(1200)
    expect(transcriptScrollDurationMs(50_000)).toBe(TRANSCRIPT_SCROLL_MAX_DURATION_MS)
  })

  it('is symmetric in direction and monotonic non-decreasing in distance', () => {
    expect(transcriptScrollDurationMs(-2000)).toBe(transcriptScrollDurationMs(2000))
    let previous = 0
    for (const distance of [1, 10, 50, 95, 120, 300, 800, 2500, 10_000]) {
      const duration = transcriptScrollDurationMs(distance)
      expect(duration).toBeGreaterThanOrEqual(previous)
      previous = duration
    }
  })

  it('defends against non-finite input', () => {
    expect(transcriptScrollDurationMs(Number.NaN)).toBe(TRANSCRIPT_SCROLL_MIN_DURATION_MS)
    expect(transcriptScrollDurationMs(Number.POSITIVE_INFINITY)).toBe(
      TRANSCRIPT_SCROLL_MIN_DURATION_MS
    )
  })
})

describe('easeInOutCubic', () => {
  it('anchors the endpoints and centre', () => {
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10)
    expect(easeInOutCubic(1)).toBe(1)
  })

  it('is monotonic and clamps out-of-range input', () => {
    let previous = -1
    for (let i = 0; i <= 20; i++) {
      const value = easeInOutCubic(i / 20)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
    expect(easeInOutCubic(-2)).toBe(0)
    expect(easeInOutCubic(3)).toBe(1)
  })
})
