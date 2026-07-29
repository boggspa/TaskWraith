import { afterEach, describe, expect, it } from 'vitest'
import {
  isAntigravityAgyOptInEnabled,
  resetAntigravityAgyOptInEnabledProbeForTests,
  setAntigravityAgyOptInEnabledProbe
} from './AntigravityAgyOptInEnabledSignal'
import {
  isAntigravityGeminiApiKeyConfigured,
  resetAntigravityGeminiApiKeyConfiguredProbeForTests,
  setAntigravityGeminiApiKeyConfiguredProbe
} from './AntigravityGeminiApiKeyConfiguredSignal'

afterEach(() => {
  resetAntigravityAgyOptInEnabledProbeForTests()
  resetAntigravityGeminiApiKeyConfiguredProbeForTests()
})

describe('AntigravityAgyOptInEnabledSignal', () => {
  it('defaults to false (fail closed) before any probe is wired', () => {
    expect(isAntigravityAgyOptInEnabled()).toBe(false)
  })

  it('reflects a wired probe returning true', () => {
    setAntigravityAgyOptInEnabledProbe(() => true)
    expect(isAntigravityAgyOptInEnabled()).toBe(true)
  })

  it('reflects a wired probe returning false', () => {
    setAntigravityAgyOptInEnabledProbe(() => false)
    expect(isAntigravityAgyOptInEnabled()).toBe(false)
  })

  it('normalizes a non-boolean truthy return to strict false (fail closed)', () => {
    setAntigravityAgyOptInEnabledProbe(() => 1 as unknown as boolean)
    expect(isAntigravityAgyOptInEnabled()).toBe(false)
  })

  it('fails closed when the wired probe throws', () => {
    setAntigravityAgyOptInEnabledProbe(() => {
      throw new Error('boom')
    })
    expect(isAntigravityAgyOptInEnabled()).toBe(false)
  })

  it('reset restores the fail-closed default probe', () => {
    setAntigravityAgyOptInEnabledProbe(() => true)
    expect(isAntigravityAgyOptInEnabled()).toBe(true)
    resetAntigravityAgyOptInEnabledProbeForTests()
    expect(isAntigravityAgyOptInEnabled()).toBe(false)
  })

  // The whole point of this module: the two lanes are independent. A regression
  // that re-derived one from the other would pass every test above.
  describe('lane independence from the Gemini API-key signal', () => {
    it('is true on agy opt-in alone, with NO API key configured', () => {
      setAntigravityAgyOptInEnabledProbe(() => true)
      setAntigravityGeminiApiKeyConfiguredProbe(() => false)
      expect(isAntigravityAgyOptInEnabled()).toBe(true)
      expect(isAntigravityGeminiApiKeyConfigured()).toBe(false)
    })

    it('is false on a configured API key alone, with NO agy opt-in', () => {
      setAntigravityAgyOptInEnabledProbe(() => false)
      setAntigravityGeminiApiKeyConfiguredProbe(() => true)
      expect(isAntigravityAgyOptInEnabled()).toBe(false)
      expect(isAntigravityGeminiApiKeyConfigured()).toBe(true)
    })

    it('a throwing agy probe does not disturb the key signal', () => {
      setAntigravityAgyOptInEnabledProbe(() => {
        throw new Error('boom')
      })
      setAntigravityGeminiApiKeyConfiguredProbe(() => true)
      expect(isAntigravityAgyOptInEnabled()).toBe(false)
      expect(isAntigravityGeminiApiKeyConfigured()).toBe(true)
    })
  })
})
