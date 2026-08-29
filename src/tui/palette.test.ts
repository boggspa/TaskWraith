import { describe, expect, it } from 'vitest'
import { adaptToneForGround, contrastRatio, hexToRgb } from './ansi'
import {
  TUI_DEFAULT_THEME_NAME,
  TUI_THEMES,
  adaptProviderAccent,
  providerAccentContrast,
  resolveTuiTheme,
  tuiThemeForColorMode,
  tuiThemeNames
} from './palette'
import { TASKWRAITH_PROVIDER_ACCENTS } from '../shared/taskWraithProviderPresentation'

const paintedThemes = TUI_THEMES.filter((theme) => theme.ground)
const providerAccents = Object.entries(TASKWRAITH_PROVIDER_ACCENTS)

/** Hue in degrees, or undefined for an achromatic colour, which has none. */
function hue(hex: string): number | undefined {
  const [red, green, blue] = hexToRgb(hex).map((channel) => channel / 255)
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const chroma = max - min
  if (chroma === 0) return undefined
  const raw =
    max === red
      ? ((green - blue) / chroma) % 6
      : max === green
        ? (blue - red) / chroma + 2
        : (red - green) / chroma + 4
  return (raw * 60 + 360) % 360
}

describe('TaskWraith TUI palette', () => {
  it('exposes every built-in theme under a unique name and alias', () => {
    const spellings = TUI_THEMES.flatMap((theme) => [theme.name, ...theme.aliases])
    expect(new Set(spellings).size).toBe(spellings.length)
    expect(tuiThemeNames()).toContain(TUI_DEFAULT_THEME_NAME)
  })

  it('resolves aliases case-insensitively', () => {
    expect(resolveTuiTheme('TOKYONIGHT').name).toBe('tokyo-night')
    expect(resolveTuiTheme('  Moon  ').name).toBe('rose-pine-moon')
    expect(resolveTuiTheme('night').name).toBe('wraith-night')
  })

  it('falls back rather than throwing on an unknown or missing name', () => {
    // A stale persisted theme or a typo at the flag must never stop the TUI
    // from starting. Grok and Vibe both warn and continue; so do we.
    expect(resolveTuiTheme('no-such-theme').name).toBe(TUI_DEFAULT_THEME_NAME)
    expect(resolveTuiTheme(undefined).name).toBe(TUI_DEFAULT_THEME_NAME)
    expect(resolveTuiTheme('').name).toBe(TUI_DEFAULT_THEME_NAME)
  })

  it('keeps every provider accent legible on every painted ground', () => {
    expect(paintedThemes.length).toBeGreaterThan(0)
    expect(providerAccents.length).toBeGreaterThan(20)
    for (const theme of paintedThemes) {
      for (const [provider, accent] of providerAccents) {
        const achieved = providerAccentContrast(accent, theme)
        expect(
          achieved,
          `${provider} on ${theme.name} reached only ${achieved.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(theme.accentContrastFloor)
      }
    }
  })

  it('lifts a hue that a hostile ground would crush, and says how far', () => {
    // Direct mechanism test. The built-in grounds do not exercise adaptation
    // (see the margin test below), so asserting "some real accent changed"
    // would only ever measure the built-ins — which is how a broken lift ships
    // looking like a satisfied guarantee. Grade it against a ground chosen to
    // be hostile instead: mid-grey is the worst case for every hue at once.
    const hostile = '#7A7A7A'
    for (const [provider, accent] of providerAccents) {
      const lifted = adaptToneForGround(accent, hostile, 3)
      expect(lifted, `${provider} was not lifted off mid-grey`).not.toBe(accent)
      expect(
        contrastRatio(lifted, hostile),
        `${provider} lifted to only ${contrastRatio(lifted, hostile).toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('records that the pinned palette clears every built-in ground unaided', () => {
    // Not a tautology — a measured property of a deliberately luminance-
    // normalised palette, recorded so it fails loudly if either side moves.
    // Every provider accent lands within ~0.1 of its neighbours on any given
    // ground, which is why adaptation is dormant here rather than absent: a
    // future ground (a user's own terminal background, say) is an arbitrary
    // colour with no such guarantee, and this is the net under it.
    for (const theme of paintedThemes) {
      for (const [provider, accent] of providerAccents) {
        expect(
          adaptProviderAccent(accent, theme),
          `${provider} needed lifting on ${theme.name} — check that ground`
        ).toBe(accent)
      }
    }
  })

  it('moves luminance without moving hue', () => {
    // The identity contract: a theme may make Codex purple readable, never make
    // Codex a different colour. Achromatic accents (grok is pure grey) have no
    // hue to preserve and are skipped rather than asserted on.
    for (const theme of paintedThemes) {
      for (const [provider, accent] of providerAccents) {
        const before = hue(accent)
        if (before === undefined) continue
        const after = hue(adaptProviderAccent(accent, theme))
        if (after === undefined) continue
        const drift = Math.abs(after - before)
        expect(
          Math.min(drift, 360 - drift),
          `${provider} hue drifted on ${theme.name}`
        ).toBeLessThan(1)
      }
    }
  })

  it('keeps each theme’s own state tones legible on its own canvas', () => {
    for (const theme of paintedThemes) {
      const ground = theme.ground?.background as string
      for (const [name, hex] of Object.entries(theme.tone)) {
        if (name === 'highlight') continue // a blend target, never drawn alone
        expect(
          contrastRatio(hex, ground),
          `${theme.name} ${name} tone on its own canvas`
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('stacks the three grounds in a visible order', () => {
    // Depth is the point of having three. Two that quantise to the same cell
    // are a flat frame with extra tokens.
    for (const theme of paintedThemes) {
      const { background, surface, panel } = theme.ground as {
        background: string
        surface: string
        panel: string
      }
      expect(new Set([background, surface, panel]).size).toBe(3)
    }
  })

  it('declines to paint when the terminal cannot render the ground honestly', () => {
    const night = resolveTuiTheme('wraith-night')
    expect(night.ground).toBeDefined()
    expect(tuiThemeForColorMode(night, 'truecolor').ground).toBeDefined()
    expect(tuiThemeForColorMode(night, 'ansi256').ground).toBeUndefined()
    expect(tuiThemeForColorMode(night, 'none').ground).toBeUndefined()
    // Tones survive the drop: losing the ground must not lose the meaning.
    expect(tuiThemeForColorMode(night, 'ansi256').tone).toEqual(night.tone)
  })

  it('lets the terminal theme keep its tones on a 256-colour terminal', () => {
    const terminal = resolveTuiTheme('terminal')
    expect(terminal.ground).toBeUndefined()
    expect(terminal.requiresTruecolor).toBe(false)
    expect(adaptProviderAccent(TASKWRAITH_PROVIDER_ACCENTS.codex, terminal)).toBe(
      TASKWRAITH_PROVIDER_ACCENTS.codex
    )
  })
})
