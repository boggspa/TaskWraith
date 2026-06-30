import { ipcMain } from 'electron'
import type { AppSettings, AgenticServiceId, ProviderId } from '../store/types'
import type { PermissionService } from '../PermissionService'

export interface AgenticWorkspaceGrantHandlerDeps {
  permissionService: Pick<PermissionService, 'upsertWorkspaceGrant' | 'removeWorkspaceGrant'>
  getSettings: () => AppSettings
  assertProviderId: (provider: ProviderId) => ProviderId
  requireNonEmptyString: (value: string, label: string) => string
  assertAgenticServiceId: (service: AgenticServiceId) => AgenticServiceId
}

export function registerAgenticWorkspaceGrantHandlers(
  deps: AgenticWorkspaceGrantHandlerDeps
): void {
  ipcMain.handle(
    'upsert-agentic-workspace-grant',
    (_event, provider: ProviderId, workspacePath: string, service: AgenticServiceId) => {
      deps.permissionService.upsertWorkspaceGrant(
        deps.assertProviderId(provider),
        deps.requireNonEmptyString(workspacePath, 'Workspace path'),
        deps.assertAgenticServiceId(service)
      )
      return deps.getSettings()
    }
  )

  ipcMain.handle(
    'remove-agentic-workspace-grant',
    (_event, provider: ProviderId, workspacePath: string, service: AgenticServiceId) => {
      deps.permissionService.removeWorkspaceGrant(
        deps.assertProviderId(provider),
        deps.requireNonEmptyString(workspacePath, 'Workspace path'),
        deps.assertAgenticServiceId(service)
      )
      return deps.getSettings()
    }
  )
}
