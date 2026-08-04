import { describe, expect, it } from 'vitest'
import { resolveRosterUpdateBossmanAssignment } from './EnsembleRosterUpdate'

const participants = [{ id: 'claude' }, { id: 'codex' }, { id: 'kimi' }]
const autoApprovals = {
  enabled: true,
  mode: 'permission_preset_once' as const,
  confirmedAt: '2026-06-26T00:00:00.000Z'
}

describe('resolveRosterUpdateBossmanAssignment', () => {
  it('rejects a mutation that explicitly clears the sole Boss', () => {
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

    expect(result).toEqual({
      ok: false,
      error: 'Exactly one participant must be marked as Boss.'
    })
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
      captainParticipantIds: ['codex'],
      secondInCommandParticipantId: 'codex',
      bossmanAutoApprovals: { enabled: true }
    })
  })

  it('moves Captains to up to three true markers in roster order', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: true, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: true },
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
      captainParticipantIds: ['codex', 'kimi'],
      secondInCommandParticipantId: 'codex',
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
      captainParticipantIds: [],
      bossmanAutoApprovals: autoApprovals
    })
  })

  it('does not accept a Captain-only roster with no configured Boss', () => {
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
      ok: false,
      error: 'Exactly one participant must be marked as Boss.'
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
      captainParticipantIds: [],
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
      captainParticipantIds: [],
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

  it('allows three Captain markers', () => {
    const fourParticipants = [...participants, { id: 'grok' }]
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: true, isSecondInCommand: false },
        { isBossman: false, isSecondInCommand: true },
        { isBossman: false, isSecondInCommand: true },
        { isBossman: false, isSecondInCommand: true }
      ],
      fourParticipants,
      {}
    )

    expect(result).toEqual({
      ok: true,
      bossmanParticipantId: 'claude',
      captainParticipantIds: ['codex', 'kimi', 'grok'],
      secondInCommandParticipantId: 'codex'
    })
  })

  it('rejects a fourth Captain marker', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [
        { isBossman: true },
        { isSecondInCommand: true },
        { isSecondInCommand: true },
        { isSecondInCommand: true },
        { isSecondInCommand: true }
      ],
      [...participants, { id: 'grok' }, { id: 'ollama' }],
      {}
    )

    expect(result).toEqual({
      ok: false,
      error: 'Up to 3 participants may be marked as Captain.'
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

  it('rejects demoting the configured Boss to background without an atomic replacement', () => {
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
      ok: false,
      error:
        'Removing or demoting the configured Boss requires assigning its replacement in the same roster update.'
    })
  })
})
