import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { ProjectReference } from '../shared/projects'
import { registerProjectReferenceExtractHandlers } from './ipc/projectReferenceExtractHandlers'
import { ProjectReferenceExtractService } from './services/ProjectReferenceExtractService'
import { ProjectReferenceExtractStore } from './services/ProjectReferenceExtractStore'
import type { ProjectReferenceExtractLoader } from './services/ProjectReferenceContextService'

export type ProjectReferenceExtractBootstrap = {
  store: ProjectReferenceExtractStore
  service: ProjectReferenceExtractService
  extractLoader: ProjectReferenceExtractLoader
  registerHandlers: (assertSenderCanManageProjects: (event: IpcMainInvokeEvent) => void) => void
}

/**
 * Composition-root helper for consentful Project reference extracts.
 * Keeps store/service construction out of the monolith body so index.ts only
 * needs a short bootstrap + register call.
 */
export function bootstrapProjectReferenceExtracts(input: {
  userDataPath: string
  getReferences: () => readonly ProjectReference[]
}): ProjectReferenceExtractBootstrap {
  const store = new ProjectReferenceExtractStore(
    path.join(input.userDataPath, 'project-reference-extracts')
  )
  const service = new ProjectReferenceExtractService({
    store,
    getReferences: input.getReferences
  })
  const extractLoader: ProjectReferenceExtractLoader = {
    getActiveExtract: (projectId, referenceId) => store.getActive(projectId, referenceId),
    readExtractText: (extractId) => store.readText(extractId)
  }
  return {
    store,
    service,
    extractLoader,
    registerHandlers: (assertSenderCanManageProjects) => {
      registerProjectReferenceExtractHandlers({
        assertSenderCanManageProjects,
        requestExtract: (request) => service.requestExtract(request),
        getActiveExtract: ({ projectId, referenceId }) => service.getActive(projectId, referenceId),
        revokeExtract: ({ extractId }) => service.revoke(extractId),
        readExtractText: ({ extractId, maxChars }) => service.readText(extractId, maxChars)
      })
    }
  }
}
