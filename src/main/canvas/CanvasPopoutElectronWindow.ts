/** Electron adapter for the otherwise platform-neutral Canvas pop-out registry. */
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type {
  CanvasPopoutOpenInput,
  CanvasPopoutWindowHandle,
  CanvasPopoutWindowManagerDeps
} from './CanvasPopoutWindowManager'

export interface CanvasPopoutElectronWindowOptions {
  preloadPath: string
  rendererFile: string
  rendererUrl?: string
  backgroundColor: string
  linuxIcon?: BrowserWindowConstructorOptions['icon']
  attachWindow(window: BrowserWindow): void
  openExternal(url: string): void
}

export function canvasPopoutRendererQuery(input: CanvasPopoutOpenInput): Record<string, string> {
  const query: Record<string, string> = {
    popout: 'canvas',
    chat: input.chatId,
    surface: input.surface
  }
  if (input.session) {
    query.canvas = input.session.canvasId
    query.canvasKind = input.session.kind
    // URL/title stay out of the utility-window URL. The destination refreshes
    // both from the main-owned live session immediately after mount.
  }
  return query
}

export function createCanvasPopoutElectronWindowDeps(
  options: CanvasPopoutElectronWindowOptions
): Pick<CanvasPopoutWindowManagerDeps, 'createWindow' | 'loadWindow'> {
  return {
    createWindow: (): CanvasPopoutWindowHandle => {
      const window = new BrowserWindow({
        width: 1080,
        height: 760,
        minWidth: 520,
        minHeight: 420,
        show: false,
        autoHideMenuBar: true,
        title: 'TaskWraith Canvas',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        backgroundColor: options.backgroundColor,
        ...(process.platform === 'linux' && options.linuxIcon ? { icon: options.linuxIcon } : {}),
        webPreferences: {
          preload: options.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          allowRunningInsecureContent: false,
          experimentalFeatures: false
        }
      })
      options.attachWindow(window)
      window.webContents.setWindowOpenHandler((details) => {
        options.openExternal(details.url)
        return { action: 'deny' }
      })
      return window
    },
    loadWindow: async (handle, input) => {
      const window = handle as BrowserWindow
      const query = canvasPopoutRendererQuery(input)
      if (options.rendererUrl) {
        const target = new URL(options.rendererUrl)
        for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
        await window.loadURL(target.toString())
        return
      }
      await window.loadFile(options.rendererFile, { query })
    }
  }
}
