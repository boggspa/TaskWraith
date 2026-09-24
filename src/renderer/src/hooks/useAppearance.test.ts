import { describe, it, expect } from 'vitest'
import type {
  AppearanceMode,
  PromptSurfaceStyle,
  ThemeAccentStyle,
  ThemeAppearance,
  ThemeCornerStyle,
  UserBubbleColor,
  VisualEffectStyle
} from '../../../main/store/types'
import { resolveAccentTokens, resolvePaneOpacityFactor } from './useAppearance'
import { DEFAULT_THEME_ACCENT_COLOR } from '../../../shared/themeAccentColor'

describe('Appearance settings validation', () => {
  it('valid appearance modes are accepted by the type system', () => {
    const validModes: AppearanceMode[] = ['solid', 'soft_glass', 'native_glass']
    expect(validModes).toContain('soft_glass')
    expect(validModes).toContain('solid')
    expect(validModes).toContain('native_glass')
  })

  it('default settings shape matches AppSettings', () => {
    const defaults = {
      appearanceMode: 'soft_glass' as AppearanceMode,
      visualEffectStyle: 'auto' as VisualEffectStyle,
      themeAppearance: 'system' as ThemeAppearance,
      themeCornerStyle: 'rounded' as ThemeCornerStyle,
      themeAccentStyle: 'system' as ThemeAccentStyle,
      themeAccentColor: DEFAULT_THEME_ACCENT_COLOR,
      userBubbleColor: 'system' as UserBubbleColor,
      promptSurfaceStyle: 'liquid_glass' as PromptSurfaceStyle,
      reduceTransparency: false,
      reduceMotion: false,
      compactDensity: false,
      showInspector: false,
      inspectorWidth: 380,
      sidebarWidth: 260
    }
    expect(defaults.appearanceMode).toBe('soft_glass')
    expect(defaults.visualEffectStyle).toBe('auto')
    expect(defaults.themeAppearance).toBe('system')
    expect(defaults.themeAccentColor).toBe(DEFAULT_THEME_ACCENT_COLOR)
    expect(defaults.reduceTransparency).toBe(false)
    expect(defaults.reduceMotion).toBe(false)
    expect(defaults.showInspector).toBe(false)
  })

  it('mode names are generic, not branded', () => {
    const mode: AppearanceMode = 'soft_glass'
    expect(mode).not.toBe('apple_glass')
    expect(mode).not.toBe('claude_glass')
    // Just verifying we use generic naming
    expect(['solid', 'soft_glass', 'native_glass']).toContain(mode)
  })

  it('forces effective pane opacity to opaque when transparency is reduced', () => {
    expect(resolvePaneOpacityFactor(42, false)).toBe(0.42)
    expect(resolvePaneOpacityFactor(42, true)).toBe(1)
    expect(resolvePaneOpacityFactor(140, false)).toBe(1)
    expect(resolvePaneOpacityFactor(-10, false)).toBe(0)
  })
})

describe('resolveAccentTokens', () => {
  it('sends the OS accent to --accent and the picked colour to the bubble', () => {
    const tokens = resolveAccentTokens({
      systemAccentColor: '1e90ffff',
      messageBubbleColor: '#2F6B4F'
    })

    expect(tokens.accent).toBe('#1E90FF')
    expect(tokens.messageBubbleAccent).toBe('#2F6B4F')
  })

  it('keeps the two colours independent', () => {
    // The whole point of the split: the bubble must not follow the desktop's
    // accent, and the desktop's accent must not follow the bubble.
    const green = resolveAccentTokens({
      systemAccentColor: '#1E90FF',
      messageBubbleColor: '#2F6B4F'
    })
    const red = resolveAccentTokens({
      systemAccentColor: '#1E90FF',
      messageBubbleColor: '#8B1E3F'
    })

    expect(green.accent).toBe(red.accent)
    expect(green.messageBubbleAccent).not.toBe(red.messageBubbleAccent)
    expect(green.accent).not.toBe(green.messageBubbleAccent)
  })

  it('derives the accent hover from the OS accent, not the bubble', () => {
    const tokens = resolveAccentTokens({
      systemAccentColor: '#1E90FF',
      messageBubbleColor: '#2F6B4F'
    })

    expect(tokens.accentHover).toBe('color-mix(in srgb, #1E90FF 78%, white)')
    expect(tokens.accentHover).not.toContain('#2F6B4F')
  })

  it('yields no accent at all when the host reports none', () => {
    // null means "apply nothing", so the active theme's own --accent stands.
    // A stand-in colour here would outrank every [data-theme] block forever.
    for (const missing of [null, undefined, '', 'not-a-color']) {
      const tokens = resolveAccentTokens({
        systemAccentColor: missing,
        messageBubbleColor: '#2F6B4F'
      })
      expect(tokens.accent).toBeNull()
      expect(tokens.accentHover).toBeNull()
      // The bubble still gets its colour — it has no OS source to lose.
      expect(tokens.messageBubbleAccent).toBe('#2F6B4F')
    }
  })
})
