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
  /**
   * The host OS accent colour, or null where the platform cannot report one.
   * `systemPreferences` is main-only, so this read is the renderer's ONLY
   * route to the desktop accent that `--accent` follows.
   */
  getSystemAccentColor: () => string | null
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
  // Spelled as a literal, not the shared SYSTEM_ACCENT_COLOR_CHANNEL constant
  // preload invokes: the build-time scan in IpcValidation.test.ts resolves
  // channel constants only within the file that handles them, and an
  // unresolvable channel escapes the "every handler has an arg schema"
  // invariant. appearanceHandlers.test.ts asserts the two stay equal.
  ipcMain.handle('appearance:get-system-accent-color', () => deps.getSystemAccentColor())
}
