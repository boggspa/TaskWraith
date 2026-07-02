import { describe, expect, it } from 'vitest'
import { resolveRosterUpdateBossmanAssignment } from './EnsembleRosterUpdate'

const participants = [{ id: 'claude' }, { id: 'codex' }, { id: 'kimi' }]

describe('resolveRosterUpdateBossmanAssignment', () => {
  it('clears an existing Boss when the roster explicitly sends all false markers', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [{ isBossman: false }, { isBossman: false }, { isBossman: false }],
      participants,
      {
        bossmanParticipantId: 'claude',
        bossmanAutoApprovals: {
          enabled: true,
          mode: 'permission_preset_once' as const,
          confirmedAt: '2026-06-26T00:00:00.000Z'
        }
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
        bossmanAutoApprovals: {
          enabled: true,
          mode: 'permission_preset_once' as const,
          confirmedAt: '2026-06-26T00:00:00.000Z'
        }
      }
    )

    expect(result).toMatchObject({
      ok: true,
      bossmanParticipantId: 'claude',
      secondInCommandParticipantId: 'codex',
      bossmanAutoApprovals: { enabled: true }
    })
  })

  it('moves second-in-command to the single true marker', () => {
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
        bossmanAutoApprovals: {
          enabled: true,
          mode: 'permission_preset_once' as const,
          confirmedAt: '2026-06-26T00:00:00.000Z'
        }
      }
    )

    expect(result).toEqual({
      ok: true,
      bossmanParticipantId: 'claude',
      secondInCommandParticipantId: 'kimi',
      bossmanAutoApprovals: {
        enabled: true,
        mode: 'permission_preset_once',
        confirmedAt: '2026-06-26T00:00:00.000Z'
      }
    })
  })

  it('moves Boss to the single true marker and drops stale auto-approval consent', () => {
    const result = resolveRosterUpdateBossmanAssignment(
      [{ isBossman: false }, { isBossman: true }, { isBossman: false }],
      participants,
      {
        bossmanParticipantId: 'claude',
        bossmanAutoApprovals: {
          enabled: true,
          mode: 'permission_preset_once' as const,
          confirmedAt: '2026-06-26T00:00:00.000Z'
        }
      }
    )

    expect(result).toEqual({
      ok: true,
      bossmanParticipantId: 'codex',
      bossmanAutoApprovals: undefined
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

  it('rejects multiple second-in-command markers', () => {
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
      error: 'Only one participant may be marked as second-in-command.'
    })
  })
})
