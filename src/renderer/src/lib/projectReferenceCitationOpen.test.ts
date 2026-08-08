import { describe, expect, it } from 'vitest'
import {
  clearProjectReferenceCitationOpenRequest,
  createProjectReferenceCitationOpenRequest,
  decideProjectReferenceCitationOpen
} from './projectReferenceCitationOpen'

describe('projectReferenceCitationOpen', () => {
  it('creates a nonce-bumping Refs-viewer open request and clears to null', () => {
    const first = createProjectReferenceCitationOpenRequest(
      {
        projectId: 'project-a',
        referenceId: 'ref-brief',
        extractId: 'extract-1',
        startOffset: 0,
        endOffset: 12,
        pageNumber: 2
      },
      0
    )
    expect(first).toEqual({
      projectId: 'project-a',
      referenceId: 'ref-brief',
      extractId: 'extract-1',
      startOffset: 0,
      endOffset: 12,
      pageNumber: 2,
      nonce: 1
    })

    const second = createProjectReferenceCitationOpenRequest(
      {
        referenceId: 'ref-brief',
        extractId: 'extract-1',
        startOffset: 4,
        endOffset: 8
      },
      first.nonce
    )
    expect(second.nonce).toBe(2)
    expect(second.projectId).toBeUndefined()
    expect(second.pageNumber).toBeUndefined()

    expect(clearProjectReferenceCitationOpenRequest()).toBeNull()
  })

  it('waits when the reference exists but extracts have not hydrated yet', () => {
    expect(
      decideProjectReferenceCitationOpen({
        referenceId: 'ref-brief',
        requestExtractId: 'ref-brief',
        referenceFound: true,
        cached: undefined
      })
    ).toEqual({ action: 'wait' })
  })

  it('prefers a ready cached extract id over a degraded request extractId', () => {
    const cached = {
      id: 'extract-real',
      status: 'ready' as const
    }
    expect(
      decideProjectReferenceCitationOpen({
        referenceId: 'ref-brief',
        requestExtractId: 'ref-brief',
        referenceFound: true,
        cached
      })
    ).toEqual({ action: 'open', extractId: 'extract-real', cached })
  })

  it('opens with the request extractId when cache is not ready and ids differ', () => {
    expect(
      decideProjectReferenceCitationOpen({
        referenceId: 'ref-brief',
        requestExtractId: 'extract-from-resolver',
        referenceFound: true,
        cached: { id: 'extract-stale', status: 'stale' }
      })
    ).toEqual({
      action: 'open',
      extractId: 'extract-from-resolver',
      cached: { id: 'extract-stale', status: 'stale' }
    })
  })

  it('reports unavailable when hydrated with no ready extract and degraded id', () => {
    expect(
      decideProjectReferenceCitationOpen({
        referenceId: 'ref-brief',
        requestExtractId: 'ref-brief',
        referenceFound: true,
        cached: null
      })
    ).toEqual({ action: 'unavailable' })
  })

  it('reports missing when the reference is not in the dock library', () => {
    expect(
      decideProjectReferenceCitationOpen({
        referenceId: 'ref-gone',
        requestExtractId: 'extract-1',
        referenceFound: false,
        cached: undefined
      })
    ).toEqual({ action: 'missing' })
  })
})
