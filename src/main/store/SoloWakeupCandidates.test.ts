import { describe, expect, it } from 'vitest'
import {
  countPendingSoloWakeups,
  selectSoloWakeupCandidateChatIds,
  type SoloWakeupCandidateSource
} from './SoloWakeupCandidates'

function source(overrides: Partial<SoloWakeupCandidateSource> = {}): SoloWakeupCandidateSource {
  return {
    vouchesForSourceBytes: () => true,
    readWakeupCount: () => 0,
    ...overrides
  }
}

describe('selectSoloWakeupCandidateChatIds', () => {
  it('skips a vouched chat with an explicit zero count', () => {
    expect(selectSoloWakeupCandidateChatIds(['a'], source())).toEqual([])
  })

  it('keeps a vouched chat with pending wakeups', () => {
    const candidates = selectSoloWakeupCandidateChatIds(['a'], source({ readWakeupCount: () => 2 }))
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat the index cannot vouch for', () => {
    const candidates = selectSoloWakeupCandidateChatIds(
      ['a'],
      source({ vouchesForSourceBytes: () => false })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat whose row predates the count field', () => {
    const candidates = selectSoloWakeupCandidateChatIds(
      ['a'],
      source({ readWakeupCount: () => null })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat whose count read throws', () => {
    const candidates = selectSoloWakeupCandidateChatIds(
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
    const candidates = selectSoloWakeupCandidateChatIds(
      ['a', '', 'b', 'c'],
      source({ readWakeupCount: (chatId) => (chatId === 'b' ? 0 : 1) })
    )
    expect(candidates).toEqual(['a', 'c'])
  })
})

describe('countPendingSoloWakeups', () => {
  it('counts only pending records', () => {
    expect(
      countPendingSoloWakeups({
        w1: { status: 'pending' },
        w2: { status: 'expired' },
        w3: { status: 'fired' }
      })
    ).toBe(1)
  })

  it('counts unreadable entries rather than silently skipping them', () => {
    expect(countPendingSoloWakeups({ w1: null, w2: 'garbage' })).toBe(2)
  })

  it('counts a missing or unreadable map as zero', () => {
    expect(countPendingSoloWakeups(undefined)).toBe(0)
    expect(countPendingSoloWakeups(null)).toBe(0)
    expect(countPendingSoloWakeups('garbage')).toBe(0)
  })
})
