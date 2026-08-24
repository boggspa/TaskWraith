import { describe, expect, it } from 'vitest'
import {
  composerModelSupportsUltraTask,
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

describe('composerModelSupportsUltraTask', () => {
  it('requires an exact selected row with explicit support', () => {
    const models = [
      { id: 'supported', ultraTaskSupported: true },
      { id: 'unsupported', ultraTaskSupported: false },
      { id: 'unknown' }
    ]

    expect(composerModelSupportsUltraTask(models, 'supported')).toBe(true)
    expect(composerModelSupportsUltraTask(models, 'unsupported')).toBe(false)
    expect(composerModelSupportsUltraTask(models, 'unknown')).toBe(false)
    expect(composerModelSupportsUltraTask(models, 'missing')).toBe(false)
    expect(composerModelSupportsUltraTask(undefined, 'supported')).toBe(false)
  })
})
