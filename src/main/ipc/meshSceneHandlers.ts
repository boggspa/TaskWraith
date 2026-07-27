/** Chat-scoped renderer IPC for the declarative Mesh Canvas viewer. */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import { meshSceneSummary } from '../../shared/meshScene'
import type { MeshSceneCallContext, MeshSceneService } from '../mesh/MeshSceneService'

export interface MeshModelOpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface MeshSceneIpcDeps {
  controller: Pick<
    MeshSceneService,
    'listForChat' | 'viewForChat' | 'closePresentation' | 'remove' | 'importUserSelectedModel'
  >
  /** Main-owned sender/chat/history authority check. */
  resolveContext: (event: IpcMainInvokeEvent, chatId: string) => MeshSceneCallContext
  /** Native picker is intentionally main-owned; the renderer never supplies a source path. */
  getRequestingWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null
  showOpenDialog: (
    window: BrowserWindow,
    options: OpenDialogOptions
  ) => Promise<MeshModelOpenDialogResult>
}

function requiredChatId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    throw new Error('Mesh Canvas requires an active canonical chat.')
  }
  return value
}

function requiredSceneId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 128) {
    throw new Error('Mesh Canvas scene id is invalid.')
  }
  return value
}

export function registerMeshSceneHandlers(ipcMain: IpcMain, deps: MeshSceneIpcDeps): void {
  ipcMain.handle('mesh-scene:list-chat', (event, chatId: unknown) => {
    const context = deps.resolveContext(event, requiredChatId(chatId))
    if (!context.chatId) throw new Error('Mesh Canvas chat authority is unavailable.')
    return deps.controller.listForChat(context.chatId)
  })

  ipcMain.handle('mesh-scene:view', (event, chatId: unknown, sceneId: unknown) => {
    const context = deps.resolveContext(event, requiredChatId(chatId))
    if (!context.chatId) throw new Error('Mesh Canvas chat authority is unavailable.')
    return deps.controller.viewForChat(requiredSceneId(sceneId), context.chatId)
  })

  ipcMain.handle('mesh-scene:close-presentation', (event, chatId: unknown, sceneId: unknown) => {
    const context = deps.resolveContext(event, requiredChatId(chatId))
    return deps.controller.closePresentation(requiredSceneId(sceneId), context)
  })

  ipcMain.handle('mesh-scene:delete', (event, chatId: unknown, sceneId: unknown) => {
    const context = deps.resolveContext(event, requiredChatId(chatId))
    return deps.controller.remove(requiredSceneId(sceneId), context)
  })

  ipcMain.handle('mesh-scene:import-user-model', async (event, chatId: unknown) => {
    const canonicalChatId = requiredChatId(chatId)
    const context = deps.resolveContext(event, canonicalChatId)
    if (!context.chatId) throw new Error('Mesh Canvas chat authority is unavailable.')
    const window = deps.getRequestingWindow(event)
    if (!window) return { canceled: true }

    // This is a human-authorised source selection. Intentionally accept no path
    // from the renderer or an agent; only the native picker result reaches the
    // service method that permits non-workspace Documents/Downloads imports.
    const selection = await deps.showOpenDialog(window, {
      title: 'Import a 3D scene or model into Mesh Canvas',
      properties: ['openFile'],
      filters: [{ name: '3D scenes and models', extensions: ['glb', 'gltf', 'obj'] }]
    })
    const sourcePath = selection.canceled ? null : selection.filePaths[0]
    if (!sourcePath || !sourcePath.trim()) return { canceled: true }

    // A dialog can outlive a deleted chat or a history clear, so re-establish
    // main-owned sender/chat authority before copying anything into the vault.
    const currentContext = deps.resolveContext(event, canonicalChatId)
    if (!currentContext.chatId) throw new Error('Mesh Canvas chat authority is unavailable.')
    const scene = deps.controller.importUserSelectedModel({ sourcePath }, currentContext)
    return { canceled: false, scene: meshSceneSummary(scene) }
  })
}
