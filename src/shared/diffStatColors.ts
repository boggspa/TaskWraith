export interface DiffStatColors {
  additions: string
  deletions: string
}

export const DEFAULT_DIFF_STAT_COLORS: DiffStatColors = {
  additions: '#2DB777',
  deletions: '#EC3D35'
}

export function normalizeDiffStatColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  const match = trimmed.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!match) return fallback
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

export function normalizeDiffStatColors(value: unknown): DiffStatColors {
  const record =
    value && typeof value === 'object' ? (value as Partial<DiffStatColors>) : undefined
  return {
    additions: normalizeDiffStatColor(record?.additions, DEFAULT_DIFF_STAT_COLORS.additions),
    deletions: normalizeDiffStatColor(record?.deletions, DEFAULT_DIFF_STAT_COLORS.deletions)
  }
}
