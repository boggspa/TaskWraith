export const THREAD_TITLE_MAX_CHARS = 160

/** Titles the create factories stamp on a never-renamed chat (desktop
 * `createChat`/`createEnsembleChat`, the iOS New Chat canvas). A first prompt
 * may overwrite exactly these; anything else is user-authored and must never
 * be clobbered by derived titling. */
export const PLACEHOLDER_THREAD_TITLES: ReadonlySet<string> = new Set([
  'New Chat',
  'New Ensemble',
  'New Workflow'
])

export function isPlaceholderThreadTitle(title: string | null | undefined): boolean {
  const normalized = (title ?? '').replace(/\s+/g, ' ').trim()
  return normalized.length === 0 || PLACEHOLDER_THREAD_TITLES.has(normalized)
}

export function normalizeThreadTitle(
  title: string | null | undefined,
  fallback = 'Untitled chat'
): string {
  const normalized = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  if (normalized.length <= THREAD_TITLE_MAX_CHARS) return normalized
  return normalized.slice(0, THREAD_TITLE_MAX_CHARS).trimEnd()
}
