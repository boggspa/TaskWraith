/**
 * Exact participant-picker selections are routing metadata, not composer
 * text. Keeping their id in the visible draft used to require injecting an
 * `ensemble-dm://` markdown link and painting a second, hidden-text overlay
 * over the textarea. The draft now remains ordinary, editable `@Role` text;
 * this module keeps the picker identity long enough for the next dispatch.
 */
export interface ComposerParticipantMentionSelection {
  participantId: string
  /** Inclusive source offset of the visible `@Role` token. */
  start: number
  /** Exclusive source offset of the visible `@Role` token. */
  end: number
  text: string
}

export function formatComposerParticipantMention(label: string): string {
  const trimmed = label.trim()
  return trimmed ? `@${trimmed} ` : ''
}

export function acceptedDraftParticipantMentionSelection(input: {
  value: string
  participantId: string
  mentionText: string
}): ComposerParticipantMentionSelection | null {
  const mentionText = input.mentionText.trimEnd()
  if (!mentionText || !input.value.startsWith(mentionText)) return null
  return {
    participantId: input.participantId,
    start: 0,
    end: mentionText.length,
    text: mentionText
  }
}

/**
 * Keep selections that lie outside a single text edit, shift selections after
 * it, and drop the one the user actively edited. This gives normal textarea
 * editing semantics without ever leaking transport markup into the draft.
 */
export function rebaseComposerParticipantMentionSelections(input: {
  previousValue: string
  nextValue: string
  selections: ComposerParticipantMentionSelection[]
}): ComposerParticipantMentionSelection[] {
  const { previousValue, nextValue, selections } = input
  let prefixLength = 0
  const maxPrefix = Math.min(previousValue.length, nextValue.length)
  while (prefixLength < maxPrefix && previousValue[prefixLength] === nextValue[prefixLength]) {
    prefixLength += 1
  }

  let suffixLength = 0
  const previousRemaining = previousValue.length - prefixLength
  const nextRemaining = nextValue.length - prefixLength
  while (
    suffixLength < previousRemaining &&
    suffixLength < nextRemaining &&
    previousValue[previousValue.length - 1 - suffixLength] ===
      nextValue[nextValue.length - 1 - suffixLength]
  ) {
    suffixLength += 1
  }

  const previousEditEnd = previousValue.length - suffixLength
  const nextEditEnd = nextValue.length - suffixLength
  const shift = nextEditEnd - previousEditEnd

  return selections.flatMap((selection) => {
    if (selection.end <= prefixLength) return [selection]
    if (selection.start >= previousEditEnd) {
      return [
        {
          ...selection,
          start: selection.start + shift,
          end: selection.end + shift
        }
      ]
    }
    // The edit touched this mention, so it is no longer an exact picker
    // selection. The plain text remains and will use normal alias routing.
    return []
  })
}

/**
 * Return a picker id only when precisely one untouched picker token remains
 * in the current draft. Multiple selected mentions intentionally remain a
 * normal multi-participant prompt rather than being collapsed into a DM.
 */
export function exactComposerParticipantMentionTarget(input: {
  value: string
  selections: ComposerParticipantMentionSelection[]
}): string | undefined {
  const matchingSelections = input.selections.filter(
    (selection) => input.value.slice(selection.start, selection.end) === selection.text
  )
  const ids = [...new Set(matchingSelections.map((selection) => selection.participantId))]
  return matchingSelections.length === 1 && ids.length === 1 ? ids[0] : undefined
}
