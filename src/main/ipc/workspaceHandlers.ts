import { ipcMain } from 'electron'
import type { WorkspaceService } from '../services/WorkspaceService'
import type { WorkspaceRecord } from '../store/types'

export interface WorkspaceProbeResult {
  branch?: string
}

export interface WorkspaceHandlerDeps {
  workspaceService: Pick<
    WorkspaceService,
    'getWorkspaces' | 'addOrUpdateWorkspace' | 'removeWorkspace' | 'clearWorkspaces'
  >
  probeExternalPath: (path: string) => Promise<WorkspaceProbeResult | null>
  broadcastWorkspaceUpdate: (workspaceId: string | undefined) => void
  broadcastWorkspaceList: () => void
}

export function registerWorkspaceHandlers(deps: WorkspaceHandlerDeps): void {
  // Lazily backfill branch metadata for records persisted before branch probing existed.
  ipcMain.handle('get-workspaces', async () => {
    const workspaces = deps.workspaceService.getWorkspaces()
    const missing = workspaces.filter((ws) => !ws.branch)
    if (missing.length === 0) return workspaces
    try {
      const probed = await Promise.all(
        missing.map(async (ws) => {
          try {
            const result = await deps.probeExternalPath(ws.path)
            return { id: ws.id, path: ws.path, branch: result?.branch }
          } catch {
            return { id: ws.id, path: ws.path, branch: undefined }
          }
        })
      )
      let touched = false
      for (const entry of probed) {
        if (entry.branch) {
          deps.workspaceService.addOrUpdateWorkspace(entry.path, {
            branch: entry.branch
          })
          touched = true
        }
      }
      return touched ? deps.workspaceService.getWorkspaces() : workspaces
    } catch {
      return workspaces
    }
  })

  ipcMain.handle(
    'add-or-update-workspace',
    async (_event, path: string, partial: Partial<WorkspaceRecord>) => {
      let resolvedPartial: Partial<WorkspaceRecord> = partial || {}
      if (!resolvedPartial.branch) {
        try {
          const probed = await deps.probeExternalPath(path)
          if (probed?.branch) {
            resolvedPartial = { ...resolvedPartial, branch: probed.branch }
          }
        } catch {
          /* keep partial as-is */
        }
      }
      const workspace = deps.workspaceService.addOrUpdateWorkspace(path, resolvedPartial)
      deps.broadcastWorkspaceUpdate(workspace?.id)
      return workspace
    }
  )

  ipcMain.handle('remove-workspace', (_event, id: string) => {
    deps.workspaceService.removeWorkspace(id)
    deps.broadcastWorkspaceList()
  })

  ipcMain.handle('clear-workspaces', () => {
    deps.workspaceService.clearWorkspaces()
    deps.broadcastWorkspaceList()
  })
}
