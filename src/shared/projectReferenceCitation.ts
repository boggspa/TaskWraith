/**
 * Project reference citation tokens — same delimiter family as recall
 * citations (`⟦…⟧`), with a `pref:` prefix for consentful extract spans.
 *
 * Canonical token form (agents must quote verbatim):
 *   ⟦pref:<referenceId>:<startOffset>-<endOffset>⟧
 *
 * - `referenceId` is a non-empty catalogue id; it must not contain `:` or `⟧`
 *   so the token remains unambiguous under a single-pass regex.
 * - Offsets are JavaScript string indices (UTF-16 code units), half-open
 *   `[startOffset, endOffset)`, relative to the consentful extract text.
 * - Invalid / out-of-range spans fail closed (dropped); never invent chips.
 *
 * After validation, tokens are typically replaced with
 * `PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER` so the renderer can attach
 * chips from `ProjectReferenceCitationMetadata` without leaving raw tokens
 * in the bubble text.
 */

export const PROJECT_REFERENCE_CITATION_OPEN = '⟦pref:'
export const PROJECT_REFERENCE_CITATION_CLOSE = '⟧'

/** Unicode OBJECT REPLACEMENT CHARACTER — stable chip slot for the renderer. */
export const PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER = '\uFFFC'

export const MAX_PROJECT_REFERENCE_CITATION_QUOTE_PREVIEW = 200
export const MAX_PROJECT_REFERENCE_CITATION_ID_LENGTH = 256
export const MAX_PROJECT_REFERENCE_CITATION_TITLE_LENGTH = 512

const CITATION_RE = /⟦pref:([^:⟧]+):(\d+)-(\d+)⟧/g

export interface ProjectReferenceCitationSpan {
  referenceId: string
  startOffset: number
  endOffset: number
  /** Exact matched token including delimiters. */
  token: string
  /** Index of the token start in the source assistant text. */
  index: number
}

export interface ProjectReferenceCitationMetadata {
  schemaVersion: 1
  referenceId: string
  extractId: string
  title: string
  startOffset: number
  endOffset: number
  pageNumber?: number
  quotePreview: string
}

export interface ProjectReferenceCitationExtractContext {
  extractId: string
  title: string
  /** Explicit page; wins over `pages` derivation when set. */
  pageNumber?: number
  pages?: ReadonlyArray<{ pageNumber: number; startOffset: number; endOffset: number }>
}

export interface ProjectReferenceCitationExtractResolution extends ProjectReferenceCitationExtractContext {
  extractText: string
}

/** Wrap a span in the canonical quotable form the agent must paste. */
export function formatProjectReferenceCitationToken(
  referenceId: string,
  startOffset: number,
  endOffset: number
): string {
  return `${PROJECT_REFERENCE_CITATION_OPEN}${referenceId}:${startOffset}-${endOffset}${PROJECT_REFERENCE_CITATION_CLOSE}`
}

function isFiniteNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0
}

/**
 * Parse citation spans from assistant text. Malformed tokens, inverted /
 * empty ranges, and overlong ids are skipped (fail closed).
 */
export function parseCitationsFromAssistantText(text: string): ProjectReferenceCitationSpan[] {
  if (!text || !text.includes(PROJECT_REFERENCE_CITATION_OPEN)) return []
  const spans: ProjectReferenceCitationSpan[] = []
  CITATION_RE.lastIndex = 0
  for (const match of text.matchAll(CITATION_RE)) {
    const referenceId = match[1]?.trim() ?? ''
    if (!referenceId || referenceId.length > MAX_PROJECT_REFERENCE_CITATION_ID_LENGTH) continue
    const startOffset = Number(match[2])
    const endOffset = Number(match[3])
    if (!isFiniteNonNegativeInt(startOffset) || !isFiniteNonNegativeInt(endOffset)) continue
    if (endOffset <= startOffset) continue
    spans.push({
      referenceId,
      startOffset,
      endOffset,
      token: match[0],
      index: match.index ?? 0
    })
  }
  return spans
}

