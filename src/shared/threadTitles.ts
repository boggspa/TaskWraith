export const THREAD_TITLE_MAX_CHARS = 160

export function normalizeThreadTitle(
  title: string | null | undefined,
  fallback = 'Untitled chat'
): string {
  const normalized = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  if (normalized.length <= THREAD_TITLE_MAX_CHARS) return normalized
  return normalized.slice(0, THREAD_TITLE_MAX_CHARS).trimEnd()
}

