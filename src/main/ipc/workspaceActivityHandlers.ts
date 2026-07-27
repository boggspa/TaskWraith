import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { getCachedWorkspaceActivitySnapshot } from '../WorkspaceActivityBackground'

export interface WorkspaceActivityHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
}

export function registerWorkspaceActivityHandlers(deps: WorkspaceActivityHandlerDeps): void {
  ipcMain.handle(
    'get-workspace-activity',
    async (event, workspacePath: string, dayCount?: number) => {
      deps.assertSenderScope(event, workspacePath)
      return getCachedWorkspaceActivitySnapshot(
        deps.requireRegisteredWorkspace(workspacePath),
        dayCount
      )
    }
  )
}
