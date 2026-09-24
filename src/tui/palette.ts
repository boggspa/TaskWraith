/**
 * TaskWraith TUI colour grounds.
 *
 * `theme.ts` owns the design *vocabulary* — glyph slots, density affordances,
 * layout, motion. This module owns the *palette* that vocabulary is drawn in,
 * and is re-exported from `theme.ts` so callers still have one import surface.
 *
 * Two rules govern the palette, and they are the reason this is not simply a
 * bag of hexes:
 *
 * 1. **A theme owns the ground and the state tones. It never owns provider
 *    hue.** Provider accents are cross-surface identity, pinned by
 *    `taskWraithProviderPresentation.test.ts` to the desktop `theme.css` and
 *    mirrored in iOS `Theme.swift`. A theme may make Codex purple *legible* on
 *    its ground (`adaptProviderAccent`); it may not make Codex a different
 *    colour. Repainting provider hue per theme would break the one thing the
 *    TUI shares with every other TaskWraith surface.
 * 2. **Not painting is a supported theme, not a degraded one.** `terminal`
 *    declines the ground entirely and inherits the user's own palette. That is
 *    the honest answer for a 256-colour terminal, for `NO_COLOR`, and for
 *    anyone who has already themed their terminal and does not want us arguing
 *    with it.
 */

import { adaptToneForGround, contrastRatio } from './ansi'
import { taskWraithProviderAccent } from '../shared/taskWraithProviderPresentation'

/* -------------------------------------------------------------------------
 * Shape
 * ---------------------------------------------------------------------- */

/**
 * The three painted depths, deepest first.
 *
 * There are exactly three because the TUI has exactly three regions that stack:
 * the transcript canvas, the overlays and composer that sit over it, and the
 * HUD strip. A fourth depth would have nothing to describe.
 */
export interface TuiThemeGround {
  /** The transcript canvas — the deepest surface, and most of the screen. */
  background: string
  /** Overlays and the composer: one step above the canvas. */
  surface: string
  /** The HUD strip: the most raised chrome. */
  panel: string
}

/**
 * Foreground for text the TUI does not otherwise colour.
 *
 * Before themes the surface had no ink at all: prose inherited the terminal
 * foreground and secondary chrome went through `Ansi.dim`. That works on the
 * dark grounds it was designed against and fails on a light one, where SGR 2
 * against a painted pale ground is frequently unreadable.
 */
export interface TuiThemeInk {
  /** Prose and primary labels. */
  primary: string
  /** Hints, separators, settled detail — everything `dim` used to carry. */
  muted: string
}

export interface TuiPermissionTone {
  info: string
  primary: string
  warning: string
  error: string
}

export interface TuiThemeTone {
  /** Dedicated permission ladder; independent from generic status tones. */
  permission: TuiPermissionTone
  good: string
  warning: string
  error: string
  /** Shared accent for ensemble chrome (baton, roster, ghost mark). */
  ensemble: string
  /** Blend target for the working shimmer and the reasoning ladder. */
  highlight: string
}

export interface TuiTheme {
  /** Canonical name. What `--theme` prints and what persistence stores. */
  name: string
  /** Extra accepted spellings. Matching is case-insensitive, as Grok's is. */
  aliases: readonly string[]
  /** One-line description, shown beside the name in the `/theme` picker. */
  summary: string
  polarity: 'dark' | 'light'
  /**
   * Whether the ground survives quantisation to the 256-colour cube.
   *
   * The near-black grounds separate by two or three points of luminance, which
   * the cube collapses to a single index — the depth disappears and the frame
   * reads as flat. Such a theme falls back rather than painting mud.
   */
  requiresTruecolor: boolean
  /** `undefined` means: do not paint, inherit the terminal's own ground. */
  ground: TuiThemeGround | undefined
  /** `undefined` means: inherit the terminal foreground, dim as before. */
  ink: TuiThemeInk | undefined
  tone: TuiThemeTone
  /**
   * Contrast floor a provider accent must clear against `ground.background`.
   *
   * 3.0 is the WCAG floor for large/bold text, which is what provider accents
   * always are here: short bold identity labels and single glyphs, never body
   * prose. Holding them to the 4.5 body-text floor would wash every hue toward
   * the same pastel and cost more identity than it buys legibility.
   */
  accentContrastFloor: number
}

/* -------------------------------------------------------------------------
 * Built-in themes
 * ---------------------------------------------------------------------- */

