import { describe, expect, it, vi } from 'vitest'
import { handleSideChatComposerKeyDown, shouldSubmitSideChatComposerKey } from './sideChatComposer'

function keyEvent(overrides: Partial<Parameters<typeof shouldSubmitSideChatComposerKey>[0]> = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    nativeEvent: {
      isComposing: false
    },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides
  }
}

describe('sideChatComposer', () => {
  it('submits on Enter and stops the global composer shortcut from also firing', () => {
    const event = keyEvent()
    const submit = vi.fn()

    expect(handleSideChatComposerKeyDown(event, submit)).toBe(true)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(submit).toHaveBeenCalledOnce()
  })

  it('also treats modified Enter as a side-chat submit', () => {
    const event = keyEvent({ metaKey: true })
    const submit = vi.fn()

    expect(handleSideChatComposerKeyDown(event, submit)).toBe(true)

    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('does not submit on Shift+Enter or IME composition', () => {
    expect(shouldSubmitSideChatComposerKey(keyEvent({ shiftKey: true }))).toBe(false)
    expect(shouldSubmitSideChatComposerKey(keyEvent({ nativeEvent: { isComposing: true } }))).toBe(
      false
    )
  })
})
