import { describe, expect, it } from 'vitest'
import { shouldOpenUserMessageEditor } from './userMessageEditHitTest'

describe('shouldOpenUserMessageEditor', () => {
  it('opens the editor for a plain click on the message text body', () => {
    expect(
      shouldOpenUserMessageEditor({
        alreadyEditing: false,
        interactiveTarget: false,
        hasTextSelection: false
      })
    ).toBe(true)
  })

  it('refuses clicks on interactive descendants (link, button, toggle, media controls)', () => {
    expect(
      shouldOpenUserMessageEditor({
        alreadyEditing: false,
        interactiveTarget: true,
        hasTextSelection: false
      })
    ).toBe(false)
  })

  it('refuses while a drag text selection is active inside the bubble', () => {
    expect(
      shouldOpenUserMessageEditor({
        alreadyEditing: false,
        interactiveTarget: false,
        hasTextSelection: true
      })
    ).toBe(false)
  })

  it('refuses while any bubble is already in edit mode (no silent edit discard)', () => {
    expect(
      shouldOpenUserMessageEditor({
        alreadyEditing: true,
        interactiveTarget: false,
        hasTextSelection: false
      })
    ).toBe(false)
  })
})
