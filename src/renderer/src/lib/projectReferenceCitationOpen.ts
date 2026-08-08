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

/** Minimal extract shape the dock needs to decide an open. */
export interface ProjectReferenceCitationOpenCachedExtract {
  id: string
  status: string
}

export type ProjectReferenceCitationOpenDecision =
  | { action: 'wait' }
  | {
      action: 'open'
      extractId: string
      cached: ProjectReferenceCitationOpenCachedExtract | null
    }
  | { action: 'unavailable' }
  | { action: 'missing' }

/**
 * Decide how the Refs dock should handle a citation→viewer request.
 *
 * - Prefer a ready cached extract id (chips often degrade to extractId ===
 *   referenceId when App has no sync resolver).
 * - Wait while extracts for a known reference have not hydrated yet, so we
 *   do not consume the nonce and then fail permanently.
 * - Open with the request extractId when it is distinct from referenceId
 *   even if the cache is not ready (resolver-supplied identity).
 */
export function decideProjectReferenceCitationOpen(input: {
  referenceId: string
  requestExtractId: string
  referenceFound: boolean
  /** `undefined` = not hydrated yet; `null` = hydrated, no extract. */
  cached: ProjectReferenceCitationOpenCachedExtract | null | undefined
}): ProjectReferenceCitationOpenDecision {
  if (!input.referenceFound) return { action: 'missing' }
  if (input.cached === undefined) return { action: 'wait' }
  if (input.cached?.status === 'ready' && input.cached.id) {
    return { action: 'open', extractId: input.cached.id, cached: input.cached }
  }
  const degraded = !input.requestExtractId || input.requestExtractId === input.referenceId
  if (!degraded) {
    return {
      action: 'open',
      extractId: input.requestExtractId,
      cached: input.cached
    }
  }
  return { action: 'unavailable' }
}
