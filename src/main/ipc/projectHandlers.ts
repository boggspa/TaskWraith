import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { parseProjectOp, type Project, type ProjectOp } from '../../shared/projects'
import type {
  ProjectLegacyImportMarker,
  ProjectLegacyImportResult
} from '../store/ProjectRegistry'

/** Boot payload for the renderer facade: current authoritative records plus
 * the one-shot import marker (so the facade knows whether the localStorage
 * handshake is still owed). */
export interface ProjectsSnapshot {
  projects: Project[]
  legacyImportMarker: ProjectLegacyImportMarker | null
}

export interface ProjectHandlerDeps {
  getProjects: () => Project[]
  getLegacyImportMarker: () => ProjectLegacyImportMarker | null
  applyProjectOp: (op: ProjectOp) => { projects: Project[]; changed: boolean }
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

  ipcMain.handle('projects:import-legacy', (event, rawJson: unknown) => {
    deps.assertSenderCanManageProjects(event)
    return deps.importLegacyProjects(typeof rawJson === 'string' ? rawJson : null)
  })
}
