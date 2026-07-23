import { afterEach, describe, expect, it } from 'vitest'
import {
  isAntigravityGeminiApiKeyConfigured,
  resetAntigravityGeminiApiKeyConfiguredProbeForTests,
  setAntigravityGeminiApiKeyConfiguredProbe
} from './AntigravityGeminiApiKeyConfiguredSignal'

afterEach(() => {
  resetAntigravityGeminiApiKeyConfiguredProbeForTests()
})

describe('AntigravityGeminiApiKeyConfiguredSignal', () => {
  it('defaults to false (fail closed) before any probe is wired', () => {
    expect(isAntigravityGeminiApiKeyConfigured()).toBe(false)
  })

  it('reflects a wired probe returning true', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => true)
    expect(isAntigravityGeminiApiKeyConfigured()).toBe(true)
  })

  it('reflects a wired probe returning false', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => false)
    expect(isAntigravityGeminiApiKeyConfigured()).toBe(false)
  })

  it('normalizes a non-boolean truthy return to strict false (fail closed)', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => 1 as unknown as boolean)
    expect(isAntigravityGeminiApiKeyConfigured()).toBe(false)
  })

  it('fails closed when the wired probe throws', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => {
      throw new Error('boom')
    })
    expect(isAntigravityGeminiApiKeyConfigured()).toBe(false)
  })

  it('reset restores the fail-closed default probe', () => {
    setAntigravityGeminiApiKeyConfiguredProbe(() => true)
    expect(isAntigravityGeminiApiKeyConfigured()).toBe(true)
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
    expect(isAntigravityGeminiApiKeyConfigured()).toBe(false)
  })
})
