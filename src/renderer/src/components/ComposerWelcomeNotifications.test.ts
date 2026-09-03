import { describe, expect, it } from 'vitest'
import {
  composerModelSupportsUltraTask,
  composerPickerUltraTaskSupportMetadata,
  resolveAntigravityUltraTaskSelection,
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

describe('resolveAntigravityUltraTaskSelection', () => {
  it('reads a bound seat’s marker from the seat, not the chat', () => {
    // The seat editor writes UltraTask onto the participant's own
    // reasoningEffort; the chat-level metadata it used to be read from is a
    // different record entirely and never carries a seat edit, so the ladder
    // snapped back to the family ceiling on every pick.
    expect(
      resolveAntigravityUltraTaskSelection({
        seatBound: true,
        seatReasoningEffort: 'ultraTask',
        chatUltraTaskSelected: false
      })
    ).toBe(true)
    expect(
      resolveAntigravityUltraTaskSelection({
        seatBound: true,
        seatReasoningEffort: 'high',
        chatUltraTaskSelected: true
      })
    ).toBe(false)
  })

  it('prefers a queued provider change over the chat metadata', () => {
    // A busy chat defers every provider-scoped patch into the pending change,
    // so that is where a mid-run UltraTask pick lands.
    expect(
      resolveAntigravityUltraTaskSelection({
        seatBound: false,
        pendingUltraTaskSelected: true,
        chatUltraTaskSelected: false
      })
    ).toBe(true)
    expect(
      resolveAntigravityUltraTaskSelection({
        seatBound: false,
        pendingUltraTaskSelected: false,
        chatUltraTaskSelected: true
      })
    ).toBe(false)
  })

  it('falls back to the chat metadata, and treats a missing marker as off', () => {
    expect(
      resolveAntigravityUltraTaskSelection({ seatBound: false, chatUltraTaskSelected: true })
    ).toBe(true)
    expect(resolveAntigravityUltraTaskSelection({ seatBound: false })).toBe(false)
    // Never truthiness — only an explicit boolean marker counts.
    expect(
      resolveAntigravityUltraTaskSelection({
        seatBound: false,
        pendingUltraTaskSelected: 'yes',
        chatUltraTaskSelected: 'yes'
      })
    ).toBe(false)
  })
})
