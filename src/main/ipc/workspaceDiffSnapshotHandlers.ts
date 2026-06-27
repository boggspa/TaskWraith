import { ipcMain } from 'electron'
import { captureWorkspaceSnapshot, getWorkspaceDiff } from '../DiffService'

export interface WorkspaceDiffSnapshotHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
}

export function registerWorkspaceDiffSnapshotHandlers(
  deps: WorkspaceDiffSnapshotHandlerDeps
): void {
  ipcMain.handle('get-diff', async (_event, workspace: string) => {
    return getWorkspaceDiff(deps.requireRegisteredWorkspace(workspace))
  })

  ipcMain.handle('capture-snapshot', async (_event, workspace: string) => {
    return captureWorkspaceSnapshot(deps.requireRegisteredWorkspace(workspace))
  })
}
