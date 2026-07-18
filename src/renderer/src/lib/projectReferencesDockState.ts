import type { ProjectReference } from '../../../shared/projects'

export interface ProjectReferencesDockState {
  projectId: string
  references: ProjectReference[]
}

/**
 * A Project switch must never render the previous Project's catalogue while
 * the store subscription catches up.
 */
export function referencesForActiveProject(
  state: ProjectReferencesDockState,
  activeProjectId: string,
  loadReferences: (projectId: string) => ProjectReference[]
): ProjectReference[] {
  return state.projectId === activeProjectId
    ? state.references
    : loadReferences(activeProjectId)
}

/**
 * Async actions are scoped to the Project that started them. A late result
 * from Project A must not overwrite the visible state after switching to B.
 */
export function applyProjectReferenceActionResult(input: {
  state: ProjectReferencesDockState
  activeProjectId: string
  actionProjectId: string
  loadReferences: (projectId: string) => ProjectReference[]
}): ProjectReferencesDockState {
  if (input.activeProjectId !== input.actionProjectId) return input.state
  return {
    projectId: input.actionProjectId,
    references: input.loadReferences(input.actionProjectId)
  }
}
