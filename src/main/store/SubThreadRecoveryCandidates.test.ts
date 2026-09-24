import { describe, expect, it } from 'vitest'
import {
  selectSubThreadRecoveryCandidateChatIds,
  type SubThreadRecoveryCandidateSource,
  type SubThreadRecoveryHint
} from './SubThreadRecoveryCandidates'

function hint(overrides: Partial<SubThreadRecoveryHint> = {}): SubThreadRecoveryHint {
  return {
    parentChatId: null,
    hasWorkerControl: false,
    hasJoinPolicy: false,
    ...overrides
  }
}

function source(
  overrides: Partial<SubThreadRecoveryCandidateSource> = {}
): SubThreadRecoveryCandidateSource {
  return {
    vouchesForSourceBytes: () => true,
    readRecoveryHint: () => hint(),
    ...overrides
  }
}

describe('selectSubThreadRecoveryCandidateChatIds', () => {
  it('skips a vouched chat that is not a sub-thread', () => {
    expect(selectSubThreadRecoveryCandidateChatIds(['a'], source())).toEqual([])
  })

  it('skips a vouched sub-thread with neither worker control nor a join policy', () => {
    const candidates = selectSubThreadRecoveryCandidateChatIds(
      ['a'],
      source({ readRecoveryHint: () => hint({ parentChatId: 'parent' }) })
    )
    expect(candidates).toEqual([])
  })

  it('keeps a vouched sub-thread with worker control', () => {
    const candidates = selectSubThreadRecoveryCandidateChatIds(
      ['a'],
      source({ readRecoveryHint: () => hint({ parentChatId: 'parent', hasWorkerControl: true }) })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a vouched sub-thread with only a join policy', () => {
    const candidates = selectSubThreadRecoveryCandidateChatIds(
      ['a'],
      source({ readRecoveryHint: () => hint({ parentChatId: 'parent', hasJoinPolicy: true }) })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat the index cannot vouch for', () => {
    const candidates = selectSubThreadRecoveryCandidateChatIds(
      ['a'],
      source({ vouchesForSourceBytes: () => false })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat whose hint is missing or throws', () => {
    expect(
      selectSubThreadRecoveryCandidateChatIds(['a'], source({ readRecoveryHint: () => null }))
    ).toEqual(['a'])
    expect(
      selectSubThreadRecoveryCandidateChatIds(
        ['a'],
        source({
          readRecoveryHint: () => {
            throw new Error('unreadable')
          }
        })
      )
    ).toEqual(['a'])
  })

  it('preserves the caller sweep order and drops empty ids', () => {
    const candidates = selectSubThreadRecoveryCandidateChatIds(
      ['a', '', 'b', 'c'],
      source({
        readRecoveryHint: (chatId) =>
          chatId === 'b' ? hint() : hint({ parentChatId: 'parent', hasWorkerControl: true })
      })
    )
    expect(candidates).toEqual(['a', 'c'])
  })
})
