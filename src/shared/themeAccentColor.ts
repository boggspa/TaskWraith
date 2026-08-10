/**
 * The single user-selected colour that drives both the app accent and the
 * user's message bubble. Older settings retain separate named accent/bubble
 * choices; `resolveThemeAccentColor` folds those into this value on read.
 */
export const DEFAULT_THEME_ACCENT_COLOR = '#5A8CFF'

const LEGACY_THEME_ACCENT_COLORS: Readonly<Record<string, string>> = {
  blue: '#5A8CFF',
  purple: '#BF7CFF',
  pink: '#FF5FA2',
  orange: '#FF9B54',
  green: '#4CC38A',
  red: '#E65B62',
  yellow: '#F2C94C',
  graphite: '#9DA6B8'
}

function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return undefined
  const raw = match[1]
  const expanded =
    raw.length === 3
      ? raw
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : raw
  return `#${expanded.toUpperCase()}`
}

/** Coerces a persisted colour to canonical `#RRGGBB`, with a safe fallback. */
export function normalizeThemeAccentColor(
  value: unknown,
  fallback = DEFAULT_THEME_ACCENT_COLOR
): string {
  return normalizeHexColor(value) ?? normalizeHexColor(fallback) ?? DEFAULT_THEME_ACCENT_COLOR
}

/**
 * Returns an explicit shared colour when present, otherwise carries forward a
 * pre-unification named accent. The former app accent wins a conflict because
 * it already coloured the whole interface; a bubble-only choice remains the
 * fallback for people who never changed their accent.
 */
export function resolveThemeAccentColor(
  value: unknown,
  legacyThemeAccentStyle?: unknown,
  legacyUserBubbleColor?: unknown
): string {
  return (
    normalizeHexColor(value) ??
    (typeof legacyThemeAccentStyle === 'string'
      ? LEGACY_THEME_ACCENT_COLORS[legacyThemeAccentStyle]
      : undefined) ??
    (typeof legacyUserBubbleColor === 'string'
      ? LEGACY_THEME_ACCENT_COLORS[legacyUserBubbleColor]
      : undefined) ??
    DEFAULT_THEME_ACCENT_COLOR
  )
}
