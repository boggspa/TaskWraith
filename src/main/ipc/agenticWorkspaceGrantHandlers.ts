import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AppSettings, AgenticServiceId, ProviderId } from '../store/types'
import type { PermissionService } from '../PermissionService'
import { rendererSafeSettings } from './settingsHandlers'

export interface AgenticWorkspaceGrantHandlerDeps {
  permissionService: Pick<PermissionService, 'upsertWorkspaceGrant' | 'removeWorkspaceGrant'>
  getSettings: () => AppSettings
  assertProviderId: (provider: ProviderId) => ProviderId
  requireNonEmptyString: (value: string, label: string) => string
  assertAgenticServiceId: (service: AgenticServiceId) => AgenticServiceId
  assertSenderCanManageAgenticWorkspaceGrants: (
    event: IpcMainInvokeEvent,
    workspacePath: string
  ) => string
}

export function registerAgenticWorkspaceGrantHandlers(
  deps: AgenticWorkspaceGrantHandlerDeps
): void {
  ipcMain.handle(
    'upsert-agentic-workspace-grant',
    (event, provider: ProviderId, workspacePath: string, service: AgenticServiceId) => {
      const validatedProvider = deps.assertProviderId(provider)
      const validatedWorkspacePath = deps.requireNonEmptyString(workspacePath, 'Workspace path')
      const validatedService = deps.assertAgenticServiceId(service)
      const authorizedWorkspacePath = deps.assertSenderCanManageAgenticWorkspaceGrants(
        event,
        validatedWorkspacePath
      )
      deps.permissionService.upsertWorkspaceGrant(
        validatedProvider,
        authorizedWorkspacePath,
        validatedService
      )
      return rendererSafeSettings(deps.getSettings())
    }
  )

  ipcMain.handle(
    'remove-agentic-workspace-grant',
    (event, provider: ProviderId, workspacePath: string, service: AgenticServiceId) => {
      const validatedProvider = deps.assertProviderId(provider)
      const validatedWorkspacePath = deps.requireNonEmptyString(workspacePath, 'Workspace path')
      const validatedService = deps.assertAgenticServiceId(service)
      const authorizedWorkspacePath = deps.assertSenderCanManageAgenticWorkspaceGrants(
        event,
        validatedWorkspacePath
      )
      deps.permissionService.removeWorkspaceGrant(
        validatedProvider,
        authorizedWorkspacePath,
        validatedService
      )
      return rendererSafeSettings(deps.getSettings())
    }
  )
}
