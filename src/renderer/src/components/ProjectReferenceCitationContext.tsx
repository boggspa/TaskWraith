import { createContext } from 'react'
import type { ProjectReferenceCitationMetadata } from '../../../shared/projectReferenceCitation'
import type { ProjectReferenceCitationOpenTarget } from '../lib/projectReferenceCitations'

export interface ProjectReferenceCitationContextValue {
  citations: readonly ProjectReferenceCitationMetadata[]
  onOpen?: (target: ProjectReferenceCitationOpenTarget) => void
}

export const ProjectReferenceCitationContext =
  createContext<ProjectReferenceCitationContextValue | null>(null)

/** Markdown link scheme carrying a citation index into the message context. */
export const PROJECT_REFERENCE_CITATION_LINK_PREFIX = 'project-ref-cite://'
