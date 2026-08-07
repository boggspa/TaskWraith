import { describe, expect, it } from 'vitest'
import { shouldAutoAllowAppshotsCapture } from './AppshotsCaptureAutoAllow'

describe('shouldAutoAllowAppshotsCapture', () => {
  it('auto-allows owned appshots under Accept Edits (default) posture', () => {
    expect(
      shouldAutoAllowAppshotsCapture({
        toolName: 'appshots',
        presetId: 'default',
        ownership: { allowed: true, reason: 'attached' }
      })
    ).toBe(true)
  })

  it('never auto-allows under Plan even when owned', () => {
    expect(
      shouldAutoAllowAppshotsCapture({
        toolName: 'appshots',
        presetId: 'plan',
        ownership: { allowed: true, reason: 'spawned' }
      })
    ).toBe(false)
  })

  it('never auto-allows under Ask (read_only) even when owned', () => {
    expect(
      shouldAutoAllowAppshotsCapture({
        toolName: 'appshots',
        presetId: 'read_only',
        ownership: { allowed: true, reason: 'launch' }
      })
    ).toBe(false)
  })

  it('does not auto-allow foreign targets', () => {
    expect(
      shouldAutoAllowAppshotsCapture({
        toolName: 'appshots',
        presetId: 'full_access',
        ownership: { allowed: false, reason: 'foreign' }
      })
    ).toBe(false)
  })

  it('does not auto-allow status tool via this predicate (name-set handles it)', () => {
    expect(
      shouldAutoAllowAppshotsCapture({
        toolName: 'appshots_status',
        presetId: 'default',
        ownership: { allowed: true, reason: 'attached' }
      })
    ).toBe(false)
  })

  it('rejects unknown tool names', () => {
    expect(
      shouldAutoAllowAppshotsCapture({
        toolName: 'attached_window_capture',
        presetId: 'default',
        ownership: { allowed: true, reason: 'attached' }
      })
    ).toBe(false)
  })
})
