import { ipcMain } from 'electron'
import type { TrustStatusResult, TrustWriteResult } from '../store/types'
import type {
  TrustedSessionScope,
  TrustedSessionSetResult
} from '../TrustedSessionGrants'

export interface SessionYoloModeState {
  enabled: boolean
  enabledAt: string | null
  managedBlocked?: boolean
  managedReason?: string
}

export interface TrustHandlerDeps {
  checkTrust: (workspacePath: string) => TrustStatusResult
  trustWorkspace: (workspacePath: string) => TrustWriteResult
  getSessionYoloMode: () => SessionYoloModeState
  setSessionYoloMode: (enabled: boolean) => SessionYoloModeState | void
  getTrustedSession: (scope: TrustedSessionScope) => TrustedSessionSetResult
  setTrustedSession: (
    scope: TrustedSessionScope,
    enabled: boolean
  ) => TrustedSessionSetResult
}

export function registerTrustHandlers(deps: TrustHandlerDeps): void {
  ipcMain.handle('check-trust', (_event, workspacePath: string) => deps.checkTrust(workspacePath))

  // One-click persistent workspace trust (#272): write the folder into
  // ~/.gemini/trustedFolders.json directly so the Gemini CLI picks it up
  // on its next run. Replaces the broken interactive `/permissions trust`
  // terminal flow.
  ipcMain.handle('trust-workspace', (_event, workspacePath: string) =>
    deps.trustWorkspace(workspacePath)
  )

  // Phase J3: session-scoped YOLO mode. The setter dependency owns the
  // renderer broadcast side effect so this registrar remains a thin IPC layer.
  ipcMain.handle('agentic-yolo-get', () => deps.getSessionYoloMode())
  ipcMain.handle('agentic-yolo-set', (_event, enabled: boolean) => {
    return deps.setSessionYoloMode(Boolean(enabled)) || deps.getSessionYoloMode()
  })

  ipcMain.handle('trusted-session-get', (_event, scope: TrustedSessionScope) =>
    deps.getTrustedSession(scope)
  )
  ipcMain.handle(
    'trusted-session-set',
    (_event, scope: TrustedSessionScope, enabled: boolean) =>
      deps.setTrustedSession(scope, Boolean(enabled))
  )
}
