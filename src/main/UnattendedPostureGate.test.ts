import { describe, expect, it, vi } from 'vitest'
import {
  buildUnattendedElevationAck,
  isUnattendedElevationAckCurrent,
  resolveUnattendedApprovalMode,
  unattendedElevationPresetId,
  UNATTENDED_SAFE_APPROVAL_MODE,
  type UnattendedElevationAck,
  type WorkflowForElevationAck
} from './UnattendedPostureGate'
import { signUnattendedElevation, verifyUnattendedElevation } from './UnattendedElevationSignature'

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

describe('unattendedElevationPresetId', () => {
  it('maps full_access → workspace_write, default → default, else undefined', () => {
    expect(unattendedElevationPresetId('full_access')).toBe('workspace_write')
    expect(unattendedElevationPresetId('default')).toBe('default')
    expect(unattendedElevationPresetId('safe')).toBeUndefined()
    expect(unattendedElevationPresetId('root')).toBeUndefined()
    expect(unattendedElevationPresetId(undefined)).toBeUndefined()
  })
})

describe('buildUnattendedElevationAck', () => {
  const wf: WorkflowForElevationAck = {
    id: 'wf-1',
    workspacePath: '/repo',
    template: { approvalMode: 'auto_edit' }
  }
  const fixedNow = (): string => '2026-06-24T12:00:00.000Z'

  it('returns undefined for level safe / unknown (revoke) and never signs', () => {
    const sign = vi.fn(() => 'sig')
    expect(buildUnattendedElevationAck(wf, 'safe', sign, fixedNow)).toBeUndefined()
    expect(buildUnattendedElevationAck(wf, 'nonsense', sign, fixedNow)).toBeUndefined()
    expect(sign).not.toHaveBeenCalled()
  })

  it('mints a signed ack for full_access with a SERVER-DERIVED mode', () => {
    const sign = vi.fn((tuple) => `sig:${tuple.level}:${tuple.acknowledgedApprovalMode}`)
    const built = buildUnattendedElevationAck(wf, 'full_access', sign, fixedNow)
    expect(built).toEqual({
      level: 'full_access',
      acknowledgedAt: '2026-06-24T12:00:00.000Z',
      acknowledgedApprovalMode: 'auto_edit', // from wf.template, not a caller arg
      signature: 'sig:full_access:auto_edit'
    })
    expect(sign).toHaveBeenCalledWith({
      workflowId: 'wf-1',
      workspacePath: '/repo',
      level: 'full_access',
      acknowledgedApprovalMode: 'auto_edit'
    })
  })

  it('takes acknowledgedApprovalMode from the workflow template, not the caller', () => {
    const built = buildUnattendedElevationAck(
      { ...wf, template: { approvalMode: 'default' } },
      'default',
      () => 'sig',
      fixedNow
    )
    expect(built?.acknowledgedApprovalMode).toBe('default')
  })
})

describe('resolveUnattendedElevation gate composition (verify AND current — both fail-closed)', () => {
  const SECRET = Buffer.from('ab'.repeat(32), 'hex')
  const tuple = {
    workflowId: 'wf-1',
    workspacePath: '/repo',
    level: 'full_access' as const,
    acknowledgedApprovalMode: 'auto_edit'
  }
  const goodAck: UnattendedElevationAck = {
    level: 'full_access',
    acknowledgedAt: '2026-06-24T00:00:00.000Z',
    acknowledgedApprovalMode: 'auto_edit',
    signature: signUnattendedElevation(SECRET, tuple)
  }
  // Mirror index.ts resolveUnattendedElevation: HMAC verify AND structural currency.
  const resolve = (ackUnderTest: UnattendedElevationAck, templateMode: string): boolean =>
    verifyUnattendedElevation(
      SECRET,
      { ...tuple, acknowledgedApprovalMode: ackUnderTest.acknowledgedApprovalMode },
      ackUnderTest.signature
    ) && isUnattendedElevationAckCurrent(ackUnderTest, templateMode)

  it('passes for an authentic, current ack', () => {
    expect(resolve(goodAck, 'auto_edit')).toBe(true)
  })

  it('FAILS on a tampered signature (HMAC verify false)', () => {
    expect(resolve({ ...goodAck, signature: 'deadbeef'.repeat(8) }, 'auto_edit')).toBe(false)
  })

  it('FAILS when the template mode changed since acking (stale → not current)', () => {
    // HMAC still verifies (tuple mode unchanged) but the currency check fails.
    expect(resolve(goodAck, 'default')).toBe(false)
  })
})
