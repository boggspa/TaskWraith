import { describe, it, expect } from 'vitest'
import {
  approvalModeRank,
  approvalElevationAckKey,
  decideApprovalElevation,
  decideFirstSendWorkspaceConsent,
  hasApprovalElevationAck,
  isApprovalElevation,
  withApprovalElevationAck
} from './approvalElevation'

describe('isApprovalElevation', () => {
  it('detects raises and ignores lowers / no-ops', () => {
    expect(isApprovalElevation('plan', 'default')).toBe(true)
    expect(isApprovalElevation('plan', 'auto_edit')).toBe(true)
    expect(isApprovalElevation('default', 'auto_edit')).toBe(true)
    expect(isApprovalElevation('auto_edit', 'default')).toBe(false)
    expect(isApprovalElevation('default', 'default')).toBe(false)
    expect(isApprovalElevation('auto_edit', 'plan')).toBe(false)
  })

  it('treats unknown modes as lowest risk', () => {
    expect(approvalModeRank('mystery')).toBe(0)
    expect(isApprovalElevation('mystery', 'default')).toBe(true)
    expect(isApprovalElevation('default', 'mystery')).toBe(false)
  })
})

describe('approvalElevationAckKey — workspace-only (owner directive 2026-08-05)', () => {
  it('keys by workspace alone; no provider component', () => {
    expect(approvalElevationAckKey('/w')).toBe('/w')
    expect(approvalElevationAckKey(null)).toBe('__global__')
    expect(approvalElevationAckKey('   ')).toBe('__global__')
  })
})

describe('hasApprovalElevationAck — new keys plus legacy workspace|provider rows', () => {
  it('matches the workspace-only key', () => {
    expect(hasApprovalElevationAck(new Set(['/w']), '/w')).toBe(true)
    expect(hasApprovalElevationAck(new Set(['/other']), '/w')).toBe(false)
  })

  it('a legacy per-provider ack proves the workspace was consented — auto-carries, no re-prompt', () => {
    expect(hasApprovalElevationAck(new Set(['/w|claude']), '/w')).toBe(true)
    expect(hasApprovalElevationAck(new Set(['/w|codex', '/x|grok']), '/w')).toBe(true)
    expect(hasApprovalElevationAck(new Set(['/x|grok']), '/w')).toBe(false)
    // a workspace whose path is a prefix of another must not leak acks
    expect(hasApprovalElevationAck(new Set(['/wide|claude']), '/w')).toBe(false)
  })
})

describe('decideApprovalElevation', () => {
  const empty: ReadonlySet<string> = new Set<string>()

  it('Tier 2 every time when raising to a write-capable provider mode (auto_edit)', () => {
    const d = decideApprovalElevation({
      from: 'default',
      to: 'auto_edit',
      workspacePath: '/w',
      acknowledgedDefault: empty
    })
    // Tier 2 still warns every time, but confirming it now ALSO records the
    // workspace consent so the milder Tier-1 never re-asks a workspace the
    // user already trusted at a sterner tier.
    expect(d).toEqual({ tier: 2, ackKey: '/w', persistAckOnConfirm: true })
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'auto_edit',
        workspacePath: '/w',
        acknowledgedDefault: empty
      })?.tier
    ).toBe(2)
  })

  it('Tier 2 is NOT suppressed by any ack set (warns on every elevation)', () => {
    expect(
      decideApprovalElevation({
        from: 'default',
        to: 'auto_edit',
        workspacePath: '/w',
        acknowledgedDefault: new Set(['/w', '/w|claude'])
      })?.tier
    ).toBe(2)
  })

  it('Tier 1 shows once per WORKSPACE when raising to Accept Edits', () => {
    const first = decideApprovalElevation({
      from: 'plan',
      to: 'default',
      workspacePath: '/w',
      acknowledgedDefault: empty
    })
    expect(first).toEqual({ tier: 1, ackKey: '/w', persistAckOnConfirm: true })
    const acked = withApprovalElevationAck(empty, first!.ackKey)
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'default',
        workspacePath: '/w',
        acknowledgedDefault: acked
      })
    ).toBeNull()
  })

  it('the ack covers EVERY provider/agent — a legacy single-provider ack silences the sheet', () => {
    // The regression this contract fixes: Antigravity re-prompted in a
    // workspace Codex had already acked.
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'default',
        workspacePath: '/w',
        acknowledgedDefault: new Set(['/w|codex'])
      })
    ).toBeNull()
  })

  it('de-escalations and unknown targets never warn', () => {
    expect(
      decideApprovalElevation({
        from: 'auto_edit',
        to: 'default',
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toBeNull()
    expect(
      decideApprovalElevation({
        from: 'plan',
        to: 'mystery',
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toBeNull()
  })
})

describe('decideFirstSendWorkspaceConsent — the one modal per workspace, on first prompt', () => {
  const empty: ReadonlySet<string> = new Set<string>()

  it('gates the first send of an edit-capable (default) run in a never-acked workspace', () => {
    expect(
      decideFirstSendWorkspaceConsent({
        approvalModes: ['default'],
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toEqual({ tier: 1, ackKey: '/w', persistAckOnConfirm: true })
  })

  it('an ensemble gates when ANY enabled seat runs at default', () => {
    expect(
      decideFirstSendWorkspaceConsent({
        approvalModes: ['plan', 'default', 'plan'],
        workspacePath: '/w',
        acknowledgedDefault: empty
      })?.tier
    ).toBe(1)
  })

  it('stays silent for read-only sends, acked workspaces, legacy acks, and write tiers', () => {
    // Plan/Ask rounds edit nothing — no consent moment.
    expect(
      decideFirstSendWorkspaceConsent({
        approvalModes: ['plan', 'plan'],
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toBeNull()
    expect(
      decideFirstSendWorkspaceConsent({
        approvalModes: ['default'],
        workspacePath: '/w',
        acknowledgedDefault: new Set(['/w'])
      })
    ).toBeNull()
    expect(
      decideFirstSendWorkspaceConsent({
        approvalModes: ['default'],
        workspacePath: '/w',
        acknowledgedDefault: new Set(['/w|antigravity'])
      })
    ).toBeNull()
    // Full WS Access / Full Access keep their own Tier-2 consent flow —
    // an auto_edit-only send never raises the workspace notice.
    expect(
      decideFirstSendWorkspaceConsent({
        approvalModes: ['auto_edit'],
        workspacePath: '/w',
        acknowledgedDefault: empty
      })
    ).toBeNull()
  })
})
