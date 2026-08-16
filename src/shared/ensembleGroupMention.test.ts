import { describe, expect, it } from 'vitest'
import {
  ENSEMBLE_GROUP_MENTIONS,
  ensembleGroupMentionMatchesStage,
  resolveEnsembleGroupMentionToken
} from './ensembleGroupMention'

describe('Ensemble group mentions', () => {
  it('defines the five provider-neutral public tokens', () => {
    expect(ENSEMBLE_GROUP_MENTIONS.map((definition) => definition.token)).toEqual([
      '@All',
      '@Scouts',
      '@Workers',
      '@Reviewers',
      '@BG'
    ])
  })

  it('resolves case and trailing sentence punctuation without widening aliases', () => {
    expect(resolveEnsembleGroupMentionToken('@SCOUTS,')?.id).toBe('scouts')
    expect(resolveEnsembleGroupMentionToken('bg.')?.id).toBe('backgrounds')
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
  })
})
