import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  AgenticWorkspaceGrantProviderId,
  AppSettings,
  AgenticServiceId,
  ProviderId
} from '../store/types'
import type { PermissionService } from '../PermissionService'
import { rendererSafeSettings } from './settingsHandlers'

export interface AgenticWorkspaceGrantHandlerDeps {
  permissionService: Pick<PermissionService, 'upsertWorkspaceGrant' | 'removeWorkspaceGrant'>
  getSettings: () => AppSettings
  assertProviderId: (provider: ProviderId) => ProviderId
  assertLiveProviderId: (provider: ProviderId) => ProviderId
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
      // Every live provider routes tool calls through the central approval
      // gate (natively, via its TaskWraith MCP broker, or both), where
      // resolvePermission honors per-provider workspace grants — Cursor
      // included since its B-mode broker shipped. assertLiveProviderId is
      // the only admission check a grant upsert needs.
      const validatedProvider = deps.assertLiveProviderId(provider)
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
    (event, provider: ProviderId | 'agents', workspacePath: string, service: AgenticServiceId) => {
      // The 'agents' wildcard is a valid workspace-grant provider; legacy/live
      // providers still pass through the normal provider assertion.
      const validatedProvider: AgenticWorkspaceGrantProviderId =
        provider === 'agents' ? 'agents' : deps.assertProviderId(provider)
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
