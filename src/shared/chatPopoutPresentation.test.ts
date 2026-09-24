import { describe, expect, it } from 'vitest'
import { chatPopoutWindowPreset, normalizeChatPopoutPresentation } from './chatPopoutPresentation'

describe('chat popout presentation', () => {
  it('defaults unknown and omitted values to the existing full presentation', () => {
    expect(normalizeChatPopoutPresentation(undefined)).toBe('full')
    expect(normalizeChatPopoutPresentation('full')).toBe('full')
    expect(normalizeChatPopoutPresentation('other')).toBe('full')
  })

  it('defines a genuinely compact companion preset', () => {
    const full = chatPopoutWindowPreset('full')
    const compact = chatPopoutWindowPreset('compact')

    expect(compact).toMatchObject({
      width: 430,
      height: 610,
      minWidth: 360,
      minHeight: 420,
      title: 'TaskWraith Compact Companion'
    })
    expect(compact.width).toBeLessThan(full.width)
    expect(compact.height).toBeLessThan(full.height)
  })
})
