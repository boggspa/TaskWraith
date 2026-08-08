import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type {
  DeleteHookRequest,
  HooksConfigSnapshot,
  EffectiveHooksSnapshot,
  SetHookEnabledRequest,
  UpsertHookRequest
} from '../../shared/hooks/HookTypes'
import type { HooksStore } from '../hooks/HooksStore'

export interface HooksHandlerDeps {
  hooksStore: Pick<
    HooksStore,
    | 'getUserHooks'
    | 'getWorkspaceHooks'
    | 'resolveEffectiveHooks'
    | 'upsertHook'
    | 'deleteHook'
    | 'setEnabled'
  >
  requireRegisteredWorkspace: (workspacePath: string, label?: string) => string
  assertSenderScope: (event: IpcMainInvokeEvent, workspacePath: string) => void
  isMainRendererSender: (event: IpcMainInvokeEvent) => boolean
  requireNonEmptyString: (value: unknown, label: string) => string
}

function assertMainRenderer(deps: HooksHandlerDeps, event: IpcMainInvokeEvent): void {
  if (!deps.isMainRendererSender(event)) {
    throw new Error('Only the main renderer may manage hooks.')
  }
}

function authorizeWorkspace(
  deps: HooksHandlerDeps,
  event: IpcMainInvokeEvent,
  workspacePath: unknown
): string {
  const raw = deps.requireNonEmptyString(workspacePath, 'Workspace path')
  const registered = deps.requireRegisteredWorkspace(raw)
  deps.assertSenderScope(event, registered)
  return registered
}

export function registerHooksHandlers(deps: HooksHandlerDeps): void {
  ipcMain.handle('hooks:get-effective', (event, workspacePath: string): EffectiveHooksSnapshot => {
    assertMainRenderer(deps, event)
    const authorized = authorizeWorkspace(deps, event, workspacePath)
    return deps.hooksStore.resolveEffectiveHooks(authorized)
  })

  ipcMain.handle('hooks:get-user', (event): HooksConfigSnapshot => {
    assertMainRenderer(deps, event)
    return deps.hooksStore.getUserHooks()
  })

  ipcMain.handle('hooks:get-workspace', (event, workspacePath: string): HooksConfigSnapshot => {
    assertMainRenderer(deps, event)
    const authorized = authorizeWorkspace(deps, event, workspacePath)
    return deps.hooksStore.getWorkspaceHooks(authorized)
  })

  ipcMain.handle('hooks:upsert', (event, request: UpsertHookRequest): HooksConfigSnapshot => {
    assertMainRenderer(deps, event)
    if (!request || typeof request !== 'object') {
      throw new Error('Hook upsert request is required.')
    }
    if (request.scope === 'workspace') {
      const authorized = authorizeWorkspace(deps, event, request.workspacePath)
      return deps.hooksStore.upsertHook({ ...request, workspacePath: authorized })
    }
    return deps.hooksStore.upsertHook(request)
  })

  ipcMain.handle('hooks:delete', (event, request: DeleteHookRequest): HooksConfigSnapshot => {
    assertMainRenderer(deps, event)
    if (!request || typeof request !== 'object') {
      throw new Error('Hook delete request is required.')
    }
    deps.requireNonEmptyString(request.id, 'Hook id')
    if (request.scope === 'workspace') {
      const authorized = authorizeWorkspace(deps, event, request.workspacePath)
      return deps.hooksStore.deleteHook({ ...request, workspacePath: authorized })
    }
    return deps.hooksStore.deleteHook(request)
  })

  ipcMain.handle(
    'hooks:set-enabled',
    (event, request: SetHookEnabledRequest): HooksConfigSnapshot => {
      assertMainRenderer(deps, event)
      if (!request || typeof request !== 'object') {
        throw new Error('Hook set-enabled request is required.')
      }
      deps.requireNonEmptyString(request.id, 'Hook id')
      if (request.scope === 'workspace') {
        const authorized = authorizeWorkspace(deps, event, request.workspacePath)
        return deps.hooksStore.setEnabled({ ...request, workspacePath: authorized })
      }
      return deps.hooksStore.setEnabled(request)
    }
  )
}
