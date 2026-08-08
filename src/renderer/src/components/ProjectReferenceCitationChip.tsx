import type { ProjectReferenceCitationMetadata } from '../../../shared/projectReferenceCitation'
import {
  projectReferenceCitationChipModel,
  type ProjectReferenceCitationChipStatus,
  type ProjectReferenceCitationOpenTarget
} from '../lib/projectReferenceCitations'

export interface ProjectReferenceCitationChipProps {
  citation: ProjectReferenceCitationMetadata
  status?: ProjectReferenceCitationChipStatus
  onOpen?: (target: ProjectReferenceCitationOpenTarget) => void
}

/**
 * Inline Project-reference citation chip for assistant markdown.
 * Shows title (+ optional quote preview). Click opens Refs viewer when
 * `onOpen` and an available openTarget are both present; otherwise the chip
 * remains visible but non-interactive.
 */
export function ProjectReferenceCitationChip({
  citation,
  status = 'available',
  onOpen
}: ProjectReferenceCitationChipProps) {
  const model = projectReferenceCitationChipModel(citation, status)
  const quote = citation.quotePreview?.trim()
  const titleAttr = quote ? `${model.title} — ${quote}` : model.title
  const interactive = Boolean(onOpen && model.openTarget && status === 'available')
  const className = [
    'project-reference-citation-chip',
    `is-${model.status}`,
    interactive ? 'is-interactive' : 'is-static'
  ].join(' ')

  const body = (
    <>
      <span className="project-reference-citation-chip-label">{model.label}</span>
      {quote ? <span className="project-reference-citation-chip-quote">{quote}</span> : null}
    </>
  )

  if (interactive && model.openTarget) {
    const target = model.openTarget
    return (
      <button
        type="button"
        className={className}
        title={titleAttr}
        onClick={() => onOpen?.(target)}
      >
        {body}
      </button>
    )
  }

  return (
    <span className={className} title={titleAttr}>
      {body}
    </span>
  )
}
