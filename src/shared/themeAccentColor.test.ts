import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME_ACCENT_COLOR,
  normalizeThemeAccentColor,
  resolveThemeAccentColor
} from './themeAccentColor'

describe('theme accent color', () => {
  it('normalizes shorthand and mixed-case hex input', () => {
    expect(normalizeThemeAccentColor('abc')).toBe('#AABBCC')
    expect(normalizeThemeAccentColor('#bAdC0d')).toBe('#BADC0D')
  })

  it('falls back safely when a persisted colour is malformed', () => {
    expect(normalizeThemeAccentColor('not-a-colour')).toBe(DEFAULT_THEME_ACCENT_COLOR)
    expect(normalizeThemeAccentColor('#f00', '#0f0')).toBe('#FF0000')
  })

  it('uses legacy selections only when an explicit shared colour is absent', () => {
    expect(resolveThemeAccentColor(undefined, 'purple', 'green')).toBe('#BF7CFF')
    expect(resolveThemeAccentColor(undefined, 'system', 'graphite')).toBe('#9DA6B8')
    expect(resolveThemeAccentColor('#123456', 'purple', 'green')).toBe('#123456')
  })
})
