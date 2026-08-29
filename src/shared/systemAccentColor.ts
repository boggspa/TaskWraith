/**
 * The operating system's own accent colour — what macOS System Settings and
 * Windows Personalisation call "accent". It drives `--accent`, so buttons,
 * focus rings and selection read as part of the desktop TaskWraith runs on.
 *
 * Deliberately NOT the same value as `themeAccentColor`, which is the colour
 * the user picks for their message bubble inside TaskWraith. The two were one
 * token until now; splitting them is what lets the bubble be, say, deep green
 * while every button still matches the system.
 */

/** Main -> renderer push, so an OS accent change applies without a reload. */
export const SYSTEM_ACCENT_COLOR_CHANGED_CHANNEL = 'system-accent-color-changed'

/** Renderer -> main read for the accent in force at mount. */
export const SYSTEM_ACCENT_COLOR_CHANNEL = 'appearance:get-system-accent-color'

/**
 * Coerces an OS accent reading to `#RRGGBB`, or `null` when there is nothing
 * usable to apply.
 *
 * Electron hands back RGBA hex with no leading `#` (`'1E90FFFF'`), and returns
 * an empty string on platforms with no accent preference to report. Alpha is
 * dropped rather than carried: every consumer mixes this token into its own
 * translucent surfaces, so an OS-supplied alpha would compound with theirs and
 * wash the accent out.
 *
 * `null` is a meaningful answer, not a failure — it means "leave `--accent`
 * alone so the active theme's own accent wins", which is exactly what a Linux
 * host or a pre-Mojave macOS should get.
 */
export function normalizeSystemAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().replace(/^#/, '')
  if (!/^[0-9a-f]+$/i.test(hex)) return null
  if (hex.length === 3 || hex.length === 4) {
    // Shorthand expands per digit; the 4th digit is alpha and is dropped.
    return `#${hex
      .slice(0, 3)
      .split('')
      .map((digit) => `${digit}${digit}`)
      .join('')}`.toUpperCase()
  }
  if (hex.length === 6 || hex.length === 8) return `#${hex.slice(0, 6)}`.toUpperCase()
  return null
}
