import type { JSX } from 'react'

import type { Project } from '../lib/projectsStore'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import { projectIdentity } from './ProjectsSidebarView'

/**
 * The "project desk" strip above the transcript: rendered ONLY while Work is
 * the active surface and the focused chat belongs to the active Project — so
 * opening the same chat from Chat or Code carries no Project chrome (the
 * route-scoped context invariant). Everything here is presentation over
 * already-authoritative state; the header grants and stores nothing.
 */
export interface ProjectHomeHeaderProps {
  project: Project
  /** True when the focused chat is the Project's claimed home. */
  isHome: boolean
  brief?: string
  referenceCount: number
  attentionCount: number
  onOpenLibrary: () => void
}

export function ProjectHomeHeader({
  project,
  isHome,
  brief,
  referenceCount,
  attentionCount,
  onOpenLibrary
}: ProjectHomeHeaderProps): JSX.Element {
  return (
    <div className="project-home-header" role="region" aria-label={`${project.name} project context`}>
      <PooledAgentIcon
        identity={projectIdentity(project)}
        size={20}
        className="project-home-header-icon"
      />
      <strong className="project-home-header-name" title={project.name}>
        {project.name}
      </strong>
      <span className={`project-home-header-chip ${isHome ? 'is-home' : ''}`}>
        {isHome ? 'Project Home' : 'Project thread'}
      </span>
      {brief && (
        <span className="project-home-header-brief" title={brief}>
          {brief}
        </span>
      )}
      <button
        type="button"
        className="project-home-header-library"
        onClick={onOpenLibrary}
        title="Open the Project reference library"
        aria-label={`Open ${project.name} reference library (${referenceCount} reference${
          referenceCount === 1 ? '' : 's'
        })`}
      >
        Library · {referenceCount}
        {attentionCount > 0 && (
          <span
            className="project-home-header-attention"
            title={`${attentionCount} reference${attentionCount === 1 ? '' : 's'} need attention`}
          >
            {attentionCount}
          </span>
        )}
      </button>
    </div>
  )
}
