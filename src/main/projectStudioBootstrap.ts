import type { IpcMainInvokeEvent } from 'electron'
import type { ProjectReferenceExtract } from '../shared/projectReferenceExtract'
import type { ProjectReference, ProjectReferenceOp } from '../shared/projects'
import { registerProjectStudioHandlers } from './ipc/projectStudioHandlers'
import { ProjectStudioService } from './services/ProjectStudioService'

export type ProjectStudioBootstrap = {
  service: ProjectStudioService
  registerHandlers: (assertSenderCanManageProjects: (event: IpcMainInvokeEvent) => void) => void
}

/**
 * Composition-root helper for Project Studio-lite.
 * Keeps service construction out of the monolith body so index.ts only needs a
 * short bootstrap + register call later.
 */
export function bootstrapProjectStudio(input: {
  userDataPath: string
  getActiveExtract: (projectId: string, referenceId: string) => ProjectReferenceExtract | null
  readExtractText: (extractId: string) => string | null
  applyReferenceOp: (op: ProjectReferenceOp) => { references: readonly ProjectReference[] }
}): ProjectStudioBootstrap {
  const service = new ProjectStudioService({
    userDataPath: input.userDataPath,
    getActiveExtract: input.getActiveExtract,
    readExtractText: input.readExtractText,
    applyReferenceOp: input.applyReferenceOp
  })
  return {
    service,
    registerHandlers: (assertSenderCanManageProjects) => {
      registerProjectStudioHandlers({
        assertSenderCanManageProjects,
        generateDraft: (request) => service.generateDraft(request),
        saveToLibrary: (request) => service.saveToLibrary(request),
        discardDraft: (request) => service.discardDraft(request),
        listArtifacts: (request) => service.listArtifacts(request)
      })
    }
  }
}
