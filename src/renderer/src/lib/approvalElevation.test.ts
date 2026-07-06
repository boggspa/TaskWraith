import { describe, it, expect } from 'vitest'
import {
  isApprovalElevation,
  approvalElevationAckKey,
  decideApprovalElevation,
  withApprovalElevationAck
} from './approvalElevation'

describe('isApprovalElevation', () => {
  it('detects raises and ignores lowers / no-ops', () => {
    expect(isApprovalElevation('plan', 'default')).toBe(true)
    expect(isApprovalElevation('plan', 'auto_edit')).toBe(true)
    expect(isApprovalElevation('default', 'auto_edit')).toBe(true)
    expect(isApprovalElevation('auto_edit', 'default')).toBe(false)
    expect(isApprovalElevation('default', 'plan')).toBe(false)
    expect(isApprovalElevation('default', 'default')).toBe(false)
  })

  it('treats unknown modes as lowest risk', () => {
    expect(isApprovalElevation('mystery', 'default')).toBe(true)
    expect(isApprovalElevation('auto_edit', 'mystery')).toBe(false)
  })
})

describe('decideApprovalElevation', () => {
  const empty: ReadonlySet<string> = new Set<string>()

  it('Tier 2 every time when raising to a write-capable provider mode (auto_edit)', () => {
    const d = decideApprovalElevation({
      from: 'default',
      to: 'auto_edit',
      provider: 'claude',
      workspacePath: '/w',
      acknowledgedDefault: empty
    })
    expect(d).toEqual({ tier: 2, ackKey: '/w|claude', persistAckOnConfirm: false })
    // a direct plan → auto_edit jump is also Tier 2
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'auto_edit',
        provider: 'claude',
        workspacePath: '/w',
        acknowledgedDefault: empty
      })?.tier
    ).toBe(2)
  })

  it('Tier 2 is NOT suppressed by any ack set (warns on every elevation)', () => {
    const acks = new Set(['/w|claude'])
    expect(
      decideApprovalElevation({
        from: 'default',
        to: 'auto_edit',
        provider: 'claude',
        workspacePath: '/w',
        acknowledgedDefault: acks
      })?.tier
    ).toBe(2)
  })

  it('Tier 1 shows once per (workspace, provider) when raising to Default', () => {
    const first = decideApprovalElevation({
      from: 'plan',
      to: 'default',
      provider: 'claude',
      workspacePath: '/w',
      acknowledgedDefault: empty
    })
    expect(first).toEqual({ tier: 1, ackKey: '/w|claude', persistAckOnConfirm: true })
    const acked = withApprovalElevationAck(empty, first!.ackKey)
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'default',
        provider: 'claude',
        workspacePath: '/w',
        acknowledgedDefault: acked
      })
    ).toBeNull()
  })

  it('Tier 1 ack is scoped per workspace AND per provider', () => {
    const acks = new Set(['/w|claude'])
    // same workspace, different provider → still warns
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'default',
        provider: 'codex',
        workspacePath: '/w',
        acknowledgedDefault: acks
      })?.tier
    ).toBe(1)
    // different workspace, same provider → still warns
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'default',
        provider: 'claude',
        workspacePath: '/other',
        acknowledgedDefault: acks
      })?.tier
    ).toBe(1)
    // same both → suppressed
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'default',
        provider: 'claude',
        workspacePath: '/w',
        acknowledgedDefault: acks
      })
    ).toBeNull()
  })

  it('never warns on de-escalation or a no-op', () => {
    expect(
      decideApprovalElevation({
        from: 'auto_edit',
        to: 'default',
        provider: 'claude',
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toBeNull()
    expect(
      decideApprovalElevation({
        from: 'default',
        to: 'plan',
        provider: 'claude',
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toBeNull()
    expect(
      decideApprovalElevation({
        from: 'default',
        to: 'default',
        provider: 'claude',
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toBeNull()
  })

  it('falls back to a global key when the workspace is null/blank', () => {
    expect(approvalElevationAckKey(null, 'claude')).toBe('__global__|claude')
    expect(approvalElevationAckKey('  ', 'claude')).toBe('__global__|claude')
    const d = decideApprovalElevation({
      from: 'plan',
      to: 'default',
      provider: 'claude',
      workspacePath: null,
      acknowledgedDefault: empty
    })
    expect(d?.ackKey).toBe('__global__|claude')
  })
})
