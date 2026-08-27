import { describe, expect, it, vi } from 'vitest'
import { applyChatPopoutWindowPresentation } from './ChatPopoutWindowPresentation'

describe('applyChatPopoutWindowPresentation', () => {
  it('shrinks an existing chat window into the companion without replacing it', () => {
    const window = {
      setMinimumSize: vi.fn(),
      setSize: vi.fn(),
      setTitle: vi.fn()
    }

    applyChatPopoutWindowPresentation(window, 'compact')

    expect(window.setMinimumSize).toHaveBeenCalledWith(360, 420)
    expect(window.setSize).toHaveBeenCalledWith(430, 610, true)
    expect(window.setTitle).toHaveBeenCalledWith('TaskWraith Compact Companion')
  })

  it('restores the full popout preset without animation when requested', () => {
    const window = {
      setMinimumSize: vi.fn(),
      setSize: vi.fn(),
      setTitle: vi.fn()
    }

    applyChatPopoutWindowPresentation(window, 'full', false)

    expect(window.setMinimumSize).toHaveBeenCalledWith(520, 480)
    expect(window.setSize).toHaveBeenCalledWith(900, 760, false)
    expect(window.setTitle).toHaveBeenCalledWith('TaskWraith Chat')
  })
})
