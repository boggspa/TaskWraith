import { describe, expect, it } from 'vitest'
import { resolveStudioCompanionShouldRun } from './StudioCompanionSettings'

describe('resolveStudioCompanionShouldRun', () => {
  it('defaults on for the supported macOS product', () => {
    expect(resolveStudioCompanionShouldRun(undefined, undefined, 'darwin')).toEqual({
      shouldRun: true,
      supported: true,
      settingEnabled: true,
      envOverride: null,
      source: 'settings'
    })
  })

  it('honours the persisted setting and explicit environment overrides', () => {
    expect(resolveStudioCompanionShouldRun(false, undefined, 'darwin').shouldRun).toBe(false)
    expect(resolveStudioCompanionShouldRun(false, ' true ', 'darwin')).toMatchObject({
      shouldRun: true,
      settingEnabled: false,
      envOverride: 'force-on',
      source: 'environment'
    })
    expect(resolveStudioCompanionShouldRun(true, '0', 'darwin')).toMatchObject({
      shouldRun: false,
      settingEnabled: true,
      envOverride: 'force-off',
      source: 'environment'
    })
  })

  it('never launches the AppKit product on an unsupported platform', () => {
    expect(resolveStudioCompanionShouldRun(true, '1', 'linux')).toMatchObject({
      shouldRun: false,
      supported: false,
      envOverride: 'force-on',
      source: 'platform'
    })
  })
})
