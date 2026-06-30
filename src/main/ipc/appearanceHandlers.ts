import { type BrowserWindow, ipcMain } from 'electron'
import type { AppSettings } from '../store/types'

interface AppearanceModePayload {
  mode?: string
  reduceTransparency?: boolean
}

export interface AppearanceHandlersDeps {
  getSettings: () => AppSettings
  isAppearanceMode: (value: unknown) => value is AppSettings['appearanceMode']
  getMainWindow: () => BrowserWindow | null
  forEachWorkspacePopoutWindow: (visit: (window: BrowserWindow) => void) => void
  applyNativeGlassToWindow: (window: BrowserWindow, settings: AppSettings) => void
  getCachedHostWeather: () => Promise<unknown>
  getNativeCapabilitySnapshot: () => unknown
}

export function registerAppearanceHandlers(deps: AppearanceHandlersDeps): void {
  ipcMain.handle(
    'set-appearance-mode',
    (_, payload: AppearanceModePayload | string) => {
      const settings = deps.getSettings()
      const requestMode = typeof payload === 'string' ? payload : payload?.mode
      const requestReduce =
        typeof payload === 'string'
          ? settings.reduceTransparency
          : (payload?.reduceTransparency ?? settings.reduceTransparency)
      const nextMode = deps.isAppearanceMode(requestMode)
        ? requestMode
        : settings.appearanceMode || 'soft_glass'
      const nextSettings: AppSettings = {
        ...settings,
        appearanceMode: nextMode,
        reduceTransparency: requestReduce
      }
      const mainWindow = deps.getMainWindow()
      if (mainWindow) {
        deps.applyNativeGlassToWindow(mainWindow, nextSettings)
      }
      deps.forEachWorkspacePopoutWindow((window) => {
        if (!window.isDestroyed()) {
          deps.applyNativeGlassToWindow(window, nextSettings)
        }
      })
      return true
    }
  )

  ipcMain.handle('get-host-weather', async () => deps.getCachedHostWeather())
  ipcMain.handle('native-capabilities:snapshot', () => deps.getNativeCapabilitySnapshot())
}
