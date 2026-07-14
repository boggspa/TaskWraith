import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { getWorkspaceActivitySnapshot } from '../WorkspaceActivityService'

export interface WorkspaceActivityHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
}

export function registerWorkspaceActivityHandlers(deps: WorkspaceActivityHandlerDeps): void {
  ipcMain.handle('get-workspace-activity', async (event, workspacePath: string, dayCount?: number) => {
    deps.assertSenderScope(event, workspacePath)
    return getWorkspaceActivitySnapshot(deps.requireRegisteredWorkspace(workspacePath), dayCount)
  })
}
