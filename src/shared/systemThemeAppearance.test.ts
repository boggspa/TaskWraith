import { describe, expect, it } from 'vitest'

import {
  isDeprecatedSystemThemeAppearance,
  normalizeSystemThemeAppearance,
  resolveSystemThemeAppearance
} from './systemThemeAppearance'

describe('system theme appearance normalization', () => {
  it('maps retired system themes to stable built-in themes', () => {
    expect(normalizeSystemThemeAppearance('obsidian')).toBe('dark')
    expect(normalizeSystemThemeAppearance('alabaster')).toBe('light')
  })

  it('identifies only retired system theme tokens', () => {
    expect(isDeprecatedSystemThemeAppearance('obsidian')).toBe(true)
    expect(isDeprecatedSystemThemeAppearance('alabaster')).toBe(true)
    expect(isDeprecatedSystemThemeAppearance('codex')).toBe(false)
  })

  it('resolves missing values to the provided fallback', () => {
    expect(resolveSystemThemeAppearance(undefined)).toBe('system')
    expect(resolveSystemThemeAppearance(null, 'dark')).toBe('dark')
    expect(resolveSystemThemeAppearance('sage')).toBe('sage')
  })
})
