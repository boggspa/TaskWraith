import { describe, expect, it } from 'vitest'
import {
  ENSEMBLE_GROUP_MENTIONS,
  ensembleGroupMentionMatchesStage,
  isEnsembleAuthorityGroupMention,
  resolveEnsembleGroupMentionParticipantIds,
  resolveEnsembleGroupMentionToken
} from './ensembleGroupMention'

describe('Ensemble group mentions', () => {
  it('defines the seven provider-neutral public tokens', () => {
    expect(ENSEMBLE_GROUP_MENTIONS.map((definition) => definition.token)).toEqual([
      '@All',
      '@Captains',
      '@Management',
      '@Scouts',
      '@Workers',
      '@Reviewers',
      '@BG'
    ])
  })

  it('resolves case and trailing sentence punctuation without widening aliases', () => {
    expect(resolveEnsembleGroupMentionToken('@SCOUTS,')?.id).toBe('scouts')
    expect(resolveEnsembleGroupMentionToken('@MANAGEMENT!')?.id).toBe('management')
    expect(resolveEnsembleGroupMentionToken('bg.')?.id).toBe('backgrounds')
    expect(resolveEnsembleGroupMentionToken('@Captain')).toBeNull()
    expect(resolveEnsembleGroupMentionToken('@Manager')).toBeNull()
    expect(resolveEnsembleGroupMentionToken('@Background')).toBeNull()
    expect(resolveEnsembleGroupMentionToken('@Scout')).toBeNull()
  })

  it('matches @All across typed and untyped seats', () => {
    expect(ensembleGroupMentionMatchesStage('all', undefined)).toBe(true)
    expect(ensembleGroupMentionMatchesStage('all', 'background')).toBe(true)
  })

  it('keeps stage groups exact', () => {
    expect(ensembleGroupMentionMatchesStage('workers', 'worker')).toBe(true)
    expect(ensembleGroupMentionMatchesStage('workers', 'reviewer')).toBe(false)
    expect(ensembleGroupMentionMatchesStage('backgrounds', 'background')).toBe(true)
    expect(ensembleGroupMentionMatchesStage('backgrounds', undefined)).toBe(false)
    expect(ensembleGroupMentionMatchesStage('captains', 'worker')).toBe(false)
    expect(ensembleGroupMentionMatchesStage('management', undefined)).toBe(false)
  })

  it('matches configured enabled authority ids without trusting display roles', () => {
    const participants = [
      { id: 'boss', enabled: true, order: 1, stageRole: 'worker', role: 'Arbitrary' },
      { id: 'captain-a', enabled: true, order: 2, stageRole: 'reviewer', role: 'Analyst' },
      { id: 'captain-disabled', enabled: false, order: 3, role: 'Captain' },
      { id: 'role-only', enabled: true, order: 4, role: 'Management' },
      { id: 'background', enabled: true, order: 5, stageRole: 'background', role: 'Captain' }
    ]
    const authority = {
      bossmanParticipantId: 'boss',
      captainParticipantIds: ['captain-disabled', 'captain-a', 'boss', 'background']
    }

    expect([
      ...resolveEnsembleGroupMentionParticipantIds({ group: 'captains', participants, authority })
    ]).toEqual(['captain-a'])
    expect([
      ...resolveEnsembleGroupMentionParticipantIds({ group: 'management', participants, authority })
    ]).toEqual(['boss', 'captain-a'])
    expect(isEnsembleAuthorityGroupMention('captains')).toBe(true)
    expect(isEnsembleAuthorityGroupMention('management')).toBe(true)
    expect(isEnsembleAuthorityGroupMention('workers')).toBe(false)
  })

  it('honours legacy Captain storage, explicit empty arrays, and no Boss recovery', () => {
    const participants = [
      { id: 'first', enabled: true, order: 1 },
      { id: 'legacy-captain', enabled: true, order: 2 }
    ]

    expect([
      ...resolveEnsembleGroupMentionParticipantIds({
        group: 'management',
        participants,
        authority: { secondInCommandParticipantId: 'legacy-captain' }
      })
    ]).toEqual(['legacy-captain'])
    expect([
      ...resolveEnsembleGroupMentionParticipantIds({
        group: 'captains',
        participants,
        authority: {
          captainParticipantIds: [],
          secondInCommandParticipantId: 'legacy-captain'
        }
      })
    ]).toEqual([])
  })
})
