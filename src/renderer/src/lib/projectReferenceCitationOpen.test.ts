import { describe, expect, it } from 'vitest'
import {
  clearProjectReferenceCitationOpenRequest,
  createProjectReferenceCitationOpenRequest
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
})
