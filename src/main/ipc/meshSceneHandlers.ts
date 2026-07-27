/** Chat-scoped renderer IPC for the declarative Mesh Canvas viewer. */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { MeshSceneCallContext, MeshSceneService } from '../mesh/MeshSceneService'

export interface MeshSceneIpcDeps {
  controller: Pick<MeshSceneService, 'listForChat' | 'viewForChat' | 'closePresentation' | 'remove'>
  /** Main-owned sender/chat/history authority check. */
  resolveContext: (event: IpcMainInvokeEvent, chatId: string) => MeshSceneCallContext
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
}
