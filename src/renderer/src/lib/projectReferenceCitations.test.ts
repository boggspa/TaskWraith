import { describe, expect, it } from 'vitest'

import {
  PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER,
  formatProjectReferenceCitationToken,
  type ProjectReferenceCitationMetadata
} from '../../../shared/projectReferenceCitation'
import {
  attachProjectReferenceCitationChips,
  prepareProjectReferenceCitationsForRender,
  projectReferenceCitationChipModel,
  segmentAssistantTextWithProjectReferenceCitations
} from './projectReferenceCitations'

const citation = (
  overrides: Partial<ProjectReferenceCitationMetadata> = {}
): ProjectReferenceCitationMetadata => ({
  schemaVersion: 1,
  referenceId: 'ref-a',
  extractId: 'extract-1',
  title: 'Research Brief',
  startOffset: 0,
  endOffset: 5,
  quotePreview: 'hello',
  ...overrides
})

describe('segmentAssistantTextWithProjectReferenceCitations', () => {
  it('splits assistant text into text + citation chip segments from metadata tokens', () => {
    const meta = citation()
    const token = formatProjectReferenceCitationToken(
      meta.referenceId,
      meta.startOffset,
      meta.endOffset
    )
    const text = `See ${token} please.`
    expect(segmentAssistantTextWithProjectReferenceCitations(text, [meta])).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'citation', citation: meta },
      { kind: 'text', text: ' please.' }
    ])
  })

  it('maps chip placeholders left by strip/replace back onto metadata in order', () => {
    const a = citation({
      referenceId: 'ref-a',
      title: 'A',
      startOffset: 0,
      endOffset: 2,
      quotePreview: 'ab'
    })
    const b = citation({
      referenceId: 'ref-b',
      extractId: 'extract-2',
      title: 'B',
      startOffset: 3,
      endOffset: 6,
      quotePreview: 'def'
    })
    const text = `X${PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER}Y${PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER}Z`
    expect(segmentAssistantTextWithProjectReferenceCitations(text, [a, b])).toEqual([
      { kind: 'text', text: 'X' },
      { kind: 'citation', citation: a },
      { kind: 'text', text: 'Y' },
      { kind: 'citation', citation: b },
      { kind: 'text', text: 'Z' }
    ])
  })

  it('fails closed: metadata without a matching token/placeholder is not invented as a chip', () => {
    const meta = citation()
    expect(segmentAssistantTextWithProjectReferenceCitations('no tokens here', [meta])).toEqual([
      { kind: 'text', text: 'no tokens here' }
    ])
  })
})

describe('attachProjectReferenceCitationChips', () => {
  it('replaces tokens with placeholders and returns render-ready segments', () => {
    const meta = citation()
    const token = formatProjectReferenceCitationToken(
      meta.referenceId,
      meta.startOffset,
      meta.endOffset
    )
    const attached = attachProjectReferenceCitationChips(`Quote ${token}.`, [meta])
    expect(attached.displayText).toBe(`Quote ${PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER}.`)
    expect(attached.citations).toEqual([meta])
    expect(attached.segments).toEqual([
      { kind: 'text', text: 'Quote ' },
      { kind: 'citation', citation: meta },
      { kind: 'text', text: '.' }
    ])
  })
})

describe('projectReferenceCitationChipModel', () => {
  it('builds an available chip with viewer deep-link fields', () => {
    const meta = citation({ pageNumber: 3 })
    expect(projectReferenceCitationChipModel(meta, 'available')).toEqual({
      label: 'Research Brief',
      title: 'Research Brief',
      status: 'available',
      openTarget: {
        referenceId: 'ref-a',
        extractId: 'extract-1',
        startOffset: 0,
        endOffset: 5,
        pageNumber: 3
      }
    })
  })

  it('degrades revoked extracts to title-only chips without an open target', () => {
    const meta = citation()
    expect(projectReferenceCitationChipModel(meta, 'revoked')).toEqual({
      label: 'Extract revoked',
      title: 'Research Brief',
      status: 'revoked',
      openTarget: undefined
    })
  })
})

describe('prepareProjectReferenceCitationsForRender (integration-ready)', () => {
  it('parses, validates against extract text, and returns chip segments', () => {
    const tokenOk = formatProjectReferenceCitationToken('ref-a', 0, 5)
    const tokenBad = formatProjectReferenceCitationToken('ref-a', 0, 99)
    const prepared = prepareProjectReferenceCitationsForRender({
      assistantText: `Ok ${tokenOk} bad ${tokenBad}`,
      resolveExtract: (referenceId) =>
        referenceId === 'ref-a'
          ? { extractId: 'extract-1', title: 'Hello', extractText: 'hello world' }
          : null
    })
    expect(prepared.citations).toHaveLength(1)
    expect(prepared.citations[0]?.quotePreview).toBe('hello')
    expect(prepared.displayText).toBe(`Ok ${PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER} bad `)
    expect(prepared.segments.filter((s) => s.kind === 'citation')).toHaveLength(1)
  })

  it('degrades missing extracts to referenceId chips when opted in', () => {
    const token = formatProjectReferenceCitationToken('orphan-ref', 0, 4)
    const prepared = prepareProjectReferenceCitationsForRender({
      assistantText: `See ${token}.`,
      resolveExtract: () => null,
      degradeMissingExtracts: true
    })
    expect(prepared.citations).toEqual([
      {
        schemaVersion: 1,
        referenceId: 'orphan-ref',
        extractId: 'orphan-ref',
        title: 'orphan-ref',
        startOffset: 0,
        endOffset: 4,
        quotePreview: ''
      }
    ])
    expect(prepared.segments.filter((s) => s.kind === 'citation')).toHaveLength(1)
    expect(prepared.displayText).toBe(`See ${PROJECT_REFERENCE_CITATION_CHIP_PLACEHOLDER}.`)
  })
})
