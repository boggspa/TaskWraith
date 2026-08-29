import { type BrowserWindow, ipcMain } from 'electron'

import type { StartupAuthorityRecoveryState } from '../startup/StartupAuthorityRecovery'

export const STARTUP_AUTHORITY_STATE_CHANNEL = 'startup-authority:state'
export const STARTUP_AUTHORITY_GET_CHANNEL = 'startup-authority:get'
export const STARTUP_AUTHORITY_RETRY_CHANNEL = 'startup-authority:retry'

export interface StartupAuthorityHandlersDeps {
  getState: () => StartupAuthorityRecoveryState
  retryNow: () => Promise<StartupAuthorityRecoveryState>
  forEachRendererWindow: (visit: (window: BrowserWindow) => void) => void
}

/**
 * Projects degraded workspace-lock authority to the renderer, and exposes the
 * explicit retry. A degraded boot used to be console-only, which meant the app
 * looked healthy while mutation, admission, run recovery and scheduling were
 * all fail-closed.
 */
export function registerStartupAuthorityHandlers(deps: StartupAuthorityHandlersDeps): {
  broadcast: (state: StartupAuthorityRecoveryState) => void
} {
  ipcMain.handle(STARTUP_AUTHORITY_GET_CHANNEL, () => deps.getState())
  ipcMain.handle(STARTUP_AUTHORITY_RETRY_CHANNEL, async () => deps.retryNow())

  return {
    broadcast: (state) => {
      deps.forEachRendererWindow((window) => {
        if (window.isDestroyed()) return
        window.webContents.send(STARTUP_AUTHORITY_STATE_CHANNEL, state)
      })
    }
  }
}