/** House tones, carried by every dark theme that does not restate them. */
const HOUSE_TONE: TuiThemeTone = {
  permission: {
    info: '#6FB6FF',
    primary: '#FFFFFF',
    warning: '#F59E0B',
    error: '#DC2626'
  },
  good: '#55B985',
  warning: '#D49A47',
  error: '#D45B62',
  ensemble: taskWraithProviderAccent('ensemble'),
  highlight: '#F4EEF7'
}

export const TUI_THEMES: readonly TuiTheme[] = [
  {
    name: 'wraith-night',
    aliases: ['night', 'dark', 'wraith'],
    summary: 'House dark. Neutral ground with the ensemble mauve.',
    polarity: 'dark',
    requiresTruecolor: true,
    ground: { background: '#12101A', surface: '#1A1723', panel: '#221E2D' },
    ink: { primary: '#E6E1EC', muted: '#8E869C' },
    tone: HOUSE_TONE,
    accentContrastFloor: 3
  },
  {
    name: 'wraith-day',
    aliases: ['day', 'light'],
    summary: 'House light, for bright terminal profiles.',
    polarity: 'light',
    requiresTruecolor: true,
    ground: { background: '#FAF8FC', surface: '#F2EFF6', panel: '#E9E4EF' },
    ink: { primary: '#1E1A26', muted: '#5F5870' },
    // Restated rather than shared: the house tones are tuned for a dark ground
    // and every one of them fails the accent floor against #FAF8FC.
    tone: {
      permission: {
        info: '#1976D2',
        primary: '#1D1D1F',
        warning: '#D97706',
        error: '#991B1B'
      },
      good: '#2F7D55',
      warning: '#8A5D14',
      error: '#A32F38',
      ensemble: '#7A4E68',
      // On a light ground the shimmer must blend toward ink, not toward white,
      // or the sweep vanishes exactly where it is meant to be brightest.
      highlight: '#2B2436'
    },
    accentContrastFloor: 3
  },
  {
    name: 'tokyo-night',
    aliases: ['tokyonight', 'tokyo'],
    summary: 'Dark, blue-tinted.',
    polarity: 'dark',
    requiresTruecolor: true,
    ground: { background: '#1A1B26', surface: '#1F2335', panel: '#24283B' },
    ink: { primary: '#C0CAF5', muted: '#565F89' },
    tone: {
      permission: {
        info: '#6FB6FF',
        primary: '#FFFFFF',
        warning: '#F59E0B',
        error: '#DC2626'
      },
      good: '#9ECE6A',
      warning: '#E0AF68',
      error: '#F7768E',
      ensemble: '#BB9AF7',
      highlight: '#C0CAF5'
    },
    accentContrastFloor: 3
  },
  {
    name: 'rose-pine-moon',
    aliases: ['rosepine-moon', 'rosepine', 'moon'],
    summary: 'Muted dark with iris accents.',
    polarity: 'dark',
    requiresTruecolor: true,
    ground: { background: '#232136', surface: '#2A273F', panel: '#393552' },
    ink: { primary: '#E0DEF4', muted: '#6E6A86' },
    tone: {
      permission: {
        info: '#6FB6FF',
        primary: '#FFFFFF',
        warning: '#F59E0B',
        error: '#DC2626'
      },
      good: '#9CCFD8',
      warning: '#F6C177',
      error: '#EB6F92',
      ensemble: '#C4A7E7',
      highlight: '#E0DEF4'
    },
    accentContrastFloor: 3
  },
  {
    name: 'terminal',
    aliases: ['none', 'inherit', 'ansi'],
    summary: 'Paint nothing. Inherit your terminal’s own colours.',
    // Polarity is a claim about the ground, and this theme does not own one.
    // Dark is the honest default for the tones it still carries; a light
    // terminal running `terminal` gets the same surface it had before themes,
    // which is the compatibility promise this theme exists to make.
    polarity: 'dark',
    requiresTruecolor: false,
    ground: undefined,
    ink: undefined,
    tone: HOUSE_TONE,
    accentContrastFloor: 0
  }
]

/**
 * The theme that paints nothing.
 *
 * This is `renderTaskWraithTui`'s default so that every existing caller and
 * every existing rendering test keeps the exact frame it had before themes
 * existed. Opting into a ground is something the CLI does deliberately.
 */
export const TUI_UNPAINTED_THEME: TuiTheme = TUI_THEMES.find(
  (theme) => theme.name === 'terminal'
) as TuiTheme

