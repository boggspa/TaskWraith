import { describe, expect, it, vi } from 'vitest'
import {
  selectEnsembleWakeupCandidateChatIds,
  type EnsembleWakeupCandidateSource
} from './EnsembleWakeupCandidates'

function source(
  overrides: Partial<EnsembleWakeupCandidateSource> = {}
): EnsembleWakeupCandidateSource {
  return {
    vouchesForSourceBytes: () => true,
    readWakeupCount: () => 0,
    ...overrides
  }
}

describe('selectEnsembleWakeupCandidateChatIds', () => {
  it('skips a vouched chat whose row counted no wakeups', () => {
    expect(selectEnsembleWakeupCandidateChatIds(['a'], source())).toEqual([])
  })

  it('keeps a vouched chat whose row counted a wakeup', () => {
    const candidates = selectEnsembleWakeupCandidateChatIds(
      ['a'],
      source({ readWakeupCount: () => 1 })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat the index cannot vouch for, without reading its count', () => {
    const readWakeupCount = vi.fn(() => 0)
    const candidates = selectEnsembleWakeupCandidateChatIds(
      ['a'],
      source({ vouchesForSourceBytes: () => false, readWakeupCount })
    )
    expect(candidates).toEqual(['a'])
    expect(readWakeupCount).not.toHaveBeenCalled()
  })

  it('keeps a chat whose row predates the count field', () => {
    // The load-bearing case: absence is unknown, never "no wakeups". A row
    // written before the field existed must still take the canonical read.
    const candidates = selectEnsembleWakeupCandidateChatIds(
      ['a'],
      source({ readWakeupCount: () => null })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat whose row read throws', () => {
    const candidates = selectEnsembleWakeupCandidateChatIds(
      ['a'],
      source({
        readWakeupCount: () => {
          throw new Error('unreadable')
        }
      })
    )
    expect(candidates).toEqual(['a'])
  })

  it('preserves the caller sweep order and drops empty ids', () => {
    const candidates = selectEnsembleWakeupCandidateChatIds(
      ['a', '', 'b', 'c'],
      source({ readWakeupCount: (chatId) => (chatId === 'b' ? 0 : 2) })
    )
    expect(candidates).toEqual(['a', 'c'])
  })
})
