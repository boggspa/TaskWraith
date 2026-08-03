import { describe, expect, it } from 'vitest'

import {
  APP_DRIVE_MODE,
  MODE_HONESTY_DESCRIPTION,
  PAUSE_VS_TAKEOVER_HELP,
  PERMISSION_HONESTY_DESCRIPTION,
  activityDisplayLabel,
  appDriveDockStatusFromNative,
  deriveAppDriveLifecycle,
  formatExpiry,
  formatStepsRemaining,
  formatVerbList,
  isAppDriveControlVerb,
  isAppDriveSessionLifecycle,
  lifecycleActionAvailability,
  lifecycleChangeAnnouncement,
  lifecycleStatusLabel,
  modeChipLabel,
  normalizeVirtualCursorPoint,
  permissionDisclosureLabel,
  sanitizeControlVerbs,
  stopControlLabel,
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
  it('maps the sanitized native control projection into dock state', () => {
    const dock = appDriveDockStatusFromNative('chat-1', {
      pickerPending: false,
      observation: {
        chatId: 'chat-1',
        generation: 2,
        attachedAt: '2026-08-03T20:00:00.000Z',
        window: {
          title: 'Shopping',
          bundleID: 'com.apple.Notes',
          applicationName: 'Notes',
          identityQuality: 'exact'
        }
      },
      control: {
        chatId: 'chat-1',
        runId: 'run-1',
        provider: 'codex',
        participantId: null,
        launchAttemptId: 'attempt-1',
        approvedAt: 1,
        approvedBy: 'user',
        trustState: 'user-approved',
        allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
        expiresAt: 100,
        stepBudget: 20,
        stepsUsed: 3,
        stepsRemaining: 17,
        mode: 'foreground',
        lifecycle: 'paused',
        canAdmitActions: false,
        virtualCursor: { x: 0.25, y: 0.75, label: 'Continue', verb: 'click' }
      }
    })
    expect(dock).toMatchObject({
      chatId: 'chat-1',
      lifecycle: 'paused',
      mode: 'foreground',
      observation: target,
      control: { stepsRemaining: 17 },
      virtualCursor: { x: 0.25, y: 0.75, label: 'Continue' }
    })
  })

  it('labels the shipped mode as Foreground Drive only', () => {
    expect(APP_DRIVE_MODE).toBe('foreground')
    expect(modeChipLabel()).toBe('Foreground Drive')
    expect(modeChipLabel('foreground')).toBe('Foreground Drive')
    expect(MODE_HONESTY_DESCRIPTION).toContain('frontmost')
    expect(MODE_HONESTY_DESCRIPTION).not.toMatch(/Background Drive is shipped/i)
  })

  it('discloses current-launch permission without durable app trust', () => {
    expect(permissionDisclosureLabel({ observation: null, control: null })).toBe('No attachment')
    expect(permissionDisclosureLabel({ observation: target, control: null })).toBe(
      'View only · Screen Watch'
    )
    expect(permissionDisclosureLabel({ observation: target, control })).toBe(
      'View & Control · current launch'
    )
    expect(PERMISSION_HONESTY_DESCRIPTION).toContain('current managed launch')
    expect(PERMISSION_HONESTY_DESCRIPTION).toContain('not durable app-keyed trust')
  })

  it('uses canonical lifecycle idle|active|paused|takeover|stopped only', () => {
    expect(isAppDriveSessionLifecycle('active')).toBe(true)
    expect(isAppDriveSessionLifecycle('viewing')).toBe(false)
    expect(isAppDriveSessionLifecycle('driving')).toBe(false)
    expect(deriveAppDriveLifecycle({ observation: null, control: null })).toBe('idle')
    expect(deriveAppDriveLifecycle({ observation: target, control: null })).toBe('active')
    expect(deriveAppDriveLifecycle({ observation: target, control })).toBe('active')
    expect(deriveAppDriveLifecycle({ observation: target, control, paused: true })).toBe('paused')
    expect(deriveAppDriveLifecycle({ observation: target, control, takeover: true })).toBe(
      'takeover'
    )
    expect(
      deriveAppDriveLifecycle({ observation: target, control, paused: true, takeover: true })
    ).toBe('takeover')
    expect(deriveAppDriveLifecycle({ observation: target, control, stopped: true })).toBe('stopped')
  })

  it('derives Viewing/Driving labels from observation/control, not lifecycle states', () => {
    expect(activityDisplayLabel({ lifecycle: 'active', observation: target, control: null })).toBe(
      'Viewing'
    )
    expect(activityDisplayLabel({ lifecycle: 'active', observation: target, control })).toBe(
      'Driving'
    )
    expect(activityDisplayLabel({ lifecycle: 'paused', observation: target, control })).toBeNull()
    expect(lifecycleStatusLabel('active', { observation: target, control: null })).toBe('Viewing')
    expect(lifecycleStatusLabel('active', { observation: target, control })).toBe('Driving')
    expect(lifecycleStatusLabel('paused')).toBe('Paused')
    expect(lifecycleStatusLabel('takeover')).toBe('Takeover')
  })

  it('exposes pause/resume/takeover/stop without implying target-scoped HID', () => {
    expect(lifecycleActionAvailability('active', { observation: target, control })).toEqual({
      canPause: true,
      canResume: false,
      canTakeOver: true,
      canStop: true,
      agentActionsRefused: false
    })
    expect(lifecycleActionAvailability('active', { observation: target, control: null })).toEqual({
      canPause: false,
      canResume: false,
      canTakeOver: false,
      canStop: true,
      agentActionsRefused: true
    })
    expect(lifecycleActionAvailability('paused').agentActionsRefused).toBe(true)
    expect(lifecycleActionAvailability('takeover')).toMatchObject({
      canResume: true,
      canTakeOver: false,
      agentActionsRefused: true
    })
    expect(lifecycleActionAvailability('idle').canStop).toBe(false)
    expect(PAUSE_VS_TAKEOVER_HELP).toContain('Pause holds agent')
    expect(PAUSE_VS_TAKEOVER_HELP).toContain('machine-wide')
  })

  it('uses context-specific Detach vs Stop control wording', () => {
    expect(stopControlLabel({ observation: target, control: null })).toBe('Detach')
    expect(stopControlLabel({ observation: target, control })).toBe('Stop control')
    expect(stopControlLabel({ observation: null, control: null })).toBe('Stop')
  })

  it('announces lifecycle changes for assistive tech', () => {
    expect(lifecycleChangeAnnouncement('paused')).toContain('paused')
    expect(lifecycleChangeAnnouncement('takeover')).toContain('Human takeover')
    expect(lifecycleChangeAnnouncement('active', { observation: target, control })).toContain(
      'driving'
    )
    expect(lifecycleChangeAnnouncement('active', { observation: target, control: null })).toContain(
      'viewing'
    )
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
