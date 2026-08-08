/**
 * One-shot handoff from a transcript citation chip to the Work Refs viewer.
 * Mirrors officeOpenRequest: App holds the pending request; the dock consumes
 * it by nonce and clears. Never a grant or agent capability.
 */

export interface ProjectReferenceCitationOpenRequest {
  projectId?: string
  referenceId: string
  extractId: string
  startOffset: number
  endOffset: number
  pageNumber?: number
  nonce: number
}

export type ProjectReferenceCitationOpenRequestInput = Omit<
  ProjectReferenceCitationOpenRequest,
  'nonce'
>

/** Build the next Refs-viewer open request, bumping `previousNonce`. */
export function createProjectReferenceCitationOpenRequest(
  input: ProjectReferenceCitationOpenRequestInput,
  previousNonce = 0
): ProjectReferenceCitationOpenRequest {
  return {
    referenceId: input.referenceId,
    extractId: input.extractId,
    startOffset: input.startOffset,
    endOffset: input.endOffset,
    nonce: previousNonce + 1,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.pageNumber !== undefined ? { pageNumber: input.pageNumber } : {})
  }
}

/** Clear helper for React state (`setRequest(clear…())`). */
export function clearProjectReferenceCitationOpenRequest(): null {
  return null
}
