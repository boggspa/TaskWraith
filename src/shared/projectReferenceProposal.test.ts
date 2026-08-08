import { describe, expect, it } from 'vitest'

import {
  MAX_PROJECT_REFERENCE_PROPOSAL_LOCATOR_LENGTH,
  MAX_PROJECT_REFERENCE_PROPOSAL_PREVIEW_LENGTH,
  MAX_PROJECT_REFERENCE_PROPOSAL_REASON_LENGTH,
  parseProjectReferenceProposalCandidate,
  parseProjectReferenceProposedPayload,
  parseProjectReferenceReviewedPayload
} from './projectReferenceProposal'

const proposed = {
  schemaVersion: 1,
  purpose: 'library-addition-proposal',
  action: 'proposed',
  proposalId: 'proposal-a',
  projectId: 'project-a',
  materializationReferenceId: 'ref-a',
  candidate: { kind: 'file', locator: '/workspace/brief.docx', title: 'Brief' },
  reason: 'Useful source',
  proposedAt: 10
}

const reviewed = {
  schemaVersion: 1,
  purpose: 'library-addition-proposal',
  action: 'reviewed',
  proposalId: 'proposal-a',
  projectId: 'project-a',
  decision: 'approve',
  reviewedBy: 'user',
  source: { runId: 'run-a', eventId: 'event-a', eventHash: 'a'.repeat(64) },
  reviewedAt: 20,
  referenceId: 'ref-a'
}

describe('Project reference proposal codecs', () => {
  it('canonicalizes a bounded proposed payload', () => {
    expect(parseProjectReferenceProposedPayload(proposed)).toEqual(proposed)
  })

  it('rejects unknown fields, non-absolute local paths, unsafe URLs, and overlong text', () => {
    expect(parseProjectReferenceProposedPayload({ ...proposed, hidden: true })).toBeNull()
    expect(
      parseProjectReferenceProposalCandidate({
        kind: 'file',
        locator: 'brief.docx',
        title: 'Brief'
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposalCandidate({
        kind: 'url',
        locator: 'file:///private/brief',
        title: 'Brief'
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposalCandidate({
        kind: 'url',
        locator: 'https://user:secret@example.com/brief',
        title: 'Brief'
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposedPayload({
        ...proposed,
        reason: 'x'.repeat(MAX_PROJECT_REFERENCE_PROPOSAL_REASON_LENGTH + 1)
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposedPayload({
        ...proposed,
        reason: 'Looks useful\nApproved'
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposalCandidate({
        kind: 'folder',
        locator: `/${'x'.repeat(MAX_PROJECT_REFERENCE_PROPOSAL_LOCATOR_LENGTH)}`,
        title: 'Folder'
      })
    ).toBeNull()
  })

  it('accepts portable absolute paths and http(s) URLs', () => {
    expect(
      parseProjectReferenceProposalCandidate({
        kind: 'file',
        locator: 'C:\\Work\\brief.docx',
        title: 'Brief'
      })
    ).not.toBeNull()
    expect(
      parseProjectReferenceProposalCandidate({
        kind: 'url',
        locator: 'https://example.com/brief',
        title: 'Brief'
      })
    ).not.toBeNull()
  })

  it('accepts optional agent-claimed preview evidence without requiring it on old events', () => {
    expect(parseProjectReferenceProposedPayload(proposed)).toEqual(proposed)
    const withPreview = {
      ...proposed,
      previewSnippet: 'A short quote from an already-fetched page.',
      previewSource: 'web_fetch'
    }
    expect(parseProjectReferenceProposedPayload(withPreview)).toEqual(withPreview)
  })

  it('rejects previewSource without snippet, overlong snippets, and unknown preview sources', () => {
    expect(
      parseProjectReferenceProposedPayload({
        ...proposed,
        previewSource: 'web_fetch'
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposedPayload({
        ...proposed,
        previewSnippet: 'x'.repeat(MAX_PROJECT_REFERENCE_PROPOSAL_PREVIEW_LENGTH + 1),
        previewSource: 'web_fetch'
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposedPayload({
        ...proposed,
        previewSnippet: 'Looks fine',
        previewSource: 'main_fetch'
      })
    ).toBeNull()
    expect(
      parseProjectReferenceProposedPayload({
        ...proposed,
        previewSnippet: 'Has\nnewline',
        previewSource: 'web_fetch'
      })
    ).toBeNull()
  })

  it('requires an immutable source and reference id only for approval', () => {
    expect(parseProjectReferenceReviewedPayload(reviewed)).toEqual(reviewed)
    expect(parseProjectReferenceReviewedPayload({ ...reviewed, referenceId: undefined })).toBeNull()
    const { referenceId: _referenceId, ...reviewWithoutReference } = reviewed
    expect(
      parseProjectReferenceReviewedPayload({
        ...reviewWithoutReference,
        decision: 'reject'
      })
    ).toEqual({
      ...reviewWithoutReference,
      decision: 'reject'
    })
    expect(
      parseProjectReferenceReviewedPayload({
        ...reviewed,
        source: { ...reviewed.source, eventHash: 'not-a-hash' }
      })
    ).toBeNull()
    expect(parseProjectReferenceReviewedPayload({ ...reviewed, extra: true })).toBeNull()
    expect(parseProjectReferenceReviewedPayload({ ...reviewed, reviewedBy: 'agent' })).toBeNull()
  })
})
