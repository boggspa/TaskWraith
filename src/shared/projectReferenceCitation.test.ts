import { describe, expect, it } from 'vitest'

import {
  MAX_PROJECT_REFERENCE_CITATION_QUOTE_PREVIEW,
  PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER,
  PROJECT_REFERENCE_CITATION_OPEN,
  buildValidatedCitationsFromAssistantText,
  formatProjectReferenceCitationToken,
  parseCitationsFromAssistantText,
  replaceCitationTokensWithPlaceholders,
  validateCitation
} from './projectReferenceCitation'

describe('project reference citation tokens', () => {
  it('formats the canonical ⟦pref:<referenceId>:<start>-<end>⟧ token', () => {
    expect(formatProjectReferenceCitationToken('ref-a', 12, 40)).toBe('⟦pref:ref-a:12-40⟧')
    expect(
      formatProjectReferenceCitationToken('ref-a', 12, 40).startsWith(
        PROJECT_REFERENCE_CITATION_OPEN
      )
    ).toBe(true)
  })

  it('parses citation spans from assistant text in order', () => {
    const a = formatProjectReferenceCitationToken('ref-a', 0, 5)
    const b = formatProjectReferenceCitationToken('ref-b', 10, 20)
    const text = `Claim one ${a} and claim two ${b}.`
    expect(parseCitationsFromAssistantText(text)).toEqual([
      {
        referenceId: 'ref-a',
        startOffset: 0,
        endOffset: 5,
        token: a,
        index: text.indexOf(a)
      },
      {
        referenceId: 'ref-b',
        startOffset: 10,
        endOffset: 20,
        token: b,
        index: text.indexOf(b)
      }
    ])
  })

  it('ignores malformed tokens and recall tokens', () => {
    const text = '⟦pref:⟧ ⟦pref:ref:bad⟧ ⟦pref:ref-a:1-⟧ ⟦pref:ref-a:x-2⟧ ⟦recall:read:r1⟧ plain'
    expect(parseCitationsFromAssistantText(text)).toEqual([])
  })

  it('rejects inverted or equal offsets at parse time', () => {
    expect(parseCitationsFromAssistantText('⟦pref:ref-a:10-10⟧')).toEqual([])
    expect(parseCitationsFromAssistantText('⟦pref:ref-a:10-9⟧')).toEqual([])
  })
})

describe('validateCitation', () => {
  const extractText = 'abcdefghijklmnopqrstuvwxyz' // length 26

  it('keeps in-range spans and builds ≤200 char quotePreview metadata', () => {
    const span = parseCitationsFromAssistantText('⟦pref:ref-a:2-8⟧')[0]!
    const meta = validateCitation(span, extractText, {
      extractId: 'extract-1',
      title: 'Brief'
    })
    expect(meta).toEqual({
      schemaVersion: 1,
      referenceId: 'ref-a',
      extractId: 'extract-1',
      title: 'Brief',
      startOffset: 2,
      endOffset: 8,
      quotePreview: 'cdefgh'
    })
  })

  it('truncates quotePreview to the documented max', () => {
    const long = 'x'.repeat(500)
    const span = {
      referenceId: 'ref-a',
      startOffset: 0,
      endOffset: 500,
      token: formatProjectReferenceCitationToken('ref-a', 0, 500),
      index: 0
    }
    const meta = validateCitation(span, long, { extractId: 'e1', title: 'T' })
    expect(meta?.quotePreview).toHaveLength(MAX_PROJECT_REFERENCE_CITATION_QUOTE_PREVIEW)
    expect(meta?.quotePreview).toBe('x'.repeat(MAX_PROJECT_REFERENCE_CITATION_QUOTE_PREVIEW))
  })

  it('drops out-of-range spans (fail closed)', () => {
    const span = {
      referenceId: 'ref-a',
      startOffset: 20,
      endOffset: 40,
      token: formatProjectReferenceCitationToken('ref-a', 20, 40),
      index: 0
    }
    expect(validateCitation(span, extractText, { extractId: 'e1', title: 'T' })).toBeNull()
  })

  it('drops negative offsets even if somehow constructed', () => {
    const span = {
      referenceId: 'ref-a',
      startOffset: -1,
      endOffset: 4,
      token: '⟦pref:ref-a:-1-4⟧',
      index: 0
    }
    expect(validateCitation(span, extractText, { extractId: 'e1', title: 'T' })).toBeNull()
  })

  it('derives pageNumber from page map when not explicit', () => {
    const span = parseCitationsFromAssistantText('⟦pref:ref-a:12-15⟧')[0]!
    const meta = validateCitation(span, extractText, {
      extractId: 'e1',
      title: 'PDF',
      pages: [
        { pageNumber: 1, startOffset: 0, endOffset: 10 },
        { pageNumber: 2, startOffset: 10, endOffset: 26 }
      ]
    })
    expect(meta?.pageNumber).toBe(2)
  })

  it('prefers an explicit pageNumber over page-map derivation', () => {
    const span = parseCitationsFromAssistantText('⟦pref:ref-a:12-15⟧')[0]!
    const meta = validateCitation(span, extractText, {
      extractId: 'e1',
      title: 'PDF',
      pageNumber: 9,
      pages: [{ pageNumber: 2, startOffset: 10, endOffset: 26 }]
    })
    expect(meta?.pageNumber).toBe(9)
  })
})

describe('token replacement for renderer', () => {
  it('replaces citation tokens with the chip placeholder marker', () => {
    const token = formatProjectReferenceCitationToken('ref-a', 0, 4)
    const text = `Before ${token} after`
    expect(replaceCitationTokensWithPlaceholders(text, [token])).toBe(
      `Before ${PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER} after`
    )
  })

  it('buildValidatedCitationsFromAssistantText validates, metadata-attaches, and strips tokens', () => {
    const extractText = 'hello world'
    const token = formatProjectReferenceCitationToken('ref-a', 0, 5)
    const ghost = formatProjectReferenceCitationToken('ref-a', 0, 99)
    const text = `Quote ${token} then ${ghost}.`
    const result = buildValidatedCitationsFromAssistantText(text, (referenceId) =>
      referenceId === 'ref-a' ? { extractId: 'extract-1', title: 'Hello', extractText } : null
    )
    expect(result.citations).toEqual([
      {
        schemaVersion: 1,
        referenceId: 'ref-a',
        extractId: 'extract-1',
        title: 'Hello',
        startOffset: 0,
        endOffset: 5,
        quotePreview: 'hello'
      }
    ])
    expect(result.displayText).toBe(`Quote ${PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER} then .`)
    expect(result.displayText).not.toContain(PROJECT_REFERENCE_CITATION_OPEN)
  })
})
