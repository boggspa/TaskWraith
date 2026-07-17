import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  parseProjectOp,
  type Project,
  type ProjectOp,
  type ProjectWorkProfile
} from '../../shared/projects'
import type {
  ProjectLegacyImportMarker,
  ProjectLegacyImportResult,
  ProjectRegistryMutationResult
} from '../store/ProjectRegistry'

/** Boot payload for the renderer facade: current authoritative records plus
 * the one-shot import marker (so the facade knows whether the localStorage
 * handshake is still owed). */
export interface ProjectsSnapshot {
  projects: Project[]
  workProfiles: ProjectWorkProfile[]
  legacyImportMarker: ProjectLegacyImportMarker | null
}

export interface ProjectHandlerDeps {
  getProjects: () => Project[]
  getWorkProfiles: () => ProjectWorkProfile[]
  getLegacyImportMarker: () => ProjectLegacyImportMarker | null
  applyProjectOp: (op: ProjectOp) => ProjectRegistryMutationResult
  setProjectHomeChat: (projectId: string, chatId: string | null) => ProjectRegistryMutationResult
  /** Home claims must reference a chat main actually knows — the registry is
   * deliberately chat-blind, so existence is validated here at the boundary. */
  chatExists: (chatId: string) => boolean
  importLegacyProjects: (rawJson: string | null) => ProjectLegacyImportResult
  /**
   * Projects are app-level organisational state managed from the main window.
   * Every channel — reads included — is main-renderer-only until a secondary
   * surface (popout, bridge webview) actually needs them; loosening later is
   * a one-line change here, tightening later is an incident.
   */
  assertSenderCanManageProjects: (event: IpcMainInvokeEvent) => void
}

export function registerProjectHandlers(deps: ProjectHandlerDeps): void {
  ipcMain.handle('projects:snapshot', (event): ProjectsSnapshot => {
    deps.assertSenderCanManageProjects(event)
    return {
      projects: deps.getProjects(),
      workProfiles: deps.getWorkProfiles(),
      legacyImportMarker: deps.getLegacyImportMarker()
    }
  })

  ipcMain.handle('projects:apply-op', (event, op: unknown) => {
    deps.assertSenderCanManageProjects(event)
    // Field-type validation (parseProjectOp) precedes semantic validation
    // inside the apply functions; both reject by throwing so the renderer
    // facade sees a rejected invoke and reconciles from the next snapshot.
    const parsed = parseProjectOp(op)
    if (!parsed) throw new Error('Malformed project operation.')
    return deps.applyProjectOp(parsed)
  })

  ipcMain.handle('projects:set-home-chat', (event, projectId: unknown, chatId: unknown) => {
    deps.assertSenderCanManageProjects(event)
    if (typeof projectId !== 'string' || !projectId.trim()) {
      throw new Error('Project id is required.')
    }
    if (chatId !== undefined && chatId !== null && typeof chatId !== 'string') {
      throw new Error('Malformed chat id.')
    }
    const normalized = typeof chatId === 'string' ? chatId.trim() : null
    if (normalized !== null) {
      if (!normalized) throw new Error('Chat id is required.')
      if (!deps.chatExists(normalized)) throw new Error('Chat not found.')
    }
    return deps.setProjectHomeChat(projectId, normalized)
  })

  ipcMain.handle('projects:import-legacy', (event, rawJson: unknown) => {
    deps.assertSenderCanManageProjects(event)
    return deps.importLegacyProjects(typeof rawJson === 'string' ? rawJson : null)
  })
}
