import { describe, expect, it } from 'vitest'
import { mapBezelPointToWindow, mapScrollDelta } from './SimulatorGestureMap'

describe('mapBezelPointToWindow', () => {
  const bezelRect = { x: 100, y: 200, width: 200, height: 400 }
  const windowBounds = { x: 0, y: 0, width: 390, height: 844 }

  it('maps the bezel origin to the window origin', () => {
    expect(
      mapBezelPointToWindow({
        bezelRect,
        windowBounds,
        clientX: 100,
        clientY: 200
      })
    ).toEqual({ x: 0, y: 0 })
  })

  it('maps the bezel center proportionally', () => {
    expect(
      mapBezelPointToWindow({
        bezelRect,
        windowBounds,
        clientX: 200,
        clientY: 400
      })
    ).toEqual({ x: 195, y: 422 })
  })

  it('clamps points outside the bezel to the window edges', () => {
    expect(
      mapBezelPointToWindow({
        bezelRect,
        windowBounds,
        clientX: -50,
        clientY: 900
      })
    ).toEqual({ x: 0, y: 844 })
    expect(
      mapBezelPointToWindow({
        bezelRect,
        windowBounds,
        clientX: 500,
        clientY: 100
      })
    ).toEqual({ x: 390, y: 0 })
  })
})

describe('mapScrollDelta', () => {
  it('passes deltas through at scale 1', () => {
    expect(mapScrollDelta({ deltaX: 3, deltaY: -12 })).toEqual({ deltaX: 3, deltaY: -12 })
  })

  it('applies an optional scale', () => {
    expect(mapScrollDelta({ deltaX: 2, deltaY: 4, scale: 1.5 })).toEqual({
      deltaX: 3,
      deltaY: 6
    })
  })

  it('treats non-finite deltas as zero', () => {
    expect(mapScrollDelta({ deltaX: Number.NaN, deltaY: Number.POSITIVE_INFINITY })).toEqual({
      deltaX: 0,
      deltaY: 0
    })
  })
})
