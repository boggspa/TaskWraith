import { ipcMain } from 'electron'
import { getWorkspaceActivitySnapshot } from '../WorkspaceActivityService'

export interface WorkspaceActivityHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
}

export function registerWorkspaceActivityHandlers(deps: WorkspaceActivityHandlerDeps): void {
  ipcMain.handle('get-workspace-activity', (_event, workspacePath: string, dayCount?: number) =>
    getWorkspaceActivitySnapshot(deps.requireRegisteredWorkspace(workspacePath), dayCount)
  )
}
