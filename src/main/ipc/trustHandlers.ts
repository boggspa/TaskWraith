import { ipcMain } from 'electron'
import type { TrustStatusResult, TrustWriteResult } from '../store/types'

export interface SessionYoloModeState {
  enabled: boolean
  enabledAt: string | null
}

export interface TrustHandlerDeps {
  checkTrust: (workspacePath: string) => TrustStatusResult
  trustWorkspace: (workspacePath: string) => TrustWriteResult
  getSessionYoloMode: () => SessionYoloModeState
  setSessionYoloMode: (enabled: boolean) => void
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
    deps.setSessionYoloMode(Boolean(enabled))
    return deps.getSessionYoloMode()
  })
}
