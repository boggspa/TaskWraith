import { describe, expect, it } from 'vitest'

import {
  MAX_PROJECT_REFERENCE_EXTRACT_ERROR_MESSAGE_LENGTH,
  MAX_PROJECT_REFERENCE_EXTRACT_LOCATOR_LENGTH,
  parseProjectReferenceExtract,
  parseProjectReferenceExtractConsent,
  parseProjectReferenceExtractKind,
  parseProjectReferenceExtractStatus
} from './projectReferenceExtract'

const consent = {
  at: 100,
  actor: 'user' as const,
  scope: 'this-reference' as const,
  chatId: 'chat-a'
}

const readyExtract = {
  schemaVersion: 1 as const,
  id: 'extract-a',
  projectId: 'project-a',
  referenceId: 'ref-a',
  kind: 'url-html' as const,
  status: 'ready' as const,
  consent,
  source: {
    locator: 'https://example.com/doc',
    contentSha256: 'a'.repeat(64),
    http: { finalUrl: 'https://example.com/doc', status: 200, fetchedAt: 90 }
  },
  text: {
    charCount: 12,
    truncated: false,
    artifactSha256: 'b'.repeat(64)
  },
  createdAt: 100,
  updatedAt: 110
}

describe('projectReferenceExtract codecs', () => {
  it('parses kind and status enums', () => {
    expect(parseProjectReferenceExtractKind('url-html')).toBe('url-html')
    expect(parseProjectReferenceExtractKind('pdf-text')).toBe('pdf-text')
    expect(parseProjectReferenceExtractKind('office-text')).toBe('office-text')
    expect(parseProjectReferenceExtractKind('plain-text')).toBe('plain-text')
    expect(parseProjectReferenceExtractKind('rag')).toBeNull()

    expect(parseProjectReferenceExtractStatus('pending')).toBe('pending')
    expect(parseProjectReferenceExtractStatus('ready')).toBe('ready')
    expect(parseProjectReferenceExtractStatus('failed')).toBe('failed')
    expect(parseProjectReferenceExtractStatus('revoked')).toBe('revoked')
    expect(parseProjectReferenceExtractStatus('stale')).toBe('stale')
    expect(parseProjectReferenceExtractStatus('done')).toBeNull()
  })

  it('requires user consent scoped to this-reference', () => {
    expect(parseProjectReferenceExtractConsent(consent)).toEqual(consent)
    expect(
      parseProjectReferenceExtractConsent({ at: 1, actor: 'agent', scope: 'this-reference' })
    ).toBeNull()
    expect(
      parseProjectReferenceExtractConsent({ at: 1, actor: 'user', scope: 'project' })
    ).toBeNull()
    expect(parseProjectReferenceExtractConsent({ at: 1, actor: 'user' })).toBeNull()
  })

  it('round-trips a ready extract and rejects unknown keys', () => {
    expect(parseProjectReferenceExtract(readyExtract)).toEqual(readyExtract)
    expect(parseProjectReferenceExtract({ ...readyExtract, hidden: true })).toBeNull()
  })

  it('accepts pending without text and failed with a bounded error', () => {
    const pending = {
      schemaVersion: 1 as const,
      id: 'extract-b',
      projectId: 'project-a',
      referenceId: 'ref-a',
      kind: 'pdf-text' as const,
      status: 'pending' as const,
      consent: { at: 1, actor: 'user' as const, scope: 'this-reference' as const },
      source: {
        locator: '/workspace/brief.pdf',
        pageRange: { first: 1, last: 3 }
      },
      createdAt: 1,
      updatedAt: 1
    }
    expect(parseProjectReferenceExtract(pending)).toEqual(pending)

    const failed = {
      ...pending,
      status: 'failed' as const,
      error: { code: 'fetch_failed', message: 'Host unreachable' },
      updatedAt: 2
    }
    expect(parseProjectReferenceExtract(failed)).toEqual(failed)
  })

  it('rejects control/bidi in metadata strings and overlong fields', () => {
    expect(
      parseProjectReferenceExtract({
        ...readyExtract,
        source: { ...readyExtract.source, locator: 'https://example.com/\npath' }
      })
    ).toBeNull()
    expect(
      parseProjectReferenceExtract({
        ...readyExtract,
        source: {
          ...readyExtract.source,
          locator: `https://example.com/${'x'.repeat(MAX_PROJECT_REFERENCE_EXTRACT_LOCATOR_LENGTH)}`
        }
      })
    ).toBeNull()
    expect(
      parseProjectReferenceExtract({
        schemaVersion: 1,
        id: 'extract-c',
        projectId: 'project-a',
        referenceId: 'ref-a',
        kind: 'plain-text',
        status: 'failed',
        consent: { at: 1, actor: 'user', scope: 'this-reference' },
        source: { locator: '/workspace/a.txt' },
        error: {
          code: 'too_large',
          message: 'x'.repeat(MAX_PROJECT_REFERENCE_EXTRACT_ERROR_MESSAGE_LENGTH + 1)
        },
        createdAt: 1,
        updatedAt: 1
      })
    ).toBeNull()
    expect(
      parseProjectReferenceExtract({
        ...readyExtract,
        id: 'extract\u202Ea'
      })
    ).toBeNull()
  })

  it('requires text for ready and error for failed', () => {
    const { text: _text, ...withoutText } = readyExtract
    expect(parseProjectReferenceExtract(withoutText)).toBeNull()
    expect(
      parseProjectReferenceExtract({
        schemaVersion: 1,
        id: 'extract-d',
        projectId: 'project-a',
        referenceId: 'ref-a',
        kind: 'plain-text',
        status: 'failed',
        consent: { at: 1, actor: 'user', scope: 'this-reference' },
        source: { locator: '/workspace/a.txt' },
        createdAt: 1,
        updatedAt: 1
      })
    ).toBeNull()
  })
})
