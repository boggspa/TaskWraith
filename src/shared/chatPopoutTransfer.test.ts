import { describe, expect, it } from 'vitest'

import {
  MAX_CHAT_POPOUT_ANCHOR_ID_LENGTH,
  MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES,
  normalizeChatPopoutRoundExpansion,
  normalizeChatPopoutScrollState
} from './chatPopoutTransfer'

describe('chat popout transfer normalization', () => {
  it('normalizes anchored scroll geometry without losing the anchor', () => {
    expect(
      normalizeChatPopoutScrollState({
        scrollTop: -2,
        scrollHeight: 100,
        clientHeight: 20,
        scrollRatio: 2,
        atBottom: 0,
        anchorMessageId: 'message-9',
        anchorOffset: -12.5
      })
    ).toEqual({
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 20,
      scrollRatio: 1,
      atBottom: false,
      anchorMessageId: 'message-9',
      anchorOffset: -12.5
    })
  })

  it('drops invalid anchors and rejects invalid geometry', () => {
    expect(
      normalizeChatPopoutScrollState({
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 20,
        scrollRatio: 0,
        atBottom: false,
        anchorMessageId: 'x'.repeat(MAX_CHAT_POPOUT_ANCHOR_ID_LENGTH + 1),
        anchorOffset: 'bad'
      })
    ).toEqual({
      scrollTop: 0,
      scrollHeight: 100,
      clientHeight: 20,
      scrollRatio: 0,
      atBottom: false
    })
    expect(normalizeChatPopoutScrollState({ scrollTop: 'bad' })).toBeUndefined()
  })

  it('keeps explicit empty disclosure and deduplicates valid entries', () => {
    expect(normalizeChatPopoutRoundExpansion([])).toEqual([])
    expect(
      normalizeChatPopoutRoundExpansion([
        { roundId: 'round-1', expanded: true },
        { roundId: '__proto__', expanded: false },
        { roundId: 'round-1', expanded: false },
        { roundId: '', expanded: true },
        { roundId: 'round-2', expanded: 'yes' }
      ])
    ).toEqual([
      { roundId: '__proto__', expanded: false },
      { roundId: 'round-1', expanded: false }
    ])
  })

  it('bounds disclosure entries and rejects wholly malformed payloads', () => {
    const oversized = Array.from(
      { length: MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES + 4 },
      (_, index) => ({ roundId: `round-${index}`, expanded: index % 2 === 0 })
    )
    expect(normalizeChatPopoutRoundExpansion(oversized)).toHaveLength(
      MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES
    )
    expect(normalizeChatPopoutRoundExpansion([{ roundId: '', expanded: 1 }])).toBeUndefined()
    expect(normalizeChatPopoutRoundExpansion({})).toBeUndefined()
  })
})
