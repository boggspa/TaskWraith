import { describe, expect, it } from 'vitest'
import { isAppDriveLeasedTool, resolveAppDriveSurfaceDescriptor } from './appDriveSurface'

describe('resolveAppDriveSurfaceDescriptor', () => {
  it('keeps the existing exact canvasId as the web surface grant key', () => {
    expect(
      resolveAppDriveSurfaceDescriptor('canvas_click', { canvasId: 'canvas-a' })
    ).toMatchObject({
      surfaceId: 'canvas-a',
      surfaceKind: 'web',
      target: { canvasId: 'canvas-a' },
      verb: 'click',
      allowedVerbs: ['click', 'fill', 'key', 'scroll', 'hover', 'select']
    })
  })

  it('binds simulator authority to the exact device and launched bundle', () => {
    const descriptor = resolveAppDriveSurfaceDescriptor(
      'simulator_tap',
      { udid: 'DEVICE-1' },
      { simulatorBundleId: 'com.example.App' }
    )
    expect(descriptor).toMatchObject({
      surfaceId: 'simulator:DEVICE-1:com.example.App',
      surfaceKind: 'simulator',
      target: { udid: 'DEVICE-1', bundleId: 'com.example.App' },
      verb: 'simulator_tap'
    })
  })

  it('classifies canvas_open(device) without treating ordinary web opens as leases', () => {
    expect(
      resolveAppDriveSurfaceDescriptor('canvas_open', {
        driver: 'device',
        udid: 'booted',
        bundleId: 'com.example.App'
      })
    ).toMatchObject({
      surfaceKind: 'simulator',
      verb: 'canvas_open_device'
    })
    expect(isAppDriveLeasedTool('canvas_open', { driver: 'web' })).toBe(false)
  })

  it('fails closed when a leased web action omits the target surface', () => {
    expect(resolveAppDriveSurfaceDescriptor('canvas_fill', {})).toBeNull()
  })
})
