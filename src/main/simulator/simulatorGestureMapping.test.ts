import { describe, expect, it } from 'vitest'
import {
  mapNormalizedScroll,
  mapNormalizedTap,
  toDevicePoint
} from './simulatorGestureMapping'

describe('simulatorGestureMapping', () => {
  it('maps normalized taps onto point extents (not raw PNG pixels)', () => {
    expect(mapNormalizedTap(0.5, 0.25, { pointWidth: 390, pointHeight: 844 })).toEqual({
      x: 195,
      y: 211
    })
    expect(toDevicePoint(1, 390)).toBe(390)
    expect(toDevicePoint(-0.2, 390)).toBe(0)
  })

  it('treats agent scroll deltas as point-space when pixel dims are omitted', () => {
    expect(
      mapNormalizedScroll(0.5, 0.5, 0, -80, { pointWidth: 390, pointHeight: 844 })
    ).toEqual({ startX: 195, startY: 422, endX: 195, endY: 502 })
  })

  it('scales human bezel scroll deltas from pixels into points', () => {
    expect(
      mapNormalizedScroll(0.5, 0.5, 0, -80, {
        pointWidth: 390,
        pointHeight: 844,
        pixelWidth: 780,
        pixelHeight: 1688
      })
    ).toEqual({ startX: 195, startY: 422, endX: 195, endY: 462 })
  })
})
