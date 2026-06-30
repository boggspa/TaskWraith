import { describe, expect, it } from 'vitest'
import { initialViewportWidth } from './useViewportWidth'

describe('initialViewportWidth', () => {
  it('uses the provided inner width when defined', () => {
    expect(initialViewportWidth(1440)).toBe(1440)
  })

  it('falls back to 1280 when inner width is undefined', () => {
    expect(initialViewportWidth(undefined)).toBe(1280)
  })
})