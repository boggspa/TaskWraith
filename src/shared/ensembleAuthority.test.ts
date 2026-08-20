import { describe, expect, it } from 'vitest'
import {
  ensembleAuthorityRoleLabel,
  legacyEnsembleAuthorityRole,
  MAX_ENSEMBLE_CAPTAINS,
  normalizeEnsembleAuthority,
  normalizeEnsembleAuthorityRole
} from './ensembleAuthority'

const participants = [
  { id: 'boss', order: 1, enabled: false },
  { id: 'captain-a', order: 2 },
  { id: 'captain-b', order: 3 },
  { id: 'captain-c', order: 4 },
  { id: 'captain-d', order: 5 },
  { id: 'background', order: 6, stageRole: 'background' }
]

describe('normalizeEnsembleAuthority', () => {
  it('keeps one configured Boss and at most three unique roster-ordered Captains', () => {
    const authority = normalizeEnsembleAuthority({
      participants,
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain-d', 'captain-b', 'captain-a', 'captain-b', 'captain-c'],
      secondInCommandParticipantId: 'background'
    })

    expect(MAX_ENSEMBLE_CAPTAINS).toBe(3)
    expect(authority).toEqual({
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain-a', 'captain-b', 'captain-c'],
      secondInCommandParticipantId: 'captain-a'
    })
  })

  it('treats a present canonical array as authoritative over the legacy scalar', () => {
    expect(
      normalizeEnsembleAuthority({
        participants,
        bossmanParticipantId: 'boss',
        captainParticipantIds: [],
        secondInCommandParticipantId: 'captain-a'
      }).captainParticipantIds
    ).toEqual([])
  })

  it('promotes a legacy scalar to a singleton compatibility array', () => {
    expect(
      normalizeEnsembleAuthority({
        participants,
        bossmanParticipantId: 'boss',
        secondInCommandParticipantId: 'captain-b'
      })
    ).toEqual({
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain-b'],
      secondInCommandParticipantId: 'captain-b'
    })
  })

  it('preserves a disabled configured Boss because availability is not configuration', () => {
    expect(
      normalizeEnsembleAuthority({
        participants,
        bossmanParticipantId: 'boss',
        captainParticipantIds: ['captain-a']
      }).bossmanParticipantId
    ).toBe('boss')
  })

  it('recovers the first foreground roster seat and removes it from Captains', () => {
    expect(
      normalizeEnsembleAuthority({
        participants: [
          { id: 'background', order: 1, stageRole: 'background' },
          { id: 'first', order: 2 },
          { id: 'second', order: 3 }
        ],
        bossmanParticipantId: 'missing',
        captainParticipantIds: ['first', 'second']
      })
    ).toEqual({
      bossmanParticipantId: 'first',
      captainParticipantIds: ['second'],
      secondInCommandParticipantId: 'second'
    })
  })

  it('recovers onto the first ENABLED foreground seat, skipping a disabled one', () => {
    expect(
      normalizeEnsembleAuthority({
        participants,
        captainParticipantIds: []
      }).bossmanParticipantId
    ).toBe('captain-a')
  })

  it('still recovers a Boss when every foreground seat is disabled', () => {
    expect(
      normalizeEnsembleAuthority({
        participants: [
          { id: 'first', order: 1, enabled: false },
          { id: 'second', order: 2, enabled: false }
        ],
        captainParticipantIds: []
      }).bossmanParticipantId
    ).toBe('first')
  })

  it('never manufactures authority when no foreground seat exists', () => {
    expect(
      normalizeEnsembleAuthority({
        participants: [{ id: 'background', order: 1, stageRole: 'background' }],
        bossmanParticipantId: 'background',
        captainParticipantIds: ['background']
      })
    ).toEqual({ captainParticipantIds: [] })
  })

  it('can validate without recovering a missing Boss', () => {
    expect(
      normalizeEnsembleAuthority({
        participants,
        bossmanParticipantId: 'missing',
        captainParticipantIds: ['captain-a'],
        recoverBoss: false
      })
    ).toEqual({
      captainParticipantIds: ['captain-a'],
      secondInCommandParticipantId: 'captain-a'
    })
  })
})

describe('canonical Ensemble authority roles', () => {
  it('normalizes the legacy second-in-command spelling at compatibility boundaries', () => {
    expect(normalizeEnsembleAuthorityRole('boss')).toBe('boss')
    expect(normalizeEnsembleAuthorityRole('captain')).toBe('captain')
    expect(normalizeEnsembleAuthorityRole('second_in_command')).toBe('captain')
    expect(normalizeEnsembleAuthorityRole('worker')).toBeUndefined()
  })

  it('round-trips canonical roles to legacy bossman-control spelling and labels', () => {
    expect(legacyEnsembleAuthorityRole('boss')).toBe('boss')
    expect(legacyEnsembleAuthorityRole('captain')).toBe('second_in_command')
    expect(ensembleAuthorityRoleLabel('boss')).toBe('Boss')
    expect(ensembleAuthorityRoleLabel('captain')).toBe('Captain')
  })
})
