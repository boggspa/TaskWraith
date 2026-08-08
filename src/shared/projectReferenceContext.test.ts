import { describe, expect, it } from 'vitest'

import {
  MAX_PROJECT_REFERENCE_CONTEXT_ITEMS,
  parseProjectReferenceContextSelection,
  parseResolvedProjectReferenceContext,
  projectReferenceContextDisclosure,
  serializeResolvedProjectReferenceContext
} from './projectReferenceContext'

describe('Project reference context codecs', () => {
  it('normalizes renderer intent and preserves explicit order', () => {
    expect(
      parseProjectReferenceContextSelection({
        schemaVersion: 1,
        projectId: ' project-a ',
        referenceIds: [' ref-b ', 'ref-a', 'ref-b']
      })
    ).toEqual({ schemaVersion: 1, projectId: 'project-a', referenceIds: ['ref-b', 'ref-a'] })
  })

  it('rejects empty, oversized, and future-version selections', () => {
    expect(
      parseProjectReferenceContextSelection({ schemaVersion: 1, projectId: 'p', referenceIds: [] })
    ).toBeNull()
    expect(
      parseProjectReferenceContextSelection({
        schemaVersion: 1,
        projectId: 'p',
        referenceIds: Array.from(
          { length: MAX_PROJECT_REFERENCE_CONTEXT_ITEMS + 1 },
          (_, index) => `r-${index}`
        )
      })
    ).toBeNull()
    expect(
      parseProjectReferenceContextSelection({
        schemaVersion: 2,
        projectId: 'p',
        referenceIds: ['r']
      })
    ).toBeNull()
  })

  it('accepts a canonical resolved bundle and produces locator-free disclosure', () => {
    const resolved = parseResolvedProjectReferenceContext({
      schemaVersion: 1,
      projectId: 'project-a',
      projectName: 'Alpha',
      references: [
        {
          id: 'ref-file',
          kind: 'file',
          title: 'Plan.docx',
          locator: '/workspace/Plan.docx',
          access: 'workspace'
        },
        {
          id: 'ref-url',
          kind: 'url',
          title: 'Brief',
          locator: 'https://example.com/brief',
          access: 'catalogue-only'
        }
      ]
    })

    expect(resolved).not.toBeNull()
    expect(serializeResolvedProjectReferenceContext(resolved!)).toContain('/workspace/Plan.docx')
    expect(projectReferenceContextDisclosure(resolved!)).not.toHaveProperty('references.0.locator')
    expect(JSON.stringify(projectReferenceContextDisclosure(resolved!))).not.toContain(
      '/workspace/Plan.docx'
    )
  })

  it('rejects duplicate ids and URLs that claim filesystem authority', () => {
    expect(
      parseResolvedProjectReferenceContext({
        schemaVersion: 1,
        projectId: 'project-a',
        projectName: 'Alpha',
        references: [
          {
            id: 'ref-url',
            kind: 'url',
            title: 'Brief',
            locator: 'https://example.com',
            access: 'workspace'
          }
        ]
      })
    ).toBeNull()
  })

  it('round-trips ready extract metadata with content digests (never full text)', () => {
    const digest = 'a'.repeat(64)
    const resolved = parseResolvedProjectReferenceContext({
      schemaVersion: 1,
      projectId: 'project-a',
      projectName: 'Alpha',
      references: [
        {
          id: 'ref-url',
          kind: 'url',
          title: 'Brief',
          locator: 'https://example.com/brief',
          access: 'catalogue-only',
          extract: {
            extractId: 'extract-1',
            status: 'ready',
            charCount: 12,
            truncated: true,
            contentDigest: digest
          }
        }
      ]
    })
    expect(resolved?.references[0].extract).toEqual({
      extractId: 'extract-1',
      status: 'ready',
      charCount: 12,
      truncated: true,
      contentDigest: digest
    })
    const serialized = serializeResolvedProjectReferenceContext(resolved!)
    expect(serialized).toContain(digest)
    expect(serialized).toContain('extract-1')
    expect(serialized).not.toContain('full extract body')
  })
})