/** What an unrecognised or unresolvable theme name lands on. */
export const TUI_DEFAULT_THEME_NAME = 'wraith-night'
/** Where `auto` lands when the ground cannot be painted at all. */
export const TUI_FALLBACK_THEME_NAME = 'terminal'

/* -------------------------------------------------------------------------
 * Resolution
 * ---------------------------------------------------------------------- */

function findTheme(name: string): TuiTheme | undefined {
  const wanted = name.trim().toLowerCase()
  return TUI_THEMES.find(
    (theme) => theme.name === wanted || theme.aliases.some((alias) => alias === wanted)
  )
}

export function tuiThemeNames(): string[] {
  return TUI_THEMES.map((theme) => theme.name)
}

/**
 * Resolve a theme by name or alias.
 *
 * An unknown name is not an error. A stale config entry or a typo at the flag
 * must not stop the TUI from starting — it falls back and the caller decides
 * whether to say so.
 */
export function resolveTuiTheme(name: string | undefined): TuiTheme {
  const found = name ? findTheme(name) : undefined
  if (found) return found
  return findTheme(TUI_DEFAULT_THEME_NAME) as TuiTheme
}

/**
 * Drop a theme's ground when the terminal cannot render it honestly.
 *
 * The ground is the whole of a theme's depth, so a truecolor theme quantised to
 * the 256-cube loses the distinction between its three surfaces and paints a
 * flat block instead. Better to keep the tones and let the terminal's own
 * background through: that is the `terminal` theme's ground, and it is a real
 * design, not a failure state.
 */
export function tuiThemeForColorMode(
  theme: TuiTheme,
  mode: 'truecolor' | 'ansi256' | 'none'
): TuiTheme {
  if (mode === 'truecolor') return theme
  if (mode === 'none') return { ...theme, ground: undefined, ink: undefined }
  if (!theme.requiresTruecolor) return theme
  return { ...theme, ground: undefined, ink: undefined }
}

/* -------------------------------------------------------------------------
 * Auto
 * ---------------------------------------------------------------------- */

export const TUI_AUTO_THEME_NAME = 'auto'
const TUI_AUTO_THEME_ALIASES = ['system'] as const

/**
 * Which theme `auto` lands on, per measured appearance.
 *
 * Two entries rather than one because "follow the terminal" is two decisions,
 * not one: Grok exposes both as settings (`auto_dark_theme` / `auto_light_theme`)
 * precisely so someone can pair Tokyo Night at night with the house light theme
 * by day. This is the same pair, not yet user-configurable.
 */
export const TUI_AUTO_THEME_MAP = {
  dark: 'wraith-night',
  light: 'wraith-day'
} as const

/**
 * `auto` is deliberately not resolvable by `resolveTuiTheme`.
 *
 * Resolving it needs a measurement that may touch the tty, so it cannot be a
 * synchronous name lookup. Callers test for it, take the measurement, and call
 * `resolveAutoTheme` — which is why `auto` is not in `TUI_THEMES`.
 */
export function isAutoThemeName(name: string | undefined): boolean {
  if (!name) return false
  const wanted = name.trim().toLowerCase()
  return wanted === TUI_AUTO_THEME_NAME || TUI_AUTO_THEME_ALIASES.some((a) => a === wanted)
}

export function resolveAutoTheme(appearance: 'dark' | 'light'): TuiTheme {
  return resolveTuiTheme(TUI_AUTO_THEME_MAP[appearance])
}

/* -------------------------------------------------------------------------
 * Provider accents
 * ---------------------------------------------------------------------- */

/**
 * Make a provider accent legible on the active ground without moving its hue.
 *
 * A theme that does not paint returns the accent untouched: the terminal's
 * background is unknown, so any "correction" would be a guess, and guessing
 * about a colour we cannot measure is how you make a readable accent
 * unreadable.
 */
export function adaptProviderAccent(accent: string, theme: TuiTheme): string {
  if (!theme.ground || theme.accentContrastFloor <= 0) return accent
  return adaptToneForGround(accent, theme.ground.background, theme.accentContrastFloor)
}

/** Contrast a provider accent achieves on a theme's canvas, for tests and audits. */
export function providerAccentContrast(accent: string, theme: TuiTheme): number {
  if (!theme.ground) return Number.POSITIVE_INFINITY
  return contrastRatio(adaptProviderAccent(accent, theme), theme.ground.background)
}
