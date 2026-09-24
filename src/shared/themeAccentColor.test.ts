import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DARK_THEME_ACCENT_COLOR,
  DEFAULT_LIGHT_THEME_ACCENT_COLOR,
  DEFAULT_THEME_ACCENT_COLOR,
  normalizeThemeAccentColor,
  resolveDefaultThemeAccentColor,
  resolveThemeAccentColorForAppearance,
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

  it('resolves the semantic default against explicit and system appearances', () => {
    expect(resolveDefaultThemeAccentColor('dark')).toBe(DEFAULT_DARK_THEME_ACCENT_COLOR)
    expect(resolveDefaultThemeAccentColor('light')).toBe(DEFAULT_LIGHT_THEME_ACCENT_COLOR)
    expect(resolveDefaultThemeAccentColor('citrus')).toBe(DEFAULT_LIGHT_THEME_ACCENT_COLOR)
    expect(resolveDefaultThemeAccentColor('system', true)).toBe(DEFAULT_LIGHT_THEME_ACCENT_COLOR)
    expect(resolveDefaultThemeAccentColor('system', false)).toBe(DEFAULT_DARK_THEME_ACCENT_COLOR)
  })

  it('keeps custom colours fixed across appearances', () => {
    expect(resolveThemeAccentColorForAppearance(DEFAULT_THEME_ACCENT_COLOR, 'light')).toBe(
      DEFAULT_LIGHT_THEME_ACCENT_COLOR
    )
    expect(resolveThemeAccentColorForAppearance('#12AB34', 'light')).toBe('#12AB34')
    expect(resolveThemeAccentColorForAppearance('#12AB34', 'dark')).toBe('#12AB34')
  })

  it('uses legacy selections only when an explicit shared colour is absent', () => {
    expect(resolveThemeAccentColor(undefined, 'purple', 'green')).toBe('#BF7CFF')
    expect(resolveThemeAccentColor(undefined, 'system', 'graphite')).toBe('#9DA6B8')
    expect(resolveThemeAccentColor('#123456', 'purple', 'green')).toBe('#123456')
  })
})
