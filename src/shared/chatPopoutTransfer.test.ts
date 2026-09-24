import { describe, expect, it } from 'vitest'

import {
  MAX_CHAT_POPOUT_ANCHOR_ID_LENGTH,
  MAX_CHAT_POPOUT_ROUND_EXPANSION_ENTRIES,
  normalizeChatPopoutRoundExpansion,
  normalizeChatPopoutScrollState,
  normalizeTranscriptViewOverride,
  normalizeTranscriptViewOverrideTransfer
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

describe('transcript view override transfer normalization', () => {
  it('narrows each real view and leaves absence absent', () => {
    // Positive control first: all three real views survive, so the
    // `toBeUndefined` assertions below cannot be passing because the function
    // rejects everything.
    expect(normalizeTranscriptViewOverride('minimal')).toBe('minimal')
    expect(normalizeTranscriptViewOverride('tools')).toBe('tools')
    expect(normalizeTranscriptViewOverride('standard')).toBe('standard')

    expect(normalizeTranscriptViewOverride(undefined)).toBeUndefined()
    expect(normalizeTranscriptViewOverride(null)).toBeUndefined()
    expect(normalizeTranscriptViewOverride('')).toBeUndefined()
    expect(normalizeTranscriptViewOverride('compact')).toBeUndefined()
    expect(normalizeTranscriptViewOverride(7)).toBeUndefined()
    expect(normalizeTranscriptViewOverride({ view: 'minimal' })).toBeUndefined()
  })

  it('never turns an absent override into a standard pin', () => {
    // The whole point of the slice. `resolveTranscriptView` is total and would
    // answer 'standard' for every one of these, converting "this chat carried
    // no override" into an explicit pin that beats a later Appearance default.
    for (const absent of [undefined, null, '', 'nonsense', 0, false, []]) {
      expect(normalizeTranscriptViewOverride(absent)).not.toBe('standard')
      expect(normalizeTranscriptViewOverride(absent)).toBeUndefined()
    }
    // ...while a DELIBERATE standard pin is still carried, which is what makes
    // the assertion above about absence rather than about the value 'standard'.
    expect(normalizeTranscriptViewOverride('standard')).toBe('standard')
  })

  it('keeps the dock leg tri-state, with null distinct from undefined', () => {
    expect(normalizeTranscriptViewOverrideTransfer('minimal')).toBe('minimal')
    expect(normalizeTranscriptViewOverrideTransfer('tools')).toBe('tools')
    expect(normalizeTranscriptViewOverrideTransfer('standard')).toBe('standard')

    // Both are falsy, so assert the exact values: collapsing them would make a
    // popout on "Follow default" unable to clear the main window's pin.
    expect(normalizeTranscriptViewOverrideTransfer(null)).toBeNull()
    expect(normalizeTranscriptViewOverrideTransfer(undefined)).toBeUndefined()
    expect(normalizeTranscriptViewOverrideTransfer(null)).not.toBe(
      normalizeTranscriptViewOverrideTransfer(undefined)
    )
  })

  it('collapses junk to undefined so an unreadable payload cannot clear a pin', () => {
    // undefined (leave alone), not null (clear) — a garbled dock payload must
    // never wipe an override the user set in the main window.
    for (const junk of ['compact', '', 0, false, [], { view: 'minimal' }]) {
      expect(normalizeTranscriptViewOverrideTransfer(junk)).toBeUndefined()
    }
    // Positive control: the one value that IS allowed to clear still does.
    expect(normalizeTranscriptViewOverrideTransfer(null)).toBeNull()
  })
})
