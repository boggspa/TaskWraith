import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  parseProjectOp,
  parseProjectReferenceOp,
  type Project,
  type ProjectOp,
  type ProjectReference,
  type ProjectReferenceAvailability,
  type ProjectReferenceKind,
  type ProjectReferenceOp,
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
  references: ProjectReference[]
  legacyImportMarker: ProjectLegacyImportMarker | null
}

export interface ProjectHandlerDeps {
  getProjects: () => Project[]
  getWorkProfiles: () => ProjectWorkProfile[]
  getReferences: () => ProjectReference[]
  getLegacyImportMarker: () => ProjectLegacyImportMarker | null
  applyProjectOp: (op: ProjectOp) => ProjectRegistryMutationResult
  applyReferenceOp: (op: ProjectReferenceOp) => ProjectRegistryMutationResult
  setProjectHomeChat: (projectId: string, chatId: string | null) => ProjectRegistryMutationResult
  /** Home claims must reference a chat main actually knows — the registry is
   * deliberately chat-blind, so existence is validated here at the boundary. */
  chatExists: (chatId: string) => boolean
  /** One existence stat for a local locator — NEVER content. URLs are not
   * probed in this phase (no network on behalf of the library). */
  probeReferenceLocator: (
    kind: Exclude<ProjectReferenceKind, 'url'>,
    locator: string
  ) => ProjectReferenceAvailability
  /** Plain OS picker for reference locators. Deliberately DISTINCT from the
   * external-path grant pickers: choosing a reference catalogues it and
   * grants NOTHING — reference ≠ access is the safety boundary. */
  pickReferencePath: (mode: 'file' | 'folder') => Promise<string | null>
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
      references: deps.getReferences(),
      legacyImportMarker: deps.getLegacyImportMarker()
    }
  })

  ipcMain.handle('projects:reference-op', (event, op: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const parsed = parseProjectReferenceOp(op)
    if (!parsed) throw new Error('Malformed project reference operation.')
    // Verification records are MAIN-initiated only (projects:verify-reference
    // runs the probe); a renderer-supplied status would let a buggy or
    // compromised renderer assert availability it never checked.
    if (parsed.kind === 'record-reference-verification') {
      throw new Error('Reference verification is main-initiated.')
    }
    return deps.applyReferenceOp(parsed)
  })

  ipcMain.handle('projects:verify-reference', (event, id: unknown) => {
    deps.assertSenderCanManageProjects(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Reference id is required.')
    const reference = deps.getReferences().find((entry) => entry.id === id.trim())
    if (!reference) throw new Error('Reference not found.')
    if (reference.kind === 'url') {
      throw new Error('URL references cannot be verified automatically.')
    }
    const status = deps.probeReferenceLocator(reference.kind, reference.locator)
    return deps.applyReferenceOp({
      kind: 'record-reference-verification',
      id: reference.id,
      status,
      now: Date.now()
    })
  })

  ipcMain.handle('projects:pick-reference-path', async (event, mode: unknown) => {
    deps.assertSenderCanManageProjects(event)
    if (mode !== 'file' && mode !== 'folder') throw new Error('Malformed picker mode.')
    return deps.pickReferencePath(mode)
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
