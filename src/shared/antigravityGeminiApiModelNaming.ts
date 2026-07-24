/**
 * Picker naming + curation for the AntiGravity Gemini API lane.
 *
 * Lives in shared because BOTH sides need one derivation: main builds the
 * catalog labels (combined catalog + static fallback), and the renderer must
 * reproduce them anywhere only the persisted model ID survives — the composer
 * footer chip and the usage dashboards (`composerChipFormat.ts`,
 * `modelDisplayName.ts`). Two derivations would drift.
 *
 * Live `models.list` returns the raw API catalogue, which is both verbose
 * (`gemini-2.5-flash-lite-preview-09-2025`) and full of rows that are not
 * distinct offers: dated revisions (`-001`), dated previews, and `-latest`
 * aliases that duplicate a canonical id. Rendered verbatim under a header that
 * already says ANTIGRAVITY, every row also repeated "Gemini API" and
 * "separate billing" — the billing terms are explained in full on the settings
 * card, not once per row.
 *
 * Naming is derived rather than hand-mapped, which is safe HERE (unlike the
 * cross-provider table in `modelDisplayName.ts`) because these ids all come
 * from one provider with one convention: `gemini-<version>-<variant tokens>`.
 * An unrecognised token is title-cased, so a new family reads correctly the day
 * it ships instead of waiting for a mapping.
 */

/**
 * Wire-format constant. The authority is main's `AntigravityGeminiApiModelDiscovery`
 * (`ANTIGRAVITY_GEMINI_API_MODEL_PREFIX`), which shared cannot import; the ids
 * are persisted in chats, so the prefix is frozen and safe to mirror.
 */
export const ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX = 'gemini-api:'

/** Families below this read as legacy next to the current ones and are hidden. */
const MIN_CURATED_VERSION = 2.5

/** Tokens whose casing is not derivable from title-casing alone. */
const TOKEN_LABELS: Record<string, string> = {
  tts: 'TTS'
}

/** An id ending in one of these is an alias or a dated snapshot of another row. */
const ALIAS_SUFFIXES = ['latest', 'exp', 'experimental']

function modelIdTokens(modelId: string): string[] {
  return modelId
    .replace(/^gemini-/, '')
    .split('-')
    .filter(Boolean)
}

/**
 * `gemini-2.5-flash-lite` → `2.5 Flash-Lite`. Flash-Lite is one product name,
 * so it keeps its hyphen; every other token is space-joined.
 */
export function antigravityGeminiApiModelLabel(modelId: string): string {
  const tokens = modelIdTokens(modelId)
  if (tokens.length === 0) return modelId
  const parts: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === 'flash' && tokens[index + 1] === 'lite') {
      parts.push('Flash-Lite')
      index += 1
      continue
    }
    parts.push(labelToken(token))
  }
  return parts.join(' ')
}

function labelToken(token: string): string {
  if (TOKEN_LABELS[token]) return TOKEN_LABELS[token]
  // Version tokens (`2.5`, `3.1`) and anything else numeric pass through as-is.
  if (/^[\d.]+$/.test(token)) return token
  return token.charAt(0).toUpperCase() + token.slice(1)
}

/**
 * Renderer-side helper for surfaces that hold only a persisted model id: the
 * derived label for a `gemini-api:` id, null for anything else (agy-lane ids,
 * `cli-default`, malformed) so callers keep their existing fallback.
 */
export function antigravityGeminiApiModelDisplayLabel(
  modelId: string | null | undefined
): string | null {
  if (typeof modelId !== 'string') return null
  const trimmed = modelId.trim()
  if (!trimmed.toLowerCase().startsWith(ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX)) return null
  const bare = trimmed.slice(ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX.length)
  if (!bare) return null
  return antigravityGeminiApiModelLabel(bare)
}

/**
 * True for rows worth offering: a current family, not an alias, and not a dated
 * revision or dated preview of a row already in the list. A bare `-preview`
 * (e.g. `gemini-3.1-pro-preview`) is a real distinct offer and is kept.
 */
export function isCuratedAntigravityGeminiApiModelId(modelId: string): boolean {
  const tokens = modelIdTokens(modelId)
  if (tokens.length === 0) return false

  const last = tokens[tokens.length - 1]
  if (ALIAS_SUFFIXES.includes(last)) return false
  // A trailing pure-number token is a revision (`-001`) or the tail of a dated
  // preview (`-preview-09-2025`); the undated id covers both.
  if (/^\d+$/.test(last)) return false

  const version = Number.parseFloat(tokens[0])
  // A leading non-numeric token means an unversioned family (`omni`); keep it.
  if (!Number.isFinite(version) || !/^[\d.]+$/.test(tokens[0])) return true
  return version >= MIN_CURATED_VERSION
}

/**
 * Curates a discovered catalogue, but never to nothing: if no row survives, the
 * provider would disappear from every surface, which is exactly the failure the
 * static fallback exists to prevent. Tidier is not worth invisible.
 */
export function curateAntigravityGeminiApiModels<T extends { id: string }>(rows: T[]): T[] {
  const curated = rows.filter((row) =>
    isCuratedAntigravityGeminiApiModelId(row.id.replace(ANTIGRAVITY_GEMINI_API_MODEL_ID_PREFIX, ''))
  )
  return curated.length > 0 ? curated : rows
}