function resolvePageNumber(
  startOffset: number,
  endOffset: number,
  context: ProjectReferenceCitationExtractContext
): number | undefined {
  if (
    typeof context.pageNumber === 'number' &&
    Number.isInteger(context.pageNumber) &&
    context.pageNumber > 0
  ) {
    return context.pageNumber
  }
  const pages = context.pages
  if (!pages || pages.length === 0) return undefined
  for (const page of pages) {
    if (
      !Number.isInteger(page.pageNumber) ||
      page.pageNumber <= 0 ||
      !isFiniteNonNegativeInt(page.startOffset) ||
      !isFiniteNonNegativeInt(page.endOffset) ||
      page.endOffset <= page.startOffset
    ) {
      continue
    }
    // Span must sit entirely inside the page range.
    if (startOffset >= page.startOffset && endOffset <= page.endOffset) {
      return page.pageNumber
    }
  }
  return undefined
}

/**
 * Validate a parsed span against extract text. Out-of-range / inverted spans
 * return null. `quotePreview` is the in-range slice, capped at 200 chars.
 */
export function validateCitation(
  span: ProjectReferenceCitationSpan,
  extractText: string,
  context: ProjectReferenceCitationExtractContext
): ProjectReferenceCitationMetadata | null {
  if (!span || typeof extractText !== 'string') return null
  const extractId = typeof context.extractId === 'string' ? context.extractId.trim() : ''
  const title = typeof context.title === 'string' ? context.title.trim() : ''
  if (
    !extractId ||
    extractId.length > MAX_PROJECT_REFERENCE_CITATION_ID_LENGTH ||
    !title ||
    title.length > MAX_PROJECT_REFERENCE_CITATION_TITLE_LENGTH
  ) {
    return null
  }
  const { referenceId, startOffset, endOffset } = span
  if (
    typeof referenceId !== 'string' ||
    !referenceId.trim() ||
    referenceId.length > MAX_PROJECT_REFERENCE_CITATION_ID_LENGTH
  ) {
    return null
  }
  if (!isFiniteNonNegativeInt(startOffset) || !isFiniteNonNegativeInt(endOffset)) return null
  if (endOffset <= startOffset) return null
  if (endOffset > extractText.length) return null

  const quotePreview = extractText
    .slice(startOffset, endOffset)
    .slice(0, MAX_PROJECT_REFERENCE_CITATION_QUOTE_PREVIEW)
  const pageNumber = resolvePageNumber(startOffset, endOffset, context)
  return {
    schemaVersion: 1,
    referenceId: referenceId.trim(),
    extractId,
    title,
    startOffset,
    endOffset,
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    quotePreview
  }
}

/** Replace each listed token (exact) with the chip placeholder marker. */
export function replaceCitationTokensWithPlaceholders(
  text: string,
  tokens: ReadonlyArray<string>,
  placeholder: string = PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER
): string {
  if (!text || tokens.length === 0) return text
  let out = text
  // Longest-first so overlapping accidental substrings cannot partial-replace.
  const unique = [...new Set(tokens.filter((token) => token.length > 0))].sort(
    (a, b) => b.length - a.length
  )
  for (const token of unique) {
    out = out.split(token).join(placeholder)
  }
  return out
}

/**
 * Parse → validate against a per-reference extract resolver → replace kept
 * tokens with chip placeholders. Unknown reference ids and out-of-range spans
 * are dropped (and their tokens stripped without a chip).
 */
export function buildValidatedCitationsFromAssistantText(
  text: string,
  resolveExtract: (referenceId: string) => ProjectReferenceCitationExtractResolution | null
): { citations: ProjectReferenceCitationMetadata[]; displayText: string } {
  const spans = parseCitationsFromAssistantText(text)
  const citations: ProjectReferenceCitationMetadata[] = []
  const keptTokens: string[] = []
  const dropTokens: string[] = []

  for (const span of spans) {
    const resolved = resolveExtract(span.referenceId)
    if (!resolved) {
      dropTokens.push(span.token)
      continue
    }
    const meta = validateCitation(span, resolved.extractText, resolved)
    if (!meta) {
      dropTokens.push(span.token)
      continue
    }
    citations.push(meta)
    keptTokens.push(span.token)
  }

  let displayText = replaceCitationTokensWithPlaceholders(text, keptTokens)
  // Invalid tokens are stripped to empty (no invented chip).
  displayText = replaceCitationTokensWithPlaceholders(displayText, dropTokens, '')
  return { citations, displayText }
}
