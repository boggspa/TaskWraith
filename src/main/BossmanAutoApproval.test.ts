import { describe, expect, it } from 'vitest'
import {
  evaluateBossmanAutoApproval,
  type BossmanAutoApprovalContext
} from './BossmanAutoApproval'

function makeContext(over: Partial<BossmanAutoApprovalContext> = {}): BossmanAutoApprovalContext {
  return {
    service: 'fileChanges',
    decision: 'ask',
    policy: 'ask',
    neverAutoAllow: false,
    readOnly: false,
    forcePrompt: false,
    hasExternalPathDetection: false,
    bossmanParticipantId: 'boss',
    autoApprovals: { enabled: true, mode: 'permission_preset_once', confirmedAt: '2026-06-24T00:00:00.000Z' },
    participantIds: ['boss', 'worker'],
    targetParticipantId: 'worker',
    targetProvider: 'codex',
    targetRole: 'Worker',
    roundId: 'round-1',
    ...over
  }
}

describe('evaluateBossmanAutoApproval', () => {
  it('auto-allows a preset-limited shell/file ask for a roster participant', () => {
    const result = evaluateBossmanAutoApproval(makeContext({ service: 'shellCommands' }))
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      mode: 'permission_preset_once',
      confirmedAt: '2026-06-24T00:00:00.000Z',
      bossmanParticipantId: 'boss',
      targetParticipantId: 'worker',
      targetProvider: 'codex',
      targetRole: 'Worker',
      roundId: 'round-1',
      actionClass: 'shellCommands'
    })
    expect(typeof (result as Record<string, unknown>).rationale).toBe('string')
  })

  // --- hard denies are never overridden ---------------------------------
  it('returns null on a hard policy deny (deny always wins)', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ decision: 'deny' }))).toBeNull()
  })

  it('returns null on an explicit allow (handled by the earlier grant branch)', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ decision: 'allow' }))).toBeNull()
  })

  // --- the documented hard guards ---------------------------------------
  it('never auto-allows a never-auto-allow service (canvasEval/RCE)', () => {
    expect(
      evaluateBossmanAutoApproval(makeContext({ service: 'canvasEval', neverAutoAllow: true }))
    ).toBeNull()
  })

  it('never widens a read-only run', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ readOnly: true }))).toBeNull()
  })

  it('never approves a forced prompt', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ forcePrompt: true }))).toBeNull()
  })

  it('never approves an external-path escape', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ hasExternalPathDetection: true }))).toBeNull()
  })

  it.each(['mcpTools', 'subThreadDelegation', 'canvasInteraction', 'crossThreadRead'] as const)(
    'never auto-allows the %s action class (only shell/file are in scope)',
    (service) => {
      expect(evaluateBossmanAutoApproval(makeContext({ service }))).toBeNull()
    }
  )

  // --- consent + roster membership --------------------------------------
  it('returns null when auto-approvals are not enabled', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({ autoApprovals: { enabled: false, mode: 'permission_preset_once', confirmedAt: 'x' } })
      )
    ).toBeNull()
    expect(evaluateBossmanAutoApproval(makeContext({ autoApprovals: undefined }))).toBeNull()
  })

  it('returns null for an unexpected auto-approval mode', () => {
    expect(
      evaluateBossmanAutoApproval(
        makeContext({ autoApprovals: { enabled: true, mode: 'session', confirmedAt: 'x' } })
      )
    ).toBeNull()
  })

  it('returns null when no Bossman is configured', () => {
    expect(evaluateBossmanAutoApproval(makeContext({ bossmanParticipantId: undefined }))).toBeNull()
  })

  it('returns null when the Bossman is no longer in the roster (stale id)', () => {
    expect(
      evaluateBossmanAutoApproval(makeContext({ participantIds: ['worker'] }))
    ).toBeNull()
  })

  it('returns null when the requesting participant is not in the roster (replaced/removed)', () => {
    expect(
      evaluateBossmanAutoApproval(makeContext({ participantIds: ['boss'], targetParticipantId: 'worker' }))
    ).toBeNull()
    expect(evaluateBossmanAutoApproval(makeContext({ targetParticipantId: undefined }))).toBeNull()
  })
})
