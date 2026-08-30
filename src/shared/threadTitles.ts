export const THREAD_TITLE_MAX_CHARS = 160
export const THREAD_TITLE_PROMPT_FALLBACK_MAX_CHARS = 72
export const THREAD_TITLE_LOCAL_AI_MAX_CHARS = 60

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

function stripPromptTitleChrome(value: string): string {
  const lines = value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^[-*+]\s+(?:\[[ xX]\]\s+)?/, '')
        .trim()
    )
  const first = lines.findIndex(Boolean)
  if (first < 0) return ''
  const paragraph: string[] = []
  for (const line of lines.slice(first)) {
    if (!line) break
    paragraph.push(line)
  }
  return paragraph.join(' ')
}

function truncateAtWordBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const room = Math.max(1, maxChars - 1)
  const prefix = value.slice(0, room)
  const boundary = prefix.lastIndexOf(' ')
  const body = boundary >= Math.floor(room * 0.55) ? prefix.slice(0, boundary) : prefix
  return `${body.trimEnd()}…`
}

/** Immediate, deterministic title used while an on-device refinement runs. */
export function derivePromptFallbackThreadTitle(
  prompt: string | null | undefined,
  fallback = 'New Chat'
): string {
  const firstLine = stripPromptTitleChrome(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!firstLine) return fallback
  const firstSentence = firstLine.match(/^(.+?[.!?])(?:\s|$)/)?.[1] || firstLine
  return truncateAtWordBoundary(firstSentence, THREAD_TITLE_PROMPT_FALLBACK_MAX_CHARS)
}

/** Legacy first-send shapes that predate explicit title provenance. */
export function isKnownPromptFallbackThreadTitle(
  title: string | null | undefined,
  prompt: string | null | undefined
): boolean {
  const normalizedTitle = normalizeThreadTitle(title, '')
  const rawPrompt = prompt || ''
  if (!normalizedTitle || !rawPrompt.trim()) return false
  const legacyCanonical = normalizeThreadTitle(rawPrompt, '')
  const legacyEnsemble = rawPrompt.length > 30 ? `${rawPrompt.slice(0, 30)}...` : rawPrompt
  return (
    normalizedTitle === legacyCanonical ||
    normalizedTitle === normalizeThreadTitle(legacyEnsemble, '') ||
    normalizedTitle === derivePromptFallbackThreadTitle(rawPrompt, '')
  )
}

/** Strictly normalize a model-proposed three-to-seven-word thread title. */
export function normalizeLocalAiThreadTitle(value: unknown): string | null {
  const normalized = String(value ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[`*_#~<>]/g, '')
    .replace(/\[|\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'“”‘’]+|["'“”‘’.:;!?]+$/g, '')
    .trim()
  if (!normalized || normalized.length > THREAD_TITLE_LOCAL_AI_MAX_CHARS) return null
  if (isPlaceholderThreadTitle(normalized)) return null
  const words = normalized.split(/\s+/).filter(Boolean)
  if (words.length < 3 || words.length > 7) return null
  return normalized
}

/** Small portable source-CAS fingerprint; the semantic snapshot uses SHA-256. */
export function threadTitleSourceFingerprint(messageId: string, content: string): string {
  let hash = 0x811c9dc5
  const value = `${messageId}\u0000${content.replace(/\r\n?/g, '\n')}`
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `title-source-v1:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
