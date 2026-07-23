import { describe, expect, it } from 'vitest'
import {
  exactComposerParticipantMentionTarget,
  formatComposerParticipantMention,
  rebaseComposerParticipantMentionSelections
} from './composerParticipantMentionSelection'

describe('composer participant mention selections', () => {
  it('formats a picker choice as ordinary editable @text', () => {
    expect(formatComposerParticipantMention('CodexSlice')).toBe('@CodexSlice ')
  })

  it('shifts a picker selection when text is inserted before it', () => {
    const previousValue = 'Ask @CodexSlice to review'
    const selections = [{ participantId: 'seat-codex', start: 4, end: 15, text: '@CodexSlice' }]
    expect(
      rebaseComposerParticipantMentionSelections({
        previousValue,
        nextValue: `Please ${previousValue}`,
        selections
      })
    ).toEqual([{ participantId: 'seat-codex', start: 11, end: 22, text: '@CodexSlice' }])
  })

  it('drops exact picker routing when the visible tag itself is edited', () => {
    expect(
      rebaseComposerParticipantMentionSelections({
        previousValue: 'Ask @CodexSlice to review',
        nextValue: 'Ask @Codex to review',
        selections: [{ participantId: 'seat-codex', start: 4, end: 15, text: '@CodexSlice' }]
      })
    ).toEqual([])
  })

  it('only supplies an exact target when exactly one untouched picker tag remains', () => {
    const selection = { participantId: 'seat-codex', start: 4, end: 15, text: '@CodexSlice' }
    expect(
      exactComposerParticipantMentionTarget({
        value: 'Ask @CodexSlice to review',
        selections: [selection]
      })
    ).toBe('seat-codex')
    expect(
      exactComposerParticipantMentionTarget({
        value: 'Ask @CodexSlice and @Codex2 to review',
        selections: [
          selection,
          { participantId: 'seat-codex-2', start: 20, end: 27, text: '@Codex2' }
        ]
      })
    ).toBeUndefined()
  })
})
