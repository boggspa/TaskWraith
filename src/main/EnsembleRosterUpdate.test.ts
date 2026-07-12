import { describe, expect, it } from 'vitest'
import { resolveRosterUpdateBossmanAssignment } from './EnsembleRosterUpdate'

const participants = [{ id: 'claude' }, { id: 'codex' }, { id: 'kimi' }]
const autoApprovals = {
  enabled: true,
  mode: 'permission_preset_once' as const,
  confirmedAt: '2026-06-26T00:00:00.000Z'
}

describe('resolveRosterUpdateBossmanAssignment', () => {
  it('clears thread-wide auto approval consent only when all leadership markers are explicitly cleared', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: false, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: false }
      ],
      participants,
      {
        bossmanParticipantId: 'claude',
        secondInCommandParticipantId: 'codex',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toEqual({ ok: true })
  })

  it('preserves an existing Boss when a legacy roster omits the marker entirely', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [{}, {}, {}],
      participants,
      {
        bossmanParticipantId: 'claude',
        secondInCommandParticipantId: 'codex',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toMatchObject({
      ok: true,
      bossmanParticipantId: 'claude',
      secondInCommandParticipantId: 'codex',
      bossmanAutoApprovals: { enabled: true }
    })
  })

  it('moves Captain to the single true marker', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: true, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: true }
      ],
      participants,
      {
        bossmanParticipantId: 'claude',
        secondInCommandParticipantId: 'codex',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toEqual({
      ok: true,
      bossmanParticipantId: 'claude',
      secondInCommandParticipantId: 'kimi',
      bossmanAutoApprovals: autoApprovals
    })
  })

  it('keeps thread-global auto approval consent when Boss is reassigned', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [{ isBossman: false }, { isBossman: true }, { isBossman: false }],
      participants,
      {
        bossmanParticipantId: 'claude',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toEqual({
      ok: true,
      bossmanParticipantId: 'codex',
      bossmanAutoApprovals: autoApprovals
    })
  })

  it('keeps thread-global auto approval consent when only Captain remains', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: false, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: true },
        { isBossman: false, isSecondInCommand: false }
      ],
      participants,
      {
        bossmanParticipantId: 'claude',
        secondInCommandParticipantId: 'codex',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toEqual({
      ok: true,
      secondInCommandParticipantId: 'codex',
      bossmanAutoApprovals: autoApprovals
    })
  })

  it('normalizes a dual-marked participant to Boss without retaining a Captain overlap', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: true, isSecondInCommand: true },
        { isBossman: false, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: false }
      ],
      participants,
      {
        bossmanParticipantId: 'claude',
        secondInCommandParticipantId: 'codex',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toEqual({
      ok: true,
      bossmanParticipantId: 'claude',
      bossmanAutoApprovals: autoApprovals
    })
  })

  it('normalizes a legacy stored Boss/Captain overlap to Boss only', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [{}, {}, {}],
      participants,
      {
        bossmanParticipantId: 'claude',
        secondInCommandParticipantId: 'claude',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toEqual({
      ok: true,
      bossmanParticipantId: 'claude',
      bossmanAutoApprovals: autoApprovals
    })
  })

  it('rejects multiple Boss markers', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [{ isBossman: true }, { isBossman: true }, { isBossman: false }],
      participants,
      {}
    )

    expect(result).toEqual({
      ok: false,
      error: 'Only one participant may be marked as Boss.'
    })
  })

  it('rejects multiple Captain markers', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: false, isSecondInCommand: true },
        { isBossman: false, isSecondInCommand: true },
        { isBossman: false, isSecondInCommand: false }
      ],
      participants,
      {}
    )

    expect(result).toEqual({
      ok: false,
      error: 'Only one participant may be marked as Captain.'
    })
  })

  it('rejects assigning Boss or Captain authority to a background seat', () => {
    const backgroundParticipants = [
      { id: 'claude', stageRole: 'background' },
      { id: 'codex' }
    ]

    expect(
      resolveRosterUpdateBossmanAssignment(
        [{ isBossman: true }, { isBossman: false }],
        backgroundParticipants,
        {}
      )
    ).toEqual({
      ok: false,
      error: 'Background participants cannot be assigned as Boss or Captain.'
    })
    expect(
      resolveRosterUpdateBossmanAssignment(
        [{ isSecondInCommand: true }, { isSecondInCommand: false }],
        backgroundParticipants,
        {}
      )
    ).toEqual({
      ok: false,
      error: 'Background participants cannot be assigned as Boss or Captain.'
    })
  })

  it('drops preserved authority when its participant becomes background', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [{}, {}],
      [{ id: 'claude', stageRole: 'background' }, { id: 'codex' }],
      {
        bossmanParticipantId: 'claude',
        secondInCommandParticipantId: 'codex',
        bossmanAutoApprovals: autoApprovals
      }
    )

    expect(result).toEqual({
      ok: true,
      secondInCommandParticipantId: 'codex',
      bossmanAutoApprovals: autoApprovals
    })
  })
})
