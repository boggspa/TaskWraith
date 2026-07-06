export type DeprecatedSystemThemeAppearance = 'obsidian' | 'alabaster'

export function isDeprecatedSystemThemeAppearance(
  value: unknown
): value is DeprecatedSystemThemeAppearance {
  return value === 'obsidian' || value === 'alabaster'
}

export function normalizeSystemThemeAppearance<T extends string | null | undefined>(
  value: T
): Exclude<T, DeprecatedSystemThemeAppearance> | 'dark' | 'light' {
  if (value === 'obsidian') return 'dark'
  if (value === 'alabaster') return 'light'
  return value as Exclude<T, DeprecatedSystemThemeAppearance>
}

export function resolveSystemThemeAppearance(
  value: string | null | undefined,
  fallback = 'system'
): string {
  return normalizeSystemThemeAppearance(value) || fallback
}
