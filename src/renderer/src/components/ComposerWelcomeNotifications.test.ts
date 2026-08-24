import { describe, expect, it } from 'vitest'
import {
  composerPickerUltraTaskSupportMetadata,
  shouldRenderWelcomeNotifications
} from './Composer'

describe('shouldRenderWelcomeNotifications', () => {
  it('keeps app-global welcome notices on the focused welcome composer only', () => {
    expect(shouldRenderWelcomeNotifications(true)).toBe(true)
    expect(shouldRenderWelcomeNotifications(true, false)).toBe(false)
    expect(shouldRenderWelcomeNotifications(false, true)).toBe(false)
  })
})

describe('composerPickerUltraTaskSupportMetadata', () => {
  it('preserves an explicit UltraTask exclusion from the live model catalogue', () => {
    expect(composerPickerUltraTaskSupportMetadata({ ultraTaskSupported: false })).toEqual({
      ultraTaskSupported: false
    })
    expect(composerPickerUltraTaskSupportMetadata({})).toEqual({})
  })
})
