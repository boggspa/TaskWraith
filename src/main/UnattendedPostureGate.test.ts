import { describe, expect, it } from 'vitest'
import {
  isUnattendedElevationAckCurrent,
  resolveUnattendedApprovalMode,
  UNATTENDED_SAFE_APPROVAL_MODE,
  type UnattendedElevationAck
} from './UnattendedPostureGate'

const ack = (over: Partial<UnattendedElevationAck> = {}): UnattendedElevationAck => ({
  level: 'full_access',
  acknowledgedAt: '2026-06-24T00:00:00.000Z',
  acknowledgedApprovalMode: 'auto_edit',
  ...over
})

describe('resolveUnattendedApprovalMode', () => {
  it('fail-closes to plan with NO ack, regardless of the requested mode', () => {
    expect(resolveUnattendedApprovalMode(undefined, 'auto_edit')).toBe('plan')
    expect(resolveUnattendedApprovalMode(undefined, 'default')).toBe('plan')
    expect(resolveUnattendedApprovalMode(undefined, undefined)).toBe('plan')
    expect(UNATTENDED_SAFE_APPROVAL_MODE).toBe('plan')
  })

  it('treats a safe-level ack as no elevation', () => {
    expect(resolveUnattendedApprovalMode(ack({ level: 'safe' }), 'auto_edit')).toBe('plan')
  })

  it('fail-closes to plan for an unknown/malformed level', () => {
    expect(
      resolveUnattendedApprovalMode(ack({ level: 'root' as unknown as 'safe' }), 'auto_edit')
    ).toBe('plan')
  })

  it("level 'default' caps an over-elevated request down to default", () => {
    expect(resolveUnattendedApprovalMode(ack({ level: 'default' }), 'auto_edit')).toBe('default')
    expect(resolveUnattendedApprovalMode(ack({ level: 'default' }), 'default')).toBe('default')
  })

  it("level 'full_access' authorizes auto_edit but NEVER raises a lower request", () => {
    expect(resolveUnattendedApprovalMode(ack({ level: 'full_access' }), 'auto_edit')).toBe(
      'auto_edit'
    )
    // never-raise: a plan/default request stays where it is even under full_access
    expect(resolveUnattendedApprovalMode(ack({ level: 'full_access' }), 'plan')).toBe('plan')
    expect(resolveUnattendedApprovalMode(ack({ level: 'full_access' }), 'default')).toBe('default')
  })

  it('collapses an unrecognized requested mode to default before capping', () => {
    expect(resolveUnattendedApprovalMode(ack({ level: 'full_access' }), 'yolo')).toBe('default')
    expect(resolveUnattendedApprovalMode(ack({ level: 'default' }), 'yolo')).toBe('default')
  })
})

describe('isUnattendedElevationAckCurrent', () => {
  it('is false with no ack or a safe-level ack', () => {
    expect(isUnattendedElevationAckCurrent(undefined, 'auto_edit')).toBe(false)
    expect(isUnattendedElevationAckCurrent(ack({ level: 'safe' }), 'plan')).toBe(false)
  })

  it('is true when the ack was confirmed against the current template mode and covers it', () => {
    expect(
      isUnattendedElevationAckCurrent(
        ack({ level: 'full_access', acknowledgedApprovalMode: 'auto_edit' }),
        'auto_edit'
      )
    ).toBe(true)
    expect(
      isUnattendedElevationAckCurrent(
        ack({ level: 'default', acknowledgedApprovalMode: 'default' }),
        'default'
      )
    ).toBe(true)
  })

  it('is STALE (false) when the template mode changed after acking', () => {
    expect(
      isUnattendedElevationAckCurrent(
        ack({ level: 'full_access', acknowledgedApprovalMode: 'auto_edit' }),
        'plan'
      )
    ).toBe(false)
  })

  it("is false when the ack's level does not cover the template mode", () => {
    // confirmed for 'default' but the template is now auto_edit → does not cover
    expect(
      isUnattendedElevationAckCurrent(
        ack({ level: 'default', acknowledgedApprovalMode: 'auto_edit' }),
        'auto_edit'
      )
    ).toBe(false)
  })
})
