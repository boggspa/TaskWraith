/**
 * Renderer helpers for Project reference citation chips.
 *
 * Pure — no React, no IPC. MessageBubble / MarkdownMessage can consume
 * `prepareProjectReferenceCitationsForRender` (or `attachProjectReferenceCitationChips`
 * when metadata already exists) to turn validated citations into text/chip
 * segments. Full bubble UI is intentionally not built here.
 */

import {
  PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER,
  buildValidatedCitationsFromAssistantText,
  formatProjectReferenceCitationToken,
  replaceCitationTokensWithPlaceholders,
  type ProjectReferenceCitationExtractResolution,
  type ProjectReferenceCitationMetadata
} from '../../../shared/projectReferenceCitation'

export type ProjectReferenceCitationSegment =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; citation: ProjectReferenceCitationMetadata }

export type ProjectReferenceCitationChipStatus = 'available' | 'revoked' | 'missing'

export interface ProjectReferenceCitationOpenTarget {
  referenceId: string
  extractId: string
  startOffset: number
  endOffset: number
  pageNumber?: number
}

export interface ProjectReferenceCitationChipModel {
  label: string
  title: string
  status: ProjectReferenceCitationChipStatus
  openTarget?: ProjectReferenceCitationOpenTarget
}

function tokenForCitation(citation: ProjectReferenceCitationMetadata): string {
  return formatProjectReferenceCitationToken(
    citation.referenceId,
    citation.startOffset,
    citation.endOffset
  )
}

/**
 * Split assistant text into text/citation segments using either:
 * - live `⟦pref:…⟧` tokens that match metadata, or
 * - chip placeholders previously left by strip/replace, consumed in metadata order.
 *
 * Metadata without a matching token/placeholder is not invented as a chip.
 */
export function segmentAssistantTextWithProjectReferenceCitations(
  text: string,
  citations: ReadonlyArray<ProjectReferenceCitationMetadata>
): ProjectReferenceCitationSegment[] {
  if (!text) return []
  if (citations.length === 0) return [{ kind: 'text', text }]

  type Hit = { start: number; end: number; citation: ProjectReferenceCitationMetadata }
  const hits: Hit[] = []
  let placeholderCursor = 0

  // Prefer exact token matches; fall back to placeholders in citation order.
  for (const citation of citations) {
    const token = tokenForCitation(citation)
    const tokenIndex = text.indexOf(token)
    if (tokenIndex >= 0) {
      hits.push({ start: tokenIndex, end: tokenIndex + token.length, citation })
      continue
    }
    if (!text.includes(PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER)) continue
    const from = placeholderCursor
    const placeholderIndex = text.indexOf(PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER, from)
    if (placeholderIndex < 0) continue
    hits.push({
      start: placeholderIndex,
      end: placeholderIndex + PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER.length,
      citation
    })
    placeholderCursor = placeholderIndex + PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER.length
  }

  hits.sort((a, b) => a.start - b.start || a.end - b.end)

  // Drop overlapping hits (keep earliest).
  const ordered: Hit[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start < cursor) continue
    ordered.push(hit)
    cursor = hit.end
  }

  if (ordered.length === 0) return [{ kind: 'text', text }]

  const segments: ProjectReferenceCitationSegment[] = []
  let offset = 0
  for (const hit of ordered) {
    if (hit.start > offset) {
      segments.push({ kind: 'text', text: text.slice(offset, hit.start) })
    }
    segments.push({ kind: 'citation', citation: hit.citation })
    offset = hit.end
  }
  if (offset < text.length) {
    segments.push({ kind: 'text', text: text.slice(offset) })
  }
  return segments
}

/**
 * Attach chips from already-validated metadata: replace matching tokens with
 * placeholders and return display text + segments.
 */
export function attachProjectReferenceCitationChips(
  text: string,
  citations: ReadonlyArray<ProjectReferenceCitationMetadata>
): {
  displayText: string
  citations: ProjectReferenceCitationMetadata[]
  segments: ProjectReferenceCitationSegment[]
} {
  const tokens = citations.map(tokenForCitation)
  const displayText = replaceCitationTokensWithPlaceholders(text, tokens)
  const segments = segmentAssistantTextWithProjectReferenceCitations(displayText, citations)
  return {
    displayText,
    citations: [...citations],
    segments
  }
}

/** Presentation model for a single chip (available vs revoked/missing). */
export function projectReferenceCitationChipModel(
  citation: ProjectReferenceCitationMetadata,
  status: ProjectReferenceCitationChipStatus
): ProjectReferenceCitationChipModel {
  if (status === 'revoked') {
    return {
      label: 'Extract revoked',
      title: citation.title,
      status,
      openTarget: undefined
    }
  }
  if (status === 'missing') {
    return {
      label: 'Extract unavailable',
      title: citation.title,
      status,
      openTarget: undefined
    }
  }
  return {
    label: citation.title,
    title: citation.title,
    status: 'available',
    openTarget: {
      referenceId: citation.referenceId,
      extractId: citation.extractId,
      startOffset: citation.startOffset,
      endOffset: citation.endOffset,
      ...(citation.pageNumber !== undefined ? { pageNumber: citation.pageNumber } : {})
    }
  }
}

/**
 * Integration-ready entry: parse + validate assistant text against extract
 * resolvers, strip invalid tokens, and return chip segments for a bubble.
 */
export function prepareProjectReferenceCitationsForRender(input: {
  assistantText: string
  resolveExtract: (referenceId: string) => ProjectReferenceCitationExtractResolution | null
}): {
  displayText: string
  citations: ProjectReferenceCitationMetadata[]
  segments: ProjectReferenceCitationSegment[]
} {
  const built = buildValidatedCitationsFromAssistantText(input.assistantText, input.resolveExtract)
  const segments = segmentAssistantTextWithProjectReferenceCitations(
    built.displayText,
    built.citations
  )
  return {
    displayText: built.displayText,
    citations: built.citations,
    segments
  }
}
