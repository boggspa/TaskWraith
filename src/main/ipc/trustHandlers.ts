import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { TrustStatusResult, TrustWriteResult } from '../store/types'
import type { TrustedSessionScope, TrustedSessionSetResult } from '../TrustedSessionGrants'

export interface SessionYoloModeState {
  enabled: boolean
  enabledAt: string | null
  managedBlocked?: boolean
  managedReason?: string
}

export interface TrustHandlerDeps {
  /**
   * Trust state is authority-bearing. Only the main renderer may read global
   * state or mutate it; secondary renderers must never gain authority from a
   * path or scope supplied in their own IPC payload.
   */
  assertMainRendererSender: (event: IpcMainInvokeEvent) => void
  /**
   * `check-trust` is the one workspace-scoped exception. Main owns the
   * mapping from a renderer WebContents to its exact workspace and validates
   * that mapping before the trust store is consulted.
   */
  assertSenderCanCheckWorkspaceTrust: (event: IpcMainInvokeEvent, workspacePath: string) => void
  /**
   * A chat popout may render its own composer's scoped Full Access state,
   * but it may not probe another chat/workspace. The injected main-owned
   * assertion binds the sender identity to the requested scope.
   */
  assertSenderCanReadTrustedSession: (event: IpcMainInvokeEvent, scope: TrustedSessionScope) => void
  checkTrust: (workspacePath: string) => TrustStatusResult
  trustWorkspace: (workspacePath: string) => TrustWriteResult
  getSessionYoloMode: () => SessionYoloModeState
  setSessionYoloMode: (enabled: boolean) => SessionYoloModeState | void
  getTrustedSession: (scope: TrustedSessionScope) => TrustedSessionSetResult
  setTrustedSession: (scope: TrustedSessionScope, enabled: boolean) => TrustedSessionSetResult
}

export function registerTrustHandlers(deps: TrustHandlerDeps): void {
  ipcMain.handle('check-trust', (event, workspacePath: string) => {
    deps.assertSenderCanCheckWorkspaceTrust(event, workspacePath)
    return deps.checkTrust(workspacePath)
  })

  // One-click persistent workspace trust (#272): write the folder into
  // ~/.gemini/trustedFolders.json directly so the Gemini CLI picks it up
  // on its next run. Replaces the broken interactive `/permissions trust`
  // terminal flow.
  ipcMain.handle('trust-workspace', (event, workspacePath: string) => {
    deps.assertMainRendererSender(event)
    return deps.trustWorkspace(workspacePath)
  })

  // Phase J3: session-scoped YOLO mode. The setter dependency owns the
  // renderer broadcast side effect so this registrar remains a thin IPC layer.
  ipcMain.handle('agentic-yolo-get', (event) => {
    deps.assertMainRendererSender(event)
    return deps.getSessionYoloMode()
  })
  ipcMain.handle('agentic-yolo-set', (event, enabled: boolean) => {
    deps.assertMainRendererSender(event)
    return deps.setSessionYoloMode(Boolean(enabled)) || deps.getSessionYoloMode()
  })

  ipcMain.handle('trusted-session-get', (event, scope: TrustedSessionScope) => {
    deps.assertSenderCanReadTrustedSession(event, scope)
    return deps.getTrustedSession(scope)
  })
  ipcMain.handle('trusted-session-set', (event, scope: TrustedSessionScope, enabled: boolean) => {
    deps.assertMainRendererSender(event)
    return deps.setTrustedSession(scope, Boolean(enabled))
  })
}
