import { describe, expect, it } from 'vitest'

import {
  APP_DRIVE_MODE,
  deriveAppDriveLifecycle,
  formatExpiry,
  formatStepsRemaining,
  formatVerbList,
  isAppDriveControlVerb,
  lifecycleActionAvailability,
  lifecycleStatusLabel,
  modeChipLabel,
  normalizeVirtualCursorPoint,
  permissionDisclosureLabel,
  sanitizeControlVerbs,
  targetPrimaryLabel,
  targetSecondaryLabel,
  type AppDriveDockControlView,
  type AppDriveDockTarget
} from './appDriveDockState'

const target: AppDriveDockTarget = {
  applicationName: 'Notes',
  windowTitle: 'Shopping',
  bundleID: 'com.apple.Notes'
}

const control: AppDriveDockControlView = {
  provider: 'codex',
  allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
  expiresAt: 1_700_000_900_000,
  stepBudget: 20,
  stepsUsed: 3,
  stepsRemaining: 17,
  approvedBy: 'user',
  trustState: 'user-approved'
}

describe('appDriveDockState', () => {
  it('labels the shipped mode as Foreground Drive only', () => {
    expect(APP_DRIVE_MODE).toBe('foreground')
    expect(modeChipLabel()).toBe('Foreground Drive')
    expect(modeChipLabel('foreground')).toBe('Foreground Drive')
  })

  it('discloses current-launch permission without durable app trust', () => {
    expect(permissionDisclosureLabel({ observation: null, control: null })).toBe('No attachment')
    expect(permissionDisclosureLabel({ observation: target, control: null })).toBe(
      'View only · Screen Watch'
    )
    expect(permissionDisclosureLabel({ observation: target, control })).toBe(
      'View & Control · current launch'
    )
  })

  it('derives lifecycle from observation/control and explicit session flags', () => {
    expect(deriveAppDriveLifecycle({ observation: null, control: null })).toBe('idle')
    expect(deriveAppDriveLifecycle({ observation: target, control: null })).toBe('viewing')
    expect(deriveAppDriveLifecycle({ observation: target, control })).toBe('driving')
    expect(deriveAppDriveLifecycle({ observation: target, control, paused: true })).toBe('paused')
    expect(deriveAppDriveLifecycle({ observation: target, control, takeover: true })).toBe(
      'takeover'
    )
    expect(
      deriveAppDriveLifecycle({ observation: target, control, paused: true, takeover: true })
    ).toBe('takeover')
    expect(deriveAppDriveLifecycle({ observation: target, control, stopped: true })).toBe('stopped')
  })

  it('exposes pause/resume/takeover/stop without implying target-scoped HID', () => {
    expect(lifecycleActionAvailability('driving')).toEqual({
      canPause: true,
      canResume: false,
      canTakeOver: true,
      canStop: true,
      agentActionsRefused: false
    })
    expect(lifecycleActionAvailability('paused').agentActionsRefused).toBe(true)
    expect(lifecycleActionAvailability('takeover')).toMatchObject({
      canResume: true,
      canTakeOver: false,
      agentActionsRefused: true
    })
    expect(lifecycleActionAvailability('idle').canStop).toBe(false)
    expect(lifecycleStatusLabel('takeover')).toBe('Takeover')
  })

  it('formats steps, expiry, verbs, and target labels for the dock chrome', () => {
    expect(formatStepsRemaining(null)).toBe('—')
    expect(formatStepsRemaining(control)).toBe('17 / 20')
    expect(formatExpiry(control.expiresAt, 1_700_000_000_000)).toBe('15m 00s')
    expect(formatExpiry(control.expiresAt, 1_700_000_900_000)).toBe('Expired')
    expect(formatExpiry(undefined)).toBe('—')
    expect(formatVerbList(control.allowedVerbs)).toBe('observe, inspect, click, fill')
    expect(formatVerbList([])).toBe('—')
    expect(targetPrimaryLabel(target)).toBe('Notes')
    expect(targetSecondaryLabel(target)).toBe('Shopping')
    expect(targetPrimaryLabel(null)).toBe('No target')
  })

  it('keeps the virtual cursor display-only and in-bounds', () => {
    expect(normalizeVirtualCursorPoint({ x: 0.25, y: 0.75, label: ' click ' })).toEqual({
      x: 0.25,
      y: 0.75,
      label: 'click'
    })
    expect(normalizeVirtualCursorPoint({ x: -0.1, y: 0.5 })).toBeNull()
    expect(normalizeVirtualCursorPoint({ x: 0.5, y: Number.NaN })).toBeNull()
    expect(normalizeVirtualCursorPoint(null)).toBeNull()
  })

  it('sanitizes control verbs without inventing authority', () => {
    expect(isAppDriveControlVerb('click')).toBe(true)
    expect(isAppDriveControlVerb('type')).toBe(false)
    expect(sanitizeControlVerbs(['observe', 'type', 'fill', 12])).toEqual(['observe', 'fill'])
    expect(sanitizeControlVerbs(null)).toEqual([])
  })
})
