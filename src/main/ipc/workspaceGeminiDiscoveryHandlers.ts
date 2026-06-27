import { ipcMain } from 'electron'
import type {
  GeminiCommandDiscoveryRecord,
  GeminiMemoryDiscoveryRecord
} from '../gemini/GeminiDiscovery'

export interface WorkspaceGeminiDiscoveryHandlerDeps {
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  discoverGeminiCommands: (workspace: string) => Promise<GeminiCommandDiscoveryRecord[]>
  discoverGeminiMemory: (workspace: string) => Promise<GeminiMemoryDiscoveryRecord[]>
}

export function registerWorkspaceGeminiDiscoveryHandlers(
  deps: WorkspaceGeminiDiscoveryHandlerDeps
): void {
  ipcMain.handle(
    'discover-gemini-commands',
    async (_, workspace: string): Promise<GeminiCommandDiscoveryRecord[]> => {
      return deps.discoverGeminiCommands(deps.requireRegisteredWorkspace(workspace))
    }
  )

  ipcMain.handle(
    'discover-gemini-memory',
    async (_, workspace: string): Promise<GeminiMemoryDiscoveryRecord[]> => {
      return deps.discoverGeminiMemory(deps.requireRegisteredWorkspace(workspace))
    }
  )
}
