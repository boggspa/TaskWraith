import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  GeminiCommandDiscoveryRecord,
  GeminiMemoryDiscoveryRecord
} from '../gemini/GeminiDiscovery'

export interface WorkspaceGeminiDiscoveryHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
  discoverGeminiCommands: (workspace: string) => Promise<GeminiCommandDiscoveryRecord[]>
  discoverGeminiMemory: (workspace: string) => Promise<GeminiMemoryDiscoveryRecord[]>
}

export function registerWorkspaceGeminiDiscoveryHandlers(
  deps: WorkspaceGeminiDiscoveryHandlerDeps
): void {
  ipcMain.handle(
    'discover-gemini-commands',
    async (event, workspace: string): Promise<GeminiCommandDiscoveryRecord[]> => {
      deps.assertSenderScope(event, workspace)
      return deps.discoverGeminiCommands(deps.requireRegisteredWorkspace(workspace))
    }
  )

  ipcMain.handle(
    'discover-gemini-memory',
    async (event, workspace: string): Promise<GeminiMemoryDiscoveryRecord[]> => {
      deps.assertSenderScope(event, workspace)
      return deps.discoverGeminiMemory(deps.requireRegisteredWorkspace(workspace))
    }
  )
}
